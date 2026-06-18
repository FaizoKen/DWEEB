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
    /// Whether the user holds Manage Webhooks (or Administrator/owner) here —
    /// the gate for the Send/Restore webhook picker. `#[serde(default)]` so
    /// entries cached before this field existed still decode (they default to
    /// false, and a data refresh re-resolves them).
    #[serde(default)]
    pub can_manage_webhooks: bool,
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
                "can_manage_webhooks": g.can_manage_webhooks,
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
    let resp = relay_dispatcher(req).await?;
    // Registered — give the app's bot the same command set the main app
    // carries (the right-click menus the dispatcher answers inline). Done
    // with the just-provided secret via a client-credentials grant, off the
    // request path and best-effort: a failure only means that server lacks
    // the menus, and re-registering retries it.
    if resp.status() == StatusCode::OK {
        if let Some(secret) = client_secret.map(str::to_string) {
            let discord = st.discord.clone();
            let app_id = application_id.clone();
            tokio::spawn(async move {
                if discord.install_commands_via_secret(&app_id, &secret).await {
                    tracing::info!(application_id = %app_id, "installed command set on custom app");
                } else {
                    tracing::warn!(
                        application_id = %app_id,
                        "couldn't install commands on custom app (best-effort, skipped)"
                    );
                }
            });
        }
    }
    Ok(resp)
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
    // Read the sealed secret before the row disappears — it's what lets us
    // clear the app's commands after unregistering. Best-effort throughout:
    // no secret (or an unopenable one after a SESSION_SECRET rotation) just
    // means the owner's old context menus dangle until they clear them.
    let secret = match api
        .http
        .get(format!(
            "{}/custom-apps/{guild}/{application_id}/secret",
            api.base
        ))
        .bearer_auth(&api.token)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| {
                v.get("client_secret_enc")
                    .and_then(|s| s.as_str())
                    .map(String::from)
            })
            .filter(|sealed| !sealed.is_empty())
            .and_then(|sealed| crate::seal::open(&st.key, &sealed)),
        _ => None,
    };
    let req = api
        .http
        .delete(format!("{}/custom-apps/{guild}/{application_id}", api.base))
        .bearer_auth(&api.token);
    let resp = relay_dispatcher(req).await?;
    if resp.status() == StatusCode::OK {
        if let Some(secret) = secret {
            let discord = st.discord.clone();
            let app_id = application_id.clone();
            tokio::spawn(async move {
                if discord.clear_commands_via_secret(&app_id, &secret).await {
                    tracing::info!(application_id = %app_id, "cleared command set on unregistered app");
                } else {
                    tracing::warn!(
                        application_id = %app_id,
                        "couldn't clear commands on unregistered app (best-effort, skipped)"
                    );
                }
            });
        }
    }
    Ok(resp)
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

// ── Webhook auto-detect (login + Manage Webhooks gated) ────────────────────
//
// Powers the Send/Restore webhook picker. Enumerating a guild's webhooks is the
// only Discord call that hard-requires the BOT to hold MANAGE_WEBHOOKS, and the
// response carries each incoming webhook's token + creator — so the builder can
// recover an existing webhook's URL or create a fresh one in a channel, without
// the user ever pasting a token. Both handlers are gated on the USER also
// holding Manage Webhooks (`authorize_webhooks`), mirroring Discord, and the
// channel a create targets is verified to belong to THIS guild first — so a
// guessed id from another server can't be reached through our shared bot token.
// Webhook tokens are sensitive, so these reads are never cached (the existing
// roles/channels cache holds only non-secret data).

#[derive(Deserialize)]
pub struct WebhookCreateBody {
    pub name: String,
    /// Optional image data URI (`data:image/png;base64,…`); omitted = Discord's
    /// default avatar.
    #[serde(default)]
    pub avatar: Option<String>,
}

/// `GET /api/guilds/:id/webhooks` — every webhook in the server, with each
/// incoming webhook's recover URL and creator. Manage-Webhooks gated.
pub async fn webhooks_list(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Path(guild): Path<String>,
) -> Result<Response, AppError> {
    authorize_webhooks(&st, &jar, &guild).await?;
    let hooks = st.discord.guild_webhooks(&guild).await?;
    let items: Vec<Value> = hooks.iter().map(webhook_json).collect();
    Ok(value_response(&json!({
        "webhooks": items,
        // So the FE can tell DWEEB-owned webhooks from third-party ones without
        // trusting its own build-time env to match this deployment.
        "dweeb_application_id": st.config.client_id,
    })))
}

/// `POST /api/guilds/:id/channels/:channel_id/webhooks` `{ name, avatar? }` —
/// create an incoming webhook in a channel of this guild.
pub async fn webhook_create(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Path((guild, channel_id)): Path<(String, String)>,
    Json(body): Json<WebhookCreateBody>,
) -> Result<Response, AppError> {
    let session = authorize_webhooks(&st, &jar, &guild).await?;
    if !is_snowflake(&channel_id) {
        return Err(client_error(
            StatusCode::BAD_REQUEST,
            "channel_id must be a Discord id.",
        ));
    }
    let name = body.name.trim();
    validate_webhook_name(name)?;
    let avatar = match body
        .avatar
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(a) if valid_data_uri(a) => Some(a.to_string()),
        Some(_) => {
            return Err(client_error(
                StatusCode::BAD_REQUEST,
                "avatar must be a data: image URI.",
            ))
        }
        None => None,
    };
    ensure_channel_in_guild(&st, &guild, &channel_id).await?;
    let reason = format!("Created via DWEEB by {}", session.uid);
    let w = st
        .discord
        .create_webhook(&channel_id, name, avatar.as_deref(), Some(&reason))
        .await?;
    Ok(value_response(&webhook_json(&w)))
}

