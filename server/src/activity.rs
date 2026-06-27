//! Discord Activity (embedded app) support.
//!
//! DWEEB also runs *inside* Discord as an Activity: the same message builder,
//! launched in a server, scoped to the current guild + channel, with real-time
//! co-editing and one-click publishing. Three things differ from the web app and
//! all of them live here:
//!
//!  1. **Auth is bearer, not cookie.** The Activity runs in a sandboxed,
//!     third-party `…discordsays.com` iframe, so the proxy's session cookie never
//!     rides along. Instead the Embedded App SDK hands the page a Discord OAuth
//!     `code` (via RPC), which `activity_token` exchanges for an access token; the
//!     browser then sends that token as `Authorization: Bearer …` on every proxy
//!     call. [`resolve_identity`] accepts either credential, so the existing
//!     guild reads work unchanged for both surfaces.
//!
//!  2. **Publishing is server-side.** A sandboxed iframe can't POST to
//!     discord.com directly, so `activity_post` does it for the browser: it
//!     reuses (or mints) a DWEEB-owned webhook in the channel and posts the
//!     built message through it — same identity + component-routing story as the
//!     web builder, just performed by the proxy.
//!
//!  3. **Collaboration is a WebSocket room.** `activity_room` joins everyone in
//!     the same Activity instance to an in-memory broadcast room: drafts and
//!     presence are relayed verbatim between participants (last-write-wins on the
//!     whole message). Ephemeral by design — nothing is persisted.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::PrivateCookieJar;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::discord::DiscordUser;
use crate::error::AppError;
use crate::routes::{
    authorize_member_session, authorize_webhooks_session, current_session, ensure_channel_in_guild,
    is_snowflake, AppState,
};
use crate::session::{now, Session};

/// How long a bearer-derived identity is reused from cache before the access
/// token is re-validated against `GET /users/@me`. Short — the token itself is
/// the authority on every guild call, this only caps how often we re-resolve the
/// user's id/name behind it.
const BEARER_TTL_SECS: i64 = 600;

/// Bounds for the collaboration rooms, so an abusive client can't exhaust memory:
/// the most distinct Activity instances we keep, the per-room broadcast backlog
/// (a lagging peer just skips to the latest draft — fine under last-write-wins),
/// and the largest relayed frame.
const MAX_ROOMS: usize = 5_000;
const BROADCAST_CAP: usize = 64;
const MAX_RELAY_BYTES: usize = 256 * 1024;

// ── Identity (cookie OR bearer) ─────────────────────────────────────────────

/// Resolve the caller's identity from *either* the session cookie (web app) or a
/// `Authorization: Bearer <discord access token>` header (embedded Activity).
/// Returns the same [`Session`] shape regardless, so the membership/Manage-
/// Webhooks gates in `routes` treat both surfaces identically.
pub(crate) async fn resolve_identity(
    st: &AppState,
    jar: &PrivateCookieJar,
    headers: &HeaderMap,
) -> Result<Session, AppError> {
    if let Some(session) = current_session(jar) {
        return Ok(session);
    }
    match bearer_token(headers) {
        Some(token) => resolve_bearer(st, &token).await,
        None => Err(AppError::Unauthorized(
            "Sign in with Discord to load server data.".into(),
        )),
    }
}

/// Build a [`Session`] from a Discord user access token: validate it by reading
/// `GET /users/@me` (cached briefly by a fingerprint of the token so repeat calls
/// don't re-hit Discord), then carry the token forward so the usual
/// `current_user_guilds` membership checks run exactly as they do for a cookie
/// session. A `401` from Discord surfaces as Unauthorized → the Activity re-auths.
pub(crate) async fn resolve_bearer(st: &AppState, token: &str) -> Result<Session, AppError> {
    let key = format!("actid:{:016x}", fingerprint(token));
    if let Some(v) = st.cache.get(&key).await {
        if let Ok(user) = serde_json::from_value::<DiscordUser>((*v).clone()) {
            return Ok(session_from_user(user, token));
        }
    }
    let user = st.discord.current_user(token).await?;
    if let Ok(val) = serde_json::to_value(&user) {
        st.cache.put(key, Arc::new(val)).await;
    }
    Ok(session_from_user(user, token))
}

