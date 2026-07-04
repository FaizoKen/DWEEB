//! Discord interaction protocol: signature verification, the request shapes we
//! read, the **pure** decision/builder logic, and the callback JSON we send back.
//!
//! Everything that decides *what should happen* — who counts as staff, whether a
//! member may open another ticket, the channel name, the permission overwrites,
//! the welcome message and its controls, the transcript HTML — is a pure
//! function here, so it is exhaustively unit-tested. The only I/O lives in
//! `rest.rs`; `routes.rs` is the thin shell that glues the two.

use std::collections::BTreeSet;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::store::{InstanceConfig, IntakeField, StaffRole, Topic};

// Interaction request types.
pub const TYPE_PING: u8 = 1;
pub const TYPE_MESSAGE_COMPONENT: u8 = 3;
pub const TYPE_MODAL_SUBMIT: u8 = 5;

// Interaction callback (response) types.
const RESPONSE_PONG: u8 = 1;
const RESPONSE_CHANNEL_MESSAGE: u8 = 4;
const RESPONSE_DEFERRED_CHANNEL_MESSAGE: u8 = 5;
const RESPONSE_UPDATE_MESSAGE: u8 = 7;
const RESPONSE_MODAL: u8 = 9;

// Component / flag constants.
const COMPONENT_ACTION_ROW: u8 = 1;
const COMPONENT_BUTTON: u8 = 2;
const COMPONENT_TEXT_INPUT: u8 = 4;
const COMPONENT_TEXT_DISPLAY: u8 = 10;
const TEXT_INPUT_SHORT: u8 = 1;
const TEXT_INPUT_PARAGRAPH: u8 = 2;
const BUTTON_PRIMARY: u8 = 1;
const BUTTON_SECONDARY: u8 = 2;
const BUTTON_DANGER: u8 = 4;
const FLAG_EPHEMERAL: u64 = 1 << 6; // 64
const FLAG_IS_COMPONENTS_V2: u64 = 1 << 15; // 32768
/// Components V2 caps the total text across a message at this many characters.
const MAX_V2_TEXT: usize = 4000;
/// Plain message `content` ceiling.
const MAX_CONTENT: usize = 2000;

// Member permission bits that, on their own, make someone "staff" here.
const PERM_ADMINISTRATOR: u64 = 1 << 3;
const PERM_MANAGE_CHANNELS: u64 = 1 << 4;
const PERM_MANAGE_GUILD: u64 = 1 << 5;

// Channel permission-overwrite bits (the per-ticket access rule).
const VIEW_CHANNEL: u64 = 1 << 10;
const SEND_MESSAGES: u64 = 1 << 11;
const EMBED_LINKS: u64 = 1 << 14;
const ATTACH_FILES: u64 = 1 << 15;
const READ_MESSAGE_HISTORY: u64 = 1 << 16;
const ADD_REACTIONS: u64 = 1 << 6;
const MANAGE_CHANNELS: u64 = 1 << 4;

/// Overwrite target kinds.
const OVERWRITE_ROLE: u8 = 0;
const OVERWRITE_MEMBER: u8 = 1;

/// What a member who can read+write a ticket is granted. Public so the reopen
/// path can restore exactly this on the opener's overwrite.
pub const PARTICIPANT_ALLOW: u64 = VIEW_CHANNEL
    | SEND_MESSAGES
    | READ_MESSAGE_HISTORY
    | EMBED_LINKS
    | ATTACH_FILES
    | ADD_REACTIONS;
/// The bot also needs to manage the channel (rename / delete / edit overwrites).
const BOT_ALLOW: u64 = PARTICIPANT_ALLOW | MANAGE_CHANNELS;
/// On a *locked* ticket the opener keeps read access but loses the ability to
/// post — they can still see the resolution, they just can't reply.
pub const LOCKED_OPENER_ALLOW: u64 = VIEW_CHANNEL | READ_MESSAGE_HISTORY;
pub const LOCKED_OPENER_DENY: u64 = SEND_MESSAGES;

/// Verify Discord's `X-Signature-Ed25519` over `timestamp || body`. Any
/// malformed input fails closed (returns false). This MUST run on the raw body
/// bytes, before JSON parsing.
pub fn verify_signature(
    public_key_hex: &str,
    signature_hex: &str,
    timestamp: &str,
    body: &[u8],
) -> bool {
    let pk: [u8; 32] = match hex::decode(public_key_hex)
        .ok()
        .and_then(|b| b.try_into().ok())
    {
        Some(arr) => arr,
        None => return false,
    };
    let verifying_key = match VerifyingKey::from_bytes(&pk) {
        Ok(k) => k,
        Err(_) => return false,
    };
    let sig: [u8; 64] = match hex::decode(signature_hex)
        .ok()
        .and_then(|b| b.try_into().ok())
    {
        Some(arr) => arr,
        None => return false,
    };
    let signature = Signature::from_bytes(&sig);

    let mut message = Vec::with_capacity(timestamp.len() + body.len());
    message.extend_from_slice(timestamp.as_bytes());
    message.extend_from_slice(body);
    verifying_key.verify(&message, &signature).is_ok()
}

