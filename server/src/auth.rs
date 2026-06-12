//! Discord OAuth2 login flow.
//!
//! Authorization-code grant with `identify guilds` scope, CSRF-protected by a
//! `state` value we set in a short-lived cookie and verify on the callback. The
//! code → token exchange happens here (server-side) so the client secret never
//! touches the browser; the resulting access token is sealed into the encrypted
//! session cookie (see `session.rs`).
//!
//!   GET  /auth/login     → redirect to Discord's consent screen
//!   GET  /auth/callback  → exchange code, set session, redirect to the builder
//!   POST /auth/logout    → clear the session
//!   GET  /auth/me        → who am I (for the FE to show signed-in state)

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;
use axum_extra::extract::cookie::PrivateCookieJar;
use serde::Deserialize;
use serde_json::json;

use crate::discord::TokenResponse;
use crate::error::AppError;
use crate::routes::{current_session, AppState, UsableGuild};
use crate::session::{
    build_custom_app_cookie, build_session_cookie, build_state_cookie, clear_custom_app_cookie,
    clear_session_cookie, clear_state_cookie, now, Session, CUSTOM_APP_COOKIE, STATE_COOKIE,
};

/// Marks a `state` value (and so its callback) as belonging to the
/// `webhook.incoming` flow rather than a login. Both flows share the `/auth/
/// callback` redirect + the one state cookie; the prefix is how `callback` tells
/// them apart, so no extra redirect URI needs registering in the Dev Portal.
const WEBHOOK_STATE_PREFIX: &str = "whk_";

/// Same idea for the bring-your-own-app variant: `webhook.incoming` run under
/// a guild's own custom application instead of DWEEB's. The credentials ride
/// in a second encrypted cookie (see `webhook_custom_start`).
const CUSTOM_WEBHOOK_STATE_PREFIX: &str = "cwh_";

/// `GET /auth/login` — set a CSRF `state` cookie and bounce to Discord.
pub async fn login(State(st): State<AppState>, jar: PrivateCookieJar) -> impl IntoResponse {
    let cfg = &st.config;
    let state = random_token();
    let url = authorize_url(&cfg.client_id, &cfg.oauth_redirect_url, &state);
    let jar = jar.add(build_state_cookie(cfg, &state));
    (jar, Redirect::to(&url))
}

/// `GET /auth/webhook` — begin Discord's `webhook.incoming` flow. Discord shows
/// its own channel picker, creates an app-owned webhook in the chosen channel,
/// and returns it on the callback. The bot doesn't need to be in the server or
/// hold any permission — the *user* authorizes the webhook for a channel they
/// can manage.
pub async fn webhook_start(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Query(q): Query<WebhookStartQuery>,
) -> impl IntoResponse {
    let cfg = &st.config;
    let state = format!("{WEBHOOK_STATE_PREFIX}{}", random_token());
    let url = webhook_authorize_url(
        &cfg.client_id,
        &cfg.oauth_redirect_url,
        &state,
        q.guild_id.as_deref(),
    );
    let jar = jar.add(build_state_cookie(cfg, &state));
    (jar, Redirect::to(&url))
}

/// Optional `?guild_id=` on `/auth/webhook` — the server the builder is already
/// connected to, used to pre-select Discord's guild picker.
#[derive(Deserialize)]
pub struct WebhookStartQuery {
    guild_id: Option<String>,
}

/// The custom app's OAuth credentials, parked in an encrypted HttpOnly cookie
/// between the flow's start and its callback. Never logged.
#[derive(serde::Serialize, Deserialize)]
struct CustomAppCreds {
    client_id: String,
    client_secret: String,
}

