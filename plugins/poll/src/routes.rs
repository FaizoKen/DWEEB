//! HTTP surface: registry, config iframe, the config API (`/api/meta`,
//! `/api/connect`, `/api/instances`), and the Discord interactions endpoint —
//! plus the poll lifecycle (vote → change/retract → close/reopen) that glues
//! the pure logic in `discord.rs` to the store and the token-free REST calls.
//!
//! Every member-facing step is pure request/response. The live tallies (and,
//! with placeholders, the whole body) are restamped by an `UPDATE_MESSAGE`
//! reply to each click *on the public message* — no bot token. That one reply
//! is then spent, so anything else the click needs (the voting panel, a vote
//! confirmation, the host controls) rides an ephemeral *followup* via the
//! interaction's own webhook token. Actions on those ephemeral panels — a pick,
//! a retract, a close — can't reach the public message in their reply, so they
//! refresh it *out of band*: each public-message click we answer caches the
//! token whose `@original` is the message (see [`AppState::refreshers`]), and
//! the panel actions reuse it to edit the message immediately (a restart or a
//! gap of more than ~15 minutes just falls back to the next click on the
//! message). The close / results announcements are public (non-ephemeral)
//! interaction responses; again, no token.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Json, Response},
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::config::Config;
use crate::discord::{self, Action, BoundPatch, PickError, Votable};
use crate::store::{
    unix_millis, Cast, EditLookup, InstanceConfig, MaskedInstance, Poll, Requirements, Status,
    Store, Tallies,
};
use crate::validate;

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    pub http: reqwest::Client,
    pub config: Arc<Config>,
    pub primary_key: ed25519_dalek::VerifyingKey,
    /// How to refresh each poll's public message *out of band*, keyed by
    /// instance id. Captured whenever we answer a click on the public message
    /// with an `UPDATE_MESSAGE` (so `@original` of that interaction's token is
    /// the public message): a later pick / retract / close / reopen happens on
    /// an ephemeral panel and can't reach the message, so it reuses this handle
    /// to bring the tallies / status onto the message immediately instead of
    /// waiting for the next click on it. RAM-only — the tokens are ~15-minute
    /// bearer credentials, so they are never persisted; a restart or an
    /// expired/absent entry just falls back to that next-click refresh.
    pub refreshers: Arc<Mutex<RefresherCache>>,
}

/// A captured way to edit one poll's public message after the fact: the
/// interaction token whose `@original` is that message, plus the message shape
/// we last saw, to re-render from. See [`AppState::refreshers`].
pub struct Refresher {
    application_id: String,
    token: String,
    message: discord::MessageRef,
    stored_at_ms: i64,
}

/// Small, short-lived cache of public-message edit handles. Sweeping the whole
/// map on every vote would make each click O(number of active polls); keep the
/// same TTL while amortising that scan to at most once per minute.
#[derive(Default)]
pub struct RefresherCache {
    entries: HashMap<String, Refresher>,
    next_sweep_at_ms: i64,
}

/// How long a captured [`Refresher`] is usable — comfortably inside Discord's
/// ~15-minute interaction-token window, with margin so we never PATCH with a
/// token about to expire.
const REFRESHER_TTL_MS: i64 = 14 * 60 * 1000;
const REFRESHER_SWEEP_INTERVAL_MS: i64 = 60 * 1000;

impl RefresherCache {
    fn insert(&mut self, id: String, entry: Refresher, now_ms: i64) {
        if now_ms >= self.next_sweep_at_ms {
            self.entries
                .retain(|_, r| now_ms.saturating_sub(r.stored_at_ms) < REFRESHER_TTL_MS);
            self.next_sweep_at_ms = now_ms.saturating_add(REFRESHER_SWEEP_INTERVAL_MS);
        }
        self.entries.insert(id, entry);
    }

    fn fresh(&mut self, id: &str, now_ms: i64) -> Option<(String, String, discord::MessageRef)> {
        let expired = self
            .entries
            .get(id)
            .is_some_and(|r| now_ms.saturating_sub(r.stored_at_ms) >= REFRESHER_TTL_MS);
        if expired {
            self.entries.remove(id);
            return None;
        }
        self.entries
            .get(id)
            .map(|r| (r.application_id.clone(), r.token.clone(), r.message.clone()))
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
            "id": "poll",
            "name": "Poll",
            "description": "Run a live poll from a button or select menu — one ballot per member, change or retract, role gates, live or hidden-until-close results, an optional deadline, and host close/reopen with a public results announcement.",
            "version": env!("CARGO_PKG_VERSION"),
            "publisher": "DWEEB",
            "homepage": "https://github.com/FaizoKen/DWEEB/tree/main/plugins/poll",
            "targets": ["button", "string_select"],
            "resources": ["guild", "message"],
            "configUrl": format!("{base}/config.html"),
            "customIdPrefix": discord::PREFIX,
            "apiVersion": 2,
            "defaultEmoji": "\u{1F4CA}",
            "managesSelectOptions": true,
            "managesFields": ["min_values", "max_values"],
            "placeholders": [
                { "token": "question", "label": "Question", "sample": "the question" },
                { "token": "votes", "label": "Ballot count", "sample": "0" },
                { "token": "results", "label": "Live results", "sample": "\u{25B1}\u{25B1}\u{25B1}\u{25B1}\u{25B1}\u{25B1}\u{25B1}\u{25B1}\u{25B1}\u{25B1} 0% (0)" },
                { "token": "leader", "label": "Current leader", "sample": "TBD" },
                { "token": "status", "label": "Status", "sample": "open" },
                { "token": "closes", "label": "Closes", "sample": "soon" }
            ],
            "presets": [
                { "id": "poll-community", "name": "Community poll", "description": "What should we host next month? Four options, live results.", "emoji": "\u{1F4CA}" },
                { "id": "poll-yesno", "name": "Yes / No vote", "description": "A quick thumbs-up-or-down decision.", "emoji": "\u{1F44D}", "targets": ["button"] },
                { "id": "poll-rsvp", "name": "Event RSVP", "description": "Going / Maybe / Can't make it — with a live count.", "emoji": "\u{1F4C5}", "targets": ["button"] },
                { "id": "poll-feedback", "name": "Feedback (hidden results)", "description": "Rate the event 1–5; results reveal when the poll closes.", "emoji": "\u{2B50}" }
            ]
        }]
    }))
}

/// The configuration iframe, embedded in the binary so the deploy is one file.
pub async fn config_html() -> Html<&'static str> {
    Html(include_str!("../static/config.html"))
}

/// Capabilities the config UI adapts to: whether the shared bot is configured
/// (so it can list roles for the vote gate / host pickers) and how to invite it.
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

/// Probe a guild with the shared bot and return its roles for the vote-gate /
/// host-role pickers. Never stores anything.
pub async fn connect(State(state): State<AppState>, Json(req): Json<ConnectRequest>) -> Response {
    if !validate::is_snowflake(req.guild_id.trim()) {
        return bad_request(
            "That server id doesn't look right — it should be 17–20 digits.".into(),
        );
    }
    let Some(token) = state.config.default_bot_token.as_deref() else {
        return bad_request(
            "This deployment has no shared bot configured, so role gates can't be set up here."
                .into(),
        );
    };
    match crate::rest::connect(&state.http, token, req.guild_id.trim()).await {
        Ok(result) => Json(json!(result)).into_response(),
        Err(e) => (e.status(), Json(json!({ "error": e.message() }))).into_response(),
    }
}

