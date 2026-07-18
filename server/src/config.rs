//! Runtime configuration, read entirely from environment variables so the same
//! binary works for `cargo run`, Docker, and `docker compose` without code
//! changes. See `.env.example` for the full list with explanations.

use std::collections::HashMap;
use std::path::Path;
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
    /// Max multipart Activity post/edit requests buffered at once. Each route
    /// accepts up to 32 MiB, so this is a hard process-memory circuit breaker.
    pub activity_upload_concurrency: usize,
    /// Server-held feedback forum webhook used by both browser surfaces. This is
    /// a credential and is never included in a frontend build. None (unset) ⇒
    /// the feedback endpoints answer 501.
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

        let cache_ttl = Duration::from_secs(parse_or("CACHE_TTL_SECS", 60)?);

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
        let session_ttl = Duration::from_secs(parse_or::<u64>("SESSION_TTL_HOURS", 168)? * 3600);
        let cookie_secure = parse_bool("COOKIE_SECURE", true)?;
        // Unset ⇒ Lax. A *set* value must be one we understand: silently falling
        // back to Lax on a typo would break cross-site auth in a way that looks
        // like a random logout bug, not a config error.
        let cookie_samesite = match opt_env("COOKIE_SAMESITE") {
            None => SameSitePolicy::Lax,
            Some(raw) => match raw.to_ascii_lowercase().as_str() {
                "lax" => SameSitePolicy::Lax,
                "none" => SameSitePolicy::None,
                _ => {
                    return Err(format!(
                        "COOKIE_SAMESITE must be \"lax\" or \"none\", got {raw:?}"
                    ))
                }
            },
        };
        let cookie_domain = opt_env("COOKIE_DOMAIN");

        let activities_enabled = parse_bool("ACTIVITIES_ENABLED", true)?;
        let activity_plugin_hosts = opt_env("ACTIVITY_PLUGIN_HOSTS")
            .map(|s| split_list(&s))
            .filter(|l| !l.is_empty())
            .unwrap_or_else(|| vec!["dweeb.faizo.net".to_string()]);
        let activity_draft_db_path =
            opt_env("ACTIVITY_DRAFT_DB_PATH").unwrap_or_else(|| "activity-drafts.db".to_string());
        let activity_draft_max_entries = parse_or("ACTIVITY_DRAFT_MAX_ENTRIES", 20_000)?;
        let activity_draft_retention_days = parse_or("ACTIVITY_DRAFT_RETENTION_DAYS", 7)?;
        let activity_upload_concurrency = parse_or("ACTIVITY_UPLOAD_CONCURRENCY", 2)?;
        if activity_upload_concurrency == 0 {
            return Err("ACTIVITY_UPLOAD_CONCURRENCY must be at least 1".into());
        }
        let feedback_webhook_url = match opt_env("FEEDBACK_WEBHOOK_URL") {
            Some(url) if valid_feedback_webhook_url(&url) => Some(url.trim().to_string()),
            Some(_) => {
                return Err(
                    "FEEDBACK_WEBHOOK_URL must be an https://discord.com/api/webhooks/... URL"
                        .into(),
                )
            }
            None => None,
        };

        let require_manage_guild = parse_bool("REQUIRE_MANAGE_GUILD", true)?;

        let rate_limit_per_min = parse_or("RATE_LIMIT_PER_MIN", 60)?;
        let rate_limit_burst = parse_or("RATE_LIMIT_BURST", 20)?;
        let discord_max_concurrency = parse_or("DISCORD_MAX_CONCURRENCY", 10)?;

        let redis_url = opt_env("REDIS_URL");

        let shortlink_ttl_days = parse_or("SHORTLINK_TTL_DAYS", 7)?;
        let shortlink_db_path =
            opt_env("SHORTLINK_DB_PATH").unwrap_or_else(|| "shortlinks.db".to_string());
        let shortlink_max_entries = parse_or("SHORTLINK_MAX_ENTRIES", 50_000)?;

        let schedules_enabled = parse_bool("SCHEDULES_ENABLED", true)?;
        let schedule_db_path =
            opt_env("SCHEDULE_DB_PATH").unwrap_or_else(|| "schedules.db".to_string());
        let schedule_max_entries = parse_or("SCHEDULE_MAX_ENTRIES", 5_000)?;
        let schedule_max_per_webhook = parse_or("SCHEDULE_MAX_PER_WEBHOOK", 25)?;
        let schedule_max_per_guild = parse_or("SCHEDULE_MAX_PER_GUILD", 5)?;
        let schedule_max_horizon_days = parse_or("SCHEDULE_MAX_HORIZON_DAYS", 366)?;
        let scheduler_tick_secs = parse_or("SCHEDULER_TICK_SECS", 15)?;
        let scheduler_lease_secs = parse_or("SCHEDULER_LEASE_SECS", 120)?;
        let scheduler_batch = parse_or("SCHEDULER_BATCH", 25)?;
        let schedule_retention_days = parse_or("SCHEDULE_RETENTION_DAYS", 7)?;

        let library_enabled = parse_bool("LIBRARY_ENABLED", true)?;
        let library_db_path =
            opt_env("LIBRARY_DB_PATH").unwrap_or_else(|| "library.db".to_string());
        let library_max_entries = parse_or("LIBRARY_MAX_ENTRIES", 100_000)?;
        let library_max_per_guild = parse_or("LIBRARY_MAX_PER_GUILD", 100)?;
        let library_posted_per_guild = parse_or("LIBRARY_POSTED_PER_GUILD", 100)?;

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
        let stripe_backfill_ttl_secs = parse_or("STRIPE_BACKFILL_TTL_SECS", 86_400)?;
        let entitlement_cache_secs = parse_or("ENTITLEMENT_CACHE_SECS", 300)?;
        let plan_limits = PlanLimits {
            free: TierLimits {
                schedules: parse_or("PLAN_FREE_SCHEDULES", 3)?,
                permanent: parse_or("PLAN_FREE_PERMANENT", 5)?,
                custom_bots: parse_or("PLAN_FREE_CUSTOM_BOTS", 1)?,
                coeditors: parse_or("PLAN_FREE_COEDITORS", 2)?,
                library: parse_or("PLAN_FREE_LIBRARY", 10)?,
                library_posted: parse_or("PLAN_FREE_LIBRARY_POSTED", 10)?,
            },
            plus: TierLimits {
                schedules: parse_or("PLAN_PLUS_SCHEDULES", 30)?,
                permanent: parse_or("PLAN_PLUS_PERMANENT", 25)?,
                custom_bots: parse_or("PLAN_PLUS_CUSTOM_BOTS", 2)?,
                coeditors: parse_or("PLAN_PLUS_COEDITORS", 6)?,
                library: parse_or("PLAN_PLUS_LIBRARY", 100)?,
                library_posted: parse_or("PLAN_PLUS_LIBRARY_POSTED", 100)?,
            },
            pro: TierLimits {
                // 0 = unlimited (mapped to i64::MAX at each gate).
                schedules: parse_or("PLAN_PRO_SCHEDULES", 0)?,
                permanent: parse_or("PLAN_PRO_PERMANENT", 0)?,
                custom_bots: parse_or("PLAN_PRO_CUSTOM_BOTS", 5)?,
                coeditors: parse_or("PLAN_PRO_COEDITORS", 25)?,
                library: parse_or("PLAN_PRO_LIBRARY", 0)?,
                library_posted: parse_or("PLAN_PRO_LIBRARY_POSTED", 0)?,
            },
        };

        check_durable_store_paths(
            &DurableStores {
                shortlink: (shortlink_ttl_days > 0).then_some(shortlink_db_path.as_str()),
                schedule: schedules_enabled.then_some(schedule_db_path.as_str()),
                library: library_enabled.then_some(library_db_path.as_str()),
                activity_draft: activities_enabled.then_some(activity_draft_db_path.as_str()),
                stripe: stripe_secret_key
                    .is_some()
                    .then_some(stripe_db_path.as_str()),
            },
            parse_bool("STRICT_DB_PATHS", false)?,
        )?;

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
            activity_upload_concurrency,
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

