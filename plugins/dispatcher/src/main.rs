//! Interactions dispatcher: the ONE public Discord interactions endpoint,
//! fanning out to plugin services by `custom_id` prefix.
//!
//! A Discord application has exactly one Interactions Endpoint URL, but every
//! DWEEB plugin that puts interactive components on a webhook message receives
//! its clicks through that single URL. Each plugin manifest declares a
//! `customIdPrefix` (e.g. `modalform:`), so the prefix doubles as the routing
//! key: this service verifies the Ed25519 signature, answers PINGs itself, and
//! forwards everything else — raw body and signature headers untouched, so the
//! plugin can (and does) re-verify — to the matching upstream.
//!
//! It also answers the one slash command the app has, `/dashboard`, inline —
//! a static ephemeral reply with the dashboard URL needs no plugin and no
//! forward hop. Register it once with `node scripts/register-commands.mjs`.
//!
//! Adding a plugin is one entry in the ROUTES env var; nothing here changes.
//!
//! Components also expire by default: a click on a message older than
//! COMPONENT_TTL_DAYS (the message id snowflake carries its send time) is
//! answered here with an UPDATE_MESSAGE that disables the clicked component,
//! and is never forwarded. A disabled component fires no further interactions,
//! so one expired click is the last traffic that message ever generates.
//!
//! Env:
//!   DISCORD_PUBLIC_KEY  app public key (64 hex chars), required
//!   ROUTES              JSON map of custom_id prefix -> upstream base URL,
//!                       e.g. {"modalform:":"http://modal-form:8090"}, required
//!   COMPONENT_TTL_DAYS  days a component stays clickable after its message
//!                       was sent, default 7; 0 = never expires
//!   DASHBOARD_URL       URL /dashboard replies with, default https://dweeb.faizo.net
//!   PORT                bind port, default 8095

use std::{net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::{json, Value};

const TYPE_PING: u64 = 1;
const TYPE_APPLICATION_COMMAND: u64 = 2;
const TYPE_MESSAGE_COMPONENT: u64 = 3;
const RESPONSE_PONG: u64 = 1;
const RESPONSE_CHANNEL_MESSAGE: u64 = 4;
const RESPONSE_UPDATE_MESSAGE: u64 = 7;
const FLAG_EPHEMERAL: u64 = 1 << 6; // 64
/// First millisecond of 2015 — the epoch Discord snowflakes count from.
const DISCORD_EPOCH_MS: u64 = 1_420_070_400_000;

struct App {
    public_key_hex: String,
    /// (custom_id prefix, upstream base URL) — longest prefix wins.
    routes: Vec<(String, String)>,
    /// How long a component stays clickable after its message was sent.
    /// `None` = never expires (COMPONENT_TTL_DAYS=0).
    component_ttl_ms: Option<u64>,
    /// What `/dashboard` replies with.
    dashboard_url: String,
    client: reqwest::Client,
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let public_key_hex = std::env::var("DISCORD_PUBLIC_KEY")
        .expect("DISCORD_PUBLIC_KEY is required (app public key, 64 hex chars)");
    if hex::decode(&public_key_hex).map(|b| b.len()) != Ok(32) {
        panic!("DISCORD_PUBLIC_KEY must be 64 hex chars");
    }

    let routes_json = std::env::var("ROUTES")
        .expect(r#"ROUTES is required, e.g. {"modalform:":"http://modal-form:8090"}"#);
    let parsed: Value = serde_json::from_str(&routes_json).expect("ROUTES must be a JSON object");
    let mut routes: Vec<(String, String)> = parsed
        .as_object()
        .expect("ROUTES must be a JSON object")
        .iter()
        .map(|(prefix, base)| {
            let base = base
                .as_str()
                .expect("ROUTES values must be URL strings")
                .trim_end_matches('/')
                .to_string();
            (prefix.clone(), base)
        })
        .collect();
    // Longest prefix first, so "modalform-v2:" beats "modalform" if both exist.
    routes.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    for (prefix, base) in &routes {
        tracing::info!(prefix, upstream = %base, "route registered");
    }

    let component_ttl_days: u64 = std::env::var("COMPONENT_TTL_DAYS")
        .ok()
        .map(|v| {
            v.trim()
                .parse()
                .expect("COMPONENT_TTL_DAYS must be a whole number of days (0 = never expires)")
        })
        .unwrap_or(7);
    let component_ttl_ms = (component_ttl_days > 0).then(|| component_ttl_days * 86_400_000);
    tracing::info!(days = component_ttl_days, "component TTL (0 = never expires)");

    let dashboard_url = std::env::var("DASHBOARD_URL")
        .unwrap_or_else(|_| "https://dweeb.faizo.net".into())
        .trim_end_matches('/')
        .to_string();

    let app = Arc::new(App {
        public_key_hex,
        routes,
        component_ttl_ms,
        dashboard_url,
        client: reqwest::Client::builder()
            // Discord gives the whole chain 3s; leave headroom to still send
            // the fallback reply if an upstream stalls.
            .timeout(Duration::from_millis(2500))
            // Keep upstream connections warm — the forward hop stays sub-ms.
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .expect("reqwest client"),
    });

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8095);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    let router = Router::new()
        .route("/health", get(health))
        // Public endpoint at the root: the hostname (interactions.<domain>) is
        // the whole address, no path component.
        .route("/", post(interactions))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(app);

    tracing::info!(%addr, "interactions dispatcher listening");
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
        })
        .await
        .expect("server");
}

