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
mod auth;
mod cache;
mod config;
mod discord;
mod error;
mod ratelimit;
mod routes;
mod schedule;
mod schedule_rule;
mod schedule_validate;
mod schedule_worker;
mod seal;
mod session;
mod shortlink;
mod singleflight;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::http::{header, HeaderName, HeaderValue, Method};
use axum::middleware::from_fn_with_state;
use axum::routing::{any, get, patch, post};
use axum::Router;
use axum_extra::extract::cookie::Key;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

use crate::cache::{DataCache, TtlCache};
use crate::config::Config;
use crate::discord::Discord;
use crate::ratelimit::{rate_limit, Limiter, RateLimiter};
use crate::routes::{
    bootstrap, channels, custom_apps_add, custom_apps_list, custom_apps_remove, emojis, health,
    list_guilds, permanent_add, permanent_list, permanent_reenable, permanent_remove, roles,
    webhook_create, webhook_delete, webhook_modify, webhooks_list, AppState, DispatcherApi,
};
use crate::schedule::{
    schedule_create, schedule_delete, schedule_get, schedule_list, schedule_list_for_guild,
    schedule_patch, ScheduleStore,
};
use crate::shortlink::{shortlink_create, shortlink_resolve, ShortLinkStore};

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
    let (cache, limiter) = match &config.redis_url {
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
                    conn,
                    per_min: config.rate_limit_per_min,
                    burst: config.rate_limit_burst,
                },
            )
        }
        None => (
            DataCache::Memory(TtlCache::new(config.cache_ttl)),
            Limiter::Memory(RateLimiter::new(
                config.rate_limit_per_min,
                config.rate_limit_burst,
            )),
        ),
    };
    let limiter = Arc::new(limiter);

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
    if let Some(store) = &schedules {
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
            Arc::clone(store),
            key.clone(),
            http,
            // The permanent-slot relay, so a `make_permanent` schedule can keep
            // its components alive when it fires (None → it just posts normally).
            dispatcher.clone(),
            config.scheduler_tick_secs,
            config.scheduler_lease_secs,
            config.scheduler_batch,
            config.schedule_retention_days,
        );
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
        schedules,
        activity_rooms: Arc::new(crate::activity::ActivityRooms::new()),
        key,
        config: Arc::new(config),
    };

    let app = Router::new()
        .route("/health", get(health))
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
        // Embedded Discord Activity: SDK token exchange, server-side publish,
        // and the real-time collaboration room (see `activity.rs`). The token +
        // post bodies are bounded well before JSON parsing; the room is a WS.
        .route(
            "/api/activity/token",
            post(activity::activity_token).layer(axum::extract::DefaultBodyLimit::max(8 * 1024)),
        )
        .route(
            "/api/activity/post",
            post(activity::activity_post).layer(axum::extract::DefaultBodyLimit::max(128 * 1024)),
        )
        .route(
            "/api/activity/edit",
            post(activity::activity_edit).layer(axum::extract::DefaultBodyLimit::max(128 * 1024)),
        )
        // Restore: pull a message DWEEB posted in the channel back into the editor.
        // The body is just three ids, so it's bounded tight like the token call.
        .route(
            "/api/activity/restore",
            post(activity::activity_restore).layer(axum::extract::DefaultBodyLimit::max(8 * 1024)),
        )
        .route("/api/activity/room/:instance", get(activity::activity_room))
        // Image proxy: fetches an external image/video so the sandboxed Activity
        // iframe (whose CSP blocks arbitrary `<img>`/`<video>` hosts) can render
        // it. Unauthenticated by necessity — an `<img>` can't carry a bearer — but
        // bounded hard (public hosts only, size + time caps) in the handler.
        .route("/api/activity/image", get(activity::activity_image))
        // Guild data (login + membership gated)
        .route("/api/guilds", get(list_guilds))
        .route("/api/guilds/:guild_id/roles", get(roles))
        .route("/api/guilds/:guild_id/channels", get(channels))
        .route("/api/guilds/:guild_id/emojis", get(emojis))
        .route("/api/guilds/:guild_id/bootstrap", get(bootstrap))
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
        .layer(TraceLayer::new_for_http())
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
