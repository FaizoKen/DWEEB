//! DWEEB "Ping Pong" plugin.
//!
//! A button that replies with your message plus a **detailed latency report**:
//!
//!   Pong! 🏓
//!   -# ⏱ click → server 142 ms · dispatcher hop 0.4 ms · handler 23 µs
//!
//! The measurements come for free from what every interaction already carries:
//! the interaction `id` is a snowflake embedding the click's millisecond
//! timestamp (click → server), the dispatcher stamps its receive time in
//! `x-dweeb-dispatcher-received` (the internal hop), and the handler times
//! itself.
//!
//! It's also the minimal DWEEB plugin: where Modal Form shows the *stateful*
//! pattern (SQLite instance store, capability ids), this one shows the
//! *stateless* pattern — the whole config travels inside the `custom_id`
//! Discord hands back on every click, so there is nothing to store:
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
/// Discord's snowflake epoch (2015-01-01T00:00:00Z) in unix milliseconds.
const DISCORD_EPOCH_MS: u64 = 1_420_070_400_000;

// Interaction request types.
const TYPE_PING: u64 = 1;
const TYPE_MESSAGE_COMPONENT: u64 = 3;
// Interaction callback (response) types.
const RESPONSE_PONG: u64 = 1;
const RESPONSE_CHANNEL_MESSAGE: u64 = 4;
// Components V2: the reply carries a Text Display instead of plain `content`.
const TYPE_TEXT_DISPLAY: u64 = 10;
const FLAG_EPHEMERAL: u64 = 1 << 6; // 64
const FLAG_IS_COMPONENTS_V2: u64 = 1 << 15; // 32768

struct App {
    public_key_hex: String,
    /// Parsed once: point decompression is meaningful work at interaction QPS.
    public_key: VerifyingKey,
    public_base_url: String,
    /// Shared secret with the dispatcher. When a forwarded request carries it
    /// (x-dweeb-forward-auth), the dispatcher's x-dweeb-public-key header
    /// names the key to verify with — that's how interactions from
    /// guild-registered custom apps still get cryptographically verified
    /// here. None = only the primary key ever verifies.
    forward_secret: Option<String>,
}

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

    let public_key_hex = std::env::var("DISCORD_PUBLIC_KEY")
        .expect("DISCORD_PUBLIC_KEY is required (app public key, 64 hex chars)");
    if hex::decode(&public_key_hex).map(|b| b.len()) != Ok(32) {
        panic!("DISCORD_PUBLIC_KEY must be 64 hex chars");
    }
    let public_key = parse_verifying_key(&public_key_hex)
        .expect("DISCORD_PUBLIC_KEY must encode a valid Ed25519 point");
    let public_base_url = std::env::var("PUBLIC_BASE_URL")
        .unwrap_or_else(|_| "http://localhost:8091".into())
        .trim_end_matches('/')
        .to_string();
    let forward_secret = std::env::var("DISPATCHER_FORWARD_SECRET")
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8091);

    let state = Arc::new(App {
        public_key_hex,
        public_key,
        public_base_url,
        forward_secret,
    });

    let app = Router::new()
        .route("/health", get(health))
        .route("/registry.json", get(registry))
        .route("/config.html", get(config_html))
        .route("/interactions", post(interactions))
        // Unroutable paths answer 404 after draining the body (see `not_found`).
        .fallback(not_found)
        .with_state(state)
        // The registry is fetched cross-origin by DWEEB. Everything here is
        // public, so a permissive (credential-less) CORS policy is fine.
        .layer(CorsLayer::permissive())
        .layer(axum::extract::DefaultBodyLimit::max(256 * 1024))
        .layer(TraceLayer::new_for_http());

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind");
    tracing::info!(%addr, "ping-pong plugin listening");

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
            "description": "Reply with your message plus a detailed latency report (click → server, dispatcher hop, handler time).",
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
/// dispatches: PING → pong, button click → the reply decoded from custom_id
/// plus a latency report (see the module docs for where each number comes from).
async fn interactions(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> Response {
    let started = std::time::Instant::now();
    let now_us = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0);

    let signature = headers
        .get("x-signature-ed25519")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let timestamp = headers
        .get("x-signature-timestamp")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let attested = attested_key(&headers, app.forward_secret.as_deref());
    let verified = match attested {
        Some(key) if !key.eq_ignore_ascii_case(&app.public_key_hex) => parse_verifying_key(key)
            .is_some_and(|key| verify_signature(&key, signature, timestamp, &body)),
        _ => verify_signature(&app.public_key, signature, timestamp, &body),
    };
    if !verified {
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
            // Every reply is Components V2 — the text rides in a Text Display.
            let mut flags = FLAG_IS_COMPONENTS_V2;
            if ephemeral {
                flags |= FLAG_EPHEMERAL;
            }
            let detail = latency_report(&interaction, &headers, now_us, started);
            Json(json!({
                "type": RESPONSE_CHANNEL_MESSAGE,
                "data": {
                    "flags": flags,
                    "components": [{
                        "type": TYPE_TEXT_DISPLAY,
                        "content": format!("{reply}\n{detail}"),
                    }],
                }
            }))
            .into_response()
        }
        _ => (StatusCode::BAD_REQUEST, "unsupported interaction type").into_response(),
    }
}

