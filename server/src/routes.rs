//! HTTP handlers and shared application state.
//!
//! The guild reads are now gated on a Discord login: every `/api/guilds/...`
//! request must carry a valid session, and the requested guild must be one the
//! signed-in user actually belongs to (and, by default, manages). That check is
//! what makes the proxy safe to expose publicly — a visitor can only read
//! servers that are genuinely theirs, not enumerate every guild the bot is in.
//!
//! Authorization data (the user's guild list) is cached per-user for the same
//! short TTL as the guild reads, so the hot path is a couple of map lookups
//! rather than a Discord round trip.

use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::{FromRef, Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::{Key, PrivateCookieJar};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::cache::DataCache;
use crate::config::Config;
use crate::discord::Discord;
use crate::error::AppError;
use crate::session::{Session, SESSION_COOKIE};
use crate::shortlink::ShortLinkStore;

/// Client for the interactions dispatcher's internal /permanent API — the
/// service that owns the per-guild permanent-component slots the dashboard
/// manages. Present only when both DISPATCHER_URL and DISPATCHER_API_TOKEN
/// are configured.
pub struct DispatcherApi {
    pub base: String,
    pub token: String,
    pub http: reqwest::Client,
}

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub discord: Arc<Discord>,
    pub cache: Arc<DataCache>,
    pub dispatcher: Option<Arc<DispatcherApi>>,
    /// Short-link store (see `shortlink.rs`); None when the feature is off.
    pub shortlinks: Option<Arc<ShortLinkStore>>,
    /// Master key for encrypting/decrypting cookies.
    pub key: Key,
}

// Lets `PrivateCookieJar` be extracted from handlers that hold `AppState`.
impl FromRef<AppState> for Key {
    fn from_ref(state: &AppState) -> Self {
        state.key.clone()
    }
}

/// Query options for the cached guild reads. `?fresh=true` bypasses the cache
/// read (forcing a live Discord round-trip) while still re-warming the cache, so
/// a user's manual "Refresh" gets current data without disabling caching for
/// everyone else. Absent/empty query → `fresh` defaults to false.
#[derive(Debug, Default, Deserialize)]
pub struct ReadQuery {
    #[serde(default)]
    pub fresh: bool,
}

/// A guild the signed-in user may use, trimmed for the FE server picker.
#[derive(Serialize, Deserialize, Clone)]
pub struct UsableGuild {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
}

/// Liveness probe — no auth, no upstream calls.
pub async fn health() -> impl IntoResponse {
    axum::Json(json!({ "status": "ok" }))
}

// ── Guild reads (login + membership gated) ─────────────────────────────────

pub async fn roles(
    State(st): State<AppState>,
    Query(q): Query<ReadQuery>,
    jar: PrivateCookieJar,
    Path(guild): Path<String>,
) -> Result<Response, AppError> {
    authorize_member(&st, &jar, &guild).await?;
    let value = fetch_roles(&st, &guild, q.fresh).await?;
    Ok(value_response(&value))
}

pub async fn channels(
    State(st): State<AppState>,
    Query(q): Query<ReadQuery>,
    jar: PrivateCookieJar,
    Path(guild): Path<String>,
) -> Result<Response, AppError> {
    authorize_member(&st, &jar, &guild).await?;
    let value = fetch_channels(&st, &guild, q.fresh).await?;
    Ok(value_response(&value))
}

pub async fn emojis(
    State(st): State<AppState>,
    Query(q): Query<ReadQuery>,
    jar: PrivateCookieJar,
    Path(guild): Path<String>,
) -> Result<Response, AppError> {
    authorize_member(&st, &jar, &guild).await?;
    let value = fetch_emojis(&st, &guild, q.fresh).await?;
    Ok(value_response(&value))
}

