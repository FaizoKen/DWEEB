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
use std::net::IpAddr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::PrivateCookieJar;
use reqwest::Url;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::discord::{DiscordUser, Webhook};
use crate::error::AppError;
use crate::routes::{
    authorize_activity_member, authorize_activity_webhooks, current_session, dispatcher_api,
    dispatcher_url_with_cap, ensure_channel_in_guild, is_snowflake, relay_dispatcher, AppState,
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

/// Keepalive for a room socket: how often the server pings (so an idle proxy/CDN
/// doesn't silently drop the connection, and a dead peer surfaces as a failed
/// send), and how long without *any* inbound frame — not even a pong — before we
/// reap a half-open/zombie connection. The timeout sits well over a couple of
/// ping intervals so a momentarily slow client isn't dropped.
const ROOM_PING_INTERVAL_SECS: u64 = 30;
const ROOM_IDLE_TIMEOUT_SECS: u64 = 90;

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

// ── Handshake telemetry (POST /api/activity/telemetry) ───────────────────────

#[derive(Deserialize)]
pub struct TelemetryBody {
    #[serde(default)]
    launch: String,
    #[serde(default)]
    stage: String,
    #[serde(default)]
    outcome: String,
    #[serde(default)]
    ms: f64,
    #[serde(default)]
    platform: String,
    #[serde(default)]
    instance: String,
    #[serde(default)]
    detail: String,
}

/// `POST /api/activity/telemetry` — record one embedded-Activity handshake stage.
///
/// A real in-Discord launch runs in a sandboxed iframe with no reachable console,
/// so a stalled handshake is otherwise invisible on our side. The browser beacons
/// each stage it enters (and any failure) here; we log it under a dedicated target
/// (`activity_handshake`) so *where* launches stall in the wild is greppable and
/// aggregatable straight from the proxy logs, with per-stage timings (`ms` is the
/// elapsed time since the launch began) reconstructable per `launch` id.
///
/// Diagnostic only, so it's deliberately **unauthenticated** — a stall can happen
/// before the access token even exists (SDK `ready`/`authorize`), which is exactly
/// the case we most want to catch. It's best-effort (answers `204` regardless) and
/// every field is clamped hard, so an anonymous caller can't turn it into a log-
/// spam or log-injection vector any more than they could the image proxy.
pub async fn activity_telemetry(
    State(st): State<AppState>,
    Json(body): Json<TelemetryBody>,
) -> Result<Response, AppError> {
    if !st.config.activities_enabled {
        return Err(not_enabled());
    }
    let launch = clamp_field(&body.launch, 48);
    let stage = clamp_field(&body.stage, 24);
    let outcome = clamp_field(&body.outcome, 12);
    let platform = clamp_field(&body.platform, 12);
    let instance = clamp_field(&body.instance, 100);
    // Only failures carry a reason; keep it short and single-line so it's one
    // clean log field.
    let detail = clamp_field(&body.detail, 200);
    // A finite, non-negative elapsed time (capped), or -1 for "not reported" —
    // never NaN/inf into the log.
    let ms: i64 = if body.ms.is_finite() && body.ms >= 0.0 {
        body.ms.min(600_000.0) as i64
    } else {
        -1
    };
    tracing::info!(
        target: "activity_handshake",
        %launch,
        %stage,
        %outcome,
        ms,
        %platform,
        %instance,
        %detail,
        "activity handshake stage",
    );
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Trim an untrusted telemetry string to a bounded, single-line snippet: drop
/// control characters (incl. newlines, so it can't forge extra log lines) and cap
/// the length. Keeps a hostile beacon from spamming or corrupting the log.
fn clamp_field(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect()
}

// ── Feedback relay (POST /api/activity/feedback) ─────────────────────────────

/// Discord caps a forum `thread_name` at 100 chars and a non-Nitro message
/// `content` at 2000; we clamp both here (the FE clamps too, but the proxy is the
/// authority on what actually reaches Discord). A forum channel has few tags, so
/// only a handful of tag ids are ever meaningful.
const FEEDBACK_THREAD_NAME_MAX: usize = 100;
const FEEDBACK_CONTENT_MAX: usize = 2000;
const FEEDBACK_MAX_TAGS: usize = 5;

#[derive(Deserialize)]
pub struct FeedbackBody {
    /// The forum post's title (the tag emoji + user's summary — see the web form).
    #[serde(default)]
    thread_name: String,
    /// The report body, already assembled by the FE (details + its own footer).
    #[serde(default)]
    content: String,
    /// The forum's own tag snowflakes to pre-sort the post under. Optional.
    #[serde(default)]
    applied_tags: Vec<String>,
}

/// `POST /api/activity/feedback` `{ thread_name, content, applied_tags }` — relay
/// a "Send feedback" report from the embedded Activity to DWEEB's feedback forum.
///
/// The web app posts feedback straight to the forum webhook from the browser, but
/// a sandboxed Activity iframe can't reach discord.com directly (the same reason
/// `activity_post` exists), so the proxy forwards it. The destination webhook is
/// held server-side (`FEEDBACK_WEBHOOK_URL`) — the browser never sees or names it,
/// so this can't be turned into an open relay to arbitrary webhooks. Bearer-gated
/// (only a signed-in Activity user can post) and we stamp the caller's *verified*
/// Discord identity onto the report, since the web form's self-typed contact could
/// be anyone. Answers `204` on a created post.
pub async fn activity_feedback(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    headers: HeaderMap,
    Json(body): Json<FeedbackBody>,
) -> Result<Response, AppError> {
    if !st.config.activities_enabled {
        return Err(not_enabled());
    }
    let Some(webhook_url) = st.config.feedback_webhook_url.as_deref() else {
        return Err(AppError::Status {
            status: StatusCode::NOT_IMPLEMENTED,
            message: "Feedback isn't available on this deployment.".into(),
            retry_after: None,
        });
    };
    // Identify the sender — also gates the endpoint to real Activity users, so it
    // can't be scripted into a feedback-forum spam cannon.
    let session = resolve_identity(&st, &jar, &headers).await?;

    let thread_name: String = body
        .thread_name
        .trim()
        .chars()
        .take(FEEDBACK_THREAD_NAME_MAX)
        .collect();
    let details = body.content.trim();
    if thread_name.is_empty() || details.is_empty() {
        return Err(bad_request("thread_name and content are required"));
    }

    // Append the verified sender under the report as quiet subtext, then hard-cap
    // the whole thing to Discord's content limit (the stamp always survives — the
    // details are trimmed to make room). The web form can only carry a self-typed
    // contact; here we know exactly who sent it.
    let stamp = format!(
        "\n-# ✅ {} ({}) · via DWEEB in Discord",
        session.name, session.uid
    );
    let room = FEEDBACK_CONTENT_MAX.saturating_sub(stamp.chars().count());
    let mut content: String = details.chars().take(room).collect();
    content.push_str(&stamp);

    // Forward only well-formed tag snowflakes so a malformed body can't 400 the
    // webhook; drop anything else.
    let applied_tags: Vec<String> = body
        .applied_tags
        .into_iter()
        .filter(|t| is_snowflake(t))
        .take(FEEDBACK_MAX_TAGS)
        .collect();

    let mut payload = json!({
        "thread_name": thread_name,
        "content": content,
        // Feedback must never ping anyone, even if the body contains a mention.
        "allowed_mentions": { "parse": [] },
    });
    if !applied_tags.is_empty() {
        payload["applied_tags"] = json!(applied_tags);
    }

    st.discord.post_webhook_url(webhook_url, &payload).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
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
    /// Keep the posted message's interactive components alive past the TTL by
    /// spending one of the guild's never-expire slots on it. Best-effort and only
    /// honoured for a message that actually has components — see the claim below.
    #[serde(default)]
    make_permanent: bool,
    /// Post under one of the server's registered custom bots instead of DWEEB:
    /// the app's id, whose Activity webhook was connected beforehand (see the
    /// custom-bot section below). Empty/absent = the standard DWEEB identity.
    #[serde(default)]
    application_id: String,
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
    let custom_app = parse_application_id(&body.application_id)?;

    authorize_activity_webhooks(&st, session.clone(), &guild).await?;
    ensure_channel_in_guild(&st, &guild, &channel_id).await?;

    let (webhook_id, token) = match custom_app.as_deref() {
        // Post as one of the server's own bots: through its connected Activity
        // webhook, brought to the destination channel first. The message then
        // carries the custom app's component routing — which the dispatcher
        // serves too, so plugins keep working.
        Some(app) => {
            let hook = require_custom_hook(&st, &guild, app).await?;
            ensure_custom_hook_in_channel(&st, &guild, app, &hook, &channel_id).await?;
            (hook.webhook_id, hook.token)
        }
        // Standard identity: reuse a DWEEB-owned incoming webhook already in
        // the channel (so we don't spawn duplicates, and never hijack a third
        // party's hook); otherwise mint one. Either way the post carries
        // DWEEB's component routing.
        None => match dweeb_webhook_in_channel(&st, &guild, &channel_id, None).await? {
            Some(found) => found,
            None => {
                let reason = format!("Created via DWEEB Activity by {}", session.uid);
                let w = st
                    .discord
                    .create_webhook(&channel_id, "DWEEB", None, Some(&reason))
                    .await?;
                let token = w.token.ok_or_else(|| {
                    AppError::BadGateway("Discord created a webhook without a token.".into())
                })?;
                (w.id, token)
            }
        },
    };

    let created = st
        .discord
        .execute_webhook(&webhook_id, &token, &body.message)
        .await?;
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

    // Optionally spend a never-expire slot on the message we just posted, so its
    // buttons & selects keep working past the deployment TTL. Best-effort and off
    // the post's critical path: a fresh post has no TTL-disabled components to
    // revive (unlike the dashboard grant), so the claim is the only step, and any
    // failure rides back as `permanent_error` rather than failing a post that has
    // already landed. The FE only offers the toggle for interactive messages, but
    // we re-guard on a real message id regardless.
    let (permanent, permanent_error) = if body.make_permanent && !message_id.is_empty() {
        match claim_permanent_slot(&st, &guild, &channel_id, &message_id, &session.uid).await {
            PermanentClaim::Claimed => (true, Value::Null),
            PermanentClaim::Full => (
                false,
                Value::String(
                    "Every never-expire slot is in use — free one in DWEEB on the web.".into(),
                ),
            ),
            // Feature isn't configured on this deployment — the FE wouldn't have
            // shown the toggle, so stay silent rather than surface a confusing note.
            PermanentClaim::Unavailable => (false, Value::Null),
            PermanentClaim::Failed => (
                false,
                Value::String(
                    "Couldn't reach the never-expire service — try again in DWEEB on the web."
                        .into(),
                ),
            ),
        }
    } else {
        (false, Value::Null)
    };

    // Land the post in the server's message library (best-effort, logged-only
    // failure): the Activity has no browser-local posted list, so this shared
    // record is what lets either surface reload the message later and update it
    // in place. The execute URL is sealed at rest by the library store.
    crate::library::record_posted_best_effort(
        &st,
        &guild,
        Some(&channel_id),
        &message_id,
        None,
        Some(&format!(
            "https://discord.com/api/webhooks/{webhook_id}/{token}"
        )),
        &body.message,
        None,
        None,
        &session.uid,
    )
    .await;

    Ok(Json(json!({
        "message_id": message_id,
        "channel_id": channel_id,
        "guild_id": guild,
        "url": jump,
        // The webhook that authored the message — the FE passes it back to
        // `activity_edit` so an update targets exactly this one.
        "webhook_id": webhook_id,
        // Which custom bot authored the post (null for DWEEB) — the FE carries
        // it into `activity_edit` so the update rides the same identity.
        "application_id": custom_app,
        // Never-expire outcome for the success dialog's receipt. `permanent` is
        // true only when a slot was actually claimed; `permanent_error` carries a
        // user-facing reason when the user asked but it couldn't be granted.
        "permanent": permanent,
        "permanent_error": permanent_error,
    }))
    .into_response())
}

/// Parse an optional custom-app id off a post/edit body: empty/absent means
/// the standard DWEEB identity, anything else must be a snowflake.
fn parse_application_id(raw: &str) -> Result<Option<String>, AppError> {
    match raw.trim() {
        "" => Ok(None),
        id if is_snowflake(id) => Ok(Some(id.to_string())),
        _ => Err(bad_request(
            "application_id must be a Discord application id",
        )),
    }
}

/// Outcome of a best-effort never-expire claim made right after a post.
enum PermanentClaim {
    /// A slot was spent on the message — its components won't expire.
    Claimed,
    /// Every slot is already taken (dispatcher answered 409).
    Full,
    /// The never-expire feature isn't configured on this deployment.
    Unavailable,
    /// The dispatcher couldn't be reached or answered unexpectedly.
    Failed,
}

/// Claim a never-expire slot for `message_id` via the interactions dispatcher's
/// internal `/permanent` API — the same service `routes::permanent_add` drives
/// for the web dashboard, called here with the resolved Activity session's user
/// as `added_by`. Never returns an error: the post has already landed, so a claim
/// problem is reported in the response, not raised.
async fn claim_permanent_slot(
    st: &AppState,
    guild: &str,
    channel_id: &str,
    message_id: &str,
    added_by: &str,
) -> PermanentClaim {
    let Ok(api) = dispatcher_api(st) else {
        return PermanentClaim::Unavailable;
    };
    // Enforce the destination server's *plan* cap, not the dispatcher's default:
    // an upgraded server gets its raised slot count here just as it does on the
    // web (see `routes::permanent_add`). Without this the claim silently caps at
    // the free PERMANENT_SLOTS_PER_GUILD default.
    let cap = st.entitlements.permanent_cap(guild).await;
    let req = api
        .http
        .post(dispatcher_url_with_cap(
            format!("{}/permanent/{guild}", api.base),
            cap,
        ))
        .bearer_auth(&api.token)
        .json(&json!({
            "message_id": message_id,
            "channel_id": channel_id,
            "added_by": added_by,
        }));
    match req.send().await {
        Ok(resp) => match resp.status().as_u16() {
            200 => PermanentClaim::Claimed,
            409 => PermanentClaim::Full,
            _ => PermanentClaim::Failed,
        },
        Err(_) => PermanentClaim::Failed,
    }
}

// ── Never-expire slot state (GET /api/activity/permanent) ────────────────────

#[derive(Deserialize)]
pub struct PermanentQuery {
    #[serde(default)]
    guild_id: String,
}

/// `GET /api/activity/permanent?guild_id=<id>` — never-expire slot usage for the
/// Activity's destination guild, so the pre-post confirm can show the "Never
/// expire" toggle (used/cap, the per-message TTL, and whether the feature is on).
///
/// The web app reads this from `/api/guilds/:id/permanent`, but that handler is
/// cookie-only (`authorize_member`); the Activity authenticates with a bearer, so
/// it needs this twin. Gated like the post itself — Manage Webhooks in the guild —
/// and relays the dispatcher's slots JSON verbatim, so the FE gets the exact same
/// shape (`{ cap, used, ttl_days, items }`) it parses for the web app. A `501`
/// means the feature is off on this deployment, which the FE treats as "no toggle".
pub async fn activity_permanent(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    headers: HeaderMap,
    Query(q): Query<PermanentQuery>,
) -> Result<Response, AppError> {
    if !st.config.activities_enabled {
        return Err(not_enabled());
    }
    let session = resolve_identity(&st, &jar, &headers).await?;
    let guild = q.guild_id.trim().to_string();
    if !is_snowflake(&guild) {
        return Err(bad_request("guild_id must be a Discord id"));
    }
    authorize_activity_webhooks(&st, session, &guild).await?;
    let api = dispatcher_api(&st)?;
    // Report slots against the server's *plan* cap (same source the web app's
    // `routes::permanent_list` uses), so an upgraded server shows its raised
    // count instead of the dispatcher's free default.
    let cap = st.entitlements.permanent_cap(&guild).await;
    let req = api
        .http
        .get(dispatcher_url_with_cap(
            format!("{}/permanent/{guild}", api.base),
            cap,
        ))
        .bearer_auth(&api.token);
    relay_dispatcher(req).await
}

// ── Server plan (GET /api/activity/plan) ─────────────────────────────────────

/// `GET /api/activity/plan?guild_id=<id>` — the destination server's tier,
/// per-feature limits, and whether in-app billing is available, so the Activity
/// can show a quiet plan indicator and a "see plans on web" hand-off.
///
/// The bearer twin of the web app's cookie-only `/api/guilds/:id/plan`; gated on
/// plain MEMBERSHIP like the other Activity reads (any member may see which plan
/// their server is on — it's display-only). Returns the exact same
/// `{ tier, limits, billing }` shape the web FE already parses. Unlike the web
/// handler it deliberately skips the Stripe legacy-claim/reconcile pass: that
/// binds the caller's floating subscription to the server, which is an owner
/// action, and this endpoint admits any member.
pub async fn activity_plan(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    headers: HeaderMap,
    Query(q): Query<PermanentQuery>,
) -> Result<Response, AppError> {
    if !st.config.activities_enabled {
        return Err(not_enabled());
    }
    let session = resolve_identity(&st, &jar, &headers).await?;
    let guild = q.guild_id.trim().to_string();
    if !is_snowflake(&guild) {
        return Err(bad_request("guild_id must be a Discord id"));
    }
    authorize_activity_member(&st, session, &guild).await?;
    let tier = st.entitlements.tier_for(&guild).await;
    let limits = st.entitlements.limits_for(tier);
    Ok(Json(json!({
        "tier": tier.as_str(),
        "limits": {
            "schedules": crate::entitlement::lim(limits.schedules),
            "permanent": crate::entitlement::lim(limits.permanent),
            "custom_bots": crate::entitlement::lim(limits.custom_bots),
            "coeditors": crate::entitlement::lim(limits.coeditors),
        },
        "billing": st.entitlements.enabled(),
    }))
    .into_response())
}

// ── Custom-bot identities (post as the server's own bot) ────────────────────
//
// A guild may register its own Discord application (`routes.rs` custom apps)
// so the dispatcher serves its interactions. The embedded Activity can also
// POST/PATCH **as** that bot: a one-time connect flow (see `auth.rs`,
// `ACTIVITY_WEBHOOK_STATE_PREFIX`) captures an app-owned incoming webhook and
// stores its token — sealed under this proxy's key — on the app's dispatcher-
// registry row. One webhook serves the whole server: before each use the
// proxy re-reads its live channel and, when the destination differs, moves it
// there with the bot's Manage Webhooks (an incoming webhook is re-pointable
// at any channel in its guild), then posts/edits with the webhook's own
// token. Messages appear under the server's bot, and their components route
// to that app — which the dispatcher serves, so DWEEB plugins keep working.

/// A stored Activity webhook, opened and ready to use.
struct CustomHook {
    webhook_id: String,
    token: String,
    /// The sealed token exactly as stored — kept so a channel move can write
    /// the registry row back without resealing.
    token_enc: String,
}

/// Outcome of looking up a custom bot's Activity webhook.
enum CustomHookState {
    Ready(CustomHook),
    /// Registered, but no Activity webhook is connected (or the stored one
    /// became unusable and was dropped).
    Missing,
    /// Registration paused: the server is over its plan's custom-bot cap.
    Suspended,
    /// The app isn't registered as a custom bot for this guild at all.
    NotRegistered,
}

/// Read a custom bot's stored Activity webhook from the dispatcher registry
/// and open its sealed token. A token sealed under a rotated key is dropped
/// (best-effort) and reported as [`CustomHookState::Missing`], so the user is
/// asked to reconnect rather than shown an opaque failure.
async fn fetch_custom_hook(
    st: &AppState,
    guild: &str,
    application_id: &str,
) -> Result<CustomHookState, AppError> {
    let api = dispatcher_api(st)?;
    let resp = api
        .http
        .get(format!(
            "{}/custom-apps/{guild}/{application_id}/hook",
            api.base
        ))
        .bearer_auth(&api.token)
        .send()
        .await
        .map_err(|e| AppError::BadGateway(format!("couldn't reach the dispatcher: {e}")))?;
    match resp.status().as_u16() {
        200 => {
            let v = resp
                .json::<Value>()
                .await
                .map_err(|e| AppError::BadGateway(format!("unexpected registry response: {e}")))?;
            if v.get("suspended").and_then(Value::as_bool).unwrap_or(false) {
                return Ok(CustomHookState::Suspended);
            }
            let hook_id = v
                .get("hook_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let token_enc = v
                .get("token_enc")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if hook_id.is_empty() || token_enc.is_empty() {
                return Ok(CustomHookState::Missing);
            }
            match crate::seal::open_hook(&st.key, &token_enc) {
                Some(token) => Ok(CustomHookState::Ready(CustomHook {
                    webhook_id: hook_id,
                    token,
                    token_enc,
                })),
                None => {
                    // Sealed under a key we no longer hold (SESSION_SECRET
                    // rotation) — unusable forever, so drop it now.
                    clear_activity_hook(st, guild, application_id).await;
                    Ok(CustomHookState::Missing)
                }
            }
        }
        404 => {
            let v = resp.json::<Value>().await.unwrap_or(Value::Null);
            match v.get("error").and_then(Value::as_str) {
                Some("no_hook") => Ok(CustomHookState::Missing),
                _ => Ok(CustomHookState::NotRegistered),
            }
        }
        _ => Err(AppError::BadGateway(
            "The custom-bot registry answered unexpectedly.".into(),
        )),
    }
}

/// Store (or refresh) a custom bot's Activity webhook on its registry row.
/// Called from the connect flow's callback (`auth.rs`) with a freshly sealed
/// token, and after a channel move to keep the row's channel note current.
pub(crate) async fn store_activity_hook(
    st: &AppState,
    guild: &str,
    application_id: &str,
    hook_id: &str,
    channel_id: &str,
    token_enc: &str,
) -> Result<(), AppError> {
    let api = dispatcher_api(st)?;
    let resp = api
        .http
        .put(format!(
            "{}/custom-apps/{guild}/{application_id}/hook",
            api.base
        ))
        .bearer_auth(&api.token)
        .json(&json!({
            "hook_id": hook_id,
            "channel_id": channel_id,
            "token_enc": token_enc,
        }))
        .send()
        .await
        .map_err(|e| AppError::BadGateway(format!("couldn't reach the dispatcher: {e}")))?;
    if resp.status().is_success() {
        return Ok(());
    }
    if resp.status().as_u16() == 404 {
        return Err(AppError::Status {
            status: StatusCode::NOT_FOUND,
            message: "That app isn't registered as a custom bot for this server.".into(),
            retry_after: None,
        });
    }
    Err(AppError::BadGateway(
        "The custom-bot registry answered unexpectedly.".into(),
    ))
}

/// Best-effort: drop a stored Activity webhook the proxy can no longer use
/// (deleted at Discord, or sealed under a rotated key). A failure only means
/// the next attempt re-discovers the same dead end.
async fn clear_activity_hook(st: &AppState, guild: &str, application_id: &str) {
    let Ok(api) = dispatcher_api(st) else { return };
    let _ = api
        .http
        .delete(format!(
            "{}/custom-apps/{guild}/{application_id}/hook",
            api.base
        ))
        .bearer_auth(&api.token)
        .send()
        .await;
}

/// Resolve a ready-to-use custom hook for a post/edit, mapping every
/// non-ready state to an actionable, user-facing error.
async fn require_custom_hook(
    st: &AppState,
    guild: &str,
    application_id: &str,
) -> Result<CustomHook, AppError> {
    match fetch_custom_hook(st, guild, application_id).await? {
        CustomHookState::Ready(hook) => Ok(hook),
        CustomHookState::Missing => Err(AppError::Status {
            status: StatusCode::CONFLICT,
            message: "This bot isn't connected to the Activity yet — connect it from the post \
                      dialog, then try again."
                .into(),
            retry_after: None,
        }),
        CustomHookState::Suspended => Err(AppError::Forbidden(
            "This custom bot is paused because the server is over its plan's custom-bot limit — \
             upgrade the server's plan on the web, or post as DWEEB."
                .into(),
        )),
        CustomHookState::NotRegistered => Err(AppError::Status {
            status: StatusCode::NOT_FOUND,
            message: "That app isn't registered as a custom bot for this server.".into(),
            retry_after: None,
        }),
    }
}

/// Make sure the custom hook currently sits in `channel_id`, moving it there
/// with the bot's Manage Webhooks when it doesn't. Discord resolves webhook
/// posts *and* webhook-message reads/edits within the webhook's current
/// channel, so every custom-bot use runs through here first. A webhook
/// Discord no longer honours is dropped from the registry with a clear
/// "reconnect it" error.
async fn ensure_custom_hook_in_channel(
    st: &AppState,
    guild: &str,
    application_id: &str,
    hook: &CustomHook,
    channel_id: &str,
) -> Result<(), AppError> {
    let live = st
        .discord
        .webhook_by_token(&hook.webhook_id, &hook.token)
        .await?
        // Gone at Discord, or (paranoia — a webhook can't change guilds)
        // somehow not this server's: treat both as unusable.
        .filter(|w| w.guild_id.as_deref() == Some(guild));
    let Some(live) = live else {
        clear_activity_hook(st, guild, application_id).await;
        return Err(AppError::Status {
            status: StatusCode::CONFLICT,
            message: "This bot's Activity webhook is gone — it may have been deleted in Discord. \
                      Reconnect it from the post dialog, then try again."
                .into(),
            retry_after: None,
        });
    };
    if live.channel_id.as_deref() != Some(channel_id) {
        st.discord
            .modify_webhook(
                &hook.webhook_id,
                None,
                None,
                Some(channel_id),
                Some("Moved by DWEEB Activity to post as this server's bot"),
            )
            .await?;
        // Keep the registry's channel note current — best-effort, the live
        // channel is re-read from Discord on every use anyway.
        let _ = store_activity_hook(
            st,
            guild,
            application_id,
            &hook.webhook_id,
            channel_id,
            &hook.token_enc,
        )
        .await;
    }
    Ok(())
}

/// The guild's custom bots that have an Activity webhook connected and aren't
/// plan-suspended — restore's candidate authors. Empty when the dispatcher is
/// off or unreachable (restore then covers DWEEB's own webhooks only).
async fn custom_apps_with_hooks(st: &AppState, guild: &str) -> Vec<String> {
    let Ok(api) = dispatcher_api(st) else {
        return Vec::new();
    };
    let cap = st.entitlements.custom_bots_cap(guild).await;
    let resp = api
        .http
        .get(dispatcher_url_with_cap(
            format!("{}/custom-apps/{guild}", api.base),
            cap,
        ))
        .bearer_auth(&api.token)
        .send()
        .await;
    let Ok(resp) = resp else { return Vec::new() };
    if !resp.status().is_success() {
        return Vec::new();
    }
    let Ok(v) = resp.json::<Value>().await else {
        return Vec::new();
    };
    v.get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|i| {
                    i.get("has_hook").and_then(Value::as_bool).unwrap_or(false)
                        && !i.get("suspended").and_then(Value::as_bool).unwrap_or(false)
                })
                .filter_map(|i| i.get("application_id").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

// ── Identities (GET /api/activity/identities) ───────────────────────────────

/// `GET /api/activity/identities?guild_id=<id>` — who the Activity can post
/// as in the destination server: always DWEEB, plus each registered (non-
/// suspended) custom bot. `ready` means an Activity webhook is connected and
/// the bot is pickable right away; `can_connect` means the one-time connect
/// flow is available (a client secret is on file). Gated like the post itself
/// (Manage Webhooks), since this list exists purely to pick a posting
/// identity. Deployments without the dispatcher just get DWEEB.
pub async fn activity_identities(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    headers: HeaderMap,
    Query(q): Query<PermanentQuery>,
) -> Result<Response, AppError> {
    if !st.config.activities_enabled {
        return Err(not_enabled());
    }
    let session = resolve_identity(&st, &jar, &headers).await?;
    let guild = q.guild_id.trim().to_string();
    if !is_snowflake(&guild) {
        return Err(bad_request("guild_id must be a Discord id"));
    }
    authorize_activity_webhooks(&st, session, &guild).await?;

    let mut identities = vec![json!({ "kind": "dweeb" })];
    if let Ok(api) = dispatcher_api(&st) {
        let cap = st.entitlements.custom_bots_cap(&guild).await;
        let resp = api
            .http
            .get(dispatcher_url_with_cap(
                format!("{}/custom-apps/{guild}", api.base),
                cap,
            ))
            .bearer_auth(&api.token)
            .send()
            .await;
        // Registry problems degrade to "no custom bots" — the standard DWEEB
        // identity must never be blocked by the registry being down.
        let items = match resp {
            Ok(resp) if resp.status().is_success() => resp.json::<Value>().await.ok(),
            _ => None,
        };
        if let Some(items) = items
            .as_ref()
            .and_then(|v| v.get("items"))
            .and_then(Value::as_array)
        {
            for item in items {
                if item
                    .get("suspended")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    continue;
                }
                identities.push(json!({
                    "kind": "custom",
                    "application_id": item.get("application_id").and_then(Value::as_str).unwrap_or_default(),
                    "name": item.get("name").and_then(Value::as_str).unwrap_or_default(),
                    "ready": item.get("has_hook").and_then(Value::as_bool).unwrap_or(false),
                    "can_connect": item.get("has_secret").and_then(Value::as_bool).unwrap_or(false),
                }));
            }
        }
    }
    Ok(Json(json!({ "identities": identities })).into_response())
}

// ── Connect a custom bot (POST /api/activity/connect-bot) ───────────────────

#[derive(Deserialize)]
pub struct ConnectBotBody {
    #[serde(default)]
    guild_id: String,
    #[serde(default)]
    application_id: String,
    /// The Activity instance to notify when the connect completes, so the room
    /// hears about it over the live socket (see `ActivityRooms::notify`).
    /// Optional — an empty/absent id just skips the push and leans on the
    /// dialog's own re-check.
    #[serde(default)]
    instance_id: String,
}

/// `POST /api/activity/connect-bot` `{ guild_id, application_id }` — mint the
/// authorize URL for the one-time "connect your bot" flow. The Activity opens
/// it in the user's external browser (the sandboxed iframe can't navigate to
/// discord.com); Discord shows its `webhook.incoming` consent under the
/// custom app, and the callback captures + stores the webhook server-side
/// (see `auth.rs`). The flow context rides sealed inside the URL's `state`,
/// so no cookie has to survive the browser hop. Gated on Manage Webhooks like
/// the posting this enables.
pub async fn activity_connect_bot(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    headers: HeaderMap,
    Json(body): Json<ConnectBotBody>,
) -> Result<Response, AppError> {
    if !st.config.activities_enabled {
        return Err(not_enabled());
    }
    let session = resolve_identity(&st, &jar, &headers).await?;
    let guild = body.guild_id.trim().to_string();
    let application_id = body.application_id.trim().to_string();
    if !is_snowflake(&guild) || !is_snowflake(&application_id) {
        return Err(bad_request(
            "guild_id and application_id must be Discord ids",
        ));
    }
    // The instance id only steers the completion push, so a malformed one is
    // simply dropped (no push) rather than failing the connect.
    let instance = body.instance_id.trim();
    let instance = if valid_instance(instance) {
        instance
    } else {
        ""
    };
    authorize_activity_webhooks(&st, session, &guild).await?;
    let url =
        crate::auth::activity_connect_authorize_url(&st, &guild, &application_id, instance).await?;
    Ok(Json(json!({ "url": url })).into_response())
}

/// Find a DWEEB-owned incoming webhook in `channel_id` whose token we can post
/// through. `prefer` names a specific webhook id to use when it's still valid
/// (an edit naming the webhook that authored the message) — otherwise any
/// DWEEB-owned hook in the channel. `None` when there's no usable DWEEB webhook.
async fn dweeb_webhook_in_channel(
    st: &AppState,
    guild: &str,
    channel_id: &str,
    prefer: Option<&str>,
) -> Result<Option<(String, String)>, AppError> {
    let hooks = st.discord.guild_webhooks(guild).await?;
    let client_id = st.config.client_id.as_str();
    let chosen = prefer
        .and_then(|id| {
            hooks
                .iter()
                .find(|&w| w.id == id && webhook_is_ours(w, channel_id, client_id))
        })
        .or_else(|| {
            hooks
                .iter()
                .find(|&w| webhook_is_ours(w, channel_id, client_id))
        });
    Ok(chosen.map(|w| (w.id.clone(), w.token.clone().unwrap_or_default())))
}

/// Whether `w` is a DWEEB-owned incoming webhook in `channel_id` with a usable
/// token — the gate for reusing (or editing through) it.
fn webhook_is_ours(w: &Webhook, channel_id: &str, client_id: &str) -> bool {
    w.kind == 1
        && w.channel_id.as_deref() == Some(channel_id)
        && w.token.as_deref().is_some_and(|t| !t.is_empty())
        && w.application_id.as_deref() == Some(client_id)
}

// ── Edit a posted message (POST /api/activity/edit) ──────────────────────────

#[derive(Deserialize)]
pub struct EditBody {
    #[serde(default)]
    guild_id: String,
    #[serde(default)]
    channel_id: String,
    #[serde(default)]
    message_id: String,
    /// The webhook that authored the message (from the post response). Optional —
    /// we fall back to any DWEEB-owned hook in the channel — but re-verified
    /// server-side before use, so a forged id can't redirect the edit.
    #[serde(default)]
    webhook_id: String,
    /// The custom bot that authored the message (from the post response), when
    /// it wasn't DWEEB — the edit then rides that bot's connected Activity
    /// webhook. Empty/absent = the standard DWEEB path.
    #[serde(default)]
    application_id: String,
    /// The wire payload the browser rebuilt (components + flags + username/avatar).
    message: Value,
}

/// `POST /api/activity/edit` `{ guild_id, channel_id, message_id, webhook_id,
/// message }` — PATCH a message previously posted from this Activity, through the
/// same DWEEB-owned webhook. Gated identically to `activity_post` (the user must
/// hold Manage Webhooks in the guild), and the webhook is re-verified to be
/// DWEEB-owned in the target channel before the edit — Discord additionally only
/// lets a webhook edit a message it authored, so a valid `message_id` for another
/// author just fails. Returns the message id + jump link.
pub async fn activity_edit(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    headers: HeaderMap,
    Json(body): Json<EditBody>,
) -> Result<Response, AppError> {
    if !st.config.activities_enabled {
        return Err(not_enabled());
    }
    let session = resolve_identity(&st, &jar, &headers).await?;
    let guild = body.guild_id.trim().to_string();
    let channel_id = body.channel_id.trim().to_string();
    let message_id = body.message_id.trim().to_string();
    if !is_snowflake(&guild) || !is_snowflake(&channel_id) || !is_snowflake(&message_id) {
        return Err(bad_request(
            "guild_id, channel_id and message_id must be Discord ids",
        ));
    }
    if !body.message.is_object() {
        return Err(bad_request("message must be a JSON object"));
    }
    let prefer = match body.webhook_id.trim() {
        "" => None,
        id if is_snowflake(id) => Some(id),
        _ => return Err(bad_request("webhook_id must be a Discord id")),
    };
    let custom_app = parse_application_id(&body.application_id)?;

    authorize_activity_webhooks(&st, session.clone(), &guild).await?;
    ensure_channel_in_guild(&st, &guild, &channel_id).await?;

    let (webhook_id, token) = match custom_app.as_deref() {
        // The message was posted as one of the server's own bots: edit through
        // its connected Activity webhook, brought back to the message's channel
        // first (Discord resolves webhook-message edits within the webhook's
        // current channel).
        Some(app) => {
            let hook = require_custom_hook(&st, &guild, app).await?;
            // Only the webhook that authored a message can edit it. A stored
            // hook that no longer matches the author (it was reconnected since
            // the post) can't succeed — say so instead of relaying Discord's
            // opaque unknown-message error.
            if prefer.is_some_and(|id| id != hook.webhook_id) {
                return Err(bad_request(
                    "This message was posted through a webhook that's since been replaced — it can't be updated anymore. Post it again.",
                ));
            }
            ensure_custom_hook_in_channel(&st, &guild, app, &hook, &channel_id).await?;
            (hook.webhook_id, hook.token)
        }
        None => dweeb_webhook_in_channel(&st, &guild, &channel_id, prefer)
            .await?
            .ok_or_else(|| {
                bad_request(
                    "Couldn't find the DWEEB webhook that posted this message — post it again.",
                )
            })?,
    };

    st.discord
        .edit_webhook_message(&webhook_id, &token, &message_id, body.message.clone())
        .await?;

    // Refresh the message's library entry (or create one, for a message posted
    // before the library existed) so the shared shelf tracks the live content.
    crate::library::record_posted_best_effort(
        &st,
        &guild,
        Some(&channel_id),
        &message_id,
        None,
        Some(&format!(
            "https://discord.com/api/webhooks/{webhook_id}/{token}"
        )),
        &body.message,
        None,
        None,
        &session.uid,
    )
    .await;

    Ok(Json(json!({
        "message_id": message_id,
        "channel_id": channel_id,
        "guild_id": guild,
        "url": format!("https://discord.com/channels/{guild}/{channel_id}/{message_id}"),
        "webhook_id": webhook_id,
        "application_id": custom_app,
    }))
    .into_response())
}

// ── Restore a posted message (POST /api/activity/restore) ────────────────────

#[derive(Deserialize)]
pub struct RestoreBody {
    #[serde(default)]
    guild_id: String,
    #[serde(default)]
    channel_id: String,
    #[serde(default)]
    message_id: String,
}

/// `POST /api/activity/restore` `{ guild_id, channel_id, message_id }` — pull a
/// message DWEEB previously posted in the channel back into the editor.
///
/// The web app's Restore makes the user paste the *webhook URL* that authored the
/// message (a secret only their browser holds). Inside the Activity that URL would
/// be a credential we can't expose to the iframe — but we don't need it: the proxy
/// already finds the DWEEB-owned webhook in the channel (the same one `post`/`edit`
/// use), so the user supplies only a message id (or link) and the lookup is
/// automatic. That's the whole simplification over the web flow.
///
/// Gated identically to `activity_post`/`activity_edit` (the user must hold Manage
/// Webhooks in the guild). Discord only returns a message to the webhook that
/// authored it, so a 404 here means the id isn't a message DWEEB's webhook posted
/// in this channel — never a user/bot/other-webhook message, even in the same
/// channel. The returned `webhook_id` matches what `post` returns, so the FE can
/// wire an in-place update to the restored message straight away.
pub async fn activity_restore(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    headers: HeaderMap,
    Json(body): Json<RestoreBody>,
) -> Result<Response, AppError> {
    if !st.config.activities_enabled {
        return Err(not_enabled());
    }
    let session = resolve_identity(&st, &jar, &headers).await?;
    let guild = body.guild_id.trim().to_string();
    let channel_id = body.channel_id.trim().to_string();
    let message_id = body.message_id.trim().to_string();
    if !is_snowflake(&guild) || !is_snowflake(&channel_id) || !is_snowflake(&message_id) {
        return Err(bad_request(
            "guild_id, channel_id and message_id must be Discord ids",
        ));
    }

    authorize_activity_webhooks(&st, session.clone(), &guild).await?;
    ensure_channel_in_guild(&st, &guild, &channel_id).await?;

    // Candidate authors, DWEEB's own webhook first (it never has to be moved).
    // Then each connected custom bot: its roaming Activity webhook may need to
    // be brought back to this channel before Discord will return the message
    // (webhook-message reads resolve within the webhook's current channel).
    // Discord only returns a message to the webhook that authored it, so a
    // wrong candidate is a clean miss, never a leak.
    let mut found: Option<(Value, String, Option<String>)> = None;
    let mut had_candidate = false;
    if let Some((webhook_id, token)) =
        dweeb_webhook_in_channel(&st, &guild, &channel_id, None).await?
    {
        had_candidate = true;
        if let Some(m) = st
            .discord
            .webhook_message(&webhook_id, &token, &message_id)
            .await?
        {
            found = Some((m, webhook_id, None));
        }
    }
    if found.is_none() {
        for app in custom_apps_with_hooks(&st, &guild).await {
            let Ok(CustomHookState::Ready(hook)) = fetch_custom_hook(&st, &guild, &app).await
            else {
                continue;
            };
            had_candidate = true;
            // A hook that turns out dead (or unmovable) just drops out of the
            // candidate set — restore reports "not found" rather than erroring.
            if ensure_custom_hook_in_channel(&st, &guild, &app, &hook, &channel_id)
                .await
                .is_err()
            {
                continue;
            }
            if let Some(m) = st
                .discord
                .webhook_message(&hook.webhook_id, &hook.token, &message_id)
                .await?
            {
                found = Some((m, hook.webhook_id, Some(app)));
                break;
            }
        }
    }
    let Some((message, webhook_id, application_id)) = found else {
        return Err(if had_candidate {
            AppError::Status {
                status: StatusCode::NOT_FOUND,
                message: "Discord couldn't find that message under this server's DWEEB or \
                          connected-bot webhooks. Only a message posted through them can be \
                          restored."
                    .into(),
                retry_after: None,
            }
        } else {
            bad_request(
                "DWEEB hasn't posted in this channel yet — only messages DWEEB (or a connected custom bot) posted here can be restored.",
            )
        });
    };

    Ok(Json(json!({
        // The raw Discord message — the browser decodes it into the editor.
        "message": message,
        "message_id": message_id,
        "channel_id": channel_id,
        "guild_id": guild,
        "url": format!("https://discord.com/channels/{guild}/{channel_id}/{message_id}"),
        // Same webhook id `post` returns, so a follow-up edit targets this hook.
        "webhook_id": webhook_id,
        // The custom bot that authored it (null for DWEEB), so a follow-up
        // update rides the same identity.
        "application_id": application_id,
    }))
    .into_response())
}

// ── Image proxy (GET /api/activity/image?url=…) ──────────────────────────────

/// Hard bounds for the image proxy, so it can't be turned into a probe or an
/// open bandwidth relay: how long a fetch may take, the largest body we'll relay,
/// and how many redirect hops we'll follow.
const IMAGE_FETCH_TIMEOUT_SECS: u64 = 10;
const MAX_IMAGE_BYTES: usize = 12 * 1024 * 1024; // comfortably over Discord's media sizes
const MAX_IMAGE_REDIRECTS: usize = 4;

#[derive(Deserialize)]
pub struct ImageQuery {
    #[serde(default)]
    url: String,
}

/// Lazily-built HTTP client for the image proxy. It needs its own redirect policy
/// (validate every hop's host so a 3xx can't bounce us onto a private address)
/// and a short timeout, so it's separate from the Discord client. Built once.
fn image_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(IMAGE_FETCH_TIMEOUT_SECS))
            .user_agent(concat!("dweeb-proxy-img/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= MAX_IMAGE_REDIRECTS {
                    return attempt.error("too many redirects");
                }
                // Block redirects onto IP-literals / obvious internal names. A
                // hostname that *resolves* to a private IP is caught after the
                // fact via the response's remote address (see below).
                if redirect_host_blocked(attempt.url()) {
                    attempt.error("redirect to a non-public host")
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .expect("failed to build image proxy HTTP client")
    })
}

/// `GET /api/activity/image?url=<encoded http(s) URL>` — fetch an external image
/// or video on the browser's behalf and relay the bytes.
///
/// The embedded Activity runs in a sandboxed `…discordsays.com` iframe whose CSP
/// only allows media from Discord's own origins (and the hosts we URL-map). The
/// arbitrary image/video URLs people paste into the builder are therefore blocked
/// when loaded as `<img>`/`<video>` — and, unlike `fetch`/XHR, those element
/// loads aren't rewritten by the SDK. The FE routes them here; this endpoint runs
/// same-origin to the iframe (via Discord's `/proxy` mapping), so the bytes
/// render.
///
/// No auth — an `<img>` can't send a bearer — so it's bounded hard instead:
/// http(s) only, public hosts only (SSRF defence), a short timeout, a size cap,
/// and only `image/*`/`video/*` content is relayed.
pub async fn activity_image(
    State(st): State<AppState>,
    Query(q): Query<ImageQuery>,
) -> Result<Response, AppError> {
    if !st.config.activities_enabled {
        return Err(not_enabled());
    }
    let target = q.url.trim();
    if target.is_empty() {
        return Err(bad_request("url is required"));
    }
    let parsed = Url::parse(target).map_err(|_| bad_request("url must be an absolute URL"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(bad_request("url must be http(s)"));
    }
    // SSRF: resolve the host and refuse if any address is non-public, before we
    // connect. (Redirect hops are vetted by the client's redirect policy, and the
    // final connection is re-checked below to catch DNS rebinding.)
    ensure_public_host(&parsed).await?;

    let mut resp = image_client()
        .get(parsed)
        .send()
        .await
        .map_err(|e| AppError::BadGateway(format!("couldn't fetch the image: {e}")))?;

    // Drop a response served from a private address even if the hostname looked
    // public (DNS rebinding) — before relaying any bytes.
    if let Some(addr) = resp.remote_addr() {
        if !ip_is_public(addr.ip()) {
            return Err(blocked_host());
        }
    }
    if !resp.status().is_success() {
        return Err(AppError::BadGateway(format!(
            "upstream returned {}",
            resp.status().as_u16()
        )));
    }

    let content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    // Only relay actual media — never HTML/JSON/etc. Defence in depth: keeps the
    // proxy from echoing an internal service's response if one ever slipped past
    // the host checks.
    let kind = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !(kind.starts_with("image/") || kind.starts_with("video/")) {
        return Err(bad_request("that URL isn't an image or video"));
    }

    // Reject up front when the server declares an oversize length…
    if let Some(len) = resp.content_length() {
        if len > MAX_IMAGE_BYTES as u64 {
            return Err(bad_request("image is too large"));
        }
    }
    // …and bound the actual read, so a missing or lying Content-Length can't blow
    // past the cap (or exhaust memory). `chunk()` is available without reqwest's
    // `stream` feature, so we accumulate by hand.
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| AppError::BadGateway(format!("couldn't read the image: {e}")))?
    {
        if buf.len() + chunk.len() > MAX_IMAGE_BYTES {
            return Err(bad_request("image is too large"));
        }
        buf.extend_from_slice(&chunk);
    }

    let mut out = Response::new(Body::from(buf));
    if let Ok(v) = HeaderValue::from_str(&content_type) {
        out.headers_mut().insert(header::CONTENT_TYPE, v);
    }
    // Cache hard at the browser + Discord's edge: a given URL renders the same
    // bytes for our purposes, so caching keeps repeat previews off our bandwidth.
    out.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=86400"),
    );
    Ok(out)
}

