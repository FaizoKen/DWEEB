//! HTTP surface: registry, config iframe, config API, and the Discord
//! interactions endpoint.

use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Json, Response},
};
use serde_json::{json, Value};

use crate::config::Config;
use crate::discord;
use crate::store::{InstanceConfig, MaskedInstance, Store};
use crate::validate;

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    pub http: reqwest::Client,
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
            "id": "modal-form",
            "name": "Modal Form",
            "description": "Open a modal on click, forward the answers to a webhook, and reply with a saved message.",
            "version": env!("CARGO_PKG_VERSION"),
            "publisher": "DWEEB",
            "homepage": "https://github.com/FaizoKen/DWEEB/tree/main/plugins/modal-form",
            "targets": ["button"],
            "configUrl": format!("{base}/config.html"),
            "customIdPrefix": "modalform:"
        }]
    }))
}

/// The configuration iframe, embedded in the binary so the deploy is one file.
pub async fn config_html() -> Html<&'static str> {
    Html(include_str!("../static/config.html"))
}

/// Create a new instance. Returns `{ id }`; the caller wraps it as
/// `custom_id = "modalform:<id>"`.
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

/// Replace an instance's config. An empty `forward_webhook` means "keep the
/// existing one" — the browser never receives the secret to echo back.
pub async fn update_instance(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(mut cfg): Json<InstanceConfig>,
) -> Response {
    if cfg.forward_webhook.trim().is_empty() {
        match state.store.get(&id) {
            Ok(Some(existing)) => cfg.forward_webhook = existing.forward_webhook,
            Ok(None) => return not_found(),
            Err(e) => {
                tracing::error!(error = %e, "update lookup");
                return storage_error();
            }
        }
    }
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

/// Read an instance for the config UI, with the webhook secret masked out.
pub async fn get_instance(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.store.get(&id) {
        Ok(Some(cfg)) => Json(MaskedInstance {
            id,
            modal: cfg.modal,
            reply: cfg.reply,
            forward_webhook_set: !cfg.forward_webhook.trim().is_empty(),
        })
        .into_response(),
        Ok(None) => not_found(),
        Err(e) => {
            tracing::error!(error = %e, "get instance");
            storage_error()
        }
    }
}

/// Discord interactions webhook. Verifies the signature on the raw body, then
/// dispatches: PING → pong, button click → modal, modal submit → forward+reply.
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
    if !discord::verify_signature(&state.config.discord_public_key, signature, timestamp, &body) {
        return (StatusCode::UNAUTHORIZED, "invalid signature").into_response();
    }

    let interaction: discord::Interaction = match serde_json::from_slice(&body) {
        Ok(i) => i,
        Err(_) => return (StatusCode::BAD_REQUEST, "malformed interaction").into_response(),
    };

    match interaction.kind {
        discord::TYPE_PING => Json(discord::pong()).into_response(),
        discord::TYPE_MESSAGE_COMPONENT => handle_component(&state, &interaction),
        discord::TYPE_MODAL_SUBMIT => handle_modal_submit(&state, &interaction).await,
        _ => Json(discord::ephemeral_text("Unsupported interaction.")).into_response(),
    }
}

/// Button click → respond with the configured modal.
fn handle_component(state: &AppState, interaction: &discord::Interaction) -> Response {
    let custom_id = interaction
        .data
        .as_ref()
        .and_then(|d| d.custom_id.as_deref())
        .unwrap_or_default();
    let Some(id) = custom_id.strip_prefix("modalform:") else {
        return Json(discord::ephemeral_text("Unknown action.")).into_response();
    };
    match state.store.get(id) {
        Ok(Some(cfg)) => {
            let submit_id = format!("modalform_submit:{id}");
            Json(discord::modal_response(&submit_id, &cfg.modal)).into_response()
        }
        Ok(None) => Json(discord::ephemeral_text("This form is no longer available.")).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "component lookup");
            Json(discord::ephemeral_text("Something went wrong.")).into_response()
        }
    }
}

/// Modal submit → forward the answers to the webhook, then reply with the saved
/// message. The forward is best-effort (short timeout); it must never block or
/// fail the user-facing reply, which Discord expects within ~3s.
async fn handle_modal_submit(state: &AppState, interaction: &discord::Interaction) -> Response {
    let Some(data) = interaction.data.as_ref() else {
        return Json(discord::ephemeral_text("Empty submission.")).into_response();
    };
    let custom_id = data.custom_id.as_deref().unwrap_or_default();
    let Some(id) = custom_id.strip_prefix("modalform_submit:") else {
        return Json(discord::ephemeral_text("Unknown form.")).into_response();
    };
    let cfg = match state.store.get(id) {
        Ok(Some(c)) => c,
        Ok(None) => {
            return Json(discord::ephemeral_text("This form is no longer available.")).into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "submit lookup");
            return Json(discord::ephemeral_text("Something went wrong.")).into_response();
        }
    };

    let values = discord::collect_modal_values(data);
    let submitter = interaction
        .member
        .as_ref()
        .and_then(|m| m.user.as_ref())
        .or(interaction.user.as_ref());
    let forward = discord::build_forward_message(&cfg.modal, &values, submitter);

    match state.http.post(&cfg.forward_webhook).json(&forward).send().await {
        Ok(resp) if resp.status().is_success() => {}
        Ok(resp) => tracing::warn!(status = %resp.status(), "forward webhook returned non-2xx"),
        Err(e) => tracing::warn!(error = %e, "forward webhook failed"),
    }

    Json(discord::reply_with_payload(&cfg.reply)).into_response()
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