/// Roles + channels + emojis in one response, so the builder can hydrate every
/// picker with a single request.
pub async fn bootstrap(
    State(st): State<AppState>,
    Query(q): Query<ReadQuery>,
    jar: PrivateCookieJar,
    Path(guild): Path<String>,
) -> Result<Response, AppError> {
    authorize_member(&st, &jar, &guild).await?;
    let roles = fetch_roles(&st, &guild, q.fresh).await?;
    let channels = fetch_channels(&st, &guild, q.fresh).await?;
    let emojis = fetch_emojis(&st, &guild, q.fresh).await?;

    let mut obj = Map::new();
    obj.insert("roles".to_string(), (*roles).clone());
    obj.insert("channels".to_string(), (*channels).clone());
    obj.insert("emojis".to_string(), (*emojis).clone());
    Ok(value_response(&Value::Object(obj)))
}

/// The signed-in user's usable servers, each flagged with whether the DWEEB bot
/// is already a member — drives the FE picker + "add the bot" prompts.
pub async fn list_guilds(
    State(st): State<AppState>,
    Query(q): Query<ReadQuery>,
    jar: PrivateCookieJar,
) -> Result<Response, AppError> {
    let session = require_session(&jar)?;
    let guilds = usable_guilds(&st, &session, q.fresh).await?;
    let bot = bot_guild_set(&st, q.fresh).await;

    let items: Vec<Value> = guilds
        .iter()
        .map(|g| {
            json!({
                "id": g.id,
                "name": g.name,
                "icon": g.icon,
                "bot_present": bot.contains(&g.id),
            })
        })
        .collect();
    Ok(value_response(&json!({ "guilds": items })))
}

// ── Permanent component slots (login + Manage Server gated) ────────────────
//
// The dashboard's "keep this message's buttons alive" feature. The slots
// themselves live in the interactions dispatcher (which enforces the expiry);
// these handlers add the user-facing authorization — a valid session and a
// guild the user manages — then relay to the dispatcher's token-gated API.

