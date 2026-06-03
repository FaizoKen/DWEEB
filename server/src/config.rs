//! Runtime configuration, read entirely from environment variables so the same
//! binary works for `cargo run`, Docker, and `docker compose` without code
//! changes. See `.env.example` for the full list with explanations.

use std::time::Duration;

/// Which browser origins may call the proxy (the CORS allow-list).
///
/// Because the proxy now uses cookie-based sessions, requests are *credentialed*
/// — and the CORS spec forbids `Access-Control-Allow-Origin: *` together with
/// credentials. So unlike the earlier read-only design there is no `Any` variant:
/// the allowed origins must be listed explicitly.
pub struct Origins(pub Vec<String>);

pub struct Config {
    /// Bot token used as `Authorization: Bot <token>` against Discord.
    pub bot_token: String,
    /// Socket address to listen on, e.g. `0.0.0.0:8080`.
    pub bind_addr: String,
    /// Exact browser origins permitted to call the proxy (CORS, credentialed).
    pub allowed_origins: Origins,
    /// How long a guild's roles/channels/emojis stay cached.
    pub cache_ttl: Duration,

    // ── Discord OAuth ──────────────────────────────────────────────────────
    /// OAuth2 client id of the DWEEB application.
    pub client_id: String,
    /// OAuth2 client secret. Never leaves the server.
    pub client_secret: String,
    /// The `redirect_uri` registered with Discord — points at `/auth/callback`
    /// on *this* service, e.g. `https://api.dweeb.example.com/auth/callback`.
    pub oauth_redirect_url: String,
    /// Where to send the browser after a successful login (the builder's URL).
    pub frontend_url: String,

    // ── Sessions ───────────────────────────────────────────────────────────
    /// Master key material (≥32 bytes) the encrypted session cookie is derived
    /// from. Rotating it logs everyone out.
    pub session_secret: String,
    /// How long a login lasts before re-auth is required.
    pub session_ttl: Duration,
    /// `Secure` flag on cookies. True in production (HTTPS); set false only for
    /// plain-HTTP local testing.
    pub cookie_secure: bool,
    /// `SameSite` policy: "lax" (default, works across subdomains of one site)
    /// or "none" (required when the API and builder are on different sites).
    pub cookie_samesite: SameSitePolicy,
    /// Optional cookie `Domain` (e.g. `.dweeb.example.com`) so the session is
    /// shared across the builder + api subdomains. None ⇒ host-only cookie.
    pub cookie_domain: Option<String>,

    // ── Authorization policy ───────────────────────────────────────────────
    /// When true, a user may only read servers where they own or hold
    /// `MANAGE_GUILD` — appropriate for a webhook-builder tool. When false, any
    /// server they're a member of is allowed.
    pub require_manage_guild: bool,

    // ── Abuse controls ─────────────────────────────────────────────────────
    /// Sustained per-IP request rate (requests per minute) for `/api` + `/auth`.
    pub rate_limit_per_min: u32,
    /// Burst the per-IP limiter tolerates above the sustained rate.
    pub rate_limit_burst: u32,
    /// Max simultaneous in-flight calls to Discord under the bot token, so a
    /// traffic spike can never exceed Discord's global rate budget.
    pub discord_max_concurrency: usize,

    // ── Scaling ────────────────────────────────────────────────────────────
    /// When set (e.g. `redis://127.0.0.1:6379`), the cache and rate limiter are
    /// shared via Redis so multiple proxy instances can run behind a load
    /// balancer. Unset ⇒ process-local in-memory backends (single instance).
    pub redis_url: Option<String>,
}

#[derive(Clone, Copy)]
pub enum SameSitePolicy {
    Lax,
    None,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let bot_token = req_env("DISCORD_BOT_TOKEN")?;
        let bind_addr = opt_env("BIND_ADDR").unwrap_or_else(|| "0.0.0.0:8080".to_string());

