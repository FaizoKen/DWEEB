//! HTTP surface: registry, config iframe, the config API (`/api/meta`,
//! `/api/connect`, `/api/instances`), and the Discord interactions endpoint —
//! plus the ticket lifecycle flows (open → claim → close → reopen/delete) that
//! glue the pure logic in `discord.rs` to the REST calls in `rest.rs`.
//!
//! The heavy flows (create a channel, post into it; transcript + delete) make
//! two or more REST calls, which won't fit Discord's ~3s interaction window. So
//! they **defer**: the handler answers instantly (a "…thinking" ack, or an
//! ephemeral "Closing…") and spawns the real work, which edits the deferred
//! reply (`PATCH @original`) when done. Deferring keeps every handler off the
//! 3s path and well inside the dispatcher's 2.5s upstream timeout.

use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Json, Response},
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::OnceCell;

use crate::config::Config;
use crate::discord::{self, Action, OpenGate, TemplateCtx};
use crate::rest::{self, RestError};
use crate::store::{unix_millis, InstanceConfig, MaskedInstance, Store, Ticket};
use crate::validate;

/// Overwrite target kind for a single member (`PUT …/permissions/{id}`).
const OVERWRITE_MEMBER: u8 = 1;

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    pub http: reqwest::Client,
    pub config: Arc<Config>,
    /// The shared bot's own user id, fetched once and cached — needed in a
    /// ticket channel's overwrites so the bot can see the channel it created,
    /// even when a *custom* app (whose application id differs) posted the panel.
    pub bot_id: Arc<OnceCell<String>>,
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
            "id": "tickets",
            "name": "Tickets",
            "description": "Private support tickets from a button or topic menu — per-ticket channel, optional intake form, staff claim, close with transcript.",
            "version": env!("CARGO_PKG_VERSION"),
            "publisher": "DWEEB",
            "homepage": "https://github.com/FaizoKen/DWEEB/tree/main/plugins/tickets",
            "targets": ["button", "string_select"],
            "configUrl": format!("{base}/config.html"),
            "customIdPrefix": "tickets:",
            "managesSelectOptions": true
        }]
    }))
}

/// The configuration iframe, embedded in the binary so the deploy is one file.
pub async fn config_html() -> Html<&'static str> {
    Html(include_str!("../static/config.html"))
}

/// Capabilities the config UI adapts to: whether the shared bot is configured
/// and, if so, how to invite it.
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

/// Probe a guild with the shared bot and return its roles + channels and the
/// bot's permission status for the picker. Never stores anything.
pub async fn connect(State(state): State<AppState>, Json(req): Json<ConnectRequest>) -> Response {
    if !validate::is_snowflake(req.guild_id.trim()) {
        return bad_request("That server id doesn't look right — it should be 17–20 digits.".into());
    }
    let Some(token) = state.config.default_bot_token.as_deref() else {
        return bad_request("This deployment has no Tickets bot configured.".into());
    };
    match rest::connect(&state.http, token, req.guild_id.trim()).await {
        Ok(result) => Json(json!(result)).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e.message() }))).into_response(),
    }
}

// ── /api/instances ───────────────────────────────────────────────────────────

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
/// dispatches by interaction type.
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
        discord::TYPE_MODAL_SUBMIT => handle_modal_submit(&state, &interaction),
        _ => Json(discord::ephemeral_text("Unsupported interaction.")).into_response(),
    }
}

/// Load an instance + run the shared guards (config exists, right guild, bot
/// configured). On any failure returns the plain-language message to reply with;
/// on success returns the config. (Returning the message, not a built `Response`,
/// keeps the `Err` variant tiny — the caller wraps it.)
fn load_for_click(
    state: &AppState,
    interaction: &discord::Interaction,
    id: &str,
) -> Result<InstanceConfig, &'static str> {
    let cfg = match state.store.get(id) {
        Ok(Some(c)) => c,
        Ok(None) => return Err("This ticket panel is no longer set up. Ask an admin to recreate it."),
        Err(e) => {
            tracing::error!(error = %e, "instance lookup");
            return Err("Something went wrong on my end.");
        }
    };
    match interaction.guild_id.as_deref() {
        Some(g) if g == cfg.guild_id => {}
        Some(_) => return Err("This panel was set up for a different server, so I can't open tickets here."),
        None => return Err("Use this inside the server, not in DMs."),
    }
    if state.config.default_bot_token.is_none() {
        return Err("This panel isn't finished — no bot is connected. Ask an admin to reconfigure it.");
    }
    Ok(cfg)
}

