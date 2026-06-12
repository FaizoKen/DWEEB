//! Cookie-backed sessions.
//!
//! After a successful Discord login we store a small JSON session inside an
//! **encrypted** cookie (`PrivateCookieJar`, AEAD-sealed with a key derived from
//! `SESSION_SECRET`). The cookie is `HttpOnly` (invisible to page JS) and, in
//! production, `Secure`. Because the payload is encrypted, the user's Discord
//! access token can ride along safely — letting us re-check guild membership
//! without any server-side session store, which keeps the proxy horizontally
//! scalable.
//!
//! The session is the *authorization root*: every `/api/guilds/...` read first
//! decodes a valid, unexpired session, then confirms the requested guild is one
//! the user actually belongs to.

use axum_extra::extract::cookie::{Cookie, SameSite};
use serde::{Deserialize, Serialize};
use time::Duration;

use crate::config::{Config, SameSitePolicy};

/// Name of the encrypted session cookie.
pub const SESSION_COOKIE: &str = "dweeb_session";
/// Name of the short-lived OAuth CSRF-state cookie.
pub const STATE_COOKIE: &str = "dweeb_oauth_state";
/// Name of the short-lived cookie carrying a custom app's OAuth credentials
/// across the bring-your-own-app webhook redirect (see `auth.rs`). Encrypted
/// by the private jar like the session, HttpOnly, and cleared on callback —
/// the secret is never persisted server-side.
pub const CUSTOM_APP_COOKIE: &str = "dweeb_custom_app";

/// The decoded session. Kept tiny so the cookie stays well under the 4 KB cap.
#[derive(Serialize, Deserialize, Clone)]
pub struct Session {
    /// Discord user id.
    pub uid: String,
    /// Display name (global name, falling back to username) — for the FE header.
    pub name: String,
    /// Avatar hash, or None.
    pub avatar: Option<String>,
    /// The user's Discord OAuth access token (encrypted at rest in the cookie).
    pub token: String,
    /// Absolute expiry, unix seconds.
    pub exp: i64,
}

impl Session {
    pub fn is_expired(&self) -> bool {
        now() >= self.exp
    }
}

/// Current unix time in seconds.
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Map our config policy onto the cookie crate's enum.
fn same_site(cfg: &Config) -> SameSite {
    match cfg.cookie_samesite {
        SameSitePolicy::Lax => SameSite::Lax,
        SameSitePolicy::None => SameSite::None,
    }
}

/// Apply the shared security attributes (path, http-only, secure, same-site,
/// optional domain) to a cookie.
fn harden(mut cookie: Cookie<'static>, cfg: &Config) -> Cookie<'static> {
    cookie.set_path("/");
    cookie.set_http_only(true);
    cookie.set_secure(cfg.cookie_secure);
    cookie.set_same_site(same_site(cfg));
    if let Some(domain) = &cfg.cookie_domain {
        cookie.set_domain(domain.clone());
    }
    cookie
}

/// Build the session cookie carrying `session` (serialized JSON), expiring with
/// the session.
pub fn build_session_cookie(cfg: &Config, session: &Session) -> Cookie<'static> {
    let json = serde_json::to_string(session).unwrap_or_default();
    let mut cookie = Cookie::new(SESSION_COOKIE, json);
    let ttl = (session.exp - now()).max(0);
    cookie.set_max_age(Duration::seconds(ttl));
    harden(cookie, cfg)
}

/// A removal cookie that clears the session (used by logout).
pub fn clear_session_cookie(cfg: &Config) -> Cookie<'static> {
    let mut cookie = Cookie::new(SESSION_COOKIE, "");
    cookie.set_max_age(Duration::seconds(0));
    harden(cookie, cfg)
}

/// Build the short-lived OAuth state cookie (CSRF protection for the callback).
pub fn build_state_cookie(cfg: &Config, state: &str) -> Cookie<'static> {
    let mut cookie = Cookie::new(STATE_COOKIE, state.to_string());
    cookie.set_max_age(Duration::minutes(10));
    harden(cookie, cfg)
}

/// A removal cookie for the state cookie (cleared once the callback consumes it).
pub fn clear_state_cookie(cfg: &Config) -> Cookie<'static> {
    let mut cookie = Cookie::new(STATE_COOKIE, "");
    cookie.set_max_age(Duration::seconds(0));
    harden(cookie, cfg)
}

/// Build the short-lived cookie that parks a custom app's OAuth credentials
/// (serialized JSON) during the bring-your-own-app webhook flow. Same 10-minute
/// budget as the state cookie it always travels with.
pub fn build_custom_app_cookie(cfg: &Config, creds_json: &str) -> Cookie<'static> {
    let mut cookie = Cookie::new(CUSTOM_APP_COOKIE, creds_json.to_string());
    cookie.set_max_age(Duration::minutes(10));
    harden(cookie, cfg)
}

/// A removal cookie for the custom-app credentials (cleared once the callback
/// consumes them — or abandons the flow).
pub fn clear_custom_app_cookie(cfg: &Config) -> Cookie<'static> {
    let mut cookie = Cookie::new(CUSTOM_APP_COOKIE, "");
    cookie.set_max_age(Duration::seconds(0));
    harden(cookie, cfg)
}
