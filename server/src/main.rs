//! DWEEB proxy — a read-only bridge between the browser-based embed builder and
//! Discord's REST API, gated behind Discord login.
//!
//! The builder can POST messages straight to a webhook from the browser, but a
//! webhook token can't *read* a guild's roles, channels, or custom emojis.
//! Those reads need a bot token (which must never ship to the browser), and the
//! relevant Discord endpoints don't send CORS headers. This service holds the
//! token server-side, adds CORS, and — so it's safe to run publicly — only
//! returns a server's data to a signed-in user who actually belongs to it.
//!
//! Hardening for public traffic: per-IP rate limiting, a global concurrency cap
//! on calls made under the shared bot token, short-TTL caching, and encrypted
//! (HttpOnly) session cookies.

mod activity;
mod activity_draft;
mod ai;
mod ai_usage;
mod auth;
mod avatar;
mod cache;
mod config;
mod discord;
mod entitlement;
mod error;
mod feedback;
mod library;
mod mcp;
mod ratelimit;
mod rating;
mod reconcile;
mod routes;
mod schedule;
mod schedule_rule;
mod schedule_validate;
mod schedule_worker;
mod seal;
mod session;
mod shortlink;
mod singleflight;
mod sqlite_pool;
mod stripe;
mod telemetry;
mod topgg;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::http::{header, HeaderName, HeaderValue, Method};
use axum::middleware::from_fn_with_state;
use axum::routing::{any, get, patch, post};
use axum::Router;
use axum_extra::extract::cookie::Key;
use tower_http::cors::{Any, CorsLayer};
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

use crate::avatar::{avatar_get, avatar_upload, AvatarStore};
use crate::cache::{DataCache, TtlCache};
use crate::config::Config;
use crate::discord::Discord;
use crate::ratelimit::{rate_limit, Limiter, RateLimiter};
use crate::rating::{rating_mine, rating_put, rating_summary, RatingStore};
use crate::routes::{
    bootstrap, capabilities, channels, custom_apps_add, custom_apps_list, custom_apps_remove,
    emojis, guild_activity_invite, health, list_guilds, permanent_add, permanent_list,
    permanent_reenable, permanent_remove, ready, roles, webhook_create, webhook_delete,
    webhook_modify, webhooks_list, AppState, DispatcherApi,
};
use crate::schedule::{
    schedule_create, schedule_delete, schedule_get, schedule_list, schedule_list_for_guild,
    schedule_patch, ScheduleStore,
};
use crate::shortlink::{shortlink_create, shortlink_resolve, ShortLinkStore};

/// Feedback creates a public forum post, so it gets a much tighter per-IP
/// budget than ordinary API reads. The in-memory token bucket starts at three
/// and refills one every five minutes; Redis enforces three per fixed 15-minute
/// window across replicas. The global limiter still applies as well.
const FEEDBACK_RATE_CAP: u32 = 3;
const FEEDBACK_RATE_WINDOW: Duration = Duration::from_secs(15 * 60);

/// The built-in AI chat spends real provider money per request, so it gets its
/// own strict per-IP budget on top of the global limiter and the per-user
/// pacing inside `ai.rs`. Sustained ~10/min with a small burst.
const AI_RATE_PER_MIN: u32 = 10;
const AI_RATE_BURST: u32 = 5;

/// Starting a checkout creates a Stripe Checkout Session (and resolves a
/// promotion code against Stripe when one was typed), so it gets its own per-IP
/// budget: it bounds both what we spend on Stripe's API and how fast anyone can
/// guess at promo codes. Generous for the real gesture — a buyer clicks Upgrade a
/// handful of times, retypes a code once or twice — and nowhere near enough to
/// sweep a code space. It sits on top of the global limiter, and the route is
/// already gated to managers of the server being upgraded.
const CHECKOUT_RATE_PER_MIN: u32 = 6;
const CHECKOUT_RATE_BURST: u32 = 4;

fn main() {
    // `dweeb-proxy healthcheck` is invoked by the Docker HEALTHCHECK on every
    // interval. Answer it before building any async runtime — the probe just
    // confirms the listener accepts connections, so it needs neither Tokio nor
    // curl/wget, keeping both the image and the per-probe cost tiny.
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        run_healthcheck();
    }

    // Right-size the async runtime: this proxy is I/O-bound (it mostly awaits
    // Discord), so the default of one worker per CPU just reserves idle thread
    // stacks and per-thread allocator arenas. Default to two workers — enough to
    // overlap the parallel hot-path reads — and let TOKIO_WORKER_THREADS scale
    // it without a rebuild.
    let worker_threads = std::env::var("TOKIO_WORKER_THREADS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|n| *n >= 1)
        .unwrap_or(2);
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(worker_threads)
        .enable_all()
        .build()
        .expect("failed to build Tokio runtime")
        .block_on(run());
}