/// The dispatcher-attested verifying key, if this request carries one.
///
/// The dispatcher also serves guild-registered *custom* Discord apps, whose
/// interactions are signed with their own keys — it forwards the verifying key
/// in `x-dweeb-public-key`, vouched for by the shared DISPATCHER_FORWARD_SECRET
/// in `x-dweeb-forward-auth`. The signature is still verified HERE, on the raw
/// bytes Discord signed; the secret only authenticates *which key to use*.
/// Without a valid secret the header is ignored (None), so a caller reaching
/// this service directly can never substitute its own key.
pub fn attested_key<'h>(
    headers: &'h axum::http::HeaderMap,
    secret: Option<&str>,
) -> Option<&'h str> {
    let secret = secret?;
    let supplied = headers.get("x-dweeb-forward-auth")?.to_str().ok()?;
    if !constant_time_eq(supplied.as_bytes(), secret.as_bytes()) {
        return None;
    }
    headers.get("x-dweeb-public-key")?.to_str().ok()
}

/// Byte-wise comparison that doesn't leak the match length through timing.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// ── Incoming interaction (only the fields we use) ────────────────────────────

#[derive(Debug, Deserialize)]
pub struct Interaction {
    #[serde(rename = "type")]
    pub kind: u8,
    /// The app this interaction belongs to — its id and `token` are what we use
    /// to edit the deferred reply (`PATCH …/messages/@original`). For a custom
    /// app these name *that* app, which is correct: it owns this interaction.
    #[serde(default)]
    pub application_id: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub guild_id: Option<String>,
    /// The channel the interaction happened in — for in-ticket controls this is
    /// the ticket channel, which is how we look the ticket up.
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub data: Option<InteractionData>,
    #[serde(default)]
    pub member: Option<Member>,
    #[serde(default)]
    pub user: Option<User>,
    /// On a component click, the message the component sits on — we reuse its
    /// current `content` when editing it in place (e.g. on Claim).
    #[serde(default)]
    pub message: Option<MessageRef>,
}

#[derive(Debug, Deserialize)]
pub struct InteractionData {
    #[serde(default)]
    pub custom_id: Option<String>,
    /// The option values a string select submitted (we set these = topic ids).
    #[serde(default)]
    pub values: Option<Vec<String>>,
    /// Present on MODAL_SUBMIT: action rows holding the submitted text inputs.
    #[serde(default)]
    pub components: Option<Vec<ModalRow>>,
}

#[derive(Debug, Deserialize)]
pub struct ModalRow {
    #[serde(default)]
    pub components: Vec<ModalRowChild>,
}

