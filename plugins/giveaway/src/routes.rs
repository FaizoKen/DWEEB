//! HTTP surface: registry, config iframe, the config API (`/api/meta`,
//! `/api/connect`, `/api/instances`), and the Discord interactions endpoint —
//! plus the giveaway lifecycle (enter → draw → reroll/cancel) that glues the
//! pure logic in `discord.rs` to the store and the optional REST calls.
//!
//! Every member-facing step is pure request/response. The live entrant count
//! rides on the Enter button's label, restamped by an `UPDATE_MESSAGE` response
//! to each click (the only way to edit a webhook-authored message — no bot
//! token). The winner announcement is the public (non-ephemeral) response to a
//! host's Draw click; again no token. Winner DMs are the one thing that needs
//! the bot, so they're spawned best-effort, off the 3s reply path.

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
use crate::discord::{self, Action, Eligibility};
use crate::store::{unix_millis, Giveaway, InstanceConfig, MaskedInstance, Status, Store};
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
            "id": "giveaway",
            "name": "Giveaway",
            "description": "Run a giveaway from a button: live entrant count, entry requirements (role / account age / one-per-person), a fair random draw of N winners, reroll, and cancel.",
            "version": env!("CARGO_PKG_VERSION"),
            "publisher": "DWEEB",
            "homepage": "https://github.com/FaizoKen/DWEEB/tree/main/plugins/giveaway",
            "targets": ["button"],
            "configUrl": format!("{base}/config.html"),
            "customIdPrefix": "giveaway:",
            "placeholders": [
                { "token": "prize", "label": "Prize", "sample": "the prize" },
                { "token": "entries", "label": "Entry count", "sample": "0" },
                { "token": "winners", "label": "Winners", "sample": "TBD" },
                { "token": "winner_count", "label": "Number of winners", "sample": "1" },
                { "token": "host", "label": "Host", "sample": "the host" },
                { "token": "status", "label": "Status", "sample": "open" }
            ]
        }]
    }))
}

/// The configuration iframe, embedded in the binary so the deploy is one file.
pub async fn config_html() -> Html<&'static str> {
    Html(include_str!("../static/config.html"))
}

/// Capabilities the config UI adapts to: whether the shared bot is configured
/// (so it can list roles for requirements and DM winners) and how to invite it.
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

/// Probe a guild with the shared bot and return its roles for the requirement /
/// host-role pickers. Never stores anything.
pub async fn connect(State(state): State<AppState>, Json(req): Json<ConnectRequest>) -> Response {
    if !validate::is_snowflake(req.guild_id.trim()) {
        return bad_request("That server id doesn't look right — it should be 17–20 digits.".into());
    }
    let Some(token) = state.config.default_bot_token.as_deref() else {
        return bad_request("This deployment has no giveaway bot configured, so role requirements can't be set up here.".into());
    };
    match crate::rest::connect(&state.http, token, req.guild_id.trim()).await {
        Ok(result) => Json(json!(result)).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e.message() }))).into_response(),
    }
}

// ── /api/instances ───────────────────────────────────────────────────────────