// ── component clicks ────────────────────────────────────────────────────────

fn handle_component(state: &AppState, interaction: &discord::Interaction) -> Response {
    match discord::parse_action(interaction.custom_id()) {
        Action::Open { id } => handle_open_click(state, interaction, &id),
        Action::Claim { id } => handle_claim(state, interaction, &id),
        Action::Close { id } => handle_close_click(state, interaction, &id),
        Action::Reopen { id } => handle_reopen(state, interaction, &id),
        Action::Delete { id } => handle_delete(state, interaction, &id),
        _ => Json(discord::ephemeral_text("Unknown action.")).into_response(),
    }
}

fn handle_modal_submit(state: &AppState, interaction: &discord::Interaction) -> Response {
    match discord::parse_action(interaction.custom_id()) {
        Action::Intake { id, topic } => handle_intake_submit(state, interaction, &id, &topic),
        Action::DoClose { id } => handle_do_close(state, interaction, &id),
        _ => Json(discord::ephemeral_text("Unknown form.")).into_response(),
    }
}

/// Panel button / select → either pop the intake modal, or defer + open straight
/// away. The anti-spam gate runs *before* the modal so a member never fills in a
/// form that would be turned away.
fn handle_open_click(state: &AppState, interaction: &discord::Interaction, id: &str) -> Response {
    let cfg = match load_for_click(state, interaction, id) {
        Ok(c) => c,
        Err(msg) => return Json(discord::ephemeral_text(msg)).into_response(),
    };
    let Some(uid) = interaction.actor_id() else {
        return Json(discord::ephemeral_text("I couldn't tell who clicked — try again.")).into_response();
    };

    // The chosen topic (select panels only). A button has none. Trust only a
    // value that matches a configured topic — never the client's raw input.
    let topic_value = interaction.first_value().map(str::to_string);
    if cfg.target == "string_select" {
        let known = topic_value
            .as_deref()
            .is_some_and(|v| cfg.topics.iter().any(|t| t.id == v));
        if !known {
            return Json(discord::ephemeral_text("Pick a topic from the menu.")).into_response();
        }
    }

    if let Some(denied) = gate_reply(state, id, uid, &cfg) {
        return denied;
    }

    if cfg.intake.is_empty() {
        // No form — defer and create.
        spawn_open(state, interaction, &cfg, id, uid, topic_value, vec![]);
        Json(discord::deferred_ephemeral()).into_response()
    } else {
        // Carry the topic value into the modal's submit id so the create step,
        // which no longer sees the select, still knows the topic.
        let submit_id = match &topic_value {
            Some(t) if !t.is_empty() => format!("{}intake:{id}:{t}", discord::PREFIX),
            _ => format!("{}intake:{id}", discord::PREFIX),
        };
        Json(discord::intake_modal(&submit_id, "Open a ticket", &cfg.intake)).into_response()
    }
}

/// Intake form submitted → re-gate, then defer + create with the answers.
fn handle_intake_submit(state: &AppState, interaction: &discord::Interaction, id: &str, topic: &str) -> Response {
    let cfg = match load_for_click(state, interaction, id) {
        Ok(c) => c,
        Err(msg) => return Json(discord::ephemeral_text(msg)).into_response(),
    };
    let Some(uid) = interaction.actor_id() else {
        return Json(discord::ephemeral_text("I couldn't tell who submitted — try again.")).into_response();
    };
    if let Some(denied) = gate_reply(state, id, uid, &cfg) {
        return denied;
    }
    let answers = interaction
        .data
        .as_ref()
        .map(discord::collect_modal_values)
        .unwrap_or_default();
    let topic_value = if topic.is_empty() { None } else { Some(topic.to_string()) };
    spawn_open(state, interaction, &cfg, id, uid, topic_value, answers);
    Json(discord::deferred_ephemeral()).into_response()
}

/// The anti-spam gate as a ready-to-send reply, or None when the open may proceed.
fn gate_reply(state: &AppState, id: &str, uid: &str, cfg: &InstanceConfig) -> Option<Response> {
    let open_count = state.store.count_open(id, uid).unwrap_or(0);
    let last = state.store.last_open_at(id, uid).unwrap_or(None);
    match discord::open_gate(open_count, cfg.max_open_per_user, last, unix_millis(), cfg.cooldown_secs) {
        OpenGate::Allowed => None,
        OpenGate::AtLimit { max } => Some(
            Json(discord::ephemeral_text(&format!(
                "You already have the most open tickets allowed here ({max}). Close one before opening another.",
            )))
            .into_response(),
        ),
        OpenGate::Cooldown { wait_secs } => Some(
            Json(discord::ephemeral_text(&format!(
                "You're opening tickets a little fast — try again in {wait_secs}s.",
            )))
            .into_response(),
        ),
    }
}

