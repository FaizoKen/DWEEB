//! HTTP surface: registry, config iframe, the config API, and the Discord
//! interactions endpoint.

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
use crate::discord::{self, PREFIX};
use crate::render::{self, MemberState, RenderInput};
use crate::rest::{self, Cache, MemberScanOutcome};
use crate::store::{EditLookup, InstanceConfig, MaskedInstance, Store};
use crate::validate;

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    pub cache: Arc<Cache>,
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
            "id": "directory",
            "name": "Directory",
            "description": "Answer a click with a live list of the server — a grouped staff roster (roles, permission badges, who holds them) or a channel index with each channel's topic. Read-only, always current.",
            "version": env!("CARGO_PKG_VERSION"),
            "publisher": "DWEEB",
            "homepage": "https://github.com/FaizoKen/DWEEB/tree/main/plugins/directory",
            "targets": ["button", "string_select"],
            "requiresBot": true,
            "resources": ["guild"],
            "configUrl": format!("{base}/config.html"),
            "customIdPrefix": PREFIX,
            "apiVersion": 2,
            "defaultEmoji": "\u{1F5C2}\u{FE0F}",
            "managesSelectOptions": true,
            "managesFields": ["min_values", "max_values"],
            "presets": [
                { "id": "directory-staff", "name": "Staff list", "description": "Owners, admins and moderators in named groups, with who holds each role.", "emoji": "\u{1F6E1}\u{FE0F}" },
                { "id": "directory-roles", "name": "Role guide", "description": "Every role the server displays separately, with what each one is for.", "emoji": "\u{1F3AD}" },
                { "id": "directory-channels", "name": "Channel index", "description": "Every channel grouped by category, each with its topic.", "emoji": "\u{1F9ED}" },
                { "id": "directory-start-here", "name": "Start here", "description": "A short, hand-picked list of the channels a new member should read first.", "emoji": "\u{1F44B}" }
            ]
        }]
    }))
}

/// The configuration iframe, embedded in the binary so the deploy is one file.
pub async fn config_html() -> Html<&'static str> {
    Html(include_str!("../static/config.html"))
}

/// Capabilities the config UI adapts to: whether the shared bot is configured at
/// all, and how to invite it.
pub async fn meta(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "apiVersion": 1,
        "defaultBot": state.config.has_default_bot(),
        "inviteUrl": state.config.bot_invite_url,
        "maxMembersPerRole": crate::store::MAX_MEMBERS_PER_ROLE,
    }))
}

// ── /api/connect ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ConnectRequest {
    guild_id: String,
}

/// Read a guild through the shared bot and hand the config UI its roles and
/// channels — plus whether member expansion will actually work here.
pub async fn connect(State(state): State<AppState>, Json(req): Json<ConnectRequest>) -> Response {
    let guild_id = req.guild_id.trim();
    if !validate::is_snowflake(guild_id) {
        return bad_request(
            "That server id doesn't look right — it should be 17–20 digits.".into(),
        );
    }
    let Some(token) = state.config.default_bot_token.as_deref() else {
        return bad_request(
            "This deployment has no shared bot configured, so a directory can't be set up here."
                .into(),
        );
    };

    // The structure read is also the "is the bot in this server?" probe, so run
    // it first: its 404 is the answer the UI needs, and there's no point paying
    // for the identity call if the bot can't see the guild at all.
    let structure = match rest::fetch_structure(&state.http, token, guild_id).await {
        Ok(s) => s,
        Err(e) => return (e.status(), Json(json!({ "error": e.message() }))).into_response(),
    };
    let (bot_id, bot_name, members_available) =
        match rest::identify(&state.http, token, guild_id).await {
            Ok(v) => v,
            Err(e) => return (e.status(), Json(json!({ "error": e.message() }))).into_response(),
        };

    // Opening the config panel is also the natural moment to drop any stale
    // cached read, so the host's next click reflects edits they just made in
    // Discord instead of waiting out the TTL.
    state.cache.invalidate(guild_id);

    Json(json!(rest::ConnectResult {
        structure,
        bot_id,
        bot_name,
        members_available,
    }))
    .into_response()
}

// ── /api/instances ───────────────────────────────────────────────────────────

/// Create a new directory. The edit credential is returned exactly once here;
/// SQLite stores only its SHA-256 digest. The caller wraps the id as
/// `custom_id = "directory:<id>"`.
pub async fn create_instance(
    State(state): State<AppState>,
    Json(mut cfg): Json<InstanceConfig>,
) -> Response {
    cfg.normalize();
    if let Err(e) = validate::validate_config(&cfg) {
        return bad_request(e);
    }
    let id = new_instance_id();
    let edit_token = new_edit_token();
    match state.store.create(&id, &edit_token, &cfg) {
        Ok(()) => {
            state.cache.invalidate(&cfg.guild_id);
            (
                StatusCode::CREATED,
                Json(json!({ "id": id, "managementToken": edit_token })),
            )
                .into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "create instance");
            storage_error()
        }
    }
}

