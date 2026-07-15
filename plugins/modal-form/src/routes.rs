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
use crate::store::{EditLookup, InstanceConfig, MaskedInstance, Store};
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
            "description": "Pop up a form on click, forward the answers to a channel (named or anonymous), and reply privately. Optional one-response-per-person.",
            "version": env!("CARGO_PKG_VERSION"),
            "publisher": "DWEEB",
            "homepage": "https://github.com/FaizoKen/DWEEB/tree/main/plugins/modal-form",
            "targets": ["button"],
            "resources": ["savedWebhooks", "savedWebhook"],
            "configUrl": format!("{base}/config.html"),
            "customIdPrefix": "modalform:",
            "apiVersion": 2
        }]
    }))
}

/// The configuration iframe, embedded in the binary so the deploy is one file.
pub async fn config_html() -> Html<&'static str> {
    Html(include_str!("../static/config.html"))
}

/// Create a new instance. The edit credential is returned exactly once here;
/// SQLite stores only its SHA-256 digest.
/// `custom_id = "modalform:<id>"`.
pub async fn create_instance(
    State(state): State<AppState>,
    Json(cfg): Json<InstanceConfig>,
) -> Response {
    if let Err(e) = validate::validate_config(&cfg) {
        return bad_request(e);
    }
    let id = new_instance_id();
    let edit_token = new_edit_token();
    match state.store.create(&id, &edit_token, &cfg) {
        Ok(()) => (
            StatusCode::CREATED,
            Json(json!({ "id": id, "managementToken": edit_token })),
        )
            .into_response(),
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
    headers: HeaderMap,
    Json(mut cfg): Json<InstanceConfig>,
) -> Response {
    let Some(edit_token) = edit_token_from_headers(&headers) else {
        return edit_forbidden();
    };
    let existing = match state.store.get_for_edit(&id, edit_token) {
        Ok(EditLookup::Authorized(existing)) => existing,
        Ok(EditLookup::Unknown) => return not_found(),
        Ok(EditLookup::Forbidden) => return edit_forbidden(),
        Err(e) => {
            tracing::error!(error = %e, "update authorization lookup");
            return storage_error();
        }
    };
    if cfg.forward_webhook.trim().is_empty() {
        cfg.forward_webhook = existing.forward_webhook;
    }
    if let Err(e) = validate::validate_config(&cfg) {
        return bad_request(e);
    }
    match state.store.update(&id, edit_token, &cfg) {
        Ok(true) => Json(json!({ "id": id })).into_response(),
        Ok(false) => edit_forbidden(),
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
            forward_username: cfg.forward_username,
            include_submitter: cfg.include_submitter,
            limit_one: cfg.limit_one,
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
    let key_hex =
        discord::attested_key(&headers, state.config.dispatcher_forward_secret.as_deref())
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
        discord::TYPE_MODAL_SUBMIT => handle_modal_submit(&state, &interaction).await,
        _ => Json(discord::ephemeral_text("Unsupported interaction.")).into_response(),
    }
}

/// Button click → respond with the configured modal, unless this form is
/// one-response-per-person and the member already submitted (turned away here,
/// before the modal opens, so they never fill in a form that would be rejected).
fn handle_component(state: &AppState, interaction: &discord::Interaction) -> Response {
    let custom_id = interaction
        .data
        .as_ref()
        .and_then(|d| d.custom_id.as_deref())
        .unwrap_or_default();
    let Some(id) = custom_id.strip_prefix("modalform:") else {
        return Json(discord::ephemeral_text("Unknown action.")).into_response();
    };
    let cfg = match state.store.get(id) {
        Ok(Some(c)) => c,
        Ok(None) => {
            return Json(discord::ephemeral_text("This form is no longer available."))
                .into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "component lookup");
            return Json(discord::ephemeral_text("Something went wrong.")).into_response();
        }
    };

    if cfg.limit_one {
        if let Some(uid) = interaction.actor_id() {
            // Fail *open* on a storage hiccup: better to let a member submit
            // (perhaps twice) than to wall off a working form behind a DB blip.
            match state.store.has_submitted(id, uid) {
                Ok(true) => return Json(discord::ephemeral_text(
                    "You've already submitted this form — only one response per person is allowed.",
                ))
                .into_response(),
                Ok(false) => {}
                Err(e) => tracing::warn!(error = %e, "has_submitted check"),
            }
        }
    }

    // Keep the submit id under the plugin's own `modalform:` prefix so the
    // dispatcher routes it back here (it matches on prefix, and a plugin owns
    // exactly one custom_id namespace). The interaction *type* — not this id —
    // is what tells a click apart from a submit.
    let submit_id = format!("modalform:submit:{id}");
    Json(discord::modal_response(&submit_id, &cfg.modal)).into_response()
}