/// Spawn the create-channel work and let the handler return its deferred ack.
fn spawn_open(
    state: &AppState,
    interaction: &discord::Interaction,
    cfg: &InstanceConfig,
    id: &str,
    uid: &str,
    topic_value: Option<String>,
    answers: Vec<(String, String)>,
) {
    let (Some(app_id), Some(token), Some(guild_id)) = (
        interaction.application_id.clone(),
        interaction.token.clone(),
        interaction.guild_id.clone(),
    ) else {
        return;
    };
    let task = OpenTask {
        state: state.clone(),
        cfg: cfg.clone(),
        instance_id: id.to_string(),
        guild_id,
        opener_id: uid.to_string(),
        opener_name: interaction.actor_name(),
        topic_value,
        answers,
        app_id,
        token,
    };
    tokio::spawn(task.run());
}

struct OpenTask {
    state: AppState,
    cfg: InstanceConfig,
    instance_id: String,
    guild_id: String,
    opener_id: String,
    opener_name: String,
    topic_value: Option<String>,
    answers: Vec<(String, String)>,
    app_id: String,
    token: String,
}

impl OpenTask {
    async fn run(self) {
        let token_bot = match self.state.config.default_bot_token.clone() {
            Some(t) => t,
            None => return self.fail("No bot is connected.").await,
        };
        let Some(bot_id) = ensure_bot_id(&self.state, &token_bot).await else {
            return self.fail("Couldn't reach Discord just now — try again in a moment.").await;
        };

        // Re-check the cap at creation time to close the open-the-modal-then-wait
        // race; the ledger is authoritative.
        let open_count = self.state.store.count_open(&self.instance_id, &self.opener_id).unwrap_or(0);
        if self.cfg.max_open_per_user > 0 && open_count >= self.cfg.max_open_per_user as i64 {
            return self
                .fail("You've hit the open-ticket limit here — close one first, then try again.")
                .await;
        }

        let number = self.state.store.next_number(&self.instance_id).unwrap_or(0);
        let name = discord::channel_name(&self.cfg.naming, number, &self.opener_name);
        let topic_label = discord::topic_label(&self.cfg.topics, self.topic_value.as_deref());
        let overwrites =
            discord::permission_overwrites(&self.guild_id, &self.opener_id, &self.cfg.staff_roles, &bot_id);
        let channel_topic = if topic_label.is_empty() {
            format!("Ticket #{number} • opened by {}", self.opener_name)
        } else {
            format!("Ticket #{number} • {topic_label} • opened by {}", self.opener_name)
        };
        let reason = format!("Ticket opened by {}", self.opener_name);

        let channel_id = match rest::create_channel(
            &self.state.http,
            &token_bot,
            &self.guild_id,
            &name,
            self.cfg.category_id.as_deref(),
            &channel_topic,
            overwrites,
            &reason,
        )
        .await
        {
            Ok(id) => id,
            Err(RestError::Denied) => {
                return self
                    .fail("I couldn't create the ticket channel. I need **Manage Channels** and **Manage Roles**, and the category (if set) must still exist — ask an admin to check, then try again.")
                    .await
            }
            Err(RestError::Busy) => {
                return self.fail("Discord was busy and I couldn't open your ticket — try again in a moment.").await
            }
        };

        // Record the ticket before posting so the controls have a row to find.
        if let Err(e) = self.state.store.create_ticket(
            &channel_id,
            &self.instance_id,
            &self.guild_id,
            number,
            &self.opener_id,
            &topic_label,
        ) {
            tracing::error!(error = %e, "record ticket");
        }

        // Welcome + controls, then (if any) the intake answers.
        let staff = discord::staff_mentions(&self.cfg.staff_roles);
        let ctx = TemplateCtx {
            opener_id: &self.opener_id,
            opener_name: &self.opener_name,
            channel_id: &channel_id,
            topic: &topic_label,
            staff_mentions: &staff,
        };
        let welcome = discord::welcome_message(&self.cfg, &self.instance_id, &ctx);
        if let Err(e) = rest::post_message(&self.state.http, &token_bot, &channel_id, &welcome).await {
            tracing::warn!(?e, "post welcome");
        }
        if !self.answers.is_empty() {
            let summary = discord::intake_summary_message(&self.cfg.intake, &self.answers);
            let _ = rest::post_message(&self.state.http, &token_bot, &channel_id, &summary).await;
        }

        // Best-effort open log.
        if let Some(log) = self.cfg.log_channel_id.as_deref() {
            let line = format!(
                "\u{1F3AB} Ticket #{number:04} opened by <@{}> → <#{channel_id}>{}",
                self.opener_id,
                if topic_label.is_empty() { String::new() } else { format!(" · {topic_label}") }
            );
            let _ = rest::post_message(
                &self.state.http,
                &token_bot,
                log,
                &json!({ "content": line, "allowed_mentions": { "parse": [] } }),
            )
            .await;
        }

        let ok = discord::open_success_text(&self.cfg, &channel_id, &ctx);
        let _ = rest::edit_original_response(
            &self.state.http,
            &self.app_id,
            &self.token,
            &discord::followup_content(&ok),
        )
        .await;
    }

