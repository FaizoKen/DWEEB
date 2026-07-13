//! DWEEB "Self Role" plugin.
//!
//! Attach it to a **button** or a **string select** in DWEEB and members can
//! give themselves the roles you choose — no moderator in the loop. One small
//! Rust service that is, all at once:
//!   • the plugin **registry** DWEEB reads (`GET /registry.json`),
//!   • the **config iframe** DWEEB embeds (`GET /config.html`),
//!   • the config **API** that iframe talks to (`/api/instances`, `/api/connect`),
//!   • the Discord **interactions** endpoint (`POST /interactions`).
//!
//! Unlike the stateless Modal Form / Ping Pong plugins, this one *does* call the
//! Discord REST API: assigning a role is `PUT
//! /guilds/{guild}/members/{user}/roles/{role}`, which needs a bot token with
//! **Manage Roles**. That token is the deployment-wide shared bot (`BOT_TOKEN`);
//! it lives only in the process environment, never per instance and never in the
//! database. The only host it is ever sent to is `discord.com`, so there is no
//! SSRF surface. State is a single SQLite file.

mod config;
mod discord;
mod reaper;
mod rest;
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

    let store = Store::open(&config.database_path).expect("failed to open database");
    // One client for both the config-time role listing and the interaction-time
    // role mutations. 2.5s keeps the whole interaction inside Discord's ~3s
    // window even after the dispatcher hop.
    let http = reqwest::Client::builder()
        .timeout(Duration::from_millis(2500))
        .user_agent(concat!(
            "dweeb-self-role/",
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
    };

    // Temporary-role reaper: only worth running when a bot token is configured
    // (without one, nothing can be added in the first place, so nothing expires).
    if let Some(token) = state.config.default_bot_token.clone() {
        reaper::spawn(
            state.store.clone(),
            state.http.clone(),
            token,
            state.config.reaper_interval_secs,
        );
    }

    let app = Router::new()
        .route("/health", get(routes::health))
        .route("/registry.json", get(routes::registry))
        .route("/config.html", get(routes::config_html))
        .route("/api/meta", get(routes::meta))
        .route("/api/connect", post(routes::connect))
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
        .layer(TraceLayer::new_for_http());

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind");
    tracing::info!(%addr, "self-role plugin listening");

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
