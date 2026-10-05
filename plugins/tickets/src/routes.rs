//! HTTP surface: registry, config iframe, the config API (`/api/meta`,
//! `/api/connect`, `/api/instances`), and the Discord interactions endpoint —
//! plus the ticket lifecycle flows (open → claim → close → reopen/delete, and
//! the staff tools) that glue the pure logic in `discord.rs` to the REST calls
//! in `rest.rs`.
//!
//! Three rules shape every flow here:
//!
//! 1. **Claim the transition before doing the work.** Each flow wins its move
//!    in the store first (`Store::reserve_open`, `Store::transition`) and only
//!    the winner touches Discord — so a double-click opens one ticket, two
//!    staff closing at once close it once, and a stale button on an old
//!    message does nothing.
//! 2. **Multi-call work is deferred.** Creating a channel and posting into it,
//!    or a transcript plus a delete, won't fit Discord's ~3s window (the
//!    dispatcher allows 2.5s). The handler answers with a deferred ephemeral
//!    and spawns the work, which edits that reply (`PATCH @original`) when done.
//! 3. **A failure is said out loud and undone.** The work that failed moves
//!    the ticket back to where it was and tells the person who clicked why, in
//!    words that separate "an admin must fix a permission" from "Discord was
//!    busy — try again".

use std::collections::HashMap;
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
use tokio::sync::OnceCell;

use crate::config::Config;
use crate::discord::{self, Action, Fallback, Interaction, OpenFailure, OpenGate, TemplateCtx};
use crate::perms::{self, Grants, Overwrite, OVERWRITE_MEMBER};
use crate::rest::{
    self, BotUser, ChannelSpec, ConnectError, Discord, History, Probe, Refusal, RestError,
};
use crate::store::{
    unix_millis, ClaimOutcome, EditLookup, InstanceConfig, MaskedInstance, OpenRequest, OpenStats,
    Reserve, Status, Store, Ticket, Topic, UnclaimOutcome,
};
use crate::tasks::Tasks;
use crate::transcript;
use crate::validate;

const SOMETHING_WRONG: &str = "Something went wrong on my end — try again in a moment.";
const HTML: &str = "text/html; charset=utf-8";
/// Channels a single refused open may probe (the member's open tickets).
const MAX_PROBES: usize = 10;
/// How long a probed channel counts as known to exist.
const SEEN_TTL: Duration = Duration::from_secs(60);
/// Tickets the staff overview lists.
const MANAGE_LIST: usize = 20;

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    pub discord: Discord,
    pub config: Arc<Config>,
    pub primary_key: ed25519_dalek::VerifyingKey,
    /// The shared bot's own user, fetched once and cached — needed in a ticket
    /// channel's overwrites so the bot can see the channel it created, even
    /// when a *custom* app (whose application id differs) posted the panel.
    pub bot: Arc<OnceCell<BotUser>>,
    /// Whether the app may read message content (Discord's privileged
    /// intent), as last learned — what the config UI warns about. Transcripts
    /// don't consult it: they judge from the history they fetched.
    pub message_content: Arc<IntentCache>,
    /// Ticket channels recently confirmed to exist — see [`reconcile`].
    pub seen_channels: Arc<Mutex<HashMap<String, Instant>>>,
    /// How long a delete-mode close waits before deleting, so everyone in the
    /// channel can read why ([`discord::DELETE_GRACE_SECS`]; tests shorten it).
    pub delete_grace: Duration,
    /// The deferred flows still running, which shutdown waits for.
    pub tasks: Tasks,
}

/// How long a learned intent answer is trusted. The maintainer can be granted
/// the intent at any time; an hour later every config UI says so, restart or no.
const INTENT_TTL: Duration = Duration::from_secs(3600);

/// The app's Message Content intent, as last learned from Discord, refreshed
/// in the background once it's an hour old.
#[derive(Default)]
pub struct IntentCache {
    known: Mutex<Option<(bool, Instant)>>,
    refreshing: std::sync::atomic::AtomicBool,
}

impl IntentCache {
    pub fn get(&self) -> Option<bool> {
        self.known
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .map(|(v, _)| v)
    }

    fn stale(&self) -> bool {
        self.known
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_none_or(|(_, at)| at.elapsed() >= INTENT_TTL)
    }