#[derive(Debug, Deserialize)]
pub struct ModalRowChild {
    #[serde(default)]
    pub custom_id: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Member {
    #[serde(default)]
    pub user: Option<User>,
    /// Role ids the member currently has. Present on guild component clicks.
    #[serde(default)]
    pub roles: Vec<String>,
    /// The member's computed permissions in this channel, as a decimal string.
    #[serde(default)]
    pub permissions: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct User {
    pub id: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub global_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct MessageRef {
    #[serde(default)]
    pub content: Option<String>,
}

impl Interaction {
    /// The acting member's user id, however the payload carries it.
    pub fn actor_id(&self) -> Option<&str> {
        self.member
            .as_ref()
            .and_then(|m| m.user.as_ref())
            .or(self.user.as_ref())
            .map(|u| u.id.as_str())
    }

    /// The acting member's display name (global name → username → id).
    pub fn actor_name(&self) -> String {
        self.member
            .as_ref()
            .and_then(|m| m.user.as_ref())
            .or(self.user.as_ref())
            .map(display_name)
            .unwrap_or_else(|| "a member".to_string())
    }

    /// The acting member's role ids (empty outside a guild).
    pub fn actor_roles(&self) -> &[String] {
        self.member
            .as_ref()
            .map(|m| m.roles.as_slice())
            .unwrap_or(&[])
    }

    /// The acting member's computed permission bits (0 if absent/unparsable).
    pub fn actor_permissions(&self) -> u64 {
        self.member
            .as_ref()
            .and_then(|m| m.permissions.as_deref())
            .and_then(|p| p.parse().ok())
            .unwrap_or(0)
    }

    pub fn custom_id(&self) -> &str {
        self.data
            .as_ref()
            .and_then(|d| d.custom_id.as_deref())
            .unwrap_or_default()
    }

    /// The first selected value on a string select (we set these = topic ids).
    pub fn first_value(&self) -> Option<&str> {
        self.data
            .as_ref()
            .and_then(|d| d.values.as_ref())
            .and_then(|v| v.first())
            .map(String::as_str)
    }
}

fn display_name(user: &User) -> String {
    user.global_name
        .clone()
        .or_else(|| user.username.clone())
        .unwrap_or_else(|| user.id.clone())
}

/// Flatten the submitted intake fields into `(field_id, value)` pairs.
pub fn collect_modal_values(data: &InteractionData) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if let Some(rows) = &data.components {
        for row in rows {
            for child in &row.components {
                if let (Some(id), Some(value)) = (&child.custom_id, &child.value) {
                    out.push((id.clone(), value.clone()));
                }
            }
        }
    }
    out
}

// ── custom_id routing ─────────────────────────────────────────────────────────

/// The plugin prefix every minted `custom_id` carries (and the dispatcher
/// routes on).
pub const PREFIX: &str = "tickets:";

/// What a `custom_id` asks this plugin to do. Parsing is total — anything we
/// don't recognise is [`Action::Unknown`] and answered with a friendly notice.
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    /// Panel button / select → start the open flow (topic, if any, comes from
    /// the select's submitted value, not the id).
    Open {
        id: String,
    },
    /// Intake modal submitted → create the ticket with these answers. `topic` is
    /// carried here because a modal submit no longer sees the select's value.
    Intake {
        id: String,
        topic: String,
    },
    /// In-ticket: staff takes ownership.
    Claim {
        id: String,
    },
    /// In-ticket: begin closing (may open the reason modal first).
    Close {
        id: String,
    },
    /// Reason modal submitted (or a direct close) → actually close.
    DoClose {
        id: String,
    },
    /// On a locked ticket: bring it back.
    Reopen {
        id: String,
    },
    /// On a locked ticket: delete it for good.
    Delete {
        id: String,
    },
    Unknown,
}

/// Parse a `custom_id` into an [`Action`]. Total and allocation-light.
pub fn parse_action(custom_id: &str) -> Action {
    let Some(rest) = custom_id.strip_prefix(PREFIX) else {
        return Action::Unknown;
    };
    let mut parts = rest.splitn(3, ':');
    let verb = parts.next().unwrap_or_default();
    let id = parts.next().unwrap_or_default().to_string();
    let extra = parts.next().unwrap_or_default().to_string();
    if id.is_empty() {
        return Action::Unknown;
    }
    match verb {
        "open" => Action::Open { id },
        "intake" => Action::Intake { id, topic: extra },
        "claim" => Action::Claim { id },
        "close" => Action::Close { id },
        "doclose" => Action::DoClose { id },
        "reopen" => Action::Reopen { id },
        "delete" => Action::Delete { id },
        _ => Action::Unknown,
    }
}

/// Mint a control `custom_id`, e.g. `tickets:close:<id>`.
pub fn control_id(verb: &str, id: &str) -> String {
    format!("{PREFIX}{verb}:{id}")
}

// ── staff & anti-spam decisions (pure) ─────────────────────────────────────────

/// Whether the acting member counts as staff for this panel: holding any
/// configured staff role, or a server-management permission (Administrator,
/// Manage Server, or Manage Channels) which always implies it.
pub fn is_staff(member_roles: &[String], member_perms: u64, staff_roles: &[StaffRole]) -> bool {
    if member_perms & (PERM_ADMINISTRATOR | PERM_MANAGE_GUILD | PERM_MANAGE_CHANNELS) != 0 {
        return true;
    }
    let staff: BTreeSet<&str> = staff_roles.iter().map(|r| r.id.as_str()).collect();
    member_roles.iter().any(|r| staff.contains(r.as_str()))
}

/// The outcome of the open-rate check — a distinct, actionable reason when denied.
#[derive(Debug, PartialEq, Eq)]
pub enum OpenGate {
    Allowed,
    /// The member already holds `max` open tickets.
    AtLimit {
        max: u32,
    },
    /// The member opened one too recently; they must wait `wait_secs` more.
    Cooldown {
        wait_secs: u64,
    },
}

/// Decide whether a member may open another ticket — pure, no I/O.
///
/// The concurrent cap is checked first (it's the more actionable "close one
/// first"); the cooldown only rate-limits fresh opens.
pub fn open_gate(
    open_count: i64,
    max_open: u32,
    last_open_ms: Option<i64>,
    now_ms: i64,
    cooldown_secs: u32,
) -> OpenGate {
    if max_open > 0 && open_count >= max_open as i64 {
        return OpenGate::AtLimit { max: max_open };
    }
    if cooldown_secs > 0 {
        if let Some(last) = last_open_ms {
            let elapsed_ms = now_ms.saturating_sub(last);
            let window_ms = cooldown_secs as i64 * 1000;
            if elapsed_ms < window_ms {
                let wait = ((window_ms - elapsed_ms) as f64 / 1000.0).ceil() as u64;
                return OpenGate::Cooldown {
                    wait_secs: wait.max(1),
                };
            }
        }
    }
    OpenGate::Allowed
}

// ── naming & templating (pure) ──────────────────────────────────────────────────

/// Turn an arbitrary string into a Discord-safe channel-name fragment: lowercase
/// ASCII, non-alphanumerics folded to single dashes, trimmed. Empty input (or
/// input with nothing usable) yields "user" so a channel always has a name.
fn slug(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut last_dash = true; // leading dash suppressed
    for ch in input.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "user".to_string()
    } else {
        out
    }
}

/// The ticket channel's name. `number` naming gives a stable, sortable
/// `ticket-0001`; `username` naming gives `ticket-ada`. Clamped to Discord's
/// 100-char channel-name ceiling.
pub fn channel_name(naming: &str, number: i64, username: &str) -> String {
    let name = match naming {
        "username" => format!("ticket-{}", slug(username)),
        _ => format!("ticket-{number:04}"),
    };
    name.chars().take(100).collect()
}

/// Context for [`render_template`] — the values that fill a welcome message's
/// placeholders.
pub struct TemplateCtx<'a> {
    pub opener_id: &'a str,
    pub opener_name: &'a str,
    pub channel_id: &'a str,
    pub topic: &'a str,
    pub staff_mentions: &'a str,
}