// ── /api/instances ───────────────────────────────────────────────────────────

/// Create a new poll. The edit credential is returned exactly once here;
/// SQLite stores only its SHA-256 digest. The caller wraps the id as
/// `custom_id = "poll:<id>"`.
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

/// Replace a poll's config (reconfigure). Ballots, tallies and status are
/// preserved. The instance id is a public binding (it lives in the message's
/// `custom_id`), so this requires the separate edit token.
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
    match state.store.update_config(&id, edit_token, &cfg) {
        Ok(true) => Json(json!({ "id": id })).into_response(),
        Ok(false) => edit_forbidden(),
        Err(e) => {
            tracing::error!(error = %e, "update instance");
            storage_error()
        }
    }
}

/// Read a poll for the config UI: its config, live ballot count and status (so
/// the UI can show "42 ballots · open").
pub async fn get_instance(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match state.store.get(&id) {
        Ok(Some(p)) => {
            let votes = state.store.tallies(&id).map(|t| t.total).unwrap_or(0);
            Json(MaskedInstance {
                id,
                config: p.config,
                status: p.status.as_str().to_string(),
                votes,
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
/// dispatches: PING → pong, component click → the poll action.
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

fn handle_component(state: &AppState, interaction: &discord::Interaction) -> Response {
    match discord::parse_action(interaction.custom_id()) {
        Action::Vote { id } => handle_bound_click(state, interaction, &id),
        Action::Pick { id } => handle_pick(state, interaction, &id),
        Action::Panel { id } => handle_panel(state, interaction, &id),
        Action::Retract { id } => handle_retract(state, interaction, &id),
        Action::Close { id } => handle_close(state, interaction, &id),
        Action::Reopen { id } => handle_reopen(state, interaction, &id),
        Action::Results { id } => handle_results(state, interaction, &id),
        Action::Manage { id } => handle_manage(state, interaction, &id),
        Action::Unknown => Json(discord::ephemeral_text("Unknown action.")).into_response(),
    }
}

/// Load a poll + run the shared guards (exists, right guild), then lazily
/// enforce the deadline: the first interaction past `ends_at` flips the poll to
/// closed (compare-and-swap, so racing clicks close it exactly once). On
/// failure returns the plain-language message to reply with.
fn load_for_click(
    state: &AppState,
    interaction: &discord::Interaction,
    id: &str,
) -> Result<Poll, &'static str> {
    let mut p = match state.store.get(id) {
        Ok(Some(p)) => p,
        Ok(None) => return Err("This poll is no longer set up. Ask an admin to recreate it."),
        Err(e) => {
            tracing::error!(error = %e, "instance lookup");
            return Err("Something went wrong on my end.");
        }
    };
    match interaction.guild_id.as_deref() {
        Some(gid) if gid == p.config.guild_id => {}
        Some(_) => {
            return Err("This poll was set up for a different server, so it can't run here.")
        }
        None => return Err("Use this inside the server, not in DMs."),
    }
    if p.status == Status::Open {
        if let Some(deadline) = p.config.ends_at {
            if unix_millis() / 1000 > deadline {
                let _ = state.store.close(id);
                p.status = Status::Closed;
            }
        }
    }
    Ok(p)
}

// ── the bound component ──────────────────────────────────────────────────────

/// A click on the bound component: a select pick carries the ballot directly; a
/// button click opens the ephemeral voting panel (or, for a host, the control
/// panel). Every answered click on the public message refreshes its tallies in
/// the reply and captures the out-of-band edit handle.
fn handle_bound_click(state: &AppState, interaction: &discord::Interaction, id: &str) -> Response {
    let p = match load_for_click(state, interaction, id) {
        Ok(p) => p,
        Err(msg) => return Json(discord::ephemeral_text(msg)).into_response(),
    };
    let Some(uid) = interaction.actor_id() else {
        return Json(discord::ephemeral_text(
            "I couldn't tell who clicked — try again.",
        ))
        .into_response();
    };
    if p.status == Status::Closed {
        return over_response(state, interaction, &p, id);
    }

    let is_host = discord::is_host(
        interaction.actor_roles(),
        interaction.actor_permissions(),
        &p.config.host_roles,
    );

    if p.config.target == "string_select" {
        return handle_select_vote(state, interaction, &p, id, uid, is_host);
    }

    // Button target: the click opens a panel — the host controls for a host,
    // the voting panel for everyone else (after the vote gate, so a member who
    // can't vote hears why instead of receiving a dead panel).
    if is_host {
        let votes = state.store.tallies(id).map(|t| t.total).unwrap_or(0);
        let panel = discord::host_panel(id, p.status, votes);
        return Json(refresh_reply_with_followup(
            state,
            interaction,
            &p,
            id,
            panel.clone(),
            panel,
        ))
        .into_response();
    }

    match gate_for(interaction, &p, uid, false) {
        Votable::Ok => {}
        deny => return deny_response(state, interaction, &p, id, deny),
    }
    let current = state
        .store
        .ballot_of(id, uid)
        .ok()
        .flatten()
        .unwrap_or_default();
    let votes = state.store.tallies(id).map(|t| t.total).unwrap_or(0);
    let panel = discord::vote_panel(
        id,
        &p.config.options,
        p.config.max_choices,
        &current,
        p.config.allow_change,
        votes,
    );
    Json(refresh_reply_with_followup(
        state,
        interaction,
        &p,
        id,
        panel.clone(),
        panel,
    ))
    .into_response()
}

/// A pick on the bound select — the ballot rides the interaction's `values`.
fn handle_select_vote(
    state: &AppState,
    interaction: &discord::Interaction,
    p: &Poll,
    id: &str,
    uid: &str,
    is_host: bool,
) -> Response {
    match gate_for(interaction, p, uid, is_host) {
        Votable::Ok => {}
        deny => return deny_response(state, interaction, p, id, deny),
    }
    let picks = match discord::sanitize_picks(
        interaction.picked_values(),
        &p.config.options,
        p.config.max_choices,
    ) {
        Ok(picks) => picks,
        Err(e) => return Json(pick_error_text(&e)).into_response(),
    };
    match state
        .store
        .cast_ballot(id, uid, &picks, p.config.allow_change)
    {
        Ok(Cast::Locked { existing }) => {
            let labels = discord::labels_for(&existing, &p.config.options);
            Json(discord::ephemeral_text(&format!(
                "\u{1F512} Ballots are locked on this poll — you already voted for **{}**.",
                labels.join(", ")
            )))
            .into_response()
        }
        Ok(_) => {
            let tallies = state.store.tallies(id).unwrap_or_default();
            let labels = discord::labels_for(&picks, &p.config.options);
            let confirmation = discord::vote_confirmation(
                id,
                &labels,
                tallies.total,
                p.config.allow_change,
                is_host.then_some(p.status),
            );
            Json(refresh_reply_with_followup_tallies(
                state,
                interaction,
                p,
                id,
                &tallies,
                confirmation.clone(),
                confirmation,
            ))
            .into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "cast ballot");
            Json(discord::ephemeral_text(
                "Something went wrong recording your vote — try again.",
            ))
            .into_response()
        }
    }
}

// ── the ephemeral panels ─────────────────────────────────────────────────────

/// A pick on the ephemeral voting panel's select. The reply updates the panel
/// in place; the public message is refreshed out of band via the captured
/// handle (this click can't reach it).
fn handle_pick(state: &AppState, interaction: &discord::Interaction, id: &str) -> Response {
    let p = match load_for_click(state, interaction, id) {
        Ok(p) => p,
        Err(msg) => return Json(discord::ephemeral_text(msg)).into_response(),
    };
    let Some(uid) = interaction.actor_id() else {
        return Json(discord::ephemeral_text(
            "I couldn't tell who clicked — try again.",
        ))
        .into_response();
    };
    if p.status == Status::Closed {
        spawn_public_refresh(state, &p, id);
        return Json(as_update(closed_panel())).into_response();
    }
    let is_host = discord::is_host(
        interaction.actor_roles(),
        interaction.actor_permissions(),
        &p.config.host_roles,
    );
    match gate_for(interaction, &p, uid, is_host) {
        Votable::Ok => {}
        deny => return deny_response(state, interaction, &p, id, deny),
    }
    let picks = match discord::sanitize_picks(
        interaction.picked_values(),
        &p.config.options,
        p.config.max_choices,
    ) {
        Ok(picks) => picks,
        Err(e) => return Json(pick_error_text(&e)).into_response(),
    };
    match state
        .store
        .cast_ballot(id, uid, &picks, p.config.allow_change)
    {
        Ok(Cast::Locked { existing }) => {
            let labels = discord::labels_for(&existing, &p.config.options);
            Json(discord::ephemeral_text(&format!(
                "\u{1F512} Ballots are locked on this poll — you already voted for **{}**.",
                labels.join(", ")
            )))
            .into_response()
        }
        Ok(_) => {
            let tallies = state.store.tallies(id).unwrap_or_default();
            let labels = discord::labels_for(&picks, &p.config.options);
            spawn_public_refresh(state, &p, id);
            Json(as_update(discord::vote_confirmation(
                id,
                &labels,
                tallies.total,
                p.config.allow_change,
                is_host.then_some(p.status),
            )))
            .into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "cast ballot");
            Json(discord::ephemeral_text(
                "Something went wrong recording your vote — try again.",
            ))
            .into_response()
        }
    }
}

/// "Change vote" / "Vote as participant": replace the current ephemeral panel
/// with the voting panel in place.
fn handle_panel(state: &AppState, interaction: &discord::Interaction, id: &str) -> Response {
    let p = match load_for_click(state, interaction, id) {
        Ok(p) => p,
        Err(msg) => return Json(discord::ephemeral_text(msg)).into_response(),
    };
    let Some(uid) = interaction.actor_id() else {
        return Json(discord::ephemeral_text(
            "I couldn't tell who clicked — try again.",
        ))
        .into_response();
    };
    if p.status == Status::Closed {
        return Json(as_update(closed_panel())).into_response();
    }
    let is_host = discord::is_host(
        interaction.actor_roles(),
        interaction.actor_permissions(),
        &p.config.host_roles,
    );
    match gate_for(interaction, &p, uid, is_host) {
        Votable::Ok => {}
        deny => return deny_response(state, interaction, &p, id, deny),
    }
    let current = state
        .store
        .ballot_of(id, uid)
        .ok()
        .flatten()
        .unwrap_or_default();
    let votes = state.store.tallies(id).map(|t| t.total).unwrap_or(0);
    Json(as_update(discord::vote_panel(
        id,
        &p.config.options,
        p.config.max_choices,
        &current,
        p.config.allow_change,
        votes,
    )))
    .into_response()
}

/// Withdraw the actor's own ballot (from a panel button). Denied once the poll
/// is closed — results are final — and on locked-ballot polls.
fn handle_retract(state: &AppState, interaction: &discord::Interaction, id: &str) -> Response {
    let p = match load_for_click(state, interaction, id) {
        Ok(p) => p,
        Err(msg) => return Json(discord::ephemeral_text(msg)).into_response(),
    };
    let Some(uid) = interaction.actor_id() else {
        return Json(discord::ephemeral_text(
            "I couldn't tell who clicked — try again.",
        ))
        .into_response();
    };
    if p.status == Status::Closed {
        return Json(discord::ephemeral_text(
            "\u{1F512} This poll has closed — ballots can no longer be withdrawn.",
        ))
        .into_response();
    }
    if !p.config.allow_change {
        return Json(discord::ephemeral_text(
            "\u{1F512} Ballots are locked on this poll, so they can't be withdrawn.",
        ))
        .into_response();
    }
    match state.store.retract(id, uid) {
        Ok(true) => {
            spawn_public_refresh(state, &p, id);
            Json(as_update(discord::retracted_notice(id))).into_response()
        }
        Ok(false) => Json(discord::ephemeral_text(
            "You don't have a ballot on this poll.",
        ))
        .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "retract ballot");
            Json(discord::ephemeral_text(
                "Something went wrong withdrawing your ballot — try again.",
            ))
            .into_response()
        }
    }
}

