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
//! A click whose custom_id matches no route is answered the same way: the
//! component is disabled, so a message left behind by an uninstalled plugin
//! stops generating traffic after its first click.
//!
//! Each guild gets PERMANENT_SLOTS_PER_GUILD exemptions, managed from the
//! DWEEB dashboard: the proxy authenticates the user (Discord login + Manage
//! Server on the guild) and calls the token-gated /permanent API here, which
//! owns the slots in SQLite. No Discord command is involved.
//!
//! Env:
//!   DISCORD_PUBLIC_KEY  app public key (64 hex chars), required
//!   ROUTES              JSON map of custom_id prefix -> upstream base URL,
//!                       e.g. {"modalform:":"http://modal-form:8090"}, required
//!   COMPONENT_TTL_DAYS  days a component stays clickable after its message
//!                       was sent, default 7; 0 = never expires
//!   PERMANENT_SLOTS_PER_GUILD
//!                       messages per guild exempt from the TTL, default 2;
//!                       0 stops new grants (existing ones stay honored)
//!   INTERNAL_API_TOKEN  bearer token the proxy must send to the /permanent
//!                       API; unset = that API is disabled
//!   DATABASE_PATH       SQLite file for the permanent slots, default ./dispatcher.db
//!   DASHBOARD_URL       URL /dashboard replies with, default https://dweeb.faizo.net
//!   PORT                bind port, default 8095

mod store;

use std::{net::SocketAddr, sync::Arc, time::Duration};

