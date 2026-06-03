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

use crate::error::AppError;
use crate::routes::{current_session, AppState, UsableGuild};
use crate::session::{
    build_session_cookie, build_state_cookie, clear_session_cookie, clear_state_cookie, now,
    Session, STATE_COOKIE,
};

/// `GET /auth/login` — set a CSRF `state` cookie and bounce to Discord.
pub async fn login(State(st): State<AppState>, jar: PrivateCookieJar) -> impl IntoResponse {
    let cfg = &st.config;
    let state = random_token();
    let url = authorize_url(&cfg.client_id, &cfg.oauth_redirect_url, &state);
    let jar = jar.add(build_state_cookie(cfg, &state));
    (jar, Redirect::to(&url))
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
    if q.error.is_some() || q.code.is_none() {
        let jar = jar.add(clear_state_cookie(cfg));
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
    let token = st
        .discord
        .exchange_code(&cfg.client_id, &cfg.client_secret, &code, &cfg.oauth_redirect_url)
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
            st.cache.put(format!("uguilds:{}", user.id), Arc::new(val)).await;
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
        format!("https://cdn.discordapp.com/avatars/{}/{hash}.{ext}", session.uid)
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