        // Credentialed CORS can't use "*", so an explicit list is mandatory.
        let allowed_origins = match opt_env("ALLOWED_ORIGINS") {
            None => return Err("ALLOWED_ORIGINS is required (cookie auth can't use \"*\")".into()),
            Some(s) if s.trim() == "*" => {
                return Err(
                    "ALLOWED_ORIGINS cannot be \"*\" with cookie auth — list the builder's exact origin(s)"
                        .into(),
                )
            }
            Some(s) => {
                let list = split_list(&s);
                if list.is_empty() {
                    return Err("ALLOWED_ORIGINS is empty after parsing".into());
                }
                Origins(list)
            }
        };

        let cache_ttl = Duration::from_secs(parse_or("CACHE_TTL_SECS", 60));

        let client_id = req_env("DISCORD_CLIENT_ID")?;
        let client_secret = req_env("DISCORD_CLIENT_SECRET")?;
        let oauth_redirect_url = req_env("OAUTH_REDIRECT_URL")?;
        let frontend_url = req_env("FRONTEND_URL")?;

        let session_secret = req_env("SESSION_SECRET")?;
        // `cookie::Key::from` requires ≥64 bytes of key material (512 bits) for
        // the combined signing + encryption keys.
        if session_secret.len() < 64 {
            return Err("SESSION_SECRET must be at least 64 characters".into());
        }
        let session_ttl = Duration::from_secs(parse_or::<u64>("SESSION_TTL_HOURS", 168) * 3600);
        let cookie_secure = parse_bool("COOKIE_SECURE", true);
        let cookie_samesite = match opt_env("COOKIE_SAMESITE").as_deref() {
            Some("none") | Some("None") => SameSitePolicy::None,
            _ => SameSitePolicy::Lax,
        };
        let cookie_domain = opt_env("COOKIE_DOMAIN");

        let require_manage_guild = parse_bool("REQUIRE_MANAGE_GUILD", true);

        let rate_limit_per_min = parse_or("RATE_LIMIT_PER_MIN", 60);
        let rate_limit_burst = parse_or("RATE_LIMIT_BURST", 20);
        let discord_max_concurrency = parse_or("DISCORD_MAX_CONCURRENCY", 10);

        let redis_url = opt_env("REDIS_URL");

        Ok(Config {
            bot_token,
            bind_addr,
            allowed_origins,
            cache_ttl,
            client_id,
            client_secret,
            oauth_redirect_url,
            frontend_url,
            session_secret,
            session_ttl,
            cookie_secure,
            cookie_samesite,
            cookie_domain,
            require_manage_guild,
            rate_limit_per_min,
            rate_limit_burst,
            discord_max_concurrency,
            redis_url,
        })
    }
}

/// Required variable: error out if missing or blank.
fn req_env(key: &str) -> Result<String, String> {
    match std::env::var(key) {
        Ok(v) if !v.trim().is_empty() => Ok(v),
        _ => Err(format!("{key} is required")),
    }
}

/// Optional variable: `None` if missing or blank.
fn opt_env(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(v) if !v.trim().is_empty() => Some(v),
        _ => None,
    }
}

/// Parse an env var into `T`, falling back to `default` when missing/invalid.
fn parse_or<T: std::str::FromStr>(key: &str, default: T) -> T {
    opt_env(key)
        .and_then(|s| s.parse::<T>().ok())
        .unwrap_or(default)
}

/// Parse a boolean env var (`true`/`1`/`yes` ⇒ true), falling back to `default`.
fn parse_bool(key: &str, default: bool) -> bool {
    match opt_env(key).map(|s| s.to_ascii_lowercase()) {
        Some(v) => matches!(v.as_str(), "1" | "true" | "yes" | "on"),
        None => default,
    }
}

/// Split a comma-separated env value, trimming whitespace and dropping blanks.
fn split_list(s: &str) -> Vec<String> {
    s.split(',')
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}