/// Fill `{user} {username} {ticket} {topic} {staff}` in a welcome template.
/// Unknown placeholders are left as-is so a typo is visible rather than eaten.
pub fn render_template(template: &str, ctx: &TemplateCtx) -> String {
    template
        .replace("{user}", &format!("<@{}>", ctx.opener_id))
        .replace("{username}", ctx.opener_name)
        .replace("{ticket}", &format!("<#{}>", ctx.channel_id))
        .replace("{topic}", ctx.topic)
        .replace("{staff}", ctx.staff_mentions)
}

/// Render the staff mention string for `{staff}` (and, optionally, the ping):
/// the configured roles as mentions, or "the team" when none are set.
pub fn staff_mentions(staff_roles: &[StaffRole]) -> String {
    if staff_roles.is_empty() {
        return "the team".to_string();
    }
    staff_roles
        .iter()
        .map(|r| format!("<@&{}>", r.id))
        .collect::<Vec<_>>()
        .join(" ")
}

// ── channel permission overwrites (pure) ────────────────────────────────────────

/// Build the permission overwrites for a fresh ticket channel: hide it from
/// `@everyone`, and grant the opener, every staff role, and the bot read+write.
/// `@everyone` is the role whose id equals the guild id.
pub fn permission_overwrites(
    guild_id: &str,
    opener_id: &str,
    staff_roles: &[StaffRole],
    bot_id: &str,
) -> Vec<Value> {
    let mut out = Vec::with_capacity(staff_roles.len() + 3);
    out.push(json!({
        "id": guild_id,
        "type": OVERWRITE_ROLE,
        "deny": VIEW_CHANNEL.to_string(),
    }));
    out.push(json!({
        "id": opener_id,
        "type": OVERWRITE_MEMBER,
        "allow": PARTICIPANT_ALLOW.to_string(),
    }));
    for role in staff_roles {
        out.push(json!({
            "id": role.id,
            "type": OVERWRITE_ROLE,
            "allow": PARTICIPANT_ALLOW.to_string(),
        }));
    }
    out.push(json!({
        "id": bot_id,
        "type": OVERWRITE_MEMBER,
        "allow": BOT_ALLOW.to_string(),
    }));
    out
}

// ── component builders (pure) ───────────────────────────────────────────────────

/// The control row posted under a welcome message: a Close button, plus a Claim
/// button when claiming is enabled. A claimed ticket shows Claim disabled.
pub fn control_row(id: &str, claim_enabled: bool, claimed: bool) -> Value {
    let mut buttons = vec![json!({
        "type": COMPONENT_BUTTON,
        "style": BUTTON_DANGER,
        "label": "Close",
        "custom_id": control_id("close", id),
    })];
    if claim_enabled {
        buttons.push(json!({
            "type": COMPONENT_BUTTON,
            "style": BUTTON_PRIMARY,
            "label": if claimed { "Claimed" } else { "Claim" },
            "custom_id": control_id("claim", id),
            "disabled": claimed,
        }));
    }
    json!({ "type": COMPONENT_ACTION_ROW, "components": buttons })
}

/// The control row on a *locked* (closed-but-kept) ticket: Reopen + Delete.
pub fn locked_controls(id: &str) -> Value {
    json!({
        "type": COMPONENT_ACTION_ROW,
        "components": [
            { "type": COMPONENT_BUTTON, "style": BUTTON_SECONDARY, "label": "Reopen", "custom_id": control_id("reopen", id) },
            { "type": COMPONENT_BUTTON, "style": BUTTON_DANGER, "label": "Delete", "custom_id": control_id("delete", id) },
        ],
    })
}

/// The full welcome message posted in a new ticket: the rendered template, the
/// control row, and an `allowed_mentions` that pings only what the config opted
/// into (never `@everyone`, even if a template or topic name contains it).
pub fn welcome_message(cfg: &InstanceConfig, id: &str, ctx: &TemplateCtx) -> Value {
    let content = clamp(&render_template(&cfg.welcome, ctx), MAX_CONTENT);
    let users = if cfg.ping_opener {
        vec![ctx.opener_id.to_string()]
    } else {
        vec![]
    };
    let roles: Vec<String> = if cfg.ping_staff {
        cfg.staff_roles.iter().map(|r| r.id.clone()).collect()
    } else {
        vec![]
    };
    json!({
        "content": content,
        "components": [control_row(id, cfg.claim_enabled, false)],
        "allowed_mentions": { "parse": [], "users": users, "roles": roles },
    })
}

/// Append a "claimed by" line to the existing welcome content and disable the
/// Claim button — the body of an `UPDATE_MESSAGE` callback. We reuse the message's
/// current `content` (from the interaction) rather than re-rendering, so nothing
/// re-pings.
pub fn claimed_update(id: &str, existing_content: &str, claimer_id: &str) -> Value {
    let content = clamp(
        &format!("{existing_content}\n\n\u{1F64B} Claimed by <@{claimer_id}>"),
        MAX_CONTENT,
    );
    json!({
        "type": RESPONSE_UPDATE_MESSAGE,
        "data": {
            "content": content,
            "components": [control_row(id, true, true)],
            "allowed_mentions": { "parse": [] },
        }
    })
}

