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
mod session;

use std::net::SocketAddr;
use std::sync::Arc;

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
use crate::routes::{bootstrap, channels, emojis, health, list_guilds, roles, AppState};

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

    let state = AppState {
        discord: Arc::new(Discord::new(
            config.bot_token.clone(),
            config.discord_max_concurrency,
        )),
        cache: Arc::new(cache),
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
        // Guild data (login + membership gated)
        .route("/api/guilds", get(list_guilds))
        .route("/api/guilds/:guild_id/roles", get(roles))
        .route("/api/guilds/:guild_id/channels", get(channels))
        .route("/api/guilds/:guild_id/emojis", get(emojis))
        .route("/api/guilds/:guild_id/bootstrap", get(bootstrap))
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
        .allow_methods([Method::GET, Method::POST])
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
