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

/// The embedded Activity's "connect your bot" variant of the custom-app
/// `webhook.incoming` flow. It runs in the user's *external* browser (the host
/// opens it from the sandboxed iframe), which carries none of our cookies — so
/// instead of the cookie pair the whole flow context (credentials, destination
/// guild, expiry) travels sealed inside the `state` value itself (AES-GCM
/// under the proxy's key; see `seal::seal_state`). The callback authenticates
/// the flow by opening it: an unopenable, expired, or replayed-into-the-wrong-
/// guild state is refused. The captured webhook is stored server-side (sealed,
/// in the dispatcher registry) rather than handed to the browser — it's the
/// credential the Activity's post/update path uses.
const ACTIVITY_WEBHOOK_STATE_PREFIX: &str = "awh_";

/// How long an Activity connect `state` stays valid — mirrors the 10-minute
/// cookie the web flow parks its credentials in.
const ACTIVITY_STATE_TTL_SECS: i64 = 600;

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
    let client_secret = open_custom_app_secret(&st, &guild, &application_id).await?;

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

/// Fetch a registered custom app's sealed client secret from the dispatcher
/// registry and open it with this proxy's key. The caller has already
/// authorized the user for `guild`; the registry read is guild-scoped so that
/// authorization maps one-to-one. Errors are user-facing and actionable.
pub(crate) async fn open_custom_app_secret(
    st: &AppState,
    guild: &str,
    application_id: &str,
) -> Result<String, AppError> {
    let api = crate::routes::dispatcher_api(st)?;
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
    Ok(client_secret)
}

/// The Activity connect flow's context, sealed into the OAuth `state` value
/// (see [`ACTIVITY_WEBHOOK_STATE_PREFIX`]). Short keys keep the resulting URL
/// parameter compact. Never logged.
#[derive(serde::Serialize, Deserialize)]
struct ActivityConnectState {
    /// Destination guild the connect was authorized for — the callback refuses
    /// a webhook created anywhere else.
    g: String,
    /// The custom application id (a Discord app's OAuth client id IS its
    /// application id).
    a: String,
    /// The app's client secret, carried for the code exchange.
    s: String,
    /// Unix seconds after which this state is dead.
    x: i64,
    /// The Activity instance the connect was started from, so the callback can
    /// push a `bot_connected` frame straight into that live collaboration room
    /// (see `activity::ActivityRooms::notify`) — the Activity learns it's ready
    /// the instant OAuth completes, without polling or a focus event the
    /// sandboxed iframe may never see. Empty when unknown (then no push; the
    /// dialog's fallback re-check still catches it).
    #[serde(default)]
    i: String,
}

