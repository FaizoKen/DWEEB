//! HTTP surface: registry, config iframe, the config API (`/api/meta`,
//! `/api/connect`, `/api/instances`), and the Discord interactions endpoint.

use std::collections::BTreeSet;
use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Json, Response},
};
use futures::future::join_all;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::Config;
use crate::discord::{self, plan_changes};
use crate::rest;
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
            "id": "self-role",
            "name": "Self Role",
            "description": "Let members give themselves roles from a button or select menu — toggle, give, take, or pick-one.",
            "version": env!("CARGO_PKG_VERSION"),
            "publisher": "DWEEB",
            "homepage": "https://github.com/FaizoKen/DWEEB/tree/main/plugins/self-role",
            "targets": ["button", "string_select"],
            "configUrl": format!("{base}/config.html"),
            "customIdPrefix": "selfrole:",
            "placeholders": [
                { "token": "roles", "label": "Roles", "sample": "the role" }
            ]
        }]
    }))
}

/// The configuration iframe, embedded in the binary so the deploy is one file.
pub async fn config_html() -> Html<&'static str> {
    Html(include_str!("../static/config.html"))
}

/// Capabilities the config UI adapts to: whether the shared bot is configured
/// (so the UI can warn when it isn't) and, if so, how to invite it.
pub async fn meta(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "apiVersion": 1,
        "defaultBot": state.config.has_default_bot(),
        "inviteUrl": state.config.bot_invite_url,
    }))
}

// ── /api/connect ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ConnectRequest {
    guild_id: String,
}

/// Probe a guild with the shared bot and return its assignable roles for the
/// picker. Never stores anything — saving happens via `/api/instances`.
pub async fn connect(State(state): State<AppState>, Json(req): Json<ConnectRequest>) -> Response {
    if !validate::is_snowflake(req.guild_id.trim()) {
        return bad_request("That server id doesn't look right — it should be 17–20 digits.".into());
    }
    let Some(token) = state.config.default_bot_token.as_deref() else {
        return bad_request("This deployment has no Self Role bot configured.".into());
    };

    match rest::connect(&state.http, token, req.guild_id.trim()).await {
        Ok(result) => Json(json!(result)).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e.message() }))).into_response(),
    }
}

// ── /api/instances ───────────────────────────────────────────────────────────

/// Create a new instance. Returns `{ id }`; the caller wraps it as
/// `custom_id = "selfrole:<id>"`.
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

/// Read an instance for the config UI.
pub async fn get_instance(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.store.get(&id) {
        Ok(Some(cfg)) => Json(MaskedInstance {
            id,
            target: cfg.target,
            guild_id: cfg.guild_id,
            guild_name: cfg.guild_name,
            roles: cfg.roles,
            mode: cfg.mode,
            response: cfg.response,
        })
        .into_response(),
        Ok(None) => not_found(),
        Err(e) => {
            tracing::error!(error = %e, "get instance");
            storage_error()
        }
    }
}

// ── /interactions ────────────────────────────────────────────────────────────

/// Discord interactions webhook. Verifies the signature on the raw body, then
/// dispatches: PING → pong, component click → apply the role change.
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
        discord::TYPE_MESSAGE_COMPONENT => handle_component(&state, &interaction).await,
        _ => Json(discord::ephemeral_text("Unsupported interaction.")).into_response(),
    }
}

/// Component click → load config, plan the role change, apply it, confirm.
async fn handle_component(state: &AppState, interaction: &discord::Interaction) -> Response {
    let custom_id = interaction
        .data
        .as_ref()
        .and_then(|d| d.custom_id.as_deref())
        .unwrap_or_default();
    let Some(id) = custom_id.strip_prefix("selfrole:") else {
        return Json(discord::ephemeral_text("Unknown action.")).into_response();
    };

    let cfg = match state.store.get(id) {
        Ok(Some(c)) => c,
        Ok(None) => {
            return Json(discord::ephemeral_text(
                "This role menu is no longer set up. Ask an admin to recreate it.",
            ))
            .into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "component lookup");
            return Json(discord::ephemeral_text("Something went wrong on my end.")).into_response();
        }
    };

    // Self-roles only make sense inside the guild they were configured for.
    let Some(guild_id) = interaction.guild_id.as_deref() else {
        return Json(discord::ephemeral_text("Use this menu inside the server, not in DMs."))
            .into_response();
    };
    if guild_id != cfg.guild_id {
        return Json(discord::ephemeral_text(
            "This menu was set up for a different server, so I can't change roles here.",
        ))
        .into_response();
    }

    // The token that actually does the work: the deployment-wide shared bot.
    // Unset ⇒ this menu can't function.
    let Some(token) = state.config.default_bot_token.clone() else {
        return Json(discord::ephemeral_text(
            "This menu isn't finished — no bot is connected. Ask an admin to reconfigure it.",
        ))
        .into_response();
    };

    let Some(user_id) = interaction.actor_id() else {
        return Json(discord::ephemeral_text("I couldn't tell who clicked — try again.")).into_response();
    };

    let managed: BTreeSet<String> = cfg.roles.iter().map(|r| r.id.clone()).collect();
    let current: BTreeSet<String> = interaction
        .member
        .as_ref()
        .map(|m| m.roles.iter().cloned().collect())
        .unwrap_or_default();
    let requested = interaction.requested_roles(&managed);
    let changes = plan_changes(&managed, &current, &requested, &cfg.mode);

    if changes.is_empty() {
        return Json(discord::build_reply(&cfg, &[], &[], &[], &[])).into_response();
    }

    // Fire every add/remove concurrently so even a multi-role "pick one" swap
    // answers inside Discord's window. Each future carries its own id so we can
    // report exactly what changed and what Discord refused.
    let reason = format!("Self-role via DWEEB ({})", interaction.actor_name());
    let mut futs = Vec::new();
    for rid in &changes.add {
        let (http, token, guild_id, user_id, rid, reason) = (
            state.http.clone(),
            token.clone(),
            guild_id.to_string(),
            user_id.to_string(),
            rid.clone(),
            reason.clone(),
        );
        futs.push(tokio::spawn(async move {
            let res = rest::add_role(&http, &token, &guild_id, &user_id, &rid, &reason).await;
            (rid, true, res) // (role id, is_add, outcome)
        }));
    }
    for rid in &changes.remove {
        let (http, token, guild_id, user_id, rid, reason) = (
            state.http.clone(),
            token.clone(),
            guild_id.to_string(),
            user_id.to_string(),
            rid.clone(),
            reason.clone(),
        );
        futs.push(tokio::spawn(async move {
            let res = rest::remove_role(&http, &token, &guild_id, &user_id, &rid, &reason).await;
            (rid, false, res)
        }));
    }

    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut denied = Vec::new();
    let mut busy = Vec::new();
    for joined in join_all(futs).await {
        let Ok((rid, is_add, res)) = joined else { continue };
        match (res, is_add) {
            (Ok(()), true) => added.push(rid),
            (Ok(()), false) => removed.push(rid),
            (Err(rest::RoleError::Denied), _) => denied.push(rid),
            (Err(rest::RoleError::Busy), _) => busy.push(rid),
        }
    }

    Json(discord::build_reply(&cfg, &added, &removed, &denied, &busy)).into_response()
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
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "Unknown instance." })),
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