async fn run() {
    // Load a local `.env` if present (for `cargo run` / running the binary
    // directly). In Docker the vars come from `env_file`, so there's no `.env`
    // in the image and this is a harmless no-op. Real environment variables
    // always win over `.env` entries.
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("configuration error: {e}");
            std::process::exit(1);
        }
    };

    let cors = build_cors(&config);
    let bind_addr = config.bind_addr.clone();

    // Choose the cache + rate-limit backend. With REDIS_URL set, both are shared
    // through Redis so multiple instances coordinate; otherwise both are
    // process-local. The connection manager is cloned into each (cheap; it's an
    // Arc internally with its own reconnection loop).
    let (cache, limiter, feedback_limiter, ai_limiter, checkout_limiter) = match &config.redis_url {
        Some(url) => {
            let conn = match connect_redis(url).await {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("redis error: {e}");
                    std::process::exit(1);
                }
            };
            tracing::info!("using Redis backend for cache + rate limiting");
            (
                DataCache::Redis {
                    conn: conn.clone(),
                    ttl_secs: config.cache_ttl.as_secs(),
                },
                Limiter::Redis {
                    conn: conn.clone(),
                    key_prefix: "",
                    // Preserve the existing Redis limiter's fixed-window cap.
                    limit: config
                        .rate_limit_per_min
                        .saturating_add(config.rate_limit_burst),
                    window_secs: 60,
                },
                Limiter::Redis {
                    conn: conn.clone(),
                    key_prefix: "feedback",
                    limit: FEEDBACK_RATE_CAP,
                    window_secs: FEEDBACK_RATE_WINDOW.as_secs(),
                },
                Limiter::Redis {
                    conn: conn.clone(),
                    key_prefix: "ai",
                    limit: AI_RATE_PER_MIN.saturating_add(AI_RATE_BURST),
                    window_secs: 60,
                },
                Limiter::Redis {
                    conn,
                    key_prefix: "checkout",
                    limit: CHECKOUT_RATE_PER_MIN.saturating_add(CHECKOUT_RATE_BURST),
                    window_secs: 60,
                },
            )
        }
        None => (
            DataCache::Memory(TtlCache::new(config.cache_ttl)),
            Limiter::Memory(RateLimiter::new(
                config.rate_limit_per_min,
                config.rate_limit_burst,
            )),
            Limiter::Memory(RateLimiter::for_window(
                FEEDBACK_RATE_CAP,
                FEEDBACK_RATE_WINDOW,
            )),
            Limiter::Memory(RateLimiter::new(AI_RATE_PER_MIN, AI_RATE_BURST)),
            Limiter::Memory(RateLimiter::new(CHECKOUT_RATE_PER_MIN, CHECKOUT_RATE_BURST)),
        ),
    };
    let limiter = Arc::new(limiter);
    let feedback_limiter = Arc::new(feedback_limiter);
    let ai_limiter = Arc::new(ai_limiter);
    let checkout_limiter = Arc::new(checkout_limiter);

    // Cookie signing + encryption key, built from the configured secret
    // (validated to be ≥64 bytes in `Config::from_env`).
    let key = Key::from(config.session_secret.as_bytes());

    // The dashboard's permanent-slot management talks to the interactions
    // dispatcher over the compose network — only when both halves of its
    // config are present.
    let dispatcher = match (&config.dispatcher_url, &config.dispatcher_token) {
        (Some(base), Some(token)) => {
            tracing::info!(upstream = %base, "permanent-slot API enabled");
            Some(Arc::new(DispatcherApi {
                base: base.clone(),
                token: token.clone(),
                http: reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(5))
                    .build()
                    .expect("reqwest client"),
            }))
        }
        _ => None,
    };

    // DWEEB's own Stripe billing (mirror + client). None when STRIPE_SECRET_KEY
    // is unset — the plan system is then inert and DWEEB runs standalone. Boot
    // fails loudly only if the mirror DB can't be opened (a deployment that
    // accepts payments must be able to record them).
    let stripe = match crate::stripe::StripeState::from_config(&config) {
        Ok(s) => s.map(Arc::new),
        Err(e) => {
            eprintln!("stripe store error: {e}");
            std::process::exit(1);
        }
    };
    if stripe.is_some() {
        tracing::info!("stripe billing enabled (DWEEB reads Stripe directly)");
    }

    // Plan entitlement reader. Inert (everyone Free, gates use store defaults)
    // until Stripe is configured, so DWEEB runs standalone. Built here so the
    // schedule worker (which spends never-expire slots at fire time) can consult
    // it too.
    let entitlements = Arc::new(crate::entitlement::Entitlement::new(
        &config,
        stripe.clone(),
    ));

    // Short links: a small SQLite file (fails the boot loudly when unwritable —
    // a deployment that promises 7-day links must be able to keep them). An
    // hourly sweep deletes expired rows; reads already filter on expiry, so a
    // link dies exactly on time either way.
    let shortlinks = if config.shortlink_ttl_days > 0 {
        match ShortLinkStore::open(
            &config.shortlink_db_path,
            config.shortlink_ttl_days,
            config.shortlink_max_entries,
        ) {
            Ok(store) => {
                tracing::info!(
                    db = %config.shortlink_db_path,
                    ttl_days = config.shortlink_ttl_days,
                    "short links enabled"
                );
                Some(Arc::new(store))
            }
            Err(e) => {
                eprintln!("short-link store error: {e}");
                std::process::exit(1);
            }
        }
    } else {
        None
    };
    // Uploaded webhook avatars. Note the asymmetry with short links above:
    // there is deliberately **no sweep task** here. Discord hot-links
    // `avatar_url` for the life of the message, so an expired row is not a dead
    // link, it is a broken image in someone's old post. Size is bounded by
    // content-addressed dedupe + a byte cap + a row cap instead (see
    // `avatar.rs`), never by deletion.
    let avatars = if config.avatar_uploads_enabled {
        match AvatarStore::open(
            &config.avatar_db_path,
            config.avatar_max_entries,
            config.avatar_max_bytes,
            config.avatar_public_base_url.clone(),
        ) {
            Ok(store) => {
                tracing::info!(
                    db = %config.avatar_db_path,
                    base = %config.avatar_public_base_url,
                    max_entries = config.avatar_max_entries,
                    "avatar uploads enabled"
                );
                Some(Arc::new(store))
            }
            Err(e) => {
                eprintln!("avatar store error: {e}");
                std::process::exit(1);
            }
        }
    } else {
        None
    };

    // First-party product ratings (see `rating.rs`). Like avatars there is no
    // sweep: a rating is something a person said about the product, and ageing
    // one out would move a published average with nobody having changed their
    // mind. Off by default — enabling it is a deliberate pair of env changes,
    // because it adds a durable store and a relative path would be destroyed on
    // the next deploy.
    let ratings = if config.ratings_enabled {
        match RatingStore::open(&config.ratings_db_path) {
            Ok(store) => {
                tracing::info!(db = %config.ratings_db_path, "product ratings enabled");
                Some(Arc::new(store))
            }
            Err(e) => {
                eprintln!("rating store error: {e}");
                std::process::exit(1);
            }
        }
    } else {
        None
    };

    if let Some(store) = &shortlinks {
        let store = Arc::clone(store);
        tokio::spawn(async move {
            // First tick fires immediately, so leftovers from before a restart
            // are reclaimed at boot.
            let mut tick = tokio::time::interval(Duration::from_secs(3600));
            loop {
                tick.tick().await;
                let s = Arc::clone(&store);
                match tokio::task::spawn_blocking(move || s.sweep()).await {
                    Ok(Ok(0)) => {}
                    Ok(Ok(n)) => tracing::info!(deleted = n, "swept expired short links"),
                    Ok(Err(e)) => tracing::warn!("short-link sweep failed: {e}"),
                    Err(e) => tracing::warn!("short-link sweep panicked: {e}"),
                }
            }
        });
    }

    // Per-server message library: a small SQLite file on the same persistent
    // volume (a saved message is a promise to keep it). Boot fails loudly if it
    // can't be opened — a deployment that accepts library entries has to be able
    // to keep them. No sweeper: drafts live until their owner deletes them
    // (bounded by the draft quota), posted history rolls over at its window,
    // and the global cap bounds the whole file. Opened before the schedule
    // worker so a fired schedule can auto-record its post here.
    let library = if config.library_enabled {
        match library::LibraryStore::open(
            &config.library_db_path,
            config.library_max_entries,
            config.library_max_per_guild,
            config.library_posted_per_guild,
        ) {
            Ok(store) => {
                tracing::info!(db = %config.library_db_path, "message library enabled");
                Some(Arc::new(store))
            }
            Err(e) => {
                eprintln!("library store error: {e}");
                std::process::exit(1);
            }
        }
    } else {
        None
    };

    // Remote MCP endpoint: registered OAuth clients + live grants. Off by
    // default — see `Config::mcp_enabled`. A store that cannot be opened is
    // fatal for the same reason the others are: booting with the feature
    // advertised but unable to remember a single grant would fail every
    // connection with an opaque error.
    let mcp_store = if config.mcp_enabled {
        match mcp::store::McpStore::open(&config.mcp_db_path, key.clone()) {
            Ok(store) => {
                tracing::info!(db = %config.mcp_db_path, "MCP endpoint enabled");
                Some(Arc::new(store))
            }
            Err(e) => {
                eprintln!("mcp store error: {e}");
                std::process::exit(1);
            }
        }
    } else {
        None
    };

    // Expired MCP authorization codes and access tokens. A code lives ten
    // minutes and a token at most a week, so nothing here is urgent — but a
    // live grant is a credential, and one that has expired should stop existing
    // rather than linger until someone happens to present it.
    if let Some(store) = &mcp_store {
        let store = Arc::clone(store);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(3600));
            loop {
                tick.tick().await;
                let s = Arc::clone(&store);
                match tokio::task::spawn_blocking(move || s.sweep()).await {
                    Ok(Ok(0)) => {}
                    Ok(Ok(n)) => tracing::info!(deleted = n, "swept expired MCP grants"),
                    Ok(Err(e)) => tracing::warn!("MCP sweep failed: {e}"),
                    Err(e) => tracing::warn!("MCP sweep panicked: {e}"),
                }
            }
        });
    }

    // Scheduled posts: a small SQLite file on the same persistent volume as the
    // short links (a schedule is a promise to post later, so it must outlive a
    // redeploy). Boot fails loudly if it can't be opened — a deployment that
    // accepts schedules has to be able to keep them. When the store is present a
    // delivery worker drains due rows on a timer (mirrors the self-role reaper).
    let schedules = if config.schedules_enabled {
        match ScheduleStore::open(
            &config.schedule_db_path,
            config.schedule_max_entries,
            config.schedule_max_per_webhook,
            config.schedule_max_per_guild,
        ) {
            Ok(store) => {
                tracing::info!(db = %config.schedule_db_path, "scheduled posts enabled");
                Some(Arc::new(store))
            }
            Err(e) => {
                eprintln!("schedule store error: {e}");
                std::process::exit(1);
            }
        }
    } else {
        None
    };
    // The scheduled-post worker is spawned *after* `AppState` is built (below):
    // a custom-bot schedule re-resolves and re-homes the bot's roaming Activity
    // webhook at fire time, which needs Discord + the dispatcher registry — i.e.
    // the whole `AppState`, not just the schedule store.

    // Persisted Activity collaboration drafts: a small SQLite file (on the same
    // persistent volume as the short links / schedules) so a collaboration room
    // can be reopened where it was left off, and survives a restart with no peers
    // online to re-seed it. Best-effort by design — if it can't be opened we log
    // and carry on with the old ephemeral behaviour rather than failing boot, so
    // an unwritable path never takes down publishing/collab. An hourly sweep
    // drops drafts nobody has touched within the retention window.
    let activity_drafts = if config.activities_enabled {
        match activity_draft::ActivityDraftStore::open(
            &config.activity_draft_db_path,
            config.activity_draft_max_entries,
        ) {
            Ok(store) => {
                tracing::info!(db = %config.activity_draft_db_path, "activity draft persistence enabled");
                Some(Arc::new(store))
            }
            Err(e) => {
                tracing::warn!("activity draft store disabled (couldn't open): {e}");
                None
            }
        }
    } else {
        None
    };
    if let Some(store) = &activity_drafts {
        // One coalescing writer seals only the newest snapshot per room and
        // commits every room ready in the window as a single transaction. This
        // keeps collaboration fan-in from becoming unbounded blocking tasks or
        // one WAL commit per connected editor.
        let writer = Arc::clone(store);
        let writer_key = key.clone();
        tokio::spawn(writer.run_writer(writer_key));

        let store = Arc::clone(store);
        let retention_secs = config.activity_draft_retention_days.max(1) * 86_400;
        tokio::spawn(async move {
            // First tick fires immediately, reclaiming leftovers from before a restart.
            let mut tick = tokio::time::interval(Duration::from_secs(3600));
            loop {
                tick.tick().await;
                let s = Arc::clone(&store);
                let now = crate::schedule::unix_now();
                match tokio::task::spawn_blocking(move || s.sweep(now, retention_secs)).await {
                    Ok(Ok(0)) => {}
                    Ok(Ok(n)) => tracing::info!(deleted = n, "swept stale activity drafts"),
                    Ok(Err(e)) => tracing::warn!("activity draft sweep failed: {e}"),
                    Err(e) => tracing::warn!("activity draft sweep panicked: {e}"),
                }
            }
        });
    }

    // Built-in AI relay: present only when GROQ_API_KEY is configured. The
    // usage ledger is a durable quota promise, so an unopenable store fails the
    // boot loudly (same stance as the schedule/library stores). A slow sweeper
    // reclaims rollup rows too old to bind any quota check.
    let ai = match ai::AiRuntime::from_config(&config) {
        Ok(runtime) => {
            if runtime.is_some() {
                // The fallback is named too: it is only reached when the
                // primary is unwell, so a decommissioned one hides until the
                // day it is needed (2026-08-16). Boot is where to notice it.
                tracing::info!(
                    db = %config.ai_db_path,
                    model = %config.ai_model,
                    fallback = %config.ai_fallback_model.as_deref().unwrap_or("none"),
                    "built-in AI relay enabled"
                );
            }
            runtime
        }
        Err(e) => {
            eprintln!("ai usage store error: {e}");
            std::process::exit(1);
        }
    };
    if let Some(runtime) = &ai {
        let store = Arc::clone(&runtime.store);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(6 * 3600));
            loop {
                tick.tick().await;
                let s = Arc::clone(&store);
                let (day_cutoff, month_cutoff) =
                    crate::ai_usage::sweep_cutoffs(crate::schedule::unix_now());
                match tokio::task::spawn_blocking(move || s.sweep(&day_cutoff, &month_cutoff)).await
                {
                    Ok(Ok(0)) => {}
                    Ok(Ok(n)) => tracing::info!(deleted = n, "swept old AI usage rollups"),
                    Ok(Err(e)) => tracing::warn!("ai usage sweep failed: {e}"),
                    Err(e) => tracing::warn!("ai usage sweep panicked: {e}"),
                }
            }
        });
    }

    let state = AppState {
        discord: Arc::new(Discord::new(
            config.bot_token.clone(),
            config.discord_max_concurrency,
        )),
        cache: Arc::new(cache),
        flight: Arc::new(crate::singleflight::SingleFlight::new()),
        dispatcher,
        shortlinks,
        avatars,
        ratings,
        schedules,
        activity_rooms: Arc::new(crate::activity::ActivityRooms::new()),
        activity_tickets: Arc::new(crate::activity::ActivityTickets::new()),
        activity_drafts,
        activity_uploads: Arc::new(tokio::sync::Semaphore::new(
            config.activity_upload_concurrency,
        )),
        library,
        mcp: mcp_store,
        entitlements,
        stripe,
        ai,
        key,
        config: Arc::new(config),
    };

    // Read off the state's `Arc<Config>` — `config` itself has moved into it,
    // and the router below is built after that move.
    let avatar_body_limit = state.config.avatar_max_bytes + 4 * 1024;

    // Now that `AppState` exists, start the scheduled-post delivery worker. It
    // holds a clone of the state so a fired custom-bot schedule can re-resolve and
    // re-home the bot's roaming webhook to the destination channel before posting
    // (a DWEEB schedule just posts to its channel-bound sealed URL).
    if state.schedules.is_some() {
        // A dedicated client with a modest timeout: the worker is off the 3s
        // interaction budget, but a hung POST mustn't hold a row's lease.
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent(concat!(
                "dweeb-proxy-scheduler/",
                env!("CARGO_PKG_VERSION"),
                " (+https://github.com/FaizoKen/DWEEB)"
            ))
            .build()
            .expect("failed to build scheduler HTTP client");
        schedule_worker::spawn(
            state.clone(),
            http,
            state.config.scheduler_tick_secs,
            state.config.scheduler_lease_secs,
            state.config.scheduler_batch,
            state.config.schedule_retention_days,
        );
    }

    // Public Top.gg listing: push the bot's server count on a timer so the page
    // doesn't drift away from reality. Inert without `TOPGG_TOKEN`, and every
    // failure it can hit is deliberately quiet — see `topgg.rs`.
    topgg::spawn(state.clone());

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/capabilities", get(capabilities))
        // ── Remote MCP endpoint (see `mcp/` and docs/mcp.md) ──────────────
        //
        // Off unless `MCP_ENABLED`; every handler answers 501 otherwise. The
        // two well-known documents are how a client that knows only the `/mcp`
        // URL discovers where to authorize — they are unauthenticated by
        // necessity, and carry no secret.
        .route(
            "/.well-known/oauth-protected-resource",
            get(mcp::oauth::protected_resource),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(mcp::oauth::authorization_server),
        )
        .route("/oauth/authorize", get(mcp::oauth::authorize))
        .route(
            "/oauth/register",
            post(mcp::oauth::register).layer(axum::extract::DefaultBodyLimit::max(16 * 1024)),
        )
        .route("/oauth/token", post(mcp::oauth::token))
        // The MCP endpoint itself. Bearer-authenticated inside the handler so
        // an unauthenticated call can answer with the `WWW-Authenticate` header
        // that bootstraps discovery. The body limit is generous enough for a
        // maxed-out Components V2 message and nothing like an upload.
        .route(
            "/mcp",
            post(mcp::protocol::endpoint)
                .get(mcp::protocol::endpoint_unsupported)
                .delete(mcp::protocol::endpoint_unsupported)
                .layer(axum::extract::DefaultBodyLimit::max(256 * 1024)),
        )
        // Readiness: verifies each present SQLite store answers a `SELECT 1`, so
        // a monitor can distinguish "up" from "a data volume is wedged". 503 (with
        // the failing store) when a probe fails; see `routes::ready`.
        .route("/ready", get(ready))
        // Auth
        .route("/auth/login", get(auth::login))
        .route("/auth/callback", get(auth::callback))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/me", get(auth::me))
        // Webhook creation via Discord's `webhook.incoming` OAuth (no bot perms).
        .route("/auth/webhook", get(auth::webhook_start))
        // Opt-in share short links (anonymous; rate-limited + validated). The
        // tight body limit keeps the create endpoint from accepting anything
        // beyond a share token, well before JSON parsing.
        .route(
            "/api/shortlink",
            post(shortlink_create).layer(axum::extract::DefaultBodyLimit::max(64 * 1024)),
        )
        .route("/api/shortlink/:id", get(shortlink_resolve))
        // Uploaded webhook avatars (see `avatar.rs`). Discord hot-links
        // `avatar_url`, so these bytes must be publicly fetchable and must stay
        // reachable for as long as the message exists.
        //
        // The upload is session-gated in the handler (an open endpoint would be
        // a free image host) and takes raw image bytes, so the body limit is the
        // configured per-image cap plus a little slack for headers. The GET is
        // deliberately anonymous: Discord's image fetcher sends no credential,
        // and neither does an `<img>` tag in the preview.
        .route(
            "/api/avatar",
            post(avatar_upload).layer(axum::extract::DefaultBodyLimit::max(avatar_body_limit)),
        )
        .route("/api/avatar/:file", get(avatar_get))
        // First-party product ratings (see `rating.rs`) — what the generated
        // pages publish as `aggregateRating`. The write is identity-gated and
        // keyed on the Discord user id, so one person holds one rating no
        // matter how often they submit; that, not a rate limit, is what makes
        // the published average defensible, and it is why these routes need no
        // dedicated limiter the way `/api/stripe/checkout` does (a call here
        // costs nothing outside our own SQLite). The summary is anonymous
        // because the build fetches it with no credential and prints it.
        .route(
            "/api/rating",
            post(rating_put)
                .get(rating_summary)
                .layer(axum::extract::DefaultBodyLimit::max(1024)),
        )
        .route("/api/rating/me", get(rating_mine))
        // Frontend crash telemetry: the browser's global error handlers beacon a
        // content-free crash report (message, a few stack frames, version, URL
        // path — never the `#hash` payload) so runtime errors in the wild are
        // visible in the proxy logs. Unauthenticated by necessity (a crash can
        // precede login) and bounded tight in the handler (see `telemetry`).
        .route(
            "/api/telemetry/crash",
            post(telemetry::crash_report).layer(axum::extract::DefaultBodyLimit::max(4 * 1024)),
        )
        // Anonymous feedback relay. The browser sends only category, summary,
        // details, and optional contact; the handler constructs the Discord
        // payload and owns the destination credential. A route-local limiter is
        // deliberately much tighter than the global API budget.
        .route(
            "/api/feedback",
            post(feedback::web_feedback)
                // 8 KiB covers the allowed character counts even when every
                // character occupies four UTF-8 bytes, while remaining tight.
                .layer(axum::extract::DefaultBodyLimit::max(8 * 1024))
                .layer(from_fn_with_state(feedback_limiter.clone(), rate_limit)),
        )
        // Scheduled posts (opt-in; webhook + payload sealed at rest, fired by a
        // background worker). Create/list need only an optional session; per-row
        // management is authorized by a manage token or the owning account. The
        // body limit keeps the create/patch endpoints bounded well before JSON
        // parsing (a maxed-out message plus envelope fits comfortably).
        .route(
            "/api/schedules",
            get(schedule_list)
                .post(schedule_create)
                .layer(axum::extract::DefaultBodyLimit::max(128 * 1024)),
        )
        .route(
            "/api/schedules/:id",
            get(schedule_get)
                .patch(schedule_patch)
                .delete(schedule_delete)
                .layer(axum::extract::DefaultBodyLimit::max(128 * 1024)),
        )
        // Every schedule for a server (login + Manage Webhooks gated) — the
        // "view all scheduled posts for this server" list.
        .route(
            "/api/guilds/:guild_id/schedules",
            get(schedule_list_for_guild),
        )
        // Per-server message library (Manage Webhooks gated, cookie OR Activity
        // bearer): the shared shelf of posted messages + saved drafts both the
        // web app and the embedded Activity read. The body limit matches the
        // schedule endpoints — a maxed-out message plus envelope fits well within.
        .route(
            "/api/guilds/:guild_id/library",
            get(library::library_list)
                .post(library::library_create)
                .layer(axum::extract::DefaultBodyLimit::max(128 * 1024)),
        )
        // Metadata-first galleries hydrate only the visible card page. Keep the
        // id envelope tight; response payloads retain the normal message limit.
        .route(
            "/api/guilds/:guild_id/library/entries",
            post(library::library_entries).layer(axum::extract::DefaultBodyLimit::max(8 * 1024)),
        )
        .route(
            "/api/guilds/:guild_id/library/origin/:message_id",
            get(library::library_origin),
        )
        .route(
            "/api/guilds/:guild_id/library/:id",
            patch(library::library_patch)
                .delete(library::library_delete)
                .layer(axum::extract::DefaultBodyLimit::max(128 * 1024)),
        )
        // Embedded Discord Activity: SDK token exchange, server-side publish,
        // and the real-time collaboration room (see `activity.rs`). The token +
        // post bodies are bounded well before JSON parsing; the room is a WS.
        // Post/edit take a bigger body than the other JSON routes because they
        // may arrive as multipart carrying the message's uploaded files (the
        // proxy forwards them to Discord): 32 MiB covers Discord's 10 MiB base
        // per-file limit with room for several images, while still bounding
        // what one request can make the proxy buffer.
        .route(
            "/api/activity/token",
            post(activity::activity_token).layer(axum::extract::DefaultBodyLimit::max(8 * 1024)),
        )
        // NB: `/api/activity/post` and `/api/activity/edit` (the 32 MiB upload
        // routes) live in `untimed_routes` below — they're deliberately exempt
        // from the global request timeout so a slow client uploading a large
        // attachment isn't cut off mid-transfer.
        // Schedule the built message to post later (one-time). The proxy resolves
        // the DWEEB webhook server-side (the iframe never sees credentials) and
        // stores the schedule sealed until it fires — same store/worker/quota as
        // the web's /api/schedules. Bearer-gated like /post, body bounded like it.
        .route(
            "/api/activity/schedule",
            post(activity::activity_schedule)
                .layer(axum::extract::DefaultBodyLimit::max(128 * 1024)),
        )
        // Restore: pull a message DWEEB posted in the channel back into the editor.
        // The body is just three ids, so it's bounded tight like the token call.
        .route(
            "/api/activity/restore",
            post(activity::activity_restore).layer(axum::extract::DefaultBodyLimit::max(8 * 1024)),
        )
        // Posting identities for the destination guild — DWEEB plus registered
        // custom bots and their connect state — so the pre-post confirm can
        // offer "Post as". Bearer-gated read, same Manage-Webhooks gate as post.
        .route(
            "/api/activity/identities",
            get(activity::activity_identities),
        )
        // Mint the authorize URL for the one-time "connect your bot" flow (an
        // app-owned webhook the Activity then posts through). The body is two
        // ids, so it's bounded tight like the token call.
        .route(
            "/api/activity/connect-bot",
            post(activity::activity_connect_bot)
                .layer(axum::extract::DefaultBodyLimit::max(8 * 1024)),
        )
        // Never-expire slots for the destination guild: the read feeds the
        // pre-post confirm's toggle and the gallery's pin chips; add/remove let
        // the gallery assign & free slots on posted cards, like the web one.
        // All bearer-gated (the cookie-only guild endpoints can't serve the
        // Activity), Manage-Webhooks in the guild required.
        .route(
            "/api/activity/permanent",
            get(activity::activity_permanent)
                .post(activity::activity_permanent_add)
                .delete(activity::activity_permanent_remove),
        )
        // The destination server's tier + limits, for the Activity's quiet plan
        // indicator. Bearer-gated read (membership only — display-only data).
        .route("/api/activity/plan", get(activity::activity_plan))
        // Mint the single-use ticket the room WebSocket connects with — an
        // authenticated POST, so the socket URL never carries the access token.
        .route(
            "/api/activity/room-ticket",
            post(activity::activity_room_ticket),
        )
        // NB: the room WebSocket `/api/activity/room/:instance` lives in
        // `untimed_routes` below — a persistent socket must not be bounded by the
        // global request timeout.
        // Image proxy: fetches an external image/video so the sandboxed Activity
        // iframe (whose CSP blocks arbitrary `<img>`/`<video>` hosts) can render
        // it. Unauthenticated by necessity — an `<img>` can't carry a bearer — but
        // bounded hard (public hosts only, size + time caps) in the handler.
        .route("/api/activity/image", get(activity::activity_image))
        // Handshake telemetry: the browser beacons each launch stage so a stalled
        // in-Discord launch (which has no reachable console) is visible in the
        // proxy logs. Unauthenticated by necessity — a stall can precede the token
        // — and bounded tight in the handler (see `activity_telemetry`).
        .route(
            "/api/activity/telemetry",
            post(activity::activity_telemetry)
                .layer(axum::extract::DefaultBodyLimit::max(2 * 1024)),
        )
        // Activity feedback uses the same closed report schema and server-held
        // destination as the web route, then adds the verified Discord sender.
        // It remains bearer-gated and shares the strict feedback-only limiter.
        .route(
            "/api/activity/feedback",
            post(feedback::activity_feedback)
                .layer(axum::extract::DefaultBodyLimit::max(8 * 1024))
                .layer(from_fn_with_state(feedback_limiter, rate_limit)),
        )
        // DWEEB's own Stripe billing (per-server, MEE6/Dyno-style). Start an
        // embedded Checkout bound to a server, list the user's premium servers,
        // move a subscription between servers, open the billing portal, and
        // receive Stripe webhooks. All but the webhook are cookie-gated; the
        // webhook is signature-verified. The webhook body is bounded but roomy
        // (Stripe events can carry a fair bit); the JSON bodies are tiny.
        // Checkout also carries its own per-IP limiter: each call creates a Stripe
        // session, and one that names a promotion code resolves it against Stripe
        // (see `CHECKOUT_RATE_PER_MIN`).
        .route(
            "/api/stripe/checkout",
            post(stripe::checkout)
                .layer(axum::extract::DefaultBodyLimit::max(4 * 1024))
                .layer(from_fn_with_state(checkout_limiter, rate_limit)),
        )
        .route(
            "/api/stripe/sync",
            post(stripe::sync).layer(axum::extract::DefaultBodyLimit::max(4 * 1024)),
        )
        .route("/api/stripe/subscriptions", get(stripe::subscriptions))
        .route(
            "/api/stripe/reassign",
            post(stripe::reassign).layer(axum::extract::DefaultBodyLimit::max(4 * 1024)),
        )
        .route("/api/stripe/portal", post(stripe::portal))
        .route(
            "/api/stripe/webhook",
            post(stripe::webhook).layer(axum::extract::DefaultBodyLimit::max(256 * 1024)),
        )
        // Built-in AI (server-held Groq key; see `ai.rs`). The chat relay is
        // cookie-gated and layered: a strict route-local per-IP limiter here,
        // then per-user pacing / single-flight / daily quotas / the monthly
        // budget inside the handler. The body is data-only (message JSON +
        // transcript) and bounded like the other message-carrying routes. The
        // TimeoutLayer above only bounds time-to-headers, so the streamed SSE
        // body is unaffected (it has its own deadline in the relay task).
        .route(
            "/api/ai/chat",
            post(ai::ai_chat)
                .layer(axum::extract::DefaultBodyLimit::max(128 * 1024))
                .layer(from_fn_with_state(ai_limiter, rate_limit)),
        )
        // The signed-in user's remaining daily allowance, for the panel meter.
        .route("/api/ai/usage", get(ai::ai_usage_summary))
        // Guild data (login + membership gated)
        .route("/api/guilds", get(list_guilds))
        .route("/api/guilds/:guild_id/roles", get(roles))
        .route("/api/guilds/:guild_id/channels", get(channels))
        .route("/api/guilds/:guild_id/emojis", get(emojis))
        .route("/api/guilds/:guild_id/bootstrap", get(bootstrap))
        // A server's plan: its tier + per-tier limits + whether billing is
        // available, for the FE's per-server pricing surface. Membership-gated;
        // fails open to Free.
        .route("/api/guilds/:guild_id/plan", get(entitlement::guild_plan))
        // Permanent component slots (login + Manage Server gated, relayed to
        // the interactions dispatcher which owns them).
        .route(
            "/api/guilds/:guild_id/permanent",
            get(permanent_list).post(permanent_add),
        )
        .route(
            "/api/guilds/:guild_id/permanent/:message_id",
            axum::routing::delete(permanent_remove),
        )
        // Service-to-service: the interactions dispatcher asks us to revive the
        // components its TTL gate disabled, once a message is made never-expire
        // from its "Message Info" button. Gated by the shared dispatcher token,
        // not a user session (see `permanent_reenable`).
        .route("/internal/permanent/reenable", post(permanent_reenable))
        // Webhook management (login + Manage Webhooks gated) — powers the
        // Send/Restore picker. Enumerate every webhook in a server (with recover
        // URLs + creators), create one in a channel, and rename / move / delete
        // one inline, through the bot's MANAGE_WEBHOOKS.
        .route("/api/guilds/:guild_id/webhooks", get(webhooks_list))
        .route(
            "/api/guilds/:guild_id/channels/:channel_id/webhooks",
            post(webhook_create),
        )
        .route(
            "/api/guilds/:guild_id/webhooks/:webhook_id",
            patch(webhook_modify).delete(webhook_delete),
        )
        // Collaboration links (login + membership gated): mint a Discord Activity
        // invite for a voice channel so `discord.gg/…` launches DWEEB there and a
        // group co-edits in one shared instance. Powers "Collaborate in Discord".
        .route(
            "/api/guilds/:guild_id/activity-invite",
            post(guild_activity_invite),
        )
        // Custom bots: a guild's own Discord apps served by the dispatcher
        // (login + Manage Server gated, relayed to the dispatcher's registry).
        .route(
            "/api/guilds/:guild_id/custom-apps",
            get(custom_apps_list).post(custom_apps_add),
        )
        .route(
            "/api/guilds/:guild_id/custom-apps/:application_id",
            axum::routing::delete(custom_apps_remove),
        )
        // Start the `webhook.incoming` OAuth flow under one of the guild's
        // registered custom bots, using its stored (sealed) client secret.
        .route(
            "/api/guilds/:guild_id/custom-apps/:application_id/webhook",
            post(auth::custom_bot_webhook_start),
        )
        // Unroutable paths answer 404 *after* draining the request body (see
        // `not_found`). Registered here, before the layers below, because
        // `Router::layer` only wraps the routes and fallback added above it —
        // the fallback needs the timeout backstop, CORS, and rate limiting like
        // any other route.
        .fallback(not_found)
        // Global request timeout: a backstop that bounds any single request so a
        // handler wedged on a stuck store lock or a hung upstream returns 408
        // instead of pinning a connection forever (outbound Discord calls and DB
        // access are already individually bounded; this catches the residue). It
        // wraps every route added *above*; the WebSocket and the two 32 MiB
        // upload routes are merged *after* it (see `untimed_routes`) so a
        // persistent socket / slow large upload is never cut off.
        .layer(TimeoutLayer::new(REQUEST_TIMEOUT))
        .merge(untimed_routes())
        .layer(cors)
        // The Activity plugin proxy is merged *after* the credentialed CORS layer
        // so it isn't wrapped by it: the sandboxed plugin iframe calls it from an
        // opaque ("null") origin with no cookies, which a credentialed allow-list
        // can't permit. It carries its own permissive, credential-free CORS
        // instead (see `activity_plugin_routes`). Rate-limit + tracing below still
        // wrap it.
        .merge(activity_plugin_routes())
        // Rate limiting runs outermost so rejected requests never touch a handler.
        .layer(from_fn_with_state(limiter, rate_limit))
        .layer(TraceLayer::new_for_http().make_span_with(request_span))
        .with_state(state);

    let listener = match tokio::net::TcpListener::bind(&bind_addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("could not bind {bind_addr}: {e}");
            std::process::exit(1);
        }
    };

    tracing::info!("dweeb-proxy listening on {bind_addr}");

    // `connect_info` makes the socket peer address available to the rate limiter
    // as a fallback when no forwarding header is present.
    let service = app.into_make_service_with_connect_info::<SocketAddr>();
    if let Err(e) = axum::serve(listener, service)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        eprintln!("server error: {e}");
        std::process::exit(1);
    }
}

