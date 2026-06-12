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

mod auth;
mod cache;
mod config;
mod discord;
mod error;
mod ratelimit;
mod routes;
mod seal;
mod session;
mod shortlink;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::http::{header, HeaderValue, Method};
use axum::middleware::from_fn_with_state;
use axum::routing::{get, post};
use axum::Router;
use axum_extra::extract::cookie::Key;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::cache::{DataCache, TtlCache};
use crate::config::Config;
use crate::discord::Discord;
use crate::ratelimit::{rate_limit, Limiter, RateLimiter};
use crate::routes::{
    bootstrap, channels, custom_apps_add, custom_apps_list, custom_apps_remove, emojis, health,
    list_guilds, permanent_add, permanent_list, permanent_remove, roles, AppState, DispatcherApi,
};
use crate::shortlink::{shortlink_create, shortlink_resolve, ShortLinkStore};

#[tokio::main]
async fn main() {
    // Load a local `.env` if present (for `cargo run` / running the binary
    // directly). In Docker the vars come from `env_file`, so there's no `.env`
    // in the image and this is a harmless no-op. Real environment variables
    // always win over `.env` entries.
    let _ = dotenvy::dotenv();

    // `dweeb-proxy healthcheck` is invoked by the Docker HEALTHCHECK. It just
    // confirms the listener accepts connections, so the runtime image needs no
    // curl/wget — keeping it tiny.
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        run_healthcheck();
    }

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

    let state = AppState {
        discord: Arc::new(Discord::new(
            config.bot_token.clone(),
            config.discord_max_concurrency,
        )),
        cache: Arc::new(cache),
        dispatcher,
        shortlinks,
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
        .allow_methods([Method::GET, Method::POST, Method::DELETE])
        .allow_headers([header::CONTENT_TYPE])
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