/// Build the latency subtext line. Every part is optional — whatever can't be
/// measured (no snowflake, direct call without the dispatcher) is just omitted,
/// so the reply never fails because a number was missing.
///
///   -# ⏱ click → server **142 ms** · dispatcher hop **0.4 ms** · handler **23 µs**
///
/// "click → server" compares the interaction snowflake's embedded timestamp
/// against this host's clock, so it includes Discord's own processing and is
/// only as honest as NTP keeps us; negative skew clamps to 0.
fn latency_report(
    interaction: &Value,
    headers: &HeaderMap,
    now_us: u64,
    started: std::time::Instant,
) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(3);

    let clicked_ms = interaction
        .get("id")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<u64>().ok())
        .map(|id| (id >> 22) + DISCORD_EPOCH_MS);
    if let Some(clicked) = clicked_ms {
        let delivery_ms = (now_us / 1000).saturating_sub(clicked);
        parts.push(format!("click → server **{delivery_ms} ms**"));
    }

    let dispatcher_us = headers
        .get("x-dweeb-dispatcher-received")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok());
    if let Some(received) = dispatcher_us {
        let hop_us = now_us.saturating_sub(received);
        parts.push(format!(
            "dispatcher hop **{:.1} ms**",
            hop_us as f64 / 1000.0
        ));
    }

    parts.push(format!("handler **{} µs**", started.elapsed().as_micros()));

    format!("-# \u{23F1} {}", parts.join(" · "))
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
fn parse_verifying_key(public_key_hex: &str) -> Option<VerifyingKey> {
    let pk: [u8; 32] = hex::decode(public_key_hex).ok()?.try_into().ok()?;
    VerifyingKey::from_bytes(&pk).ok()
}

fn verify_signature(
    verifying_key: &VerifyingKey,
    signature_hex: &str,
    timestamp: &str,
    body: &[u8],
) -> bool {
    let sig: [u8; 64] = match hex::decode(signature_hex)
        .ok()
        .and_then(|b| b.try_into().ok())
    {
        Some(arr) => arr,
        None => return false,
    };
    let signature = Signature::from_bytes(&sig);

    let mut message = Vec::with_capacity(timestamp.len() + body.len());
    message.extend_from_slice(timestamp.as_bytes());
    message.extend_from_slice(body);
    verifying_key.verify(&message, &signature).is_ok()
}

/// The dispatcher-attested verifying key, if this request carries one.
///
/// The dispatcher also serves guild-registered *custom* Discord apps, whose
/// interactions are signed with their own keys — it forwards the verifying
/// key in `x-dweeb-public-key`, vouched for by the shared
/// DISPATCHER_FORWARD_SECRET in `x-dweeb-forward-auth`. The signature is
/// still verified HERE, on the raw bytes Discord signed; the secret only
/// authenticates *which key to use*. Without a valid secret the header is
/// ignored (None), so a caller reaching this service directly can never
/// substitute its own key.
fn attested_key<'h>(headers: &'h HeaderMap, secret: Option<&str>) -> Option<&'h str> {
    let secret = secret?;
    let supplied = headers.get("x-dweeb-forward-auth")?.to_str().ok()?;
    if !constant_time_eq(supplied.as_bytes(), secret.as_bytes()) {
        return None;
    }
    headers.get("x-dweeb-public-key")?.to_str().ok()
}

/// Byte-wise comparison that doesn't leak the match length through timing.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