/// Open a Redis connection manager (auto-reconnecting) from a URL, verifying
/// connectivity up-front so a misconfigured `REDIS_URL` fails loudly at boot
/// rather than hanging. `ConnectionManager::new` retries the initial connection
/// persistently, so we bound the whole attempt with a timeout and confirm it
/// with a `PING`.
async fn connect_redis(url: &str) -> Result<redis::aio::ConnectionManager, String> {
    let client = redis::Client::open(url).map_err(|e| format!("invalid REDIS_URL: {e}"))?;
    let connect = async {
        let mut conn = redis::aio::ConnectionManager::new(client)
            .await
            .map_err(|e| format!("could not connect to Redis: {e}"))?;
        redis::cmd("PING")
            .query_async::<()>(&mut conn)
            .await
            .map_err(|e| format!("Redis PING failed: {e}"))?;
        Ok::<_, String>(conn)
    };
    match tokio::time::timeout(std::time::Duration::from_secs(5), connect).await {
        Ok(res) => res,
        Err(_) => Err("timed out connecting to Redis (is REDIS_URL reachable?)".to_string()),
    }
}

/// Routes for the Activity plugin proxy, with their own permissive (credential-
/// free) CORS so the sandboxed, opaque-origin plugin iframe can call them.
///
/// The page loader (`/api/activity/plugin`) is fetched as the iframe's `src` and
/// the relay (`/api/activity/plugin-fetch`) by the page's rewritten `fetch`/XHR —
/// both from an opaque origin that sends `Origin: null` and no cookies, which the
/// main credentialed CORS allow-list can't accept. `Any` origin/methods/headers
/// answers the JSON preflight and returns `Access-Control-Allow-Origin: *` (valid
/// for these non-credentialed calls). Auth/SSRF/size bounds live in the handlers.
/// Backstop for a single request's total time (see the `TimeoutLayer` in
/// `main`). Generous on purpose: it exists to unstick a wedged handler, not to
/// enforce a latency SLA, so it clears the slowest legitimate path (a handler
/// making several sequential Discord calls, each already capped by the reqwest
/// client) with headroom.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// The tracing span every request runs inside, so a failure says *which* request
/// failed.
///
/// `TraceLayer::new_for_http()`'s stock span is built by `DefaultMakeSpan`, which
/// records method and URI — at **DEBUG**. The deployed filter is `info`, so that
/// span is disabled and its fields never reach the log, leaving `on_failure` to
/// report a bare `response failed classification=Status code: 502 Bad Gateway
/// latency=10002 ms`. That is the whole alert: no method, no route, no reason. A
/// 502 on 2026-08-11 could not be attributed to a handler even with the journal
/// in hand, because two unrelated subsystems have ten-second deadlines. Naming the
/// route is what makes the next one a five-second triage.
///
/// **Path only — never the query.** These lines are forwarded to Discord by
/// `dweeb-alerts`, and query strings carry OAuth `code`s, Stripe identifiers, and
/// pasted third-party URLs. `Uri::path()` excludes all of it, and no route embeds
/// a credential in its path (ids only — webhook *tokens* are never routed).
///
/// `error` starts empty and is filled in by `AppError::into_response` for 5xx, so
/// the reason lands on the same line as the classification.
fn request_span(req: &axum::http::Request<axum::body::Body>) -> tracing::Span {
    tracing::info_span!(
        "http",
        method = %req.method(),
        path = %req.uri().path(),
        error = tracing::field::Empty,
    )
}