/// Modal submit → forward the answers to the webhook, then reply with the
/// configured message. The forward runs on a short timeout so the user-facing
/// reply always lands within Discord's ~3s window — but when it *fails*, the
/// reply says so (never the configured "thanks" — that would silently swallow
/// the submission). For a one-response-per-person form, the submission is
/// recorded only when the forward actually reached the destination, so a
/// transient failure can't lock the member out forever.
async fn handle_modal_submit(state: &AppState, interaction: &discord::Interaction) -> Response {
    let Some(data) = interaction.data.as_ref() else {
        return Json(discord::ephemeral_text("Empty submission.")).into_response();
    };
    let custom_id = data.custom_id.as_deref().unwrap_or_default();
    let Some(id) = custom_id.strip_prefix("modalform:submit:") else {
        return Json(discord::ephemeral_text("Unknown form.")).into_response();
    };
    let cfg = match state.store.get(id) {
        Ok(Some(c)) => c,
        Ok(None) => {
            return Json(discord::ephemeral_text("This form is no longer available."))
                .into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "submit lookup");
            return Json(discord::ephemeral_text("Something went wrong.")).into_response();
        }
    };

    let values = discord::collect_modal_values(data);
    let forward = discord::build_forward_message(&cfg, &values, interaction.actor());

    // `with_components=true` is required for Discord to respect the V2
    // components on the execute (without it they're silently dropped).
    let forwarded_ok = match state
        .http
        .post(&cfg.forward_webhook)
        .query(&[("with_components", "true")])
        .json(&forward)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => true,
        Ok(resp) => {
            tracing::warn!(status = %resp.status(), "forward webhook returned non-2xx");
            false
        }
        Err(e) => {
            let kind = if e.is_timeout() {
                "timeout"
            } else if e.is_connect() {
                "connect"
            } else {
                "transport"
            };
            tracing::warn!(kind, "forward webhook failed");
            false
        }
    };

    // A failed forward means the answers went nowhere — say so instead of
    // sending the configured "thanks, recorded" reply, which would silently
    // swallow the submission. Nothing was recorded (the one-per-person mark
    // below only lands on success), so trying again is safe and honest.
    if !forwarded_ok {
        return Json(discord::ephemeral_text(
            "\u{26A0}\u{FE0F} Your answers couldn't be delivered just now, so nothing was \
             recorded — please submit the form again in a moment.",
        ))
        .into_response();
    }

    if cfg.limit_one {
        if let Some(uid) = interaction.actor_id() {
            if let Err(e) = state.store.record_submission(id, uid) {
                tracing::warn!(error = %e, "record submission");
            }
        }
    }

    Json(discord::build_reply(&cfg.reply)).into_response()
}

// ── helpers ──────────────────────────────────────────────────────────────────

fn new_instance_id() -> String {
    // The id is an opaque public binding, not the edit credential.
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("CSPRNG unavailable");
    hex::encode(bytes)
}

fn new_edit_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("CSPRNG unavailable");
    hex::encode(bytes)
}

const EDIT_TOKEN_HEADER: &str = "x-dweeb-plugin-edit-token";

fn edit_token_from_headers(headers: &HeaderMap) -> Option<&str> {
    let token = headers.get(EDIT_TOKEN_HEADER)?.to_str().ok()?;
    (token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit())).then_some(token)
}

fn bad_request(message: String) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response()
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "Unknown instance." })),
    )
        .into_response()
}

fn edit_forbidden() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({
            "error": "This browser does not have edit access. Save again to create a replacement instance."
        })),
    )
        .into_response()
}

fn storage_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "Storage error." })),
    )
        .into_response()
}