/// Build the authorize URL for the embedded Activity's "connect your bot"
/// flow: Discord's `webhook.incoming` consent under the guild's custom app,
/// with the flow context sealed into `state` (the external browser that
/// completes it carries none of our cookies). `instance` is the Activity
/// instance the connect began in, threaded through so the callback can notify
/// its live room. The caller (see `activity::activity_connect_bot`) has
/// already gated the user on Manage Webhooks in `guild`.
pub(crate) async fn activity_connect_authorize_url(
    st: &AppState,
    guild: &str,
    application_id: &str,
    instance: &str,
) -> Result<String, AppError> {
    let client_secret = open_custom_app_secret(st, guild, application_id).await?;
    let payload = serde_json::to_string(&ActivityConnectState {
        g: guild.to_string(),
        a: application_id.to_string(),
        s: client_secret,
        x: now() + ACTIVITY_STATE_TTL_SECS,
        i: instance.to_string(),
    })
    .map_err(|e| AppError::Internal(format!("serialize connect state: {e}")))?;
    let sealed = crate::seal::seal_state(&st.key, &payload)
        .ok_or_else(|| AppError::Internal("couldn't seal the connect state".into()))?;
    let state = format!("{ACTIVITY_WEBHOOK_STATE_PREFIX}{sealed}");
    Ok(webhook_authorize_url(
        application_id,
        &st.config.oauth_redirect_url,
        &state,
        Some(guild),
    ))
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

    // User cancelled, or Discord reported an error — return to the builder with a
    // marker so the popup that started this flow can relay the failure and close
    // in place (rather than booting a whole app inside the popup). Which flow it
    // was comes from the `state` prefix; Discord usually echoes `state` on a
    // cancel, but fall back to the cookie we stored at the flow's start in case it
    // doesn't. The custom-app credentials cookie (if this was that flow) is
    // cleared too — an abandoned flow must not leave a secret parked in the browser.
    if q.error.is_some() || q.code.is_none() {
        let flow_state = q
            .state
            .clone()
            .or_else(|| jar.get(STATE_COOKIE).map(|c| c.value().to_string()))
            .unwrap_or_default();
        // An Activity connect flow ends on a standalone page, not the builder —
        // it runs in the user's external browser, where the Activity isn't.
        if flow_state.starts_with(ACTIVITY_WEBHOOK_STATE_PREFIX) {
            return Ok(activity_connect_page(
                false,
                "Nothing was connected",
                "The authorization was cancelled. You can close this tab, return to Discord, and try again from the post dialog.",
            ));
        }
        let marker = if flow_state.starts_with(WEBHOOK_STATE_PREFIX)
            || flow_state.starts_with(CUSTOM_WEBHOOK_STATE_PREFIX)
        {
            "dweeb_webhook=error"
        } else {
            "dweeb_login=error"
        };
        let jar = jar
            .add(clear_state_cookie(cfg))
            .add(clear_custom_app_cookie(cfg));
        return Ok((jar, Redirect::to(&format!("{}#{marker}", cfg.frontend_url))).into_response());
    }

    // Activity "connect your bot" flow: it completes in the user's external
    // browser, which carries none of our cookies, so it's authenticated by the
    // sealed `state` itself (AEAD under the proxy's key, expiry-bounded, guild-
    // pinned) — checked *instead of* the cookie CSRF below. The captured
    // webhook stays server-side; the page only says how it went.
    if q.state
        .as_deref()
        .unwrap_or_default()
        .starts_with(ACTIVITY_WEBHOOK_STATE_PREFIX)
    {
        let state = q.state.unwrap_or_default();
        let code = q.code.unwrap_or_default();
        return Ok(activity_connect_callback(&st, &state, &code).await);
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
                can_manage_webhooks: g.can_manage_webhooks(),
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
    // Marker so the login popup recognises its return, hands "signed in" back to
    // the opener, and closes — instead of booting the app inside the popup. The
    // full-page fallback just strips it on the reload (the session cookie drives
    // auth either way). See `core/oauth/flows` (`loginFlow`).
    Ok((
        jar,
        Redirect::to(&format!("{}#dweeb_login=ok", cfg.frontend_url)),
    )
        .into_response())
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

/// Finish an Activity "connect your bot" flow: open + verify the sealed
/// `state`, exchange the code under the custom app's credentials, refuse a
/// webhook that landed outside the pinned guild, then seal the webhook token
/// and store it on the app's dispatcher-registry row. Always answers with the
/// standalone result page — this tab belongs to the user's external browser;
/// the Activity itself learns the outcome by re-reading the identity list.
async fn activity_connect_callback(st: &AppState, state: &str, code: &str) -> Response {
    let sealed = &state[ACTIVITY_WEBHOOK_STATE_PREFIX.len()..];
    let ctx = crate::seal::open_state(&st.key, sealed)
        .and_then(|payload| serde_json::from_str::<ActivityConnectState>(&payload).ok());
    let Some(ctx) = ctx else {
        return activity_connect_page(
            false,
            "This link can't be verified",
            "The connect link is damaged or wasn't issued by this DWEEB. Return to Discord and start again from the post dialog.",
        );
    };
    if now() > ctx.x {
        return activity_connect_page(
            false,
            "This link has expired",
            "Connect links are valid for 10 minutes. Return to Discord and start again from the post dialog.",
        );
    }
    let exchanged = st
        .discord
        .exchange_code(&ctx.a, &ctx.s, code, &st.config.oauth_redirect_url)
        .await;
    let Ok(token) = exchanged else {
        // Almost always a stale client secret or a missing redirect URI on the
        // user's app — their fix, not ours, so say so without leaking detail.
        tracing::warn!("activity connect exchange failed");
        return activity_connect_page(
            false,
            "Discord refused the authorization",
            "Check that the app's client secret registered with DWEEB is current and that DWEEB's callback URL is listed under the app's OAuth2 → Redirects, then try again.",
        );
    };
    let webhook = token
        .webhook
        .and_then(|w| match (w.id, w.token, w.channel_id) {
            (Some(id), Some(tok), Some(channel)) if !id.is_empty() && !tok.is_empty() => {
                Some((id, tok, channel, w.guild_id))
            }
            _ => None,
        });
    let Some((hook_id, hook_token, channel_id, guild_id)) = webhook else {
        return activity_connect_page(
            false,
            "No webhook came back",
            "Discord completed the authorization but returned no webhook. Return to Discord and try again.",
        );
    };
    if guild_id.as_deref() != Some(ctx.g.as_str()) {
        // Created in some other server — refuse it, and best-effort remove the
        // stray webhook so nothing half-connected is left behind.
        let _ = st
            .discord
            .delete_webhook_by_token(&hook_id, &hook_token)
            .await;
        return activity_connect_page(
            false,
            "That was a different server",
            "The webhook was authorized in another server, so nothing was connected. Try again and keep the pre-selected server in Discord's dialog.",
        );
    }
    let Some(token_enc) = crate::seal::seal_hook(&st.key, &hook_token) else {
        return activity_connect_page(
            false,
            "Something went wrong on our side",
            "The webhook credential couldn't be secured, so nothing was stored. Please try again.",
        );
    };
    match crate::activity::store_activity_hook(
        st,
        &ctx.g,
        &ctx.a,
        &hook_id,
        &channel_id,
        &token_enc,
    )
    .await
    {
        Ok(()) => {
            // Tell the live Activity room the bot is ready, so its "Post as"
            // dialog selects it the instant this returns — no polling, no focus
            // event needed. Best-effort: the room may have closed, or the flow
            // began outside one (`i` empty); the dialog's own re-check covers it.
            if !ctx.i.is_empty() {
                st.activity_rooms.notify(
                    &ctx.i,
                    json!({ "type": "bot_connected", "application_id": ctx.a }).to_string(),
                );
            }
            activity_connect_page(
                true,
                "Your bot is connected",
                "You can close this tab and return to Discord — it's already selected under “Post as”. Posts will appear under your bot in any channel you choose.",
            )
        }
        Err(err) => {
            tracing::warn!("activity connect store failed: {err}");
            // Nothing will ever use the webhook we just minted — best-effort
            // remove it so nothing half-connected lingers in the server.
            let _ = st
                .discord
                .delete_webhook_by_token(&hook_id, &hook_token)
                .await;
            activity_connect_page(
                false,
                "The connection couldn't be saved",
                "The webhook was created but couldn't be stored — the app may have been unregistered meanwhile. Return to Discord and try again.",
            )
        }
    }
}

/// The standalone result page for an Activity connect flow. Self-contained
/// (inline styles, no external assets) because it renders in whatever browser
/// Discord handed the flow to. `title`/`detail` are always our own static
/// strings — nothing user-controlled is echoed.
fn activity_connect_page(ok: bool, title: &str, detail: &str) -> Response {
    let (icon, accent) = if ok {
        ("✓", "#3ba55d")
    } else {
        ("✕", "#ed4245")
    };
    let html = format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>{title} · DWEEB</title>
<style>
  body{{margin:0;display:grid;place-items:center;min-height:100vh;background:#1e1f22;
       color:#dbdee1;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}}
  main{{max-width:26rem;padding:2.5rem 1.5rem;text-align:center}}
  .icon{{display:inline-grid;place-items:center;width:3.25rem;height:3.25rem;border-radius:50%;
        background:{accent};color:#fff;font-size:1.6rem;font-weight:700;margin-bottom:1rem}}
  h1{{font-size:1.15rem;margin:0 0 .5rem;color:#f2f3f5}}
  p{{margin:0;color:#b5bac1}}
  .brand{{margin-top:2rem;font-size:.8rem;letter-spacing:.08em;color:#80848e}}
</style></head><body><main>
<span class="icon" aria-hidden="true">{icon}</span>
<h1>{title}</h1>
<p>{detail}</p>
<div class="brand">DWEEB</div>
</main></body></html>"#
    );
    (
        [
            (axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (axum::http::header::CACHE_CONTROL, "no-store"),
        ],
        html,
    )
        .into_response()
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