/// The SQLite files that hold a *durable promise* — a scheduled post that must
/// fire, a saved draft, a 7-day short link, the billing mirror. Only the stores
/// actually switched on are listed; a disabled feature's path is never opened,
/// so it has nothing to lose. `None` ⇒ that store is off.
struct DurableStores<'a> {
    shortlink: Option<&'a str>,
    schedule: Option<&'a str>,
    library: Option<&'a str>,
    activity_draft: Option<&'a str>,
    stripe: Option<&'a str>,
}

impl<'a> DurableStores<'a> {
    /// `(env key, configured path)` for each enabled store.
    fn enabled(&self) -> Vec<(&'static str, &'a str)> {
        [
            ("SHORTLINK_DB_PATH", self.shortlink),
            ("SCHEDULE_DB_PATH", self.schedule),
            ("LIBRARY_DB_PATH", self.library),
            ("ACTIVITY_DRAFT_DB_PATH", self.activity_draft),
            ("STRIPE_DB_PATH", self.stripe),
        ]
        .into_iter()
        .filter_map(|(key, path)| path.map(|p| (key, p)))
        .collect()
    }
}

/// Refuse — or at least shout — when a durable store is pointed at a *relative*
/// path.
///
/// Each of these paths defaults to a bare filename, which resolves against the
/// process's working directory. In a container that directory is part of the
/// image's writable layer, not the mounted volume, so the file is destroyed on
/// the next deploy: scheduled posts never fire, saved drafts vanish, short links
/// 404, the billing mirror empties. Nothing errors — the store just comes back
/// empty, which is the worst possible way to lose data.
///
/// Today production is safe only because compose happens to pass
/// `${SHORTLINK_DB_PATH:-/data/shortlinks.db}` and friends. That is a property of
/// a file the server has never seen. Drop one line from it and the loss is
/// silent, so make the server itself hold the invariant.
///
/// Warn by default (a hard failure here would take down a running deployment
/// that is quietly relying on a default), and let `STRICT_DB_PATHS=true` promote
/// it to a boot failure once an operator has confirmed every path is absolute.
fn check_durable_store_paths(stores: &DurableStores<'_>, strict: bool) -> Result<(), String> {
    let ephemeral: Vec<&str> = stores
        .enabled()
        .into_iter()
        .filter(|(_, path)| !is_durable_path(path))
        .map(|(key, _)| key)
        .collect();
    if ephemeral.is_empty() {
        return Ok(());
    }

    let keys = ephemeral.join(", ");
    if strict {
        return Err(format!(
            "STRICT_DB_PATHS is on, but these stores have a relative path and would not \
             survive a redeploy: {keys}. Point each at an absolute path on the persistent \
             volume (e.g. /data/<name>.db)."
        ));
    }
    tracing::warn!(
        target: "config",
        stores = %keys,
        "relative DB path(s): these files resolve against the working directory, which is \
         NOT the persistent volume in a container — the data is silently lost on the next \
         deploy. Set each to an absolute path (e.g. /data/<name>.db). Set STRICT_DB_PATHS=true \
         to make this a hard boot failure."
    );
    Ok(())
}