/// `POST /api/guilds/:guild_id/custom-apps/:application_id/webhook` — begin
/// Discord's `webhook.incoming` flow under one of the guild's registered
/// custom bots, so the created webhook belongs to *their* app and its
/// components dispatch to their app's Interactions Endpoint URL (the DWEEB
/// dispatcher).
///
/// One click, no secret prompt: the client secret was collected at
/// registration, sealed under this proxy's key, and stored in the
/// dispatcher's registry. Here it's fetched back (token-gated, guild-scoped),
/// opened, and parked — encrypted, HttpOnly, 10-minute lifetime — in the
/// cookie the shared callback consumes for the code exchange. Authorization
/// is the same as every other guild write: a session + the user manages the
/// guild. The response carries the authorize URL for the FE to navigate to.
///
/// Prerequisite the FE surfaces to the user: this proxy's `/auth/callback`
/// URL must be added under THEIR app's OAuth2 → Redirects, or Discord
/// refuses the authorize step.
pub async fn custom_bot_webhook_start(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    axum::extract::Path((guild, application_id)): axum::extract::Path<(String, String)>,
) -> Result<Response, AppError> {
    let cfg = &st.config;
    crate::routes::authorize_member(&st, &jar, &guild).await?;
    if !crate::routes::is_snowflake(&application_id) {
        return Err(AppError::Status {
            status: axum::http::StatusCode::BAD_REQUEST,
            message: "application_id must be a Discord application id.".into(),
            retry_after: None,
        });
    }

    // Fetch the sealed secret from the registry (guild-scoped, so the
    // authorization above maps one-to-one) and open it with our key.
    let api = crate::routes::dispatcher_api(&st)?;
    let resp = api
        .http
        .get(format!(
            "{}/custom-apps/{guild}/{application_id}/secret",
            api.base
        ))
        .bearer_auth(&api.token)
        .send()
        .await
        .map_err(|e| AppError::BadGateway(format!("couldn't reach the dispatcher: {e}")))?;
    if resp.status().as_u16() == 404 {
        return Err(AppError::Status {
            status: axum::http::StatusCode::NOT_FOUND,
            message: "That app isn't registered as a custom bot for this server.".into(),
            retry_after: None,
        });
    }
    if !resp.status().is_success() {
        return Err(AppError::BadGateway(
            "The custom-bot registry answered unexpectedly.".into(),
        ));
    }
    let sealed = resp
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| {
            v.get("client_secret_enc")
                .and_then(|s| s.as_str())
                .map(String::from)
        })
        .unwrap_or_default();
    if sealed.is_empty() {
        return Err(AppError::Status {
            status: axum::http::StatusCode::CONFLICT,
            message: "No client secret is stored for this app — register it again with the client secret to enable webhook creation.".into(),
            retry_after: None,
        });
    }
    let Some(client_secret) = crate::seal::open(&st.key, &sealed) else {
        // Almost always a rotated SESSION_SECRET — the stored secret is
        // unopenable now. Fails safe; re-registering repairs it.
        return Err(AppError::Status {
            status: axum::http::StatusCode::CONFLICT,
            message: "The stored client secret can't be read anymore — register the app again with the client secret.".into(),
            retry_after: None,
        });
    };

    let state = format!("{CUSTOM_WEBHOOK_STATE_PREFIX}{}", random_token());
    // A Discord app's OAuth client id IS its application id.
    let url = webhook_authorize_url(
        &application_id,
        &cfg.oauth_redirect_url,
        &state,
        Some(guild.as_str()),
    );
    let creds = CustomAppCreds {
        client_id: application_id,
        client_secret,
    };
    let creds_json = serde_json::to_string(&creds)
        .map_err(|e| AppError::Internal(format!("serialize creds: {e}")))?;
    let jar = jar
        .add(build_state_cookie(cfg, &state))
        .add(build_custom_app_cookie(cfg, &creds_json));
    Ok((jar, Json(json!({ "url": url }))).into_response())
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