fn session_from_user(user: DiscordUser, token: &str) -> Session {
    let name = user
        .global_name
        .filter(|s| !s.is_empty())
        .unwrap_or(user.username);
    Session {
        uid: user.id,
        name,
        avatar: user.avatar,
        token: token.to_string(),
        exp: now() + BEARER_TTL_SECS,
    }
}

/// Pull a non-empty `Bearer` token out of the `Authorization` header.
fn bearer_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

/// A stable, non-reversible cache-bucket id for a token. Not a security boundary
/// (the Discord call is the real check) — just keeps the raw token out of cache
/// keys and logs.
fn fingerprint(token: &str) -> u64 {
    let mut h = DefaultHasher::new();
    token.hash(&mut h);
    h.finish()
}

fn not_enabled() -> AppError {
    AppError::Status {
        status: StatusCode::NOT_IMPLEMENTED,
        message: "Discord Activities aren't enabled on this deployment.".into(),
        retry_after: None,
    }
}

fn bad_request(message: &str) -> AppError {
    AppError::Status {
        status: StatusCode::BAD_REQUEST,
        message: message.into(),
        retry_after: None,
    }
}

// ── Token exchange (POST /api/activity/token) ───────────────────────────────

#[derive(Deserialize)]
pub struct TokenBody {
    #[serde(default)]
    code: String,
}

/// `POST /api/activity/token` `{ code }` — exchange the Embedded App SDK's
/// authorization code for a user access token. Runs server-side so the client
/// secret never reaches the iframe; the browser gets back only the access token,
/// which it hands to `sdk.commands.authenticate(...)` and then carries as a
/// bearer on subsequent proxy calls.
pub async fn activity_token(
    State(st): State<AppState>,
    Json(body): Json<TokenBody>,
) -> Result<Response, AppError> {
    if !st.config.activities_enabled {
        return Err(not_enabled());
    }
    let code = body.code.trim();
    if code.is_empty() {
        return Err(bad_request("code is required"));
    }
    let token = st
        .discord
        .exchange_code_embedded(&st.config.client_id, &st.config.client_secret, code)
        .await?;
    Ok(Json(json!({ "access_token": token.access_token })).into_response())
}

// ── Publish (POST /api/activity/post) ───────────────────────────────────────

#[derive(Deserialize)]
pub struct PostBody {
    #[serde(default)]
    guild_id: String,
    #[serde(default)]
    channel_id: String,
    /// The wire payload the browser built (components + flags + username/avatar).
    message: Value,
}

/// `POST /api/activity/post` `{ guild_id, channel_id, message }` — post the
/// built message into the Activity's channel. Gated like every other webhook
/// feature (the user must hold Manage Webhooks in the guild); the proxy reuses a
/// DWEEB-owned webhook in the channel — or creates one — and posts through it, so
/// the message keeps the builder's custom username/avatar and its components
/// route back to the dispatcher. Returns the new message id + a jump link.
pub async fn activity_post(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    headers: HeaderMap,
    Json(body): Json<PostBody>,
) -> Result<Response, AppError> {
    if !st.config.activities_enabled {
        return Err(not_enabled());
    }
    let session = resolve_identity(&st, &jar, &headers).await?;
    let guild = body.guild_id.trim().to_string();
    let channel_id = body.channel_id.trim().to_string();
    if !is_snowflake(&guild) || !is_snowflake(&channel_id) {
        return Err(bad_request("guild_id and channel_id must be Discord ids"));
    }
    if !body.message.is_object() {
        return Err(bad_request("message must be a JSON object"));
    }

    authorize_webhooks_session(&st, session.clone(), &guild).await?;
    ensure_channel_in_guild(&st, &guild, &channel_id).await?;

    // Prefer reusing a DWEEB-owned incoming webhook already in the channel (so we
    // don't spawn duplicates, and never hijack a third party's hook); otherwise
    // mint one. Either way the post carries DWEEB's component routing.
    let hooks = st.discord.guild_webhooks(&guild).await?;
    let reuse = hooks.into_iter().find(|w| {
        w.kind == 1
            && w.channel_id.as_deref() == Some(channel_id.as_str())
            && w.token.as_deref().is_some_and(|t| !t.is_empty())
            && w.application_id.as_deref() == Some(st.config.client_id.as_str())
    });
    let (webhook_id, token) = match reuse {
        Some(w) => (w.id, w.token.unwrap_or_default()),
        None => {
            let reason = format!("Created via DWEEB Activity by {}", session.uid);
            let w = st
                .discord
                .create_webhook(&channel_id, "DWEEB", None, Some(&reason))
                .await?;
            let token = w
                .token
                .ok_or_else(|| AppError::BadGateway("Discord created a webhook without a token.".into()))?;
            (w.id, token)
        }
    };

    let created = st.discord.execute_webhook(&webhook_id, &token, &body.message).await?;
    let message_id = created
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let jump = if message_id.is_empty() {
        Value::Null
    } else {
        Value::String(format!(
            "https://discord.com/channels/{guild}/{channel_id}/{message_id}"
        ))
    };
    Ok(Json(json!({
        "message_id": message_id,
        "channel_id": channel_id,
        "guild_id": guild,
        "url": jump,
    }))
    .into_response())
}