// ── host actions: close / reopen / results ───────────────────────────────────

/// Re-check that the actor is a host for this poll. Returns the deny reply when
/// they aren't — never trust that only hosts can reach these custom_ids.
// The Err *is* the HTTP reply, built at most once per denied click — boxing it
// to shrink the variant would only add indirection.
#[allow(clippy::result_large_err)]
fn require_host(
    state: &AppState,
    interaction: &discord::Interaction,
    id: &str,
) -> Result<Poll, Response> {
    let p = match load_for_click(state, interaction, id) {
        Ok(p) => p,
        Err(msg) => return Err(Json(discord::ephemeral_text(msg)).into_response()),
    };
    if !discord::is_host(
        interaction.actor_roles(),
        interaction.actor_permissions(),
        &p.config.host_roles,
    ) {
        return Err(Json(discord::ephemeral_text(
            "Only a server manager (or a configured host role) can do that.",
        ))
        .into_response());
    }
    Ok(p)
}

/// The dispatcher's "Message Info" manage button: the host panel as a fresh
/// ephemeral reply. Unlike a host's click on the poll itself, this button sits
/// on the (ephemeral) info reply — there is no poll message in the interaction
/// to refresh, so the panel is the whole answer; its Close/Reopen/Post-results
/// then reach the public message out of band exactly as they do today.
fn handle_manage(state: &AppState, interaction: &discord::Interaction, id: &str) -> Response {
    let p = match require_host(state, interaction, id) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let votes = state.store.tallies(id).map(|t| t.total).unwrap_or(0);
    Json(discord::host_panel(id, p.status, votes)).into_response()
}

fn handle_close(state: &AppState, interaction: &discord::Interaction, id: &str) -> Response {
    let p = match require_host(state, interaction, id) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    if p.status == Status::Closed {
        return Json(discord::ephemeral_text(
            "This poll is already closed. Use **Post results** to announce it again, or **Reopen** to resume voting.",
        ))
        .into_response();
    }
    match state.store.close(id) {
        Ok(true) => {}
        Ok(false) => {
            return Json(discord::ephemeral_text(
                "Another host closed this poll first.",
            ))
            .into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "close poll");
            return Json(discord::ephemeral_text(
                "Something went wrong closing the poll — try again.",
            ))
            .into_response();
        }
    }
    let closed = Poll {
        config: p.config.clone(),
        status: Status::Closed,
    };
    // Bring the public message to its final state out of band (button/select
    // disabled, results revealed) — this click is on the ephemeral panel and
    // can't reach it.
    spawn_public_refresh(state, &closed, id);
    let tallies = state.store.tallies(id).unwrap_or_default();
    let vars = render_vars(&closed, &tallies);
    Json(discord::results_announcement(
        &vars,
        true,
        closed.config.close_announcement.as_deref(),
    ))
    .into_response()
}