async fn health() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
}

async fn interactions(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // Verify before parsing; Discord probes with invalid signatures and a 401
    // here is what makes the endpoint pass their validation.
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
        Some(TYPE_PING) => return Json(json!({ "type": RESPONSE_PONG })).into_response(),
        // Slash commands route by name, not custom_id. The app has exactly
        // one — /dashboard — and its reply is a static URL, so answering it
        // here costs nothing and skips the forward hop entirely.
        Some(TYPE_APPLICATION_COMMAND) => {
            let name = interaction
                .pointer("/data/name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if name == "dashboard" {
                // Bare URL (no <>) so Discord renders the OG preview card.
                return ephemeral(&format!(
                    "\u{1F6E0}\u{FE0F} Build and manage your messages at {}",
                    app.dashboard_url
                ));
            }
            tracing::warn!(name, "unknown slash command");
            return ephemeral("Unknown command.");
        }
        _ => {}
    }

    // Components and modal submits both carry the routing key here.
    let custom_id = interaction
        .pointer("/data/custom_id")
        .and_then(Value::as_str)
        .unwrap_or_default();

    // Components expire COMPONENT_TTL_DAYS after their message was sent (the
    // message id snowflake carries the send time — no registry of instances
    // needed). An expired click is answered by disabling the component on the
    // message itself, so it never reaches a plugin and never fires again.
    // Modal submits are exempt: opening the modal already passed this gate.
    if interaction.get("type").and_then(Value::as_u64) == Some(TYPE_MESSAGE_COMPONENT) {
        if let (Some(ttl_ms), Some(sent_ms)) = (app.component_ttl_ms, message_sent_ms(&interaction))
        {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            if now_ms.saturating_sub(sent_ms) > ttl_ms {
                tracing::info!(custom_id, "component past TTL, disabling");
                return disable_expired(&interaction, custom_id);
            }
        }
    }

    let Some((prefix, base)) = app
        .routes
        .iter()
        .find(|(prefix, _)| custom_id.starts_with(prefix.as_str()))
    else {
        tracing::warn!(custom_id, "no route for interaction");
        return ephemeral("This component isn't wired to any installed plugin.");
    };

    // Forward raw body + signature headers so the plugin re-verifies the exact
    // bytes Discord signed. The receive timestamp (unix µs) lets latency-aware
    // plugins (e.g. ping-pong) report the dispatcher hop; it is informational
    // only — it isn't part of the signed material.
    let received_us = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros())
        .unwrap_or(0);
    let forwarded = app
        .client
        .post(format!("{base}/interactions"))
        .header("content-type", "application/json")
        .header("x-signature-ed25519", signature)
        .header("x-signature-timestamp", timestamp)
        .header("x-dweeb-dispatcher-received", received_us.to_string())
        .body(body.clone())
        .send()
        .await;

    match forwarded {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16())
                .unwrap_or(StatusCode::BAD_GATEWAY);
            let content_type = resp
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/json")
                .to_string();
            let bytes = resp.bytes().await.unwrap_or_default();
            (status, [(axum::http::header::CONTENT_TYPE, content_type)], bytes).into_response()
        }
        Err(err) => {
            // Still answer Discord within its 3s window so the user sees a
            // message instead of "This interaction failed".
            tracing::error!(prefix, upstream = %base, %err, "forward failed");
            ephemeral("The plugin behind this component didn't respond — try again shortly.")
        }
    }
}

/// When the message a component sits on was sent, from its snowflake id.
fn message_sent_ms(interaction: &Value) -> Option<u64> {
    let id: u64 = interaction
        .pointer("/message/id")?
        .as_str()?
        .parse()
        .ok()?;
    Some((id >> 22) + DISCORD_EPOCH_MS)
}

/// Answer an expired click by editing the message to disable the clicked
/// component. Discord stops sending interactions for a disabled component, so
/// this is also the last request the message ever generates.
fn disable_expired(interaction: &Value, custom_id: &str) -> Response {
    // Echo the message's own component tree back with the one component
    // disabled. If the tree is somehow absent, fall back to an ephemeral note
    // rather than wiping the message's components with an empty list.
    let Some(mut components) = interaction.pointer("/message/components").cloned() else {
        return ephemeral("This component has expired.");
    };
    disable_component(&mut components, custom_id);
    Json(json!({
        "type": RESPONSE_UPDATE_MESSAGE,
        "data": { "components": components }
    }))
    .into_response()
}

/// Recursively set `disabled: true` on every component matching `custom_id`.
/// Handles Components V2 nesting: containers/sections/action rows hold
/// children under `components`, a section's button under `accessory`.
fn disable_component(node: &mut Value, custom_id: &str) {
    match node {
        Value::Array(items) => {
            for item in items {
                disable_component(item, custom_id);
            }
        }
        Value::Object(map) => {
            if map.get("custom_id").and_then(Value::as_str) == Some(custom_id) {
                map.insert("disabled".into(), Value::Bool(true));
            }
            if let Some(children) = map.get_mut("components") {
                disable_component(children, custom_id);
            }
            if let Some(accessory) = map.get_mut("accessory") {
                disable_component(accessory, custom_id);
            }
        }
        _ => {}
    }
}

/// Minimal user-facing reply for the cases where no plugin answered.
fn ephemeral(message: &str) -> Response {
    Json(json!({
        "type": RESPONSE_CHANNEL_MESSAGE,
        "data": { "content": message, "flags": FLAG_EPHEMERAL }
    }))
    .into_response()
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