/// Discord snowflakes are 17–20 digits today; accept a small range with slack.
pub(crate) fn is_snowflake(s: &str) -> bool {
    (15..=25).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

#[derive(Deserialize)]
pub struct PermanentAddBody {
    pub message_id: String,
    pub channel_id: String,
}

/// `GET /api/guilds/:id/permanent` — slot usage + current permanent messages.
pub async fn permanent_list(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Path(guild): Path<String>,
) -> Result<Response, AppError> {
    authorize_member(&st, &jar, &guild).await?;
    let api = dispatcher_api(&st)?;
    let req = api
        .http
        .get(format!("{}/permanent/{guild}", api.base))
        .bearer_auth(&api.token);
    relay_dispatcher(req).await
}

/// `POST /api/guilds/:id/permanent` `{ message_id, channel_id }` — spend a
/// slot on a message. 409 with the current slots when the guild is full.
pub async fn permanent_add(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Path(guild): Path<String>,
    Json(body): Json<PermanentAddBody>,
) -> Result<Response, AppError> {
    let session = authorize_member(&st, &jar, &guild).await?;
    if !is_snowflake(&body.message_id) || !is_snowflake(&body.channel_id) {
        return Err(AppError::Status {
            status: StatusCode::BAD_REQUEST,
            message: "message_id and channel_id must be Discord ids".into(),
            retry_after: None,
        });
    }
    let api = dispatcher_api(&st)?;
    let req = api
        .http
        .post(format!("{}/permanent/{guild}", api.base))
        .bearer_auth(&api.token)
        .json(&json!({
            "message_id": body.message_id,
            "channel_id": body.channel_id,
            // Recorded for audit; the session is the source of truth for who.
            "added_by": session.uid,
        }));
    relay_dispatcher(req).await
}

/// `DELETE /api/guilds/:id/permanent/:message_id` — give the slot back.
pub async fn permanent_remove(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Path((guild, message_id)): Path<(String, String)>,
) -> Result<Response, AppError> {
    authorize_member(&st, &jar, &guild).await?;
    if !is_snowflake(&message_id) {
        return Err(AppError::Status {
            status: StatusCode::BAD_REQUEST,
            message: "message_id must be a Discord id".into(),
            retry_after: None,
        });
    }
    let api = dispatcher_api(&st)?;
    let req = api
        .http
        .delete(format!("{}/permanent/{guild}/{message_id}", api.base))
        .bearer_auth(&api.token);
    relay_dispatcher(req).await
}

// ── Custom bots (login + Manage Server gated) ──────────────────────────────
//
// A guild may register its OWN Discord application(s) so the interactions
// dispatcher serves them too — components on messages sent by *their* bot
// then work through DWEEB's plugins. The registry (and the per-guild quota,
// default 1, plan-extensible later) lives in the dispatcher; these handlers
// add the user-facing authorization and relay, exactly like the permanent
// slots above.

#[derive(Deserialize)]
pub struct CustomAppAddBody {
    pub application_id: String,
    pub public_key: String,
    /// The app's OAuth client secret, asked for at registration so "create a
    /// webhook from this bot" is one click later. Sealed (AES-GCM under the
    /// proxy's key) before it leaves this process; the dispatcher stores only
    /// ciphertext and the browser never sees it again.
    #[serde(default)]
    pub client_secret: Option<String>,
}

/// `GET /api/guilds/:id/custom-apps` — quota usage + registered apps.
pub async fn custom_apps_list(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Path(guild): Path<String>,
) -> Result<Response, AppError> {
    authorize_member(&st, &jar, &guild).await?;
    let api = dispatcher_api(&st)?;
    let req = api
        .http
        .get(format!("{}/custom-apps/{guild}", api.base))
        .bearer_auth(&api.token);
    relay_dispatcher(req).await
}

/// `POST /api/guilds/:id/custom-apps` `{ application_id, public_key,
/// client_secret? }` — register the guild's own app. The display name is not
/// part of the request: it's resolved from Discord here, so it's the app's
/// real name. 409 with `error: quota_full | app_taken` when it can't be
/// granted.
pub async fn custom_apps_add(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Path(guild): Path<String>,
    Json(body): Json<CustomAppAddBody>,
) -> Result<Response, AppError> {
    let session = authorize_member(&st, &jar, &guild).await?;
    let application_id = body.application_id.trim().to_string();
    let public_key = body.public_key.trim().to_lowercase();
    if !is_snowflake(&application_id) {
        return Err(AppError::Status {
            status: StatusCode::BAD_REQUEST,
            message: "application_id must be a Discord application id.".into(),
            retry_after: None,
        });
    }
    if application_id == st.config.client_id {
        return Err(AppError::Status {
            status: StatusCode::BAD_REQUEST,
            message: "That's the DWEEB app itself — it's already wired up.".into(),
            retry_after: None,
        });
    }
    // Shape check here; the dispatcher additionally validates it's a real
    // Ed25519 point and not this deployment's own key.
    if public_key.len() != 64 || !public_key.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::Status {
            status: StatusCode::BAD_REQUEST,
            message: "public_key must be the app's 64-character hex Public Key.".into(),
            retry_after: None,
        });
    }
    // Seal the client secret before it leaves this process. Optional at the
    // API level — without it the app still gets its interactions served, but
    // the dashboard can't offer one-click webhook creation for it.
    let client_secret = body
        .client_secret
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let client_secret_enc = match client_secret {
        None => String::new(),
        Some(secret) => {
            if secret.len() < 16
                || secret.len() > 128
                || !secret.bytes().all(|b| b.is_ascii_graphic())
            {
                return Err(AppError::Status {
                    status: StatusCode::BAD_REQUEST,
                    message: "client_secret doesn't look like a Discord client secret.".into(),
                    retry_after: None,
                });
            }
            crate::seal::seal(&st.key, secret)
                .ok_or_else(|| AppError::Internal("couldn't seal the client secret".into()))?
        }
    };
    let api = dispatcher_api(&st)?;
    // Nobody types the name — it's resolved from Discord, best-effort. The
    // public lookup covers nearly every app; the few that 404 there get a
    // second chance through the just-provided client secret. Failing both
    // never blocks registration: an empty name makes the UI show the
    // application id, and an Update retries the lookup.
    let mut name = st
        .discord
        .application_name(&application_id)
        .await
        .unwrap_or_default();
    if name.is_empty() {
        if let Some(secret) = client_secret {
            name = st
                .discord
                .application_name_via_secret(&application_id, secret)
                .await
                .unwrap_or_default();
        }
    }
    let req = api
        .http
        .post(format!("{}/custom-apps/{guild}", api.base))
        .bearer_auth(&api.token)
        .json(&json!({
            "application_id": application_id,
            "public_key": public_key,
            "name": name,
            "client_secret_enc": client_secret_enc,
            // Recorded for audit; the session is the source of truth for who.
            "added_by": session.uid,
        }));
    relay_dispatcher(req).await
}