    /// Edit the deferred reply into a plain-language failure.
    async fn fail(&self, msg: &str) {
        let _ = rest::edit_original_response(
            &self.state.http,
            &self.app_id,
            &self.token,
            &discord::followup_content(msg),
        )
        .await;
    }
}

// ── claim ───────────────────────────────────────────────────────────────────

fn handle_claim(state: &AppState, interaction: &discord::Interaction, id: &str) -> Response {
    let cfg = match load_for_click(state, interaction, id) {
        Ok(c) => c,
        Err(msg) => return Json(discord::ephemeral_text(msg)).into_response(),
    };
    if !cfg.claim_enabled {
        return Json(discord::ephemeral_text("Claiming isn't enabled for these tickets.")).into_response();
    }
    if !discord::is_staff(interaction.actor_roles(), interaction.actor_permissions(), &cfg.staff_roles) {
        return Json(discord::ephemeral_text("Only staff can claim tickets.")).into_response();
    }
    let Some(channel_id) = interaction.channel_id.as_deref() else {
        return Json(discord::ephemeral_text("I couldn't tell which ticket this is.")).into_response();
    };
    let Some(claimer) = interaction.actor_id() else {
        return Json(discord::ephemeral_text("I couldn't tell who clicked — try again.")).into_response();
    };
    match state.store.get_ticket(channel_id) {
        Ok(Some(_)) => {}
        Ok(None) => return Json(discord::ephemeral_text("This doesn't look like an active ticket.")).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "claim lookup");
            return Json(discord::ephemeral_text("Something went wrong on my end.")).into_response();
        }
    }
    if let Err(e) = state.store.set_claim(channel_id, claimer) {
        tracing::warn!(error = %e, "record claim");
    }
    let existing = interaction.message.as_ref().and_then(|m| m.content.as_deref()).unwrap_or("");
    Json(discord::claimed_update(id, existing, claimer)).into_response()
}

// ── close ────────────────────────────────────────────────────────────────────

/// Close button → confirm with a reason modal, or (if confirmation is off) close
/// straight away.
fn handle_close_click(state: &AppState, interaction: &discord::Interaction, id: &str) -> Response {
    let cfg = match load_for_click(state, interaction, id) {
        Ok(c) => c,
        Err(msg) => return Json(discord::ephemeral_text(msg)).into_response(),
    };
    let Some(channel_id) = interaction.channel_id.as_deref() else {
        return Json(discord::ephemeral_text("I couldn't tell which ticket this is.")).into_response();
    };
    let ticket = match state.store.get_ticket(channel_id) {
        Ok(Some(t)) => t,
        Ok(None) => return Json(discord::ephemeral_text("This doesn't look like an active ticket.")).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "close lookup");
            return Json(discord::ephemeral_text("Something went wrong on my end.")).into_response();
        }
    };
    if let Some(denied) = close_permission_reply(interaction, &cfg, &ticket) {
        return denied;
    }
    if cfg.close_confirmation {
        let submit_id = discord::control_id("doclose", id);
        Json(discord::close_reason_modal(&submit_id)).into_response()
    } else {
        begin_close(state, interaction, &cfg, &ticket, "")
    }
}