// ── Webhook handler helpers ────────────────────────────────────────────────

/// Build a small client-error response without repeating the struct each time.
fn client_error(status: StatusCode, message: impl Into<String>) -> AppError {
    AppError::Status {
        status,
        message: message.into(),
        retry_after: None,
    }
}

/// Shape one webhook for the browser: forward the safe fields, fold the token
/// into a ready-to-use execute `url` (incoming webhooks only — never sent on its
/// own), and trim the creator to id + display name + avatar.
fn webhook_json(w: &crate::discord::Webhook) -> Value {
    let url = match (w.kind, w.token.as_deref()) {
        (1, Some(t)) if !t.is_empty() => {
            Some(format!("https://discord.com/api/webhooks/{}/{}", w.id, t))
        }
        _ => None,
    };
    let creator = w.user.as_ref().map(|u| {
        let name = u
            .global_name
            .clone()
            .filter(|s| !s.is_empty())
            .or_else(|| u.username.clone())
            .unwrap_or_default();
        json!({ "id": u.id, "name": name, "avatar": u.avatar })
    });
    json!({
        "id": w.id,
        "type": w.kind,
        "name": w.name,
        "avatar": w.avatar,
        "channel_id": w.channel_id,
        "guild_id": w.guild_id,
        "application_id": w.application_id,
        "url": url,
        "creator": creator,
    })
}

/// Discord rejects webhook names over 80 chars, empty names, and any name
/// containing "clyde"/"discord" (case-insensitive). Catch those here so the user
/// gets a clear message instead of a raw Discord 400.
fn validate_webhook_name(name: &str) -> Result<(), AppError> {
    let len = name.chars().count();
    if len == 0 || len > 80 {
        return Err(client_error(
            StatusCode::BAD_REQUEST,
            "Webhook name must be 1–80 characters.",
        ));
    }
    let lower = name.to_lowercase();
    if lower.contains("clyde") || lower.contains("discord") {
        return Err(client_error(
            StatusCode::BAD_REQUEST,
            "Discord doesn't allow webhook names containing “clyde” or “discord”.",
        ));
    }
    Ok(())
}

/// Loose check that a string is an image data URI within a sane size, before we
/// hand it to Discord. Not a decode — just enough to reject obvious junk and cap
/// the payload (~1MB of base64).
fn valid_data_uri(s: &str) -> bool {
    s.starts_with("data:image/") && s.contains(";base64,") && s.len() <= 1_500_000
}

/// The set of channel ids in a guild's cached channel list value.
fn ids_from_array(v: &Value) -> HashSet<String> {
    v.as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|c| c.get("id").and_then(|i| i.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// Ensure `channel_id` is a channel of `guild` before we point the bot token at
/// it. Tries the cache first, then a live read (so a just-created channel isn't
/// a false negative); only then does it refuse.
async fn ensure_channel_in_guild(
    st: &AppState,
    guild: &str,
    channel_id: &str,
) -> Result<(), AppError> {
    let cached = fetch_channels(st, guild, false).await?;
    if ids_from_array(&cached).contains(channel_id) {
        return Ok(());
    }
    let fresh = fetch_channels(st, guild, true).await?;
    if ids_from_array(&fresh).contains(channel_id) {
        return Ok(());
    }
    Err(client_error(
        StatusCode::NOT_FOUND,
        "That channel isn't in this server.",
    ))
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

/// Stricter gate for the webhook picker (list + create): a member of the guild
/// (as above) who *additionally* holds Manage Webhooks (or Administrator/owner)
/// there. The bot is what performs the calls, but we mirror Discord's own gating
/// so a guild's webhook tokens are only ever revealed to someone who could
/// already see them in Server Settings. Returns the session so a create can
/// record who acted.
pub(crate) async fn authorize_webhooks(
    st: &AppState,
    jar: &PrivateCookieJar,
    guild: &str,
) -> Result<Session, AppError> {
    let session = require_session(jar)?;
    let guilds = usable_guilds(st, &session, false).await?;
    match guilds.iter().find(|g| g.id == guild) {
        Some(g) if g.can_manage_webhooks => Ok(session),
        Some(_) => Err(AppError::Forbidden(
            "Managing webhooks needs the Manage Webhooks permission in this server (or Administrator). Ask an admin, or have your role granted it.".into(),
        )),
        None => Err(AppError::Forbidden(
            "You can only manage servers you belong to. If your permissions just changed, sign in again to refresh.".into(),
        )),
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
            can_manage_webhooks: g.can_manage_webhooks(),
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