use axum::{
    body::Bytes,
    extract::{Path, State},
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
/// Discord snowflakes are 17–20 digits today; accept a small range with slack.
fn is_snowflake(s: &str) -> bool {
    (15..=25).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

struct App {
    public_key_hex: String,
    /// (custom_id prefix, upstream base URL) — longest prefix wins.
    routes: Vec<(String, String)>,
    /// How long a component stays clickable after its message was sent.
    /// `None` = never expires (COMPONENT_TTL_DAYS=0).
    component_ttl_ms: Option<u64>,
    /// TTL-exempt messages each guild may hold at once.
    permanent_slots: u32,
    /// Which messages are TTL-exempt.
    store: store::Store,
    /// Bearer token the proxy presents to the /permanent management API.
    /// `None` disables that API entirely.
    internal_token: Option<String>,
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

    let permanent_slots: u32 = std::env::var("PERMANENT_SLOTS_PER_GUILD")
        .ok()
        .map(|v| {
            v.trim()
                .parse()
                .expect("PERMANENT_SLOTS_PER_GUILD must be a whole number (0 stops new grants)")
        })
        .unwrap_or(2);
    let database_path =
        std::env::var("DATABASE_PATH").unwrap_or_else(|_| "./dispatcher.db".into());
    let store = store::Store::open(&database_path).expect("open permanent-message store");
    let internal_token = std::env::var("INTERNAL_API_TOKEN")
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    tracing::info!(
        path = %database_path,
        slots = permanent_slots,
        api_enabled = internal_token.is_some(),
        "permanent store ready"
    );

    let dashboard_url = std::env::var("DASHBOARD_URL")
        .unwrap_or_else(|_| "https://dweeb.faizo.net".into())
        .trim_end_matches('/')
        .to_string();

    let app = Arc::new(App {
        public_key_hex,
        routes,
        component_ttl_ms,
        permanent_slots,
        store,
        internal_token,
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
        // Permanent-slot management, called by the proxy on behalf of the
        // dashboard. Token-gated (INTERNAL_API_TOKEN) — Caddy also refuses
        // /permanent on the public hostname, but the token is the real gate.
        .route(
            "/permanent/:guild_id",
            get(permanent_list).post(permanent_add),
        )
        .route(
            "/permanent/:guild_id/:message_id",
            axum::routing::delete(permanent_remove),
        )
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
    // needed), unless an admin spent one of the guild's permanent slots on
    // the message. An expired click is answered by disabling the component on
    // the message itself, so it never reaches a plugin and never fires again.
    // Modal submits are exempt: opening the modal already passed this gate.
    // Only already-expired clicks pay the store lookup; fresh traffic never
    // touches the database.
    if interaction.get("type").and_then(Value::as_u64) == Some(TYPE_MESSAGE_COMPONENT) {
        if let (Some(ttl_ms), Some(sent_ms)) = (app.component_ttl_ms, message_sent_ms(&interaction))
        {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let message_id = interaction
                .pointer("/message/id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if now_ms.saturating_sub(sent_ms) > ttl_ms && !app.store.is_permanent(message_id) {
                tracing::info!(custom_id, "component past TTL, disabling");
                return disable_clicked(&interaction, custom_id, "This component has expired.");
            }
        }
    }

    let Some((prefix, base)) = app
        .routes
        .iter()
        .find(|(prefix, _)| custom_id.starts_with(prefix.as_str()))
    else {
        tracing::warn!(custom_id, "no route for interaction, disabling component");
        // An unrouted component can never succeed — its plugin isn't
        // installed — so disable it like an expired one rather than leave it
        // clickable. Modal submits carry the modal's custom_id, which isn't
        // on the message, so there is nothing to disable for them.
        const NOT_WIRED: &str = "This component isn't wired to any installed plugin.";
        if interaction.get("type").and_then(Value::as_u64) == Some(TYPE_MESSAGE_COMPONENT) {
            return disable_clicked(&interaction, custom_id, NOT_WIRED);
        }
        return ephemeral(NOT_WIRED);
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

/// Answer a dead click (expired or unrouted) by editing the message to disable
/// the clicked component. Discord stops sending interactions for a disabled
/// component, so this is also the last request the message ever generates.
fn disable_clicked(interaction: &Value, custom_id: &str, fallback: &str) -> Response {
    // Echo the message's own component tree back with the one component
    // disabled. If the tree is somehow absent, fall back to an ephemeral note
    // rather than wiping the message's components with an empty list.
    let Some(mut components) = interaction.pointer("/message/components").cloned() else {
        return ephemeral(fallback);
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

// ── Permanent-slot management API (called by the proxy) ─────────────────────
//
// The dashboard is the only client: browser → proxy (Discord login + Manage
// Server check on the guild) → here, with INTERNAL_API_TOKEN as a bearer.
// This service stays the single owner of the slots the TTL gate consults.

/// `GET /permanent/:guild_id` — slot usage + the current permanent messages.
async fn permanent_list(
    State(app): State<Arc<App>>,
    Path(guild_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Some(denied) = deny_internal(&app, &headers, &[&guild_id]) {
        return denied;
    }
    match app.store.list(&guild_id) {
        Ok(rows) => slots_json(&app, &rows).into_response(),
        Err(err) => internal_error(err),
    }
}

/// `POST /permanent/:guild_id` `{ message_id, channel_id, added_by }` —
/// spend a slot. Idempotent: adding an already-permanent message is a 200.
async fn permanent_add(
    State(app): State<Arc<App>>,
    Path(guild_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Some(denied) = deny_internal(&app, &headers, &[&guild_id]) {
        return denied;
    }
    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return bad_request("body must be JSON"),
    };
    let field = |k: &str| parsed.get(k).and_then(Value::as_str).unwrap_or_default();
    let (message_id, channel_id, added_by) =
        (field("message_id"), field("channel_id"), field("added_by"));
    if !is_snowflake(message_id) || !is_snowflake(channel_id) {
        return bad_request("message_id and channel_id must be snowflakes");
    }

    let added = app.store.add(
        &guild_id,
        channel_id,
        message_id,
        added_by,
        app.permanent_slots,
    );
    let outcome = match added {
        Ok(o) => o,
        Err(err) => return internal_error(err),
    };
    match app.store.list(&guild_id) {
        Ok(rows) => match outcome {
            store::Add::Added | store::Add::Already => slots_json(&app, &rows).into_response(),
            store::Add::Full => {
                (StatusCode::CONFLICT, slots_error_json(&app, &rows, "slots_full"))
                    .into_response()
            }
        },
        Err(err) => internal_error(err),
    }
}

/// `DELETE /permanent/:guild_id/:message_id` — give the slot back.
async fn permanent_remove(
    State(app): State<Arc<App>>,
    Path((guild_id, message_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if let Some(denied) = deny_internal(&app, &headers, &[&guild_id, &message_id]) {
        return denied;
    }
    let removed = match app.store.remove(&guild_id, &message_id) {
        Ok(r) => r,
        Err(err) => return internal_error(err),
    };
    if !removed {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "not_permanent" })),
        )
            .into_response();
    }
    match app.store.list(&guild_id) {
        Ok(rows) => slots_json(&app, &rows).into_response(),
        Err(err) => internal_error(err),
    }
}

/// Shared admission check for the management API: bearer token (constant-time
/// compare; a missing INTERNAL_API_TOKEN disables the API outright) and
/// snowflake-shaped path ids. `None` means proceed.
fn deny_internal(app: &App, headers: &HeaderMap, ids: &[&str]) -> Option<Response> {
    let Some(expected) = app.internal_token.as_deref() else {
        return Some(
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "permanent API disabled (INTERNAL_API_TOKEN unset)" })),
            )
                .into_response(),
        );
    };
    let supplied = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();
    if !constant_time_eq(supplied.as_bytes(), expected.as_bytes()) {
        return Some((StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" }))).into_response());
    }
    if ids.iter().any(|id| !is_snowflake(id)) {
        return Some(bad_request("ids must be snowflakes"));
    }
    None
}

/// The slot state every management response carries. `ttl_days` is null when
/// components never expire on this deployment (COMPONENT_TTL_DAYS=0) — the
/// dashboard hides the feature then.
fn slots_json(app: &App, rows: &[store::PermanentRow]) -> Json<Value> {
    Json(json!({
        "cap": app.permanent_slots,
        "used": rows.len(),
        "ttl_days": app.component_ttl_ms.map(|ms| ms / 86_400_000),
        "items": rows.iter().map(|r| json!({
            "message_id": r.message_id,
            "channel_id": r.channel_id,
            "added_at": r.added_at,
        })).collect::<Vec<_>>(),
    }))
}

/// Same state plus an error code, for the 409 slots-full response.
fn slots_error_json(app: &App, rows: &[store::PermanentRow], error: &str) -> Json<Value> {
    let mut body = slots_json(app, rows).0;
    body["error"] = json!(error);
    Json(body)
}

fn bad_request(message: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response()
}

fn internal_error(err: rusqlite::Error) -> Response {
    tracing::error!(%err, "permanent store error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "storage error" })),
    )
        .into_response()
}

/// Byte-wise comparison that doesn't leak the match length through timing.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
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