fn handle_reopen(state: &AppState, interaction: &discord::Interaction, id: &str) -> Response {
    let p = match require_host(state, interaction, id) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    if p.status != Status::Closed {
        return Json(discord::ephemeral_text("This poll isn't closed.")).into_response();
    }
    match state.store.reopen(id) {
        Ok(true) => {}
        Ok(false) => {
            return Json(discord::ephemeral_text(
                "Another host already reopened this poll.",
            ))
            .into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "reopen poll");
            return Json(discord::ephemeral_text(
                "Something went wrong reopening the poll — try again.",
            ))
            .into_response();
        }
    }
    let mut config = p.config.clone();
    // A deadline in the past would lazy-close the poll again on the very next
    // click — reopening past it means the host wants voting back, so clear it.
    if config
        .ends_at
        .is_some_and(|deadline| unix_millis() / 1000 > deadline)
    {
        config.ends_at = None;
        if let Err(e) = state.store.update_config_unchecked(id, &config) {
            tracing::error!(error = %e, "clear stale deadline on reopen");
        }
    }
    let reopened = Poll {
        config,
        status: Status::Open,
    };
    spawn_public_refresh(state, &reopened, id);
    Json(as_update(discord::host_panel(
        id,
        Status::Open,
        state.store.tallies(id).map(|t| t.total).unwrap_or(0),
    )))
    .into_response()
}