/// Refuse a fetch target whose host is plainly internal: an IP-literal in a
/// private/reserved range, an internal-looking name, or a hostname that *resolves*
/// only/partly to non-public addresses.
async fn ensure_public_host(url: &Url) -> Result<(), AppError> {
    let host = url
        .host_str()
        .ok_or_else(|| bad_request("url has no host"))?;
    if let Ok(ip) = host.parse::<IpAddr>() {
        return if ip_is_public(ip) {
            Ok(())
        } else {
            Err(blocked_host())
        };
    }
    if host_name_is_internal(host) {
        return Err(blocked_host());
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let mut resolved = false;
    for addr in tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| AppError::BadGateway("couldn't resolve the image host".into()))?
    {
        resolved = true;
        if !ip_is_public(addr.ip()) {
            return Err(blocked_host());
        }
    }
    if !resolved {
        return Err(AppError::BadGateway(
            "couldn't resolve the image host".into(),
        ));
    }
    Ok(())
}

fn blocked_host() -> AppError {
    AppError::Forbidden("that host isn't allowed".into())
}

/// Hostnames that can't be a public site: localhost, the non-routable suffixes
/// used for internal/service discovery, and bare single-label names.
fn host_name_is_internal(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    h == "localhost"
        || h.ends_with(".localhost")
        || h.ends_with(".local")
        || h.ends_with(".internal")
        || h.ends_with(".intranet")
        || !h.contains('.') // single-label → an internal/service name, never a public host
}