/// Replace a directory's config. The instance id is a public binding (it lives
/// in the message's `custom_id`), so this requires the separate edit token.
pub async fn update_instance(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(mut cfg): Json<InstanceConfig>,
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
    cfg.normalize();
    if let Err(e) = validate::validate_config(&cfg) {
        return bad_request(e);
    }
    match state.store.update(&id, edit_token, &cfg) {
        Ok(true) => {
            state.cache.invalidate(&cfg.guild_id);
            Json(json!({ "id": id })).into_response()
        }
        Ok(false) => edit_forbidden(),
        Err(e) => {
            tracing::error!(error = %e, "update instance");
            storage_error()
        }
    }
}

/// Read an instance for the config UI. A directory holds no secret — the bot is
/// the deployment's, and there is no webhook — so nothing needs masking.
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
/// dispatches: PING → pong, a click → the directory.
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
        discord::TYPE_MESSAGE_COMPONENT => handle_component(&state, interaction).await,
        _ => Json(discord::ephemeral_text("Unsupported interaction.")).into_response(),
    }
}

/// A click → load the config, check the gate, read the server, reply.
async fn handle_component(state: &AppState, interaction: discord::Interaction) -> Response {
    let Some(id) = interaction.custom_id().strip_prefix(PREFIX) else {
        return Json(discord::ephemeral_text("Unknown action.")).into_response();
    };

    let cfg = match state.store.get(id) {
        Ok(Some(c)) => c,
        Ok(None) => {
            return Json(discord::ephemeral_text(
                "This list is no longer set up. Ask an admin to recreate it.",
            ))
            .into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "component lookup");
            return Json(discord::ephemeral_text("Something went wrong on my end."))
                .into_response();
        }
    };

    // A directory is bound to the server it was configured for: its role and
    // channel ids mean nothing anywhere else. Refuse rather than render a list
    // of ids that resolve to nothing.
    let guild_id = interaction.guild_id.clone().unwrap_or_default();
    if guild_id.is_empty() {
        return Json(discord::ephemeral_text(
            "This list only works inside the server it was made for.",
        ))
        .into_response();
    }
    if guild_id != cfg.guild_id {
        return Json(discord::ephemeral_text(
            "This list was set up for a different server, so there's nothing to show here.",
        ))
        .into_response();
    }

    let Some(user_id) = interaction.actor_id() else {
        return Json(discord::ephemeral_text(
            "I couldn't tell who clicked — try again.",
        ))
        .into_response();
    };
    if let Some(denial) =
        discord::gate_denial(&cfg.requirements, interaction.actor_roles(), user_id)
    {
        return Json(discord::ephemeral_text(&denial)).into_response();
    }

    let Some(token) = state.config.default_bot_token.clone() else {
        return Json(discord::ephemeral_text(
            "This list is temporarily unavailable. Try again later.",
        ))
        .into_response();
    };

    // A roster with member expansion has to page the member list, which can
    // outlast Discord's ~3s window — so answer "thinking…" now and edit the real
    // reply in. Everything else is one concurrent structure read and answers
    // inline; see `discord::needs_defer`.
    if discord::needs_defer(&cfg) {
        let (Some(application_id), Some(interaction_token)) = (
            interaction.application_id.clone(),
            interaction.token.clone(),
        ) else {
            // Without these we can't follow up at all. Fall through to an inline
            // reply with no member expansion rather than leaving the click dead.
            tracing::warn!("component interaction carried no application_id/token");
            return inline_reply(state, &cfg, &token, interaction.picked_section()).await;
        };
        let public = cfg.public;
        let section = interaction.picked_section().map(|s| s.to_string());
        let state = state.clone();
        tokio::spawn(async move {
            let components = build_components(&state, &cfg, &token, section.as_deref()).await;
            rest::edit_original(
                &state.http,
                &application_id,
                &interaction_token,
                &discord::followup_body(components),
            )
            .await;
        });
        return Json(discord::deferred(public)).into_response();
    }

    inline_reply(state, &cfg, &token, interaction.picked_section()).await
}

async fn inline_reply(
    state: &AppState,
    cfg: &InstanceConfig,
    token: &str,
    section: Option<&str>,
) -> Response {
    let components = build_components(state, cfg, token, section).await;
    Json(discord::message_reply(components, cfg.public)).into_response()
}

