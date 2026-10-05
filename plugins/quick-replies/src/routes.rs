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
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::Config;
use crate::discord::{self, ReplyContext};
use crate::media;
use crate::rest;
use crate::store::{EditLookup, InstanceConfig, MaskedInstance, Store};
use crate::validate;

/// Every minted `custom_id` starts with this; the dispatcher routes on it.
const PREFIX: &str = "quickreplies:";

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    pub http: reqwest::Client,
    pub config: Arc<Config>,
    pub primary_key: ed25519_dalek::VerifyingKey,
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
            "id": "quick-replies",
            "name": "Quick Replies",
            "description": "Attach canned replies to a button or topic menu — each one sends text, links and {user}/{server} variables privately or publicly, with optional role-gating.",
            "version": env!("CARGO_PKG_VERSION"),
            "publisher": "DWEEB",
            "homepage": "https://github.com/FaizoKen/DWEEB/tree/main/plugins/quick-replies",
            "targets": ["button", "string_select"],
            "configUrl": format!("{base}/config.html"),
            "customIdPrefix": PREFIX,
            "managesSelectOptions": true,
            "apiVersion": 2
        }]
    }))
}

/// The configuration iframe, embedded in the binary so the deploy is one file.
pub async fn config_html() -> Html<&'static str> {
    Html(include_str!("../static/config.html"))
}

/// Capabilities the config UI adapts to: whether the shared bot is configured
/// (so it can list roles for the gate picker) and, if so, how to invite it.
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

/// Probe a guild with the shared bot and return its roles for the gate picker.
/// Never stores anything — saving happens via `/api/instances`.
pub async fn connect(State(state): State<AppState>, Json(req): Json<ConnectRequest>) -> Response {
    if !validate::is_snowflake(req.guild_id.trim()) {
        return bad_request(
            "That server id doesn't look right — it should be 17–20 digits.".into(),
        );
    }
    let Some(token) = state.config.default_bot_token.as_deref() else {
        return bad_request(
            "This deployment has no shared bot configured, so role-gating can't be set up here."
                .into(),
        );
    };
    match rest::connect(&state.http, token, req.guild_id.trim()).await {
        Ok(result) => Json(json!(result)).into_response(),
        Err(e) => (e.status(), Json(json!({ "error": e.message() }))).into_response(),
    }
}

// ── /api/instances ───────────────────────────────────────────────────────────

/// Create a new instance. The edit credential is returned exactly once here;
/// SQLite stores only its SHA-256 digest. The caller wraps the id as
/// `custom_id = "quickreplies:<id>"`.
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