/// Create a new giveaway. Returns `{ id }`; the caller wraps it as
/// `custom_id = "giveaway:<id>"`.
pub async fn create_instance(State(state): State<AppState>, Json(cfg): Json<InstanceConfig>) -> Response {
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

/// Replace a giveaway's config (reconfigure). Entries, status and winners are
/// preserved.
pub async fn update_instance(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(cfg): Json<InstanceConfig>,
) -> Response {
    if let Err(e) = validate::validate_config(&cfg) {
        return bad_request(e);
    }
    match state.store.update_config(&id, &cfg) {
        Ok(true) => Json(json!({ "id": id })).into_response(),
        Ok(false) => not_found(),
        Err(e) => {
            tracing::error!(error = %e, "update instance");
            storage_error()
        }
    }
}

/// Read a giveaway for the config UI: its config, live entry count, status and
/// drawn winners (so the UI can show "42 entered · open").
pub async fn get_instance(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.store.get(&id) {
        Ok(Some(g)) => {
            let entries = state.store.count_entries(&id).unwrap_or(0);
            Json(MaskedInstance {
                id,
                config: g.config,
                status: g.status.as_str().to_string(),
                entries,
                winners: g.winners,
            })
            .into_response()
        }
        Ok(None) => not_found(),
        Err(e) => {
            tracing::error!(error = %e, "get instance");
            storage_error()
        }
    }
}

// ── /interactions ────────────────────────────────────────────────────────────

/// Discord interactions webhook. Verifies the signature on the raw body, then
/// dispatches: PING → pong, component click → the giveaway action.
pub async fn interactions(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let signature = headers.get("X-Signature-Ed25519").and_then(|v| v.to_str().ok());
    let timestamp = headers.get("X-Signature-Timestamp").and_then(|v| v.to_str().ok());
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

fn handle_component(state: &AppState, interaction: &discord::Interaction) -> Response {
    match discord::parse_action(interaction.custom_id()) {
        Action::Enter { id } => handle_enter(state, interaction, &id),
        Action::Join { id } => handle_toggle(state, interaction, &id, true),
        Action::Leave { id } => handle_toggle(state, interaction, &id, false),
        Action::Draw { id } => handle_draw(state, interaction, &id),
        Action::Reroll { id } => handle_reroll(state, interaction, &id),
        Action::Cancel { id } => handle_cancel(state, interaction, &id),
        Action::Unknown => Json(discord::ephemeral_text("Unknown action.")).into_response(),
    }
}

/// Load a giveaway + run the shared guards (exists, right guild). On failure
/// returns the plain-language message to reply with.
fn load_for_click(
    state: &AppState,
    interaction: &discord::Interaction,
    id: &str,
) -> Result<Giveaway, &'static str> {
    let g = match state.store.get(id) {
        Ok(Some(g)) => g,
        Ok(None) => return Err("This giveaway is no longer set up. Ask an admin to recreate it."),
        Err(e) => {
            tracing::error!(error = %e, "instance lookup");
            return Err("Something went wrong on my end.");
        }
    };
    match interaction.guild_id.as_deref() {
        Some(gid) if gid == g.config.guild_id => {}
        Some(_) => return Err("This giveaway was set up for a different server, so it can't run here."),
        None => return Err("Use this inside the server, not in DMs."),
    }
    Ok(g)
}

// ── enter ─────────────────────────────────────────────────────────────────────

/// The bound Enter button. A host gets the control panel; everyone else is run
/// through the eligibility gate and entered (or told why not).
fn handle_enter(state: &AppState, interaction: &discord::Interaction, id: &str) -> Response {
    let g = match load_for_click(state, interaction, id) {
        Ok(g) => g,
        Err(msg) => return Json(discord::ephemeral_text(msg)).into_response(),
    };
    let Some(uid) = interaction.actor_id() else {
        return Json(discord::ephemeral_text("I couldn't tell who clicked — try again.")).into_response();
    };

    // A host clicking Enter gets the control panel instead of entering — that's
    // how Draw / Reroll / Cancel are reached (the panel has an "enter as
    // participant" button for a host who also wants in).
    if discord::is_host(interaction.actor_roles(), interaction.actor_permissions(), &g.config.host_roles) {
        let entered = state.store.is_entered(id, uid).unwrap_or(false);
        let count = state.store.count_entries(id).unwrap_or(0);
        return Json(discord::host_panel(id, g.status, entered, count, g.config.winner_count as usize))
            .into_response();
    }

    let account_ms = discord::snowflake_to_unix_ms(uid);
    match discord::check_eligibility(
        g.status,
        g.config.ends_at,
        unix_millis(),
        interaction.actor_roles(),
        account_ms,
        &g.config.requirements,
    ) {
        Eligibility::Over => over_response(state, interaction, &g, id),
        Eligibility::EntriesClosed => Json(discord::ephemeral_text(
            "\u{23F0} Entries have closed — the winners will be drawn soon. Good luck!",
        ))
        .into_response(),
        Eligibility::MissingRoles => {
            Json(discord::ephemeral_text(&discord::missing_roles_message(&g.config.requirements)))
                .into_response()
        }
        Eligibility::AccountTooNew { needed_days } => Json(discord::ephemeral_text(&format!(
            "\u{1F512} Your account is too new to enter — it has to be at least {needed_days} day{} old.",
            if needed_days == 1 { "" } else { "s" }
        )))
        .into_response(),
        Eligibility::Ok => match state.store.enter(id, uid) {
            Ok(true) => {
                // A brand-new entry: restamp the live count onto the button (and,
                // when placeholders are in play, re-render `{entries}` in the body).
                let count = state.store.count_entries(id).unwrap_or(1);
                match entry_count_update(interaction, &g, id, count) {
                    Some(v) => Json(v).into_response(),
                    None => Json(discord::ephemeral_text(&format!(
                        "\u{2705} You're in! You're 1 of **{count}**. Good luck! \u{1F340}"
                    )))
                    .into_response(),
                }
            }
            Ok(false) => {
                // Already entered — reassure the re-clicker and offer Leave.
                let count = state.store.count_entries(id).unwrap_or(1);
                Json(discord::already_in_panel(id, count)).into_response()
            }
            Err(e) => {
                tracing::error!(error = %e, "record entry");
                Json(discord::ephemeral_text("Something went wrong recording your entry — try again.")).into_response()
            }
        },
    }
}

/// The response to an Enter click on a giveaway that's already over: lazily flip
/// the public message to its end state so the message itself shows it's done —
/// the button disables and relabels, and (when the host used placeholders) the
/// `{winners}` / `{status}` text fills in from the stored template. This is the
/// click that finally refreshes the message after a draw, since a webhook message
/// is editable only in reply to a click on it. Falls back to an ephemeral note if
/// the message carried no components to edit.
fn over_response(state: &AppState, interaction: &discord::Interaction, g: &Giveaway, id: &str) -> Response {
    let (label, note) = match g.status {
        Status::Cancelled => (
            "\u{274C} Giveaway cancelled",
            "\u{274C} This giveaway was cancelled.".to_string(),
        ),
        _ => (
            "\u{1F3C1} Giveaway ended",
            if g.winners.is_empty() {
                "\u{1F3C1} This giveaway has ended.".to_string()
            } else {
                format!(
                    "\u{1F3C1} This giveaway has ended. Winners: {}.",
                    discord::join_mentions(&g.winners)
                )
            },
        ),
    };
    let enter = discord::enter_id(id);
    if let Some(msg) = interaction.message.as_ref() {
        if let Some(template) = g.config.message_template.as_ref() {
            // Re-render the whole message: winners, status and the final count all
            // settle into the host's own text.
            let count = state.store.count_entries(id).unwrap_or(0);
            let vars = render_vars(&g.config, count, g.winners.clone(), g.status);
            return Json(discord::update_message_from_template(msg, template, &vars, &enter, Some(label), true))
                .into_response();
        }
        if let Some(v) = discord::update_button_response(msg, &enter, Some(label), true) {
            return Json(v).into_response();
        }
    }
    Json(discord::ephemeral_text(&note)).into_response()
}

/// Host panel "enter / leave as participant" (and the member-facing Leave button
/// on the already-entered notice). Toggles the actor's own entry and updates the
/// ephemeral panel in place.
fn handle_toggle(state: &AppState, interaction: &discord::Interaction, id: &str, join: bool) -> Response {
    let g = match load_for_click(state, interaction, id) {
        Ok(g) => g,
        Err(msg) => return Json(discord::ephemeral_text(msg)).into_response(),
    };
    let Some(uid) = interaction.actor_id() else {
        return Json(discord::ephemeral_text("I couldn't tell who clicked — try again.")).into_response();
    };

    if join {
        let _ = state.store.enter(id, uid);
    } else {
        let _ = state.store.leave(id, uid);
    }

    let is_host = discord::is_host(interaction.actor_roles(), interaction.actor_permissions(), &g.config.host_roles);
    if is_host {
        // Re-render the host panel in place (entered flag flipped).
        let entered = state.store.is_entered(id, uid).unwrap_or(join);
        let count = state.store.count_entries(id).unwrap_or(0);
        let panel = discord::host_panel(id, g.status, entered, count, g.config.winner_count as usize);
        Json(as_update(panel)).into_response()
    } else {
        // A plain member left via the already-entered notice.
        Json(as_update(discord::left_notice())).into_response()
    }
}

// ── host actions: draw / reroll / cancel ─────────────────────────────────────

/// Re-check that the actor is a host for this giveaway. Returns the deny reply
/// when they aren't — never trust that only hosts can reach these custom_ids.
fn require_host(state: &AppState, interaction: &discord::Interaction, id: &str) -> Result<Giveaway, Response> {
    let g = match load_for_click(state, interaction, id) {
        Ok(g) => g,
        Err(msg) => return Err(Json(discord::ephemeral_text(msg)).into_response()),
    };
    if !discord::is_host(interaction.actor_roles(), interaction.actor_permissions(), &g.config.host_roles) {
        return Err(Json(discord::ephemeral_text(
            "Only a server manager (or a configured host role) can do that.",
        ))
        .into_response());
    }
    Ok(g)
}

fn handle_draw(state: &AppState, interaction: &discord::Interaction, id: &str) -> Response {
    let g = match require_host(state, interaction, id) {
        Ok(g) => g,
        Err(resp) => return resp,
    };
    if g.status != Status::Open {
        return Json(discord::ephemeral_text(match g.status {
            Status::Ended => "This giveaway has already been drawn. Use **Reroll** to pick again.",
            _ => "This giveaway was cancelled, so there's nothing to draw.",
        }))
        .into_response();
    }

    let entrants = state.store.list_entrants(id).unwrap_or_default();
    if entrants.is_empty() {
        return Json(discord::ephemeral_text(
            "Nobody has entered yet, so there's no one to draw. Give it time, or cancel the giveaway.",
        ))
        .into_response();
    }

    let winners = discord::choose_winners(&entrants, g.config.winner_count as usize, |bound| rand_below(bound));
    if let Err(e) = state.store.set_winners(id, &winners) {
        tracing::error!(error = %e, "set winners");
        return Json(discord::ephemeral_text("Something went wrong drawing winners — try again.")).into_response();
    }
    maybe_dm_winners(state, &g.config, &winners);

    let vars = render_vars(&g.config, entrants.len() as i64, winners.clone(), Status::Ended);
    Json(discord::announcement_message(&vars, false, g.config.announcement.as_deref())).into_response()
}

fn handle_reroll(state: &AppState, interaction: &discord::Interaction, id: &str) -> Response {
    let g = match require_host(state, interaction, id) {
        Ok(g) => g,
        Err(resp) => return resp,
    };
    if g.status != Status::Ended {
        return Json(discord::ephemeral_text(
            "Draw the winners first — then you can reroll for a fresh pick.",
        ))
        .into_response();
    }

    // Reroll excludes everyone already drawn, so a reroll is genuinely fresh.
    let already: std::collections::BTreeSet<&str> = g.winners.iter().map(String::as_str).collect();
    let pool: Vec<String> = state
        .store
        .list_entrants(id)
        .unwrap_or_default()
        .into_iter()
        .filter(|u| !already.contains(u.as_str()))
        .collect();
    if pool.is_empty() {
        return Json(discord::ephemeral_text(
            "Everyone who entered has already been drawn — there's no one left to reroll.",
        ))
        .into_response();
    }

    let winners = discord::choose_winners(&pool, g.config.winner_count as usize, |bound| rand_below(bound));
    if let Err(e) = state.store.set_winners(id, &winners) {
        tracing::error!(error = %e, "reroll set winners");
        return Json(discord::ephemeral_text("Something went wrong rerolling — try again.")).into_response();
    }
    maybe_dm_winners(state, &g.config, &winners);

    let entries = state.store.count_entries(id).unwrap_or(pool.len() as i64);
    let vars = render_vars(&g.config, entries, winners.clone(), Status::Ended);
    Json(discord::announcement_message(&vars, true, g.config.announcement.as_deref())).into_response()
}

fn handle_cancel(state: &AppState, interaction: &discord::Interaction, id: &str) -> Response {
    let g = match require_host(state, interaction, id) {
        Ok(g) => g,
        Err(resp) => return resp,
    };
    if g.status == Status::Cancelled {
        return Json(discord::ephemeral_text("This giveaway is already cancelled.")).into_response();
    }
    if let Err(e) = state.store.set_cancelled(id) {
        tracing::error!(error = %e, "cancel");
        return Json(discord::ephemeral_text("Something went wrong cancelling — try again.")).into_response();
    }
    // Tell everyone, publicly — entrants deserve to know it's off.
    Json(json!({
        "type": 4,
        "data": {
            "content": format!("\u{274C} The giveaway for **{}** has been cancelled.", clamp(&g.config.prize, 200)),
            "allowed_mentions": { "parse": [] }
        }
    }))
    .into_response()
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// Build the `UPDATE_MESSAGE` that restamps the entrant count on the Enter
/// button. When the host used placeholders, re-render the whole message from the
/// stored template (so `{entries}` updates in the body too, and the count rides
/// the host's own button wording); otherwise just restamp the live button label,
/// preserving the rest of the message exactly as before.
fn entry_count_update(
    interaction: &discord::Interaction,
    g: &Giveaway,
    id: &str,
    count: i64,
) -> Option<Value> {
    let msg = interaction.message.as_ref()?;
    let enter = discord::enter_id(id);

    if let Some(template) = g.config.message_template.as_ref() {
        let vars = render_vars(&g.config, count, g.winners.clone(), g.status);
        let base = discord::enter_button_label(template).unwrap_or_else(|| "\u{1F389} Enter".to_string());
        let label = discord::label_with_count(&discord::substitute(&base, &vars), count);
        return Some(discord::update_message_from_template(msg, template, &vars, &enter, Some(&label), false));
    }

    let current = msg
        .components
        .as_ref()
        .and_then(|c| discord::find_button_label(c, &enter))
        .unwrap_or_else(|| "\u{1F389} Enter".to_string());
    let label = discord::label_with_count(&current, count);
    discord::update_button_response(msg, &enter, Some(&label), false)
}

/// Assemble the placeholder values for the giveaway's current state — the bridge
/// from stored config + runtime to the pure renderer in `discord.rs`.
fn render_vars(cfg: &InstanceConfig, entries: i64, winners: Vec<String>, status: Status) -> discord::RenderVars {
    discord::RenderVars {
        prize: cfg.prize.clone(),
        entries,
        winner_count: cfg.winner_count,
        winners,
        status,
        host_user_id: cfg.host_user_id.clone(),
    }
}

/// Turn a freshly-built (type 4) ephemeral reply into an `UPDATE_MESSAGE` (type
/// 7) so it edits the ephemeral panel in place rather than stacking a new one.
fn as_update(mut resp: Value) -> Value {
    resp["type"] = json!(7);
    resp
}

/// Spawn best-effort winner DMs when the giveaway opted in *and* a bot token is
/// configured. Off the reply path, so a slow/closed DM never delays the
/// announcement.
fn maybe_dm_winners(state: &AppState, cfg: &InstanceConfig, winners: &[String]) {
    if !cfg.dm_winners || winners.is_empty() {
        return;
    }
    let Some(token) = state.config.default_bot_token.clone() else {
        return;
    };
    let http = state.http.clone();
    let content = discord::winner_dm_content(&cfg.prize);
    let winners = winners.to_vec();
    tokio::spawn(async move {
        let futs = winners.iter().map(|w| crate::rest::dm_user(&http, &token, w, &content));
        futures::future::join_all(futs).await;
    });
}

/// An unbiased random index in `0..bound`, from the OS CSPRNG. Rejection
/// sampling drops the small high tail that would otherwise skew a plain modulo,
/// so every entrant has exactly equal odds.
fn rand_below(bound: usize) -> usize {
    if bound <= 1 {
        return 0;
    }
    let bound = bound as u64;
    let zone = u64::MAX - (u64::MAX % bound); // largest multiple of `bound`
    loop {
        let mut b = [0u8; 8];
        getrandom::getrandom(&mut b).expect("CSPRNG unavailable");
        let x = u64::from_le_bytes(b);
        if x < zone {
            return (x % bound) as usize;
        }
    }
}

fn new_instance_id() -> String {
    // 128 bits of entropy. This id lives in the (Discord-side) custom_id and is
    // the capability to reconfigure, so it must be unguessable.
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("CSPRNG unavailable");
    hex::encode(bytes)
}

fn clamp(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn bad_request(message: String) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response()
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "Unknown instance." }))).into_response()
}

