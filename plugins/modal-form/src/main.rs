//! DWEEB "Modal Form" plugin.
//!
//! One small Rust service that is, all at once:
//!   • the plugin **registry** DWEEB reads (`GET /registry.json`),
//!   • the **config iframe** DWEEB embeds (`GET /config.html`),
//!   • the config **API** that iframe talks to (`/api/instances`),
//!   • the Discord **interactions** endpoint (`POST /interactions`).
//!
//! It holds no bot token and makes no Discord REST calls — it only verifies
//! interaction signatures and answers with callback JSON, plus one outbound
//! POST to the user's configured forward webhook. State is a single SQLite
//! file. That keeps it cheap to host: one tiny binary, no database server.

mod config;
mod discord;
mod routes;
mod store;
mod validate;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

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
    // The modal-submit handler awaits this forward POST before replying, so its
    // timeout is part of the interaction's latency budget. 2.5s keeps the whole
    // round-trip inside Discord's ~3s window even after the dispatcher hop; the
    // forward is best-effort and the reply is sent whether or not it succeeds.
    let http = reqwest::Client::builder()
        .timeout(Duration::from_millis(2500))
        .pool_idle_timeout(Duration::from_secs(30))
        .pool_max_idle_per_host(16)
        .user_agent(concat!(
            "dweeb-modal-form/",
            env!("CARGO_PKG_VERSION"),
            " (+https://github.com/FaizoKen/DWEEB)"
        ))
        .build()
        .expect("failed to build HTTP client");

    let port = config.port;
    let state = AppState {
        store: Arc::new(store),
        http,
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
        // by the iframe. Reads/creates are public; PUT is edit-token gated, so a
        // permissive credential-less CORS policy is fine.
        .layer(CorsLayer::permissive())
        .layer(axum::extract::DefaultBodyLimit::max(256 * 1024))
        .layer(TraceLayer::new_for_http());

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind");
    tracing::info!(%addr, "modal-form plugin listening");

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