/// Fallback for a path this service doesn't route: 404 — but only *after* the
/// request body has been read and dropped.
///
/// The drain is the entire point. Axum's default fallback answers without
/// touching the body, so hyper can't reuse the connection and closes it; Caddy,
/// still streaming that body upstream, sees the close as `write: broken pipe`,
/// throws our 404 away, and synthesises a **502** for the client. Caddy logs
/// that at ERROR, and ERROR is the paging channel (`dweeb-alerts`) — so every
/// internet vulnerability scanner that POSTs a body at a path we don't serve
/// (`POST /lib/vendor/phpunit/…`, `POST /`) paged the maintainer over a request
/// we had already answered correctly. Same rule as a plugin's `ConnectError`
/// mapping: a status code is an alerting decision, and this was never our fault.
///
/// Reading the body first keeps the connection reusable, so the honest 404
/// reaches the client and nothing is logged anywhere. Buffering via `Bytes`
/// rather than streaming the drain is deliberate: it's bounded by the ambient
/// `DefaultBodyLimit`, and a body past that limit is one we *want* to hang up on
/// instead of read to the end.
async fn not_found(_drained: axum::body::Bytes) -> impl axum::response::IntoResponse {
    (axum::http::StatusCode::NOT_FOUND, "Not found")
}

/// Routes deliberately exempt from the global request timeout, merged into the
/// app *after* the `TimeoutLayer`: the collaboration room WebSocket (a
/// persistent socket, not a request/response) and the two 32 MiB upload routes
/// (a slow client legitimately spends a while streaming a large attachment). All
/// three still get CORS, rate-limiting, and tracing, which are applied after the
/// merge in `main`.
fn untimed_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/activity/post",
            post(activity::activity_post)
                .layer(axum::extract::DefaultBodyLimit::max(32 * 1024 * 1024)),
        )
        .route(
            "/api/activity/edit",
            post(activity::activity_edit)
                .layer(axum::extract::DefaultBodyLimit::max(32 * 1024 * 1024)),
        )
        .route("/api/activity/room/:instance", get(activity::activity_room))
}