/// A second message posted in a new ticket summarising the intake answers, so
/// staff see the form responses inline. `@everyone` etc. in an answer never
/// pings (the suppressed `allowed_mentions`).
pub fn intake_summary_message(fields: &[IntakeField], answers: &[(String, String)]) -> Value {
    let mut body = String::from("\u{1F4CB} **Intake**");
    for (id, value) in answers {
        let label = fields
            .iter()
            .find(|f| &f.id == id)
            .map(|f| f.label.clone())
            .unwrap_or_else(|| id.clone());
        let shown = if value.trim().is_empty() {
            "\u{2014}".to_string()
        } else {
            clamp(value, 1024)
        };
        body.push_str(&format!("\n\n**{}**\n{}", clamp(&label, 256), shown));
    }
    json!({
        "content": clamp(&body, MAX_CONTENT),
        "allowed_mentions": { "parse": [] },
    })
}

/// The message posted in a ticket when it's locked (close_mode = "lock"): who
/// closed it, the optional reason, and Reopen/Delete controls.
pub fn locked_message(id: &str, closer_id: &str, reason: &str) -> Value {
    let mut body = format!("\u{1F512} Ticket closed by <@{closer_id}>.");
    let reason = reason.trim();
    if !reason.is_empty() {
        body.push_str(&format!("\n**Reason:** {}", clamp(reason, 1500)));
    }
    json!({
        "content": clamp(&body, MAX_CONTENT),
        "components": [locked_controls(id)],
        "allowed_mentions": { "parse": [] },
    })
}

/// The fresh control message posted when a locked ticket is reopened.
pub fn reopened_message(id: &str, claim_enabled: bool, reopener_id: &str) -> Value {
    json!({
        "content": format!("\u{1F513} Reopened by <@{reopener_id}>."),
        "components": [control_row(id, claim_enabled, false)],
        "allowed_mentions": { "parse": [] },
    })
}

// ── modals (pure) ────────────────────────────────────────────────────────────

/// Build the intake MODAL callback. `submit_id` is routed back here on submit
/// (it carries the panel id and, for a topic select, the chosen topic).
pub fn intake_modal(submit_id: &str, title: &str, fields: &[IntakeField]) -> Value {
    let rows: Vec<Value> = fields
        .iter()
        .take(5)
        .map(|f| {
            let style = if f.style == "paragraph" {
                TEXT_INPUT_PARAGRAPH
            } else {
                TEXT_INPUT_SHORT
            };
            let mut input = json!({
                "type": COMPONENT_TEXT_INPUT,
                "custom_id": clamp(&f.id, 100),
                "label": clamp(&f.label, 45),
                "style": style,
                "required": f.required,
            });
            if let Some(p) = &f.placeholder {
                input["placeholder"] = json!(clamp(p, 100));
            }
            json!({ "type": COMPONENT_ACTION_ROW, "components": [input] })
        })
        .collect();
    json!({
        "type": RESPONSE_MODAL,
        "data": { "custom_id": submit_id, "title": clamp(title, 45), "components": rows }
    })
}

/// The close-reason MODAL: a single optional paragraph. `submit_id` is the
/// `tickets:doclose:<id>` that actually performs the close on submit.
pub fn close_reason_modal(submit_id: &str) -> Value {
    json!({
        "type": RESPONSE_MODAL,
        "data": {
            "custom_id": submit_id,
            "title": "Close ticket",
            "components": [{
                "type": COMPONENT_ACTION_ROW,
                "components": [{
                    "type": COMPONENT_TEXT_INPUT,
                    "custom_id": "reason",
                    "label": "Reason (optional)",
                    "style": TEXT_INPUT_PARAGRAPH,
                    "required": false,
                    "max_length": 500,
                    "placeholder": "Add a note for the transcript / log.",
                }],
            }],
        }
    })
}

/// Pull the `reason` field out of a submitted close modal (empty if absent).
pub fn reason_from_modal(data: &InteractionData) -> String {
    collect_modal_values(data)
        .into_iter()
        .find(|(id, _)| id == "reason")
        .map(|(_, v)| v)
        .unwrap_or_default()
}

// ── outgoing callbacks (pure) ───────────────────────────────────────────────────

pub fn pong() -> Value {
    json!({ "type": RESPONSE_PONG })
}

/// An ephemeral text reply, Components V2 (text rides in a Text Display).
pub fn ephemeral_text(content: &str) -> Value {
    json!({
        "type": RESPONSE_CHANNEL_MESSAGE,
        "data": {
            "flags": FLAG_IS_COMPONENTS_V2 | FLAG_EPHEMERAL,
            "components": [{ "type": COMPONENT_TEXT_DISPLAY, "content": clamp(content, MAX_V2_TEXT) }],
        }
    })
}

/// A deferred ephemeral ack ("…thinking"), edited later via `PATCH @original`.
/// Used by the open/create flow so the channel work happens off the 3s path.
pub fn deferred_ephemeral() -> Value {
    json!({ "type": RESPONSE_DEFERRED_CHANNEL_MESSAGE, "data": { "flags": FLAG_EPHEMERAL } })
}

/// The plain-content body used to edit a deferred reply (`PATCH @original`).
pub fn followup_content(content: &str) -> Value {
    json!({ "content": clamp(content, MAX_CONTENT) })
}

/// The ephemeral acknowledgement shown to the opener once the ticket exists.
pub fn open_success_text(cfg: &InstanceConfig, channel_id: &str, ctx: &TemplateCtx) -> String {
    match (cfg.response.mode.as_str(), cfg.response.text.as_deref()) {
        ("custom", Some(t)) if !t.trim().is_empty() => {
            clamp(&render_template(t.trim(), ctx), MAX_CONTENT)
        }
        _ => format!("\u{1F3AB} Opened your ticket: <#{channel_id}>"),
    }
}