    #[cfg(test)]
    pub fn set(&self, value: bool) {
        *self.known.lock().unwrap_or_else(|p| p.into_inner()) = Some((value, Instant::now()));
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
            "id": "tickets",
            "name": "Tickets",
            "description": "Private support tickets from a button or topic menu — per-ticket channel, optional intake form, staff claim and members, close with transcript.",
            "version": env!("CARGO_PKG_VERSION"),
            "publisher": "DWEEB",
            "homepage": "https://github.com/FaizoKen/DWEEB/tree/main/plugins/tickets",
            "targets": ["button", "string_select"],
            "configUrl": format!("{base}/config.html"),
            "customIdPrefix": "tickets:",
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
/// and, if so, how to invite it — and whether it can read message content
/// (`null` until known), which decides what a transcript can hold.
pub async fn meta(State(state): State<AppState>) -> Json<Value> {
    if state.message_content.stale() && state.discord.has_token() {
        let st = state.clone();
        state.tasks.spawn(async move {
            refresh_message_content(&st).await;
        });
    }
    Json(json!({
        "apiVersion": 1,
        "defaultBot": state.config.has_default_bot(),
        "inviteUrl": state.config.bot_invite_url,
        "messageContent": state.message_content.get(),
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
    let guild_id = req.guild_id.trim();
    if !validate::is_snowflake(guild_id) {
        return bad_request(
            "That server id doesn't look right — it should be 17–20 digits.".into(),
        );
    }
    if !state.discord.has_token() {
        return bad_request("This deployment has no Tickets bot configured.".into());
    }
    let bot = match ensure_bot_user(&state).await {
        Ok(b) => b,
        Err(e) => return connect_error(e),
    };
    match state.discord.connect(guild_id, &bot).await {
        Ok(result) => Json(json!(result)).into_response(),
        Err(e) => connect_error(e),
    }
}

fn connect_error(e: ConnectError) -> Response {
    (e.status(), Json(json!({ "error": e.message() }))).into_response()
}

// ── /api/instances ───────────────────────────────────────────────────────────

/// Create a new panel. The edit credential is returned exactly once here;
/// SQLite stores only its SHA-256 digest.
pub async fn create_instance(
    State(state): State<AppState>,
    Json(cfg): Json<InstanceConfig>,
) -> Response {
    if let Err(e) = validate::validate_config(&cfg) {
        return bad_request(e);
    }
    if let Some(refusal) = verify_placement(&state, &cfg).await {
        return refusal;
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

/// Replace a panel's config. The instance id is a public binding (it lives in
/// the message's `custom_id`), so this requires the separate edit token.
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
    if let Some(refusal) = verify_placement(&state, &cfg).await {
        return refusal;
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

/// Every channel a panel names must be in the panel's own server — the log
/// channel above all. The bot posts transcripts and close reasons there, and
/// the config API takes any id: without this, a panel in one server could
/// point its log at a channel in *another* server the shared bot can reach,
/// and every ticket opened would post there as the DWEEB bot — a relay for
/// spam into someone else's community. Categories are held to the same rule
/// so a config never names a place its tickets can't go.
/// Returns the refusal to send, or `None` when every channel checks out.
async fn verify_placement(state: &AppState, cfg: &InstanceConfig) -> Option<Response> {
    let categories: Vec<&str> = cfg
        .category_id
        .iter()
        .chain(cfg.topics.iter().filter_map(|t| t.category_id.as_ref()))
        .map(String::as_str)
        .collect();
    if cfg.log_channel_id.is_none() && categories.is_empty() {
        return None;
    }
    if !state.discord.has_token() {
        return Some(bad_request(
            "This deployment has no Tickets bot configured.".into(),
        ));
    }
    let channels = match state.discord.guild_channels(&cfg.guild_id).await {
        Ok(c) => c,
        Err(e) => return Some(connect_error(e)),
    };
    if let Some(log) = cfg.log_channel_id.as_deref() {
        let refusal = match channels.iter().find(|c| c.id == log) {
            Some(c) if rest::is_text_channel(c.kind) => None,
            Some(_) => Some("The log channel must be a text channel."),
            None => Some("That log channel isn't in this server — pick one from the list."),
        };
        if let Some(text) = refusal {
            return Some(bad_request(text.into()));
        }
    }
    let stray = categories.into_iter().any(|id| {
        !channels
            .iter()
            .any(|c| c.id == id && rest::is_category(c.kind))
    });
    stray.then(|| {
        bad_request(
            "A ticket category isn't in this server any more — pick it again from the list.".into(),
        )
    })
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

    let interaction: Interaction = match serde_json::from_slice(&body) {
        Ok(i) => i,
        Err(_) => return (StatusCode::BAD_REQUEST, "malformed interaction").into_response(),
    };

    match interaction.kind {
        discord::TYPE_PING => Json(discord::pong()).into_response(),
        discord::TYPE_MESSAGE_COMPONENT => handle_component(&state, &interaction).await,
        discord::TYPE_MODAL_SUBMIT => handle_modal_submit(&state, &interaction).await,
        _ => reply("Unsupported interaction."),
    }
}

async fn handle_component(state: &AppState, ix: &Interaction) -> Response {
    match discord::parse_action(ix.custom_id()) {
        Action::Open { id } => open_click(state, ix, &id).await,
        Action::Claim { id } => claim(state, ix, &id, true),
        Action::Unclaim { id } => claim(state, ix, &id, false),
        Action::Close { id } => close_click(state, ix, &id),
        Action::Reopen { id } => reopen(state, ix, &id),
        Action::Delete { id } => delete(state, ix, &id),
        Action::Members { id } => members(state, ix, &id),
        Action::AddMembers { id } => member_pick(state, ix, &id, true),
        Action::RemoveMembers { id } => member_pick(state, ix, &id, false),
        Action::Manage { id } => manage(state, ix, &id),
        _ => reply("Unknown action."),
    }
}

async fn handle_modal_submit(state: &AppState, ix: &Interaction) -> Response {
    match discord::parse_action(ix.custom_id()) {
        Action::Intake { id, topic } => intake_submit(state, ix, &id, &topic).await,
        Action::DoClose { id } => do_close(state, ix, &id),
        _ => reply("Unknown form."),
    }
}

/// An ephemeral text reply.
fn reply(text: &str) -> Response {
    Json(discord::ephemeral_text(text)).into_response()
}

/// Load a panel and run the shared guards: it exists, this is its server, and
/// a bot is configured. The `Err` is the text to reply with (the message, not
/// a built `Response`, keeps the `Err` variant small — callers wrap it).
fn load_panel(
    state: &AppState,
    ix: &Interaction,
    id: &str,
) -> Result<InstanceConfig, &'static str> {
    let cfg = match state.store.get(id) {
        Ok(Some(c)) => c,
        Ok(None) => {
            return Err("This ticket panel is no longer set up. Ask an admin to recreate it.")
        }
        Err(e) => {
            tracing::error!(error = %e, "instance lookup");
            return Err(SOMETHING_WRONG);
        }
    };
    match ix.guild_id.as_deref() {
        Some(g) if g == cfg.guild_id => {}
        Some(_) => {
            return Err(
                "This panel was set up for a different server, so I can't open tickets here.",
            )
        }
        None => return Err("Use this inside the server, not in DMs."),
    }
    if !state.discord.has_token() {
        return Err(
            "This panel isn't finished — no bot is connected. Ask an admin to reconfigure it.",
        );
    }
    Ok(cfg)
}

/// Load the ticket an in-ticket control was clicked in, and its panel. The
/// control's panel id must be the ticket's own: a crafted `custom_id` naming
/// another panel would otherwise be judged by *that* panel's staff roles.
fn load_ticket(
    state: &AppState,
    ix: &Interaction,
    id: &str,
) -> Result<(InstanceConfig, Ticket), &'static str> {
    let cfg = load_panel(state, ix, id)?;
    let Some(channel_id) = ix.channel_id.as_deref() else {
        return Err("I couldn't tell which ticket this is.");
    };
    match state.store.get_ticket(channel_id) {
        Ok(Some(t)) if t.instance_id == id => Ok((cfg, t)),
        Ok(Some(_)) => Err("These controls don't belong to this ticket."),
        Ok(None) => Err("This doesn't look like a ticket channel."),
        Err(e) => {
            tracing::error!(error = %e, "ticket lookup");
            Err(SOMETHING_WRONG)
        }
    }
}

/// What to tell someone whose action needs a state the ticket isn't in.
fn status_text(s: Status) -> &'static str {
    match s {
        Status::Pending | Status::Open => "This ticket is open.",
        Status::Closing => "This ticket is already being closed.",
        Status::Locked => "This ticket is closed.",
        Status::Reopening => "This ticket is being reopened.",
        Status::Deleting => "This ticket is being deleted.",
        Status::Closed => "This ticket is already gone.",
    }
}

/// The staff check for an in-ticket action: the panel's staff, plus the
/// ticket's topic's, plus server managers.
fn actor_is_staff(ix: &Interaction, cfg: &InstanceConfig, ticket: &Ticket) -> bool {
    discord::is_staff(
        ix.actor_roles(),
        ix.actor_permissions(),
        &discord::staff_ids(cfg, &ticket.topic_id),
    )
}

/// How a deferred flow edits the reply it deferred.
#[derive(Clone)]
struct ReplyHandle {
    app_id: String,
    token: String,
}

fn reply_handle(ix: &Interaction) -> Option<ReplyHandle> {
    Some(ReplyHandle {
        app_id: ix.application_id.clone()?,
        token: ix.token.clone()?,
    })
}

/// The immediate answer for a deferred flow: a "thinking…" reply the work will
/// edit, or — if Discord somehow sent no token to edit with — a plain note.
fn ack(handle: &Option<ReplyHandle>, fallback: &str) -> Response {
    match handle {
        Some(_) => Json(discord::deferred_ephemeral()).into_response(),
        None => reply(fallback),
    }
}

/// Edit a deferred reply. Best-effort: after a delete the reply's channel is
/// gone with it, which is fine.
async fn say(state: &AppState, handle: &Option<ReplyHandle>, text: &str) {
    if let Some(h) = handle {
        let _ = state
            .discord
            .edit_original(&h.app_id, &h.token, &discord::followup_content(text))
            .await;
    }
}

// ── opening ──────────────────────────────────────────────────────────────────

/// Panel button / select → either pop the intake modal, or reserve + defer +
/// open straight away. The anti-spam gate runs *before* the modal so a member
/// never fills in a form that would be turned away.
async fn open_click(state: &AppState, ix: &Interaction, id: &str) -> Response {
    let cfg = match load_panel(state, ix, id) {
        Ok(c) => c,
        Err(msg) => return reply(msg),
    };
    let Some(uid) = ix.actor_id() else {
        return reply("I couldn't tell who clicked — try again.");
    };
    // The chosen topic (select panels only), trusted only if it's configured.
    let topic = if cfg.target == "string_select" {
        match discord::resolve_topic(&cfg, ix.first_value()) {
            Some(t) => Some(t.clone()),
            None => return reply("Pick a topic from the menu."),
        }
    } else {
        None
    };

    if cfg.intake.is_empty() {
        return begin_open(state, ix, &cfg, id, uid, topic, Vec::new()).await;
    }
    // A form comes first. Check the gate now — without holding a slot, since
    // the member may abandon the form.
    if let Some(denied) = precheck(state, &cfg, id, uid).await {
        return denied;
    }
    // Carry the topic into the modal's submit id: the submit no longer sees
    // the select.
    let submit_id = match &topic {
        Some(t) => format!("{}intake:{id}:{}", discord::PREFIX, t.id),
        None => format!("{}intake:{id}", discord::PREFIX),
    };
    let label = topic.as_ref().map(|t| t.label.as_str()).unwrap_or("");
    Json(discord::intake_modal(&submit_id, label, &cfg.intake)).into_response()
}

/// Intake form submitted → reserve + defer + open with the answers.
async fn intake_submit(state: &AppState, ix: &Interaction, id: &str, topic_id: &str) -> Response {
    let cfg = match load_panel(state, ix, id) {
        Ok(c) => c,
        Err(msg) => return reply(msg),
    };
    let Some(uid) = ix.actor_id() else {
        return reply("I couldn't tell who submitted — try again.");
    };
    let topic = match (topic_id.is_empty(), cfg.target.as_str()) {
        (true, "string_select") => return reply("Pick a topic from the menu."),
        (true, _) => None,
        (false, _) => match cfg.topic(topic_id) {
            Some(t) => Some(t.clone()),
            None => {
                return reply("That topic isn't offered any more — pick another from the menu.")
            }
        },
    };
    let answers = ix
        .data
        .as_ref()
        .map(discord::collect_modal_values)
        .unwrap_or_default();
    begin_open(state, ix, &cfg, id, uid, topic, answers).await
}

/// The gate as a reply, without reserving anything (the pre-form check).
async fn precheck(state: &AppState, cfg: &InstanceConfig, id: &str, uid: &str) -> Option<Response> {
    let now = unix_millis();
    let gate_of =
        |s: &OpenStats| discord::open_gate(s, cfg.max_open_per_user, now, cfg.cooldown_secs);
    let mut gate = match state.store.peek_open_stats(id, uid) {
        Ok(s) => gate_of(&s),
        Err(e) => {
            tracing::error!(error = %e, "ticket anti-spam lookup");
            return Some(reply(
                "Something went wrong checking your existing tickets — try again.",
            ));
        }
    };
    if matches!(gate, OpenGate::AtLimit { .. }) && reconcile(state, id, uid).await > 0 {
        if let Ok(s) = state.store.peek_open_stats(id, uid) {
            gate = gate_of(&s);
        }
    }
    match gate {
        OpenGate::Allowed => None,
        denied => Some(refusal(state, denied, id, uid)),
    }
}

/// A refused open, pointing an at-limit member at the ticket they have.
fn refusal(state: &AppState, gate: OpenGate, id: &str, uid: &str) -> Response {
    let open = if matches!(gate, OpenGate::AtLimit { .. }) {
        state.store.open_tickets_of(id, uid).unwrap_or_default()
    } else {
        Vec::new()
    };
    reply(&discord::gate_text(gate, &open))
}

/// Reserve the member's slot (gate + placeholder row, atomically), then defer
/// and create the ticket off the 3s path.
async fn begin_open(
    state: &AppState,
    ix: &Interaction,
    cfg: &InstanceConfig,
    id: &str,
    uid: &str,
    topic: Option<Topic>,
    answers: Vec<(String, String)>,
) -> Response {
    let (Some(handle), Some(guild_id)) = (reply_handle(ix), ix.guild_id.clone()) else {
        return reply("Discord didn't send enough to open a ticket — try again.");
    };
    let opener_name = ix.actor_name();
    let now = unix_millis();
    let req = OpenRequest {
        instance_id: id,
        guild_id: &guild_id,
        opener_id: uid,
        opener_name: &opener_name,
        topic: topic.as_ref().map(|t| t.label.as_str()).unwrap_or(""),
        topic_id: topic.as_ref().map(|t| t.id.as_str()).unwrap_or(""),
        now_ms: now,
    };
    let decide = |s: &OpenStats| match discord::open_gate(
        s,
        cfg.max_open_per_user,
        now,
        cfg.cooldown_secs,
    ) {
        OpenGate::Allowed => None,
        denied => Some(denied),
    };
    let mut outcome = state.store.reserve_open(&req, decide);
    // At the cap? Maybe one of their tickets was deleted by hand — check, and
    // if so, try again with the ledger corrected.
    if matches!(outcome, Ok(Reserve::Denied(OpenGate::AtLimit { .. })))
        && reconcile(state, id, uid).await > 0
    {
        outcome = state.store.reserve_open(&req, decide);
    }
    match outcome {
        Ok(Reserve::Reserved { key, number }) => {
            let task = OpenTask {
                state: state.clone(),
                cfg: cfg.clone(),
                instance_id: id.to_string(),
                guild_id,
                opener_id: uid.to_string(),
                opener_name,
                opener_handle: ix.actor_handle(),
                topic,
                answers,
                key,
                number,
                created_at: now,
                handle,
            };
            state.tasks.spawn(task.run());
            Json(discord::deferred_ephemeral()).into_response()
        }
        Ok(Reserve::Denied(gate)) => refusal(state, gate, id, uid),
        Err(e) => {
            tracing::error!(error = %e, "reserve ticket");
            reply(SOMETHING_WRONG)
        }
    }
}

/// Probe a member's open tickets and release the slot of any whose channel is
/// gone — deleted by hand, or with the server. Without this, a ticket channel
/// removed outside the plugin held its opener at the open cap forever, with
/// nothing to close. Returns how many were released.
///
/// It runs on the 3s path, so the probes are concurrent, short, and skipped
/// for channels confirmed in the last minute: a member hammering Open at the
/// cap costs one probe per ticket per minute.
async fn reconcile(state: &AppState, instance_id: &str, opener_id: &str) -> usize {
    let Ok(open) = state.store.open_tickets_of(instance_id, opener_id) else {
        return 0;
    };
    let candidates: Vec<Ticket> = open
        .into_iter()
        .filter(|t| !recently_seen(state, &t.channel_id))
        .take(MAX_PROBES)
        .collect();
    release_vanished(state, &candidates).await
}

/// Probe tickets and mark the ones whose channel is gone; returns how many.
async fn release_vanished(state: &AppState, tickets: &[Ticket]) -> usize {
    if tickets.is_empty() {
        return 0;
    }
    let probes = join_all(
        tickets
            .iter()
            .map(|t| state.discord.channel_exists(&t.channel_id)),
    )
    .await;
    let now = unix_millis();
    let mut released = 0;
    for (t, probe) in tickets.iter().zip(probes) {
        match probe {
            Probe::Gone => {
                if state
                    .store
                    .mark_vanished(&t.channel_id, now)
                    .unwrap_or(false)
                {
                    released += 1;
                    tracing::info!(
                        channel = %t.channel_id,
                        number = t.number,
                        "ticket channel was deleted outside the plugin; released it"
                    );
                }
            }
            Probe::Exists => remember_seen(state, &t.channel_id),
            Probe::Unknown => {}
        }
    }
    released
}

fn recently_seen(state: &AppState, channel_id: &str) -> bool {
    let seen = state
        .seen_channels
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    seen.get(channel_id)
        .is_some_and(|at| at.elapsed() < SEEN_TTL)
}

fn remember_seen(state: &AppState, channel_id: &str) {
    let mut seen = state
        .seen_channels
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    if seen.len() >= 4096 {
        seen.retain(|_, at| at.elapsed() < SEEN_TTL);
    }
    seen.insert(channel_id.to_string(), Instant::now());
}

/// The deferred half of an open: create the channel, record it, post into it.
struct OpenTask {
    state: AppState,
    cfg: InstanceConfig,
    instance_id: String,
    guild_id: String,
    opener_id: String,
    opener_name: String,
    opener_handle: String,
    topic: Option<Topic>,
    answers: Vec<(String, String)>,
    key: String,
    number: i64,
    created_at: i64,
    handle: ReplyHandle,
}

impl OpenTask {
    async fn run(self) {
        let text = match self.open().await {
            Ok(text) => text,
            Err(failure) => {
                if let Err(e) = self.state.store.release(&self.key) {
                    tracing::error!(error = %e, "release ticket reservation");
                }
                discord::open_failure_text(failure).to_string()
            }
        };
        say(&self.state, &Some(self.handle.clone()), &text).await;
    }

    /// Returns the opener's success reply.
    async fn open(&self) -> Result<String, OpenFailure> {
        let bot = ensure_bot(&self.state).await.ok_or(OpenFailure::Busy)?;
        let topic_id = self.topic.as_ref().map(|t| t.id.as_str()).unwrap_or("");
        let topic_label = self
            .topic
            .as_ref()
            .map(|t| t.label.clone())
            .unwrap_or_default();
        let staff = discord::staff_ids(&self.cfg, topic_id);
        let name = discord::channel_name(&self.cfg.naming, self.number, &self.opener_handle);
        let category = self
            .topic
            .as_ref()
            .and_then(|t| t.category_id.clone())
            .or_else(|| self.cfg.category_id.clone());
        let channel_topic = if topic_label.is_empty() {
            format!(
                "Ticket #{:04} · opened by <@{}>",
                self.number, self.opener_id
            )
        } else {
            format!(
                "Ticket #{:04} · {topic_label} · opened by <@{}>",
                self.number, self.opener_id
            )
        };
        let reason = format!("Ticket #{:04} opened by {}", self.number, self.opener_name);
        let (channel_id, fallback) = self
            .create_channel(
                &bot,
                &staff,
                &name,
                category.as_deref(),
                &channel_topic,
                &reason,
            )
            .await?;

        let ticket = Ticket {
            channel_id: channel_id.clone(),
            instance_id: self.instance_id.clone(),
            guild_id: self.guild_id.clone(),
            number: self.number,
            opener_id: self.opener_id.clone(),
            opener_name: self.opener_name.clone(),
            topic: topic_label.clone(),
            topic_id: topic_id.to_string(),
            channel_name: name,
            claimed_by: None,
            status: Status::Open,
            created_at: self.created_at,
            closed_at: None,
            closed_by: None,
            lock_muted: None,
        };
        if let Err(e) = self.state.store.activate(&self.key, &ticket) {
            tracing::error!(error = %e, "record ticket");
            self.roll_back(&channel_id).await;
            return Err(OpenFailure::Internal);
        }

        // Welcome + controls. Without them nobody could close the ticket, so a
        // failure here takes the whole open back rather than leave a channel
        // with no way out.
        let mentions = discord::staff_mentions(&staff);
        let ctx = TemplateCtx {
            opener_id: &self.opener_id,
            opener_name: &self.opener_name,
            channel_id: &channel_id,
            topic: &topic_label,
            staff_mentions: &mentions,
        };
        let welcome = discord::welcome_message(&self.cfg, &self.instance_id, &ctx, &staff);
        if let Err(e) = self.state.discord.post_message(&channel_id, &welcome).await {
            tracing::warn!(?e, "post welcome — rolling the ticket back");
            self.roll_back(&channel_id).await;
            if let Err(e) = self.state.store.discard(&channel_id) {
                tracing::error!(error = %e, "discard rolled-back ticket");
            }
            return Err(match e {
                RestError::Refused(Refusal::MissingPermissions) => OpenFailure::MissingPermissions,
                // The channel vanished under us, or Discord is struggling: a
                // retry makes a fresh channel and may well work.
                RestError::Busy | RestError::Refused(Refusal::NotFound) => OpenFailure::Busy,
                // Discord read the welcome and said no — something in its text,
                // which no retry changes. "Try again" sent members round in
                // circles while every open failed the same way.
                RestError::Refused(_) => OpenFailure::WelcomeRejected,
            });
        }
        // The ticket stands without its answers, so a failure here doesn't
        // undo the open — but the opener hears, since the answers exist
        // nowhere else.
        let mut answers_lost = false;
        for msg in discord::intake_messages(&self.cfg.intake, &self.answers) {
            if let Err(e) = self.state.discord.post_message(&channel_id, &msg).await {
                tracing::warn!(?e, "post intake answers");
                answers_lost = true;
            }
        }

        match (self.cfg.log_channel_id.as_deref(), fallback) {
            (Some(log), fallback) => {
                let mut line = discord::open_log(&ticket);
                if let Some(why) = fallback {
                    line.push('\n');
                    line.push_str(&discord::fallback_log(&ticket, why));
                }
                let _ = self
                    .state
                    .discord
                    .post_message(log, &discord::log_message(&line))
                    .await;
            }
            (None, Some(why)) => {
                tracing::info!(?why, channel = %channel_id, "ticket opened outside its category");
            }
            (None, None) => {}
        }
        let mut reply = discord::open_success_text(&self.cfg, &channel_id, &ctx);
        if answers_lost {
            reply.push_str(
                "\n\u{26A0}\u{FE0F} Discord didn't take your form answers, so they aren't in the ticket — please add them there.",
            );
        }
        Ok(reply)
    }

    /// Create the channel, degrading instead of failing where a ticket can
    /// still open: with the essential grants if the bot can't grant the full
    /// set, and at the top of the server if the category is full, gone, or
    /// closed to the bot. Returns why it left the category, if it did.
    async fn create_channel(
        &self,
        bot: &BotUser,
        staff: &[String],
        name: &str,
        category: Option<&str>,
        channel_topic: &str,
        reason: &str,
    ) -> Result<(String, Option<Fallback>), OpenFailure> {
        let mut plan: Vec<(Option<&str>, Grants)> = Vec::with_capacity(4);
        if let Some(c) = category {
            plan.push((Some(c), Grants::Full));
            plan.push((Some(c), Grants::Essential));
        }
        plan.push((None, Grants::Full));
        plan.push((None, Grants::Essential));

        let mut category_trouble: Option<Fallback> = None;
        for (parent, grants) in plan {
            if parent.is_some() && category_trouble == Some(Fallback::CategoryUnavailable) {
                continue;
            }
            let spec = ChannelSpec {
                name,
                parent_id: parent,
                topic: channel_topic,
                overwrites: discord::permission_overwrites(
                    &self.guild_id,
                    &self.opener_id,
                    staff,
                    &bot.id,
                    grants,
                ),
                reason,
            };
            match self
                .state
                .discord
                .create_channel(&self.guild_id, &spec)
                .await
            {
                Ok(id) => {
                    if grants == Grants::Essential {
                        tracing::info!(
                            guild = %self.guild_id,
                            "ticket opened with essential grants: the bot lacks an optional server permission"
                        );
                    }
                    let left_category = parent.is_none() && category.is_some();
                    let why =
                        left_category.then(|| category_trouble.unwrap_or(Fallback::CategoryDenied));
                    return Ok((id, why));
                }
                Err(RestError::Refused(Refusal::MissingPermissions)) => {
                    if parent.is_some() && grants == Grants::Essential {
                        category_trouble = Some(Fallback::CategoryDenied);
                    }
                }
                Err(RestError::Refused(Refusal::CategoryProblem | Refusal::NotFound))
                    if parent.is_some() =>
                {
                    category_trouble = Some(Fallback::CategoryUnavailable);
                }
                Err(RestError::Refused(Refusal::ChannelLimit)) => {
                    return Err(OpenFailure::ChannelLimit)
                }
                Err(RestError::Refused(_)) => return Err(OpenFailure::Rejected),
                Err(RestError::Busy) => return Err(OpenFailure::Busy),
            }
        }
        Err(OpenFailure::MissingPermissions)
    }

    async fn roll_back(&self, channel_id: &str) {
        if let Err(e) = self
            .state
            .discord
            .delete_channel(channel_id, "Ticket couldn't be set up")
            .await
        {
            tracing::warn!(?e, channel = %channel_id, "couldn't roll back a half-made ticket");
        }
    }
}

// ── claim ───────────────────────────────────────────────────────────────────

/// Claim or unclaim, answered in place: the clicked control message's claim
/// line and button flip in one `UPDATE_MESSAGE`.
fn claim(state: &AppState, ix: &Interaction, id: &str, take: bool) -> Response {
    let (cfg, ticket) = match load_ticket(state, ix, id) {
        Ok(v) => v,
        Err(msg) => return reply(msg),
    };
    if !cfg.claim_enabled {
        return reply("Claiming isn't enabled for these tickets.");
    }
    if !actor_is_staff(ix, &cfg, &ticket) {
        return reply("Only staff can claim tickets.");
    }
    let Some(actor) = ix.actor_id() else {
        return reply("I couldn't tell who clicked — try again.");
    };
    let existing = ix
        .message
        .as_ref()
        .and_then(|m| m.content.as_deref())
        .unwrap_or("");
    let update =
        |claimer: Option<&str>| Json(discord::claim_update(id, existing, claimer)).into_response();
    if take {
        match state.store.claim(&ticket.channel_id, actor) {
            Ok(ClaimOutcome::Claimed) => update(Some(actor)),
            Ok(ClaimOutcome::AlreadyClaimed(by)) if by == actor => {
                reply("You've already claimed this ticket.")
            }
            Ok(ClaimOutcome::AlreadyClaimed(by)) => {
                reply(&format!("<@{by}> has already claimed this ticket."))
            }
            Ok(ClaimOutcome::NotOpen(s)) => reply(status_text(s)),
            Ok(ClaimOutcome::Missing) => reply(status_text(Status::Closed)),
            Err(e) => {
                tracing::error!(error = %e, "claim");
                reply(SOMETHING_WRONG)
            }
        }
    } else {
        let manager = discord::is_manager(ix.actor_permissions());
        match state.store.unclaim(&ticket.channel_id, actor, manager) {
            Ok(UnclaimOutcome::Released) => update(None),
            // Already unclaimed (a stale button): just show the true state.
            Ok(UnclaimOutcome::NotClaimed) => update(None),
            Ok(UnclaimOutcome::HeldBy(by)) => reply(&format!(
                "<@{by}> claimed this ticket — only they or a server manager can release it."
            )),
            Ok(UnclaimOutcome::NotOpen(s)) => reply(status_text(s)),
            Ok(UnclaimOutcome::Missing) => reply(status_text(Status::Closed)),
            Err(e) => {
                tracing::error!(error = %e, "unclaim");
                reply(SOMETHING_WRONG)
            }
        }
    }
}

// ── close ────────────────────────────────────────────────────────────────────

/// Close button → confirm with a reason modal, or (if confirmation is off) close
/// straight away.
fn close_click(state: &AppState, ix: &Interaction, id: &str) -> Response {
    let (cfg, ticket) = match load_ticket(state, ix, id) {
        Ok(v) => v,
        Err(msg) => return reply(msg),
    };
    if ticket.status != Status::Open {
        return reply(status_text(ticket.status));
    }
    if let Some(denied) = close_denied(ix, &cfg, &ticket) {
        return denied;
    }
    if cfg.close_confirmation {
        let submit_id = discord::control_id("doclose", id);
        return Json(discord::close_reason_modal(&submit_id)).into_response();
    }
    begin_close(state, ix, cfg, &ticket, String::new())
}

/// Reason modal submitted → close with the supplied reason.
fn do_close(state: &AppState, ix: &Interaction, id: &str) -> Response {
    let (cfg, ticket) = match load_ticket(state, ix, id) {
        Ok(v) => v,
        Err(msg) => return reply(msg),
    };
    if let Some(denied) = close_denied(ix, &cfg, &ticket) {
        return denied;
    }
    let reason = ix
        .data
        .as_ref()
        .map(discord::reason_from_modal)
        .unwrap_or_default();
    begin_close(state, ix, cfg, &ticket, reason)
}

/// Staff may always close; the opener may if the panel allows it.
fn close_denied(ix: &Interaction, cfg: &InstanceConfig, ticket: &Ticket) -> Option<Response> {
    if actor_is_staff(ix, cfg, ticket) {
        return None;
    }
    if cfg.allow_opener_close && ix.actor_id() == Some(ticket.opener_id.as_str()) {
        return None;
    }
    Some(reply("Only staff can close this ticket."))
}

/// Win the open → closing transition, then close off the 3s path.
fn begin_close(
    state: &AppState,
    ix: &Interaction,
    cfg: InstanceConfig,
    ticket: &Ticket,
    reason: String,
) -> Response {
    match state
        .store
        .transition(&ticket.channel_id, &[Status::Open], Status::Closing)
    {
        Ok(Some(ticket)) => {
            let handle = reply_handle(ix);
            let ack = ack(&handle, "\u{1F512} Closing this ticket…");
            let task = CloseTask {
                state: state.clone(),
                cfg,
                ticket,
                closer_id: ix.actor_id().unwrap_or_default().to_string(),
                closer_name: ix.actor_name(),
                reason,
                control_message: ix.message_id().map(str::to_string),
                handle,
            };
            state.tasks.spawn(task.run());
            ack
        }
        // Another close (or a lock) got there first.
        Ok(None) => reply(status_text(current_status(state, &ticket.channel_id))),
        Err(e) => {
            tracing::error!(error = %e, "begin close");
            reply(SOMETHING_WRONG)
        }
    }
}

fn current_status(state: &AppState, channel_id: &str) -> Status {
    state
        .store
        .get_ticket(channel_id)
        .ok()
        .flatten()
        .map(|t| t.status)
        .unwrap_or(Status::Closed)
}

struct CloseTask {
    state: AppState,
    cfg: InstanceConfig,
    ticket: Ticket,
    closer_id: String,
    closer_name: String,
    reason: String,
    /// The message whose Close button was pressed — retired once locked.
    control_message: Option<String>,
    handle: Option<ReplyHandle>,
}

impl CloseTask {
    async fn run(self) {
        if self.cfg.close_mode == "lock" {
            self.lock().await;
        } else {
            self.delete().await;
        }
    }

    fn audit(&self) -> String {
        format!(
            "Ticket #{:04} closed by {}",
            self.ticket.number, self.closer_name
        )
    }

    /// Delete mode: say so in the channel, read the history while it exists,
    /// give everyone the grace period, delete — and only then file the
    /// records, so a close that fails never leaves a log saying it happened.
    async fn delete(self) {
        let d = &self.state.discord;
        let channel = &self.ticket.channel_id;
        let started = Instant::now();
        let delete_at = unix_millis() / 1000 + self.state.delete_grace.as_secs() as i64;
        let _ = d
            .post_message(
                channel,
                &discord::closing_notice(&self.closer_id, &self.reason, delete_at),
            )
            .await;
        say(
            &self.state,
            &self.handle,
            "\u{1F512} Closing — this channel is about to be deleted.",
        )
        .await;
        let history = if self.wants_transcript() {
            Some(d.fetch_history(channel).await)
        } else {
            None
        };
        if let Some(rest) = self.state.delete_grace.checked_sub(started.elapsed()) {
            tokio::time::sleep(rest).await;
        }
        match d.delete_channel(channel, &self.audit()).await {
            Ok(()) => {
                let now = unix_millis();
                if let Err(e) = self.state.store.finish_close(
                    channel,
                    Status::Closing,
                    Status::Closed,
                    &self.closer_id,
                    now,
                ) {
                    tracing::error!(error = %e, "record closed ticket");
                }
                self.file_records(history, now).await;
            }
            Err(e) => {
                tracing::warn!(?e, channel = %channel, "close couldn't delete the channel");
                let _ = self
                    .state
                    .store
                    .transition(channel, &[Status::Closing], Status::Open);
                let _ = d
                    .post_message(channel, &discord::close_failed_notice())
                    .await;
                say(&self.state, &self.handle, close_failure_text(e)).await;
            }
        }
    }

    /// Lock mode: take away posting from everyone but staff (the one step a
    /// lock can't do without), post the closed banner with Reopen/Delete,
    /// record the ticket as locked — and only then retire the open controls,
    /// rename, and file the records.
    async fn lock(self) {
        let d = &self.state.discord;
        let channel = &self.ticket.channel_id;
        let audit = self.audit();
        // Members an earlier lock muted before a restart cut it short: its
        // mutes are still on the channel and its list still in the row
        // (recovery reopened the ticket, and this Close is the lock running
        // again), so they are this lock's to answer for too.
        let mut muted = self.ticket.lock_muted.clone().unwrap_or_default();
        let change = set_member_access(&self.state, channel, Access::Locked, None, &audit).await;
        for id in change.changed {
            if !muted.contains(&id) {
                muted.push(id);
            }
        }
        if let Some(e) = change.error {
            tracing::warn!(?e, channel = %channel, "lock couldn't change member access");
            self.undo_lock(&muted, &audit).await;
            say(&self.state, &self.handle, lock_failure_text(e)).await;
            return;
        }
        // Who this lock muted, kept before anything else can be interrupted:
        // a reopen gives exactly them their voice back — never someone staff
        // muted by hand.
        if let Err(e) = self
            .state
            .store
            .set_lock_mutes(channel, Some(&muted), Status::Closing)
        {
            tracing::error!(error = %e, "record who a lock muted");
        }
        // The Reopen/Delete controls go up *before* the old ones come down: a
        // ticket must never be left with no working buttons. If they can't be
        // posted, the lock is undone — the old Close still works.
        if let Err(e) = d
            .post_message(
                channel,
                &discord::locked_message(&self.ticket.instance_id, &self.closer_id, &self.reason),
            )
            .await
        {
            tracing::warn!(?e, channel = %channel, "post locked banner — undoing the lock");
            self.undo_lock(&muted, &audit).await;
            say(&self.state, &self.handle, lock_failure_text(e)).await;
            return;
        }
        // Locked from here, and recorded so *before* the old controls are
        // retired or the channel renamed: the rename is slow (retried, and held
        // up by Discord's rename limit), and a restart inside it used to leave
        // the ticket in `closing` — which recovery reopens — with its Close
        // already gone and the banner's Reopen/Delete refusing an "open"
        // ticket. Nobody could close it again.
        let now = unix_millis();
        match self.state.store.finish_close(
            channel,
            Status::Closing,
            Status::Locked,
            &self.closer_id,
            now,
        ) {
            Ok(true) => {}
            Ok(false) => {
                // Only a restart's recovery takes a held claim away, and then
                // the recovered state owns the ticket: touch nothing more.
                tracing::warn!(channel = %channel, "a lock lost its claim before it finished");
                return;
            }
            Err(e) => {
                tracing::error!(error = %e, "record locked ticket");
                say(&self.state, &self.handle, SOMETHING_WRONG).await;
                return;
            }
        }
        if let Some(m) = &self.control_message {
            let _ = d
                .edit_message(channel, m, &discord::retire_controls())
                .await;
        }
        // Best-effort: Discord allows two renames per channel per ten minutes,
        // and a lock must not fail over a name.
        let _ = d
            .rename_channel(
                channel,
                &discord::closed_name(&self.ticket.channel_name, self.ticket.number),
                &audit,
            )
            .await;
        let history = if self.wants_transcript() {
            Some(d.fetch_history(channel).await)
        } else {
            None
        };
        self.file_records(history, now).await;
        say(&self.state, &self.handle, "\u{1F512} Ticket closed.").await;
    }

    /// Put an unfinished lock back: give their voice back to exactly the
    /// members it muted — not every muted member, which would also unmute
    /// anyone staff muted by hand — remember any that Discord wouldn't restore
    /// (the next lock picks them up, its reopen restores them), and reopen.
    async fn undo_lock(&self, muted: &[String], audit: &str) {
        let channel = &self.ticket.channel_id;
        let mut left: Vec<String> = Vec::new();
        if !muted.is_empty() {
            let undone = set_member_access(
                &self.state,
                channel,
                Access::Participant,
                Some(muted),
                audit,
            )
            .await;
            if let Some(e) = undone.error {
                tracing::warn!(?e, channel = %channel, "couldn't restore access after a failed lock");
            }
            left = undone.failed;
        }
        let left = (!left.is_empty()).then_some(left.as_slice());
        if let Err(e) = self
            .state
            .store
            .set_lock_mutes(channel, left, Status::Closing)
        {
            tracing::error!(error = %e, "record who a failed lock left muted");
        }
        let _ = self
            .state
            .store
            .transition(channel, &[Status::Closing], Status::Open);
    }

    fn wants_transcript(&self) -> bool {
        self.cfg.transcripts && (self.cfg.log_channel_id.is_some() || self.cfg.transcript_dm)
    }

    /// The close record: the transcript (with the close line as its caption)
    /// or the bare line, in the log channel — and the transcript by DM if the
    /// panel asks for it.
    async fn file_records(&self, history: Option<History>, now: i64) {
        let d = &self.state.discord;
        let line = discord::close_log(&self.ticket, &self.closer_id, &self.reason, now);
        let html = history.map(|h| self.render_transcript(h, now));
        if let Some(log) = self.cfg.log_channel_id.as_deref() {
            let filed = match &html {
                Some(html) => d
                    .upload_file(log, &self.transcript_name(), html.as_bytes(), HTML, &line)
                    .await
                    .is_ok(),
                None => false,
            };
            if !filed {
                let _ = d.post_message(log, &discord::log_message(&line)).await;
            }
        }
        if let (true, Some(html)) = (self.cfg.transcript_dm, &html) {
            self.dm_transcript(html).await;
        }
    }

    fn transcript_name(&self) -> String {
        format!("ticket-{:04}-transcript.html", self.ticket.number)
    }

    fn render_transcript(&self, history: History, now: i64) -> String {
        let History {
            messages,
            users,
            truncated,
        } = history;
        // Judged from the history itself, never from the cached intent flag:
        // the data can't be stale, and the day the intent is granted the very
        // next transcript must stop saying the text was withheld.
        let withheld = transcript::looks_withheld(&messages);
        let mut names = transcript::Names {
            users,
            ..Default::default()
        };
        let topic_roles = self
            .cfg
            .topic(&self.ticket.topic_id)
            .map(|t| t.staff_roles.as_slice())
            .unwrap_or(&[]);
        for role in self.cfg.staff_roles.iter().chain(topic_roles) {
            names.roles.insert(role.id.clone(), role.name.clone());
        }
        let channel_name = discord::reopen_name(&self.ticket.channel_name, self.ticket.number);
        names
            .channels
            .insert(self.ticket.channel_id.clone(), channel_name.clone());
        let opener_name = if self.ticket.opener_name.is_empty() {
            names
                .users
                .get(&self.ticket.opener_id)
                .cloned()
                .unwrap_or_else(|| self.ticket.opener_id.clone())
        } else {
            self.ticket.opener_name.clone()
        };
        let meta = transcript::Meta {
            channel_name: &channel_name,
            guild_name: &self.cfg.guild_name,
            number: self.ticket.number,
            topic: &self.ticket.topic,
            opener: transcript::Person {
                id: &self.ticket.opener_id,
                name: &opener_name,
            },
            opened_at_ms: self.ticket.created_at,
            closed_by: transcript::Person {
                id: &self.closer_id,
                name: &self.closer_name,
            },
            closed_at_ms: now,
            reason: &self.reason,
            claimed_by: self.ticket.claimed_by.as_deref(),
            truncated,
            content_withheld: withheld,
        };
        transcript::render(&meta, &messages, &names)
    }

    /// Best-effort: plenty of members keep DMs from server members off.
    async fn dm_transcript(&self, html: &str) {
        let d = &self.state.discord;
        let note = if self.cfg.guild_name.is_empty() {
            format!(
                "\u{1F4DC} Here's the transcript of your ticket #{:04}.",
                self.ticket.number
            )
        } else {
            format!(
                "\u{1F4DC} Here's the transcript of your ticket #{:04} in **{}**.",
                self.ticket.number, self.cfg.guild_name
            )
        };
        let sent = match d.open_dm(&self.ticket.opener_id).await {
            Ok(dm) => {
                d.upload_file(&dm, &self.transcript_name(), html.as_bytes(), HTML, &note)
                    .await
            }
            Err(e) => Err(e),
        };
        if let Err(e) = sent {
            tracing::info!(?e, "couldn't DM a transcript to the opener");
        }
    }
}

fn close_failure_text(e: RestError) -> &'static str {
    match e {
        RestError::Refused(Refusal::MissingPermissions) => {
            "I couldn't delete this channel — the bot needs **Manage Channels** here. The ticket stays open; ask an admin to check the bot's permissions."
        }
        RestError::Busy => "Discord was busy and the ticket didn't close — try again in a moment.",
        RestError::Refused(_) => "Discord wouldn't delete this channel, so the ticket stays open.",
    }
}

fn lock_failure_text(e: RestError) -> &'static str {
    match e {
        RestError::Refused(Refusal::MissingPermissions) => {
            "I couldn't lock this ticket — the bot needs **Manage Roles** (Manage Permissions in this channel). The ticket stays open."
        }
        RestError::Busy => "Discord was busy and the ticket didn't close — try again in a moment.",
        RestError::Refused(_) => "Discord refused to lock this ticket, so it stays open.",
    }
}

/// A lock-mode Delete that didn't go through — the ticket is still *closed*
/// (locked), which the delete-mode close's "stays open" wording got wrong.
fn delete_failure_text(e: RestError) -> &'static str {
    match e {
        RestError::Refused(Refusal::MissingPermissions) => {
            "I couldn't delete this channel — the bot needs **Manage Channels** here. The ticket stays closed; ask an admin to check the bot's permissions."
        }
        RestError::Busy => {
            "Discord was busy and the channel wasn't deleted — try again in a moment."
        }
        RestError::Refused(_) => "Discord wouldn't delete this channel, so the ticket stays closed.",
    }
}

/// Same three-way split as a lock's: a permanent refusal is never "busy".
fn reopen_failure_text(e: RestError) -> &'static str {
    match e {
        RestError::Refused(Refusal::MissingPermissions) => {
            "I couldn't reopen this ticket — the bot needs **Manage Roles** (Manage Permissions in this channel)."
        }
        RestError::Busy => "Discord was busy and the ticket didn't reopen — try again in a moment.",
        RestError::Refused(_) => "Discord refused to reopen this ticket, so it stays closed.",
    }
}

/// Which way [`set_member_access`] turns people's access.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Access {
    /// Read-only: the lock.
    Locked,
    /// Read and write: a participant again.
    Participant,
}