fn activity_plugin_routes() -> Router<AppState> {
    let cors = CorsLayer::new()
        .allow_methods(Any)
        .allow_headers(Any)
        .allow_origin(Any);
    Router::new()
        .route("/api/activity/plugin", get(activity::activity_plugin_frame))
        .route(
            "/api/activity/plugin-fetch",
            any(activity::activity_plugin_fetch)
                .layer(axum::extract::DefaultBodyLimit::max(256 * 1024)),
        )
        .layer(cors)
}

/// Build the CORS layer: explicit origins (credentialed requests forbid `*`),
/// GET + POST, allowing cookies to flow.
fn build_cors(config: &Config) -> CorsLayer {
    let origins: Vec<HeaderValue> = config
        .allowed_origins
        .0
        .iter()
        .filter_map(|o| o.parse().ok())
        .collect();

    CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE])
        // `x-manage-token` is the per-schedule capability the builder sends when
        // loading/canceling a scheduled post; without it here the preflight fails
        // and those calls read as "couldn't reach the service".
        .allow_headers([
            header::CONTENT_TYPE,
            // The embedded Activity authenticates with a bearer token rather than
            // the session cookie (its iframe is third-party), so direct
            // cross-origin calls must be allowed to send it.
            header::AUTHORIZATION,
            HeaderName::from_static("x-manage-token"),
        ])
        .allow_credentials(true)
        .allow_origin(origins)
}