/// `DELETE /api/guilds/:id/custom-apps/:application_id` — unregister.
pub async fn custom_apps_remove(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Path((guild, application_id)): Path<(String, String)>,
) -> Result<Response, AppError> {
    authorize_member(&st, &jar, &guild).await?;
    if !is_snowflake(&application_id) {
        return Err(AppError::Status {
            status: StatusCode::BAD_REQUEST,
            message: "application_id must be a Discord application id.".into(),
            retry_after: None,
        });
    }
    let api = dispatcher_api(&st)?;
    let req = api
        .http
        .delete(format!("{}/custom-apps/{guild}/{application_id}", api.base))
        .bearer_auth(&api.token);
    relay_dispatcher(req).await
}

/// The dispatcher client, or a clear "not enabled here" for deployments that
/// don't run the dispatcher (e.g. proxy-only setups).
pub(crate) fn dispatcher_api(st: &AppState) -> Result<&Arc<DispatcherApi>, AppError> {
    st.dispatcher.as_ref().ok_or_else(|| AppError::Status {
        status: StatusCode::NOT_IMPLEMENTED,
        message: "This feature isn't enabled on this deployment.".into(),
        retry_after: None,
    })
}

/// Send a prepared dispatcher request and pass its answer through. The
/// statuses the FE acts on (200, 400, 404 not-found, 409 full/taken) relay
/// verbatim; anything else means *our* deployment is misconfigured or down,
/// which is a gateway error, not the caller's.
async fn relay_dispatcher(req: reqwest::RequestBuilder) -> Result<Response, AppError> {
    let resp = req
        .send()
        .await
        .map_err(|e| AppError::BadGateway(format!("couldn't reach the dispatcher: {e}")))?;
    let status = resp.status();
    let bytes = resp.bytes().await.unwrap_or_default();
    match status.as_u16() {
        200 | 400 | 404 | 409 => Ok((
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::OK),
            [(header::CONTENT_TYPE, "application/json")],
            bytes,
        )
            .into_response()),
        other => {
            tracing::error!(status = other, "dispatcher permanent API error");
            Err(AppError::BadGateway(
                "The permanent-slot service answered unexpectedly — check the dispatcher logs."
                    .into(),
            ))
        }
    }
}

// ── Authorization ──────────────────────────────────────────────────────────

/// Decode a valid, unexpired session or reject with 401.
fn require_session(jar: &PrivateCookieJar) -> Result<Session, AppError> {
    current_session(jar)
        .ok_or_else(|| AppError::Unauthorized("Sign in with Discord to load server data.".into()))
}

/// Read + validate the session cookie (decrypted by the private jar).
pub fn current_session(jar: &PrivateCookieJar) -> Option<Session> {
    let cookie = jar.get(SESSION_COOKIE)?;
    let session: Session = serde_json::from_str(cookie.value()).ok()?;
    if session.is_expired() {
        return None;
    }
    Some(session)
}

/// Ensure the caller is signed in and the requested guild is one they may use.
/// Returns the session so writes can record who acted.
pub(crate) async fn authorize_member(
    st: &AppState,
    jar: &PrivateCookieJar,
    guild: &str,
) -> Result<Session, AppError> {
    let session = require_session(jar)?;
    // Membership is a gate, not user-facing data — always serve it from cache so
    // a forced data refresh doesn't also force an extra `current_user_guilds`
    // round-trip on every guild read.
    let guilds = usable_guilds(st, &session, false).await?;
    if guilds.iter().any(|g| g.id == guild) {
        Ok(session)
    } else {
        Err(AppError::Forbidden(
            "You can only load servers you manage. If you just added the bot, sign in again to refresh your server list.".into(),
        ))
    }
}