impl Access {
    /// Whether an overwrite is one this change could touch. A lock mutes
    /// member overwrites that can see and still post (the opener, anyone
    /// added); a reopen restores muted ones — narrowed by the caller to the
    /// members the lock itself muted (`Ticket::lock_muted`), so someone staff
    /// muted by hand stays muted. A member overwrite that *hides* the channel
    /// from someone is never touched — reopening must not reveal a ticket to a
    /// person staff kept out.
    fn applies_to(self, o: &Overwrite) -> bool {
        let sees = o.allow & perms::VIEW_CHANNEL != 0;
        let muted = o.deny & perms::SEND_MESSAGES != 0;
        match self {
            Access::Locked => sees && !muted,
            Access::Participant => sees && muted,
        }
    }

    fn bits(self, grants: Grants) -> (u64, u64) {
        match self {
            Access::Locked => (grants.locked_allow(), grants.locked_deny()),
            Access::Participant => (grants.participant(), 0),
        }
    }
}

/// What [`set_member_access`] did. Every member is tried even when one fails,
/// so a caller undoing a half-done change can put back exactly the members
/// it changed — and a lock that failed for one guest no longer leaves the
/// opener muted on a ticket that went back to open.
struct AccessChange {
    /// Members whose overwrite this change wrote.
    changed: Vec<String>,
    /// Members Discord wouldn't change.
    failed: Vec<String>,
    /// The first refusal, if anything failed (or the channel couldn't be read).
    error: Option<RestError>,
}

