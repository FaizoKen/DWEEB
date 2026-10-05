//! HTTP surface: registry, config iframe, the config API (`/api/meta`,
//! `/api/connect`, `/api/instances`), and the Discord interactions endpoint.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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
use crate::discord::{self, plan_changes, ReplyOutcome};
use crate::rest;
use crate::store::{EditLookup, InstanceConfig, ManagedRole, MaskedInstance, Store};
use crate::validate::{self, RoleBlock};

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    pub http: reqwest::Client,
    pub config: Arc<Config>,
    pub primary_key: ed25519_dalek::VerifyingKey,
    /// Guild role lists the click-time safety check judges against — see
    /// [`roles_for_click`].
    pub role_cache: Arc<Mutex<RoleCache>>,
}

/// How long a cached role list answers a click without a fresh read.
const ROLE_CACHE_FRESH: Duration = Duration::from_secs(60);
/// The oldest list a click falls back to while Discord is slow or down.
const ROLE_CACHE_STALE_MAX: Duration = Duration::from_secs(3600);
/// Guilds whose role lists are kept at once.
const ROLE_CACHE_MAX_GUILDS: usize = 1024;
/// The click path's deadline for the role read: short, so the read plus the
/// role change still answer inside Discord's interaction window.
const CLICK_ROLE_READ_TIMEOUT: Duration = Duration::from_millis(1200);

/// A small, bounded cache of guild role lists.
#[derive(Default)]
pub struct RoleCache {
    entries: HashMap<String, (Instant, Arc<Vec<rest::RoleInfo>>)>,
}

impl RoleCache {
    fn get(&self, guild_id: &str, max_age: Duration) -> Option<Arc<Vec<rest::RoleInfo>>> {
        self.entries
            .get(guild_id)
            .filter(|(at, _)| at.elapsed() <= max_age)
            .map(|(_, roles)| roles.clone())
    }

    fn put(&mut self, guild_id: &str, roles: Arc<Vec<rest::RoleInfo>>) {
        if self.entries.len() >= ROLE_CACHE_MAX_GUILDS && !self.entries.contains_key(guild_id) {
            self.entries
                .retain(|_, (at, _)| at.elapsed() <= ROLE_CACHE_STALE_MAX);
            if self.entries.len() >= ROLE_CACHE_MAX_GUILDS {
                if let Some(oldest) = self
                    .entries
                    .iter()
                    .min_by_key(|(_, (at, _))| *at)
                    .map(|(k, _)| k.clone())
                {
                    self.entries.remove(&oldest);
                }
            }
        }
        self.entries
            .insert(guild_id.to_string(), (Instant::now(), roles));
    }
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
            "resources": ["guild", "savedWebhooks", "savedWebhook"],
            "configUrl": format!("{base}/config.html"),
            "customIdPrefix": "selfrole:",
            "apiVersion": 2,
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
        "apiVersion": 2,
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
        Err(e) => (e.status(), Json(json!({ "error": e.message() }))).into_response(),
    }
}

// ── /api/instances ───────────────────────────────────────────────────────────