/// Map the topic value a select submitted to its configured label (empty for a
/// button panel or an unknown value — never trust the client's label).
pub fn topic_label(topics: &[Topic], value: Option<&str>) -> String {
    match value {
        Some(v) => topics
            .iter()
            .find(|t| t.id == v)
            .map(|t| t.label.clone())
            .unwrap_or_default(),
        None => String::new(),
    }
}

// ── transcript (pure) ────────────────────────────────────────────────────────

/// One message as the transcript needs it.
pub struct TranscriptLine {
    pub author: String,
    pub timestamp: String,
    pub content: String,
}

/// Render a minimal, self-contained HTML transcript. Every Discord-supplied
/// string is HTML-escaped — a message body is arbitrary user input and must
/// never break out into markup.
pub fn transcript_html(title: &str, lines: &[TranscriptLine]) -> String {
    let mut html = String::with_capacity(2048 + lines.len() * 128);
    html.push_str(
        "<!doctype html><html><head><meta charset=\"utf-8\"><style>\
body{background:#1e1f22;color:#dbdee1;font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px}\
h1{font-size:18px;color:#fff;margin:0 0 16px}\
.m{padding:8px 0;border-top:1px solid #2b2d31}\
.a{font-weight:600;color:#fff}.t{color:#949ba4;font-size:12px;margin-left:8px}\
.c{white-space:pre-wrap;margin-top:2px}</style><title>",
    );
    html.push_str(&escape_html(title));
    html.push_str("</title></head><body><h1>");
    html.push_str(&escape_html(title));
    html.push_str("</h1>");
    if lines.is_empty() {
        html.push_str("<p class=\"t\">No messages.</p>");
    }
    for line in lines {
        html.push_str("<div class=\"m\"><span class=\"a\">");
        html.push_str(&escape_html(&line.author));
        html.push_str("</span><span class=\"t\">");
        html.push_str(&escape_html(&line.timestamp));
        html.push_str("</span><div class=\"c\">");
        html.push_str(&escape_html(&line.content));
        html.push_str("</div></div>");
    }
    html.push_str("</body></html>");
    html
}

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