fn storage_error() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Storage error." }))).into_response()
}

#[cfg(test)]
mod tests {
    //! Lifecycle integration tests: drive the real interaction handlers against a
    //! live (in-memory) store and assert the Discord payloads they emit — the
    //! glue the pure `discord.rs` tests can't cover (store reads, the
    //! template-vs-fallback branch, the draw→over refresh).

    use super::*;
    use crate::config::Config;
    use crate::store::Requirements;

    const MANAGE_GUILD: &str = "32"; // 1 << 5

    fn test_state() -> AppState {
        let store = Store::open(":memory:").expect("open store");
        let config = Config {
            port: 0,
            public_base_url: "http://localhost".into(),
            discord_public_key: "0".repeat(64),
            dispatcher_forward_secret: None,
            database_path: ":memory:".into(),
            default_bot_token: None,
            bot_invite_url: None,
        };
        AppState { store: Arc::new(store), http: reqwest::Client::new(), config: Arc::new(config) }
    }

    /// A giveaway config for `Nitro`, 1 winner, in guild `1`, optionally carrying a
    /// message template.
    fn config_with(template: Option<Value>) -> InstanceConfig {
        InstanceConfig {
            target: "button".into(),
            guild_id: "1".into(),
            guild_name: String::new(),
            prize: "Nitro".into(),
            winner_count: 1,
            description: None,
            host_user_id: None,
            ends_at: None,
            requirements: Requirements::default(),
            host_roles: vec![],
            dm_winners: false,
            announcement: None,
            message_template: template,
        }
    }