impl AccessChange {
    fn failed_before_starting(e: RestError) -> Self {
        AccessChange {
            changed: Vec::new(),
            failed: Vec::new(),
            error: Some(e),
        }
    }
}

/// Mute or restore member overwrites on a ticket except the bot's own — the
/// opener and anyone staff added. Staff *roles* keep their access. `only`
/// narrows the change to those members (whom a lock muted, or whom a failed
/// step must put back); `None` means every member overwrite it applies to.
async fn set_member_access(
    state: &AppState,
    channel_id: &str,
    access: Access,
    only: Option<&[String]>,
    reason: &str,
) -> AccessChange {
    // Without the bot's own id its overwrite would look like a member's, and
    // a lock would mute the bot out of the channel it has to manage.
    let Some(bot) = ensure_bot(state).await else {
        return AccessChange::failed_before_starting(RestError::Busy);
    };
    let bot_id = bot.id;
    let overwrites = match state.discord.channel_overwrites(channel_id).await {
        Ok(o) => o,
        Err(e) => return AccessChange::failed_before_starting(e),
    };
    let targets: Vec<&Overwrite> = overwrites
        .iter()
        .filter(|o| {
            o.kind == OVERWRITE_MEMBER
                && o.id != bot_id
                && access.applies_to(o)
                && only.is_none_or(|ids| ids.contains(&o.id))
        })
        .collect();
    let results = join_all(
        targets
            .iter()
            .map(|o| set_access(state, channel_id, &o.id, access, reason)),
    )
    .await;
    let mut change = AccessChange {
        changed: Vec::new(),
        failed: Vec::new(),
        error: None,
    };
    for (o, result) in targets.into_iter().zip(results) {
        match result {
            Ok(Applied::Changed) => change.changed.push(o.id.clone()),
            Ok(Applied::Gone) => {}
            Err(e) => {
                change.failed.push(o.id.clone());
                change.error.get_or_insert(e);
            }
        }
    }
    change
}