fn handle_results(state: &AppState, interaction: &discord::Interaction, id: &str) -> Response {
    let p = match require_host(state, interaction, id) {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let tallies = state.store.tallies(id).unwrap_or_default();
    let vars = render_vars(&p, &tallies);
    // Reposting a closed poll's results uses the final wording; while open it's
    // an interim snapshot (which a host may share even on a hidden poll — their
    // call). Never the custom close template: that belongs to the close moment.
    Json(discord::results_announcement(
        &vars,
        p.status == Status::Closed,
        None,
    ))
    .into_response()
}

// ── shared reply plumbing ────────────────────────────────────────────────────

/// The vote gate for one actor. Hosts skip the role / account-age requirements
/// (it's their poll) but never the closed state. `DeadlinePassed` can only
/// surface on a race (the lazy close in [`load_for_click`] usually wins) and is
/// treated exactly like closed by [`deny_response`].
fn gate_for(interaction: &discord::Interaction, p: &Poll, uid: &str, is_host: bool) -> Votable {
    let no_requirements = Requirements::default();
    let reqs = if is_host {
        &no_requirements
    } else {
        &p.config.requirements
    };
    discord::check_votable(
        p.status,
        p.config.ends_at,
        unix_millis(),
        interaction.actor_roles(),
        discord::snowflake_to_unix_ms(uid),
        reqs,
    )
}

/// The reply for a denied vote attempt.
fn deny_response(
    state: &AppState,
    interaction: &discord::Interaction,
    p: &Poll,
    id: &str,
    deny: Votable,
) -> Response {
    match deny {
        Votable::Ok => unreachable!("deny_response called with Ok"),
        Votable::Closed | Votable::DeadlinePassed => {
            let closed = Poll {
                config: p.config.clone(),
                status: Status::Closed,
            };
            over_response(state, interaction, &closed, id)
        }
        Votable::MissingRoles => Json(discord::ephemeral_text(&discord::missing_roles_message(
            &p.config.requirements,
        )))
        .into_response(),
        Votable::AccountTooNew { needed_days } => Json(discord::ephemeral_text(&format!(
            "\u{1F512} Your account is too new to vote here — it has to be at least {needed_days} day{} old.",
            if needed_days == 1 { "" } else { "s" }
        )))
        .into_response(),
    }
}

fn pick_error_text(e: &PickError) -> Value {
    match e {
        PickError::Empty => discord::ephemeral_text("Pick at least one option."),
        PickError::Unknown => discord::ephemeral_text(
            "This poll's options have changed since this message was posted — ask a host to repost it.",
        ),
        PickError::TooMany { max } => discord::ephemeral_text(&format!(
            "Pick at most {max} option{}.",
            if *max == 1 { "" } else { "s" }
        )),
    }
}

/// The response to a click on a poll that's over: lazily flip the public
/// message to its closed state — the bound component disables, and (when the
/// host used placeholders) the `{results}` / `{status}` text settles to the
/// final tallies, revealing a hidden poll's results. This is the click that
/// finally refreshes the message after an out-of-band close missed it. Falls
/// back to an ephemeral results note if the message carried nothing editable.
fn over_response(
    state: &AppState,
    interaction: &discord::Interaction,
    p: &Poll,
    id: &str,
) -> Response {
    let tallies = state.store.tallies(id).unwrap_or_default();
    // Only a click on the PUBLIC message may flip it in the reply — a panel
    // click's message is the ephemeral panel (see `MessageRef::is_ephemeral`),
    // which must fall through to the ephemeral results note instead.
    if let Some(msg) = interaction.message.as_ref().filter(|m| !m.is_ephemeral()) {
        if let Some(data) = live_message_data(p, msg, id, &tallies) {
            remember_refresher(state, interaction, id);
            return Json(json!({ "type": 7, "data": data })).into_response();
        }
    }
    let vars = render_vars(p, &tallies);
    Json(discord::ephemeral_text(&format!(
        "\u{1F512} **This poll has closed.**\n\n{}",
        discord::results_block(&vars)
    )))
    .into_response()
}

/// Assemble the placeholder values for the poll's current state — the bridge
/// from stored config + tallies to the pure renderer in `discord.rs`.
fn render_vars(p: &Poll, t: &Tallies) -> discord::RenderVars {
    discord::RenderVars {
        question: p.config.question.clone(),
        votes: t.total,
        tallies: p
            .config
            .options
            .iter()
            .map(|o| (o.clone(), t.count_for(&o.key)))
            .collect(),
        status: p.status,
        hide_results: p.config.hide_results,
        ends_at: p.config.ends_at,
    }
}

/// How to restyle the bound component right now. A closed poll disables it and
/// relabels; an open one carries the live ballot count — on the button label
/// always, on the select placeholder only when there's no stored template (a
/// template's own substituted placeholder wins).
fn live_patch(
    p: &Poll,
    msg: &discord::MessageRef,
    bound: &str,
    vars: &discord::RenderVars,
) -> BoundPatch {
    match p.status {
        Status::Closed => BoundPatch {
            label: Some("\u{1F4CA} Poll closed".to_string()),
            placeholder: Some("\u{1F4CA} Poll closed".to_string()),
            disabled: true,
        },
        Status::Open => {
            if p.config.target == "button" {
                let base = p
                    .config
                    .message_template
                    .as_ref()
                    .and_then(discord::template_button_label)
                    .or_else(|| {
                        msg.components
                            .as_ref()
                            .and_then(|c| discord::find_button_label(c, bound))
                    })
                    .unwrap_or_else(|| "\u{1F5F3}\u{FE0F} Vote".to_string());
                BoundPatch {
                    label: Some(discord::label_with_count(
                        &discord::substitute(&base, vars),
                        vars.votes,
                    )),
                    placeholder: None,
                    disabled: false,
                }
            } else {
                let placeholder = if p.config.message_template.is_some() {
                    None
                } else {
                    let base = msg
                        .components
                        .as_ref()
                        .and_then(|c| discord::find_select_placeholder(c, bound))
                        .unwrap_or_default();
                    Some(discord::placeholder_with_count(&base, vars.votes))
                };
                BoundPatch {
                    label: None,
                    placeholder,
                    disabled: false,
                }
            }
        }
    }
}

/// The message-edit `data` that brings the bound poll message up to its current
/// state: the live tallies while open, or the final results + disabled
/// component once closed. This is the same `data` an `UPDATE_MESSAGE` reply
/// carries — returned bare so it can also drive an out-of-band `@original` edit
/// (the path that refreshes the message after a panel action). None when the
/// message carried nothing editable.
fn live_message_data(
    p: &Poll,
    msg: &discord::MessageRef,
    id: &str,
    tallies: &Tallies,
) -> Option<Value> {
    let bound = discord::bound_id(id);
    let vars = render_vars(p, tallies);
    let patch = live_patch(p, msg, &bound, &vars);
    let resp = match p.config.message_template.as_ref() {
        Some(template) => {
            discord::update_message_from_template(msg, template, &vars, &bound, &patch)
        }
        None => discord::update_component_response(msg, &bound, &patch)?,
    };
    resp.get("data").cloned()
}

/// The reply to a button click on the public message, which exists to deliver
/// a panel: refresh the message in the reply (`UPDATE_MESSAGE` — capturing the
/// out-of-band edit handle) and ship the panel as an ephemeral followup via the
/// interaction's own webhook token. The panel is the click's whole point, so
/// without a token (or anything editable) it becomes the direct (type 4) reply
/// instead — never silently dropped.
fn refresh_reply_with_followup(
    state: &AppState,
    interaction: &discord::Interaction,
    p: &Poll,
    id: &str,
    followup: Value,
    fallback: Value,
) -> Value {
    let has_token = interaction
        .application_id
        .as_deref()
        .zip(interaction.token.as_deref())
        .is_some();
    if !has_token {
        return fallback;
    }
    let tallies = state.store.tallies(id).unwrap_or_default();
    refresh_reply_with_followup_tallies(state, interaction, p, id, &tallies, followup, fallback)
}

/// The reply to a select vote on the public message: the ballot is already
/// recorded, so the refresh is the load-bearing half — it goes in the reply
/// whenever the message is editable, and the confirmation rides an ephemeral
/// followup only when the interaction carries its webhook token. With nothing
/// editable, the confirmation becomes the direct reply.
fn refresh_reply_with_followup_tallies(
    state: &AppState,
    interaction: &discord::Interaction,
    p: &Poll,
    id: &str,
    tallies: &Tallies,
    followup: Value,
    fallback: Value,
) -> Value {
    let refreshed = interaction
        .message
        .as_ref()
        .filter(|m| !m.is_ephemeral())
        .and_then(|msg| {
            let data = live_message_data(p, msg, id, tallies)?;
            if let Some((app_id, token)) = interaction
                .application_id
                .as_deref()
                .zip(interaction.token.as_deref())
            {
                if let Some(followup_data) = followup.get("data") {
                    spawn_followup(state, app_id, token, followup_data.clone());
                }
            }
            // `@original` of this click is the public message, so keep its token
            // around for later panel actions (pick/retract/close) to reuse.
            remember_refresher(state, interaction, id);
            Some(json!({ "type": 7, "data": data }))
        });
    refreshed.unwrap_or(fallback)
}

/// Capture how to edit this poll's public message later. Call this only where
/// we answer a click with an `UPDATE_MESSAGE` on the public message — then this
/// interaction's `@original` is that message, and its token can edit it for the
/// life of the token. A no-op without a token / app id / message (e.g. tests).
fn remember_refresher(state: &AppState, interaction: &discord::Interaction, id: &str) {
    let (Some(app_id), Some(token), Some(message)) = (
        interaction.application_id.as_deref(),
        interaction.token.as_deref(),
        interaction.message.as_ref(),
    ) else {
        return;
    };
    // Never capture a panel click: an ephemeral message's `@original` is the
    // panel itself, so a handle to it would aim later public-message refreshes
    // at the wrong message.
    if message.is_ephemeral() {
        return;
    }
    let now = unix_millis();
    let entry = Refresher {
        application_id: app_id.to_string(),
        token: token.to_string(),
        message: message.clone(),
        stored_at_ms: now,
    };
    if let Ok(mut cache) = state.refreshers.lock() {
        cache.insert(id.to_string(), entry, now);
    }
}

/// Best-effort: bring a poll's public message current out of band after an
/// action on an ephemeral panel — a pick, retract, close or reopen — which
/// can't reach the message itself. Reuses the token captured by
/// [`remember_refresher`] from an earlier public-message click (whose
/// `@original` is the message); renders the new state from the message shape we
/// stored. A no-op when there's no fresh captured handle, nothing editable, or
/// no async runtime (tests).
fn spawn_public_refresh(state: &AppState, p: &Poll, id: &str) {
    let now = unix_millis();
    let captured = state
        .refreshers
        .lock()
        .ok()
        .and_then(|mut cache| cache.fresh(id, now));
    let Some((app_id, token, message)) = captured else {
        return;
    };
    let tallies = state.store.tallies(id).unwrap_or_default();
    let Some(data) = live_message_data(p, &message, id, &tallies) else {
        return;
    };
    if tokio::runtime::Handle::try_current().is_err() {
        return;
    }
    let http = state.http.clone();
    tokio::spawn(async move {
        if !crate::rest::edit_original_message(&http, &app_id, &token, &data).await {
            tracing::debug!("poll public-message refresh didn't land");
        }
    });
}

/// Best-effort: post an interaction followup (a panel / confirmation) via the
/// interaction's own webhook token, off the reply path. Skipped when no async
/// runtime is present (the lifecycle tests drive the handlers on a bare
/// executor); in production axum always provides one.
fn spawn_followup(state: &AppState, app_id: &str, token: &str, data: Value) {
    if tokio::runtime::Handle::try_current().is_err() {
        return;
    }
    let http = state.http.clone();
    let (app_id, token) = (app_id.to_string(), token.to_string());
    tokio::spawn(async move {
        // A short beat so Discord has registered our (message-edit) reply before
        // the followup lands.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        if !crate::rest::create_followup_message(&http, &app_id, &token, &data).await {
            tracing::debug!("poll panel followup didn't land");
        }
    });
}

/// The ephemeral notice shown when a panel action lands on a closed poll. Built
/// the same (non-V2) way as the other panels so it can replace them in place.
fn closed_panel() -> Value {
    json!({
        "type": 4,
        "data": {
            "flags": 64,
            "content": "\u{1F512} This poll has closed — thanks for voting!",
            "allowed_mentions": { "parse": [] },
        }
    })
}