    /// A host message that uses every placeholder, plus the Enter button.
    fn template(id: &str) -> Value {
        json!([
            { "type": 10, "content": "Win {prize}! In: {entries}. Winners: {winners}. [{status}]" },
            { "type": 1, "components": [
                { "type": 2, "style": 3, "label": "\u{1F389} Enter", "custom_id": format!("giveaway:{id}") }
            ]}
        ])
    }

    /// The components Discord echoes back on a click (a V2 message). For the
    /// template path the body is irrelevant (we render from the stored template);
    /// for the no-template path it's what gets restamped.
    fn live_components(id: &str, body: &str) -> Value {
        json!([
            { "type": 10, "content": body },
            { "type": 1, "components": [
                { "type": 2, "style": 3, "label": "\u{1F389} Enter", "custom_id": format!("giveaway:{id}") }
            ]}
        ])
    }

    fn enter_click(id: &str, user: &str, perms: &str, components: Value) -> discord::Interaction {
        serde_json::from_value(json!({
            "type": 3,
            "guild_id": "1",
            "data": { "custom_id": format!("giveaway:{id}") },
            "member": { "user": { "id": user }, "roles": [], "permissions": perms },
            "message": { "content": "", "components": components, "flags": 32768 }
        }))
        .expect("interaction")
    }