/// What one member's overwrite change came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Applied {
    Changed,
    /// They've left the server. Discord refuses to write an overwrite for
    /// someone who isn't a member — and such a refusal used to fail every lock
    /// and reopen of the ticket for good, so staff couldn't close it at all.
    /// Someone who isn't in the server can't post in it either, so there is
    /// nothing to do. (Their old overwrite stays on the channel; should they
    /// rejoin, staff can lock or remove them then.)
    Gone,
}

/// Set one member's access, falling back to the essential bits when the bot
/// can't grant (or deny) the full set.
async fn set_access(
    state: &AppState,
    channel_id: &str,
    user_id: &str,
    access: Access,
    reason: &str,
) -> Result<Applied, RestError> {
    let (allow, deny) = access.bits(Grants::Full);
    let result = match state
        .discord
        .set_overwrite(channel_id, user_id, OVERWRITE_MEMBER, allow, deny, reason)
        .await
    {
        Err(RestError::Refused(Refusal::MissingPermissions)) => {
            let (allow, deny) = access.bits(Grants::Essential);
            state
                .discord
                .set_overwrite(channel_id, user_id, OVERWRITE_MEMBER, allow, deny, reason)
                .await
        }
        other => other,
    };
    match result {
        Ok(()) => Ok(Applied::Changed),
        Err(RestError::Refused(Refusal::UnknownMember)) => Ok(Applied::Gone),
        Err(e) => Err(e),
    }
}