// ── Collaboration rooms (WS /api/activity/room/:instance) ────────────────────

/// One participant in a collaboration room, as broadcast in the roster.
#[derive(Clone)]
struct Participant {
    id: String,
    name: String,
    avatar: Option<String>,
}

/// In-memory state for one Activity instance: the broadcast channel every
/// participant's socket subscribes to, plus a per-user connection count so the
/// roster reflects unique people (a user with two tabs counts once, and the room
/// is dropped only when the last connection closes).
struct RoomState {
    tx: broadcast::Sender<String>,
    members: HashMap<String, (Participant, u32)>,
}

/// All live collaboration rooms, keyed by Activity instance id. Ephemeral: a
/// room exists only while someone is connected and is forgotten when empty.
pub struct ActivityRooms {
    inner: Mutex<HashMap<String, RoomState>>,
}

impl Default for ActivityRooms {
    fn default() -> Self {
        Self::new()
    }
}

impl ActivityRooms {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Join `instance`: subscribe a receiver, register the participant, and
    /// broadcast the updated roster (the joiner is already subscribed, so it sees
    /// the roster too). `None` when the room cap is hit on a brand-new instance.
    fn join(
        &self,
        instance: &str,
        me: &Participant,
    ) -> Option<(broadcast::Sender<String>, broadcast::Receiver<String>)> {
        let mut map = self.inner.lock().ok()?;
        if !map.contains_key(instance) && map.len() >= MAX_ROOMS {
            return None;
        }
        let room = map.entry(instance.to_string()).or_insert_with(|| RoomState {
            tx: broadcast::channel(BROADCAST_CAP).0,
            members: HashMap::new(),
        });
        let rx = room.tx.subscribe();
        let entry = room.members.entry(me.id.clone()).or_insert((me.clone(), 0));
        entry.1 += 1;
        let roster = roster_json(&room.members);
        let tx = room.tx.clone();
        drop(map);
        let _ = tx.send(roster);
        Some((tx, rx))
    }

    /// Drop one of `uid`'s connections from `instance`; remove the participant
    /// when their last connection closes, the whole room when it empties, and
    /// broadcast the updated roster to anyone still connected.
    fn leave(&self, instance: &str, uid: &str) {
        let Ok(mut map) = self.inner.lock() else {
            return;
        };
        let Some(room) = map.get_mut(instance) else {
            return;
        };
        if let Some(entry) = room.members.get_mut(uid) {
            entry.1 = entry.1.saturating_sub(1);
            if entry.1 == 0 {
                room.members.remove(uid);
            }
        }
        if room.members.is_empty() {
            map.remove(instance);
        } else {
            let roster = roster_json(&room.members);
            let _ = room.tx.send(roster);
        }
    }
}

