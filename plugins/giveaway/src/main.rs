//! DWEEB "Giveaway" plugin.
//!
//! Attach it to an **interactive button** in DWEEB and you have a giveaway: a
//! member clicks **Enter**, the live entrant count ticks up on the message
//! itself, and when you're ready a moderator draws N winners at random. One
//! small Rust service that is, all at once:
//!   • the plugin **registry** DWEEB reads (`GET /registry.json`),
//!   • the **config iframe** DWEEB embeds (`GET /config.html`),
//!   • the config **API** that iframe talks to (`/api/instances`, `/api/connect`),
//!   • the Discord **interactions** endpoint (`POST /interactions`).
//!
//! ## The "winners are announced LATER" tension, resolved
//!
//! An *Enter* click is pure request/response. *Ending* a giveaway and announcing
//! winners happens later — and none of the bundled plugins initiate outbound
//! messages on a schedule. We deliberately do **not** run a scheduler: a host
//! draws winners with a mod-only **Draw** button (reachable by clicking the
//! Enter button as a Manage-Server holder), which keeps the whole lifecycle in
//! the request/response model every other plugin uses — no background poster, no
//! "missed the deadline while the box was down" failure mode, and the draw
//! happens exactly when a human is there to hype it. An optional **deadline**
//! still has teeth: it's enforced lazily at click time (entries close once it
//! passes) and rendered as a live countdown — see `discord.rs`.
//!
//! Because the host message is posted through a **webhook** (a bot can't edit a
//! webhook-authored message), the only way to touch it is an `UPDATE_MESSAGE`
//! response to a click *on it* — which is exactly how the live entrant count is
//! kept current, with no bot token. The winner announcement is the public
//! (non-ephemeral) interaction response to the Draw click; again, no token.
//!
//! The shared bot (`BOT_TOKEN`) is therefore **optional**: it powers only the
//! config-time role picker (listing a guild's roles for entry requirements) and
//! the optional "DM the winners" feature. Everything else runs token-free. State
//! is a single SQLite file.

mod config;
mod discord;
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

#[tokio::main]
async fn main() {
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
    // One client for the config-time role listing and the draw-time winner DMs.
    // 2.5s keeps the whole interaction inside Discord's ~3s window even after the
    // dispatcher hop.
    let http = reqwest::Client::builder()
        .timeout(Duration::from_millis(2500))
        .user_agent(concat!(
            "dweeb-giveaway/",
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
        // by the iframe. Both are public/capability-gated, so a permissive
        // (credential-less) CORS policy is fine.
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind");
    tracing::info!(%addr, "giveaway plugin listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}