/// `GET /auth/callback` — verify state, exchange the code, mint the session.
pub async fn callback(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Query(q): Query<CallbackQuery>,
) -> Result<Response, AppError> {
    let cfg = &st.config;

    // User cancelled, or Discord reported an error — just return to the builder.
    // The custom-app credentials cookie (if this was that flow) is cleared too;
    // an abandoned flow must not leave a secret parked in the browser.
    if q.error.is_some() || q.code.is_none() {
        let jar = jar
            .add(clear_state_cookie(cfg))
            .add(clear_custom_app_cookie(cfg));
        return Ok((jar, Redirect::to(&cfg.frontend_url)).into_response());
    }

    // CSRF: the round-tripped `state` must equal the one we stored at /login.
    let expected = jar.get(STATE_COOKIE).map(|c| c.value().to_string());
    let provided = q.state.unwrap_or_default();
    if provided.is_empty() || expected.as_deref() != Some(provided.as_str()) {
        return Err(AppError::Unauthorized(
            "Login could not be verified (state mismatch). Please try again.".into(),
        ));
    }

    let code = q.code.unwrap_or_default();

    // Bring-your-own-app `webhook.incoming` flow: exchange the code against
    // the CUSTOM app's credentials (parked in the encrypted cookie at start),
    // then hand the webhook back exactly like the standard flow below. A
    // failed exchange is most likely a mistyped client secret — a user error,
    // so it soft-fails back to the builder rather than erroring the callback.
    if provided.starts_with(CUSTOM_WEBHOOK_STATE_PREFIX) {
        let creds = jar
            .get(CUSTOM_APP_COOKIE)
            .and_then(|c| serde_json::from_str::<CustomAppCreds>(c.value()).ok());
        let jar = jar
            .add(clear_state_cookie(cfg))
            .add(clear_custom_app_cookie(cfg));
        let Some(creds) = creds else {
            // Cookie expired (>10 min on Discord's screen) or was dropped.
            let target = format!("{}#dweeb_webhook=error", cfg.frontend_url);
            return Ok((jar, Redirect::to(&target)).into_response());
        };
        let exchanged = st
            .discord
            .exchange_code(
                &creds.client_id,
                &creds.client_secret,
                &code,
                &cfg.oauth_redirect_url,
            )
            .await;
        let target = match exchanged {
            Ok(token) => build_webhook_redirect(&st, &cfg.frontend_url, &token).await,
            Err(_) => {
                // Almost always a mistyped client secret or an unregistered
                // redirect URI on the user's app — their fix, not ours.
                tracing::warn!("custom-app webhook exchange failed");
                format!("{}#dweeb_webhook=error", cfg.frontend_url)
            }
        };
        return Ok((jar, Redirect::to(&target)).into_response());
    }

    // `webhook.incoming` flow: exchange the code, then redirect to the builder
    // with the created webhook's URL in the fragment. No session is minted — this
    // authorization is just for the one webhook, independent of being signed in.
    if provided.starts_with(WEBHOOK_STATE_PREFIX) {
        let token = st
            .discord
            .exchange_code(
                &cfg.client_id,
                &cfg.client_secret,
                &code,
                &cfg.oauth_redirect_url,
            )
            .await?;
        let jar = jar.add(clear_state_cookie(cfg));
        let target = build_webhook_redirect(&st, &cfg.frontend_url, &token).await;
        return Ok((jar, Redirect::to(&target)).into_response());
    }

    let token = st
        .discord
        .exchange_code(
            &cfg.client_id,
            &cfg.client_secret,
            &code,
            &cfg.oauth_redirect_url,
        )
        .await?;
    let user = st.discord.current_user(&token.access_token).await?;

    let display = user
        .global_name
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| user.username.clone());
    let session = Session {
        uid: user.id.clone(),
        name: display,
        avatar: user.avatar.clone(),
        token: token.access_token.clone(),
        exp: now() + cfg.session_ttl.as_secs() as i64,
    };

    // Warm the per-user guild cache so the FE picker is populated immediately.
    if let Ok(raw) = st.discord.current_user_guilds(&token.access_token).await {
        let require = cfg.require_manage_guild;
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
            st.cache
                .put(format!("uguilds:{}", user.id), Arc::new(val))
                .await;
        }
    }

    let jar = jar
        .add(clear_state_cookie(cfg))
        .add(build_session_cookie(cfg, &session));
    Ok((jar, Redirect::to(&cfg.frontend_url)).into_response())
}

/// `POST /auth/logout` — drop the session cookie.
pub async fn logout(State(st): State<AppState>, jar: PrivateCookieJar) -> impl IntoResponse {
    let jar = jar.add(clear_session_cookie(&st.config));
    (jar, Json(json!({ "ok": true })))
}

/// `GET /auth/me` — the signed-in user, or 401 when anonymous.
pub async fn me(State(st): State<AppState>, jar: PrivateCookieJar) -> Result<Response, AppError> {
    let _ = &st; // state only needed to satisfy the cookie extractor's key.
    let session =
        current_session(&jar).ok_or_else(|| AppError::Unauthorized("Not signed in.".into()))?;

    let avatar_url = session.avatar.as_ref().map(|hash| {
        let ext = if hash.starts_with("a_") { "gif" } else { "png" };
        format!(
            "https://cdn.discordapp.com/avatars/{}/{hash}.{ext}",
            session.uid
        )
    });

    Ok(Json(json!({
        "id": session.uid,
        "name": session.name,
        "avatar_url": avatar_url,
    }))
    .into_response())
}

/// Discord's OAuth2 authorize URL for the code grant.
fn authorize_url(client_id: &str, redirect_uri: &str, state: &str) -> String {
    format!(
        "https://discord.com/oauth2/authorize?client_id={}&response_type=code&redirect_uri={}&scope={}&state={}&prompt=none",
        client_id,
        percent_encode(redirect_uri),
        percent_encode("identify guilds"),
        state,
    )
}