/// Healthcheck subcommand: succeed (exit 0) if the listen port accepts a TCP
/// connection, fail (exit 1) otherwise.
fn run_healthcheck() -> ! {
    let addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let port = addr.rsplit(':').next().unwrap_or("8080");
    match std::net::TcpStream::connect(format!("127.0.0.1:{port}")) {
        Ok(_) => std::process::exit(0),
        Err(_) => std::process::exit(1),
    }
}

/// Resolve when the process receives Ctrl-C or (on Unix) SIGTERM, so Docker
/// `stop` shuts the server down cleanly.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::body::{Body, Bytes};
    use axum::handler::Handler;
    use axum::http::{Request, StatusCode};
    use axum::response::IntoResponse;

    /// A 502 pages. It has to say what failed.
    ///
    /// On 2026-08-11 one arrived reading, in full, `response failed
    /// classification=Status code: 502 Bad Gateway latency=10002 ms` — no method,
    /// no route, no reason. Two unrelated subsystems have ten-second deadlines, so
    /// it could not be attributed even with the journal in hand. The span supplies
    /// the first two and `AppError` records the third.
    ///
    /// And the query string must stay out of it: these lines go to Discord via
    /// `dweeb-alerts`, and `/auth/callback?code=…` carries a live OAuth code.
    #[test]
    fn a_paging_failure_names_the_route_and_reason_but_never_the_query() {
        use std::io::Write;
        use std::sync::Mutex;
        use tracing_subscriber::fmt::MakeWriter;

        #[derive(Clone, Default)]
        struct Capture(Arc<Mutex<Vec<u8>>>);
        impl Write for Capture {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl<'a> MakeWriter<'a> for Capture {
            type Writer = Capture;
            fn make_writer(&'a self) -> Self::Writer {
                self.clone()
            }
        }

        let capture = Capture::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(capture.clone())
            .with_ansi(false)
            .finish();

        tracing::subscriber::with_default(subscriber, || {
            let req = Request::builder()
                .method("POST")
                .uri("/auth/callback?code=live-oauth-code-do-not-log")
                .body(Body::empty())
                .expect("request");
            let span = request_span(&req);
            let _entered = span.enter();
            // A handler failing, exactly as axum converts it…
            let _ = crate::error::AppError::BadGateway(
                "could not reach Discord: operation timed out".into(),
            )
            .into_response();
            // …and `tower_http`'s failure line, emitted inside the same span.
            tracing::error!("response failed");
        });

        let logged = String::from_utf8(capture.0.lock().unwrap().clone()).expect("utf-8");
        assert!(logged.contains("method=POST"), "no method in: {logged}");
        assert!(
            logged.contains("path=/auth/callback"),
            "no route in: {logged}"
        );
        assert!(
            logged.contains("operation timed out"),
            "no reason in: {logged}"
        );
        assert!(
            !logged.contains("live-oauth-code-do-not-log"),
            "the query string reached the log (and Discord): {logged}"
        );
    }

    /// A 4xx is the caller's problem and is often high-volume, so it must not
    /// smuggle its message onto the span — that field exists to explain a page.
    #[test]
    fn a_client_error_records_no_reason() {
        use std::io::Write;
        use std::sync::Mutex;
        use tracing_subscriber::fmt::MakeWriter;

        #[derive(Clone, Default)]
        struct Capture(Arc<Mutex<Vec<u8>>>);
        impl Write for Capture {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl<'a> MakeWriter<'a> for Capture {
            type Writer = Capture;
            fn make_writer(&'a self) -> Self::Writer {
                self.clone()
            }
        }

        let capture = Capture::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(capture.clone())
            .with_ansi(false)
            .finish();

        tracing::subscriber::with_default(subscriber, || {
            let req = Request::builder()
                .method("GET")
                .uri("/api/activity/image")
                .body(Body::empty())
                .expect("request");
            let span = request_span(&req);
            let _entered = span.enter();
            let _ = crate::error::AppError::Status {
                status: StatusCode::BAD_REQUEST,
                message: "that URL returned 404".into(),
                retry_after: None,
            }
            .into_response();
            tracing::error!("still logging in this span");
        });

        let logged = String::from_utf8(capture.0.lock().unwrap().clone()).expect("utf-8");
        assert!(
            !logged.contains("that URL returned 404"),
            "a 4xx recorded itself as a failure reason: {logged}"
        );
    }

    /// The 404 fallback must READ the request body, not just answer.
    ///
    /// Answering without reading forces hyper to close the connection, which
    /// Caddy reports as `write: broken pipe`, converts into a 502, and logs at
    /// ERROR — i.e. it pages, for a scanner request we answered correctly. If
    /// someone "simplifies" `not_found` to take no extractor, this fails.
    #[tokio::test]
    async fn fallback_drains_the_request_body() {
        let read = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&read);
        let chunks = tokio_stream::iter(vec![
            Ok::<Bytes, std::io::Error>(Bytes::from_static(b"<?php ")),
            Ok(Bytes::from_static(b"eval($_POST[0]);")),
        ]);
        let counted = tokio_stream::StreamExt::map(chunks, move |chunk| {
            if let Ok(bytes) = &chunk {
                counter.fetch_add(bytes.len(), Ordering::SeqCst);
            }
            chunk
        });

        let request = Request::builder()
            .method("POST")
            .uri("/lib/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php")
            .body(Body::from_stream(counted))
            .expect("build request");

        let response = not_found.call(request, ()).await;

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            read.load(Ordering::SeqCst),
            22,
            "the fallback must consume the whole body before responding"
        );
    }
}