/// Sync host check for the redirect policy (no DNS): block IP-literals in a
/// non-public range and obviously-internal names.
fn redirect_host_blocked(url: &Url) -> bool {
    match url.host_str() {
        None => true,
        Some(host) => match host.parse::<IpAddr>() {
            Ok(ip) => !ip_is_public(ip),
            Err(_) => host_name_is_internal(host),
        },
    }
}

/// Whether an address is a public, routable unicast address — the allowlist for
/// the image proxy. Everything private/reserved (loopback, RFC1918, link-local
/// incl. cloud metadata `169.254.169.254`, CGNAT, ULA, …) is refused.
fn ip_is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xc0) == 64) // 100.64.0.0/10 CGNAT
                || o[0] >= 240) // 240.0.0.0/4 reserved
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return ip_is_public(IpAddr::V4(v4));
            }
            let seg = v6.segments();
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (seg[0] & 0xfe00) == 0xfc00 // fc00::/7 unique-local
                || (seg[0] & 0xffc0) == 0xfe80) // fe80::/10 link-local
        }
    }
}

// ── Plugin config proxy (GET /api/activity/plugin, * /api/activity/plugin-fetch) ─

/// Hard bounds for the plugin proxy, mirroring the image proxy: a short fetch
/// timeout, the largest config page we'll relay, and the largest single API
/// response we'll relay back to the iframe.
const MAX_PLUGIN_HTML_BYTES: usize = 2 * 1024 * 1024;
const MAX_PLUGIN_RESP_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
pub struct PluginUrlQuery {
    #[serde(default)]
    url: String,
}