/// Authorize URL for the webhook-create flow. `webhook.incoming` creates the
/// webhook (and shows Discord's channel picker); `guilds` lets us read the user's
/// server list so we can resolve the destination *server name* from their own
/// account — no bot membership or DWEEB login required. No `prompt=none` — we
/// *want* the channel picker shown every time.
///
/// `guild_id`, when present, pre-selects that server in Discord's picker. We
/// don't pass `disable_guild_select`, so it's only a default the user can change.
/// Only snowflakes (digits) are forwarded — Discord rejects a malformed
/// `guild_id`, so anything else is dropped to fall back to the full picker.
fn webhook_authorize_url(
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    guild_id: Option<&str>,
) -> String {
    let mut url = format!(
        "https://discord.com/oauth2/authorize?client_id={}&response_type=code&redirect_uri={}&scope={}&state={}",
        client_id,
        percent_encode(redirect_uri),
        percent_encode("webhook.incoming guilds"),
        state,
    );
    if let Some(gid) = guild_id.filter(|g| !g.is_empty() && g.bytes().all(|b| b.is_ascii_digit())) {
        url.push_str(&format!("&guild_id={gid}"));
    }
    url
}

/// Where to send the browser after a `webhook.incoming` exchange: back to the
/// builder with the new webhook's execute URL in the fragment (`#dweeb_webhook=`),
/// which the FE reads, drops into the Send field, then clears. The URL is the
/// user's own credential and lives only in their browser's address bar
/// momentarily; a fragment is never sent to a server. On failure (user backed
/// out, or Discord returned no webhook) we signal the FE with an `error` marker.
///
/// Best-effort, we resolve the destination's *names* (`&channel=`, `&guild=`) so
/// the builder can label same-named webhooks without the user signing in:
///   - **server name** from the user's own guild list (the `guilds` scope) —
///     works even when the bot isn't in that server; bot lookup as a fallback.
///   - **channel name** from the bot (no user-OAuth scope exposes it) — present
///     only when the bot is in the server. Skipped silently otherwise.
async fn build_webhook_redirect(st: &AppState, frontend: &str, token: &TokenResponse) -> String {
    let Some(w) = token.webhook.as_ref() else {
        return format!("{frontend}#dweeb_webhook=error");
    };
    let Some(url) = w.url.as_deref().filter(|u| !u.is_empty()) else {
        return format!("{frontend}#dweeb_webhook=error");
    };

    let guild = resolve_guild_name(st, &token.access_token, w.guild_id.as_deref());
    let channel = async {
        match w.channel_id.as_deref() {
            Some(id) => st.discord.channel_name(id).await,
            None => None,
        }
    };
    let (guild, channel) = tokio::join!(guild, channel);

    let mut frag = format!("dweeb_webhook={}", percent_encode(url));
    if let Some(c) = channel.as_deref().filter(|s| !s.is_empty()) {
        frag.push_str(&format!("&channel={}", percent_encode(c)));
    }
    if let Some(g) = guild.as_deref().filter(|s| !s.is_empty()) {
        frag.push_str(&format!("&guild={}", percent_encode(g)));
    }
    format!("{frontend}#{frag}")
}

/// The server name for `guild_id`, preferring the user's own guild list (their
/// `guilds`-scoped token names every server they're in, bot or not) and falling
/// back to a bot lookup. None when neither source has it.
async fn resolve_guild_name(
    st: &AppState,
    access_token: &str,
    guild_id: Option<&str>,
) -> Option<String> {
    let gid = guild_id?;
    if let Ok(guilds) = st.discord.current_user_guilds(access_token).await {
        if let Some(g) = guilds.into_iter().find(|g| g.id == gid) {
            return Some(g.name);
        }
    }
    st.discord.guild_name(gid).await
}

/// 16 random bytes as lowercase hex — an unguessable CSRF `state` token.
fn random_token() -> String {
    let mut buf = [0u8; 16];
    // If the OS RNG ever fails we'd rather fail the login than emit a guessable
    // token; an all-zero buffer still won't match a fresh cookie, so the
    // callback's state check rejects it.
    let _ = getrandom::getrandom(&mut buf);
    let mut s = String::with_capacity(32);
    for b in buf {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Percent-encode a query-parameter value (RFC 3986 unreserved set untouched).
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