/// Reason modal submitted → close with the supplied reason.
fn handle_do_close(state: &AppState, interaction: &discord::Interaction, id: &str) -> Response {
    let cfg = match load_for_click(state, interaction, id) {
        Ok(c) => c,
        Err(msg) => return Json(discord::ephemeral_text(msg)).into_response(),
    };
    let Some(channel_id) = interaction.channel_id.as_deref() else {
        return Json(discord::ephemeral_text("I couldn't tell which ticket this is.")).into_response();
    };
    let ticket = match state.store.get_ticket(channel_id) {
        Ok(Some(t)) => t,
        Ok(None) => return Json(discord::ephemeral_text("This ticket is already gone.")).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "doclose lookup");
            return Json(discord::ephemeral_text("Something went wrong on my end.")).into_response();
        }
    };
    if let Some(denied) = close_permission_reply(interaction, &cfg, &ticket) {
        return denied;
    }
    let reason = interaction.data.as_ref().map(discord::reason_from_modal).unwrap_or_default();
    begin_close(state, interaction, &cfg, &ticket, &reason)
}

/// Staff may always close; the opener may if the panel allows it.
fn close_permission_reply(interaction: &discord::Interaction, cfg: &InstanceConfig, ticket: &Ticket) -> Option<Response> {
    let actor = interaction.actor_id().unwrap_or_default();
    let staff = discord::is_staff(interaction.actor_roles(), interaction.actor_permissions(), &cfg.staff_roles);
    let is_opener = actor == ticket.opener_id;
    if staff || (is_opener && cfg.allow_opener_close) {
        return None;
    }
    Some(
        Json(discord::ephemeral_text(
            "Only staff can close this ticket.",
        ))
        .into_response(),
    )
}

/// Acknowledge the close instantly, then do transcript + delete/lock off-path.
fn begin_close(state: &AppState, interaction: &discord::Interaction, cfg: &InstanceConfig, ticket: &Ticket, reason: &str) -> Response {
    let task = CloseTask {
        state: state.clone(),
        cfg: cfg.clone(),
        ticket: ticket.clone(),
        closer_id: interaction.actor_id().unwrap_or_default().to_string(),
        closer_name: interaction.actor_name(),
        reason: reason.to_string(),
    };
    tokio::spawn(task.run());
    Json(discord::ephemeral_text("\u{1F512} Closing this ticket…")).into_response()
}

struct CloseTask {
    state: AppState,
    cfg: InstanceConfig,
    ticket: Ticket,
    closer_id: String,
    closer_name: String,
    reason: String,
}

impl CloseTask {
    async fn run(self) {
        let Some(token) = self.state.config.default_bot_token.clone() else { return };
        let channel = &self.ticket.channel_id;

        // Transcript first (best-effort), while the channel still has its history.
        if self.cfg.transcripts {
            if let Some(log) = self.cfg.log_channel_id.as_deref() {
                self.write_transcript(&token, log).await;
            }
        }

        if self.cfg.close_mode == "lock" {
            // Keep the channel: rename, mute the opener, post the closed banner.
            let _ = rest::rename_channel(&self.state.http, &token, channel, &format!("closed-{:04}", self.ticket.number)).await;
            let _ = rest::set_overwrite(
                &self.state.http,
                &token,
                channel,
                &self.ticket.opener_id,
                OVERWRITE_MEMBER,
                discord::LOCKED_OPENER_ALLOW,
                discord::LOCKED_OPENER_DENY,
            )
            .await;
            let _ = self.state.store.set_status(channel, "locked");
            let msg = discord::locked_message(&self.ticket.instance_id, &self.closer_id, &self.reason);
            let _ = rest::post_message(&self.state.http, &token, channel, &msg).await;
        } else {
            // Delete the channel outright.
            let _ = self.state.store.delete_ticket(channel);
            let reason = format!("Ticket closed by {}", self.closer_name);
            if let Err(e) = rest::delete_channel(&self.state.http, &token, channel, &reason).await {
                tracing::warn!(?e, "delete channel on close");
            }
        }
    }

