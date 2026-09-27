//! Discord interaction protocol: signature verification, the request shapes we
//! read, the **pure** decision/builder logic, and the callback JSON we send back.
//!
//! Everything that decides *what should happen* — who counts as staff, whether a
//! member may open another ticket, the channel name, the permission overwrites,
//! every message a ticket posts and every reply a click gets — is a pure
//! function here, so it is exhaustively unit-tested. The only I/O lives in
//! `rest.rs`; `routes.rs` is the thin shell that glues the two.

use std::collections::BTreeSet;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::perms::{self, Grants, OVERWRITE_MEMBER, OVERWRITE_ROLE};
use crate::store::{InstanceConfig, IntakeField, OpenStats, Ticket, Topic};

// Interaction request types.
pub const TYPE_PING: u8 = 1;
pub const TYPE_MESSAGE_COMPONENT: u8 = 3;
pub const TYPE_MODAL_SUBMIT: u8 = 5;

// Interaction callback (response) types.
const RESPONSE_PONG: u8 = 1;
const RESPONSE_CHANNEL_MESSAGE: u8 = 4;
const RESPONSE_DEFERRED_CHANNEL_MESSAGE: u8 = 5;
const RESPONSE_DEFERRED_UPDATE_MESSAGE: u8 = 6;
const RESPONSE_UPDATE_MESSAGE: u8 = 7;
const RESPONSE_MODAL: u8 = 9;

// Component / flag constants.
const COMPONENT_ACTION_ROW: u8 = 1;
const COMPONENT_BUTTON: u8 = 2;
const COMPONENT_TEXT_INPUT: u8 = 4;
const COMPONENT_USER_SELECT: u8 = 5;
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
pub const MAX_CONTENT: usize = 2000;

/// Longest answer an intake question accepts. Discord's modal enforces it as
/// the member types, so nothing is ever cut off afterwards.
pub const INTAKE_SHORT_MAX: u32 = 512;
pub const INTAKE_PARAGRAPH_MAX: u32 = 1024;
/// People one Members pick can add or remove at a time.
const MEMBERS_PER_PICK: u8 = 10;
/// How long a delete-mode close gives everyone in the channel to read why.
pub const DELETE_GRACE_SECS: i64 = 5;

// ── signature verification ───────────────────────────────────────────────────

/// Verify Discord's `X-Signature-Ed25519` over `timestamp || body`. Any
/// malformed input fails closed (returns false). This MUST run on the raw body
/// bytes, before JSON parsing.
pub fn verify_signature(
    public_key_hex: &str,
    signature_hex: &str,
    timestamp: &str,
    body: &[u8],
) -> bool {
    let Some(verifying_key) = parse_verifying_key(public_key_hex) else {
        return false;
    };
    verify_signature_with_key(&verifying_key, signature_hex, timestamp, body)
}

pub fn parse_verifying_key(public_key_hex: &str) -> Option<VerifyingKey> {
    let pk: [u8; 32] = hex::decode(public_key_hex).ok()?.try_into().ok()?;
    VerifyingKey::from_bytes(&pk).ok()
}

pub fn verify_signature_with_key(
    verifying_key: &VerifyingKey,
    signature_hex: &str,
    timestamp: &str,
    body: &[u8],
) -> bool {
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
    /// On a component click (or a modal opened from one), the message the
    /// component sits on — we reuse its `content` when editing it in place,
    /// and its `id` to retire its buttons once they are stale.
    #[serde(default)]
    pub message: Option<MessageRef>,
}

#[derive(Debug, Deserialize)]
pub struct InteractionData {
    #[serde(default)]
    pub custom_id: Option<String>,
    /// A select's picked values: topic ids on the panel menu, user ids on the
    /// Members picker.
    #[serde(default)]
    pub values: Option<Vec<String>>,
    /// Present on MODAL_SUBMIT: action rows holding the submitted text inputs.
    #[serde(default)]
    pub components: Option<Vec<ModalRow>>,
    /// On a user select: the users Discord resolved the picked ids to.
    #[serde(default)]
    pub resolved: Option<Resolved>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Resolved {
    #[serde(default)]
    pub users: std::collections::HashMap<String, Value>,
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
    pub id: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
}

impl Interaction {
    fn actor(&self) -> Option<&User> {
        self.member
            .as_ref()
            .and_then(|m| m.user.as_ref())
            .or(self.user.as_ref())
    }

    /// The acting member's user id, however the payload carries it.
    pub fn actor_id(&self) -> Option<&str> {
        self.actor().map(|u| u.id.as_str())
    }

    /// The acting member's display name (global name → username → id).
    pub fn actor_name(&self) -> String {
        self.actor()
            .map(display_name)
            .unwrap_or_else(|| "a member".to_string())
    }

    /// The acting member's unique handle (username → display name) — what a
    /// `ticket-<name>` channel is named after, since display names repeat.
    pub fn actor_handle(&self) -> String {
        self.actor()
            .and_then(|u| u.username.clone())
            .unwrap_or_else(|| self.actor_name())
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
            .map(perms::parse_bits)
            .unwrap_or(0)
    }

    pub fn custom_id(&self) -> &str {
        self.data
            .as_ref()
            .and_then(|d| d.custom_id.as_deref())
            .unwrap_or_default()
    }

    /// Every value a select submitted.
    pub fn values(&self) -> &[String] {
        self.data
            .as_ref()
            .and_then(|d| d.values.as_deref())
            .unwrap_or(&[])
    }

    /// The users a user select picked — only ids Discord itself resolved as
    /// users. The raw `values` are what the clicking client sent; `resolved`
    /// is Discord's own reading of them, so a value that names a role, or the
    /// guild's `@everyone`, never gets through.
    pub fn picked_users(&self) -> Vec<String> {
        let Some(users) = self
            .data
            .as_ref()
            .and_then(|d| d.resolved.as_ref())
            .map(|r| &r.users)
        else {
            return Vec::new();
        };
        self.values()
            .iter()
            .filter(|v| users.contains_key(v.as_str()))
            .cloned()
            .collect()
    }

    /// The first selected value on a string select (we set these = topic ids).
    pub fn first_value(&self) -> Option<&str> {
        self.values().first().map(String::as_str)
    }

