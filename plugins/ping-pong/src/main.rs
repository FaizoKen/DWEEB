//! DWEEB "Ping Pong" plugin.
//!
//! The minimal DWEEB plugin: a button that instantly replies with a
//! configurable message. Where Modal Form shows the *stateful* pattern
//! (SQLite instance store, capability ids), this one shows the *stateless*
//! pattern — the whole config travels inside the `custom_id` Discord hands
//! back on every click, so there is nothing to store and nothing to look up:
//!
//!   pingpong:1:<e|p>:<percent-encoded reply text>
//!   └prefix──┘ │ │    └ what to say (≤ 100 chars total, Discord's limit)
//!            ver └ e = ephemeral (only the clicker sees it), p = public
//!
//! Like every DWEEB plugin it is, all at once: the registry DWEEB reads
//! (`GET /registry.json`), the config iframe DWEEB embeds (`GET /config.html`),
//! and the Discord interactions endpoint (`POST /interactions`) — reached via
//! the interactions dispatcher, which routes on the `pingpong:` prefix.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use percent_encoding::percent_decode_str;
use serde_json::{json, Value};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing_subscriber::EnvFilter;

const PREFIX: &str = "pingpong:";
const DEFAULT_REPLY: &str = "Pong! \u{1F3D3}";

// Interaction request types.
const TYPE_PING: u64 = 1;
const TYPE_MESSAGE_COMPONENT: u64 = 3;
// Interaction callback (response) types.
const RESPONSE_PONG: u64 = 1;
const RESPONSE_CHANNEL_MESSAGE: u64 = 4;
const FLAG_EPHEMERAL: u64 = 1 << 6; // 64

struct App {
    public_key_hex: String,
    public_base_url: String,
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let public_key_hex = std::env::var("DISCORD_PUBLIC_KEY")
        .expect("DISCORD_PUBLIC_KEY is required (app public key, 64 hex chars)");
    if hex::decode(&public_key_hex).map(|b| b.len()) != Ok(32) {
        panic!("DISCORD_PUBLIC_KEY must be 64 hex chars");
    }
    let public_base_url = std::env::var("PUBLIC_BASE_URL")
        .unwrap_or_else(|_| "http://localhost:8091".into())
        .trim_end_matches('/')
        .to_string();
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8091);

    let state = Arc::new(App {
        public_key_hex,
        public_base_url,
    });

    let app = Router::new()
        .route("/health", get(health))
        .route("/registry.json", get(registry))
        .route("/config.html", get(config_html))
        .route("/interactions", post(interactions))
        .with_state(state)
        // The registry is fetched cross-origin by DWEEB. Everything here is
        // public, so a permissive (credential-less) CORS policy is fine.
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind");
    tracing::info!(%addr, "ping-pong plugin listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("shutting down");
        })
        .await
        .expect("server error");
}

async fn health() -> &'static str {
    "ok"
}

/// The DWEEB plugin registry payload — points at this service's own config UI.
async fn registry(State(app): State<Arc<App>>) -> Json<Value> {
    let base = &app.public_base_url;
    Json(json!({
        "schemaVersion": 1,
        "plugins": [{
            "schemaVersion": 1,
            "id": "ping-pong",
            "name": "Ping Pong",
            "description": "Reply instantly with a message of your choice when the button is clicked.",
            "version": env!("CARGO_PKG_VERSION"),
            "publisher": "DWEEB",
            "homepage": "https://github.com/FaizoKen/DWEEB/tree/main/plugins/ping-pong",
            "targets": ["button"],
            "configUrl": format!("{base}/config.html"),
            "customIdPrefix": PREFIX
        }]
    }))
}

/// The configuration iframe, embedded in the binary so the deploy is one file.
async fn config_html() -> Html<&'static str> {
    Html(include_str!("../static/config.html"))
}

/// Discord interactions endpoint. Verifies the signature on the raw body, then
/// dispatches: PING → pong, button click → the reply decoded from custom_id.
async fn interactions(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> Response {
    let signature = headers
        .get("x-signature-ed25519")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let timestamp = headers
        .get("x-signature-timestamp")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if !verify_signature(&app.public_key_hex, signature, timestamp, &body) {
        return (StatusCode::UNAUTHORIZED, "bad signature").into_response();
    }

    let interaction: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return (StatusCode::BAD_REQUEST, "malformed interaction").into_response(),
    };

    match interaction.get("type").and_then(Value::as_u64) {
        Some(TYPE_PING) => Json(json!({ "type": RESPONSE_PONG })).into_response(),
        Some(TYPE_MESSAGE_COMPONENT) => {
            let custom_id = interaction
                .pointer("/data/custom_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let (reply, ephemeral) = decode_custom_id(custom_id);
            let mut flags = 0u64;
            if ephemeral {
                flags |= FLAG_EPHEMERAL;
            }
            Json(json!({
                "type": RESPONSE_CHANNEL_MESSAGE,
                "data": { "content": reply, "flags": flags }
            }))
            .into_response()
        }
        _ => (StatusCode::BAD_REQUEST, "unsupported interaction type").into_response(),
    }
}

/// Decode `pingpong:1:<e|p>:<percent-encoded text>` → (reply, ephemeral).
/// Anything malformed falls back to the default, public-safe reply — a stale
/// or hand-crafted custom_id should never make the button stop working.
fn decode_custom_id(custom_id: &str) -> (String, bool) {
    let fallback = || (DEFAULT_REPLY.to_string(), true);
    let Some(rest) = custom_id.strip_prefix(PREFIX) else {
        return fallback();
    };
    let Some(rest) = rest.strip_prefix("1:") else {
        return fallback();
    };
    let (ephemeral, encoded) = match rest.split_once(':') {
        Some(("e", enc)) => (true, enc),
        Some(("p", enc)) => (false, enc),
        _ => return fallback(),
    };
    let decoded: String = percent_decode_str(encoded).decode_utf8_lossy().into_owned();
    let trimmed = decoded.trim();
    if trimmed.is_empty() {
        return fallback();
    }
    // Discord caps message content at 2000 chars; a 100-char custom_id can't
    // exceed that, but clamp anyway so the invariant doesn't live elsewhere.
    (trimmed.chars().take(2000).collect(), ephemeral)
}

/// Verify Discord's `X-Signature-Ed25519` over `timestamp || body`. Any
/// malformed input fails closed (returns false). This MUST run on the raw body
/// bytes, before JSON parsing. (Same logic as the modal-form plugin.)
fn verify_signature(public_key_hex: &str, signature_hex: &str, timestamp: &str, body: &[u8]) -> bool {
    let pk: [u8; 32] = match hex::decode(public_key_hex).ok().and_then(|b| b.try_into().ok()) {
        Some(arr) => arr,
        None => return false,
    };
    let verifying_key = match VerifyingKey::from_bytes(&pk) {
        Ok(k) => k,
        Err(_) => return false,
    };
    let sig: [u8; 64] = match hex::decode(signature_hex).ok().and_then(|b| b.try_into().ok()) {
        Some(arr) => arr,
        None => return false,
    };
    let signature = Signature::from_bytes(&sig);

    let mut message = Vec::with_capacity(timestamp.len() + body.len());
    message.extend_from_slice(timestamp.as_bytes());
    message.extend_from_slice(body);
    verifying_key.verify(&message, &signature).is_ok()
}