/// Does this path survive a redeploy — i.e. is it anchored somewhere other than
/// the process's working directory?
///
/// Deliberately *not* just `Path::is_absolute()`. That is evaluated with the host
/// platform's rules, and the proxy is developed on Windows but deployed in a
/// Linux container: `Path::new("/data/x.db").is_absolute()` is `false` on
/// Windows (it wants a drive letter), so the real production path would trip a
/// "your data is ephemeral" warning on every developer's machine and be ignored.
/// A leading `/` is what actually matters in the container, so check that first
/// and fall back to the platform rule (which accepts `D:\data\x.db` locally).
fn is_durable_path(path: &str) -> bool {
    path.starts_with('/') || Path::new(path).is_absolute()
}

/// Required variable: error out if missing or blank. The value is **trimmed** —
/// see [`opt_env`] for why that matters.
fn req_env(key: &str) -> Result<String, String> {
    std::env::var(key)
        .ok()
        .as_deref()
        .and_then(normalize)
        .ok_or_else(|| format!("{key} is required"))
}

/// The one place an env value's surrounding whitespace is dealt with: blank (or
/// whitespace-only) ⇒ `None`, otherwise the trimmed value.
fn normalize(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Optional variable: `None` if missing or blank.
///
/// The value is **trimmed**. This is not cosmetic: a `.env` line with a stray
/// trailing space used to survive all the way into [`parse_bool`], where
/// `"true "` matched none of the truthy spellings and quietly became `false`.
/// On `REQUIRE_MANAGE_GUILD` that silently disables the authorization gate that
/// restricts a user to servers they actually manage; on `COOKIE_SECURE` it drops
/// the `Secure` flag off the session cookie. One invisible keystroke must never
/// be able to do that.
fn opt_env(key: &str) -> Option<String> {
    std::env::var(key).ok().as_deref().and_then(normalize)
}

/// Parse an env var into `T`. Missing or blank ⇒ `default`.
///
/// A value that is *present but unparseable* is a boot error, never a silent
/// fall back to `default`: an operator who typed `RATE_LIMIT_PER_MIN=600x` asked
/// for something, and quietly running at 60 instead is worse than not booting.
fn parse_or<T: std::str::FromStr>(key: &str, default: T) -> Result<T, String> {
    parse_value(key, opt_env(key).as_deref(), default)
}

/// Pure core of [`parse_or`], split out so it is testable without mutating
/// process-global environment state. `raw` is already normalized.
fn parse_value<T: std::str::FromStr>(
    key: &str,
    raw: Option<&str>,
    default: T,
) -> Result<T, String> {
    match raw {
        None => Ok(default),
        Some(raw) => raw
            .parse::<T>()
            .map_err(|_| format!("{key} is set to an invalid value ({raw:?})")),
    }
}

/// Parse a boolean env var. Missing or blank ⇒ `default`.
///
/// Accepts `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`, any case. Anything
/// else is a boot error rather than an implicit `false` — the old behaviour made
/// every typo silently mean "off", which for the several flags that default to
/// `true` (authorization, `Secure` cookies, whole features) is a downgrade you
/// would never see in a log.
fn parse_bool(key: &str, default: bool) -> Result<bool, String> {
    bool_value(key, opt_env(key).as_deref(), default)
}

/// Pure core of [`parse_bool`]. `raw` is already normalized.
fn bool_value(key: &str, raw: Option<&str>, default: bool) -> Result<bool, String> {
    match raw {
        None => Ok(default),
        Some(raw) => match raw.to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Ok(true),
            "0" | "false" | "no" | "off" => Ok(false),
            _ => Err(format!("{key} must be a boolean (true/false), got {raw:?}")),
        },
    }
}

