//! DWEEB "Picker" plugin.
//!
//! Attach it to one of Discord's **auto-populated** select menus — a **User**,
//! **Role**, **Mentionable** (user or role) or **Channel** select — and when a
//! member makes a selection the plugin replies with their picks resolved to
//! mentions: `You selected @Alice, @Bob and #general.` The reply is always a
//! **private** confirmation (ephemeral — only the person who picked sees it).
//!
//! These four selects are the ones Discord auto-fills from the server (you don't
//! hand-wire any options), and each one says "needs a bot to handle clicks" in
//! the builder — this is that bot for them. It is the cheapest plugin to host: a
//! pick is a pure payload → resolve → reply, so there is **no Discord REST call
//! on the hot path and no bot token required**. One small Rust service that is,
//! all at once:
//!   • the plugin **registry** DWEEB reads (`GET /registry.json`),
//!   • the **config iframe** DWEEB embeds (`GET /config.html`),
//!   • the config **API** that iframe talks to (`/api/instances`),
//!   • the Discord **interactions** endpoint (`POST /interactions`).
//!
//! State is a single SQLite file (the per-menu reply config); no secret is ever
//! stored. The instance id inside the component's `custom_id` is a **public
//! binding** only — reconfiguring requires the separate protocol-v2 management
//! token, of which only a SHA-256 digest is kept.

mod config;
mod discord;
mod routes;
mod store;
mod validate;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    routing::{get, post},
    Router,
};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::routes::AppState;
use crate::store::Store;

fn main() {
    // Right-size the async runtime: this service is I/O-bound and low-QPS, so
    // the default of one worker per CPU just reserves idle thread stacks and
    // per-thread allocator arenas. Default to a single worker; set
    // TOKIO_WORKER_THREADS in the environment to scale up without a rebuild.
    let worker_threads = std::env::var("TOKIO_WORKER_THREADS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|n| *n >= 1)
        .unwrap_or(1);
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(worker_threads)
        .enable_all()
        .build()
        .expect("failed to build Tokio runtime")
        .block_on(run());
}

async fn run() {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("configuration error: {e}");
            std::process::exit(1);
        }
    };

    let primary_key = discord::parse_verifying_key(&config.discord_public_key)
        .expect("DISCORD_PUBLIC_KEY must encode a valid Ed25519 point");
    let store = Store::open(&config.database_path).expect("failed to open database");

    let port = config.port;
    let state = AppState {
        store: Arc::new(store),
        config: Arc::new(config),
        primary_key,
    };

    let app = Router::new()
        .route("/health", get(routes::health))
        .route("/registry.json", get(routes::registry))
        .route("/config.html", get(routes::config_html))
        .route("/api/instances", post(routes::create_instance))
        .route(
            "/api/instances/:id",
            get(routes::get_instance).put(routes::update_instance),
        )
        .route("/interactions", post(routes::interactions))
        .with_state(state)
        // The registry is fetched cross-origin by DWEEB; the config API is hit
        // by the iframe. Both are public/capability-gated, so a permissive
        // (credential-less) CORS policy is fine.
        .layer(CorsLayer::permissive())
        .layer(axum::extract::DefaultBodyLimit::max(256 * 1024))
        .layer(TraceLayer::new_for_http());

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind");
    tracing::info!(%addr, "picker plugin listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
}

/// Resolve on Ctrl-C or (on Unix) SIGTERM. Docker sends SIGTERM on
/// `stop`/`compose down`, so without the SIGTERM arm a redeploy would hard-kill
/// this service after the grace timeout instead of letting it drain.
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
    tracing::info!("shutting down");
}