/// Read what this directory needs and render it.
///
/// Always returns renderable components: a failed structure read becomes a
/// one-line explanation, and a refused member list degrades to a roster without
/// members (see [`MemberScanOutcome`]). Nothing here can leave a click unanswered.
async fn build_components(
    state: &AppState,
    cfg: &InstanceConfig,
    token: &str,
    section: Option<&str>,
) -> Vec<Value> {
    let structure = match state
        .cache
        .structure(&state.http, token, &cfg.guild_id)
        .await
    {
        Ok(s) => s,
        Err(e) => {
            // Deliberately not an ERROR log: "the bot was removed from the
            // server" is an admin's doing, and ERROR is the paging channel.
            tracing::info!(guild_id = %cfg.guild_id, error = ?e, "structure read failed");
            return vec![json!({
                "type": discord::COMPONENT_TEXT_DISPLAY,
                "content": e.member_message(),
            })];
        }
    };

    let (members, member_state) = if discord::needs_defer(cfg) {
        // Only the roles actually on show are scanned — the bound that keeps a
        // cached scan small (see the note in `rest`). `roster_role_ids` is the
        // renderer's own selection logic, so the two can't drift.
        let wanted: Vec<String> = render::roster_role_ids(cfg, &structure);
        match state
            .cache
            .members(&state.http, token, &cfg.guild_id, &wanted)
            .await
        {
            MemberScanOutcome::Ok(index) => (Some(index), MemberState::Ready),
            MemberScanOutcome::Unavailable => (None, MemberState::Unavailable),
            MemberScanOutcome::Busy => (None, MemberState::Busy),
        }
    } else {
        (None, MemberState::NotRequested)
    };

    render::render(&RenderInput {
        cfg,
        structure: &structure,
        members: members.as_ref(),
        member_state,
        section,
    })
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
            "error": "This browser does not have edit access. Save again to create a replacement list."
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
        Json(json!({ "error": "Unknown list." })),
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

    /// The registry payload, without needing a running service.
    ///
    /// Mirrors `registry()` — which can't be called in a test because it needs an
    /// `AppState` — so the assertions below check the values that actually ship.
    /// Keep the two in step; the fields asserted here are the ones a drift breaks
    /// silently rather than loudly.
    const CONFIG_HTML: &str = include_str!("../static/config.html");

    /// Every preset the manifest advertises must exist in the config iframe's own
    /// preset table, and vice versa.
    ///
    /// This is the one drift in a plugin manifest with no visible symptom: DWEEB
    /// shows a preset in the library, passes its id to the iframe on a fresh
    /// attach, and the iframe silently ignores an id it doesn't know — so the
    /// user picks "Staff list" and gets a blank form with no error anywhere.
    #[test]
    fn every_advertised_preset_exists_in_the_config_iframe() {
        // The ids in the manifest built by `registry()` above.
        let advertised = [
            "directory-staff",
            "directory-roles",
            "directory-channels",
            "directory-start-here",
        ];
        for id in advertised {
            assert!(
                CONFIG_HTML.contains(&format!("id: \"{id}\"")),
                "manifest advertises preset {id:?} but config.html has no entry for it"
            );
        }
        // And nothing in the iframe's table is unreachable from the library.
        let declared = CONFIG_HTML.matches("id: \"directory-").count();
        assert_eq!(
            declared,
            advertised.len(),
            "config.html declares {declared} presets but the manifest advertises {}",
            advertised.len()
        );
    }

    /// The iframe mints `custom_id`s with its own copy of the prefix; DWEEB
    /// validates them against the manifest's `customIdPrefix`. A mismatch makes
    /// every save fail host-side validation.
    #[test]
    fn the_iframe_and_the_manifest_agree_on_the_prefix() {
        assert_eq!(PREFIX, "directory:");
        assert!(CONFIG_HTML.contains(r#"const PREFIX = "directory:";"#));
    }

    /// Editor-data access is default-deny: the iframe can only read a resource
    /// the manifest declared. It requests `guild`, so the manifest must say so.
    #[test]
    fn the_iframe_only_requests_declared_resources() {
        assert!(CONFIG_HTML.contains(r#"requestResource("guild")"#));
        // `message` and the webhook resources are deliberately NOT declared — a
        // read-only directory has no business reading the draft or a credential.
        for undeclared in ["\"message\"", "\"savedWebhook\"", "\"savedMessages\""] {
            assert!(
                !CONFIG_HTML.contains(&format!("requestResource({undeclared})")),
                "config.html requests {undeclared}, which the manifest does not declare"
            );
        }
    }

    /// The token header is a fixed-width hex credential; anything else is not a
    /// candidate and must not reach a digest comparison.
    #[test]
    fn only_a_well_formed_edit_token_header_is_accepted() {
        let mut headers = HeaderMap::new();
        assert!(edit_token_from_headers(&headers).is_none());

        headers.insert(EDIT_TOKEN_HEADER, "short".parse().unwrap());
        assert!(edit_token_from_headers(&headers).is_none());

        headers.insert(EDIT_TOKEN_HEADER, "z".repeat(64).parse().unwrap());
        assert!(
            edit_token_from_headers(&headers).is_none(),
            "non-hex rejected"
        );

        let good = "a1b2c3d4".repeat(8);
        headers.insert(EDIT_TOKEN_HEADER, good.parse().unwrap());
        assert_eq!(edit_token_from_headers(&headers), Some(good.as_str()));
    }

    #[test]
    fn generated_ids_and_tokens_have_the_expected_shape() {
        let id = new_instance_id();
        assert_eq!(id.len(), 32);
        assert!(id.bytes().all(|b| b.is_ascii_hexdigit()));
        // The edit credential is 256-bit — the width DWEEB's host validates.
        let token = new_edit_token();
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(new_edit_token(), token, "tokens must not repeat");
    }
}