/// Serialise the current roster as the `{ type: "roster", participants }` frame
/// peers apply to render the presence list.
fn roster_json(members: &HashMap<String, (Participant, u32)>) -> String {
    let participants: Vec<Value> = members
        .values()
        .map(|(p, _)| json!({ "id": p.id, "name": p.name, "avatar": p.avatar }))
        .collect();
    json!({ "type": "roster", "participants": participants }).to_string()
}

#[derive(Deserialize)]
pub struct RoomQuery {
    /// Discord user access token — WebSockets can't carry an `Authorization`
    /// header, so the bearer rides in the query (same-origin to the iframe via
    /// Discord's proxy, forwarded over TLS).
    #[serde(default)]
    token: String,
    /// The Activity's guild, gated exactly like every other guild feature.
    #[serde(default)]
    guild: String,
}

/// `GET /api/activity/room/:instance` (WebSocket) — join the collaboration room
/// for an Activity instance. Authenticated by the bearer token in the query and
/// the same guild-membership gate the rest of the proxy enforces.
pub async fn activity_room(
    State(st): State<AppState>,
    Path(instance): Path<String>,
    Query(q): Query<RoomQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, AppError> {
    if !st.config.activities_enabled {
        return Err(not_enabled());
    }
    if !valid_instance(&instance) {
        return Err(bad_request("invalid instance id"));
    }
    if q.token.trim().is_empty() || !is_snowflake(&q.guild) {
        return Err(AppError::Unauthorized("missing activity credentials".into()));
    }
    let session = resolve_bearer(&st, q.token.trim()).await?;
    authorize_member_session(&st, session.clone(), &q.guild).await?;
    let me = Participant {
        id: session.uid,
        name: session.name,
        avatar: session.avatar,
    };
    Ok(ws.on_upgrade(move |socket| async move {
        room_socket(st, instance, me, socket).await;
    }))
}

/// Pump one participant's socket: relay anything they send to the whole room
/// (size-capped), forward the room's broadcast back to them, and deregister on
/// disconnect. Drafts are opaque here — the browser tags each with its own
/// connection id and ignores its own echo, so the server never has to understand
/// the payload, only fan it out.
async fn room_socket(st: AppState, instance: String, me: Participant, mut socket: WebSocket) {
    let Some((tx, mut rx)) = st.activity_rooms.join(&instance, &me) else {
        let _ = socket.send(Message::Close(None)).await;
        return;
    };
    loop {
        tokio::select! {
            inbound = socket.recv() => match inbound {
                Some(Ok(Message::Text(t))) => {
                    if t.len() <= MAX_RELAY_BYTES {
                        let _ = tx.send(t);
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {} // ignore binary / ping / pong
            },
            outbound = rx.recv() => match outbound {
                Ok(s) => {
                    if socket.send(Message::Text(s)).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
        }
    }
    st.activity_rooms.leave(&instance, &me.id);
}

/// Discord's Activity instance ids are short slugs; accept a bounded set of
/// URL-safe characters so a hostile path can't be used as a room key.
fn valid_instance(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_instance_accepts_slugs_and_rejects_paths() {
        assert!(valid_instance("i.abc-123_DEF"));
        assert!(!valid_instance(""));
        assert!(!valid_instance("../etc"));
        assert!(!valid_instance(&"x".repeat(101)));
    }

    #[test]
    fn roster_lists_unique_members() {
        let mut members = HashMap::new();
        members.insert(
            "1".to_string(),
            (
                Participant {
                    id: "1".into(),
                    name: "Ana".into(),
                    avatar: None,
                },
                2,
            ),
        );
        let s = roster_json(&members);
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["type"], "roster");
        assert_eq!(v["participants"].as_array().unwrap().len(), 1);
        assert_eq!(v["participants"][0]["name"], "Ana");
    }

    #[test]
    fn fingerprint_is_stable_and_token_specific() {
        assert_eq!(fingerprint("tok-abc"), fingerprint("tok-abc"));
        assert_ne!(fingerprint("tok-abc"), fingerprint("tok-xyz"));
    }
}