    async fn write_transcript(&self, token: &str, log: &str) {
        let raw = rest::fetch_recent_messages(&self.state.http, token, &self.ticket.channel_id, 3).await;
        let lines: Vec<discord::TranscriptLine> = raw
            .iter()
            .map(|m| discord::TranscriptLine {
                author: m.author.name(),
                timestamp: m.timestamp.clone(),
                content: m.content.clone(),
            })
            .collect();
        let title = format!("ticket-{:04}", self.ticket.number);
        let html = discord::transcript_html(&title, &lines);
        let reason = self.reason.trim();
        let note = format!(
            "\u{1F4DC} Transcript for #{:04} (closed by <@{}>{}).",
            self.ticket.number,
            self.closer_id,
            if reason.is_empty() { String::new() } else { format!(" · {reason}") }
        );
        let _ = rest::upload_transcript(
            &self.state.http,
            token,
            log,
            &format!("{title}.html"),
            html,
            &note,
        )
        .await;
    }
}

// ── reopen / delete (lock mode) ───────────────────────────────────────────────

fn handle_reopen(state: &AppState, interaction: &discord::Interaction, id: &str) -> Response {
    let cfg = match load_for_click(state, interaction, id) {
        Ok(c) => c,
        Err(msg) => return Json(discord::ephemeral_text(msg)).into_response(),
    };
    if !discord::is_staff(interaction.actor_roles(), interaction.actor_permissions(), &cfg.staff_roles) {
        return Json(discord::ephemeral_text("Only staff can reopen tickets.")).into_response();
    }
    let Some(channel_id) = interaction.channel_id.as_deref() else {
        return Json(discord::ephemeral_text("I couldn't tell which ticket this is.")).into_response();
    };
    let ticket = match state.store.get_ticket(channel_id) {
        Ok(Some(t)) => t,
        Ok(None) => return Json(discord::ephemeral_text("This ticket can't be reopened.")).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "reopen lookup");
            return Json(discord::ephemeral_text("Something went wrong on my end.")).into_response();
        }
    };
    let task = ReopenTask {
        state: state.clone(),
        cfg,
        ticket,
        reopener_id: interaction.actor_id().unwrap_or_default().to_string(),
    };
    tokio::spawn(task.run());
    Json(discord::ephemeral_text("\u{1F513} Reopening this ticket…")).into_response()
}

struct ReopenTask {
    state: AppState,
    cfg: InstanceConfig,
    ticket: Ticket,
    reopener_id: String,
}

impl ReopenTask {
    async fn run(self) {
        let Some(token) = self.state.config.default_bot_token.clone() else { return };
        let channel = &self.ticket.channel_id;
        let _ = rest::set_overwrite(
            &self.state.http,
            &token,
            channel,
            &self.ticket.opener_id,
            OVERWRITE_MEMBER,
            discord::PARTICIPANT_ALLOW,
            0,
        )
        .await;
        let _ = rest::rename_channel(&self.state.http, &token, channel, &format!("ticket-{:04}", self.ticket.number)).await;
        let _ = self.state.store.set_status(channel, "open");
        let msg = discord::reopened_message(&self.ticket.instance_id, self.cfg.claim_enabled, &self.reopener_id);
        let _ = rest::post_message(&self.state.http, &token, channel, &msg).await;
    }
}

fn handle_delete(state: &AppState, interaction: &discord::Interaction, id: &str) -> Response {
    let cfg = match load_for_click(state, interaction, id) {
        Ok(c) => c,
        Err(msg) => return Json(discord::ephemeral_text(msg)).into_response(),
    };
    if !discord::is_staff(interaction.actor_roles(), interaction.actor_permissions(), &cfg.staff_roles) {
        return Json(discord::ephemeral_text("Only staff can delete tickets.")).into_response();
    }
    let Some(channel_id) = interaction.channel_id.clone() else {
        return Json(discord::ephemeral_text("I couldn't tell which ticket this is.")).into_response();
    };
    let closer_name = interaction.actor_name();
    let state2 = state.clone();
    tokio::spawn(async move {
        let Some(token) = state2.config.default_bot_token.clone() else { return };
        let _ = state2.store.delete_ticket(&channel_id);
        let reason = format!("Ticket deleted by {closer_name}");
        if let Err(e) = rest::delete_channel(&state2.http, &token, &channel_id, &reason).await {
            tracing::warn!(?e, "delete channel");
        }
    });
    Json(discord::ephemeral_text("\u{1F5D1}\u{FE0F} Deleting this ticket…")).into_response()
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// Fetch + cache the shared bot's own user id (needed for the channel overwrite).
async fn ensure_bot_id(state: &AppState, token: &str) -> Option<String> {
    state
        .bot_id
        .get_or_try_init(|| async { rest::bot_user_id(&state.http, token).await })
        .await
        .ok()
        .cloned()
}

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
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "Storage error." }))).into_response()
}