// ── reopen / delete (lock mode) ───────────────────────────────────────────────

fn reopen(state: &AppState, ix: &Interaction, id: &str) -> Response {
    let (cfg, ticket) = match load_ticket(state, ix, id) {
        Ok(v) => v,
        Err(msg) => return reply(msg),
    };
    if !actor_is_staff(ix, &cfg, &ticket) {
        return reply("Only staff can reopen tickets.");
    }
    match state
        .store
        .transition(&ticket.channel_id, &[Status::Locked], Status::Reopening)
    {
        Ok(Some(ticket)) => {
            let handle = reply_handle(ix);
            let ack = ack(&handle, "\u{1F513} Reopening this ticket…");
            let task = ReopenTask {
                state: state.clone(),
                cfg,
                ticket,
                reopener_id: ix.actor_id().unwrap_or_default().to_string(),
                reopener_name: ix.actor_name(),
                control_message: ix.message_id().map(str::to_string),
                handle,
            };
            state.tasks.spawn(task.run());
            ack
        }
        Ok(None) => match current_status(state, &ticket.channel_id) {
            Status::Open => reply("This ticket is already open."),
            s => reply(status_text(s)),
        },
        Err(e) => {
            tracing::error!(error = %e, "begin reopen");
            reply(SOMETHING_WRONG)
        }
    }
}

