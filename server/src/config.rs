//! Runtime configuration, read entirely from environment variables so the same
//! binary works for `cargo run`, Docker, and `docker compose` without code
//! changes. See `.env.example` for the full list with explanations.

use std::collections::HashMap;
use std::time::Duration;

/// Which browser origins may call the proxy (the CORS allow-list).
///
/// Because the proxy now uses cookie-based sessions, requests are *credentialed*
/// — and the CORS spec forbids `Access-Control-Allow-Origin: *` together with
/// credentials. So unlike the earlier read-only design there is no `Any` variant:
/// the allowed origins must be listed explicitly.
pub struct Origins(pub Vec<String>);

/// Per-tier numeric quotas for the plan gates. `0` means **unlimited** — the
/// enforcement points translate it to `i64::MAX`. All values are env-tunable;
/// the defaults encode the shipped Free/Plus/Pro table.
#[derive(Clone, Copy)]
pub struct TierLimits {
    /// Active scheduled posts (per server).
    pub schedules: i64,
    /// Never-expire / permanent component slots (per server).
    pub permanent: i64,
    /// Registered custom bots (per server).
    pub custom_bots: i64,
    /// Concurrent live co-editors in an Activity collaboration room.
    pub coeditors: i64,
    /// Deliberately saved library drafts (per server) — the curated shelf.
    pub library: i64,
    /// Posted-message history window (per server): the library keeps the last
    /// N posted messages, auto-recorded and auto-evicted oldest-first.
    pub library_posted: i64,
}

