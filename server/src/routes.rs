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
use serde_json::{json, Value};

use crate::cache::DataCache;
use crate::config::Config;
use crate::discord::Discord;
use crate::error::AppError;
use crate::session::{Session, SESSION_COOKIE};
use crate::shortlink::ShortLinkStore;
use crate::singleflight::SingleFlight;

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
    /// Collapses concurrent identical cache-miss fetches into one Discord call
    /// (see `singleflight`) — the guard against a cold-cache request burst, on a
    /// reload or right after login, hammering Discord's rate limit.
    pub flight: Arc<SingleFlight>,
    pub dispatcher: Option<Arc<DispatcherApi>>,
    /// Short-link store (see `shortlink.rs`); None when the feature is off.
    pub shortlinks: Option<Arc<ShortLinkStore>>,
    /// Scheduled-post store (see `schedule.rs`); None when the feature is off.
    pub schedules: Option<Arc<crate::schedule::ScheduleStore>>,
    /// Live collaboration rooms for the embedded Activity (see `activity.rs`).
    /// Ephemeral + in-memory, so it's always present (cheap when unused).
    pub activity_rooms: Arc<crate::activity::ActivityRooms>,
    /// Persisted Activity collaboration drafts (see `activity_draft.rs`), so a
    /// room resumes where it was left off. None when Activities are disabled.
    pub activity_drafts: Option<Arc<crate::activity_draft::ActivityDraftStore>>,
    /// Per-server message library (see `library.rs`); None when the feature is
    /// off.
    pub library: Option<Arc<crate::library::LibraryStore>>,
    /// Plan entitlement reader (see `entitlement.rs`) — resolves a user's tier
    /// from DWEEB's own Stripe mirror and answers the per-tier quota for each
    /// gate. Always present (inert when unconfigured, so the gates fall back to
    /// store defaults).
    pub entitlements: Arc<crate::entitlement::Entitlement>,
    /// DWEEB's own Stripe billing (mirror + client; see `stripe.rs`). None when
    /// Stripe isn't configured — the plan system is then inert.
    pub stripe: Option<Arc<crate::stripe::StripeState>>,
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
    headers: axum::http::HeaderMap,
    Path(guild): Path<String>,
) -> Result<Response, AppError> {
    // The embedded Activity authenticates with a bearer token (its third-party
    // iframe gets no session cookie). The emoji picker pulls custom emoji from
    // every server the user shares with the bot, so this read — like `bootstrap`
    // and `list_guilds` — must accept either credential, or the Activity 401s on
    // each cross-server fetch and the picker mistakes it for an expired session.
    authorize_member_either(&st, &jar, &headers, &guild).await?;
    let value = fetch_emojis(&st, &guild, q.fresh).await?;
    Ok(value_response(&value))
}

/// Roles + channels + emojis in one response, so the builder can hydrate every
/// picker with a single request.
pub async fn bootstrap(
    State(st): State<AppState>,
    Query(q): Query<ReadQuery>,
    jar: PrivateCookieJar,
    headers: axum::http::HeaderMap,
    Path(guild): Path<String>,
) -> Result<Response, AppError> {
    // The embedded Activity authenticates with a bearer token (its third-party
    // iframe gets no session cookie), so this — the one read the Activity's
    // preview needs to resolve mentions — accepts either credential.
    authorize_member_either(&st, &jar, &headers, &guild).await?;
    // The three reads are independent — on a cold cache they'd otherwise be
    // three sequential Discord round-trips. Fire them concurrently (each still
    // coalesced + cached by key, and the bot semaphore caps total in-flight
    // calls), so bootstrap costs one round-trip's latency, not three.
    let (roles, channels, emojis) = tokio::join!(
        fetch_roles(&st, &guild, q.fresh),
        fetch_channels(&st, &guild, q.fresh),
        fetch_emojis(&st, &guild, q.fresh),
    );
    let (roles, channels, emojis) = (roles?, channels?, emojis?);

    // Stitch the three cached `Arc<Value>` trees straight into the response
    // bytes. Serialising each in place avoids deep-cloning every role, channel,
    // and emoji into an intermediate Map (these arrays can run to hundreds of
    // entries) on every bootstrap — including cache hits.
    Ok(bootstrap_response(&roles, &channels, &emojis))
}