/// Whether a plugin host is on the configured allow-list — it equals an entry or
/// is a sub-domain of one (`quickreplies.dweeb.faizo.net` ⊂ `dweeb.faizo.net`).
/// This is what keeps the plugin proxy from being a general open relay.
fn plugin_host_allowed(host: &str, allow: &[String]) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    allow.iter().any(|entry| {
        let e = entry
            .trim()
            .trim_start_matches('.')
            .trim_end_matches('.')
            .to_ascii_lowercase();
        !e.is_empty() && (h == e || h.ends_with(&format!(".{e}")))
    })
}

/// Parse + vet a plugin URL: absolute https, host on the allow-list, and (SSRF)
/// resolving only to public addresses. Returns the parsed `Url` on success.
async fn ensure_plugin_target(raw: &str, allow: &[String]) -> Result<Url, AppError> {
    let parsed = Url::parse(raw).map_err(|_| bad_request("url must be an absolute URL"))?;
    if parsed.scheme() != "https" {
        return Err(bad_request("plugin url must be https"));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| bad_request("plugin url has no host"))?;
    if !plugin_host_allowed(host, allow) {
        return Err(AppError::Forbidden("that plugin host isn't allowed".into()));
    }
    ensure_public_host(&parsed).await?;
    Ok(parsed)
}