/// Replace an instance's config. The instance id is a public binding (it lives
/// in the message's `custom_id`), so this requires the separate edit token.
pub async fn update_instance(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(cfg): Json<InstanceConfig>,
) -> Response {
    let Some(edit_token) = edit_token_from_headers(&headers) else {
        return edit_forbidden();
    };
    match state.store.authorize_edit(&id, edit_token) {
        Ok(EditLookup::Authorized) => {}
        Ok(EditLookup::Unknown) => return not_found(),
        Ok(EditLookup::Forbidden) => return edit_forbidden(),
        Err(e) => {
            tracing::error!(error = %e, "update authorization lookup");
            return storage_error();
        }
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

/// Read an instance for the config UI.
///
/// The id alone is public (it's in the posted component's `custom_id`), so a
/// role-gated reply's message is only returned to a request carrying the edit
/// token; anyone else gets the menu with that message withheld (see
/// [`MaskedInstance::public_view`]). A wrong token reads the same as none.
pub async fn get_instance(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let config = match state.store.get(&id) {
        Ok(Some(config)) => config,
        Ok(None) => return not_found(),
        Err(e) => {
            tracing::error!(error = %e, "get instance");
            return storage_error();
        }
    };
    let authorized = match edit_token_from_headers(&headers) {
        None => false,
        Some(token) => match state.store.authorize_edit(&id, token) {
            Ok(EditLookup::Authorized) => true,
            Ok(_) => false,
            Err(e) => {
                tracing::error!(error = %e, "read authorization lookup");
                false
            }
        },
    };
    let view = if authorized {
        MaskedInstance::full(id, config)
    } else {
        MaskedInstance::public_view(id, config)
    };
    Json(view).into_response()
}

// ── /interactions ────────────────────────────────────────────────────────────

/// Discord interactions webhook. Verifies the signature on the raw body, then
/// dispatches: PING → pong, component click → the matched reply.
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
    let attested =
        discord::attested_key(&headers, state.config.dispatcher_forward_secret.as_deref());
    let verified = match attested {
        Some(key) if !key.eq_ignore_ascii_case(&state.config.discord_public_key) => {
            discord::verify_signature(key, signature, timestamp, &body)
        }
        _ => discord::verify_signature_with_key(&state.primary_key, signature, timestamp, &body),
    };
    if !verified {
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

/// Component click → load config, pick the matching reply, gate-check, reply.
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
            return Json(discord::ephemeral_text("Something went wrong on my end."))
                .into_response();
        }
    };

    // Which reply did this click ask for?
    //   • a button maps to its single reply;
    //   • a select maps the first picked option value back to its reply — the
    //     value IS the reply key (DWEEB wired + locked the options), and we only
    //     ever act on a value we recognise, never a raw client-supplied one.
    let reply = if interaction.is_button() {
        cfg.replies.first()
    } else {
        interaction
            .picked_values()
            .iter()
            .find_map(|v| cfg.reply_for(v))
    };
    let Some(reply) = reply else {
        return Json(discord::ephemeral_text(
            "That option isn't available anymore — the menu may have been reconfigured.",
        ))
        .into_response();
    };

    // Role gate: re-derive trust from the member's payload roles. A gated reply
    // outside a guild (no member) has no roles to match, so it fails closed.
    let member_roles: BTreeSet<String> = interaction.actor_roles().iter().cloned().collect();
    if !discord::reply_allowed(&reply.allowed_roles, &member_roles) {
        return Json(discord::gate_denied(&reply.allowed_roles)).into_response();
    }

    let Some(user_id) = interaction.actor_id() else {
        return Json(discord::ephemeral_text(
            "I couldn't tell who clicked — try again.",
        ))
        .into_response();
    };
    let server_name = if cfg.guild_name.trim().is_empty() {
        "the server".to_string()
    } else {
        cfg.guild_name.clone()
    };
    let ctx = ReplyContext {
        user_id: user_id.to_string(),
        user_name: interaction.actor_name(),
        server_name,
    };

    // A reply saved before uploads were refused still names one; it goes out
    // without those pictures (see `media`). Info, never a page: the member got
    // their reply, and only the admin can fix the saved message.
    let left_out = reply
        .payload
        .as_ref()
        .and_then(|p| p.get("components"))
        .and_then(Value::as_array)
        .map_or(0, |c| media::unsendable_media(c).len());
    if left_out > 0 {
        tracing::info!(
            instance = id,
            reply = %reply.key,
            left_out,
            "sent a saved reply without the pictures it can't send"
        );
    }

    Json(discord::build_reply(reply, &ctx)).into_response()
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

fn edit_forbidden() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({
            "error": "This browser does not have edit access. Save again to create a replacement instance."
        })),
    )
        .into_response()
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{QuickReply, RoleRef};

    const KEY: &str = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

    fn test_state() -> AppState {
        AppState {
            store: Arc::new(Store::open(":memory:").unwrap()),
            http: reqwest::Client::new(),
            config: Arc::new(Config {
                port: 0,
                public_base_url: String::new(),
                discord_public_key: KEY.into(),
                dispatcher_forward_secret: None,
                database_path: String::new(),
                default_bot_token: None,
                bot_invite_url: None,
            }),
            primary_key: discord::parse_verifying_key(KEY).unwrap(),
        }
    }

    fn reply(key: &str, body: &str, gated: bool) -> QuickReply {
        QuickReply {
            key: key.into(),
            label: format!("Topic {key}"),
            emoji: None,
            emoji_id: None,
            emoji_animated: None,
            description: None,
            title: Some(format!("Heading {key}")),
            payload: None,
            body: body.into(),
            ephemeral: true,
            allowed_roles: if gated {
                vec![RoleRef {
                    id: "123456789012345678".into(),
                    name: "Subscriber".into(),
                    color: 0,
                }]
            } else {
                vec![]
            },
        }
    }

    async fn read(state: &AppState, token: Option<&str>) -> (StatusCode, Value) {
        let mut headers = HeaderMap::new();
        if let Some(token) = token {
            headers.insert(EDIT_TOKEN_HEADER, token.parse().unwrap());
        }
        let resp = get_instance(State(state.clone()), Path("abc".to_string()), headers).await;
        let status = resp.status();
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }

    /// A role-gated reply's message must not be readable by anyone who saw the
    /// public id in the component's `custom_id` — only by the browser holding
    /// the edit token. The open reply beside it reads as before.
    #[tokio::test]
    async fn a_gated_replys_content_is_not_readable_without_edit_access() {
        let state = test_state();
        let token = "d".repeat(64);
        let cfg = InstanceConfig {
            target: "string_select".into(),
            guild_id: None,
            guild_name: String::new(),
            replies: vec![
                reply("k1", "Welcome! Read the rules.", false),
                reply(
                    "k2",
                    "Subscriber-only download: https://example.com/secret-build.zip",
                    true,
                ),
            ],
        };
        state.store.create("abc", &token, &cfg).unwrap();

        for presented in [None, Some("e".repeat(64))] {
            let (status, body) = read(&state, presented.as_deref()).await;
            assert_eq!(status, StatusCode::OK);
            let text = body.to_string();
            assert!(!text.contains("secret-build.zip"), "{text}");
            assert!(!text.contains("Heading k2"), "{text}");
            // The topic and its gate stay, so the form still shows the menu.
            assert_eq!(body["replies"][1]["label"], "Topic k2");
            assert_eq!(body["withheld"], serde_json::json!(["k2"]));
            assert_eq!(body["replies"][0]["body"], "Welcome! Read the rules.");
        }

        let (status, body) = read(&state, Some(&token)).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.to_string().contains("secret-build.zip"));
        assert!(body.get("withheld").is_none(), "{body}");
    }
}