    fn control_click(id: &str, verb: &str, perms: &str) -> discord::Interaction {
        serde_json::from_value(json!({
            "type": 3,
            "guild_id": "1",
            "data": { "custom_id": format!("giveaway:{verb}:{id}") },
            "member": { "user": { "id": "1" }, "roles": [], "permissions": perms },
            "message": { "content": "", "components": Value::Null, "flags": 64 }
        }))
        .expect("interaction")
    }

    /// Read the JSON body out of a handler's `Response`.
    fn body_json(resp: Response) -> Value {
        let bytes = futures::executor::block_on(axum::body::to_bytes(resp.into_body(), usize::MAX))
            .expect("read body");
        serde_json::from_slice(&bytes).expect("json body")
    }

    #[test]
    fn entering_renders_placeholders_into_the_message_body_and_button() {
        let state = test_state();
        let id = "abc";
        state.store.create(id, &config_with(Some(template(id)))).unwrap();

        let resp = handle_component(&state, &enter_click(id, "555", "0", template(id)));
        let v = body_json(resp);
        assert_eq!(v["type"], 7); // UPDATE_MESSAGE
        let s = v.to_string();
        // The body filled in: prize, the live count, winners-not-drawn, status.
        assert!(s.contains("Win Nitro!"), "{s}");
        assert!(s.contains("In: 1"), "{s}");
        assert!(s.contains("Winners: TBD"), "{s}");
        assert!(s.contains("[open]"), "{s}");
        // The count also rides the host's own button wording, button still live.
        assert!(s.contains("Enter (1)"), "{s}");
        assert!(s.contains("\"disabled\":false"), "{s}");
    }

