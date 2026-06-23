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
use crate::store::{InstanceConfig, ManagedRole, MaskedInstance, Store};
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
            "description": "Let members self-assign roles from a button or select menu — toggle/give/take, a pick-limit (1 = swap), per-role emoji, a 'who can use this' role gate, auto-expiring roles, and optional audit logging.",
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
        return bad_request(
            "That server id doesn't look right — it should be 17–20 digits.".into(),
        );
    }
    let Some(token) = state.config.default_bot_token.as_deref() else {
        return bad_request("This deployment has no Self Role bot configured.".into());
    };

    match rest::connect(&state.http, token, req.guild_id.trim()).await {
        Ok(result) => Json(json!(result)).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.message() })),
        )
            .into_response(),
    }
}

// ── /api/instances ───────────────────────────────────────────────────────────

/// Create a new instance. Returns `{ id }`; the caller wraps it as
/// `custom_id = "selfrole:<id>"`.
pub async fn create_instance(
    State(state): State<AppState>,
    Json(mut cfg): Json<InstanceConfig>,
) -> Response {
    cfg.normalize();
    // On a fresh create there's nothing to "keep", so an empty webhook is none.
    if cfg.log_webhook.as_deref() == Some("") {
        cfg.log_webhook = None;
    }
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
    Json(mut cfg): Json<InstanceConfig>,
) -> Response {
    cfg.normalize();
    // The browser never receives the audit-log webhook (it's masked), so it
    // can't echo it back. An **empty** `log_webhook` means "keep the existing
    // one"; an explicit **null/absent** means "turn logging off".
    if cfg.log_webhook.as_deref() == Some("") {
        cfg.log_webhook = match state.store.get(&id) {
            Ok(Some(existing)) => existing.log_webhook,
            _ => None,
        };
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

/// Read an instance for the config UI (audit-log webhook masked to a boolean).
pub async fn get_instance(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.store.get(&id) {
        Ok(Some(cfg)) => Json(MaskedInstance::from_config(id, cfg)).into_response(),
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
            return Json(discord::ephemeral_text("Something went wrong on my end."))
                .into_response();
        }
    };

    // Self-roles only make sense inside the guild they were configured for.
    let Some(guild_id) = interaction.guild_id.as_deref() else {
        return Json(discord::ephemeral_text(
            "Use this menu inside the server, not in DMs.",
        ))
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
        return Json(discord::ephemeral_text(
            "I couldn't tell who clicked — try again.",
        ))
        .into_response();
    };

    let managed: BTreeSet<String> = cfg.roles.iter().map(|r| r.id.clone()).collect();
    let member_roles: Vec<String> = interaction
        .member
        .as_ref()
        .map(|m| m.roles.clone())
        .unwrap_or_default();

    // Access gate: a menu can require role(s) and/or a minimum account age
    // before it does anything. A pure check over the interaction payload — no
    // extra Discord call, so it stays well inside the 3s window.
    if !cfg.requirement.is_open() {
        let created = discord::snowflake_to_unix_ms(user_id);
        let access = discord::check_access(&member_roles, created, now_millis(), &cfg.requirement);
        if access != discord::Access::Ok {
            return Json(discord::ephemeral_text(&discord::access_denied_message(
                &cfg.requirement,
                &access,
            )))
            .into_response();
        }
    }

    let current: BTreeSet<String> = member_roles.iter().cloned().collect();
    let requested = interaction.requested_roles(&managed);
    let changes = plan_changes(
        &managed,
        &current,
        &requested,
        &cfg.mode,
        cfg.max.map(|m| m as usize),
    );

    if changes.is_empty() {
        // Nothing actually moved — but a click refused by the pick-limit still
        // needs its own explanation rather than a bare "you're all set".
        return Json(discord::build_reply(
            &cfg,
            &[],
            &[],
            &[],
            &[],
            &changes.blocked,
            None,
        ))
        .into_response();
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
        let Ok((rid, is_add, res)) = joined else {
            continue;
        };
        match (res, is_add) {
            (Ok(()), true) => added.push(rid),
            (Ok(()), false) => removed.push(rid),
            (Err(rest::RoleError::Denied), _) => denied.push(rid),
            (Err(rest::RoleError::Busy), _) => busy.push(rid),
        }
    }

    // Temporary-role bookkeeping: a freshly-granted role gets a removal deadline
    // (the reaper drains it later); a role just taken away clears any pending
    // removal so it isn't double-removed.
    let now = now_millis();
    if let Some(secs) = cfg.expires_after_secs {
        let expires_at = now + secs as i64 * 1000;
        for rid in &added {
            let _ = state
                .store
                .upsert_grant(id, guild_id, user_id, rid, expires_at);
        }
    }
    for rid in &removed {
        let _ = state.store.delete_grant(id, user_id, rid);
    }

    // Audit log: best-effort, fired detached so it never delays the member's
    // confirmation. Only when something actually changed.
    if let Some(url) = cfg.log_webhook.clone() {
        if !added.is_empty() || !removed.is_empty() {
            let line = audit_line(user_id, &added, &removed, &cfg.roles);
            let http = state.http.clone();
            tokio::spawn(async move {
                rest::post_webhook_log(&http, &url, &line).await;
            });
        }
    }

    let expires_at_unix = cfg.expires_after_secs.map(|s| now / 1000 + s as i64);
    Json(discord::build_reply(
        &cfg,
        &added,
        &removed,
        &denied,
        &busy,
        &changes.blocked,
        expires_at_unix,
    ))
    .into_response()
}

// ── helpers ──────────────────────────────────────────────────────────────────

fn new_instance_id() -> String {
    // 128 bits of entropy. This id lives in the (Discord-side) custom_id and is
    // the capability to reconfigure, so it must be unguessable.
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("CSPRNG unavailable");
    hex::encode(bytes)
}

fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// One audit-log line: who changed what. Role names render as bold text (not
/// mentions), and the webhook post defangs mentions anyway, so this can never
/// ping. The `<@id>` actor renders as their name without notifying them.
fn audit_line(
    user_id: &str,
    added: &[String],
    removed: &[String],
    roles: &[ManagedRole],
) -> String {
    let label = |id: &str| {
        roles
            .iter()
            .find(|r| r.id == id)
            .filter(|r| !r.name.trim().is_empty())
            .map(|r| format!("**{}**", r.name))
            .unwrap_or_else(|| format!("<@&{id}>"))
    };
    let names = |ids: &[String]| {
        ids.iter()
            .map(|id| label(id))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut parts = Vec::new();
    if !added.is_empty() {
        parts.push(format!("gained {}", names(added)));
    }
    if !removed.is_empty() {
        parts.push(format!("lost {}", names(removed)));
    }
    format!("\u{1F4DD} <@{user_id}> {}", parts.join("; "))
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