    /// The id of the message the clicked component sits on.
    pub fn message_id(&self) -> Option<&str> {
        self.message.as_ref().and_then(|m| m.id.as_deref())
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
    /// In-ticket: the claimer (or a manager) lets go.
    Unclaim {
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
    /// In-ticket: staff opens the add/remove-people picker.
    Members {
        id: String,
    },
    /// The picker's "add" select.
    AddMembers {
        id: String,
    },
    /// The picker's "remove" select.
    RemoveMembers {
        id: String,
    },
    /// Staff overview of a panel's tickets (from the dispatcher's Message Info).
    Manage {
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
        "unclaim" => Action::Unclaim { id },
        "close" => Action::Close { id },
        "doclose" => Action::DoClose { id },
        "reopen" => Action::Reopen { id },
        "delete" => Action::Delete { id },
        "members" => Action::Members { id },
        "addmember" => Action::AddMembers { id },
        "rmmember" => Action::RemoveMembers { id },
        "manage" => Action::Manage { id },
        _ => Action::Unknown,
    }
}

/// Mint a control `custom_id`, e.g. `tickets:close:<id>`.
pub fn control_id(verb: &str, id: &str) -> String {
    format!("{PREFIX}{verb}:{id}")
}

// ── staff & anti-spam decisions (pure) ─────────────────────────────────────────

/// A server-management permission — Administrator, Manage Server or Manage
/// Channels. Holders always count as staff, and may override a claim.
pub fn is_manager(member_perms: u64) -> bool {
    member_perms & (perms::ADMINISTRATOR | perms::MANAGE_GUILD | perms::MANAGE_CHANNELS) != 0
}

/// Whether the acting member counts as staff: a manager, or holding any of
/// `staff_ids` (the panel's staff plus, inside a ticket, its topic's).
pub fn is_staff(member_roles: &[String], member_perms: u64, staff_ids: &[String]) -> bool {
    if is_manager(member_perms) {
        return true;
    }
    let staff: BTreeSet<&str> = staff_ids.iter().map(String::as_str).collect();
    member_roles.iter().any(|r| staff.contains(r.as_str()))
}

/// The staff role ids for a ticket: the panel's, plus its topic's (if the
/// topic still exists), without duplicates, panel roles first.
pub fn staff_ids(cfg: &InstanceConfig, topic_id: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let topic_roles = cfg
        .topic(topic_id)
        .map(|t| t.staff_roles.as_slice())
        .unwrap_or(&[]);
    for role in cfg.staff_roles.iter().chain(topic_roles) {
        if !out.contains(&role.id) {
            out.push(role.id.clone());
        }
    }
    out
}

/// The outcome of the open-rate check — a distinct, actionable reason when denied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenGate {
    Allowed,
    /// One of the member's opens is being created right now (a double-click).
    InFlight,
    /// The member already holds `max` open tickets.
    AtLimit {
        max: u32,
    },
    /// The member opened one too recently; they may try again at `until_ms`.
    Cooldown {
        until_ms: i64,
    },
}

/// Decide whether a member may open another ticket — pure, no I/O.
///
/// An open already in flight is refused regardless of the limits (a
/// double-click is never two tickets). The concurrent cap comes next — it's
/// the more actionable "close one first"; the cooldown only rate-limits fresh
/// opens.
pub fn open_gate(stats: &OpenStats, max_open: u32, now_ms: i64, cooldown_secs: u32) -> OpenGate {
    if stats.pending > 0 {
        return OpenGate::InFlight;
    }
    if max_open > 0 && stats.open >= max_open as i64 {
        return OpenGate::AtLimit { max: max_open };
    }
    if cooldown_secs > 0 {
        if let Some(last) = stats.last_open_ms {
            let until = last.saturating_add(cooldown_secs as i64 * 1000);
            if now_ms < until {
                return OpenGate::Cooldown { until_ms: until };
            }
        }
    }
    OpenGate::Allowed
}

/// The reply for a refused open. `open` lists the member's open tickets, so an
/// at-limit member is pointed straight at the one they already have.
pub fn gate_text(gate: OpenGate, open: &[Ticket]) -> String {
    match gate {
        OpenGate::Allowed => String::new(),
        OpenGate::InFlight => {
            "Your ticket is already being created — it'll appear in a moment.".to_string()
        }
        OpenGate::AtLimit { max } => match open {
            [] => format!(
                "You already have the most open tickets allowed here ({max}). Close one before opening another."
            ),
            [one] => format!(
                "You already have an open ticket: <#{}>. Close it before opening another.",
                one.channel_id
            ),
            many => format!(
                "You already have {} open tickets here (the limit is {max}): {}. Close one before opening another.",
                many.len(),
                many.iter()
                    .map(|t| format!("<#{}>", t.channel_id))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        },
        OpenGate::Cooldown { until_ms } => format!(
            "You're opening tickets a little fast — try again <t:{}:R>.",
            // Round up: "in 0 seconds" would invite a click that still fails.
            (until_ms + 999) / 1000
        ),
    }
}

// ── naming & templating (pure) ──────────────────────────────────────────────────

/// Turn a name into a channel-name fragment: lowercase letters and digits (any
/// script — Discord accepts them), underscores kept, everything else folded to
/// single dashes and trimmed. Empty when nothing usable is left.
fn slug(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut last_dash = true; // leading dash suppressed
    for ch in input.chars() {
        if ch.is_alphanumeric() || ch == '_' {
            out.extend(ch.to_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// The ticket channel's name. `number` naming gives a stable, sortable
/// `ticket-0001`; `username` naming gives `ticket-ada` from the opener's handle,
/// falling back to the number when the name has nothing usable. Clamped to
/// Discord's 100-char channel-name ceiling.
pub fn channel_name(naming: &str, number: i64, handle: &str) -> String {
    let name = match (naming, slug(handle)) {
        ("username", s) if !s.is_empty() => format!("ticket-{s}"),
        _ => format!("ticket-{number:04}"),
    };
    clamp(&name, 100)
}

/// The name a locked ticket wears: `ticket-0042` → `closed-0042`,
/// `ticket-ada` → `closed-ada`.
pub fn closed_name(channel_name: &str, number: i64) -> String {
    let base = reopen_name(channel_name, number);
    let suffix = base.strip_prefix("ticket-").unwrap_or(&base);
    clamp(&format!("closed-{suffix}"), 100)
}

/// The name a reopened ticket goes back to — the one it was created with
/// (tickets from before names were recorded fall back to the number).
pub fn reopen_name(channel_name: &str, number: i64) -> String {
    if channel_name.is_empty() {
        format!("ticket-{number:04}")
    } else {
        channel_name.to_string()
    }
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
/// the roles as mentions, or "the team" when none are set.
pub fn staff_mentions(staff_ids: &[String]) -> String {
    if staff_ids.is_empty() {
        return "the team".to_string();
    }
    staff_ids
        .iter()
        .map(|id| format!("<@&{id}>"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Resolve the topic a panel select submitted — only a configured one; a
/// crafted value is refused rather than acted on.
pub fn resolve_topic<'c>(cfg: &'c InstanceConfig, value: Option<&str>) -> Option<&'c Topic> {
    value.and_then(|v| cfg.topics.iter().find(|t| t.id == v))
}

// ── channel permission overwrites (pure) ────────────────────────────────────────

/// Build the permission overwrites for a fresh ticket channel: hide it from
/// `@everyone`, and grant the opener, every staff role, and the bot. `@everyone`
/// is the role whose id equals the guild id.
pub fn permission_overwrites(
    guild_id: &str,
    opener_id: &str,
    staff_ids: &[String],
    bot_id: &str,
    grants: Grants,
) -> Vec<Value> {
    let mut out = Vec::with_capacity(staff_ids.len() + 3);
    out.push(json!({
        "id": guild_id,
        "type": OVERWRITE_ROLE,
        "deny": perms::VIEW_CHANNEL.to_string(),
    }));
    out.push(json!({
        "id": opener_id,
        "type": OVERWRITE_MEMBER,
        "allow": grants.participant().to_string(),
    }));
    for id in staff_ids {
        out.push(json!({
            "id": id,
            "type": OVERWRITE_ROLE,
            "allow": grants.participant().to_string(),
        }));
    }
    out.push(json!({
        "id": bot_id,
        "type": OVERWRITE_MEMBER,
        "allow": grants.bot().to_string(),
    }));
    out
}

// ── component builders (pure) ───────────────────────────────────────────────────

fn button(style: u8, label: &str, emoji: &str, custom_id: String) -> Value {
    json!({
        "type": COMPONENT_BUTTON,
        "style": style,
        "label": label,
        "emoji": { "name": emoji },
        "custom_id": custom_id,
    })
}

/// The control row on an open ticket: Close, Claim/Unclaim (when claiming is
/// on), and Members.
pub fn control_row(id: &str, claim_enabled: bool, claimed: bool) -> Value {
    let mut buttons = vec![button(
        BUTTON_DANGER,
        "Close",
        "\u{1F512}",
        control_id("close", id),
    )];
    if claim_enabled {
        buttons.push(if claimed {
            button(
                BUTTON_SECONDARY,
                "Unclaim",
                "\u{1F64B}",
                control_id("unclaim", id),
            )
        } else {
            button(
                BUTTON_PRIMARY,
                "Claim",
                "\u{1F64B}",
                control_id("claim", id),
            )
        });
    }
    buttons.push(button(
        BUTTON_SECONDARY,
        "Members",
        "\u{1F465}",
        control_id("members", id),
    ));
    json!({ "type": COMPONENT_ACTION_ROW, "components": buttons })
}

/// The control row on a *locked* (closed-but-kept) ticket: Reopen + Delete.
pub fn locked_controls(id: &str) -> Value {
    json!({
        "type": COMPONENT_ACTION_ROW,
        "components": [
            button(BUTTON_SECONDARY, "Reopen", "\u{1F513}", control_id("reopen", id)),
            button(BUTTON_DANGER, "Delete", "\u{1F5D1}\u{FE0F}", control_id("delete", id)),
        ],
    })
}

/// The edit that retires a control message's buttons once they're stale (the
/// welcome's Close/Claim after a lock; the Reopen/Delete after a reopen).
pub fn retire_controls() -> Value {
    json!({ "components": [] })
}

// ── messages a ticket posts (pure) ──────────────────────────────────────────────

/// The welcome message posted in a new ticket: the rendered template, the
/// control row, and an `allowed_mentions` that pings only what the config opted
/// into (never `@everyone`, even if a template or topic name contains it).
pub fn welcome_message(
    cfg: &InstanceConfig,
    id: &str,
    ctx: &TemplateCtx,
    staff_ids: &[String],
) -> Value {
    let content = clamp(&render_template(&cfg.welcome, ctx), MAX_CONTENT);
    let users = if cfg.ping_opener {
        vec![ctx.opener_id.to_string()]
    } else {
        vec![]
    };
    let roles: Vec<&String> = if cfg.ping_staff {
        staff_ids.iter().collect()
    } else {
        vec![]
    };
    json!({
        "content": content,
        "components": [control_row(id, cfg.claim_enabled, false)],
        "allowed_mentions": { "parse": [], "users": users, "roles": roles },
    })
}

const CLAIM_MARK: &str = "\u{1F64B} Claimed by <@";

/// `content` with the "Claimed by" line set to `claimer` — kept whole under the
/// content cap by trimming the body above it, never the line itself.
pub fn with_claim_line(content: &str, claimer: &str) -> String {
    let line = format!("\n\n{CLAIM_MARK}{claimer}>");
    let base = without_claim_line(content);
    let room = MAX_CONTENT.saturating_sub(line.chars().count());
    format!("{}{line}", clamp(&base, room))
}

/// `content` without a trailing "Claimed by" line (the one [`with_claim_line`]
/// adds — also the format older builds wrote).
pub fn without_claim_line(content: &str) -> String {
    let marker = format!("\n\n{CLAIM_MARK}");
    match content.rfind(&marker) {
        Some(i) if !content[i + 2..].contains('\n') => content[..i].to_string(),
        _ => content.to_string(),
    }
}

/// The `UPDATE_MESSAGE` for a claim or unclaim: the clicked control message's
/// content with the claim line set or cleared, and its row flipped. Reusing the
/// message's own content (not re-rendering the template) means nothing re-pings.
pub fn claim_update(id: &str, existing_content: &str, claimer: Option<&str>) -> Value {
    let content = match claimer {
        Some(c) => with_claim_line(existing_content, c),
        None => without_claim_line(existing_content),
    };
    json!({
        "type": RESPONSE_UPDATE_MESSAGE,
        "data": {
            "content": content,
            "components": [control_row(id, true, claimer.is_some())],
            "allowed_mentions": { "parse": [] },
        }
    })
}

/// The intake answers, posted right after the welcome so staff see the form
/// inline. Split across as many messages as the 2000-character cap needs —
/// never truncated — and nothing in an answer can ping (`parse: []`).
pub fn intake_messages(fields: &[IntakeField], answers: &[(String, String)]) -> Vec<Value> {
    let mut blocks: Vec<String> = Vec::new();
    for (id, value) in answers {
        let label = fields
            .iter()
            .find(|f| &f.id == id)
            .map(|f| f.label.as_str())
            .unwrap_or(id);
        let value = value.trim();
        let shown = if value.is_empty() {
            "\u{2014}".to_string()
        } else {
            clamp(value, 1500)
        };
        blocks.push(format!("**{}**\n{}", clamp(label, 256), shown));
    }
    if blocks.is_empty() {
        return vec![];
    }
    let mut messages = Vec::new();
    let mut current = String::from("\u{1F4CB} **Intake answers**");
    for block in blocks {
        let joined = current.chars().count() + 2 + block.chars().count();
        if joined > MAX_CONTENT && !current.is_empty() {
            messages.push(std::mem::take(&mut current));
            current = block;
        } else {
            if !current.is_empty() {
                current.push_str("\n\n");
            }
            current.push_str(&block);
        }
    }
    messages.push(current);
    messages
        .into_iter()
        .map(|content| {
            json!({ "content": clamp(&content, MAX_CONTENT), "allowed_mentions": { "parse": [] } })
        })
        .collect()
}

fn closed_by_line(closer_id: &str, reason: &str) -> String {
    let mut body = format!("\u{1F512} Ticket closed by <@{closer_id}>.");
    let reason = reason.trim();
    if !reason.is_empty() {
        body.push_str(&format!("\n**Reason:** {}", clamp(reason, 1500)));
    }
    body
}

/// Posted in a delete-mode ticket just before it goes, so everyone in it —
/// the opener included — sees who closed it and why. `delete_at` is unix
/// seconds; the `<t:…:R>` counts down in each reader's client.
pub fn closing_notice(closer_id: &str, reason: &str, delete_at: i64) -> Value {
    json!({
        "content": clamp(
            &format!("{}\nThis channel will be deleted <t:{delete_at}:R>.", closed_by_line(closer_id, reason)),
            MAX_CONTENT,
        ),
        "allowed_mentions": { "parse": [] },
    })
}

/// Posted when a delete-mode close couldn't delete the channel after all.
pub fn close_failed_notice() -> Value {
    json!({
        "content": "\u{26A0}\u{FE0F} I couldn't delete this channel, so the ticket stays open.",
        "allowed_mentions": { "parse": [] },
    })
}

/// The message posted in a ticket when it's locked (close_mode = "lock"): who
/// closed it, the optional reason, and Reopen/Delete controls.
pub fn locked_message(id: &str, closer_id: &str, reason: &str) -> Value {
    json!({
        "content": clamp(&closed_by_line(closer_id, reason), MAX_CONTENT),
        "components": [locked_controls(id)],
        "allowed_mentions": { "parse": [] },
    })
}

/// The fresh control message posted when a locked ticket is reopened. A claim
/// survives the lock, so the row shows it.
pub fn reopened_message(
    id: &str,
    claim_enabled: bool,
    claimed_by: Option<&str>,
    reopener_id: &str,
) -> Value {
    let mut content = format!("\u{1F513} Reopened by <@{reopener_id}>.");
    if let (true, Some(by)) = (claim_enabled, claimed_by) {
        content = with_claim_line(&content, by);
    }
    json!({
        "content": content,
        "components": [control_row(id, claim_enabled, claim_enabled && claimed_by.is_some())],
        "allowed_mentions": { "parse": [] },
    })
}

/// The ephemeral people picker a staff member gets from **Members**: one user
/// select to add, one to remove.
pub fn members_panel(id: &str, note: Option<&str>) -> Value {
    let mut content = String::from(
        "\u{1F465} **Who can see this ticket**\nAdd people to bring them in, or remove someone who was added. The opener and staff roles keep their access.",
    );
    if let Some(note) = note {
        content.push_str("\n\n");
        content.push_str(note);
    }
    let select = |verb: &str, placeholder: &str| {
        json!({
            "type": COMPONENT_ACTION_ROW,
            "components": [{
                "type": COMPONENT_USER_SELECT,
                "custom_id": control_id(verb, id),
                "placeholder": placeholder,
                "min_values": 1,
                "max_values": MEMBERS_PER_PICK,
            }],
        })
    };
    json!({
        "content": clamp(&content, MAX_CONTENT),
        "components": [select("addmember", "Add people…"), select("rmmember", "Remove people…")],
        "allowed_mentions": { "parse": [] },
    })
}

/// The public note when staff add people — it pings exactly the people added,
/// so they find the ticket.
pub fn members_added_note(actor_id: &str, added: &[String]) -> Value {
    json!({
        "content": format!(
            "\u{1F465} <@{actor_id}> added {} to this ticket.",
            mention_list(added)
        ),
        "allowed_mentions": { "parse": [], "users": added },
    })
}

/// The public note when staff remove people. Pings no one.
pub fn members_removed_note(actor_id: &str, removed: &[String]) -> Value {
    json!({
        "content": format!(
            "\u{1F465} <@{actor_id}> removed {} from this ticket.",
            mention_list(removed)
        ),
        "allowed_mentions": { "parse": [] },
    })
}

fn mention_list(ids: &[String]) -> String {
    ids.iter()
        .map(|id| format!("<@{id}>"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The staff overview of a panel: every ticket still around, oldest first,
/// inside one reply's 2000 characters.
pub fn manage_text(tickets: &[Ticket], total_shown_cap: usize) -> String {
    let open = tickets
        .iter()
        .filter(|t| t.status != crate::store::Status::Locked)
        .count();
    let locked = tickets.len() - open;
    let mut out = format!("\u{1F3AB} **Tickets on this panel** — {open} open");
    if locked > 0 {
        out.push_str(&format!(" · {locked} closed and kept"));
    }
    if tickets.is_empty() {
        out.push_str("\nNo tickets are open right now.");
        return out;
    }
    for t in tickets {
        let mut line = format!("\n<#{}> · #{:04}", t.channel_id, t.number);
        if !t.topic.is_empty() {
            line.push_str(&format!(" · {}", clamp(&t.topic, 60)));
        }
        line.push_str(&format!(
            " · <@{}> · opened <t:{}:R>",
            t.opener_id,
            t.created_at / 1000
        ));
        match (&t.claimed_by, t.status) {
            (_, crate::store::Status::Locked) => line.push_str(" · \u{1F512} closed"),
            (Some(by), _) => line.push_str(&format!(" · \u{1F64B} <@{by}>")),
            (None, _) => line.push_str(" · unclaimed"),
        }
        if out.chars().count() + line.chars().count() > MAX_CONTENT - 80 {
            out.push_str("\n-# …and more. Open the ticket category to see them all.");
            return out;
        }
        out.push_str(&line);
    }
    if tickets.len() >= total_shown_cap {
        out.push_str(&format!("\n-# Showing the oldest {total_shown_cap}."));
    }
    out
}

// ── modals (pure) ────────────────────────────────────────────────────────────

/// Build the intake MODAL callback. `submit_id` is routed back here on submit
/// (it carries the panel id and, for a topic select, the chosen topic). The
/// title names the topic when there is one.
pub fn intake_modal(submit_id: &str, topic: &str, fields: &[IntakeField]) -> Value {
    let rows: Vec<Value> = fields
        .iter()
        .take(5)
        .map(|f| {
            let (style, max) = if f.style == "paragraph" {
                (TEXT_INPUT_PARAGRAPH, INTAKE_PARAGRAPH_MAX)
            } else {
                (TEXT_INPUT_SHORT, INTAKE_SHORT_MAX)
            };
            let mut input = json!({
                "type": COMPONENT_TEXT_INPUT,
                "custom_id": clamp(&f.id, 100),
                "label": clamp(&f.label, 45),
                "style": style,
                "required": f.required,
                "max_length": max,
            });
            if let Some(p) = &f.placeholder {
                input["placeholder"] = json!(clamp(p, 100));
            }
            json!({ "type": COMPONENT_ACTION_ROW, "components": [input] })
        })
        .collect();
    let title = if topic.trim().is_empty() {
        "Open a ticket".to_string()
    } else {
        format!("Open a ticket — {}", topic.trim())
    };
    json!({
        "type": RESPONSE_MODAL,
        "data": { "custom_id": submit_id, "title": clamp(&title, 45), "components": rows }
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
            "allowed_mentions": { "parse": [] },
        }
    })
}

/// An ephemeral reply carrying a full message body (content + components).
pub fn ephemeral_message(mut body: Value) -> Value {
    body["flags"] = json!(FLAG_EPHEMERAL);
    json!({ "type": RESPONSE_CHANNEL_MESSAGE, "data": body })
}

/// A deferred ephemeral ack ("…thinking"), edited later via `PATCH @original`.
/// Every multi-call flow uses it so the Discord work happens off the 3s path.
pub fn deferred_ephemeral() -> Value {
    json!({ "type": RESPONSE_DEFERRED_CHANNEL_MESSAGE, "data": { "flags": FLAG_EPHEMERAL } })
}

/// A deferred ack that will edit the clicked message itself (the Members
/// picker, which reports its result in place).
pub fn deferred_update() -> Value {
    json!({ "type": RESPONSE_DEFERRED_UPDATE_MESSAGE })
}

/// The plain-content body used to edit a deferred reply (`PATCH @original`).
pub fn followup_content(content: &str) -> Value {
    json!({ "content": clamp(content, MAX_CONTENT), "allowed_mentions": { "parse": [] } })
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

/// Why an open failed, for the opener. Each names the fix, or says it's
/// transient — never "fix your permissions" for a blip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenFailure {
    MissingPermissions,
    ChannelLimit,
    Busy,
    Rejected,
    /// Our own storage failed.
    Internal,
}

pub fn open_failure_text(f: OpenFailure) -> &'static str {
    match f {
        OpenFailure::Internal => "Something went wrong on my end — try again in a moment.",
        OpenFailure::MissingPermissions => {
            "I couldn't create your ticket channel because the bot is missing a permission. Ask an admin to reopen this panel's settings in DWEEB — it shows exactly what to fix."
        }
        OpenFailure::ChannelLimit => {
            "This server has reached Discord's limit on channels, so I can't open a ticket channel. Ask an admin to clear out some old channels."
        }
        OpenFailure::Busy => "Discord was busy and I couldn't open your ticket — try again in a moment.",
        OpenFailure::Rejected => {
            "Discord wouldn't create the ticket channel. Ask an admin to check this panel's settings in DWEEB."
        }
    }
}

// ── log channel lines (pure) ─────────────────────────────────────────────────

fn topic_suffix(topic: &str) -> String {
    if topic.is_empty() {
        String::new()
    } else {
        format!(" · {}", clamp(topic, 100))
    }
}

pub fn open_log(ticket: &Ticket) -> String {
    format!(
        "\u{1F3AB} **#{:04}** opened by <@{}> \u{2192} <#{}>{}",
        ticket.number,
        ticket.opener_id,
        ticket.channel_id,
        topic_suffix(&ticket.topic)
    )
}

/// The close record: who, whose, how long, why.
pub fn close_log(ticket: &Ticket, closer_id: &str, reason: &str, now_ms: i64) -> String {
    let mut line = format!(
        "\u{1F512} **#{:04}** closed by <@{closer_id}> · opened by <@{}>{} · open {}",
        ticket.number,
        ticket.opener_id,
        topic_suffix(&ticket.topic),
        crate::timefmt::humanize_ms(now_ms - ticket.created_at)
    );
    let reason = reason.trim();
    if !reason.is_empty() {
        line.push_str(&format!("\n**Reason:** {}", clamp(reason, 1500)));
    }
    clamp(&line, MAX_CONTENT)
}

pub fn reopen_log(ticket: &Ticket, actor_id: &str) -> String {
    format!(
        "\u{1F513} **#{:04}** reopened by <@{actor_id}> \u{2192} <#{}>",
        ticket.number, ticket.channel_id
    )
}

pub fn delete_log(ticket: &Ticket, actor_id: &str) -> String {
    format!(
        "\u{1F5D1}\u{FE0F} **#{:04}** deleted by <@{actor_id}>",
        ticket.number
    )
}

/// Why a ticket opened somewhere other than its configured category.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fallback {
    /// The category is full (Discord caps a category at 50 channels) or gone.
    CategoryUnavailable,
    /// The bot can't create channels in the category.
    CategoryDenied,
}

pub fn fallback_log(ticket: &Ticket, why: Fallback) -> String {
    let reason = match why {
        Fallback::CategoryUnavailable => {
            "the ticket category is full (Discord allows 50 channels per category) or no longer exists"
        }
        Fallback::CategoryDenied => "the bot isn't allowed to create channels in the ticket category",
    };
    format!(
        "\u{26A0}\u{FE0F} **#{:04}** (<#{}>) opened at the top of the server because {reason}. Pick another category, or fix the bot's access, in this panel's settings.",
        ticket.number, ticket.channel_id
    )
}

/// A plain log message: never pings anyone the line mentions.
pub fn log_message(content: &str) -> Value {
    json!({ "content": clamp(content, MAX_CONTENT), "allowed_mentions": { "parse": [] } })
}

/// Truncate to at most `max` characters (respecting char boundaries).
pub fn clamp(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{ResponseDef, StaffRole, Status};

    fn roles(ids: &[&str]) -> Vec<StaffRole> {
        ids.iter()
            .map(|id| StaffRole {
                id: id.to_string(),
                name: format!("Role {id}"),
                color: 0,
            })
            .collect()
    }

    fn ids(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    fn ticket(channel: &str) -> Ticket {
        Ticket {
            channel_id: channel.into(),
            instance_id: "abc".into(),
            guild_id: "g".into(),
            number: 42,
            opener_id: "7".into(),
            opener_name: "Ada".into(),
            topic: "Billing".into(),
            topic_id: "t1".into(),
            channel_name: "ticket-0042".into(),
            claimed_by: None,
            status: Status::Open,
            created_at: 1_000_000,
            closed_at: None,
            closed_by: None,
        }
    }

    // ── custom_id routing ──────────────────────────────────────────────────
    #[test]
    fn parse_action_round_trips_the_control_ids() {
        let cases = [
            ("open", Action::Open { id: "abc".into() }),
            ("claim", Action::Claim { id: "abc".into() }),
            ("unclaim", Action::Unclaim { id: "abc".into() }),
            ("close", Action::Close { id: "abc".into() }),
            ("doclose", Action::DoClose { id: "abc".into() }),
            ("reopen", Action::Reopen { id: "abc".into() }),
            ("delete", Action::Delete { id: "abc".into() }),
            ("members", Action::Members { id: "abc".into() }),
            ("addmember", Action::AddMembers { id: "abc".into() }),
            ("rmmember", Action::RemoveMembers { id: "abc".into() }),
            ("manage", Action::Manage { id: "abc".into() }),
        ];
        for (verb, want) in cases {
            let id = control_id(verb, "abc");
            assert!(id.len() <= 100, "{id} is too long for a custom_id");
            assert_eq!(parse_action(&id), want);
        }
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
        let staff = ids(&["100", "200"]);
        assert!(is_staff(&ids(&["100"]), 0, &staff)); // has a staff role
        assert!(!is_staff(&ids(&["999"]), 0, &staff)); // unrelated role, no perms
        assert!(is_staff(&[], perms::ADMINISTRATOR, &staff)); // admin always staff
        assert!(is_staff(&[], perms::MANAGE_CHANNELS, &staff));
        assert!(is_staff(&[], perms::MANAGE_GUILD, &staff));
        assert!(!is_staff(&[], 0, &staff)); // a plain member is not staff
    }

    #[test]
    fn topic_staff_join_the_panel_staff_without_duplicates() {
        let mut cfg = base_cfg();
        cfg.target = "string_select".into();
        cfg.staff_roles = roles(&["100"]);
        cfg.topics = vec![Topic {
            id: "t1".into(),
            label: "Billing".into(),
            emoji: None,
            description: None,
            staff_roles: roles(&["300", "100"]),
            category_id: None,
            category_name: String::new(),
        }];
        assert_eq!(staff_ids(&cfg, "t1"), ids(&["100", "300"]));
        // An unknown or empty topic contributes nothing.
        assert_eq!(staff_ids(&cfg, "gone"), ids(&["100"]));
        assert_eq!(staff_ids(&cfg, ""), ids(&["100"]));
    }

    // ── open gate ──────────────────────────────────────────────────────────
    fn stats(open: i64, pending: i64, last: Option<i64>) -> OpenStats {
        OpenStats {
            open,
            pending,
            last_open_ms: last,
        }
    }

    #[test]
    fn open_gate_blocks_at_the_concurrent_limit() {
        assert_eq!(
            open_gate(&stats(1, 0, None), 1, 0, 0),
            OpenGate::AtLimit { max: 1 }
        );
        assert_eq!(open_gate(&stats(0, 0, None), 1, 0, 0), OpenGate::Allowed);
        // 0 = unlimited.
        assert_eq!(open_gate(&stats(99, 0, None), 0, 0, 0), OpenGate::Allowed);
    }

    #[test]
    fn an_open_in_flight_is_refused_even_without_limits() {
        // No cap, no cooldown — a double-click is still one ticket.
        assert_eq!(open_gate(&stats(0, 1, None), 0, 0, 0), OpenGate::InFlight);
    }

    #[test]
    fn open_gate_enforces_cooldown_then_clears() {
        let now = 1_000_000;
        // Opened 10s ago, 30s cooldown → may try again 20s from now.
        assert_eq!(
            open_gate(&stats(0, 0, Some(now - 10_000)), 0, now, 30),
            OpenGate::Cooldown {
                until_ms: now + 20_000
            }
        );
        // Past the window → allowed.
        assert_eq!(
            open_gate(&stats(0, 0, Some(now - 31_000)), 0, now, 30),
            OpenGate::Allowed
        );
        // Limit takes precedence over cooldown.
        assert_eq!(
            open_gate(&stats(2, 0, Some(now)), 2, now, 30),
            OpenGate::AtLimit { max: 2 }
        );
    }

    #[test]
    fn at_limit_points_at_the_open_ticket() {
        let one = gate_text(OpenGate::AtLimit { max: 1 }, &[ticket("555")]);
        assert!(one.contains("<#555>"), "{one}");
        let two = gate_text(
            OpenGate::AtLimit { max: 2 },
            &[ticket("555"), ticket("666")],
        );
        assert!(two.contains("<#555>, <#666>") && two.contains("limit is 2"));
        assert!(gate_text(OpenGate::AtLimit { max: 3 }, &[]).contains("(3)"));
        // The cooldown counts down in the reader's client, rounded up.
        let cd = gate_text(OpenGate::Cooldown { until_ms: 10_001 }, &[]);
        assert!(cd.contains("<t:11:R>"), "{cd}");
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
        assert_eq!(channel_name("username", 1, "ada_dev"), "ticket-ada_dev");
        assert_eq!(channel_name("username", 1, "✨ emoji ✨"), "ticket-emoji");
        // Any script works — Discord accepts it.
        assert_eq!(channel_name("username", 1, "Ōkami 狼"), "ticket-ōkami-狼");
        // Nothing usable falls back to the number, never a shared name.
        assert_eq!(channel_name("username", 7, "✨✨"), "ticket-0007");
        assert!(
            channel_name("username", 1, &"a".repeat(300))
                .chars()
                .count()
                <= 100
        );
    }

    #[test]
    fn lock_and_reopen_names_round_trip() {
        assert_eq!(closed_name("ticket-0042", 42), "closed-0042");
        assert_eq!(closed_name("ticket-ada", 42), "closed-ada");
        // Tickets from before names were recorded fall back to the number.
        assert_eq!(closed_name("", 42), "closed-0042");
        assert_eq!(reopen_name("ticket-ada", 42), "ticket-ada");
        assert_eq!(reopen_name("", 42), "ticket-0042");
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
            "Hi {user} ({username}) re {topic} in {ticket} — {staff} {unknown}",
            &ctx,
        );
        assert_eq!(
            out,
            "Hi <@42> (Ada) re Billing in <#777> — <@&100> {unknown}"
        );
    }

    #[test]
    fn staff_mentions_falls_back_to_the_team() {
        assert_eq!(staff_mentions(&[]), "the team");
        assert_eq!(staff_mentions(&ids(&["1", "2"])), "<@&1> <@&2>");
    }

    // ── overwrites ─────────────────────────────────────────────────────────
    #[test]
    fn overwrites_hide_from_everyone_and_grant_opener_staff_bot() {
        let ow = permission_overwrites("guild1", "opener1", &ids(&["role1"]), "bot1", Grants::Full);
        // @everyone (id == guild id) is denied view.
        assert_eq!(ow[0]["id"], "guild1");
        assert_eq!(ow[0]["deny"], perms::VIEW_CHANNEL.to_string());
        // opener is a member overwrite that can view+send.
        assert_eq!(ow[1]["id"], "opener1");
        assert_eq!(ow[1]["type"], OVERWRITE_MEMBER);
        let allow: u64 = ow[1]["allow"].as_str().unwrap().parse().unwrap();
        assert!(allow & perms::VIEW_CHANNEL != 0 && allow & perms::SEND_MESSAGES != 0);
        assert!(allow & perms::ATTACH_FILES != 0);
        // staff role overwrite present.
        assert_eq!(ow[2]["id"], "role1");
        assert_eq!(ow[2]["type"], OVERWRITE_ROLE);
        // bot can also manage the channel.
        let bot = ow.last().unwrap();
        assert_eq!(bot["id"], "bot1");
        let bot_allow: u64 = bot["allow"].as_str().unwrap().parse().unwrap();
        assert!(bot_allow & perms::MANAGE_CHANNELS != 0);

        // The essential fallback grants no optional bit.
        let lean = permission_overwrites("g", "o", &[], "b", Grants::Essential);
        let allow: u64 = lean[1]["allow"].as_str().unwrap().parse().unwrap();
        assert_eq!(allow & perms::ATTACH_FILES, 0);
        assert_ne!(allow & perms::SEND_MESSAGES, 0);
    }

    // ── welcome message & controls ──────────────────────────────────────────
    fn base_cfg() -> InstanceConfig {
        InstanceConfig {
            target: "button".into(),
            guild_id: "g".into(),
            guild_name: String::new(),
            staff_roles: roles(&["100"]),
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
            transcript_dm: false,
            max_open_per_user: 1,
            cooldown_secs: 30,
            response: ResponseDef::default(),
        }
    }

    fn ctx() -> TemplateCtx<'static> {
        TemplateCtx {
            opener_id: "42",
            opener_name: "Ada",
            channel_id: "777",
            topic: "",
            staff_mentions: "<@&100>",
        }
    }

    #[test]
    fn welcome_pings_only_what_is_opted_in() {
        let cfg = base_cfg();
        let msg = welcome_message(&cfg, "abc", &ctx(), &ids(&["100", "300"]));
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
        // The control row has Close + Claim (not yet claimed) + Members.
        let buttons = &msg["components"][0]["components"];
        assert_eq!(buttons[0]["custom_id"], "tickets:close:abc");
        assert_eq!(buttons[1]["custom_id"], "tickets:claim:abc");
        assert_eq!(buttons[2]["custom_id"], "tickets:members:abc");
    }

    #[test]
    fn welcome_pings_panel_and_topic_staff_when_enabled() {
        let mut cfg = base_cfg();
        cfg.ping_staff = true;
        let msg = welcome_message(&cfg, "abc", &ctx(), &ids(&["100", "300"]));
        assert_eq!(msg["allowed_mentions"]["roles"], json!(["100", "300"]));
    }

    #[test]
    fn control_row_without_claim_has_close_and_members() {
        let row = control_row("abc", false, false);
        let buttons = row["components"].as_array().unwrap();
        let ids: Vec<_> = buttons
            .iter()
            .map(|b| b["custom_id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["tickets:close:abc", "tickets:members:abc"]);
    }

    #[test]
    fn claim_line_is_set_replaced_and_cleared() {
        let claimed = with_claim_line("Welcome!", "9");
        assert_eq!(claimed, "Welcome!\n\n\u{1F64B} Claimed by <@9>");
        // Re-claiming replaces, never stacks.
        assert_eq!(
            with_claim_line(&claimed, "8"),
            "Welcome!\n\n\u{1F64B} Claimed by <@8>"
        );
        assert_eq!(without_claim_line(&claimed), "Welcome!");
        // A body that merely mentions the phrase mid-text is left alone.
        let prose = "Note: \u{1F64B} Claimed by <@1> means taken.\nThanks";
        assert_eq!(without_claim_line(prose), prose);
        // The line survives a full-length body.
        let long = with_claim_line(&"x".repeat(MAX_CONTENT), "9");
        assert!(long.chars().count() <= MAX_CONTENT);
        assert!(long.ends_with("Claimed by <@9>"));
    }

    #[test]
    fn claim_update_flips_the_row_and_never_pings() {
        let v = claim_update("abc", "Welcome!", Some("9"));
        assert!(v["data"]["content"]
            .as_str()
            .unwrap()
            .contains("Claimed by <@9>"));
        assert_eq!(
            v["data"]["components"][0]["components"][1]["custom_id"],
            "tickets:unclaim:abc"
        );
        assert_eq!(
            v["data"]["allowed_mentions"]["parse"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        let back = claim_update("abc", v["data"]["content"].as_str().unwrap(), None);
        assert_eq!(back["data"]["content"], "Welcome!");
        assert_eq!(
            back["data"]["components"][0]["components"][1]["custom_id"],
            "tickets:claim:abc"
        );
    }

    #[test]
    fn reopened_message_keeps_the_claim() {
        let v = reopened_message("abc", true, Some("9"), "5");
        assert!(v["content"].as_str().unwrap().contains("Claimed by <@9>"));
        assert_eq!(
            v["components"][0]["components"][1]["custom_id"],
            "tickets:unclaim:abc"
        );
        let plain = reopened_message("abc", true, None, "5");
        assert_eq!(
            plain["components"][0]["components"][1]["custom_id"],
            "tickets:claim:abc"
        );
    }

    // ── members ────────────────────────────────────────────────────────────
    #[test]
    fn members_panel_offers_add_and_remove_pickers() {
        let v = members_panel("abc", None);
        assert_eq!(
            v["components"][0]["components"][0]["custom_id"],
            "tickets:addmember:abc"
        );
        assert_eq!(
            v["components"][0]["components"][0]["type"],
            COMPONENT_USER_SELECT
        );
        assert_eq!(
            v["components"][1]["components"][0]["custom_id"],
            "tickets:rmmember:abc"
        );
        let with_note = members_panel("abc", Some("Added <@1>."));
        assert!(with_note["content"]
            .as_str()
            .unwrap()
            .ends_with("Added <@1>."));
    }

    #[test]
    fn adding_pings_the_added_and_removing_pings_nobody() {
        let added = members_added_note("5", &ids(&["1", "2"]));
        assert_eq!(added["allowed_mentions"]["users"], json!(["1", "2"]));
        assert!(added["content"].as_str().unwrap().contains("<@1>, <@2>"));
        let removed = members_removed_note("5", &ids(&["1"]));
        assert!(removed["allowed_mentions"].get("users").is_none());
    }

    // ── modals ─────────────────────────────────────────────────────────────
    #[test]
    fn intake_modal_carries_fields_limits_and_topic() {
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
        let v = intake_modal("tickets:intake:abc:billing", "Billing", &fields);
        assert_eq!(v["data"]["custom_id"], "tickets:intake:abc:billing");
        assert_eq!(v["data"]["title"], "Open a ticket — Billing");
        let first = &v["data"]["components"][0]["components"][0];
        assert_eq!(first["custom_id"], "f1");
        assert_eq!(first["required"], true);
        assert_eq!(first["max_length"], INTAKE_SHORT_MAX);
        let second = &v["data"]["components"][1]["components"][0];
        assert_eq!(second["style"], TEXT_INPUT_PARAGRAPH);
        assert_eq!(second["max_length"], INTAKE_PARAGRAPH_MAX);
        // No topic, plain title; a long topic is clamped to Discord's 45.
        assert_eq!(
            intake_modal("x", "", &fields)["data"]["title"],
            "Open a ticket"
        );
        let long = intake_modal("x", &"y".repeat(80), &fields);
        assert_eq!(long["data"]["title"].as_str().unwrap().chars().count(), 45);
    }

    #[test]
    fn reason_is_pulled_from_a_close_modal() {
        let data = InteractionData {
            custom_id: Some("tickets:doclose:abc".into()),
            values: None,
            resolved: None,
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
    fn intake_answers_are_labelled_and_never_truncated() {
        let fields: Vec<IntakeField> = (0..5)
            .map(|i| IntakeField {
                id: format!("f{i}"),
                label: format!("Question {i}"),
                style: "paragraph".into(),
                required: false,
                placeholder: None,
            })
            .collect();
        // Five maximal answers: far past one message's 2000 characters.
        let answers: Vec<(String, String)> = (0..5)
            .map(|i| {
                (
                    format!("f{i}"),
                    format!("{i}").repeat(INTAKE_PARAGRAPH_MAX as usize),
                )
            })
            .collect();
        let msgs = intake_messages(&fields, &answers);
        assert!(msgs.len() >= 3);
        let all: String = msgs
            .iter()
            .map(|m| m["content"].as_str().unwrap().to_string())
            .collect();
        for (i, (_, answer)) in answers.iter().enumerate() {
            assert!(all.contains(answer.as_str()), "answer {i} was cut");
            assert!(all.contains(&format!("**Question {i}**")));
        }
        for m in &msgs {
            assert!(m["content"].as_str().unwrap().chars().count() <= MAX_CONTENT);
            assert_eq!(m["allowed_mentions"]["parse"], json!([]));
        }
        // Blank answers read as an em dash; no answers, no message.
        let blank = intake_messages(&fields, &[("f0".into(), "  ".into())]);
        assert!(blank[0]["content"].as_str().unwrap().contains('\u{2014}'));
        assert!(intake_messages(&fields, &[]).is_empty());
    }

    // ── replies ────────────────────────────────────────────────────────────
    #[test]
    fn open_success_summary_links_the_channel() {
        let cfg = base_cfg();
        assert!(open_success_text(&cfg, "777", &ctx()).contains("<#777>"));
    }

    #[test]
    fn open_success_custom_renders_template() {
        let mut cfg = base_cfg();
        cfg.response = ResponseDef {
            mode: "custom".into(),
            text: Some("See {ticket} 🎉".into()),
        };
        assert_eq!(open_success_text(&cfg, "777", &ctx()), "See <#777> 🎉");
    }

    #[test]
    fn topics_resolve_only_to_configured_values() {
        let mut cfg = base_cfg();
        cfg.topics = vec![Topic {
            id: "t1".into(),
            label: "Billing".into(),
            emoji: None,
            description: None,
            staff_roles: vec![],
            category_id: None,
            category_name: String::new(),
        }];
        assert_eq!(resolve_topic(&cfg, Some("t1")).unwrap().label, "Billing");
        assert!(resolve_topic(&cfg, Some("evil")).is_none()); // unknown value → refused
        assert!(resolve_topic(&cfg, None).is_none());
    }

    #[test]
    fn every_open_failure_explains_itself() {
        for f in [
            OpenFailure::MissingPermissions,
            OpenFailure::ChannelLimit,
            OpenFailure::Busy,
            OpenFailure::Rejected,
            OpenFailure::Internal,
        ] {
            assert!(!open_failure_text(f).is_empty());
        }
    }

    // ── records ────────────────────────────────────────────────────────────
    #[test]
    fn log_lines_name_the_ticket_and_the_people() {
        let t = ticket("555");
        let open = open_log(&t);
        assert!(open.contains("#0042") && open.contains("<@7>") && open.contains("<#555>"));
        assert!(open.contains("Billing"));
        let close = close_log(&t, "9", "fixed", t.created_at + 3_600_000);
        assert!(close.contains("<@9>") && close.contains("open 1h") && close.contains("fixed"));
        assert!(reopen_log(&t, "9").contains("<#555>"));
        assert!(delete_log(&t, "9").contains("#0042"));
        assert!(fallback_log(&t, Fallback::CategoryUnavailable).contains("50 channels"));
        assert_eq!(log_message("x")["allowed_mentions"]["parse"], json!([]));
    }

    #[test]
    fn manage_overview_lists_tickets_and_states() {
        let mut claimed = ticket("1");
        claimed.claimed_by = Some("9".into());
        let mut locked = ticket("2");
        locked.status = Status::Locked;
        let text = manage_text(&[claimed, locked, ticket("3")], 25);
        assert!(text.contains("2 open") && text.contains("1 closed and kept"));
        assert!(text.contains("<#1>") && text.contains("\u{1F64B} <@9>"));
        assert!(text.contains("unclaimed"));
        assert!(manage_text(&[], 25).contains("No tickets are open"));
        // A long list stays inside one reply's budget.
        let many: Vec<Ticket> = (0..200).map(|i| ticket(&i.to_string())).collect();
        let text = manage_text(&many, 200);
        assert!(text.chars().count() <= MAX_CONTENT, "{}", text.len());
        assert!(text.ends_with("to see them all."));
    }

    #[test]
    fn closing_notice_counts_down_and_never_pings() {
        let v = closing_notice("9", "done", 1_700_000_000);
        let c = v["content"].as_str().unwrap();
        assert!(c.contains("<@9>") && c.contains("done") && c.contains("<t:1700000000:R>"));
        assert_eq!(v["allowed_mentions"]["parse"], json!([]));
    }
}