    #[test]
    fn drawing_then_a_click_fills_the_winners_into_the_message() {
        let state = test_state();
        let id = "abc";
        state.store.create(id, &config_with(Some(template(id)))).unwrap();
        for u in ["100", "200", "300"] {
            state.store.enter(id, u).unwrap();
        }

        // A host draws — public announcement, winners recorded.
        let drawn = body_json(handle_component(&state, &control_click(id, "draw", MANAGE_GUILD)));
        assert_eq!(drawn["type"], 4);
        let winner = state.store.get(id).unwrap().unwrap().winners.into_iter().next().unwrap();
        assert!(["100", "200", "300"].contains(&winner.as_str()));

        // The next click on the original message refreshes it: winner mention in
        // the body, status ended, the Enter button disabled.
        let over = body_json(handle_component(&state, &enter_click(id, "999", "0", template(id))));
        assert_eq!(over["type"], 7);
        let s = over.to_string();
        assert!(s.contains(&format!("<@{winner}>")), "{s}");
        assert!(s.contains("[ended]"), "{s}");
        assert!(s.contains("In: 3"), "{s}");
        assert!(s.contains("\"disabled\":true"), "{s}");
    }

    #[test]
    fn without_a_template_only_the_button_restamps() {
        let state = test_state();
        let id = "xyz";
        state.store.create(id, &config_with(None)).unwrap();

        let live = live_components(id, "My own giveaway copy");
        let v = body_json(handle_component(&state, &enter_click(id, "555", "0", live)));
        assert_eq!(v["type"], 7);
        let s = v.to_string();
        // The user's body is preserved verbatim; only the button gains the count.
        assert!(s.contains("My own giveaway copy"), "{s}");
        assert!(s.contains("Enter (1)"), "{s}");
    }
}