/// `GET /api/activity/plugin?url=<encoded https config URL>` — serve a plugin's
/// configuration page *through* the proxy so it loads same-origin inside Discord.
///
/// A plugin's config iframe lives on its own `*.dweeb.faizo.net` host. On the web
/// app the editor's CSP whitelists those origins, but the embedded Activity runs
/// in a sandboxed `…discordsays.com` iframe whose CSP only allows Discord's own
/// origins and our URL-mapped host — so the cross-origin plugin frame is blocked
/// and renders blank. We fetch the page here and return it from the proxy (which
/// the iframe reaches over the same `/proxy` mapping as everything else), making
/// it same-origin and CSP-allowed. A small shim is injected so the page's own
/// absolute `/api/*` calls are re-routed back through [`activity_plugin_fetch`]
/// (the iframe is sandboxed to an opaque origin, so it can't reach the plugin
/// host directly either). No per-plugin changes are needed.
pub async fn activity_plugin_frame(
    State(st): State<AppState>,
    Query(q): Query<PluginUrlQuery>,
) -> Result<Response, AppError> {
    if !st.config.activities_enabled {
        return Err(not_enabled());
    }
    let raw = q.url.trim();
    if raw.is_empty() {
        return Err(bad_request("url is required"));
    }
    let target = ensure_plugin_target(raw, &st.config.activity_plugin_hosts).await?;
    let upstream_origin = target.origin().ascii_serialization();

    let mut resp = image_client()
        .get(target)
        .send()
        .await
        .map_err(|e| AppError::BadGateway(format!("couldn't load the plugin: {e}")))?;
    if let Some(addr) = resp.remote_addr() {
        if !ip_is_public(addr.ip()) {
            return Err(blocked_host());
        }
    }
    if !resp.status().is_success() {
        return Err(AppError::BadGateway(format!(
            "plugin returned {}",
            resp.status().as_u16()
        )));
    }
    let content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !content_type.contains("text/html") {
        return Err(bad_request("plugin config URL didn't return HTML"));
    }

    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| AppError::BadGateway(format!("couldn't read the plugin: {e}")))?
    {
        if buf.len() + chunk.len() > MAX_PLUGIN_HTML_BYTES {
            return Err(bad_request("plugin config page is too large"));
        }
        buf.extend_from_slice(&chunk);
    }

    let html = String::from_utf8_lossy(&buf);
    let injected = inject_plugin_shim(&html, &upstream_origin);

    let mut out = Response::new(Body::from(injected));
    out.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    // The page is re-derived from `?url` each load and carries a baked shim, so
    // don't let it sit in a cache; `nosniff` keeps the relayed bytes typed as set.
    out.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    out.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(out)
}

