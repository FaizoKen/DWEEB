//! DWEEB "Directory" plugin.
//!
//! Attach it to a **button** or an options **menu** and a click answers with a
//! live list of the server. Two modes:
//!
//!   • **Roles** — a staff roster. The roles you pick (or every role the server
//!     displays separately, or every role with moderation powers), arranged into
//!     named groups like "Owners" / "Moderators", each with a permission badge
//!     line and your own one-line description.
//!   • **Channels** — a channel index. Every channel (or a category, or a
//!     hand-picked shortlist) grouped under its category heading, each with its
//!     own topic as the caption.
//!
//! Everything is read at click time, so a renamed role or a rewritten topic is
//! current without anyone re-editing the message. The reply is private by
//! default; a directory can be made public instead.
//!
//! **This plugin only ever reads.** It needs no permission bit — being a member
//! of the guild is enough for `GET /guilds/{id}`, `/roles` and `/channels` — and
//! it writes nothing back to Discord beyond its own reply.
//!
//! ## No privileged intent, by construction
//!
//! Every read here works for a bot that is merely a guild member, so there is no
//! deployment in which part of this plugin works and the rest doesn't. That is a
//! deliberate constraint, not an accident: a roster of *who holds each role* was
//! implemented and then removed, because `GET /guilds/{id}/members` is gated on
//! the privileged `GUILD_MEMBERS` intent and no ungated endpoint can substitute
//! (`/members/search` needs a name prefix and can't filter by role; the role
//! object has no member count). Shipped as a graceful degradation, it put
//! "Member lists aren't available right now." into members' messages on every
//! deployment without the intent. Server-wide totals took its place — they come
//! free with the guild fetch (`?with_counts=true`). Don't reintroduce per-member
//! reads unless the intent is actually a deployment requirement.
//!
//! One small Rust service that is, all at once:
//!   • the plugin **registry** DWEEB reads (`GET /registry.json`),
//!   • the **config iframe** DWEEB embeds (`GET /config.html`),
//!   • the config **API** that iframe talks to (`/api/meta`, `/api/connect`,
//!     `/api/instances`),
//!   • the Discord **interactions** endpoint (`POST /interactions`).
//!
//! State is a single SQLite file (the per-directory config); no secret is ever
//! stored — the shared bot token lives only in this process's environment. The
//! instance id inside the component's `custom_id` is a **public binding** only;
//! reconfiguring requires the separate protocol-v2 management token, of which
//! only a SHA-256 digest is kept.
//!
//! Env:
//!   DISCORD_PUBLIC_KEY        app public key (64 hex chars), required
//!   PUBLIC_BASE_URL           origin this service is served at
//!   BOT_TOKEN                 shared bot token used for every read; unset = the
//!                             config UI refuses to set a directory up
//!   BOT_INVITE_URL            optional invite link surfaced by the config UI
//!   DISPATCHER_FORWARD_SECRET shared secret attesting a custom app's key
//!   DATABASE_PATH             SQLite file, default ./directory.db
//!   STRUCTURE_CACHE_SECS      guild/role/channel cache TTL, default 60 (0 = off)
//!   CACHE_MAX_GUILDS          cached guilds, default 64
//!   PORT                      bind port, default 8099

mod config;
mod discord;
mod render;
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
use crate::rest::Cache;
use crate::routes::AppState;
use crate::store::Store;

fn main() {
    // Right-size the async runtime: this service is I/O-bound and low-QPS, so
    // the default of one worker per CPU just reserves idle thread stacks and
    // per-thread allocator arenas. Default to a single worker; set
    // TOKIO_WORKER_THREADS in the environment to scale up without a rebuild.
    let worker_threads = std::env::var("TOKIO_WORKER_THREADS")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
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

    // Parse the primary verifying key once at boot rather than per interaction;
    // custom-app keys stay dynamic because they arrive per request.
    let primary_key = discord::parse_verifying_key(&config.discord_public_key)
        .expect("DISCORD_PUBLIC_KEY must encode a valid Ed25519 point");
    let store = Store::open(&config.database_path).expect("failed to open database");
    store.ping().expect("database is not readable");

    if !config.has_default_bot() {
        // Not fatal: the service still serves its registry and config iframe, and
        // the UI explains the situation. Boot-time WARN so an operator sees it
        // once rather than discovering it from a member's failed click.
        tracing::warn!(
            "BOT_TOKEN is not set — directories cannot be configured or read on this deployment"
        );
    }

    // One shared client with a bounded idle pool. The 2.5s timeout keeps a reply
    // inside Discord's ~3s window even after the dispatcher hop — and since
    // nothing here defers, that ceiling applies to every click without
    // exception.
    let http = reqwest::Client::builder()
        .timeout(Duration::from_millis(2500))
        .pool_idle_timeout(Duration::from_secs(30))
        .pool_max_idle_per_host(16)
        .user_agent(concat!(
            "dweeb-directory/",
            env!("CARGO_PKG_VERSION"),
            " (+https://github.com/FaizoKen/DWEEB)"
        ))
        .build()
        .expect("failed to build HTTP client");

    let port = config.port;
    let cache = Arc::new(Cache::new(&config));
    let state = AppState {
        store: Arc::new(store),
        cache,
        http,
        config: Arc::new(config),
        primary_key,
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
        // Unroutable paths answer 404 after draining the body (see `not_found`).
        // Registered BEFORE the layers below so they wrap it too — `Router::layer`
        // only applies to what was added above it.
        .fallback(not_found)
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
    tracing::info!(%addr, "directory plugin listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
}

/// Fallback for a path this service doesn't route: 404 — but only *after* the
/// request body has been read and dropped.
///
/// The drain is the entire point. Axum's default fallback answers without
/// touching the body, so hyper can't reuse the connection and closes it; Caddy,
/// still streaming that body upstream, sees the close as `write: broken pipe`,
/// throws our 404 away, and synthesises a **502** for the client. Caddy logs
/// that at ERROR, and ERROR is the paging channel (`dweeb-alerts`) — so an
/// internet vulnerability scanner POSTing a body at a path we don't serve
/// (`POST /`) paged the maintainer over a request we had already answered
/// correctly. The house rule holds here too: a status code is an alerting
/// decision, and 5xx must mean *our* fault.
///
/// Reading the body first keeps the connection reusable, so the honest 404
/// reaches the client and nothing is logged anywhere. Buffering via `Bytes`
/// rather than streaming the drain is deliberate: it's bounded by the router's
/// `DefaultBodyLimit`, and a body past that limit is one we *want* to hang up on
/// instead of read to the end.
async fn not_found(_drained: axum::body::Bytes) -> impl axum::response::IntoResponse {
    (axum::http::StatusCode::NOT_FOUND, "Not found")
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

#[cfg(test)]
mod tests {
    use super::not_found;
    use axum::body::{Body, Bytes};
    use axum::handler::Handler;
    use axum::http::{Request, StatusCode};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// The unroutable-path fallback must read the request body before answering.
    ///
    /// If it doesn't, hyper can't reuse the connection, Caddy reports
    /// `write: broken pipe`, throws our 404 away and synthesises a **502** —
    /// which it logs at ERROR, which pages. Vulnerability scanners POST bodies at
    /// paths we don't serve constantly, so this is the difference between silence
    /// and a 3am alert for a request we answered correctly. If someone
    /// "simplifies" `not_found` to take no extractor, this fails.
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