/// Assemble `{ "roles": …, "channels": …, "emojis": … }` by writing each
/// already-serialised value directly, with no intermediate clone or `Map`.
fn bootstrap_response(roles: &Value, channels: &Value, emojis: &Value) -> Response {
    let mut buf = Vec::with_capacity(4096);
    buf.extend_from_slice(b"{\"roles\":");
    let _ = serde_json::to_writer(&mut buf, roles);
    buf.extend_from_slice(b",\"channels\":");
    let _ = serde_json::to_writer(&mut buf, channels);
    buf.extend_from_slice(b",\"emojis\":");
    let _ = serde_json::to_writer(&mut buf, emojis);
    buf.push(b'}');
    ([(header::CONTENT_TYPE, "application/json")], buf).into_response()
}

/// The signed-in user's usable servers, each flagged with whether the DWEEB bot
/// is already a member — drives the FE picker + "add the bot" prompts.
pub async fn list_guilds(
    State(st): State<AppState>,
    Query(q): Query<ReadQuery>,
    jar: PrivateCookieJar,
    headers: axum::http::HeaderMap,
) -> Result<Response, AppError> {
    // The embedded Activity authenticates with a bearer token (its third-party
    // iframe gets no session cookie). A DM-launched Activity has no guild of its
    // own, so it lists the user's servers here to pick a publish destination —
    // hence this accepts either credential, like the guild reads.
    let via_cookie = current_session(&jar).is_some();
    let session = crate::activity::resolve_identity(&st, &jar, &headers).await?;
    // The user's guild list (a Discord call under the user token) and the bot's
    // guild set (a paginated call under the bot token) are independent — run
    // them concurrently so the picker's cold-cache load is one round-trip's
    // latency, not two. Each is still cached + coalesced internally.
    //
    // Web (cookie) keeps the `REQUIRE_MANAGE_GUILD` picker policy; the Activity
    // (bearer) lists the user's FULL membership, so a DM-launch destination can be
    // any server where they hold Manage Webhooks — not only ones they also manage.
    let guilds_fut = async {
        if via_cookie {
            usable_guilds(&st, &session, q.fresh).await
        } else {
            member_guilds(&st, &session, q.fresh).await
        }
    };
    let (guilds, bot) = tokio::join!(guilds_fut, bot_guild_set(&st, q.fresh));
    let guilds = guilds?;

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
    let cap = st.entitlements.permanent_cap(&guild).await;
    let req = api
        .http
        .post(dispatcher_url_with_cap(
            format!("{}/permanent/{guild}", api.base),
            cap,
        ))
        .bearer_auth(&api.token)
        .json(&json!({
            "message_id": body.message_id,
            "channel_id": body.channel_id,
            // Recorded for audit; the session is the source of truth for who.
            "added_by": session.uid,
        }));
    let resp = relay_dispatcher(req).await?;
    // Now permanent: revive anything the TTL gate disabled while the message was
    // expiring (the same favour the Discord-side "Never expire" button gets, see
    // `permanent_reenable`). Off the response path and best-effort — a failure
    // only means the buttons stay greyed until the message is re-posted.
    if resp.status() == StatusCode::OK {
        spawn_revive(
            &st,
            guild.clone(),
            body.channel_id.clone(),
            body.message_id.clone(),
        );
    }
    Ok(resp)
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
    let cap = st.entitlements.permanent_cap(&guild).await;
    let req = api
        .http
        .delete(dispatcher_url_with_cap(
            format!("{}/permanent/{guild}/{message_id}", api.base),
            cap,
        ))
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
    let cap = st.entitlements.custom_bots_cap(&guild).await;
    let req = api
        .http
        .get(dispatcher_url_with_cap(
            format!("{}/custom-apps/{guild}", api.base),
            cap,
        ))
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
    let cap = st.entitlements.custom_bots_cap(&guild).await;
    let req = api
        .http
        .post(dispatcher_url_with_cap(
            format!("{}/custom-apps/{guild}", api.base),
            cap,
        ))
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
    let cap = st.entitlements.custom_bots_cap(&guild).await;
    let req = api
        .http
        .delete(dispatcher_url_with_cap(
            format!("{}/custom-apps/{guild}/{application_id}", api.base),
            cap,
        ))
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

/// Append `?cap=N` to a dispatcher URL when the proxy has a plan-derived cap to
/// impose (the acting user's tier). `None` ⇒ leave the URL as-is so the
/// dispatcher uses its own env default — the standalone / plan-disabled case.
/// The dispatcher reads `cap` off the query on every `/permanent` and
/// `/custom-apps` route and uses it for both enforcement and the `cap` it
/// echoes back to the FE.
pub(crate) fn dispatcher_url_with_cap(base: String, cap: Option<u32>) -> String {
    match cap {
        Some(c) => format!("{base}?cap={c}"),
        None => base,
    }
}

/// Send a prepared dispatcher request and pass its answer through. The
/// statuses the FE acts on (200, 400, 404 not-found, 409 full/taken) relay
/// verbatim; anything else means *our* deployment is misconfigured or down,
/// which is a gateway error, not the caller's.
pub(crate) async fn relay_dispatcher(req: reqwest::RequestBuilder) -> Result<Response, AppError> {
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

// ── Component revival (dispatcher → proxy, service-to-service) ──────────────
//
// When a message is made never-expire — from the dashboard (`permanent_add`)
// or the Discord-side "Message Info → Never expire" button — its components may
// already carry the `disabled: true` the interactions dispatcher's TTL gate
// stamped on each post-expiry click. The dispatcher can't undo that itself: the
// grant click lands on an ephemeral reply, not the posted message, and it holds
// no webhook token. So it asks us — we hold the webhook tokens — to PATCH the
// message back to life via the webhook that authored it (no bot token; the same
// credential DWEEB posts with). The dashboard path calls `spawn_revive`
// directly; the Discord-button path comes through `permanent_reenable` below.

#[derive(Deserialize)]
pub struct ReenableBody {
    pub guild_id: String,
    pub channel_id: String,
    pub message_id: String,
}

/// `POST /internal/permanent/reenable` — called by the interactions dispatcher
/// (service-to-service) after its "Never expire" button grants a slot. Re-enables
/// any component the TTL gate disabled on the posted message. Authenticated by
/// the shared dispatcher token (the same secret the dashboard relay presents, in
/// the reverse direction) — there is no user session here. Answers `202` at once
/// and does the Discord work in the background, so the dispatcher's call (racing
/// Discord's 3s interaction deadline) never waits on it.
pub async fn permanent_reenable(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<ReenableBody>,
) -> Result<Response, AppError> {
    // The shared dispatcher token gates this, constant-time compared. Without one
    // configured the feature is off (so is the dashboard relay that pairs with it).
    let Some(expected) = st.config.dispatcher_token.as_deref() else {
        return Err(client_error(
            StatusCode::NOT_IMPLEMENTED,
            "This feature isn't enabled on this deployment.",
        ));
    };
    let supplied = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();
    if !constant_time_eq(supplied.as_bytes(), expected.as_bytes()) {
        return Err(AppError::Unauthorized("bad dispatcher token".into()));
    }
    if !is_snowflake(&body.guild_id)
        || !is_snowflake(&body.channel_id)
        || !is_snowflake(&body.message_id)
    {
        return Err(client_error(
            StatusCode::BAD_REQUEST,
            "guild_id, channel_id and message_id must be Discord ids",
        ));
    }
    spawn_revive(&st, body.guild_id, body.channel_id, body.message_id);
    Ok((StatusCode::ACCEPTED, Json(json!({ "status": "accepted" }))).into_response())
}

/// Run [`revive_message_components`] off the request path, logging the outcome.
/// Shared by every never-expire entry point (dashboard, Discord button, and the
/// embedded Activity's gallery); a few Discord round-trips must never make a
/// Discord interaction handler (or the dashboard click) wait.
pub(crate) fn spawn_revive(st: &AppState, guild: String, channel_id: String, message_id: String) {
    let st = st.clone();
    tokio::spawn(async move {
        match revive_message_components(&st, &guild, &channel_id, &message_id).await {
            Ok(Revived::Patched) => {
                tracing::info!(%message_id, "re-enabled expired components after never-expire grant")
            }
            Ok(Revived::NothingToDo) => {
                tracing::debug!(%message_id, "never-expire grant: nothing disabled to revive")
            }
            Ok(Revived::WebhookGone) => tracing::warn!(
                %message_id,
                %channel_id,
                "never-expire grant: no DWEEB webhook found to revive the message (deleted, or posted by a third party)"
            ),
            Err(err) => tracing::warn!(%err, %message_id, "never-expire grant: re-enable failed"),
        }
    });
}

/// Outcome of a revive attempt — purely for the log line.
enum Revived {
    /// The message had disabled components; they were cleared and PATCHed.
    Patched,
    /// The authoring webhook was found, but nothing was disabled (the common,
    /// healthy case) — no PATCH issued.
    NothingToDo,
    /// No webhook in the channel could claim the message (all 404'd).
    WebhookGone,
}

/// Find the DWEEB webhook that posted `message_id` in `channel_id` of `guild`,
/// and clear any TTL-disabled components on it via that webhook's token. Tries
/// each incoming webhook the channel has (usually a single DWEEB hook): only the
/// authoring webhook's token can GET/PATCH the message, so a 404 just means "not
/// this one, try the next". The strip is a no-op unless something was actually
/// disabled, so a healthy message costs only the GET.
async fn revive_message_components(
    st: &AppState,
    guild: &str,
    channel_id: &str,
    message_id: &str,
) -> Result<Revived, AppError> {
    let hooks = st.discord.guild_webhooks(guild).await?;
    // Incoming (type-1) webhooks in this channel that handed us a usable token.
    let candidates = hooks.iter().filter(|w| {
        w.kind == 1
            && w.channel_id.as_deref() == Some(channel_id)
            && w.token.as_deref().is_some_and(|t| !t.is_empty())
    });
    for w in candidates {
        let token = w.token.as_deref().unwrap_or_default();
        let Some(message) = st.discord.webhook_message(&w.id, token, message_id).await? else {
            continue; // 404 — a different webhook authored this message
        };
        let Some(mut components) = message.get("components").cloned() else {
            return Ok(Revived::NothingToDo); // owns it, but carries no components
        };
        if !clear_disabled(&mut components) {
            return Ok(Revived::NothingToDo);
        }
        let mut body = json!({ "components": components });
        // A Components-V2 message must keep its IS_COMPONENTS_V2 flag for the
        // edit to validate the V2 component types (text displays, containers).
        // Restate the message's exact flags so that bit — and any
        // suppress-notification/embed bits — survive unchanged; non-V2 messages
        // are left without a `flags` field so their classic rows validate.
        const FLAG_IS_COMPONENTS_V2: u64 = 1 << 15;
        if let Some(flags) = message.get("flags").and_then(Value::as_u64) {
            if flags & FLAG_IS_COMPONENTS_V2 != 0 {
                body["flags"] = json!(flags);
            }
        }
        st.discord
            .edit_webhook_message(&w.id, token, message_id, body)
            .await?;
        return Ok(Revived::Patched);
    }
    Ok(Revived::WebhookGone)
}

/// Clear the `disabled` flag from every *interactive* component (one carrying a
/// `custom_id`) in a Discord component tree, returning whether anything changed.
/// This precisely reverses the dispatcher's TTL gate, which disables a component
/// by its `custom_id` (plugins/dispatcher/src/main.rs `disable_component`), and
/// walks the same Components-V2 nesting: children under `components`, a section's
/// button under `accessory`. Link/premium buttons (no `custom_id`) are left
/// alone — only what could have been TTL-disabled is touched.
fn clear_disabled(node: &mut Value) -> bool {
    match node {
        Value::Array(items) => items.iter_mut().fold(false, |c, i| clear_disabled(i) | c),
        Value::Object(map) => {
            let interactive = map.get("custom_id").and_then(Value::as_str).is_some();
            let mut changed = false;
            if interactive && map.get("disabled").and_then(Value::as_bool) == Some(true) {
                map.insert("disabled".into(), Value::Bool(false));
                changed = true;
            }
            if let Some(children) = map.get_mut("components") {
                changed |= clear_disabled(children);
            }
            if let Some(accessory) = map.get_mut("accessory") {
                changed |= clear_disabled(accessory);
            }
            changed
        }
        _ => false,
    }
}

/// Byte-wise comparison that doesn't leak the match length through timing — the
/// same shape the dispatcher uses on the other end of this shared token.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// ── Webhook management (login + Manage Webhooks gated) ─────────────────────
//
// Powers the Send/Restore webhook picker. Enumerating a guild's webhooks is the
// only Discord call that hard-requires the BOT to hold MANAGE_WEBHOOKS, and the
// response carries each incoming webhook's token + creator — so the builder can
// recover an existing webhook's URL, create a fresh one in a channel, or
// rename / re-avatar / move / delete one inline (incl. bulk "purge duplicates"),
// without the user ever pasting a token. Every handler is gated on the USER also
// holding Manage Webhooks (`authorize_webhooks`), mirroring Discord, and every
// webhook or channel a write touches is verified to belong to THIS guild first —
// so a guessed id from another server can't be reached through our shared bot
// token. Webhook tokens are sensitive, so these reads are never cached (the
// existing roles/channels cache holds only non-secret data).

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

/// `PATCH /api/guilds/:id/webhooks/:webhook_id` `{ name?, avatar?, channel_id? }`
/// — rename, re-avatar (string sets, `null` clears), and/or move the webhook.
/// The raw `Value` body lets `avatar: null` (clear) read differently from an
/// absent `avatar` (leave) — a distinction `Option<String>` would collapse.
pub async fn webhook_modify(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Path((guild, webhook_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Result<Response, AppError> {
    let session = authorize_webhooks(&st, &jar, &guild).await?;
    if !is_snowflake(&webhook_id) {
        return Err(client_error(
            StatusCode::BAD_REQUEST,
            "webhook_id must be a Discord id.",
        ));
    }
    let obj = body
        .as_object()
        .ok_or_else(|| client_error(StatusCode::BAD_REQUEST, "Body must be a JSON object."))?;

    let name = match obj.get("name") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            let t = s.trim();
            validate_webhook_name(t)?;
            Some(t.to_string())
        }
        Some(_) => {
            return Err(client_error(
                StatusCode::BAD_REQUEST,
                "name must be a string.",
            ))
        }
    };
    let avatar: Option<Value> = match obj.get("avatar") {
        None => None,
        Some(Value::Null) => Some(Value::Null),
        Some(Value::String(s)) if valid_data_uri(s) => Some(Value::String(s.clone())),
        Some(_) => {
            return Err(client_error(
                StatusCode::BAD_REQUEST,
                "avatar must be a data: image URI, or null to clear it.",
            ))
        }
    };
    let move_to = match obj.get("channel_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            let t = s.trim();
            if !is_snowflake(t) {
                return Err(client_error(
                    StatusCode::BAD_REQUEST,
                    "channel_id must be a Discord id.",
                ));
            }
            Some(t.to_string())
        }
        Some(_) => {
            return Err(client_error(
                StatusCode::BAD_REQUEST,
                "channel_id must be a string.",
            ))
        }
    };
    if name.is_none() && avatar.is_none() && move_to.is_none() {
        return Err(client_error(StatusCode::BAD_REQUEST, "Nothing to change."));
    }

    ensure_webhook_in_guild(&st, &guild, &webhook_id).await?;
    if let Some(c) = &move_to {
        ensure_channel_in_guild(&st, &guild, c).await?;
    }
    let reason = format!("Edited via DWEEB by {}", session.uid);
    let w = st
        .discord
        .modify_webhook(
            &webhook_id,
            name.as_deref(),
            avatar,
            move_to.as_deref(),
            Some(&reason),
        )
        .await?;
    Ok(value_response(&webhook_json(&w)))
}

/// `DELETE /api/guilds/:id/webhooks/:webhook_id` — delete a webhook in this guild.
pub async fn webhook_delete(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Path((guild, webhook_id)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let session = authorize_webhooks(&st, &jar, &guild).await?;
    if !is_snowflake(&webhook_id) {
        return Err(client_error(
            StatusCode::BAD_REQUEST,
            "webhook_id must be a Discord id.",
        ));
    }
    ensure_webhook_in_guild(&st, &guild, &webhook_id).await?;
    let reason = format!("Deleted via DWEEB by {}", session.uid);
    st.discord
        .delete_webhook(&webhook_id, Some(&reason))
        .await?;
    Ok(value_response(&json!({ "ok": true })))
}

// ── Collaboration links (POST /api/guilds/:id/activity-invite) ───────────────

/// How long a collaboration invite stays valid, in seconds. Discord caps `max_age`
/// at 7 days; we use the max so a link shared ahead of a session survives, while
/// still expiring rather than leaving a permanent join link to the channel.
const ACTIVITY_INVITE_MAX_AGE: u32 = 604_800;

#[derive(Deserialize)]
pub struct ActivityInviteBody {
    #[serde(default)]
    channel_id: String,
}

/// `POST /api/guilds/:id/activity-invite` `{ channel_id }` — mint a Discord
/// **Activity invite** for a channel, so `discord.gg/{code}` drops whoever opens
/// it into that channel with DWEEB launched. That shared instance is what makes
/// real-time co-editing possible (a bare `discord.com/activities/{id}` launch
/// strands a lone user in a solo call) — it backs the web app's "Collaborate in
/// Discord". Discord accepts these invites in both text and voice channels
/// (verified against the live API), so we do NOT hard-restrict the channel type
/// here — we confirm the channel belongs to the guild and let Discord be the
/// authority on what it will and won't launch an activity in (an unsupported kind
/// comes back as its own 400, surfaced verbatim).
///
/// Gated on plain membership ([`authorize_member`]): creating a collaboration
/// link is the entry point to co-editing, not a privileged action, so any member
/// who can load the server may make one. The bot performs the call and needs
/// Create Instant Invite in the channel (part of the shared invite union); a
/// server that hasn't re-added the bot gets a clear re-invite prompt from
/// [`Discord::create_activity_invite`].
pub async fn guild_activity_invite(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Path(guild): Path<String>,
    Json(body): Json<ActivityInviteBody>,
) -> Result<Response, AppError> {
    authorize_member(&st, &jar, &guild).await?;
    let channel_id = body.channel_id.trim().to_string();
    if !is_snowflake(&channel_id) {
        return Err(client_error(
            StatusCode::BAD_REQUEST,
            "channel_id must be a Discord id.",
        ));
    }
    // Confirm the channel belongs to *this* guild before we point the bot token at
    // it (cache, then a live read for a just-created channel); Discord decides
    // whether an activity invite is allowed in that channel kind.
    ensure_channel_in_guild(&st, &guild, &channel_id).await?;
    let invite = st
        .discord
        .create_activity_invite(
            &channel_id,
            &st.config.client_id,
            ACTIVITY_INVITE_MAX_AGE,
            Some("DWEEB collaboration link"),
        )
        .await?;
    Ok(value_response(&json!({
        "code": invite.code,
        "url": format!("https://discord.gg/{}", invite.code),
        "expires_at": invite.expires_at,
    })))
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
pub(crate) async fn ensure_channel_in_guild(
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

/// Ensure `webhook_id` belongs to `guild` before a write touches it — the bot
/// token can otherwise act on any webhook id, in any server it's in.
async fn ensure_webhook_in_guild(
    st: &AppState,
    guild: &str,
    webhook_id: &str,
) -> Result<(), AppError> {
    let hooks = st.discord.guild_webhooks(guild).await?;
    if hooks.iter().any(|w| w.id == webhook_id) {
        Ok(())
    } else {
        Err(client_error(
            StatusCode::NOT_FOUND,
            "That webhook isn't in this server.",
        ))
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
    authorize_member_session(st, session, guild).await
}

/// Membership gate for an already-resolved session — shared by the cookie path
/// ([`authorize_member`]) and the embedded Activity's bearer path
/// (`activity::resolve_identity` builds the same `Session` from a Discord access
/// token). Always serves the user's guild list from cache: membership is a gate,
/// not user-facing data, so a forced data refresh shouldn't also force an extra
/// `current_user_guilds` round-trip on every guild read.
pub(crate) async fn authorize_member_session(
    st: &AppState,
    session: Session,
    guild: &str,
) -> Result<Session, AppError> {
    let guilds = usable_guilds(st, &session, false).await?;
    if guilds.iter().any(|g| g.id == guild) {
        Ok(session)
    } else {
        Err(AppError::Forbidden(
            "You can only load servers you manage. If you just added the bot, sign in again to refresh your server list.".into(),
        ))
    }
}

/// Resolve identity (cookie OR bearer) and apply the membership gate that fits the
/// surface: the web app's `REQUIRE_MANAGE_GUILD` policy for a cookie session, or the
/// embedded Activity's plain-membership gate for a bearer — there the guild is
/// trusted SDK launch context, so any member may load it. Used by the reads both
/// surfaces share (`bootstrap`, `emojis`).
pub(crate) async fn authorize_member_either(
    st: &AppState,
    jar: &PrivateCookieJar,
    headers: &axum::http::HeaderMap,
    guild: &str,
) -> Result<Session, AppError> {
    // A valid cookie means the web app; otherwise `resolve_identity` falls through
    // to the bearer, which only the Activity sends.
    let via_cookie = current_session(jar).is_some();
    let session = crate::activity::resolve_identity(st, jar, headers).await?;
    if via_cookie {
        authorize_member_session(st, session, guild).await
    } else {
        authorize_activity_member(st, session, guild).await
    }
}

/// Membership gate for the embedded Activity (bearer path). The Activity's guild
/// comes from Discord's SDK launch context, so the gate is plain MEMBERSHIP —
/// `REQUIRE_MANAGE_GUILD` (a web-app picker policy) is deliberately NOT applied, so
/// any member can load the guild's data and collaborate. Privileged actions stay
/// gated by [`authorize_activity_webhooks`].
pub(crate) async fn authorize_activity_member(
    st: &AppState,
    session: Session,
    guild: &str,
) -> Result<Session, AppError> {
    let guilds = member_guilds(st, &session, false).await?;
    if guilds.iter().any(|g| g.id == guild) {
        Ok(session)
    } else {
        Err(AppError::Forbidden(
            "You're not a member of this server — or your session is stale. Relaunch DWEEB to refresh."
                .into(),
        ))
    }
}

/// Manage-Webhooks gate for the embedded Activity (bearer path) — posting, editing
/// and restoring. Finds the guild by plain membership (not `REQUIRE_MANAGE_GUILD`,
/// like [`authorize_activity_member`]), then requires Manage Webhooks there
/// (Administrator/owner included) — the same permission Discord gates webhook
/// management on, and independent of Manage Server.
pub(crate) async fn authorize_activity_webhooks(
    st: &AppState,
    session: Session,
    guild: &str,
) -> Result<Session, AppError> {
    let guilds = member_guilds(st, &session, false).await?;
    match guilds.iter().find(|g| g.id == guild) {
        Some(g) if g.can_manage_webhooks => Ok(session),
        Some(_) => Err(AppError::Forbidden(
            "Posting here needs the Manage Webhooks permission in this server (or Administrator). \
             You can still edit together — ask someone who has it to post."
                .into(),
        )),
        None => Err(AppError::Forbidden(
            "You're not a member of this server — or your session is stale. Relaunch DWEEB to refresh."
                .into(),
        )),
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
    authorize_webhooks_session(st, session, guild).await
}

/// Manage-Webhooks gate for an already-resolved session — the bearer-path twin
/// of [`authorize_webhooks`], used by the embedded Activity's publish handler so
/// posting into a channel needs the same permission the web builder's webhook
/// features do.
pub(crate) async fn authorize_webhooks_session(
    st: &AppState,
    session: Session,
    guild: &str,
) -> Result<Session, AppError> {
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
    // This is `GET /users/@me/guilds` — a tight Discord route — and it runs on
    // every guild read's authorization. Coalesce concurrent misses (a reload
    // firing bootstrap + webhooks + the picker at once) so one call serves them
    // all, re-checking the cache once the gate is held.
    let _gate = st.flight.acquire(&key).await;
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

/// The user's FULL guild membership — every server they belong to — mapped with
/// the Manage-Webhooks bit and cached per-user. Unlike [`usable_guilds`] this does
/// NOT apply `REQUIRE_MANAGE_GUILD`: it backs the embedded Activity's authorization,
/// where the launching guild is trusted SDK context and *any* member may load and
/// collaborate (posting stays separately gated on Manage Webhooks). Kept under its
/// own cache key so it never mixes with the web app's filtered list.
async fn member_guilds(
    st: &AppState,
    session: &Session,
    fresh: bool,
) -> Result<Vec<UsableGuild>, AppError> {
    let key = format!("mguilds:{}", session.uid);
    if !fresh {
        if let Some(v) = st.cache.get(&key).await {
            if let Ok(list) = serde_json::from_value::<Vec<UsableGuild>>((*v).clone()) {
                return Ok(list);
            }
        }
    }
    // Same coalescing as `usable_guilds`: one `/users/@me/guilds` call serves a
    // burst of concurrent misses (bootstrap + room + the picker on a launch).
    let _gate = st.flight.acquire(&key).await;
    if !fresh {
        if let Some(v) = st.cache.get(&key).await {
            if let Ok(list) = serde_json::from_value::<Vec<UsableGuild>>((*v).clone()) {
                return Ok(list);
            }
        }
    }
    let raw = st.discord.current_user_guilds(&session.token).await?;
    let list: Vec<UsableGuild> = raw
        .into_iter()
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
    // A *single global* key paginating the tight `/users/@me/guilds` bot route:
    // without coalescing, every user whose `botguilds` cache lapsed at once
    // re-paginates it in parallel — the classic shared-key stampede. The gate
    // makes the whole fleet of misses share one pagination.
    let _gate = st.flight.acquire(KEY).await;
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
    cached_or_fetch(st, &key, fresh, || st.discord.roles(guild)).await
}

async fn fetch_channels(st: &AppState, guild: &str, fresh: bool) -> Result<Arc<Value>, AppError> {
    let key = format!("channels:{guild}");
    cached_or_fetch(st, &key, fresh, || st.discord.channels(guild)).await
}

async fn fetch_emojis(st: &AppState, guild: &str, fresh: bool) -> Result<Arc<Value>, AppError> {
    let key = format!("emojis:{guild}");
    cached_or_fetch(st, &key, fresh, || st.discord.emojis(guild)).await
}

/// Serve `key` from cache, or fetch it from Discord once and cache the result —
/// with the fetch coalesced so a cold-cache burst (a reload, or many users right
/// after login) makes one Discord call, not one per caller. Flow: cache read
/// (unless `fresh`) → acquire the per-key gate → re-read the cache (a concurrent
/// leader may have just filled it) → fetch + cache. `fresh` skips both cache
/// reads so the manual "Refresh" still pulls live data, while concurrent passive
/// loads waiting on the same gate get that fresh value for free.
async fn cached_or_fetch<T, Fut>(
    st: &AppState,
    key: &str,
    fresh: bool,
    fetch: impl FnOnce() -> Fut,
) -> Result<Arc<Value>, AppError>
where
    T: serde::Serialize,
    Fut: std::future::Future<Output = Result<T, AppError>>,
{
    if !fresh {
        if let Some(v) = st.cache.get(key).await {
            return Ok(v);
        }
    }
    let _gate = st.flight.acquire(key).await;
    if !fresh {
        if let Some(v) = st.cache.get(key).await {
            return Ok(v);
        }
    }
    let value = Arc::new(to_value(fetch().await?)?);
    st.cache.put(key.to_string(), Arc::clone(&value)).await;
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

#[cfg(test)]
mod tests {
    use super::*;

    // ── clear_disabled (component revival) ───────────────────────────────────

    #[test]
    fn clear_disabled_reenables_a_nested_v2_button() {
        // A Components-V2 tree: a container holding a text display + an action
        // row whose button the TTL gate disabled. The text display must survive.
        let mut tree = json!([
            { "type": 17, "components": [
                { "type": 10, "content": "Pick one" },
                { "type": 1, "components": [
                    { "type": 2, "style": 1, "label": "Go", "custom_id": "p:go", "disabled": true }
                ]}
            ]}
        ]);
        assert!(clear_disabled(&mut tree), "a disabled button is a change");
        assert_eq!(tree[0]["components"][0]["content"], "Pick one");
        let btn = &tree[0]["components"][1]["components"][0];
        assert_eq!(btn["disabled"], false);
        assert_eq!(btn["custom_id"], "p:go");
    }

    #[test]
    fn clear_disabled_handles_section_accessory_and_selects() {
        // A section's button lives under `accessory`, not `components`; a select
        // menu is interactive too (it carries a custom_id).
        let mut tree = json!([
            { "type": 9, "components": [{ "type": 10, "content": "row" }],
              "accessory": { "type": 2, "style": 2, "label": "x", "custom_id": "p:a", "disabled": true } },
            { "type": 1, "components": [
                { "type": 3, "custom_id": "p:sel", "disabled": true, "options": [] }
            ]}
        ]);
        assert!(clear_disabled(&mut tree));
        assert_eq!(tree[0]["accessory"]["disabled"], false);
        assert_eq!(tree[1]["components"][0]["disabled"], false);
    }

    #[test]
    fn clear_disabled_leaves_link_buttons_and_intentional_gaps_untouched() {
        // A link button has no custom_id, so it's never something the TTL gate
        // disabled — leave its (here absent) state alone. And a tree with nothing
        // disabled reports no change, so the caller skips the PATCH entirely.
        let mut tree = json!([
            { "type": 1, "components": [
                { "type": 2, "style": 5, "label": "Docs", "url": "https://x", "disabled": true },
                { "type": 2, "style": 1, "label": "Live", "custom_id": "p:live" }
            ]}
        ]);
        assert!(
            !clear_disabled(&mut tree),
            "no interactive disabled component"
        );
        // The link button keeps its (author-set) disabled; the live one is intact.
        assert_eq!(tree[0]["components"][0]["disabled"], true);
        assert_eq!(tree[0]["components"][1]["custom_id"], "p:live");
    }

    // ── constant_time_eq ─────────────────────────────────────────────────────

    #[test]
    fn constant_time_eq_matches_only_identical_bytes() {
        assert!(constant_time_eq(b"s3cret", b"s3cret"));
        assert!(!constant_time_eq(b"s3cret", b"s3creT"));
        assert!(!constant_time_eq(b"s3cret", b"s3cre")); // length differs
        assert!(constant_time_eq(b"", b""));
    }
}