/// `(GET|POST|PUT|PATCH|DELETE) /api/activity/plugin-fetch?url=<encoded>` — relay
/// a single plugin API call on the sandboxed iframe's behalf.
///
/// The page served by [`activity_plugin_frame`] is sandboxed to an opaque origin,
/// so its own `fetch("/api/…")` calls can't reach the plugin host. The injected
/// shim rewrites them to this endpoint, which forwards the method + JSON body to
/// the real plugin host and relays the response. Same allow-list + SSRF + size
/// bounds as the page loader. Cookies and the Activity bearer are deliberately
/// **not** forwarded — these plugin endpoints are unauthenticated, and we never
/// hand a plugin the user's Discord token.
pub async fn activity_plugin_fetch(
    State(st): State<AppState>,
    method: Method,
    Query(q): Query<PluginUrlQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, AppError> {
    if !st.config.activities_enabled {
        return Err(not_enabled());
    }
    // The CORS layer answers the preflight; only real verbs reach the handler.
    if !matches!(
        method,
        Method::GET | Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) {
        return Err(bad_request("unsupported method"));
    }
    let raw = q.url.trim();
    if raw.is_empty() {
        return Err(bad_request("url is required"));
    }
    let target = ensure_plugin_target(raw, &st.config.activity_plugin_hosts).await?;

    let mut req = image_client().request(method, target);
    // Forward only the content type — never cookies or the Activity bearer.
    if let Some(ct) = headers.get(header::CONTENT_TYPE) {
        req = req.header(header::CONTENT_TYPE, ct);
    }
    if !body.is_empty() {
        req = req.body(body.to_vec());
    }

    let mut resp = req
        .send()
        .await
        .map_err(|e| AppError::BadGateway(format!("couldn't reach the plugin: {e}")))?;
    if let Some(addr) = resp.remote_addr() {
        if !ip_is_public(addr.ip()) {
            return Err(blocked_host());
        }
    }
    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = resp.headers().get(header::CONTENT_TYPE).cloned();

    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| AppError::BadGateway(format!("couldn't read the plugin response: {e}")))?
    {
        if buf.len() + chunk.len() > MAX_PLUGIN_RESP_BYTES {
            return Err(bad_request("plugin response is too large"));
        }
        buf.extend_from_slice(&chunk);
    }

    let mut out = Response::new(Body::from(buf));
    *out.status_mut() = status;
    if let Some(ct) = content_type {
        out.headers_mut().insert(header::CONTENT_TYPE, ct);
    }
    out.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(out)
}

/// Insert the fetch-rewriting shim at the top of the page's `<head>` so it runs
/// before the plugin's own (end-of-`<body>`) script makes any call.
fn inject_plugin_shim(html: &str, upstream_origin: &str) -> String {
    // `upstream_origin` is a URL origin (scheme://host[:port]) — no quotes or
    // control chars are possible — but JSON-encode it anyway so it's an unarguably
    // safe JS string literal.
    let up = serde_json::to_string(upstream_origin).unwrap_or_else(|_| "\"\"".to_string());
    let shim = format!("<script>{}</script>", plugin_shim_js(&up));
    match find_head_insert(html) {
        Some(idx) => {
            let mut s = String::with_capacity(html.len() + shim.len());
            s.push_str(&html[..idx]);
            s.push_str(&shim);
            s.push_str(&html[idx..]);
            s
        }
        None => format!("{shim}{html}"),
    }
}

/// Byte offset just after the opening `<head …>` tag, case-insensitively; `None`
/// if the page has no head (then the shim is prepended to the whole document).
fn find_head_insert(html: &str) -> Option<usize> {
    let lower = html.to_ascii_lowercase();
    let head = lower.find("<head")?;
    let gt = lower[head..].find('>')? + head;
    Some(gt + 1)
}

/// The injected shim. Wraps `fetch`/`XMLHttpRequest.open` so the plugin page's
/// same-origin absolute calls (`/api/meta`, `/api/instances/…`) are re-pointed at
/// our [`activity_plugin_fetch`] relay. It derives the proxy mount prefix from its
/// own document path, so it tracks whatever prefix the host mapped us under, and
/// leaves cross-origin requests (e.g. Discord's CDN) and already-proxied paths
/// untouched. `UP` is the plugin's real origin, baked in by the loader.
fn plugin_shim_js(upstream_js: &str) -> String {
    format!(
        r#"(function(){{"use strict";var UP={up};var L=location;var B=L.pathname.replace(/\/api\/activity\/plugin$/,"");var F=B+"/api/activity/plugin-fetch";function rw(u){{try{{var a=new URL(u,L.href);if(a.origin!==L.origin)return u;if(a.pathname.indexOf(B+"/api/activity/")===0)return u;return F+"?url="+encodeURIComponent(UP+a.pathname+a.search);}}catch(e){{return u;}}}}var of=window.fetch;if(of){{window.fetch=function(i,n){{try{{if(typeof i==="string"){{i=rw(i);}}else if(i&&i.url){{i=new Request(rw(i.url),i);}}}}catch(e){{}}return of.call(this,i,n);}};}}var oo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){{try{{arguments[1]=rw(u);}}catch(e){{}}return oo.apply(this,arguments);}};}})();"#,
        up = upstream_js
    )
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
    /// Max distinct participants (live co-editors), fixed by the first (host)
    /// joiner's plan tier. A reconnecting member never counts twice, so this caps
    /// *people*, not connections.
    cap: u32,
}

