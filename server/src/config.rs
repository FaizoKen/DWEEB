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

    // ── Discord Activities (embedded app) ──────────────────────────────────
    /// Master switch for the embedded Activity endpoints (`/api/activity/*`):
    /// the SDK token exchange, server-side publish, and the collaboration room
    /// WebSocket. Default on — they reuse the OAuth client + bot token the proxy
    /// already holds, so no extra secret is needed. Set false to refuse them
    /// (501) on a deployment that doesn't register an Activity.
    pub activities_enabled: bool,
    /// Host allow-list (bare domains) the Activity *plugin proxy* may load a
    /// config page from — and forward its API calls to. Inside Discord a plugin's
    /// own `*.dweeb.faizo.net` config iframe is blocked by the sandbox CSP, so the
    /// proxy serves it same-origin instead (`/api/activity/plugin*`); this list is
    /// what stops that path from becoming an open proxy. A host matches when it
    /// equals an entry or is a sub-domain of one. From `ACTIVITY_PLUGIN_HOSTS`
    /// (comma-separated); defaults to the DWEEB plugin domain.
    pub activity_plugin_hosts: Vec<String>,
    /// SQLite file the Activity's collaboration drafts persist to, so a room can
    /// be reopened where it was left off (see `activity_draft.rs`). Should sit on
    /// the same persistent volume as the schedule/short-link DBs to survive a
    /// redeploy. Only used when `activities_enabled`.
    pub activity_draft_db_path: String,
    /// Creation of a *new* instance's draft is dropped once this many are stored
    /// (existing rows keep updating); bounds worst-case disk use under abuse.
    pub activity_draft_max_entries: u64,
    /// Days a collaboration draft is kept after its last edit before the sweeper
    /// deletes it — a session nobody has touched this long won't be resumed.
    pub activity_draft_retention_days: i64,
    /// Feedback forum webhook the embedded Activity relays "Send feedback" reports
    /// to. The web app posts feedback to this webhook straight from the browser
    /// (`VITE_FEEDBACK_WEBHOOK_URL`), but a sandboxed Activity iframe can't reach
    /// discord.com directly, so `activity_feedback` forwards the report on the
    /// browser's behalf. Held server-side so the browser never names the
    /// destination — it can't be turned into an open relay. None (unset) ⇒ the
    /// Activity's feedback endpoint answers 501.
    pub feedback_webhook_url: Option<String>,

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

    // ── Short links ────────────────────────────────────────────────────────
    /// Days a short link lives before it auto-expires and is deleted
    /// (default 7). 0 disables the feature: the endpoints answer 501 and the
    /// builder's UI only offers the default hash link.
    pub shortlink_ttl_days: u64,
    /// SQLite file the short links live in. Must sit on persistent storage —
    /// a short link is a 7-day promise, so it has to survive a redeploy.
    pub shortlink_db_path: String,
    /// Creation answers 503 once this many links are stored (existing links
    /// keep resolving); bounds worst-case disk usage under abuse.
    pub shortlink_max_entries: u64,

    // ── Scheduled posts ────────────────────────────────────────────────────
    /// Master switch for scheduled posts. False ⇒ the `/api/schedules`
    /// endpoints answer 501 and the worker never starts (the builder hides the
    /// tab). Default on — the feature needs no secret beyond SESSION_SECRET,
    /// which is already required for sealing.
    pub schedules_enabled: bool,
    /// SQLite file the scheduled posts live in. Must sit on persistent storage —
    /// a schedule is a promise to post later, so it has to survive a redeploy.
    pub schedule_db_path: String,
    /// Creation answers 503 once this many schedules are stored; bounds disk use.
    pub schedule_max_entries: u64,
    /// Max active/paused schedules per destination webhook (anti-spam).
    pub schedule_max_per_webhook: u64,
    /// Max active/paused schedules per destination **server** — the user-facing
    /// quota. Default 5.
    pub schedule_max_per_guild: u64,
    /// How far ahead a first run may be scheduled (days). Default 366.
    pub schedule_max_horizon_days: u64,
    /// How often the delivery worker wakes to fire due schedules (seconds).
    pub scheduler_tick_secs: u64,
    /// How long a claimed (`sending`) row is leased before a crashed worker's
    /// claim is reclaimed and retried (seconds).
    pub scheduler_lease_secs: i64,
    /// Max schedules fired per worker tick — bounds the Discord call rate after
    /// a backlog.
    pub scheduler_batch: usize,
    /// Days a completed/failed schedule is kept (for the management list) before
    /// the worker sweeps it.
    pub schedule_retention_days: i64,

    // ── Permanent component slots ──────────────────────────────────────────
    /// Base URL of the interactions dispatcher's internal API (compose-network
    /// address, e.g. `http://dispatcher:8095`). Together with
    /// `dispatcher_token`, enables the dashboard's permanent-slot management;
    /// unset ⇒ those endpoints answer 501.
    pub dispatcher_url: Option<String>,
    /// Bearer token for the dispatcher's internal API (`INTERNAL_API_TOKEN`
    /// on the dispatcher side).
    pub dispatcher_token: Option<String>,
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

        let activities_enabled = parse_bool("ACTIVITIES_ENABLED", true);
        let activity_plugin_hosts = opt_env("ACTIVITY_PLUGIN_HOSTS")
            .map(|s| split_list(&s))
            .filter(|l| !l.is_empty())
            .unwrap_or_else(|| vec!["dweeb.faizo.net".to_string()]);
        let activity_draft_db_path =
            opt_env("ACTIVITY_DRAFT_DB_PATH").unwrap_or_else(|| "activity-drafts.db".to_string());
        let activity_draft_max_entries = parse_or("ACTIVITY_DRAFT_MAX_ENTRIES", 20_000);
        let activity_draft_retention_days = parse_or("ACTIVITY_DRAFT_RETENTION_DAYS", 7);
        let feedback_webhook_url = opt_env("FEEDBACK_WEBHOOK_URL");

        let require_manage_guild = parse_bool("REQUIRE_MANAGE_GUILD", true);

        let rate_limit_per_min = parse_or("RATE_LIMIT_PER_MIN", 60);
        let rate_limit_burst = parse_or("RATE_LIMIT_BURST", 20);
        let discord_max_concurrency = parse_or("DISCORD_MAX_CONCURRENCY", 10);

        let redis_url = opt_env("REDIS_URL");

        let shortlink_ttl_days = parse_or("SHORTLINK_TTL_DAYS", 7);
        let shortlink_db_path =
            opt_env("SHORTLINK_DB_PATH").unwrap_or_else(|| "shortlinks.db".to_string());
        let shortlink_max_entries = parse_or("SHORTLINK_MAX_ENTRIES", 50_000);

        let schedules_enabled = parse_bool("SCHEDULES_ENABLED", true);
        let schedule_db_path =
            opt_env("SCHEDULE_DB_PATH").unwrap_or_else(|| "schedules.db".to_string());
        let schedule_max_entries = parse_or("SCHEDULE_MAX_ENTRIES", 5_000);
        let schedule_max_per_webhook = parse_or("SCHEDULE_MAX_PER_WEBHOOK", 25);
        let schedule_max_per_guild = parse_or("SCHEDULE_MAX_PER_GUILD", 5);
        let schedule_max_horizon_days = parse_or("SCHEDULE_MAX_HORIZON_DAYS", 366);
        let scheduler_tick_secs = parse_or("SCHEDULER_TICK_SECS", 15);
        let scheduler_lease_secs = parse_or("SCHEDULER_LEASE_SECS", 120);
        let scheduler_batch = parse_or("SCHEDULER_BATCH", 25);
        let schedule_retention_days = parse_or("SCHEDULE_RETENTION_DAYS", 7);

        let dispatcher_url = opt_env("DISPATCHER_URL").map(|u| u.trim_end_matches('/').to_string());
        let dispatcher_token = opt_env("DISPATCHER_API_TOKEN");

        Ok(Config {
            bot_token,
            bind_addr,
            allowed_origins,
            cache_ttl,
            client_id,
            client_secret,
            oauth_redirect_url,
            frontend_url,
            activities_enabled,
            activity_plugin_hosts,
            activity_draft_db_path,
            activity_draft_max_entries,
            activity_draft_retention_days,
            feedback_webhook_url,
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
            shortlink_ttl_days,
            shortlink_db_path,
            shortlink_max_entries,
            schedules_enabled,
            schedule_db_path,
            schedule_max_entries,
            schedule_max_per_webhook,
            schedule_max_per_guild,
            schedule_max_horizon_days,
            scheduler_tick_secs,
            scheduler_lease_secs,
            scheduler_batch,
            schedule_retention_days,
            dispatcher_url,
            dispatcher_token,
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