/// The user's usable guilds (owner or `MANAGE_GUILD`, unless that gate is off),
/// cached per-user so repeat reads don't re-hit Discord.
async fn usable_guilds(
    st: &AppState,
    session: &Session,
    fresh: bool,
) -> Result<Vec<UsableGuild>, AppError> {
    let key = format!("uguilds:{}", session.uid);
    if !fresh {
        if let Some(v) = st.cache.get(&key).await {
            if let Ok(list) = serde_json::from_value::<Vec<UsableGuild>>((*v).clone()) {
                return Ok(list);
            }
        }
    }
    let raw = st.discord.current_user_guilds(&session.token).await?;
    let require = st.config.require_manage_guild;
    let list: Vec<UsableGuild> = raw
        .into_iter()
        .filter(|g| !require || g.can_manage())
        .map(|g| UsableGuild {
            id: g.id,
            name: g.name,
            icon: g.icon,
        })
        .collect();
    if let Ok(val) = serde_json::to_value(&list) {
        st.cache.put(key, Arc::new(val)).await;
    }
    Ok(list)
}

/// The set of guild ids the bot is in (cached). Best-effort: an error here only
/// costs the picker its "bot already added" annotation, never a failed request.
async fn bot_guild_set(st: &AppState, fresh: bool) -> HashSet<String> {
    const KEY: &str = "botguilds";
    if !fresh {
        if let Some(v) = st.cache.get(KEY).await {
            if let Ok(ids) = serde_json::from_value::<Vec<String>>((*v).clone()) {
                return ids.into_iter().collect();
            }
        }
    }
    match st.discord.bot_guild_ids().await {
        Ok(ids) => {
            if let Ok(val) = serde_json::to_value(&ids) {
                st.cache.put(KEY.to_string(), Arc::new(val)).await;
            }
            ids.into_iter().collect()
        }
        Err(_) => HashSet::new(),
    }
}

// ── Cached guild reads ─────────────────────────────────────────────────────

async fn fetch_roles(st: &AppState, guild: &str, fresh: bool) -> Result<Arc<Value>, AppError> {
    let key = format!("roles:{guild}");
    if !fresh {
        if let Some(v) = st.cache.get(&key).await {
            return Ok(v);
        }
    }
    let value = Arc::new(to_value(st.discord.roles(guild).await?)?);
    st.cache.put(key, Arc::clone(&value)).await;
    Ok(value)
}

async fn fetch_channels(st: &AppState, guild: &str, fresh: bool) -> Result<Arc<Value>, AppError> {
    let key = format!("channels:{guild}");
    if !fresh {
        if let Some(v) = st.cache.get(&key).await {
            return Ok(v);
        }
    }
    let value = Arc::new(to_value(st.discord.channels(guild).await?)?);
    st.cache.put(key, Arc::clone(&value)).await;
    Ok(value)
}

async fn fetch_emojis(st: &AppState, guild: &str, fresh: bool) -> Result<Arc<Value>, AppError> {
    let key = format!("emojis:{guild}");
    if !fresh {
        if let Some(v) = st.cache.get(&key).await {
            return Ok(v);
        }
    }
    let value = Arc::new(to_value(st.discord.emojis(guild).await?)?);
    st.cache.put(key, Arc::clone(&value)).await;
    Ok(value)
}

fn to_value<T: serde::Serialize>(v: T) -> Result<Value, AppError> {
    serde_json::to_value(v).map_err(|e| AppError::Internal(e.to_string()))
}

/// Serialise a `Value` directly to bytes for the response body.
fn value_response(value: &Value) -> Response {
    let bytes = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    ([(header::CONTENT_TYPE, "application/json")], bytes).into_response()
}