/// Create a new instance. The edit credential is returned exactly once here;
/// SQLite stores only its SHA-256 digest.
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
    if let Err(resp) = check_menu_roles(&state, &cfg).await {
        return resp;
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

/// Replace an instance's config.
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
        Ok(EditLookup::Authorized(existing)) => *existing,
        Ok(EditLookup::Unknown) => return not_found(),
        Ok(EditLookup::Forbidden) => return edit_forbidden(),
        Err(e) => {
            tracing::error!(error = %e, "update authorization lookup");
            return storage_error();
        }
    };
    cfg.normalize();
    // The browser never receives the audit-log webhook (it's masked), so it
    // can't echo it back. An **empty** `log_webhook` means "keep the existing
    // one"; an explicit **null/absent** means "turn logging off".
    if cfg.log_webhook.as_deref() == Some("") {
        cfg.log_webhook = existing.log_webhook;
    }
    if let Err(e) = validate::validate_config(&cfg) {
        return bad_request(e);
    }
    if let Err(resp) = check_menu_roles(&state, &cfg).await {
        return resp;
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
    let mut changes = plan_changes(
        &managed,
        &current,
        &requested,
        &cfg.mode,
        cfg.max.map(|m| m as usize),
    );

    // The safety check, at click time: a role whose permissions changed after
    // the menu was saved — or a menu saved before this check existed — must not
    // hand out a staff role either. Only grants are judged; taking a role away
    // is always safe.
    let mut refused: Vec<(String, RoleBlock)> = Vec::new();
    let mut unchecked: Vec<String> = Vec::new();
    if !changes.add.is_empty() {
        match roles_for_click(state, &token, guild_id).await {
            Some(roles) => {
                changes
                    .add
                    .retain(|rid| match validate::role_block(rid, guild_id, &roles) {
                        // A role newer than our list reads as Missing; Discord itself
                        // refuses one that's really gone.
                        None | Some(RoleBlock::Missing) => true,
                        Some(why) => {
                            refused.push((rid.clone(), why));
                            false
                        }
                    })
            }
            // Nothing to judge by (Discord slow or down, nothing cached): never
            // grant blind — report it as busy so the member clicks again.
            None => unchecked = std::mem::take(&mut changes.add),
        }
        // A swap (pick one) whose pick didn't go through must not still evict
        // the member's other roles from this menu.
        if cfg.max == Some(1) && (!refused.is_empty() || !unchecked.is_empty()) {
            changes.remove.clear();
        }
    }

    if changes.is_empty() {
        // Nothing actually moved — but a click refused by the pick-limit, the
        // safety check or a busy Discord still needs its own explanation rather
        // than a bare "you're all set".
        return Json(discord::build_reply(
            &cfg,
            &ReplyOutcome {
                busy: &unchecked,
                blocked: &changes.blocked,
                refused: &refused,
                ..Default::default()
            },
        ))
        .into_response();
    }

    // Fire every add/remove concurrently so even a multi-role "pick one" swap
    // answers inside Discord's window. Each future carries its own id so we can
    // report exactly what changed and what Discord refused.
    let reason = format!("Self-role via DWEEB ({})", interaction.actor_name());
    let mut futs = Vec::new();
    for rid in &changes.add {
        futs.push(apply_role_change(
            &state.http,
            &token,
            guild_id,
            user_id,
            rid,
            &reason,
            true,
        ));
    }
    for rid in &changes.remove {
        futs.push(apply_role_change(
            &state.http,
            &token,
            guild_id,
            user_id,
            rid,
            &reason,
            false,
        ));
    }

    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut denied = Vec::new();
    let mut busy = Vec::new();
    for (rid, is_add, res) in join_all(futs).await {
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
    busy.extend(unchecked);
    Json(discord::build_reply(
        &cfg,
        &ReplyOutcome {
            added: &added,
            removed: &removed,
            denied: &denied,
            busy: &busy,
            blocked: &changes.blocked,
            refused: &refused,
            expires_at_unix,
        },
    ))
    .into_response()
}

/// Refuse a menu listing a role a self-role menu may never hand out (see
/// `validate::role_block`), judged against the guild's live role list — read
/// with the shared bot, which every Self Role menu needs anyway. A Discord
/// outage answers with the same non-paging status `/api/connect` would.
// The Err *is* the HTTP reply, built at most once per refused save.
#[allow(clippy::result_large_err)]
async fn check_menu_roles(state: &AppState, cfg: &InstanceConfig) -> Result<(), Response> {
    let Some(token) = state.config.default_bot_token.as_deref() else {
        return Err(bad_request(
            "This deployment has no Self Role bot configured, so a menu can't be saved here."
                .into(),
        ));
    };
    let roles = match rest::guild_roles(&state.http, token, &cfg.guild_id, None).await {
        Ok(roles) => roles,
        Err(e) => {
            return Err((e.status(), Json(json!({ "error": e.message() }))).into_response());
        }
    };
    let blocked: Vec<(String, RoleBlock)> = cfg
        .roles
        .iter()
        .filter_map(|r| {
            validate::role_block(&r.id, &cfg.guild_id, &roles).map(|why| {
                let live_name = roles
                    .iter()
                    .find(|g| g.id == r.id)
                    .map(|g| g.name.clone())
                    .filter(|n| !n.trim().is_empty());
                let name = live_name.unwrap_or_else(|| {
                    if r.name.trim().is_empty() {
                        r.id.clone()
                    } else {
                        r.name.clone()
                    }
                });
                (name, why)
            })
        })
        .collect();
    if let Ok(mut cache) = state.role_cache.lock() {
        cache.put(&cfg.guild_id, Arc::new(roles));
    }
    if blocked.is_empty() {
        Ok(())
    } else {
        Err(bad_request(validate::blocked_roles_message(&blocked)))
    }
}

/// The guild's roles for the click-time safety check: a fresh cached list, else
/// a quick read (which refreshes the cache), else — Discord slow or down — the
/// last list seen within the hour. None when there's nothing to judge by.
async fn roles_for_click(
    state: &AppState,
    token: &str,
    guild_id: &str,
) -> Option<Arc<Vec<rest::RoleInfo>>> {
    let cached = state
        .role_cache
        .lock()
        .ok()
        .and_then(|c| c.get(guild_id, ROLE_CACHE_FRESH));
    if cached.is_some() {
        return cached;
    }
    match rest::guild_roles(&state.http, token, guild_id, Some(CLICK_ROLE_READ_TIMEOUT)).await {
        Ok(roles) => {
            let roles = Arc::new(roles);
            if let Ok(mut cache) = state.role_cache.lock() {
                cache.put(guild_id, roles.clone());
            }
            Some(roles)
        }
        Err(e) => {
            tracing::info!(guild_id, error = ?e, "role read for the safety check failed");
            state
                .role_cache
                .lock()
                .ok()
                .and_then(|c| c.get(guild_id, ROLE_CACHE_STALE_MAX))
        }
    }
}

/// One role REST future. Joining these directly avoids a scheduler task
/// allocation and repeated client/token/id clones for every selected role,
/// while preserving the existing concurrent request behavior.
async fn apply_role_change(
    http: &reqwest::Client,
    token: &str,
    guild_id: &str,
    user_id: &str,
    role_id: &str,
    reason: &str,
    add: bool,
) -> (String, bool, Result<(), rest::RoleError>) {
    let result = if add {
        rest::add_role(http, token, guild_id, user_id, role_id, reason).await
    } else {
        rest::remove_role(http, token, guild_id, user_id, role_id, reason).await
    };
    (role_id.to_string(), add, result)
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

#[cfg(test)]
mod tests {
    //! The click-time half of the safety check, driven through the real handler
    //! with a pre-populated role cache — so a refused grant never reaches the
    //! network at all.

    use super::*;
    use crate::store::{Requirement, ResponseDef};

    const TEST_EDIT_TOKEN: &str =
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const GUILD: &str = "100000000000000000";

    fn test_state() -> AppState {
        let public_key =
            "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a".to_string();
        let config = Config {
            port: 0,
            public_base_url: "http://localhost".into(),
            discord_public_key: public_key.clone(),
            dispatcher_forward_secret: None,
            database_path: ":memory:".into(),
            default_bot_token: Some("test-token".into()),
            bot_invite_url: None,
            reaper_interval_secs: 30,
        };
        AppState {
            store: Arc::new(Store::open(":memory:").expect("open store")),
            http: reqwest::Client::new(),
            config: Arc::new(config),
            primary_key: discord::parse_verifying_key(&public_key).unwrap(),
            role_cache: Default::default(),
        }
    }

    fn managed(id: &str, name: &str) -> ManagedRole {
        ManagedRole {
            id: id.into(),
            name: name.into(),
            color: 0,
            emoji: None,
            emoji_id: None,
            emoji_animated: false,
            description: None,
        }
    }

    fn menu(target: &str, roles: Vec<ManagedRole>, max: Option<u32>) -> InstanceConfig {
        InstanceConfig {
            target: target.into(),
            guild_id: GUILD.into(),
            guild_name: String::new(),
            roles,
            mode: "toggle".into(),
            max,
            requirement: Requirement::default(),
            expires_after_secs: None,
            log_webhook: None,
            response: ResponseDef::default(),
        }
    }

    fn cache_roles(state: &AppState, roles: Vec<rest::RoleInfo>) {
        state.role_cache.lock().unwrap().put(GUILD, Arc::new(roles));
    }

    fn info(id: &str, name: &str, permissions: u64) -> rest::RoleInfo {
        rest::RoleInfo {
            id: id.into(),
            name: name.into(),
            managed: false,
            permissions,
        }
    }

    fn body_json(resp: Response) -> Value {
        let bytes = futures::executor::block_on(axum::body::to_bytes(resp.into_body(), usize::MAX))
            .expect("read body");
        serde_json::from_slice(&bytes).expect("json body")
    }

    /// A menu saved (before this check existed, or before the role gained
    /// permissions) listing the server's Moderator role: the click is refused
    /// with the reason, and nothing is sent to Discord.
    #[test]
    fn a_staff_role_is_never_granted_at_click_time() {
        let state = test_state();
        let moderator = "200000000000000002";
        state
            .store
            .create(
                "abc",
                TEST_EDIT_TOKEN,
                &menu("button", vec![managed(moderator, "Moderator")], None),
            )
            .unwrap();
        cache_roles(&state, vec![info(moderator, "Moderator", 1 << 2)]);
        let click: discord::Interaction = serde_json::from_value(json!({
            "type": 3,
            "guild_id": GUILD,
            "data": { "custom_id": "selfrole:abc", "component_type": 2 },
            "member": { "user": { "id": "300000000000000000" }, "roles": [] }
        }))
        .unwrap();
        let v = body_json(futures::executor::block_on(handle_component(
            &state, &click,
        )));
        let text = v["data"]["components"][0]["content"].as_str().unwrap();
        assert!(
            text.contains("**Moderator** (it has Ban Members)"),
            "{text}"
        );
        assert!(text.contains("never grants"), "{text}");
    }

    /// A pick-one menu whose pick is refused must not still take the member's
    /// current role away — the swap is called off whole.
    #[test]
    fn a_refused_swap_keeps_the_members_current_role() {
        let state = test_state();
        let (red, admin) = ("200000000000000001", "200000000000000002");
        state
            .store
            .create(
                "abc",
                TEST_EDIT_TOKEN,
                &menu(
                    "string_select",
                    vec![managed(red, "Red"), managed(admin, "Admin")],
                    Some(1),
                ),
            )
            .unwrap();
        cache_roles(
            &state,
            vec![info(red, "Red", 0), info(admin, "Admin", 1 << 3)],
        );
        let click: discord::Interaction = serde_json::from_value(json!({
            "type": 3,
            "guild_id": GUILD,
            "data": { "custom_id": "selfrole:abc", "component_type": 3, "values": [admin] },
            "member": { "user": { "id": "300000000000000000" }, "roles": [red] }
        }))
        .unwrap();
        // Were the swap to evict Red, the handler would call Discord; refusing
        // the pick first leaves nothing to do, so this answers without the network.
        let v = body_json(futures::executor::block_on(handle_component(
            &state, &click,
        )));
        let text = v["data"]["components"][0]["content"].as_str().unwrap();
        assert!(text.contains("**Admin** (it has Administrator)"), "{text}");
        assert!(!text.contains("Removed"), "{text}");
    }
}