/// Outcome of a [`ActivityRooms::join`] attempt.
enum Joined {
    Ok {
        tx: broadcast::Sender<String>,
        rx: broadcast::Receiver<String>,
        is_first: bool,
    },
    /// The global `MAX_ROOMS` ceiling was hit on a brand-new instance.
    RoomsFull,
    /// This room is full for the host's plan tier (carries that cap for the FE).
    CoeditorsFull(u32),
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
    /// the roster too). `host_cap` sets the room's per-host co-editor limit when
    /// this call *creates* the room (the first joiner is the host); later joiners
    /// are measured against the stored cap, so a Free host's room stays capped
    /// even if a Pro user tries to join.
    ///
    /// The `is_first` bool is true when this connection is the room's **first**
    /// member — nobody else is here to answer its `hello` with the live draft, so
    /// the caller replays the persisted draft to it instead (resume-on-reopen).
    fn join(&self, instance: &str, me: &Participant, host_cap: u32) -> Joined {
        let Ok(mut map) = self.inner.lock() else {
            return Joined::RoomsFull;
        };
        if !map.contains_key(instance) && map.len() >= MAX_ROOMS {
            return Joined::RoomsFull;
        }
        let room = map
            .entry(instance.to_string())
            .or_insert_with(|| RoomState {
                tx: broadcast::channel(BROADCAST_CAP).0,
                members: HashMap::new(),
                cap: host_cap.max(1),
            });
        // A returning member (another tab / a reconnect) never counts against the
        // cap; only a genuinely new person does.
        let already_here = room.members.contains_key(&me.id);
        if !already_here && room.members.len() as u32 >= room.cap {
            return Joined::CoeditorsFull(room.cap);
        }
        // First member iff the room held nobody before we register ourselves.
        let is_first = room.members.is_empty();
        let rx = room.tx.subscribe();
        let entry = room.members.entry(me.id.clone()).or_insert((me.clone(), 0));
        entry.1 += 1;
        let roster = roster_json(&room.members);
        let tx = room.tx.clone();
        drop(map);
        let _ = tx.send(roster);
        Joined::Ok { tx, rx, is_first }
    }

    /// Push a server-authored frame into `instance`'s room, reaching every
    /// connected participant's socket. Best-effort: a no-op when the room isn't
    /// live (nobody connected) or the lock is poisoned. Unlike a peer relay this
    /// carries no `cid`, so clients treat it as authoritative. Used by the
    /// custom-bot connect callback to announce a freshly connected bot.
    pub(crate) fn notify(&self, instance: &str, msg: String) {
        let Ok(map) = self.inner.lock() else {
            return;
        };
        if let Some(room) = map.get(instance) {
            let _ = room.tx.send(msg);
        }
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
    /// Empty for a DM / group-DM launch, which has no guild — see [`activity_room`].
    #[serde(default)]
    guild: String,
}

/// `GET /api/activity/room/:instance` (WebSocket) — join the collaboration room
/// for an Activity instance. Authenticated by the bearer token in the query.
///
/// When the launch carries a `guild` (server channel), we also enforce the same
/// membership gate the rest of the proxy uses. A DM / group-DM launch has no
/// guild, so there's nothing to gate on — the room is keyed by Discord's
/// per-launch `instance` id, which is unguessable and ephemeral, and that id is
/// the capability: a peer can only join the same room by being in the same DM and
/// launching the same Activity. (Omitting `guild` can't be used to bypass a *guild*
/// room's membership check either, since reaching that room still requires its
/// unguessable instance id.)
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
    if q.token.trim().is_empty() {
        return Err(AppError::Unauthorized(
            "missing activity credentials".into(),
        ));
    }
    let session = resolve_bearer(&st, q.token.trim()).await?;
    let guild = q.guild.trim();
    if !guild.is_empty() {
        if !is_snowflake(guild) {
            return Err(bad_request("invalid guild id"));
        }
        authorize_activity_member(&st, session.clone(), guild).await?;
    }
    // The key drafts persist/resume under. It's the STABLE context of the
    // instance id (`gc-<guild>-<channel>` / the DM context), NOT the whole id —
    // Discord changes the per-launch prefix on every End→Play, so keying by the
    // full id would never resume a relaunch (see `draft_context`). `None` disables
    // persistence for this socket (unrecognized id, or a `gc-` context whose guild
    // doesn't match the authorized query guild — so a forged instance path can't
    // read or poison another channel's draft; the room still works, just ephemeral).
    let draft_key: Option<String> =
        draft_context(&instance).and_then(|ctx| match context_guild(ctx) {
            Some(cg) => (cg == guild).then(|| ctx.to_string()),
            None => Some(ctx.to_string()),
        });
    // This server's plan tier caps how many people can co-edit a room hosted in
    // it (per-server premium). A room with no guild context (a solo DM launch)
    // isn't billable to any server, so it stays unlimited — as does a
    // plan-disabled deployment (`coeditor_cap` → `None`).
    let host_cap = if guild.is_empty() {
        crate::entitlement::UNLIMITED_SLOTS
    } else {
        st.entitlements
            .coeditor_cap(guild)
            .await
            .unwrap_or(crate::entitlement::UNLIMITED_SLOTS)
    };
    let me = Participant {
        id: session.uid,
        name: session.name,
        avatar: session.avatar,
    };
    Ok(ws.on_upgrade(move |socket| async move {
        room_socket(st, instance, draft_key, me, host_cap, socket).await;
    }))
}