/// The Free / Plus / Pro quota table read by `entitlement.rs`.
pub struct PlanLimits {
    pub free: TierLimits,
    pub plus: TierLimits,
    pub pro: TierLimits,
}

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

    // ── Message library ────────────────────────────────────────────────────
    /// Master switch for the per-server message library. False ⇒ the
    /// `/api/guilds/:id/library` endpoints answer 501 and both frontends fall
    /// back to browser-local storage only. Default on — like schedules it
    /// needs no secret beyond SESSION_SECRET, which sealing already requires.
    pub library_enabled: bool,
    /// SQLite file the library lives in. Must sit on persistent storage — a
    /// saved message is a promise to keep it, so it has to survive a redeploy.
    pub library_db_path: String,
    /// Creation answers 503 once this many entries are stored (existing ones
    /// stay readable); bounds worst-case disk use under abuse.
    pub library_max_entries: u64,
    /// Max saved drafts per server when plan entitlement is disabled — the
    /// standalone default the tier limits override.
    pub library_max_per_guild: u64,
    /// Posted-history window per server when plan entitlement is disabled —
    /// how many auto-recorded posted messages a server keeps before the oldest
    /// is evicted.
    pub library_posted_per_guild: u64,

    // ── Permanent component slots ──────────────────────────────────────────
    /// Base URL of the interactions dispatcher's internal API (compose-network
    /// address, e.g. `http://dispatcher:8095`). Together with
    /// `dispatcher_token`, enables the dashboard's permanent-slot management;
    /// unset ⇒ those endpoints answer 501.
    pub dispatcher_url: Option<String>,
    /// Bearer token for the dispatcher's internal API (`INTERNAL_API_TOKEN`
    /// on the dispatcher side).
    pub dispatcher_token: Option<String>,

    // ── Plans & billing (DWEEB's own Stripe integration) ───────────────────
    // DWEEB reads Stripe DIRECTLY (its own webhook + local mirror + checkout),
    // sharing the same Stripe account + price IDs (SKUs) as RoleLogic but with no
    // runtime dependency on it: RoleLogic being down never affects DWEEB.
    /// Stripe secret key (`sk_live_…`/`sk_test_…`). None ⇒ the whole plan system
    /// is inert (every user Free, gates use store defaults) and DWEEB runs
    /// standalone.
    pub stripe_secret_key: Option<String>,
    /// Stripe webhook signing secret (`whsec_…`). None ⇒ `/api/stripe/webhook`
    /// answers 501 (the mirror then fills only via lazy backfill).
    pub stripe_webhook_secret: Option<String>,
    /// price_id → entitlement slots: the shared-SKU map (the same prices
    /// RoleLogic sells). From `STRIPE_PRICE_SLOTS` (JSON `{price_id: slots}`).
    pub stripe_price_slots: HashMap<String, i64>,
    /// (tier, interval) → the price id its in-app checkout buys. Keys are
    /// "plus"/"pro" (monthly) and "plus_year"/"pro_year" (annual). From
    /// `STRIPE_CHECKOUT_PRICE_PLUS[_YEAR]` / `_PRO[_YEAR]`.
    pub stripe_checkout_price: HashMap<String, String>,
    /// Optional fixed TaxRate id (`txr_…`) added on top at checkout (parity with
    /// RoleLogic's manual-tax path). None ⇒ no tax line.
    pub stripe_tax_rate_id: Option<String>,
    /// SQLite file the local subscription mirror lives in — on the same
    /// persistent volume as the other stores.
    pub stripe_db_path: String,
    /// How long before DWEEB re-checks Stripe for a user with no mirrored
    /// subscription — bounds backfill calls for existing subscribers + free users.
    pub stripe_backfill_ttl_secs: i64,
    /// How long a resolved tier is cached per user before re-reading the mirror.
    pub entitlement_cache_secs: i64,
    /// The Free/Plus/Pro quota table (env-tunable; defaults shipped).
    pub plan_limits: PlanLimits,
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

        let library_enabled = parse_bool("LIBRARY_ENABLED", true);
        let library_db_path =
            opt_env("LIBRARY_DB_PATH").unwrap_or_else(|| "library.db".to_string());
        let library_max_entries = parse_or("LIBRARY_MAX_ENTRIES", 100_000);
        let library_max_per_guild = parse_or("LIBRARY_MAX_PER_GUILD", 100);
        let library_posted_per_guild = parse_or("LIBRARY_POSTED_PER_GUILD", 100);

        let dispatcher_url = opt_env("DISPATCHER_URL").map(|u| u.trim_end_matches('/').to_string());
        let dispatcher_token = opt_env("DISPATCHER_API_TOKEN");

        let stripe_secret_key = opt_env("STRIPE_SECRET_KEY");
        let stripe_webhook_secret = opt_env("STRIPE_WEBHOOK_SECRET");
        let stripe_price_slots = opt_env("STRIPE_PRICE_SLOTS")
            .and_then(|s| serde_json::from_str::<HashMap<String, i64>>(&s).ok())
            .unwrap_or_default();
        // Keys are "plus"/"pro" (monthly) and "plus_year"/"pro_year" (annual);
        // see `stripe::checkout_key`.
        let mut stripe_checkout_price = HashMap::new();
        if let Some(p) = opt_env("STRIPE_CHECKOUT_PRICE_PLUS") {
            stripe_checkout_price.insert("plus".to_string(), p);
        }
        if let Some(p) = opt_env("STRIPE_CHECKOUT_PRICE_PRO") {
            stripe_checkout_price.insert("pro".to_string(), p);
        }
        if let Some(p) = opt_env("STRIPE_CHECKOUT_PRICE_PLUS_YEAR") {
            stripe_checkout_price.insert("plus_year".to_string(), p);
        }
        if let Some(p) = opt_env("STRIPE_CHECKOUT_PRICE_PRO_YEAR") {
            stripe_checkout_price.insert("pro_year".to_string(), p);
        }
        let stripe_tax_rate_id = opt_env("STRIPE_TAX_RATE_ID");
        let stripe_db_path = opt_env("STRIPE_DB_PATH").unwrap_or_else(|| "stripe.db".to_string());
        let stripe_backfill_ttl_secs = parse_or("STRIPE_BACKFILL_TTL_SECS", 86_400);
        let entitlement_cache_secs = parse_or("ENTITLEMENT_CACHE_SECS", 300);
        let plan_limits = PlanLimits {
            free: TierLimits {
                schedules: parse_or("PLAN_FREE_SCHEDULES", 3),
                permanent: parse_or("PLAN_FREE_PERMANENT", 5),
                custom_bots: parse_or("PLAN_FREE_CUSTOM_BOTS", 1),
                coeditors: parse_or("PLAN_FREE_COEDITORS", 2),
                library: parse_or("PLAN_FREE_LIBRARY", 10),
                library_posted: parse_or("PLAN_FREE_LIBRARY_POSTED", 10),
            },
            plus: TierLimits {
                schedules: parse_or("PLAN_PLUS_SCHEDULES", 30),
                permanent: parse_or("PLAN_PLUS_PERMANENT", 25),
                custom_bots: parse_or("PLAN_PLUS_CUSTOM_BOTS", 2),
                coeditors: parse_or("PLAN_PLUS_COEDITORS", 6),
                library: parse_or("PLAN_PLUS_LIBRARY", 100),
                library_posted: parse_or("PLAN_PLUS_LIBRARY_POSTED", 100),
            },
            pro: TierLimits {
                // 0 = unlimited (mapped to i64::MAX at each gate).
                schedules: parse_or("PLAN_PRO_SCHEDULES", 0),
                permanent: parse_or("PLAN_PRO_PERMANENT", 0),
                custom_bots: parse_or("PLAN_PRO_CUSTOM_BOTS", 5),
                coeditors: parse_or("PLAN_PRO_COEDITORS", 25),
                library: parse_or("PLAN_PRO_LIBRARY", 0),
                library_posted: parse_or("PLAN_PRO_LIBRARY_POSTED", 0),
            },
        };

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
            library_enabled,
            library_db_path,
            library_max_entries,
            library_max_per_guild,
            library_posted_per_guild,
            dispatcher_url,
            dispatcher_token,
            stripe_secret_key,
            stripe_webhook_secret,
            stripe_price_slots,
            stripe_checkout_price,
            stripe_tax_rate_id,
            stripe_db_path,
            stripe_backfill_ttl_secs,
            entitlement_cache_secs,
            plan_limits,
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
