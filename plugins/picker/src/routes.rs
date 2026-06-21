//! HTTP surface: registry, config iframe, the config API (`/api/instances`), and
//! the Discord interactions endpoint.

use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Json, Response},
};
use serde_json::{json, Value};

use crate::config::Config;
use crate::discord::{self, PickContext};
use crate::store::{InstanceConfig, MaskedInstance, Store};
use crate::validate;

/// Every minted `custom_id` starts with this; the dispatcher routes on it.
const PREFIX: &str = "picker:";

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    pub config: Arc<Config>,
}

pub async fn health() -> &'static str {
    "ok"
}

/// The DWEEB plugin registry payload — points at this service's own config UI.
pub async fn registry(State(state): State<AppState>) -> Json<Value> {
    let base = &state.config.public_base_url;
    Json(json!({
        "schemaVersion": 1,
        "plugins": [{
            "schemaVersion": 1,
            "id": "picker",
            "name": "Picker",
            "description": "Attach to a User / Role / Mentionable / Channel select — a member's picks come back as mentions in a private confirmation. No bot needed.",
            "version": env!("CARGO_PKG_VERSION"),
            "publisher": "DWEEB",
            "homepage": "https://github.com/FaizoKen/DWEEB/tree/main/plugins/picker",
            "targets": ["user_select", "role_select", "mentionable_select", "channel_select"],
            "configUrl": format!("{base}/config.html"),
            "customIdPrefix": PREFIX
        }]
    }))
}

/// The configuration iframe, embedded in the binary so the deploy is one file.
pub async fn config_html() -> Html<&'static str> {
    Html(include_str!("../static/config.html"))
}

// ── /api/instances ───────────────────────────────────────────────────────────

/// Create a new instance. Returns `{ id }`; the caller wraps it as
/// `custom_id = "picker:<id>"`.
pub async fn create_instance(
    State(state): State<AppState>,
    Json(cfg): Json<InstanceConfig>,
) -> Response {
    if let Err(e) = validate::validate_config(&cfg) {
        return bad_request(e);
    }
    let id = new_instance_id();
    match state.store.create(&id, &cfg) {
        Ok(()) => (StatusCode::CREATED, Json(json!({ "id": id }))).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "create instance");
            storage_error()
        }
    }
}

/// Replace an instance's config.
pub async fn update_instance(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(cfg): Json<InstanceConfig>,
) -> Response {
    if let Err(e) = validate::validate_config(&cfg) {
        return bad_request(e);
    }
    match state.store.update(&id, &cfg) {
        Ok(true) => Json(json!({ "id": id })).into_response(),
        Ok(false) => not_found(),
        Err(e) => {
            tracing::error!(error = %e, "update instance");
            storage_error()
        }
    }
}

/// Read an instance for the config UI (no secrets to mask).
pub async fn get_instance(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.store.get(&id) {
        Ok(Some(config)) => Json(MaskedInstance { id, config }).into_response(),
        Ok(None) => not_found(),
        Err(e) => {
            tracing::error!(error = %e, "get instance");
            storage_error()
        }
    }
}

// ── /interactions ────────────────────────────────────────────────────────────

/// Discord interactions webhook. Verifies the signature on the raw body, then
/// dispatches: PING → pong, select use → the resolved-picks reply.
pub async fn interactions(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let signature = headers
        .get("X-Signature-Ed25519")
        .and_then(|v| v.to_str().ok());
    let timestamp = headers
        .get("X-Signature-Timestamp")
        .and_then(|v| v.to_str().ok());
    let (Some(signature), Some(timestamp)) = (signature, timestamp) else {
        return (StatusCode::UNAUTHORIZED, "missing signature").into_response();
    };
    let key_hex = discord::attested_key(&headers, state.config.dispatcher_forward_secret.as_deref())
        .unwrap_or(&state.config.discord_public_key);
    if !discord::verify_signature(key_hex, signature, timestamp, &body) {
        return (StatusCode::UNAUTHORIZED, "invalid signature").into_response();
    }

    let interaction: discord::Interaction = match serde_json::from_slice(&body) {
        Ok(i) => i,
        Err(_) => return (StatusCode::BAD_REQUEST, "malformed interaction").into_response(),
    };

    match interaction.kind {
        discord::TYPE_PING => Json(discord::pong()).into_response(),
        discord::TYPE_MESSAGE_COMPONENT => handle_component(&state, &interaction),
        _ => Json(discord::ephemeral_text("Unsupported interaction.")).into_response(),
    }
}

/// Select use → load config, resolve the picks, reply.
fn handle_component(state: &AppState, interaction: &discord::Interaction) -> Response {
    let Some(id) = interaction.custom_id().strip_prefix(PREFIX) else {
        return Json(discord::ephemeral_text("Unknown action.")).into_response();
    };

    let cfg = match state.store.get(id) {
        Ok(Some(c)) => c,
        Ok(None) => {
            return Json(discord::ephemeral_text(
                "This menu is no longer set up. Ask an admin to recreate it.",
            ))
            .into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "component lookup");
            return Json(discord::ephemeral_text("Something went wrong on my end.")).into_response();
        }
    };

    let picks = interaction.picks();
    // A min-0 menu can be submitted empty — there's nothing to confirm or
    // announce, so reply privately and post nothing public.
    if picks.is_empty() {
        return Json(discord::ephemeral_text("You didn't pick anything.")).into_response();
    }

    let Some(user_id) = interaction.actor_id() else {
        return Json(discord::ephemeral_text("I couldn't tell who picked — try again.")).into_response();
    };
    let server_name = if cfg.guild_name.trim().is_empty() {
        "the server".to_string()
    } else {
        cfg.guild_name.clone()
    };
    let ctx = PickContext {
        user_id: user_id.to_string(),
        user_name: interaction.actor_name(),
        server_name,
        picks,
    };

    Json(discord::build_reply(&cfg, &ctx)).into_response()
}

// ── helpers ──────────────────────────────────────────────────────────────────

fn new_instance_id() -> String {
    // 128 bits of entropy. This id lives in the (Discord-side) custom_id and is
    // the capability to reconfigure, so it must be unguessable.
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("CSPRNG unavailable");
    hex::encode(bytes)
}

fn bad_request(message: String) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response()
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "Unknown instance." }))).into_response()
}

fn storage_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "Storage error." })),
    )
        .into_response()
}