/// Turn a freshly-built (type 4) ephemeral reply into an `UPDATE_MESSAGE` (type
/// 7) so it edits the ephemeral panel in place rather than stacking a new one.
fn as_update(mut resp: Value) -> Value {
    resp["type"] = json!(7);
    resp
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

#[cfg(test)]
mod tests {
    //! Lifecycle integration tests: drive the real interaction handlers against a
    //! live (in-memory) store and assert the Discord payloads they emit — the
    //! glue the pure `discord.rs` tests can't cover (store reads, the
    //! template-vs-fallback branch, the lazy deadline close, the close→over
    //! refresh).

    use super::*;
    use crate::config::Config;
    use crate::store::{PollOption, Requirements, RoleRef};

    const MANAGE_GUILD: &str = "32"; // 1 << 5
    const TEST_EDIT_TOKEN: &str =
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    fn test_state() -> AppState {
        let store = Store::open(":memory:").expect("open store");
        // RFC 8032 test-vector public key: a valid point without needing a
        // signing key in these handler-only tests.
        let public_key =
            "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a".to_string();
        let config = Config {
            port: 0,
            public_base_url: "http://localhost".into(),
            discord_public_key: public_key.clone(),
            dispatcher_forward_secret: None,
            database_path: ":memory:".into(),
            default_bot_token: None,
            bot_invite_url: None,
        };
        AppState {
            store: Arc::new(store),
            http: reqwest::Client::new(),
            config: Arc::new(config),
            primary_key: discord::parse_verifying_key(&public_key).unwrap(),
            refreshers: Default::default(),
        }
    }

    fn opt(key: &str, label: &str) -> PollOption {
        PollOption {
            key: key.into(),
            label: label.into(),
            description: None,
            emoji: None,
        }
    }

    /// A poll config in guild `1`, optionally carrying a message template.
    fn config_with(target: &str, template: Option<Value>) -> InstanceConfig {
        InstanceConfig {
            target: target.into(),
            guild_id: "1".into(),
            guild_name: String::new(),
            question: "What next?".into(),
            options: vec![opt("a", "Movie night"), opt("b", "Game night")],
            max_choices: 1,
            allow_change: true,
            hide_results: false,
            ends_at: None,
            requirements: Requirements::default(),
            host_roles: vec![],
            close_announcement: None,
            message_template: template,
        }
    }

    /// A host message that uses the live placeholders, plus the bound select.
    fn select_template(id: &str) -> Value {
        json!([
            { "type": 10, "content": "\u{1F4CA} {question}\n{results}\nTotal: {votes} [{status}]" },
            { "type": 1, "components": [
                { "type": 3, "custom_id": format!("poll:{id}"), "placeholder": "Cast your vote", "options": [
                    { "label": "Movie night", "value": "a" }, { "label": "Game night", "value": "b" }
                ]}
            ]}
        ])
    }

    fn button_template(id: &str) -> Value {
        json!([
            { "type": 10, "content": "\u{1F4CA} {question}\n{results}\nTotal: {votes} [{status}]" },
            { "type": 1, "components": [
                { "type": 2, "style": 1, "label": "\u{1F5F3}\u{FE0F} Vote", "custom_id": format!("poll:{id}") }
            ]}
        ])
    }

    fn select_click(
        id: &str,
        user: &str,
        perms: &str,
        values: &[&str],
        components: Value,
    ) -> discord::Interaction {
        serde_json::from_value(json!({
            "type": 3,
            "guild_id": "1",
            "data": { "custom_id": format!("poll:{id}"), "values": values },
            "member": { "user": { "id": user }, "roles": [], "permissions": perms },
            "message": { "content": "", "components": components, "flags": 32768 }
        }))
        .expect("interaction")
    }

    fn button_click(id: &str, user: &str, perms: &str, components: Value) -> discord::Interaction {
        serde_json::from_value(json!({
            "type": 3,
            "guild_id": "1",
            "data": { "custom_id": format!("poll:{id}") },
            "member": { "user": { "id": user }, "roles": [], "permissions": perms },
            "message": { "content": "", "components": components, "flags": 32768 }
        }))
        .expect("interaction")
    }

    /// A click on an ephemeral panel control (`poll:<verb>:<id>`), optionally a
    /// pick with select values.
    fn panel_click(
        id: &str,
        verb: &str,
        user: &str,
        perms: &str,
        values: &[&str],
    ) -> discord::Interaction {
        serde_json::from_value(json!({
            "type": 3,
            "guild_id": "1",
            "data": { "custom_id": format!("poll:{verb}:{id}"), "values": values },
            "member": { "user": { "id": user }, "roles": [], "permissions": perms },
            "message": { "content": "", "components": Value::Null, "flags": 64 }
        }))
        .expect("interaction")
    }

    /// A click that carries an interaction token (as Discord always sends), so
    /// the public message is refreshed in the reply.
    fn tokened_select_click(
        id: &str,
        user: &str,
        values: &[&str],
        components: Value,
    ) -> discord::Interaction {
        serde_json::from_value(json!({
            "type": 3,
            "guild_id": "1",
            "application_id": "999000",
            "token": "tok_abc",
            "data": { "custom_id": format!("poll:{id}"), "values": values },
            "member": { "user": { "id": user }, "roles": [], "permissions": "0" },
            "message": { "content": "", "components": components, "flags": 32768 }
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
    fn a_select_vote_renders_tallies_into_the_message() {
        let state = test_state();
        let id = "abc";
        state
            .store
            .create(
                id,
                TEST_EDIT_TOKEN,
                &config_with("string_select", Some(select_template(id))),
            )
            .unwrap();

        let resp = handle_component(
            &state,
            &select_click(id, "555", "0", &["a"], select_template(id)),
        );
        let v = body_json(resp);
        assert_eq!(v["type"], 7); // UPDATE_MESSAGE
        let s = v.to_string();
        assert!(s.contains("What next?"), "{s}");
        assert!(s.contains("**Movie night**"), "{s}");
        assert!(s.contains("100% (1)"), "{s}");
        assert!(s.contains("Total: 1 [open]"), "{s}");
        assert!(s.contains("\"disabled\":false"), "{s}");
        // The ballot landed.
        assert_eq!(state.store.tallies(id).unwrap().total, 1);
    }

    #[test]
    fn changing_a_vote_moves_the_tally_but_not_the_total() {
        let state = test_state();
        let id = "abc";
        state
            .store
            .create(
                id,
                TEST_EDIT_TOKEN,
                &config_with("string_select", Some(select_template(id))),
            )
            .unwrap();
        let _ = handle_component(
            &state,
            &select_click(id, "555", "0", &["a"], select_template(id)),
        );
        let v = body_json(handle_component(
            &state,
            &select_click(id, "555", "0", &["b"], select_template(id)),
        ));
        let s = v.to_string();
        assert!(s.contains("Total: 1 [open]"), "{s}");
        let t = state.store.tallies(id).unwrap();
        assert_eq!(t.total, 1);
        assert_eq!(t.count_for("a"), 0);
        assert_eq!(t.count_for("b"), 1);
    }

    #[test]
    fn a_locked_poll_refuses_a_second_ballot_with_the_existing_picks() {
        let state = test_state();
        let id = "abc";
        let mut cfg = config_with("string_select", None);
        cfg.allow_change = false;
        state.store.create(id, TEST_EDIT_TOKEN, &cfg).unwrap();
        let _ = handle_component(
            &state,
            &select_click(id, "555", "0", &["a"], select_template(id)),
        );
        let v = body_json(handle_component(
            &state,
            &select_click(id, "555", "0", &["b"], select_template(id)),
        ));
        let s = v.to_string();
        assert!(s.contains("locked"), "{s}");
        assert!(s.contains("**Movie night**"), "{s}");
        assert_eq!(state.store.tallies(id).unwrap().count_for("b"), 0);
    }

    #[test]
    fn a_forged_value_is_refused_and_never_counted() {
        let state = test_state();
        let id = "abc";
        state
            .store
            .create(id, TEST_EDIT_TOKEN, &config_with("string_select", None))
            .unwrap();
        let v = body_json(handle_component(
            &state,
            &select_click(id, "555", "0", &["zzz"], select_template(id)),
        ));
        assert!(v.to_string().contains("options have changed"), "{v}");
        assert_eq!(state.store.tallies(id).unwrap().total, 0);
    }

    #[test]
    fn a_button_click_without_a_token_falls_back_to_the_vote_panel() {
        let state = test_state();
        let id = "abc";
        state
            .store
            .create(id, TEST_EDIT_TOKEN, &config_with("button", None))
            .unwrap();
        let v = body_json(handle_component(
            &state,
            &button_click(id, "555", "0", button_template(id)),
        ));
        assert_eq!(v["type"], 4);
        let s = v.to_string();
        assert!(s.contains(&format!("poll:pick:{id}")), "{s}");
        assert!(s.contains("Cast your vote"), "{s}");
    }

    #[test]
    fn a_hosts_button_click_falls_back_to_the_host_panel() {
        let state = test_state();
        let id = "abc";
        state
            .store
            .create(id, TEST_EDIT_TOKEN, &config_with("button", None))
            .unwrap();
        let v = body_json(handle_component(
            &state,
            &button_click(id, "1", MANAGE_GUILD, button_template(id)),
        ));
        assert_eq!(v["type"], 4);
        let s = v.to_string();
        assert!(s.contains("Host controls"), "{s}");
        assert!(s.contains(&format!("poll:close:{id}")), "{s}");
    }

    #[test]
    fn a_pick_on_the_ephemeral_panel_updates_it_in_place_and_records_the_ballot() {
        let state = test_state();
        let id = "abc";
        state
            .store
            .create(id, TEST_EDIT_TOKEN, &config_with("button", None))
            .unwrap();
        let v = body_json(handle_component(
            &state,
            &panel_click(id, "pick", "555", "0", &["a"]),
        ));
        assert_eq!(v["type"], 7); // updates the ephemeral panel in place
        let s = v.to_string();
        assert!(s.contains("Vote recorded"), "{s}");
        assert!(s.contains("**Movie night**"), "{s}");
        assert_eq!(state.store.tallies(id).unwrap().total, 1);
    }

    #[test]
    fn retract_withdraws_the_ballot_and_updates_the_panel() {
        let state = test_state();
        let id = "abc";
        state
            .store
            .create(id, TEST_EDIT_TOKEN, &config_with("button", None))
            .unwrap();
        let _ = handle_component(&state, &panel_click(id, "pick", "555", "0", &["a"]));
        let v = body_json(handle_component(
            &state,
            &panel_click(id, "retract", "555", "0", &[]),
        ));
        assert_eq!(v["type"], 7);
        assert!(v.to_string().contains("withdrawn"), "{v}");
        assert_eq!(state.store.tallies(id).unwrap().total, 0);

        let again = body_json(handle_component(
            &state,
            &panel_click(id, "retract", "555", "0", &[]),
        ));
        assert!(again.to_string().contains("don't have a ballot"), "{again}");
    }

    #[test]
    fn close_announces_publicly_and_a_later_click_flips_the_message() {
        let state = test_state();
        let id = "abc";
        state
            .store
            .create(
                id,
                TEST_EDIT_TOKEN,
                &config_with("string_select", Some(select_template(id))),
            )
            .unwrap();
        let _ = handle_component(
            &state,
            &select_click(id, "100", "0", &["a"], select_template(id)),
        );

        // A non-host can't close.
        let denied = body_json(handle_component(
            &state,
            &panel_click(id, "close", "9", "0", &[]),
        ));
        assert!(denied.to_string().contains("server manager"), "{denied}");

        // A host closes: public (type 4) announcement with the final results.
        let closed = body_json(handle_component(
            &state,
            &panel_click(id, "close", "1", MANAGE_GUILD, &[]),
        ));
        assert_eq!(closed["type"], 4);
        let s = closed["data"]["content"].as_str().unwrap();
        assert!(s.contains("Poll closed"), "{s}");
        assert!(s.contains("**Movie night**"), "{s}");
        assert_eq!(
            closed["data"]["allowed_mentions"]["parse"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert!(matches!(
            state.store.get(id).unwrap().unwrap().status,
            Status::Closed
        ));

        // The next click on the message settles it: results final, select disabled.
        let over = body_json(handle_component(
            &state,
            &select_click(id, "999", "0", &["b"], select_template(id)),
        ));
        assert_eq!(over["type"], 7);
        let s = over.to_string();
        assert!(s.contains("[closed]"), "{s}");
        assert!(s.contains("\u{1F3C6}"), "{s}");
        assert!(s.contains("\"disabled\":true"), "{s}");
        // And the late ballot was never counted.
        assert_eq!(state.store.tallies(id).unwrap().total, 1);
    }

    #[test]
    fn hidden_results_stay_hidden_open_and_reveal_on_close() {
        let state = test_state();
        let id = "abc";
        let mut cfg = config_with("string_select", Some(select_template(id)));
        cfg.hide_results = true;
        state.store.create(id, TEST_EDIT_TOKEN, &cfg).unwrap();

        let open = body_json(handle_component(
            &state,
            &select_click(id, "100", "0", &["a"], select_template(id)),
        ));
        let s = open.to_string();
        assert!(s.contains("hidden until the poll closes"), "{s}");
        assert!(!s.contains("**Movie night** \u{25B0}"), "{s}");

        let closed = body_json(handle_component(
            &state,
            &panel_click(id, "close", "1", MANAGE_GUILD, &[]),
        ));
        let s = closed["data"]["content"].as_str().unwrap();
        assert!(s.contains("**Movie night**"), "{s}");
        assert!(s.contains("100%"), "{s}");
    }

    #[test]
    fn a_passed_deadline_lazily_closes_on_the_next_click() {
        let state = test_state();
        let id = "abc";
        let mut cfg = config_with("string_select", Some(select_template(id)));
        cfg.ends_at = Some(unix_millis() / 1000 - 60);
        state.store.create(id, TEST_EDIT_TOKEN, &cfg).unwrap();

        let v = body_json(handle_component(
            &state,
            &select_click(id, "555", "0", &["a"], select_template(id)),
        ));
        // The click that found the deadline flips the message to closed…
        assert_eq!(v["type"], 7);
        assert!(v.to_string().contains("[closed]"), "{v}");
        // …the vote is NOT counted, and the store status is settled.
        assert_eq!(state.store.tallies(id).unwrap().total, 0);
        assert!(matches!(
            state.store.get(id).unwrap().unwrap().status,
            Status::Closed
        ));
    }

    #[test]
    fn reopen_clears_a_passed_deadline_so_voting_actually_resumes() {
        let state = test_state();
        let id = "abc";
        let mut cfg = config_with("string_select", None);
        cfg.ends_at = Some(unix_millis() / 1000 - 60);
        state.store.create(id, TEST_EDIT_TOKEN, &cfg).unwrap();
        // Lazy-close it.
        let _ = handle_component(
            &state,
            &select_click(id, "555", "0", &["a"], select_template(id)),
        );
        assert!(matches!(
            state.store.get(id).unwrap().unwrap().status,
            Status::Closed
        ));

        let v = body_json(handle_component(
            &state,
            &panel_click(id, "reopen", "1", MANAGE_GUILD, &[]),
        ));
        assert_eq!(v["type"], 7); // host panel updated in place
        let p = state.store.get(id).unwrap().unwrap();
        assert!(matches!(p.status, Status::Open));
        assert_eq!(p.config.ends_at, None);

        // And voting genuinely works again.
        let _ = handle_component(
            &state,
            &select_click(id, "555", "0", &["a"], select_template(id)),
        );
        assert_eq!(state.store.tallies(id).unwrap().total, 1);
    }

    #[test]
    fn post_results_is_host_only_and_says_interim_while_open() {
        let state = test_state();
        let id = "abc";
        state
            .store
            .create(id, TEST_EDIT_TOKEN, &config_with("string_select", None))
            .unwrap();
        let _ = handle_component(
            &state,
            &select_click(id, "100", "0", &["b"], select_template(id)),
        );

        let denied = body_json(handle_component(
            &state,
            &panel_click(id, "results", "9", "0", &[]),
        ));
        assert!(denied.to_string().contains("server manager"), "{denied}");

        let posted = body_json(handle_component(
            &state,
            &panel_click(id, "results", "1", MANAGE_GUILD, &[]),
        ));
        assert_eq!(posted["type"], 4);
        let s = posted["data"]["content"].as_str().unwrap();
        assert!(s.contains("still open"), "{s}");
        assert!(s.contains("**Game night**"), "{s}");
    }

    #[test]
    fn a_tokened_vote_captures_a_refresher_the_close_can_reuse() {
        let state = test_state();
        let id = "abc";
        state
            .store
            .create(
                id,
                TEST_EDIT_TOKEN,
                &config_with("string_select", Some(select_template(id))),
            )
            .unwrap();

        // A vote carrying an interaction token captures how to edit the public
        // message later — the token whose `@original` is that message.
        let resp = body_json(handle_component(
            &state,
            &tokened_select_click(id, "100", &["a"], select_template(id)),
        ));
        assert_eq!(resp["type"], 7);
        let captured = {
            let cache = state.refreshers.lock().unwrap();
            let r = cache.entries.get(id).expect("refresher captured");
            assert_eq!(r.application_id, "999000");
            assert_eq!(r.token, "tok_abc");
            r.message.clone()
        };

        // That captured message shape renders exactly the closed state a close
        // would PATCH out of band: crowned winner, closed status, disabled.
        state.store.close(id).unwrap();
        let p = state.store.get(id).unwrap().unwrap();
        let tallies = state.store.tallies(id).unwrap();
        let data = live_message_data(&p, &captured, id, &tallies).expect("editable");
        let s = data.to_string();
        assert!(s.contains("[closed]"), "{s}");
        assert!(s.contains("\u{1F3C6}"), "{s}");
        assert!(s.contains("\"disabled\":true"), "{s}");
    }

    #[test]
    fn a_select_vote_without_a_template_restamps_the_placeholder_only() {
        let state = test_state();
        let id = "xyz";
        state
            .store
            .create(id, TEST_EDIT_TOKEN, &config_with("string_select", None))
            .unwrap();
        let v = body_json(handle_component(
            &state,
            &select_click(id, "555", "0", &["a"], select_template(id)),
        ));
        assert_eq!(v["type"], 7);
        let s = v.to_string();
        // The user's body text is preserved verbatim (no template to re-render);
        // the live count rides the select placeholder.
        assert!(s.contains("Cast your vote \u{B7} 1 vote"), "{s}");
        assert!(s.contains("{results}"), "{s}");
    }

    #[test]
    fn vote_gates_apply_to_members_but_not_hosts() {
        let state = test_state();
        let id = "abc";
        let mut cfg = config_with("string_select", None);
        cfg.requirements = Requirements {
            roles: vec![RoleRef {
                id: "555".into(),
                name: "Sub".into(),
                color: 0,
            }],
            require_all: false,
            min_account_age_days: 0,
        };
        state.store.create(id, TEST_EDIT_TOKEN, &cfg).unwrap();

        let denied = body_json(handle_component(
            &state,
            &select_click(id, "9", "0", &["a"], select_template(id)),
        ));
        assert!(denied.to_string().contains("<@&555>"), "{denied}");
        assert_eq!(state.store.tallies(id).unwrap().total, 0);

        // A host votes through their own gate.
        let _ = handle_component(
            &state,
            &select_click(id, "1", MANAGE_GUILD, &["a"], select_template(id)),
        );
        assert_eq!(state.store.tallies(id).unwrap().total, 1);
    }

    #[test]
    fn an_ephemeral_panel_click_is_never_mistaken_for_the_public_message() {
        let state = test_state();
        let id = "abc";
        state
            .store
            .create(
                id,
                TEST_EDIT_TOKEN,
                &config_with("string_select", Some(select_template(id))),
            )
            .unwrap();
        state.store.close(id).unwrap();
        let p = state.store.get(id).unwrap().unwrap();

        // A tokened interaction whose message is an EPHEMERAL panel (flags 64):
        // the closed-poll reply must fall back to the ephemeral results note —
        // never an UPDATE_MESSAGE that would rewrite the panel as if it were
        // the poll message — and must not poison the refresher cache (a later
        // close would PATCH the panel instead of the public message).
        let panel_interaction: discord::Interaction = serde_json::from_value(json!({
            "type": 3,
            "guild_id": "1",
            "application_id": "999000",
            "token": "tok_panel",
            "data": { "custom_id": format!("poll:{id}") },
            "member": { "user": { "id": "555" }, "roles": [], "permissions": "0" },
            "message": { "content": "panel", "components": select_template(id), "flags": 64 }
        }))
        .unwrap();
        let v = body_json(over_response(&state, &panel_interaction, &p, id));
        assert_eq!(v["type"], 4);
        assert!(v.to_string().contains("This poll has closed"), "{v}");
        assert!(state.refreshers.lock().unwrap().entries.is_empty());
    }

    #[test]
    fn manage_control_opens_the_host_panel_off_the_message() {
        let state = test_state();
        let id = "abc";
        state
            .store
            .create(id, TEST_EDIT_TOKEN, &config_with("button", None))
            .unwrap();
        state
            .store
            .cast_ballot(id, "100", &["a".to_string()], true)
            .unwrap();

        // The dispatcher's Message Info button carries no poll message at all
        // (it sits on the ephemeral info reply) — the panel must arrive as a
        // fresh ephemeral reply (type 4), never an UPDATE of the info reply.
        let resp = body_json(handle_component(
            &state,
            &panel_click(id, "manage", "1", MANAGE_GUILD, &[]),
        ));
        assert_eq!(resp["type"], 4);
        let s = resp.to_string();
        assert!(s.contains("Host controls"), "{s}");
        assert!(s.contains(&format!("poll:close:{id}")), "{s}");
    }

    #[test]
    fn manage_control_is_denied_for_a_plain_member() {
        let state = test_state();
        let id = "abc";
        state
            .store
            .create(id, TEST_EDIT_TOKEN, &config_with("button", None))
            .unwrap();

        let denied = body_json(handle_component(
            &state,
            &panel_click(id, "manage", "9", "0", &[]),
        ));
        assert!(
            denied.to_string().contains("Only a server manager"),
            "{denied}"
        );
    }
}