/// Truncate to at most `max` characters (respecting char boundaries).
fn clamp(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::ResponseDef;

    fn staff(ids: &[&str]) -> Vec<StaffRole> {
        ids.iter()
            .map(|id| StaffRole {
                id: id.to_string(),
                name: format!("Role {id}"),
                color: 0,
            })
            .collect()
    }

    // ── custom_id routing ──────────────────────────────────────────────────
    #[test]
    fn parse_action_round_trips_the_control_ids() {
        assert_eq!(
            parse_action("tickets:open:abc"),
            Action::Open { id: "abc".into() }
        );
        assert_eq!(
            parse_action("tickets:claim:abc"),
            Action::Claim { id: "abc".into() }
        );
        assert_eq!(
            parse_action("tickets:close:abc"),
            Action::Close { id: "abc".into() }
        );
        assert_eq!(
            parse_action("tickets:doclose:abc"),
            Action::DoClose { id: "abc".into() }
        );
        assert_eq!(
            parse_action("tickets:reopen:abc"),
            Action::Reopen { id: "abc".into() }
        );
        assert_eq!(
            parse_action("tickets:delete:abc"),
            Action::Delete { id: "abc".into() }
        );
    }

    #[test]
    fn parse_action_carries_the_intake_topic() {
        assert_eq!(
            parse_action("tickets:intake:abc:billing"),
            Action::Intake {
                id: "abc".into(),
                topic: "billing".into()
            }
        );
        // No topic segment ⇒ empty topic, still valid.
        assert_eq!(
            parse_action("tickets:intake:abc"),
            Action::Intake {
                id: "abc".into(),
                topic: String::new()
            }
        );
    }

    #[test]
    fn parse_action_rejects_foreign_or_empty() {
        assert_eq!(parse_action("other:open:abc"), Action::Unknown);
        assert_eq!(parse_action("tickets:open:"), Action::Unknown); // missing id
        assert_eq!(parse_action("tickets:bogus:abc"), Action::Unknown);
        assert_eq!(parse_action(""), Action::Unknown);
    }

    // ── staff check ────────────────────────────────────────────────────────
    #[test]
    fn staff_by_role_or_management_permission() {
        let roles = staff(&["100", "200"]);
        assert!(is_staff(&["100".into()], 0, &roles)); // has a staff role
        assert!(!is_staff(&["999".into()], 0, &roles)); // unrelated role, no perms
        assert!(is_staff(&[], PERM_ADMINISTRATOR, &roles)); // admin always staff
        assert!(is_staff(&[], PERM_MANAGE_CHANNELS, &roles));
        assert!(!is_staff(&[], 0, &roles)); // a plain member is not staff
    }

    // ── open gate ──────────────────────────────────────────────────────────
    #[test]
    fn open_gate_blocks_at_the_concurrent_limit() {
        assert_eq!(open_gate(1, 1, None, 0, 0), OpenGate::AtLimit { max: 1 });
        assert_eq!(open_gate(0, 1, None, 0, 0), OpenGate::Allowed);
        // 0 = unlimited.
        assert_eq!(open_gate(99, 0, None, 0, 0), OpenGate::Allowed);
    }

    #[test]
    fn open_gate_enforces_cooldown_then_clears() {
        // Opened 10s ago, 30s cooldown → must wait ~20s more.
        let now = 1_000_000;
        let g = open_gate(0, 0, Some(now - 10_000), now, 30);
        assert_eq!(g, OpenGate::Cooldown { wait_secs: 20 });
        // Past the window → allowed.
        assert_eq!(
            open_gate(0, 0, Some(now - 31_000), now, 30),
            OpenGate::Allowed
        );
        // Limit takes precedence over cooldown.
        assert_eq!(
            open_gate(2, 2, Some(now), now, 30),
            OpenGate::AtLimit { max: 2 }
        );
    }

    // ── channel naming ─────────────────────────────────────────────────────
    #[test]
    fn channel_name_number_is_zero_padded_and_sortable() {
        assert_eq!(channel_name("number", 1, "ada"), "ticket-0001");
        assert_eq!(channel_name("number", 42, "ada"), "ticket-0042");
    }

    #[test]
    fn channel_name_username_is_slugged() {
        assert_eq!(
            channel_name("username", 1, "Ada Lovelace"),
            "ticket-ada-lovelace"
        );
        assert_eq!(channel_name("username", 1, "✨ emoji ✨"), "ticket-emoji");
        // Nothing usable falls back to a stable name, never empty.
        assert_eq!(channel_name("username", 1, "✨✨"), "ticket-user");
    }

    // ── templating ─────────────────────────────────────────────────────────
    #[test]
    fn render_template_fills_known_placeholders() {
        let ctx = TemplateCtx {
            opener_id: "42",
            opener_name: "Ada",
            channel_id: "777",
            topic: "Billing",
            staff_mentions: "<@&100>",
        };
        let out = render_template(
            "Hi {user} ({username}) re {topic} in {ticket} — {staff}",
            &ctx,
        );
        assert_eq!(out, "Hi <@42> (Ada) re Billing in <#777> — <@&100>");
    }

    #[test]
    fn staff_mentions_falls_back_to_the_team() {
        assert_eq!(staff_mentions(&[]), "the team");
        assert_eq!(staff_mentions(&staff(&["1", "2"])), "<@&1> <@&2>");
    }

    // ── overwrites ─────────────────────────────────────────────────────────
    #[test]
    fn overwrites_hide_from_everyone_and_grant_opener_staff_bot() {
        let ow = permission_overwrites("guild1", "opener1", &staff(&["role1"]), "bot1");
        // @everyone (id == guild id) is denied view.
        assert_eq!(ow[0]["id"], "guild1");
        assert_eq!(ow[0]["deny"], VIEW_CHANNEL.to_string());
        // opener is a member overwrite that can view+send.
        assert_eq!(ow[1]["id"], "opener1");
        assert_eq!(ow[1]["type"], OVERWRITE_MEMBER);
        let allow: u64 = ow[1]["allow"].as_str().unwrap().parse().unwrap();
        assert!(allow & VIEW_CHANNEL != 0 && allow & SEND_MESSAGES != 0);
        // staff role overwrite present.
        assert_eq!(ow[2]["id"], "role1");
        assert_eq!(ow[2]["type"], OVERWRITE_ROLE);
        // bot can also manage the channel.
        let bot = ow.last().unwrap();
        assert_eq!(bot["id"], "bot1");
        let bot_allow: u64 = bot["allow"].as_str().unwrap().parse().unwrap();
        assert!(bot_allow & MANAGE_CHANNELS != 0);
    }

    // ── welcome message & controls ──────────────────────────────────────────
    fn base_cfg() -> InstanceConfig {
        InstanceConfig {
            target: "button".into(),
            guild_id: "g".into(),
            guild_name: String::new(),
            staff_roles: staff(&["100"]),
            category_id: None,
            category_name: String::new(),
            log_channel_id: None,
            log_channel_name: String::new(),
            naming: "number".into(),
            welcome: "Hi {user}, {staff} will help.".into(),
            ping_opener: true,
            ping_staff: false,
            intake: vec![],
            topics: vec![],
            close_mode: "delete".into(),
            close_confirmation: true,
            allow_opener_close: true,
            claim_enabled: true,
            transcripts: true,
            max_open_per_user: 1,
            cooldown_secs: 30,
            response: ResponseDef::default(),
        }
    }

    #[test]
    fn welcome_pings_only_what_is_opted_in() {
        let cfg = base_cfg();
        let ctx = TemplateCtx {
            opener_id: "42",
            opener_name: "Ada",
            channel_id: "777",
            topic: "",
            staff_mentions: "<@&100>",
        };
        let msg = welcome_message(&cfg, "abc", &ctx);
        assert!(msg["content"].as_str().unwrap().contains("<@42>"));
        // Opener pinged, staff not (ping_staff = false), @everyone never.
        assert_eq!(msg["allowed_mentions"]["users"][0], "42");
        assert_eq!(
            msg["allowed_mentions"]["roles"].as_array().unwrap().len(),
            0
        );
        assert_eq!(
            msg["allowed_mentions"]["parse"].as_array().unwrap().len(),
            0
        );
        // The control row has Close + Claim (not yet claimed).
        let buttons = &msg["components"][0]["components"];
        assert_eq!(buttons[0]["custom_id"], "tickets:close:abc");
        assert_eq!(buttons[1]["custom_id"], "tickets:claim:abc");
        assert_eq!(buttons[1]["disabled"], false);
    }

    #[test]
    fn welcome_can_ping_staff_roles_when_enabled() {
        let mut cfg = base_cfg();
        cfg.ping_staff = true;
        let ctx = TemplateCtx {
            opener_id: "42",
            opener_name: "Ada",
            channel_id: "777",
            topic: "",
            staff_mentions: "<@&100>",
        };
        let msg = welcome_message(&cfg, "abc", &ctx);
        assert_eq!(msg["allowed_mentions"]["roles"][0], "100");
    }

    #[test]
    fn control_row_without_claim_has_only_close() {
        let row = control_row("abc", false, false);
        let buttons = row["components"].as_array().unwrap();
        assert_eq!(buttons.len(), 1);
        assert_eq!(buttons[0]["custom_id"], "tickets:close:abc");
    }

    #[test]
    fn claimed_update_disables_claim_and_appends_line() {
        let v = claimed_update("abc", "Welcome!", "staff9");
        assert!(v["data"]["content"]
            .as_str()
            .unwrap()
            .contains("Claimed by <@staff9>"));
        let claim = &v["data"]["components"][0]["components"][1];
        assert_eq!(claim["disabled"], true);
        // Never re-pings.
        assert_eq!(
            v["data"]["allowed_mentions"]["parse"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    // ── modals ─────────────────────────────────────────────────────────────
    #[test]
    fn intake_modal_carries_fields_and_submit_id() {
        let fields = vec![
            IntakeField {
                id: "f1".into(),
                label: "Subject".into(),
                style: "short".into(),
                required: true,
                placeholder: Some("e.g. refund".into()),
            },
            IntakeField {
                id: "f2".into(),
                label: "Details".into(),
                style: "paragraph".into(),
                required: false,
                placeholder: None,
            },
        ];
        let v = intake_modal("tickets:intake:abc:billing", "Open a ticket", &fields);
        assert_eq!(v["data"]["custom_id"], "tickets:intake:abc:billing");
        assert_eq!(
            v["data"]["components"][0]["components"][0]["custom_id"],
            "f1"
        );
        assert_eq!(
            v["data"]["components"][0]["components"][0]["required"],
            true
        );
        assert_eq!(
            v["data"]["components"][1]["components"][0]["style"],
            TEXT_INPUT_PARAGRAPH
        );
    }

    #[test]
    fn reason_is_pulled_from_a_close_modal() {
        let data = InteractionData {
            custom_id: Some("tickets:doclose:abc".into()),
            values: None,
            components: Some(vec![ModalRow {
                components: vec![ModalRowChild {
                    custom_id: Some("reason".into()),
                    value: Some("spam".into()),
                }],
            }]),
        };
        assert_eq!(reason_from_modal(&data), "spam");
    }

    #[test]
    fn intake_summary_labels_answers_and_dashes_blanks() {
        let fields = vec![
            IntakeField {
                id: "f1".into(),
                label: "Subject".into(),
                style: "short".into(),
                required: true,
                placeholder: None,
            },
            IntakeField {
                id: "f2".into(),
                label: "Details".into(),
                style: "paragraph".into(),
                required: false,
                placeholder: None,
            },
        ];
        let answers = vec![("f1".into(), "Refund".into()), ("f2".into(), "  ".into())];
        let msg = intake_summary_message(&fields, &answers);
        let content = msg["content"].as_str().unwrap();
        assert!(content.contains("**Subject**") && content.contains("Refund"));
        assert!(content.contains("**Details**") && content.contains('\u{2014}')); // blank → em dash
        assert_eq!(
            msg["allowed_mentions"]["parse"].as_array().unwrap().len(),
            0
        );
    }

    // ── replies ────────────────────────────────────────────────────────────
    #[test]
    fn open_success_summary_links_the_channel() {
        let cfg = base_cfg();
        let ctx = TemplateCtx {
            opener_id: "42",
            opener_name: "Ada",
            channel_id: "777",
            topic: "",
            staff_mentions: "",
        };
        assert!(open_success_text(&cfg, "777", &ctx).contains("<#777>"));
    }

    #[test]
    fn open_success_custom_renders_template() {
        let mut cfg = base_cfg();
        cfg.response = ResponseDef {
            mode: "custom".into(),
            text: Some("See {ticket} 🎉".into()),
        };
        let ctx = TemplateCtx {
            opener_id: "42",
            opener_name: "Ada",
            channel_id: "777",
            topic: "",
            staff_mentions: "",
        };
        assert_eq!(open_success_text(&cfg, "777", &ctx), "See <#777> 🎉");
    }

    #[test]
    fn topic_label_only_trusts_configured_values() {
        let topics = vec![Topic {
            id: "t1".into(),
            label: "Billing".into(),
            emoji: None,
            description: None,
        }];
        assert_eq!(topic_label(&topics, Some("t1")), "Billing");
        assert_eq!(topic_label(&topics, Some("evil")), ""); // unknown value → no label
        assert_eq!(topic_label(&topics, None), "");
    }

    // ── transcript ─────────────────────────────────────────────────────────
    #[test]
    fn transcript_escapes_message_content() {
        let lines = vec![TranscriptLine {
            author: "Ada".into(),
            timestamp: "2026-06-15".into(),
            content: "<script>alert('x')</script> & <b>".into(),
        }];
        let html = transcript_html("ticket-0001", &lines);
        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("&amp;"));
        assert!(!html.contains("<script>alert"));
    }
}
