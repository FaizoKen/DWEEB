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

    // Reuse a DWEEB-owned incoming webhook already in the channel (so we don't
    // spawn duplicates, and never hijack a third party's hook); otherwise mint
    // one. Either way the post carries DWEEB's component routing.
    let (webhook_id, token) = match dweeb_webhook_in_channel(&st, &guild, &channel_id, None).await?
    {
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
    Ok(Json(json!({
        "message_id": message_id,
        "channel_id": channel_id,
        "guild_id": guild,
        "url": jump,
        // The webhook that authored the message — the FE passes it back to
        // `activity_edit` so an update targets exactly this one.
        "webhook_id": webhook_id,
    }))
    .into_response())
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

    authorize_webhooks_session(&st, session.clone(), &guild).await?;
    ensure_channel_in_guild(&st, &guild, &channel_id).await?;

    let (webhook_id, token) = dweeb_webhook_in_channel(&st, &guild, &channel_id, prefer)
        .await?
        .ok_or_else(|| {
            bad_request("Couldn't find the DWEEB webhook that posted this message — post it again.")
        })?;

    st.discord
        .edit_webhook_message(&webhook_id, &token, &message_id, body.message)
        .await?;

    Ok(Json(json!({
        "message_id": message_id,
        "channel_id": channel_id,
        "guild_id": guild,
        "url": format!("https://discord.com/channels/{guild}/{channel_id}/{message_id}"),
        "webhook_id": webhook_id,
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
        let room = map
            .entry(instance.to_string())
            .or_insert_with(|| RoomState {
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
        authorize_member_session(&st, session.clone(), guild).await?;
    }
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
                        let _ = tx.send(t);
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