/// Split a comma-separated env value, trimming whitespace and dropping blanks.
fn split_list(s: &str) -> Vec<String> {
    s.split(',')
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

/// Keep the server-held relay pinned to Discord rather than accepting an
/// arbitrary configured request target. The path check also catches accidental
/// channel/message URLs without ever echoing a secret value in an error.
fn valid_feedback_webhook_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value.trim()) else {
        return false;
    };
    if url.scheme() != "https"
        || url.host_str() != Some("discord.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }

    let Some(segments) = url.path_segments() else {
        return false;
    };
    let segments: Vec<_> = segments.collect();
    matches!(segments.as_slice(), ["api", "webhooks", id, token]
        if !id.is_empty()
            && id.bytes().all(|b| b.is_ascii_digit())
            && !token.is_empty()
            && token.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')))
}

#[cfg(test)]
mod tests {
    use super::{
        bool_value, check_durable_store_paths, is_durable_path, normalize, parse_value,
        valid_feedback_webhook_url, DurableStores,
    };

    /// Only the stores a test actually cares about; the rest are "off".
    fn stores<'a>(schedule: Option<&'a str>, library: Option<&'a str>) -> DurableStores<'a> {
        DurableStores {
            shortlink: None,
            schedule,
            library,
            activity_draft: None,
            stripe: None,
        }
    }

    #[test]
    fn env_values_are_trimmed_and_blanks_are_absent() {
        assert_eq!(normalize("  true  ").as_deref(), Some("true"));
        assert_eq!(normalize("true").as_deref(), Some("true"));
        assert_eq!(normalize("   "), None);
        assert_eq!(normalize(""), None);
    }

    /// The regression that motivated trimming: a `.env` line with a trailing
    /// space used to make `REQUIRE_MANAGE_GUILD=true ` parse as **false**, which
    /// silently switched off the gate restricting users to servers they manage.
    #[test]
    fn a_trailing_space_cannot_flip_a_boolean_off() {
        let raw = normalize("true ");
        assert_eq!(
            bool_value("REQUIRE_MANAGE_GUILD", raw.as_deref(), true),
            Ok(true)
        );
    }

    #[test]
    fn booleans_accept_known_spellings_in_any_case() {
        for on in ["1", "true", "TRUE", "Yes", "on"] {
            assert_eq!(bool_value("K", Some(on), false), Ok(true), "{on}");
        }
        for off in ["0", "false", "FALSE", "No", "off"] {
            assert_eq!(bool_value("K", Some(off), true), Ok(false), "{off}");
        }
    }

    /// A typo must not silently mean "off" — that is how a `true`-by-default
    /// security flag gets disabled without a trace in the logs.
    #[test]
    fn an_unrecognized_boolean_is_a_boot_error() {
        assert!(bool_value("K", Some("flase"), true).is_err());
        assert!(bool_value("K", Some("enabled"), true).is_err());
        assert_eq!(bool_value("K", None, true), Ok(true));
    }

    /// Likewise a malformed number: running at the default while the operator
    /// believes their value took effect is worse than refusing to boot.
    #[test]
    fn an_unparseable_number_is_a_boot_error_not_a_silent_default() {
        assert!(parse_value::<u32>("RATE_LIMIT_PER_MIN", Some("600x"), 60).is_err());
        assert_eq!(parse_value("RATE_LIMIT_PER_MIN", Some("600"), 60), Ok(600));
        assert_eq!(parse_value("RATE_LIMIT_PER_MIN", None, 60), Ok(60));
    }

    /// The deployment target is a Linux container, so a leading `/` must read as
    /// durable **on every host**, including the Windows dev machine where
    /// `Path::is_absolute()` alone would say otherwise.
    #[test]
    fn posix_absolute_paths_are_durable_on_any_host() {
        assert!(is_durable_path("/data/schedules.db"));
        assert!(!is_durable_path("schedules.db"));
        assert!(!is_durable_path("./schedules.db"));
    }

    #[test]
    fn absolute_store_paths_pass_in_either_mode() {
        let s = stores(Some("/data/schedules.db"), Some("/data/library.db"));
        assert!(check_durable_store_paths(&s, false).is_ok());
        assert!(check_durable_store_paths(&s, true).is_ok());
    }

    #[test]
    fn a_relative_store_path_warns_by_default_and_fails_under_strict() {
        let s = stores(Some("schedules.db"), Some("/data/library.db"));
        assert!(check_durable_store_paths(&s, false).is_ok());

        let err = check_durable_store_paths(&s, true).unwrap_err();
        assert!(err.contains("SCHEDULE_DB_PATH"), "{err}");
        // The absolute one is durable, so it must not be named.
        assert!(!err.contains("LIBRARY_DB_PATH"), "{err}");
    }

    /// A disabled feature never opens its file, so its path cannot lose data
    /// and must not block a boot that has nothing to do with it.
    #[test]
    fn a_disabled_store_is_not_checked() {
        let s = stores(None, None);
        assert!(check_durable_store_paths(&s, true).is_ok());
    }

    #[test]
    fn feedback_webhook_is_pinned_to_discord_execute_urls() {
        assert!(valid_feedback_webhook_url(
            "https://discord.com/api/webhooks/123/abc_DEF-456"
        ));
        assert!(!valid_feedback_webhook_url(
            "https://example.com/api/webhooks/123/abc"
        ));
        assert!(!valid_feedback_webhook_url(
            "http://discord.com/api/webhooks/123/abc"
        ));
        assert!(!valid_feedback_webhook_url(
            "https://discord.com/api/webhooks/not-an-id/abc"
        ));
        assert!(!valid_feedback_webhook_url(
            "https://discord.com/api/webhooks/123/abc?wait=true"
        ));
    }
}