/// Pump one participant's socket: relay anything they send to the whole room
/// (size-capped), forward the room's broadcast back to them, and deregister on
/// disconnect. Drafts are opaque here — the browser tags each with its own
/// connection id and ignores its own echo, so the server never has to understand
/// the payload, only fan it out.
async fn room_socket(
    st: AppState,
    instance: String,
    draft_key: Option<String>,
    me: Participant,
    host_cap: u32,
    mut socket: WebSocket,
) {
    let (tx, mut rx, is_first) = match st.activity_rooms.join(&instance, &me, host_cap) {
        Joined::Ok { tx, rx, is_first } => (tx, rx, is_first),
        Joined::RoomsFull => {
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
        Joined::CoeditorsFull(cap) => {
            // Tell the client why (so it can show "this room is full on the host's
            // plan" and fall back to solo editing), then close.
            let frame = json!({ "type": "room_full", "cap": cap }).to_string();
            let _ = socket.send(Message::Text(frame)).await;
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
    };
    // Resume-on-reopen: when we're the first one back in the room, no peer will
    // answer our `hello`, so replay the persisted draft (if any) straight to this
    // socket. It's sent as a dedicated `resume` frame (not a peer `draft`) so the
    // client applies it only when it hasn't diverged from its fresh-open baseline
    // — a mere reconnect, which already holds newer local state, ignores it rather
    // than reverting to the ≤throttle-stale stored copy. A live room skips this
    // entirely: a peer's fresher in-memory state supersedes anything on disk.
    if is_first {
        if let Some(key) = &draft_key {
            if let Some(message) = load_persisted_draft(&st, key).await {
                let frame = json!({ "type": "resume", "message": message }).to_string();
                let _ = socket.send(Message::Text(frame)).await;
            }
        }
    }
    // Keepalive: ping on a fixed interval so an idle intermediary doesn't drop
    // the socket, and reap a peer we've heard nothing from. Browsers answer our
    // ping with a pong automatically, which refreshes `last_seen`.
    let mut ping = tokio::time::interval(Duration::from_secs(ROOM_PING_INTERVAL_SECS));
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let idle_timeout = Duration::from_secs(ROOM_IDLE_TIMEOUT_SECS);
    let mut last_seen = Instant::now();
    loop {
        tokio::select! {
            inbound = socket.recv() => match inbound {
                Some(Ok(Message::Text(t))) => {
                    last_seen = Instant::now();
                    if t.len() <= MAX_RELAY_BYTES {
                        // Persist full-draft frames for resume-on-reopen, and keep
                        // the server-only `snapshot` frames off the wire (peers
                        // already have that state via the granular patch that
                        // triggered it — rebroadcasting a full draft would revert
                        // concurrent edits, the very thing patches exist to avoid).
                        let rebroadcast =
                            persist_and_should_relay(&st, draft_key.as_deref(), &t);
                        if rebroadcast {
                            let _ = tx.send(t);
                        }
                    }
                }
                // A pong (or a client-sent ping) proves the peer is still alive.
                Some(Ok(Message::Pong(_))) | Some(Ok(Message::Ping(_))) => {
                    last_seen = Instant::now();
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {} // ignore binary
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
            _ = ping.tick() => {
                // Drop a zombie that's gone quiet (no pong, no frame), else ping —
                // a send error means the socket is already gone.
                if last_seen.elapsed() > idle_timeout {
                    break;
                }
                if socket.send(Message::Ping(Vec::new())).await.is_err() {
                    break;
                }
            },
        }
    }
    st.activity_rooms.leave(&instance, &me.id);
}

/// Inspect one inbound room frame: persist the draft it carries and report
/// whether it should still be relayed to peers.
///
/// Two frame types carry the full message — `draft` (the structural/latecomer
/// sync peers apply) and `snapshot` (a server-only heartbeat the client sends
/// purely to refresh the stored draft). Both update the persisted draft; only
/// `snapshot` is withheld from the broadcast, since peers already hold that state
/// via the granular patch that prompted it, and re-applying a full draft would
/// revert their concurrent edits. Everything else relays unchanged. The DB write
/// runs on a blocking task off the socket loop, keyed by the room's stable
/// `draft_key`; a no-op (always relay) when persistence is off or disabled for
/// this socket (`draft_key` is `None`).
fn persist_and_should_relay(st: &AppState, draft_key: Option<&str>, frame: &str) -> bool {
    let (Some(store), Some(key)) = (&st.activity_drafts, draft_key) else {
        return true;
    };
    // Cheap pre-filter: only the two full-message frame types name themselves
    // here, so patch/focus/target/hello frames skip the JSON parser entirely. A
    // false positive (a text edit literally containing the word) just costs one
    // extra parse and is still relayed correctly.
    if !frame.contains("\"snapshot\"") && !frame.contains("\"draft\"") {
        return true;
    }
    let Ok(v) = serde_json::from_str::<Value>(frame) else {
        return true;
    };
    let ty = v.get("type").and_then(Value::as_str);
    if matches!(ty, Some("draft") | Some("snapshot")) {
        if let Some(message) = v.get("message") {
            if let Ok(msg_str) = serde_json::to_string(message) {
                if let Some(sealed) = crate::seal::seal(&st.key, &msg_str) {
                    let store = Arc::clone(store);
                    let key = key.to_string();
                    let now = crate::schedule::unix_now();
                    tokio::task::spawn_blocking(move || {
                        if let Err(e) = store.put(&key, &sealed, now) {
                            tracing::warn!("activity draft persist failed: {e}");
                        }
                    });
                }
            }
        }
    }
    // `snapshot` is server-only; `draft` and everything else still fan out.
    ty != Some("snapshot")
}

/// Load and unseal the persisted draft stored under `key` as a JSON message, or
/// `None` when nothing is stored, persistence is off, or it can't be read/opened.
async fn load_persisted_draft(st: &AppState, key: &str) -> Option<Value> {
    let store = Arc::clone(st.activity_drafts.as_ref()?);
    let key = key.to_string();
    let sealed = tokio::task::spawn_blocking(move || store.get(&key))
        .await
        .ok()?
        .ok()??;
    let plain = crate::seal::open(&st.key, &sealed)?;
    serde_json::from_str::<Value>(&plain).ok()
}

/// The STABLE context of a Discord Activity instance id — what a draft is keyed
/// by so a relaunch in the same place resumes it.
///
/// Instance ids look like `i-<per-launch id>-gc-<guild>-<channel>` (a channel
/// launch) or `i-<per-launch id>-<other context>` (e.g. a DM). Discord mints a
/// fresh `<per-launch id>` on every End→Play, but the trailing context is stable
/// for a given channel/DM — so we strip the leading `i-<per-launch id>-` and key
/// on the rest. `None` when the id doesn't fit that shape (then persistence is
/// disabled rather than keyed on something unstable).
fn draft_context(instance: &str) -> Option<&str> {
    let rest = instance.strip_prefix("i-")?;
    let dash = rest.find('-')?;
    let ctx = &rest[dash + 1..];
    (!ctx.is_empty()).then_some(ctx)
}

/// The guild embedded in a `gc-<guild>-<channel>` context, or `None` for a
/// non-guild (e.g. DM) context. Used to bind draft access to the authorized guild.
fn context_guild(context: &str) -> Option<&str> {
    let rest = context.strip_prefix("gc-")?;
    let end = rest.find('-').unwrap_or(rest.len());
    let g = &rest[..end];
    (!g.is_empty()).then_some(g)
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
    fn webhook_is_ours_gate() {
        let mk = |kind: i64, channel: &str, app: &str, token: Option<&str>| Webhook {
            id: "1".into(),
            kind,
            name: None,
            avatar: None,
            channel_id: Some(channel.into()),
            guild_id: None,
            application_id: Some(app.into()),
            token: token.map(str::to_string),
            user: None,
        };
        let (cid, app) = ("100", "app-123");
        // DWEEB-owned (type-1) incoming webhook in the channel, with a token.
        assert!(webhook_is_ours(
            &mk(1, "100", "app-123", Some("t")),
            cid,
            app
        ));
        // Rejected: wrong type, wrong channel, another app's hook, or no token.
        assert!(!webhook_is_ours(
            &mk(2, "100", "app-123", Some("t")),
            cid,
            app
        ));
        assert!(!webhook_is_ours(
            &mk(1, "999", "app-123", Some("t")),
            cid,
            app
        ));
        assert!(!webhook_is_ours(
            &mk(1, "100", "other", Some("t")),
            cid,
            app
        ));
        assert!(!webhook_is_ours(&mk(1, "100", "app-123", None), cid, app));
        assert!(!webhook_is_ours(
            &mk(1, "100", "app-123", Some("")),
            cid,
            app
        ));
    }

    #[test]
    fn room_caps_distinct_coeditors_at_the_host_tier() {
        let rooms = ActivityRooms::new();
        let p = |id: &str| Participant {
            id: id.into(),
            name: id.into(),
            avatar: None,
        };
        // Host joins first with a cap of 2 — that fixes the room's limit.
        assert!(matches!(
            rooms.join("inst", &p("host"), 2),
            Joined::Ok { .. }
        ));
        // A second distinct person fits.
        assert!(matches!(rooms.join("inst", &p("b"), 2), Joined::Ok { .. }));
        // A third is refused with the host's cap, even if THEY are unlimited —
        // the stored room cap (from the host) is what bites.
        assert!(matches!(
            rooms.join("inst", &p("c"), crate::entitlement::UNLIMITED_SLOTS),
            Joined::CoeditorsFull(2)
        ));
        // A returning member (another tab) never counts against the cap.
        assert!(matches!(
            rooms.join("inst", &p("host"), 2),
            Joined::Ok { .. }
        ));
    }

    #[test]
    fn draft_context_is_stable_across_relaunch() {
        // Real Discord channel-launch ids: the leading `i-<num>` changes every
        // End→Play, but the `gc-<guild>-<channel>` tail is stable — so two
        // relaunches in one channel must resolve to the SAME draft key.
        let a = "i-1521845307220955136-gc-1152851518228283392-1387427085177327747";
        let b = "i-1521847258067243149-gc-1152851518228283392-1387427085177327747";
        assert_eq!(
            draft_context(a),
            Some("gc-1152851518228283392-1387427085177327747")
        );
        assert_eq!(draft_context(a), draft_context(b));
        // A different channel is a different key.
        let other = "i-999-gc-1152851518228283392-1316755985397715014";
        assert_ne!(draft_context(a), draft_context(other));
        // Guild extraction binds a draft to its guild.
        assert_eq!(
            context_guild("gc-1152851518228283392-1387427085177327747"),
            Some("1152851518228283392")
        );
        // A DM / non-guild context has no embedded guild.
        assert_eq!(context_guild("pc-1387427085177327747"), None);
        // Malformed shapes yield no context (persistence disabled, not crashed).
        assert_eq!(draft_context("garbage"), None);
        assert_eq!(draft_context("i-"), None);
        assert_eq!(draft_context("i-onlylaunchid"), None);
    }

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
    fn clamp_field_strips_control_chars_and_caps_length() {
        // Newlines/control chars are dropped so a beacon can't forge extra log
        // lines, and the length is bounded.
        assert_eq!(clamp_field("in\nject\red\t!", 100), "injected!");
        assert_eq!(clamp_field("abcdefgh", 4), "abcd");
        assert_eq!(clamp_field("", 8), "");
        // Ordinary text is untouched.
        assert_eq!(clamp_field("authorizing", 24), "authorizing");
    }

    #[test]
    fn fingerprint_is_stable_and_token_specific() {
        assert_eq!(fingerprint("tok-abc"), fingerprint("tok-abc"));
        assert_ne!(fingerprint("tok-abc"), fingerprint("tok-xyz"));
    }

    #[test]
    fn ip_is_public_blocks_private_and_reserved() {
        let blocked = [
            "127.0.0.1",       // loopback
            "10.0.0.5",        // RFC1918
            "172.16.1.1",      // RFC1918
            "192.168.1.1",     // RFC1918
            "169.254.169.254", // link-local / cloud metadata
            "100.64.0.1",      // CGNAT
            "0.0.0.0",         // unspecified
            "255.255.255.255", // broadcast
            "240.0.0.1",       // reserved
            "::1",             // v6 loopback
            "fc00::1",         // v6 ULA
            "fe80::1",         // v6 link-local
            "::ffff:10.0.0.1", // v4-mapped private
        ];
        for ip in blocked {
            assert!(!ip_is_public(ip.parse().unwrap()), "{ip} should be blocked");
        }
        let allowed = ["1.1.1.1", "8.8.8.8", "151.101.0.1", "2606:4700::1111"];
        for ip in allowed {
            assert!(ip_is_public(ip.parse().unwrap()), "{ip} should be allowed");
        }
    }

    #[test]
    fn internal_host_names_are_rejected() {
        for h in [
            "localhost",
            "db.internal",
            "router.local",
            "redis",
            "svc.intranet",
        ] {
            assert!(host_name_is_internal(h), "{h} should be internal");
        }
        for h in ["picsum.photos", "cdn.example.com", "i.imgur.com"] {
            assert!(!host_name_is_internal(h), "{h} should be external");
        }
    }

    #[test]
    fn plugin_host_allowed_matches_domain_and_subdomains() {
        let allow = vec!["dweeb.faizo.net".to_string()];
        assert!(plugin_host_allowed("dweeb.faizo.net", &allow));
        assert!(plugin_host_allowed("quickreplies.dweeb.faizo.net", &allow));
        assert!(plugin_host_allowed("QuickReplies.Dweeb.Faizo.Net", &allow)); // case-insensitive
        assert!(plugin_host_allowed("quickreplies.dweeb.faizo.net.", &allow)); // trailing dot
                                                                               // Not a sub-domain — a look-alike suffix must not slip through.
        assert!(!plugin_host_allowed("evil-dweeb.faizo.net", &allow));
        assert!(!plugin_host_allowed("dweeb.faizo.net.evil.com", &allow));
        assert!(!plugin_host_allowed("notdweeb.faizo.net", &allow));
        assert!(!plugin_host_allowed("example.com", &allow));
    }

    #[test]
    fn shim_injects_after_head_and_routes_calls() {
        let html = "<!doctype html><html><head><title>x</title></head><body></body></html>";
        let out = inject_plugin_shim(html, "https://quickreplies.dweeb.faizo.net");
        // Shim lands immediately after the opening <head> tag, before its content.
        let head = out.find("<head>").unwrap();
        let script = out.find("<script>").unwrap();
        let title = out.find("<title>").unwrap();
        assert!(
            head < script && script < title,
            "shim must sit at the top of <head>"
        );
        assert!(out.contains("plugin-fetch"));
        // The upstream origin is baked in as a JS string literal.
        assert!(out.contains("\"https://quickreplies.dweeb.faizo.net\""));
    }

    #[test]
    fn shim_prepends_when_no_head() {
        let html = "<div>no head here</div>";
        let out = inject_plugin_shim(html, "https://x.dweeb.faizo.net");
        assert!(out.starts_with("<script>"));
        assert!(out.ends_with("<div>no head here</div>"));
    }

    #[test]
    fn redirect_policy_blocks_internal_targets() {
        assert!(redirect_host_blocked(
            &Url::parse("http://169.254.169.254/latest").unwrap()
        ));
        assert!(redirect_host_blocked(
            &Url::parse("http://10.0.0.1/x").unwrap()
        ));
        assert!(redirect_host_blocked(
            &Url::parse("http://localhost/x").unwrap()
        ));
        assert!(!redirect_host_blocked(
            &Url::parse("https://fastly.picsum.photos/x").unwrap()
        ));
    }
}