struct ReopenTask {
    state: AppState,
    cfg: InstanceConfig,
    ticket: Ticket,
    reopener_id: String,
    reopener_name: String,
    control_message: Option<String>,
    handle: Option<ReplyHandle>,
}

impl ReopenTask {
    async fn run(self) {
        let d = &self.state.discord;
        let channel = &self.ticket.channel_id;
        let audit = format!(
            "Ticket #{:04} reopened by {}",
            self.ticket.number, self.reopener_name
        );
        // Exactly the members the lock muted. A ticket an older build locked
        // has no list, and restores every muted member, as it always did.
        let only = self.ticket.lock_muted.as_deref();
        let change =
            set_member_access(&self.state, channel, Access::Participant, only, &audit).await;
        if let Some(e) = change.error {
            tracing::warn!(?e, channel = %channel, "reopen couldn't restore member access");
            self.relock(&change.changed, &audit).await;
            say(&self.state, &self.handle, reopen_failure_text(e)).await;
            return;
        }
        // New controls first, the locked banner's retired only after: if they
        // can't be posted, the ticket goes back to locked, whose Reopen still
        // works.
        let msg = discord::reopened_message(
            &self.ticket.instance_id,
            self.cfg.claim_enabled,
            self.ticket.claimed_by.as_deref(),
            &self.reopener_id,
        );
        if let Err(e) = d.post_message(channel, &msg).await {
            tracing::warn!(?e, channel = %channel, "post reopened controls — staying locked");
            self.relock(&change.changed, &audit).await;
            say(&self.state, &self.handle, reopen_failure_text(e)).await;
            return;
        }
        if let Err(e) = self.state.store.finish_reopen(channel) {
            tracing::error!(error = %e, "record reopened ticket");
        }
        if let Some(m) = &self.control_message {
            let _ = d
                .edit_message(channel, m, &discord::retire_controls())
                .await;
        }
        let _ = d
            .rename_channel(
                channel,
                &discord::reopen_name(&self.ticket.channel_name, self.ticket.number),
                &audit,
            )
            .await;
        if let Some(log) = self.cfg.log_channel_id.as_deref() {
            let line = discord::reopen_log(&self.ticket, &self.reopener_id);
            let _ = d.post_message(log, &discord::log_message(&line)).await;
        }
        say(&self.state, &self.handle, "\u{1F513} Ticket reopened.").await;
    }

    /// Put a half-done reopen back: mute again exactly the members it gave
    /// their voice back — not every member who can post, which would also
    /// silence anyone who never was the lock's — and return the ticket to
    /// locked. The lock's list stays as it was: they're its again.
    async fn relock(&self, unmuted: &[String], audit: &str) {
        let channel = &self.ticket.channel_id;
        if !unmuted.is_empty() {
            let relocked =
                set_member_access(&self.state, channel, Access::Locked, Some(unmuted), audit).await;
            if let Some(e) = relocked.error {
                tracing::warn!(?e, channel = %channel, "couldn't re-lock after a failed reopen");
            }
        }
        let _ = self
            .state
            .store
            .transition(channel, &[Status::Reopening], Status::Locked);
    }
}

fn delete(state: &AppState, ix: &Interaction, id: &str) -> Response {
    let (cfg, ticket) = match load_ticket(state, ix, id) {
        Ok(v) => v,
        Err(msg) => return reply(msg),
    };
    if !actor_is_staff(ix, &cfg, &ticket) {
        return reply("Only staff can delete tickets.");
    }
    match state
        .store
        .transition(&ticket.channel_id, &[Status::Locked], Status::Deleting)
    {
        Ok(Some(ticket)) => {
            let handle = reply_handle(ix);
            let ack = ack(&handle, "\u{1F5D1}\u{FE0F} Deleting this ticket…");
            let tasks = state.tasks.clone();
            let state = state.clone();
            let actor_id = ix.actor_id().unwrap_or_default().to_string();
            let actor_name = ix.actor_name();
            tasks.spawn(async move {
                let channel = &ticket.channel_id;
                let audit = format!("Ticket #{:04} deleted by {actor_name}", ticket.number);
                match state.discord.delete_channel(channel, &audit).await {
                    Ok(()) => {
                        let _ =
                            state
                                .store
                                .transition(channel, &[Status::Deleting], Status::Closed);
                        if let Some(log) = cfg.log_channel_id.as_deref() {
                            let line = discord::delete_log(&ticket, &actor_id);
                            let _ = state
                                .discord
                                .post_message(log, &discord::log_message(&line))
                                .await;
                        }
                    }
                    Err(e) => {
                        tracing::warn!(?e, channel = %channel, "delete ticket channel");
                        let _ =
                            state
                                .store
                                .transition(channel, &[Status::Deleting], Status::Locked);
                        say(&state, &handle, delete_failure_text(e)).await;
                    }
                }
            });
            ack
        }
        Ok(None) => match current_status(state, &ticket.channel_id) {
            Status::Open => reply("This ticket was reopened — close it before deleting it."),
            s => reply(status_text(s)),
        },
        Err(e) => {
            tracing::error!(error = %e, "begin delete");
            reply(SOMETHING_WRONG)
        }
    }
}

// ── members ──────────────────────────────────────────────────────────────────

/// The Members button: staff get a private add/remove picker.
fn members(state: &AppState, ix: &Interaction, id: &str) -> Response {
    let (cfg, ticket) = match load_ticket(state, ix, id) {
        Ok(v) => v,
        Err(msg) => return reply(msg),
    };
    if ticket.status != Status::Open {
        return reply(status_text(ticket.status));
    }
    if !actor_is_staff(ix, &cfg, &ticket) {
        return reply("Only staff can add or remove people.");
    }
    Json(discord::ephemeral_message(discord::members_panel(id, None))).into_response()
}

/// A pick in the Members panel: add or remove the chosen people, then report
/// in place.
fn member_pick(state: &AppState, ix: &Interaction, id: &str, add: bool) -> Response {
    let (cfg, ticket) = match load_ticket(state, ix, id) {
        Ok(v) => v,
        Err(msg) => return reply(msg),
    };
    if ticket.status != Status::Open {
        return reply(status_text(ticket.status));
    }
    if !actor_is_staff(ix, &cfg, &ticket) {
        return reply("Only staff can add or remove people.");
    }
    let Some(handle) = reply_handle(ix) else {
        return reply("Discord didn't send enough to do that — try again.");
    };
    // Only ids Discord resolved as *users*, and never the guild's own id
    // (`@everyone`'s role). An overwrite is keyed by id alone, so acting on a
    // role's id here would replace or delete that role's overwrite — the one
    // that hides the ticket from the server, or the one that lets staff in.
    let picked: Vec<String> = ix
        .picked_users()
        .into_iter()
        .filter(|v| validate::is_snowflake(v) && *v != ticket.guild_id)
        .take(10)
        .collect();
    let task = MembersTask {
        state: state.clone(),
        instance_id: id.to_string(),
        ticket,
        actor_id: ix.actor_id().unwrap_or_default().to_string(),
        actor_name: ix.actor_name(),
        picked,
        add,
        handle,
    };
    state.tasks.spawn(task.run());
    Json(discord::deferred_update()).into_response()
}

struct MembersTask {
    state: AppState,
    instance_id: String,
    ticket: Ticket,
    actor_id: String,
    actor_name: String,
    picked: Vec<String>,
    add: bool,
    handle: ReplyHandle,
}

impl MembersTask {
    async fn run(self) {
        let d = &self.state.discord;
        let channel = &self.ticket.channel_id;
        let busy = |state: &AppState, handle: &ReplyHandle, id: &str| {
            let state = state.clone();
            let handle = handle.clone();
            let id = id.to_string();
            async move {
                let _ = state
                    .discord
                    .edit_original(
                        &handle.app_id,
                        &handle.token,
                        &discord::members_panel(
                            &id,
                            Some("Discord was busy — nothing changed. Try again in a moment."),
                        ),
                    )
                    .await;
            }
        };
        // Never guess the bot's id: an empty one would let a pick treat the
        // bot's own overwrite as a member's.
        let Some(bot) = ensure_bot(&self.state).await else {
            busy(&self.state, &self.handle, &self.instance_id).await;
            return;
        };
        let bot_id = bot.id;
        let audit = format!(
            "Ticket #{:04}: {} by {}",
            self.ticket.number,
            if self.add {
                "member added"
            } else {
                "member removed"
            },
            self.actor_name
        );
        let mut notes: Vec<String> = Vec::new();
        // The channel's overwrites as they stand: a pick may only ever touch a
        // *member* overwrite. Belt and braces behind the resolved-users check —
        // a role's overwrite is never replaced or deleted from here.
        let overwrites = match d.channel_overwrites(channel).await {
            Ok(o) => o,
            Err(e) => {
                tracing::warn!(?e, "read ticket overwrites for members");
                busy(&self.state, &self.handle, &self.instance_id).await;
                return;
            }
        };
        let role_ids: Vec<&str> = overwrites
            .iter()
            .filter(|o| o.kind != OVERWRITE_MEMBER)
            .map(|o| o.id.as_str())
            .collect();
        let targets: Vec<&String> = self
            .picked
            .iter()
            .filter(|u| {
                if **u == bot_id || role_ids.contains(&u.as_str()) {
                    return false;
                }
                if !self.add && **u == self.ticket.opener_id {
                    notes.push(format!(
                        "<@{u}> opened this ticket — close it instead of removing them."
                    ));
                    return false;
                }
                true
            })
            .collect();
        // The click found the ticket open, but a close may have started since —
        // and an add landing after a lock read the channel's overwrites would
        // leave someone able to post in a locked ticket. Check again just
        // before writing.
        let status = match self.state.store.get_ticket(channel) {
            Ok(t) => t.map_or(Status::Closed, |t| t.status),
            Err(e) => {
                tracing::error!(error = %e, "ticket lookup before changing members");
                busy(&self.state, &self.handle, &self.instance_id).await;
                return;
            }
        };
        if status != Status::Open {
            let note = format!("{} Nothing changed.", status_text(status));
            let _ = d
                .edit_original(
                    &self.handle.app_id,
                    &self.handle.token,
                    &discord::members_panel(&self.instance_id, Some(&note)),
                )
                .await;
            return;
        }
        let results = join_all(targets.iter().map(|u| async {
            if self.add {
                match set_access(&self.state, channel, u, Access::Participant, &audit).await {
                    Ok(Applied::Changed) => Ok(()),
                    // Not in the server: nobody to let in.
                    Ok(Applied::Gone) => Err(RestError::Refused(Refusal::UnknownMember)),
                    Err(e) => Err(e),
                }
            } else {
                d.delete_overwrite(channel, u, &audit).await
            }
        }))
        .await;
        let mut done: Vec<String> = Vec::new();
        let mut failed: Option<RestError> = None;
        for (u, r) in targets.into_iter().zip(results) {
            match r {
                Ok(()) => done.push(u.clone()),
                Err(e) => {
                    tracing::warn!(?e, "change ticket member access");
                    failed.get_or_insert(e);
                }
            }
        }
        if !done.is_empty() {
            let note = if self.add {
                discord::members_added_note(&self.actor_id, &done)
            } else {
                discord::members_removed_note(&self.actor_id, &done)
            };
            let _ = d.post_message(channel, &note).await;
            let who = done
                .iter()
                .map(|u| format!("<@{u}>"))
                .collect::<Vec<_>>()
                .join(", ");
            notes.insert(
                0,
                format!(
                    "\u{2705} {} {who}.",
                    if self.add { "Added" } else { "Removed" }
                ),
            );
        }
        if let Some(e) = failed {
            notes.push(
                match e {
                    RestError::Refused(Refusal::MissingPermissions) => {
                        "Some changes didn't go through — the bot needs **Manage Roles** (Manage Permissions in this channel)."
                    }
                    RestError::Refused(Refusal::UnknownMember) => {
                        "Some of them aren't in this server, so they couldn't be added."
                    }
                    _ => "Some changes didn't go through — Discord was busy. Try again in a moment.",
                }
                .to_string(),
            );
        }
        let note = (!notes.is_empty()).then(|| notes.join("\n"));
        let _ = d
            .edit_original(
                &self.handle.app_id,
                &self.handle.token,
                &discord::members_panel(&self.instance_id, note.as_deref()),
            )
            .await;
    }
}

// ── the staff overview (Message Info → Manage tickets) ────────────────────────

/// `tickets:manage:<id>`: a private list of the panel's tickets for its staff,
/// with channels deleted by hand cleaned out first.
fn manage(state: &AppState, ix: &Interaction, id: &str) -> Response {
    let cfg = match load_panel(state, ix, id) {
        Ok(c) => c,
        Err(msg) => return reply(msg),
    };
    if !discord::is_staff(
        ix.actor_roles(),
        ix.actor_permissions(),
        &discord::staff_ids(&cfg, ""),
    ) {
        return reply("Only this panel's staff can see its tickets.");
    }
    let handle = reply_handle(ix);
    let ack = ack(&handle, "Loading tickets…");
    let tasks = state.tasks.clone();
    let state = state.clone();
    let id = id.to_string();
    tasks.spawn(async move {
        let tickets = state
            .store
            .active_tickets(&id, MANAGE_LIST)
            .unwrap_or_default();
        let unknown: Vec<Ticket> = tickets
            .iter()
            .filter(|t| !recently_seen(&state, &t.channel_id))
            .cloned()
            .collect();
        release_vanished(&state, &unknown).await;
        let tickets = state
            .store
            .active_tickets(&id, MANAGE_LIST)
            .unwrap_or_default();
        say(
            &state,
            &handle,
            &discord::manage_text(&tickets, MANAGE_LIST),
        )
        .await;
    });
    ack
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// Fetch + cache the shared bot's own user (needed for the channel overwrite).
async fn ensure_bot_user(state: &AppState) -> Result<BotUser, ConnectError> {
    state
        .bot
        .get_or_try_init(|| async { state.discord.bot_user().await })
        .await
        .cloned()
}

async fn ensure_bot(state: &AppState) -> Option<BotUser> {
    ensure_bot_user(state).await.ok()
}

/// Re-learn whether this app may read message content. One refresh at a time;
/// a failure leaves the last answer (or none) in place for the next try.
pub async fn refresh_message_content(state: &AppState) {
    use std::sync::atomic::Ordering;
    let cache = &state.message_content;
    if cache.refreshing.swap(true, Ordering::AcqRel) {
        return;
    }
    if let Ok(value) = state.discord.message_content_intent().await {
        *cache.known.lock().unwrap_or_else(|p| p.into_inner()) = Some((value, Instant::now()));
    }
    cache.refreshing.store(false, Ordering::Release);
}

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
