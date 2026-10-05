//! Discord interaction protocol: signature verification, the request shapes we
//! read, the **pure** decision/builder logic, and the callback JSON we send back.
//!
//! Everything that *decides what should happen* — who may enter, who counts as a
//! host, which entrants win, how the live count is stamped onto the button, what
//! the winner announcement says — is a pure function here, so it is exhaustively
//! unit-tested. The only I/O lives in `rest.rs` (the optional role-list and
//! winner-DM calls); `routes.rs` is the thin shell that glues the two and turns
//! interaction responses into the live count + public announcement, no bot token
//! required.

use std::collections::BTreeSet;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::store::{Requirements, Status};

// Interaction request types.
pub const TYPE_PING: u8 = 1;
pub const TYPE_MESSAGE_COMPONENT: u8 = 3;

// Interaction callback (response) types.
const RESPONSE_PONG: u8 = 1;
const RESPONSE_CHANNEL_MESSAGE: u8 = 4;
const RESPONSE_UPDATE_MESSAGE: u8 = 7;

// Component / button / flag constants.
const COMPONENT_TYPE_BUTTON: u8 = 2;
const COMPONENT_ACTION_ROW: u8 = 1;
const COMPONENT_TEXT_DISPLAY: u8 = 10;
const BUTTON_PRIMARY: u8 = 1;
const BUTTON_SECONDARY: u8 = 2;
const BUTTON_SUCCESS: u8 = 3;
const BUTTON_DANGER: u8 = 4;
const FLAG_EPHEMERAL: u64 = 1 << 6; // 64
const FLAG_IS_COMPONENTS_V2: u64 = 1 << 15; // 32768
/// Components V2 caps the total text across a message at this many characters.
const MAX_V2_TEXT: usize = 4000;
/// Plain message `content` ceiling.
const MAX_CONTENT: usize = 2000;
/// Discord button-label ceiling.
const MAX_LABEL: usize = 80;

// Member permission bits that, on their own, make someone a giveaway "host".
const PERM_ADMINISTRATOR: u64 = 1 << 3;
const PERM_MANAGE_GUILD: u64 = 1 << 5;

/// Discord's epoch (2015-01-01) in ms — the offset baked into every snowflake.
const DISCORD_EPOCH_MS: i64 = 1_420_070_400_000;
const MS_PER_DAY: i64 = 86_400_000;

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
    #[serde(default)]
    pub guild_id: Option<String>,
    #[serde(default)]
    pub data: Option<InteractionData>,
    #[serde(default)]
    pub member: Option<Member>,
    #[serde(default)]
    pub user: Option<User>,
    /// On a component click, the message the component sits on. We echo its
    /// components back (with the Enter button's label restamped) to keep the
    /// live count current — the only way to edit a webhook-authored message.
    #[serde(default)]
    pub message: Option<MessageRef>,
    /// This interaction's webhook token. With the `application_id` it addresses
    /// `/webhooks/{app}/{token}` — used to post a *followup* (no bot token): when
    /// a host's Enter click spends its one reply on the `UPDATE_MESSAGE` refresh,
    /// the control panel rides here. Valid ~15 minutes.
    #[serde(default)]
    pub token: Option<String>,
    /// The application this interaction is for — the first path segment of the
    /// interaction-webhook URL above. (A custom app carries its own id here; the
    /// followup then runs against that app's interaction, exactly as it should.)
    #[serde(default)]
    pub application_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct InteractionData {
    #[serde(default)]
    pub custom_id: Option<String>,
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

/// We only ever need the actor's id (winners are referenced by mention, never
/// by display name), so this is deliberately minimal — extra payload fields are
/// ignored by serde.
#[derive(Debug, Deserialize, Clone)]
pub struct User {
    pub id: String,
}

/// The message a component sits on — its content, component tree, and flags, so
/// an `UPDATE_MESSAGE` can echo them back verbatim with one button restyled.
#[derive(Debug, Deserialize, Clone)]
pub struct MessageRef {
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub components: Option<Value>,
    #[serde(default)]
    pub flags: Option<u64>,
}

impl MessageRef {
    /// True when this is an ephemeral message — one of our panels, or someone's
    /// private copy of the giveaway (a Quick Replies reply carrying its button),
    /// never the public giveaway message. Its interaction token's `@original`
    /// is that private message, so it must never be re-rendered as the public
    /// message or cached as the out-of-band refresh target.
    pub fn is_ephemeral(&self) -> bool {
        self.flags.unwrap_or(0) & FLAG_EPHEMERAL != 0
    }
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
}

// ── custom_id routing ─────────────────────────────────────────────────────────

/// The plugin prefix every minted `custom_id` carries (and the dispatcher routes
/// on).
pub const PREFIX: &str = "giveaway:";

/// What a `custom_id` asks this plugin to do. The Enter button DWEEB attaches is
/// a bare `giveaway:<id>` (no verb); the host-panel controls carry a verb.
/// Parsing is total — anything unrecognised is [`Action::Unknown`].
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    /// The member-facing Enter button (the bound component).
    Enter {
        id: String,
    },
    /// Host panel: enter/leave as a participant.
    Join {
        id: String,
    },
    Leave {
        id: String,
    },
    /// Host panel: draw winners now.
    Draw {
        id: String,
    },
    /// Host panel: reroll a fresh set of winners.
    Reroll {
        id: String,
    },
    /// Host panel: call the giveaway off.
    Cancel {
        id: String,
    },
    /// Open the host panel from a surface that isn't the giveaway message —
    /// the dispatcher mints `giveaway:manage:<id>` buttons on its "Message
    /// Info" reply. Same authority gate as every other host verb.
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
    match rest.split_once(':') {
        // No verb ⇒ the bare Enter button. The id is the whole remainder.
        None => {
            if rest.is_empty() {
                Action::Unknown
            } else {
                Action::Enter {
                    id: rest.to_string(),
                }
            }
        }
        Some((verb, id)) => {
            let id = id.to_string();
            if id.is_empty() {
                return Action::Unknown;
            }
            match verb {
                "join" => Action::Join { id },
                "leave" => Action::Leave { id },
                "draw" => Action::Draw { id },
                "reroll" => Action::Reroll { id },
                "cancel" => Action::Cancel { id },
                "manage" => Action::Manage { id },
                _ => Action::Unknown,
            }
        }
    }
}

/// Mint a control `custom_id`, e.g. `giveaway:draw:<id>`.
pub fn control_id(verb: &str, id: &str) -> String {
    format!("{PREFIX}{verb}:{id}")
}

/// The bound Enter button's `custom_id`, `giveaway:<id>`.
pub fn enter_id(id: &str) -> String {
    format!("{PREFIX}{id}")
}

// ── host & eligibility decisions (pure) ──────────────────────────────────────

/// Whether the acting member is a host for this giveaway: holding a configured
/// host role, or a server-management permission (Administrator or Manage Server,
/// which always implies it).
pub fn is_host(
    member_roles: &[String],
    member_perms: u64,
    host_roles: &[crate::store::RoleRef],
) -> bool {
    if member_perms & (PERM_ADMINISTRATOR | PERM_MANAGE_GUILD) != 0 {
        return true;
    }
    let hosts: BTreeSet<&str> = host_roles.iter().map(|r| r.id.as_str()).collect();
    member_roles.iter().any(|r| hosts.contains(r.as_str()))
}

/// The account creation time (unix ms) encoded in a snowflake id, or None if the
/// id doesn't parse. Discord packs the ms-since-its-epoch in the high 42 bits.
pub fn snowflake_to_unix_ms(id: &str) -> Option<i64> {
    let raw: u64 = id.parse().ok()?;
    Some((raw >> 22) as i64 + DISCORD_EPOCH_MS)
}

/// Why a member may not enter — each a distinct, actionable case.
#[derive(Debug, PartialEq, Eq)]
pub enum Eligibility {
    Ok,
    /// The giveaway is ended or cancelled (the caller has the status to phrase it).
    Over,
    /// Past the deadline — entries are closed pending the draw.
    EntriesClosed,
    /// The member lacks the required role(s).
    MissingRoles,
    /// The member's account isn't old enough.
    AccountTooNew {
        needed_days: u32,
    },
}

/// Decide whether a member may enter — pure, no I/O. All inputs come from the
/// interaction payload (roles, the user-id snowflake) or stored config, so the
/// whole gate runs without a single Discord call.
pub fn check_eligibility(
    status: Status,
    ends_at: Option<i64>,
    now_ms: i64,
    member_roles: &[String],
    account_created_ms: Option<i64>,
    reqs: &Requirements,
) -> Eligibility {
    if status != Status::Open {
        return Eligibility::Over;
    }
    if let Some(deadline_secs) = ends_at {
        if now_ms / 1000 > deadline_secs {
            return Eligibility::EntriesClosed;
        }
    }
    if !reqs.roles.is_empty() {
        let have: BTreeSet<&str> = member_roles.iter().map(String::as_str).collect();
        let needed = reqs.roles.iter().map(|r| r.id.as_str());
        let ok = if reqs.require_all {
            needed.clone().all(|r| have.contains(r))
        } else {
            needed.clone().any(|r| have.contains(r))
        };
        if !ok {
            return Eligibility::MissingRoles;
        }
    }
    if reqs.min_account_age_days > 0 {
        // If the id didn't parse we can't enforce the floor, so we let them in
        // rather than wall out a real member over a parsing quirk.
        if let Some(created) = account_created_ms {
            let age_days = (now_ms.saturating_sub(created)) / MS_PER_DAY;
            if age_days < reqs.min_account_age_days as i64 {
                return Eligibility::AccountTooNew {
                    needed_days: reqs.min_account_age_days,
                };
            }
        }
    }
    Eligibility::Ok
}

/// A plain-language reason for a [`MissingRoles`](Eligibility::MissingRoles)
/// denial, naming the role(s) as mentions (which render as the role name).
pub fn missing_roles_message(reqs: &Requirements) -> String {
    let mentions: Vec<String> = reqs.roles.iter().map(|r| format!("<@&{}>", r.id)).collect();
    match (reqs.require_all, mentions.as_slice()) {
        (_, [one]) => format!("\u{1F512} You need the {one} role to enter this giveaway."),
        (true, many) => format!(
            "\u{1F512} You need all of these roles to enter: {}.",
            many.join(" ")
        ),
        (false, many) => format!(
            "\u{1F512} You need one of these roles to enter: {}.",
            many.join(" ")
        ),
    }
}

// ── the draw (pure) ──────────────────────────────────────────────────────────

/// Draw up to `n` distinct winners from `pool`, using `pick` as the source of
/// randomness: `pick(bound)` must return an index in `0..bound`. A partial
/// Fisher-Yates shuffle — every entrant is equally likely, no entrant is drawn
/// twice, and the result is exactly `min(n, pool.len())` long. Pure (the
/// randomness is injected), so it is tested both for fairness invariants and,
/// with a deterministic `pick`, for an exact outcome.
#[cfg(test)]
pub fn choose_winners(
    pool: &[String],
    n: usize,
    mut pick: impl FnMut(usize) -> usize,
) -> Vec<String> {
    let mut bag: Vec<String> = pool.to_vec();
    let take = n.min(bag.len());
    for i in 0..take {
        let remaining = bag.len() - i;
        let j = i + (pick(remaining) % remaining);
        bag.swap(i, j);
    }
    bag.truncate(take);
    bag
}

// ── live-count button restyling (pure) ───────────────────────────────────────

/// Strip a trailing ` (123)` count suffix from a button label, so restamping the
/// count never compounds (`Enter (1)` → `Enter (2)`, not `Enter (1) (2)`). Only a
/// purely-numeric parenthesised suffix is removed, so a label that legitimately
/// ends in `(...)` text is left intact.
fn strip_count_suffix(label: &str) -> &str {
    let t = label.trim_end();
    if let Some(open) = t.rfind(" (") {
        if t.ends_with(')') {
            let inner = &t[open + 2..t.len() - 1];
            if !inner.is_empty()
                && inner
                    .chars()
                    .all(|c| c.is_ascii_digit() || c == ',' || c == ' ')
            {
                return t[..open].trim_end();
            }
        }
    }
    t
}

/// A button label with the entrant count appended, e.g. `🎉 Enter (1,234)`.
pub fn label_with_count(label: &str, count: i64) -> String {
    let base = strip_count_suffix(label);
    let out = format!("{base} ({})", commas(count));
    clamp(&out, MAX_LABEL)
}

/// The current label of the button with this `custom_id`, found anywhere in the
/// (possibly Components-V2, deeply nested) component tree.
pub fn find_button_label(components: &Value, custom_id: &str) -> Option<String> {
    fn walk(v: &Value, custom_id: &str) -> Option<String> {
        match v {
            Value::Array(a) => a.iter().find_map(|x| walk(x, custom_id)),
            Value::Object(o) => {
                if o.get("custom_id").and_then(Value::as_str) == Some(custom_id) {
                    return o.get("label").and_then(Value::as_str).map(str::to_string);
                }
                o.values().find_map(|x| walk(x, custom_id))
            }
            _ => None,
        }
    }
    walk(components, custom_id)
}

/// Clone a component tree, restyling the button with this `custom_id`: set its
/// label (when given) and `disabled` flag. Everything else — the user's own
/// message design — is preserved verbatim, which is exactly what lets an
/// `UPDATE_MESSAGE` keep the live count current without flattening their layout.
pub fn restyle_button(
    components: &Value,
    custom_id: &str,
    label: Option<&str>,
    disabled: bool,
) -> Value {
    fn patch(v: &mut Value, custom_id: &str, label: Option<&str>, disabled: bool) {
        match v {
            Value::Array(a) => {
                for item in a.iter_mut() {
                    patch(item, custom_id, label, disabled);
                }
            }
            Value::Object(o) => {
                if o.get("custom_id").and_then(Value::as_str) == Some(custom_id) {
                    if let Some(l) = label {
                        o.insert("label".into(), json!(clamp(l, MAX_LABEL)));
                    }
                    o.insert("disabled".into(), json!(disabled));
                }
                for val in o.values_mut() {
                    patch(val, custom_id, label, disabled);
                }
            }
            _ => {}
        }
    }
    let mut out = components.clone();
    patch(&mut out, custom_id, label, disabled);
    out
}

/// Build an `UPDATE_MESSAGE` that re-renders the host message with the Enter
/// button restyled, preserving the rest of the message (content + V2 layout +
/// flags). None when the message carried no components to edit.
pub fn update_button_response(
    message: &MessageRef,
    custom_id: &str,
    label: Option<&str>,
    disabled: bool,
) -> Option<Value> {
    let components = message.components.as_ref()?;
    let patched = restyle_button(components, custom_id, label, disabled);
    Some(wrap_update(message, patched))
}

/// Wrap a re-rendered component tree as the `UPDATE_MESSAGE` for `message`,
/// preserving its V2 flag / plain content. Every media reference is cleaned to
/// the shape Discord accepts on the way back in (see [`sanitize_media`]), and a
/// V2 message is kept inside the per-message text budget (see
/// [`fit_text_budget`]) — an edit Discord refuses fails the member's click.
fn wrap_update(message: &MessageRef, mut components: Value) -> Value {
    sanitize_media(&mut components);
    let flags = message.flags.unwrap_or(0);
    let v2 = flags & FLAG_IS_COMPONENTS_V2 != 0;
    if v2 {
        fit_text_budget(&mut components, MAX_V2_TEXT);
    }
    let mut data = json!({
        "components": components,
        "allowed_mentions": { "parse": [] },
    });
    if v2 {
        // V2 forbids `content`; the text already lives inside `components`.
        data["flags"] = json!(FLAG_IS_COMPONENTS_V2);
    } else if let Some(content) = message.content.as_deref() {
        // Preserve the plain content so the edit doesn't blank the message body.
        data["content"] = json!(content);
    }
    json!({ "type": RESPONSE_UPDATE_MESSAGE, "data": data })
}

// ── media this service can (and can't) send (pure) ────────────────────────────

const COMPONENT_FILE: u64 = 13;

/// The fields Discord stamps onto every media item it returns. They're
/// output-only: the update endpoints refuse an edit that echoes any of them back
/// (the same list DWEEB strips before re-sending a restored message —
/// `src/core/serialization/attachments.ts`).
const RESOLVED_MEDIA_FIELDS: &[&str] = &[
    "proxy_url",
    "height",
    "width",
    "content_type",
    "loading_state",
    "id",
    "placeholder",
    "placeholder_version",
    "content_scan_metadata",
    "flags",
];

/// Longest file name an error message quotes before eliding the rest.
const MAX_MEDIA_NAME: usize = 80;

/// Whether Discord can fetch this media URL itself.
fn is_sendable_url(url: &str) -> bool {
    ["https://", "http://"].iter().any(|scheme| {
        url.len() > scheme.len()
            && url.as_bytes()[..scheme.len()].eq_ignore_ascii_case(scheme.as_bytes())
    })
}

/// Every picture or file in a stored message template that this service could
/// never send, named the way its author would recognise it. Empty when the
/// whole template can be re-sent.
///
/// The template is captured from DWEEB's editor, where a picture uploaded from
/// the author's computer is a `session://<id>/<name>` handle to a file that
/// lives only in that browser — DWEEB's own Send uploads the bytes, but a
/// re-render from here can't, and Discord refuses the **whole** edit over one
/// media URL it can't fetch, so every click on the giveaway would fail. Only an
/// `http(s)://` link is sendable, and a File component never is: it can only
/// show an attachment uploaded *with* a message.
pub fn unsendable_media(template: &Value) -> Vec<String> {
    fn walk(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::Array(a) => a.iter().for_each(|x| walk(x, out)),
            Value::Object(o) => {
                if o.get("type").and_then(Value::as_u64) == Some(COMPONENT_FILE) {
                    out.push(describe_media(o.get("file")));
                } else if let Some(media) = o.get("media") {
                    let url = media.get("url").and_then(Value::as_str).unwrap_or("");
                    if !is_sendable_url(url) {
                        out.push(describe_media(Some(media)));
                    }
                }
                o.values().for_each(|x| walk(x, out));
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(template, &mut out);
    out
}

/// What to call an unsendable picture in a message to its author: the name of
/// the file they uploaded (`session://<id>/<name>`, `attachment://<name>`), else
/// the reference exactly as written.
fn describe_media(media: Option<&Value>) -> String {
    let url = media
        .and_then(|m| m.get("url"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if url.is_empty() {
        return "a picture with no link".to_string();
    }
    let name = url
        .strip_prefix("session://")
        .and_then(|rest| rest.split_once('/').map(|(_, name)| name))
        .or_else(|| url.strip_prefix("attachment://"))
        .filter(|name| !name.is_empty())
        .unwrap_or(url);
    if name.chars().count() > MAX_MEDIA_NAME {
        let mut short: String = name.chars().take(MAX_MEDIA_NAME).collect();
        short.push('…');
        short
    } else {
        name.to_string()
    }
}

/// Clean every `media` / `file` object in an outgoing component tree to the
/// shape Discord accepts on an edit: drop the resolved output-only fields, and
/// keep exactly one reference — a concrete `url` (Discord re-resolves it) in
/// preference to the `attachment_id` a fetched message carries beside it.
fn sanitize_media(tree: &mut Value) {
    match tree {
        Value::Array(a) => a.iter_mut().for_each(sanitize_media),
        Value::Object(o) => {
            for key in ["media", "file"] {
                if let Some(Value::Object(media)) = o.get_mut(key) {
                    clean_media_object(media);
                }
            }
            o.values_mut().for_each(sanitize_media);
        }
        _ => {}
    }
}

fn clean_media_object(media: &mut Map<String, Value>) {
    for field in RESOLVED_MEDIA_FIELDS {
        media.remove(*field);
    }
    let has_url = media
        .get("url")
        .and_then(Value::as_str)
        .is_some_and(|u| !u.is_empty());
    if has_url {
        media.remove("attachment_id");
    } else {
        media.remove("url");
        let has_attachment = media
            .get("attachment_id")
            .and_then(Value::as_str)
            .is_some_and(|a| !a.is_empty());
        if !has_attachment {
            media.remove("attachment_id");
        }
    }
}

// ── the V2 text budget (pure) ────────────────────────────────────────────────

/// Text the V2 budget counts, in UTF-16 code units (how DWEEB counts Discord's
/// limits): every text display `content`, button / option `label`, option
/// `description` and select `placeholder` in the tree.
fn text_units(v: &Value) -> usize {
    match v {
        Value::Array(a) => a.iter().map(text_units).sum(),
        Value::Object(o) => o
            .iter()
            .map(|(k, val)| match (k.as_str(), val) {
                ("content" | "label" | "description" | "placeholder", Value::String(s)) => {
                    s.encode_utf16().count()
                }
                _ => text_units(val),
            })
            .sum(),
        _ => 0,
    }
}

/// Keep a re-rendered V2 message inside Discord's per-message text budget.
///
/// DWEEB validates the template against short placeholder samples, but
/// `{winners}` expands to up to twenty mentions after a draw — a message near
/// the limit then goes over it, Discord refuses the edit, and every click on the
/// giveaway fails. Trimming the longest text display (where the expansion
/// almost always landed) keeps the message editable.
fn fit_text_budget(tree: &mut Value, budget: usize) {
    let total = text_units(tree);
    if total <= budget {
        return;
    }
    let mut excess = total - budget;
    let mut contents = Vec::new();
    content_pointers(tree, &mut String::new(), &mut contents);
    contents.sort_by_key(|c| std::cmp::Reverse(c.1));
    for (pointer, len) in contents {
        if excess == 0 {
            break;
        }
        let Some(Value::String(text)) = tree.pointer_mut(&pointer) else {
            continue;
        };
        // Keep `keep` units plus a one-unit ellipsis, removing at least `excess`.
        let keep = len.saturating_sub(excess + 1);
        let mut kept = String::new();
        let mut units = 0;
        for c in text.chars() {
            if units + c.len_utf16() > keep {
                break;
            }
            units += c.len_utf16();
            kept.push(c);
        }
        kept.push('…');
        excess = excess.saturating_sub(len.saturating_sub(units + 1));
        *text = kept;
    }
}

/// RFC 6901 pointers to every text display `content` string, with its length in
/// UTF-16 units.
fn content_pointers(v: &Value, path: &mut String, out: &mut Vec<(String, usize)>) {
    match v {
        Value::Array(a) => {
            for (i, item) in a.iter().enumerate() {
                let len = path.len();
                path.push('/');
                path.push_str(&i.to_string());
                content_pointers(item, path, out);
                path.truncate(len);
            }
        }
        Value::Object(o) => {
            for (k, val) in o {
                let len = path.len();
                path.push('/');
                path.push_str(&escape_pointer(k));
                if let ("content", Value::String(s)) = (k.as_str(), val) {
                    out.push((path.clone(), s.encode_utf16().count()));
                } else {
                    content_pointers(val, path, out);
                }
                path.truncate(len);
            }
        }
        _ => {}
    }
}

fn escape_pointer(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

/// RFC 6901 pointer to the first object (depth-first, in the same order the
/// patchers below walk) that satisfies `pred`.
fn find_pointer(tree: &Value, pred: &dyn Fn(&Map<String, Value>) -> bool) -> Option<String> {
    fn walk(v: &Value, path: &mut String, pred: &dyn Fn(&Map<String, Value>) -> bool) -> bool {
        match v {
            Value::Array(a) => {
                for (i, item) in a.iter().enumerate() {
                    let len = path.len();
                    path.push('/');
                    path.push_str(&i.to_string());
                    if walk(item, path, pred) {
                        return true;
                    }
                    path.truncate(len);
                }
                false
            }
            Value::Object(o) => {
                if pred(o) {
                    return true;
                }
                for (k, val) in o {
                    let len = path.len();
                    path.push('/');
                    path.push_str(&escape_pointer(k));
                    if walk(val, path, pred) {
                        return true;
                    }
                    path.truncate(len);
                }
                false
            }
            _ => false,
        }
    }
    let mut path = String::new();
    walk(tree, &mut path, pred).then_some(path)
}

// ── message placeholders (pure) ──────────────────────────────────────────────
//
// The host message can carry `{token}` placeholders the giveaway fills in: the
// live entrant count, the prize, the winners once drawn, the status. DWEEB paints
// the first values at send time; from then on only THIS service can keep the
// (webhook-authored) message current, by re-rendering its stored template on each
// click and replying `UPDATE_MESSAGE`. Re-rendering from the raw-token *template*
// (never from the already-rendered message) is what makes it idempotent — the
// count restamps and `{winners}` flips to mentions on the next click after a draw.

/// The live values a giveaway message's placeholders resolve to right now. Built
/// from the stored config plus the current count / winners / status.
pub struct RenderVars {
    pub prize: String,
    pub entries: i64,
    pub winner_count: u32,
    /// Drawn winners' user ids (empty until a draw → `{winners}` renders `TBD`).
    pub winners: Vec<String>,
    pub status: Status,
    pub host_user_id: Option<String>,
}

impl RenderVars {
    /// Resolve one token to its rendered string, or `None` for a token this
    /// plugin doesn't own (left verbatim by [`substitute`], so a stray `{foo}` in
    /// prose survives untouched). Mirrors the DWEEB manifest's declared set.
    fn value_of(&self, token: &str) -> Option<String> {
        Some(match token {
            "prize" => self.prize.clone(),
            "entries" => commas(self.entries),
            "winner_count" => self.winner_count.to_string(),
            "winners" => {
                if self.winners.is_empty() {
                    "TBD".to_string()
                } else {
                    join_mentions(&self.winners)
                }
            }
            "status" => status_label(self.status).to_string(),
            // A `<@id>` mention renders as the host's name; empty when unset.
            "host" => match &self.host_user_id {
                Some(id) => format!("<@{id}>"),
                None => String::new(),
            },
            _ => return None,
        })
    }
}

fn status_label(status: Status) -> &'static str {
    match status {
        Status::Open => "open",
        Status::Ended => "ended",
        Status::Cancelled => "cancelled",
    }
}

/// Replace every known `{token}` in `text` with its value; an unknown or
/// malformed `{…}` is left exactly as written. Pure.
pub fn substitute(text: &str, vars: &RenderVars) -> String {
    substitute_with(text, |token| vars.value_of(token))
}

/// Token substitution with an injected resolver — the shared core so the public
/// announcement and the in-message render agree on `{token}` syntax to the byte.
/// Scans on the ASCII `{`/`}` delimiters, so it never splits a multi-byte char.
fn substitute_with(text: &str, mut resolve: impl FnMut(&str) -> Option<String>) -> String {
    if !text.contains('{') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        if let Some(close) = after.find('}') {
            let token = &after[..close];
            if is_token(token) {
                if let Some(value) = resolve(token) {
                    out.push_str(&value);
                    rest = &after[close + 1..];
                    continue;
                }
            }
        }
        // Not a substitutable token: emit the `{` literally and keep scanning.
        out.push('{');
        rest = after;
    }
    out.push_str(rest);
    out
}

/// A placeholder token: `[a-z0-9_]{1,32}`, matching DWEEB's `PLACEHOLDER_TOKEN_RE`.
fn is_token(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// Render the bound giveaway message from its stored `template` (the host's own
/// message, captured with raw `{tokens}`): substitute every Text Display content
/// and button label, then restyle the Enter button (label + `disabled`, and pin
/// its `custom_id` to `enter_id`). `live` is the component tree of the message
/// as Discord echoed it, used to find the Enter button in a template captured
/// before DWEEB bound it (see [`enter_pointer`]). Returns the component tree for
/// an `UPDATE_MESSAGE`. Pure — the template is cloned, never mutated.
pub fn render_bound_message(
    template: &Value,
    vars: &RenderVars,
    enter_id: &str,
    enter_label: Option<&str>,
    disabled: bool,
    live: Option<&Value>,
) -> Value {
    let target = enter_pointer(template, live, enter_id);
    let mut out = template.clone();
    substitute_tree(&mut out, vars);
    // Patch the Enter button last so its computed label (live count / "ended")
    // wins over any substitution done to it above. Substitution only rewrites
    // strings, so a pointer resolved on the raw template still addresses the
    // same node here.
    if !patch_button_with_id(&mut out, enter_id, enter_id, enter_label, disabled) {
        if let Some(Value::Object(o)) = target.as_deref().and_then(|p| out.pointer_mut(p)) {
            apply_button(o, enter_id, enter_label, disabled);
        }
    }
    out
}

/// Where the giveaway's Enter button sits in a (raw) template: the button that
/// already carries `enter_id`; else — a template captured on first save, before
/// DWEEB bound the button — the template node at the place the bound button
/// sits in the `live` message; else the first interactive button. Resolving by
/// position is what keeps another plugin's button that happens to come first
/// (a Rules reply beside Enter) from being taken over, relabelled, and unbound.
fn enter_pointer(template: &Value, live: Option<&Value>, enter_id: &str) -> Option<String> {
    let has_id =
        |o: &Map<String, Value>| o.get("custom_id").and_then(Value::as_str) == Some(enter_id);
    if let Some(p) = find_pointer(template, &has_id) {
        return Some(p);
    }
    if let Some(p) = live.and_then(|l| find_pointer(l, &has_id)) {
        let same_place_is_a_button = template
            .pointer(&p)
            .and_then(Value::as_object)
            .is_some_and(is_interactive_button);
        if same_place_is_a_button {
            return Some(p);
        }
    }
    find_pointer(template, &|o| is_interactive_button(o))
}

/// Walk a component tree, substituting placeholders in the two user-text fields:
/// Text Display `content` and button `label`. Generic descent keeps it correct as
/// the layout nests (containers, sections, action rows).
fn substitute_tree(v: &mut Value, vars: &RenderVars) {
    match v {
        Value::Array(a) => {
            for item in a.iter_mut() {
                substitute_tree(item, vars);
            }
        }
        Value::Object(o) => {
            // Compute first (ends the immutable borrow) then write.
            if let Some(content) = o
                .get("content")
                .and_then(Value::as_str)
                .map(|s| substitute(s, vars))
            {
                o.insert("content".into(), Value::String(content));
            }
            if let Some(label) = o
                .get("label")
                .and_then(Value::as_str)
                .map(|s| substitute(s, vars))
            {
                o.insert("label".into(), Value::String(label));
            }
            for val in o.values_mut() {
                substitute_tree(val, vars);
            }
        }
        _ => {}
    }
}

/// The label of the giveaway's Enter button in a (raw) template — the same
/// button [`render_bound_message`] restyles (see [`enter_pointer`]) — so the
/// live count is appended to the host's own wording for *that* button, never a
/// neighbour's. None when the template carries no interactive button.
pub fn enter_button_label(
    template: &Value,
    live: Option<&Value>,
    enter_id: &str,
) -> Option<String> {
    let pointer = enter_pointer(template, live, enter_id)?;
    let node = template.pointer(&pointer)?;
    Some(
        node.get("label")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    )
}

/// Patch every button whose `custom_id == match_id` to `new_id` + label/disabled.
/// Returns whether any matched.
fn patch_button_with_id(
    tree: &mut Value,
    match_id: &str,
    new_id: &str,
    label: Option<&str>,
    disabled: bool,
) -> bool {
    fn walk(
        v: &mut Value,
        match_id: &str,
        new_id: &str,
        label: Option<&str>,
        disabled: bool,
        hit: &mut bool,
    ) {
        match v {
            Value::Array(a) => {
                for item in a.iter_mut() {
                    walk(item, match_id, new_id, label, disabled, hit);
                }
            }
            Value::Object(o) => {
                if o.get("custom_id").and_then(Value::as_str) == Some(match_id) {
                    apply_button(o, new_id, label, disabled);
                    *hit = true;
                }
                for val in o.values_mut() {
                    walk(val, match_id, new_id, label, disabled, hit);
                }
            }
            _ => {}
        }
    }
    let mut hit = false;
    walk(tree, match_id, new_id, label, disabled, &mut hit);
    hit
}

/// An object that is an interactive button (type 2 carrying a `custom_id` — not a
/// Link/Premium button, which have none).
fn is_interactive_button(o: &Map<String, Value>) -> bool {
    o.get("type").and_then(Value::as_u64) == Some(COMPONENT_TYPE_BUTTON as u64)
        && o.contains_key("custom_id")
}

fn apply_button(o: &mut Map<String, Value>, custom_id: &str, label: Option<&str>, disabled: bool) {
    o.insert("custom_id".into(), json!(custom_id));
    if let Some(l) = label {
        o.insert("label".into(), json!(clamp(l, MAX_LABEL)));
    }
    o.insert("disabled".into(), json!(disabled));
}

/// Build the `UPDATE_MESSAGE` that re-renders the bound message from `template`
/// with current `vars`. Preserves the live message's V2 flag / plain content
/// exactly like [`update_button_response`]. `allowed_mentions.parse = []` so a
/// re-render can't ping `@everyone` and winners render as names without
/// re-notifying (the public announcement already pinged them).
pub fn update_message_from_template(
    message: &MessageRef,
    template: &Value,
    vars: &RenderVars,
    enter_id: &str,
    enter_label: Option<&str>,
    disabled: bool,
) -> Value {
    let components = render_bound_message(
        template,
        vars,
        enter_id,
        enter_label,
        disabled,
        message.components.as_ref(),
    );
    wrap_update(message, components)
}

// ── outgoing callbacks (pure) ────────────────────────────────────────────────

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

/// An ephemeral message carrying buttons (a plain-content message, not V2, so it
/// can hold both `content` and a classic action row of controls).
fn ephemeral_with_buttons(content: &str, buttons: Vec<Value>) -> Value {
    let mut data = json!({
        "flags": FLAG_EPHEMERAL,
        "content": clamp(content, MAX_CONTENT),
        "allowed_mentions": { "parse": [] },
    });
    if !buttons.is_empty() {
        data["components"] = json!([{ "type": COMPONENT_ACTION_ROW, "components": buttons }]);
    }
    json!({ "type": RESPONSE_CHANNEL_MESSAGE, "data": data })
}

fn button(style: u8, label: &str, custom_id: String) -> Value {
    json!({ "type": COMPONENT_TYPE_BUTTON, "style": style, "label": label, "custom_id": custom_id })
}

/// The status shown to a member who clicks Enter while already entered: a
/// confirmation plus a Leave button. Reassures the "did it work?" re-clicker and
/// lets them withdraw.
pub fn already_in_panel(id: &str, count: i64) -> Value {
    ephemeral_with_buttons(
        &format!(
            "\u{2705} You're already entered \u{2014} you're 1 of **{}**. Good luck! \u{1F340}",
            commas(count)
        ),
        vec![button(
            BUTTON_DANGER,
            "Leave giveaway",
            control_id("leave", id),
        )],
    )
}

/// The notice after a member leaves. Built the same (non-V2) way as
/// [`already_in_panel`] so it can replace that panel *in place* via an
/// `UPDATE_MESSAGE` — Discord rejects switching a message between V2 and non-V2
/// on edit, so both ends of that edit must be plain-content messages.
pub fn left_notice() -> Value {
    ephemeral_with_buttons(
        "\u{1F44B} You've left the giveaway. Click **Enter** on the message to rejoin.",
        vec![],
    )
}

/// The host control panel (ephemeral), shown when a Manage-Server holder (or a
/// configured host role) clicks Enter. Adapts to the giveaway's status.
pub fn host_panel(
    id: &str,
    status: Status,
    entered: bool,
    entry_count: i64,
    winner_count: usize,
) -> Value {
    match status {
        Status::Open => {
            let join = if entered {
                button(
                    BUTTON_SECONDARY,
                    "Leave as participant",
                    control_id("leave", id),
                )
            } else {
                button(
                    BUTTON_SECONDARY,
                    "Enter as participant",
                    control_id("join", id),
                )
            };
            ephemeral_with_buttons(
                &format!(
                    "\u{1F6E0}\u{FE0F} **Host controls** \u{2014} you manage this server.\n**{}** entered so far. Draw whenever you're ready.",
                    commas(entry_count)
                ),
                vec![
                    join,
                    button(BUTTON_SUCCESS, "\u{1F389} Draw winners", control_id("draw", id)),
                    button(BUTTON_DANGER, "Cancel giveaway", control_id("cancel", id)),
                ],
            )
        }
        Status::Ended => ephemeral_with_buttons(
            &format!(
                "\u{1F3C1} **This giveaway has ended.** {} drawn. You can reroll for a fresh pick.",
                if winner_count == 1 {
                    "1 winner".to_string()
                } else {
                    format!("{winner_count} winners")
                }
            ),
            vec![button(
                BUTTON_PRIMARY,
                "\u{1F501} Reroll",
                control_id("reroll", id),
            )],
        ),
        // Plain content like the other two states, never V2: a host's Leave or
        // Cancel replaces the panel in place, and Discord refuses an edit that
        // switches a message between V2 and non-V2.
        Status::Cancelled => ephemeral_with_buttons(
            "\u{274C} This giveaway was cancelled \u{2014} there's nothing left to manage.",
            vec![],
        ),
    }
}

/// The public winner announcement (a non-ephemeral interaction response, so it
/// posts in the channel with **no bot token**). Pings only the winners. A custom
/// template runs through the same [`substitute`] as the in-message placeholders,
/// so `{winners}`, `{prize}`, `{entries}`, `{status}` … all work here too.
pub fn announcement_message(vars: &RenderVars, rerolled: bool, custom: Option<&str>) -> Value {
    let text = match custom.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => {
            let body = substitute(t, vars);
            if rerolled {
                format!("\u{1F501} **Reroll!** {body}")
            } else {
                body
            }
        }
        None => default_announcement(
            &vars.prize,
            &join_mentions(&vars.winners),
            rerolled,
            vars.winners.len(),
        ),
    };
    json!({
        "type": RESPONSE_CHANNEL_MESSAGE,
        "data": {
            "content": clamp(&text, MAX_CONTENT),
            "allowed_mentions": { "parse": [], "users": vars.winners },
        }
    })
}

fn default_announcement(prize: &str, mentions: &str, rerolled: bool, n: usize) -> String {
    let winner_word = if n == 1 { "winner" } else { "winners" };
    if rerolled {
        format!("\u{1F501} **Reroll!** The new {winner_word}: {mentions} \u{2014} you won **{prize}**! \u{1F389}")
    } else {
        format!(
            "\u{1F389} **Giveaway ended!**\nCongratulations {mentions} \u{2014} you won **{prize}**! \u{1F38A}"
        )
    }
}

/// The DM body sent to a winner (best-effort, when DMs are enabled).
pub fn winner_dm_content(prize: &str) -> String {
    clamp(
        &format!("\u{1F389} You won **{prize}**! Congratulations \u{2014} head back to the channel to claim it."),
        MAX_CONTENT,
    )
}

// ── small formatting helpers (pure) ──────────────────────────────────────────

/// Join user ids as Discord mentions: `<@a>`, `<@a> and <@b>`, `<@a>, <@b> and <@c>`.
pub fn join_mentions(ids: &[String]) -> String {
    let m: Vec<String> = ids.iter().map(|id| format!("<@{id}>")).collect();
    match m.as_slice() {
        [] => "no one".to_string(),
        [a] => a.clone(),
        [a, b] => format!("{a} and {b}"),
        [rest @ .., last] => format!("{} and {}", rest.join(", "), last),
    }
}

/// Group an integer with thousands separators (`1234` → `1,234`).
fn commas(n: i64) -> String {
    let neg = n < 0;
    let digits = n.unsigned_abs().to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    let bytes = digits.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 && (bytes.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(*b as char);
    }
    if neg {
        format!("-{out}")
    } else {
        out
    }
}

/// Truncate to at most `max` characters (respecting char boundaries).
fn clamp(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::RoleRef;

    fn roles(ids: &[&str]) -> Vec<RoleRef> {
        ids.iter()
            .map(|id| RoleRef {
                id: id.to_string(),
                name: format!("Role {id}"),
                color: 0,
            })
            .collect()
    }
    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    // ── custom_id routing ───────────────────────────────────────────────────
    #[test]
    fn parse_action_reads_the_bare_enter_button() {
        assert_eq!(
            parse_action("giveaway:abc123"),
            Action::Enter {
                id: "abc123".into()
            }
        );
    }

    #[test]
    fn parse_action_reads_the_host_controls() {
        assert_eq!(
            parse_action("giveaway:draw:abc"),
            Action::Draw { id: "abc".into() }
        );
        assert_eq!(
            parse_action("giveaway:reroll:abc"),
            Action::Reroll { id: "abc".into() }
        );
        assert_eq!(
            parse_action("giveaway:cancel:abc"),
            Action::Cancel { id: "abc".into() }
        );
        assert_eq!(
            parse_action("giveaway:join:abc"),
            Action::Join { id: "abc".into() }
        );
        assert_eq!(
            parse_action("giveaway:leave:abc"),
            Action::Leave { id: "abc".into() }
        );
        // The dispatcher's Message Info manage button.
        assert_eq!(
            parse_action("giveaway:manage:abc"),
            Action::Manage { id: "abc".into() }
        );
    }

    #[test]
    fn parse_action_rejects_foreign_or_empty() {
        assert_eq!(parse_action("other:abc"), Action::Unknown);
        assert_eq!(parse_action("giveaway:"), Action::Unknown);
        assert_eq!(parse_action("giveaway:draw:"), Action::Unknown);
        assert_eq!(parse_action("giveaway:bogus:abc"), Action::Unknown);
        assert_eq!(parse_action(""), Action::Unknown);
    }

    #[test]
    fn enter_id_round_trips_through_parse() {
        let id = "deadbeef";
        assert_eq!(parse_action(&enter_id(id)), Action::Enter { id: id.into() });
    }

    // ── host check ──────────────────────────────────────────────────────────
    #[test]
    fn host_by_role_or_management_permission() {
        let hosts = roles(&["100"]);
        assert!(is_host(&ids(&["100"]), 0, &hosts)); // configured host role
        assert!(!is_host(&ids(&["999"]), 0, &hosts)); // unrelated role, no perms
        assert!(is_host(&[], PERM_ADMINISTRATOR, &hosts)); // admin always host
        assert!(is_host(&[], PERM_MANAGE_GUILD, &hosts)); // manage server too
        assert!(!is_host(&[], 0, &hosts)); // a plain member is not a host
    }

    // ── snowflake → account age ─────────────────────────────────────────────
    #[test]
    fn snowflake_decodes_creation_time() {
        // The first snowflake (timestamp 0) is exactly the Discord epoch.
        assert_eq!(snowflake_to_unix_ms("0"), Some(DISCORD_EPOCH_MS));
        // A known id: (id >> 22) + epoch.
        let id = "175928847299117063"; // documented Discord example
        let expected = (175928847299117063u64 >> 22) as i64 + DISCORD_EPOCH_MS;
        assert_eq!(snowflake_to_unix_ms(id), Some(expected));
        assert_eq!(snowflake_to_unix_ms("not-a-number"), None);
    }

    // ── eligibility ─────────────────────────────────────────────────────────
    fn reqs_role_any(ids_: &[&str]) -> Requirements {
        Requirements {
            roles: roles(ids_),
            require_all: false,
            min_account_age_days: 0,
        }
    }

    #[test]
    fn open_giveaway_with_no_requirements_admits_anyone() {
        let r = Requirements::default();
        assert_eq!(
            check_eligibility(Status::Open, None, 0, &[], None, &r),
            Eligibility::Ok
        );
    }

    #[test]
    fn ended_or_cancelled_is_over() {
        let r = Requirements::default();
        assert_eq!(
            check_eligibility(Status::Ended, None, 0, &[], None, &r),
            Eligibility::Over
        );
        assert_eq!(
            check_eligibility(Status::Cancelled, None, 0, &[], None, &r),
            Eligibility::Over
        );
    }

    #[test]
    fn past_the_deadline_closes_entries() {
        let r = Requirements::default();
        // now (ms) is one second past the deadline (secs).
        let now_ms = 2_000_000;
        let deadline = now_ms / 1000 - 1;
        assert_eq!(
            check_eligibility(Status::Open, Some(deadline), now_ms, &[], None, &r),
            Eligibility::EntriesClosed
        );
        // Before the deadline: still open.
        assert_eq!(
            check_eligibility(
                Status::Open,
                Some(now_ms / 1000 + 100),
                now_ms,
                &[],
                None,
                &r
            ),
            Eligibility::Ok
        );
    }

    #[test]
    fn role_requirement_any_vs_all() {
        let any = reqs_role_any(&["a", "b"]);
        assert_eq!(
            check_eligibility(Status::Open, None, 0, &ids(&["b"]), None, &any),
            Eligibility::Ok
        );
        assert_eq!(
            check_eligibility(Status::Open, None, 0, &ids(&["z"]), None, &any),
            Eligibility::MissingRoles
        );
        let all = Requirements {
            roles: roles(&["a", "b"]),
            require_all: true,
            min_account_age_days: 0,
        };
        assert_eq!(
            check_eligibility(Status::Open, None, 0, &ids(&["a"]), None, &all),
            Eligibility::MissingRoles
        );
        assert_eq!(
            check_eligibility(Status::Open, None, 0, &ids(&["a", "b"]), None, &all),
            Eligibility::Ok
        );
    }

    #[test]
    fn account_age_floor_blocks_new_accounts() {
        let r = Requirements {
            roles: vec![],
            require_all: false,
            min_account_age_days: 7,
        };
        let now = 100 * MS_PER_DAY;
        // Created 3 days ago → too new.
        assert_eq!(
            check_eligibility(Status::Open, None, now, &[], Some(now - 3 * MS_PER_DAY), &r),
            Eligibility::AccountTooNew { needed_days: 7 }
        );
        // Created 30 days ago → fine.
        assert_eq!(
            check_eligibility(
                Status::Open,
                None,
                now,
                &[],
                Some(now - 30 * MS_PER_DAY),
                &r
            ),
            Eligibility::Ok
        );
        // Unparseable creation time can't be enforced → admitted, not walled out.
        assert_eq!(
            check_eligibility(Status::Open, None, now, &[], None, &r),
            Eligibility::Ok
        );
    }

    #[test]
    fn missing_roles_message_names_the_roles() {
        assert!(missing_roles_message(&reqs_role_any(&["1"])).contains("<@&1>"));
        let m = missing_roles_message(&reqs_role_any(&["1", "2"]));
        assert!(m.contains("one of") && m.contains("<@&1>") && m.contains("<@&2>"));
        let all = Requirements {
            roles: roles(&["1", "2"]),
            require_all: true,
            min_account_age_days: 0,
        };
        assert!(missing_roles_message(&all).contains("all of"));
    }

    // ── the draw ────────────────────────────────────────────────────────────
    #[test]
    fn choose_winners_is_deterministic_with_a_fixed_pick() {
        let pool = ids(&["a", "b", "c", "d"]);
        // pick always returns 0 ⇒ Fisher-Yates takes element i each step ⇒ order
        // preserved.
        let w = choose_winners(&pool, 2, |_| 0);
        assert_eq!(w, ids(&["a", "b"]));
    }

    #[test]
    fn choose_winners_respects_count_and_pool_bounds() {
        let pool = ids(&["a", "b", "c"]);
        assert_eq!(choose_winners(&pool, 0, |_| 0).len(), 0);
        assert_eq!(choose_winners(&pool, 2, |_| 0).len(), 2);
        // Asking for more than exist returns everyone, once.
        let all = choose_winners(&pool, 99, |_| 0);
        assert_eq!(all.len(), 3);
        let set: BTreeSet<_> = all.iter().collect();
        assert_eq!(set.len(), 3);
        // Empty pool yields nothing, never panics.
        assert!(choose_winners(&[], 3, |_| 0).is_empty());
    }

    #[test]
    fn choose_winners_never_repeats_an_entrant() {
        let pool = ids(&["a", "b", "c", "d", "e"]);
        // A varied pick sequence; result must still be distinct and a subset.
        let mut seq = [3usize, 1, 4, 0, 2].into_iter().cycle();
        let w = choose_winners(&pool, 4, |bound| seq.next().unwrap() % bound);
        let set: BTreeSet<_> = w.iter().collect();
        assert_eq!(set.len(), w.len());
        assert!(w.iter().all(|x| pool.contains(x)));
    }

    // ── live count / button restyle ─────────────────────────────────────────
    #[test]
    fn label_with_count_appends_and_never_compounds() {
        assert_eq!(label_with_count("🎉 Enter", 5), "🎉 Enter (5)");
        // Re-stamping replaces, not appends.
        assert_eq!(label_with_count("🎉 Enter (5)", 6), "🎉 Enter (6)");
        // Thousands separator.
        assert_eq!(label_with_count("Enter", 1234), "Enter (1,234)");
        // A legitimate non-numeric "(...)" suffix is preserved.
        assert_eq!(label_with_count("Enter (now)", 2), "Enter (now) (2)");
    }

    #[test]
    fn restyle_button_finds_a_nested_button_and_preserves_siblings() {
        // A Components-V2-ish tree: a container holding an action row + button,
        // plus an unrelated text display that must survive untouched.
        let tree = json!([
            { "type": 17, "components": [
                { "type": 10, "content": "Win a prize!" },
                { "type": 1, "components": [
                    { "type": 2, "style": 3, "label": "🎉 Enter", "custom_id": "giveaway:xyz" }
                ]}
            ]}
        ]);
        assert_eq!(
            find_button_label(&tree, "giveaway:xyz").as_deref(),
            Some("🎉 Enter")
        );
        let out = restyle_button(&tree, "giveaway:xyz", Some("🎉 Enter (3)"), false);
        // The text display is preserved verbatim.
        assert_eq!(out[0]["components"][0]["content"], "Win a prize!");
        // The button got the new label + an explicit (false) disabled flag.
        let btn = &out[0]["components"][1]["components"][0];
        assert_eq!(btn["label"], "🎉 Enter (3)");
        assert_eq!(btn["disabled"], false);
        // A non-matching custom_id leaves the tree alone.
        let untouched = restyle_button(&tree, "giveaway:nope", Some("x"), true);
        assert_eq!(
            untouched[0]["components"][1]["components"][0]["label"],
            "🎉 Enter"
        );
    }

    #[test]
    fn update_button_response_preserves_v2_flag_and_drops_content() {
        let msg = MessageRef {
            content: Some("".into()),
            components: Some(json!([
                { "type": 1, "components": [
                    { "type": 2, "style": 3, "label": "Enter", "custom_id": "giveaway:xyz" }
                ]}
            ])),
            flags: Some(FLAG_IS_COMPONENTS_V2),
        };
        let v = update_button_response(&msg, "giveaway:xyz", Some("Enter (1)"), false).unwrap();
        assert_eq!(v["type"], RESPONSE_UPDATE_MESSAGE);
        assert_eq!(v["data"]["flags"], FLAG_IS_COMPONENTS_V2);
        assert!(v["data"].get("content").is_none()); // V2 forbids content
        assert_eq!(
            v["data"]["components"][0]["components"][0]["label"],
            "Enter (1)"
        );
    }

    #[test]
    fn update_button_response_keeps_plain_content() {
        let msg = MessageRef {
            content: Some("Giveaway!".into()),
            components: Some(json!([
                { "type": 1, "components": [
                    { "type": 2, "style": 3, "label": "Enter", "custom_id": "giveaway:xyz" }
                ]}
            ])),
            flags: Some(0),
        };
        let v = update_button_response(&msg, "giveaway:xyz", None, true).unwrap();
        assert_eq!(v["data"]["content"], "Giveaway!");
        assert_eq!(
            v["data"]["components"][0]["components"][0]["disabled"],
            true
        );
    }

    #[test]
    fn update_button_response_is_none_without_components() {
        let msg = MessageRef {
            content: Some("hi".into()),
            components: None,
            flags: None,
        };
        assert!(update_button_response(&msg, "giveaway:xyz", None, false).is_none());
    }

    // ── announcement ────────────────────────────────────────────────────────
    fn ann_text(v: &Value) -> String {
        v["data"]["content"].as_str().unwrap().to_string()
    }

    /// A `RenderVars` for tests: ended giveaway for `prize` with these winners.
    fn vars(prize: &str, winners: &[&str]) -> RenderVars {
        RenderVars {
            prize: prize.to_string(),
            entries: winners.len() as i64,
            winner_count: winners.len().max(1) as u32,
            winners: ids(winners),
            status: Status::Ended,
            host_user_id: None,
        }
    }

    #[test]
    fn announcement_pings_only_winners_and_names_the_prize() {
        let v = announcement_message(&vars("Nitro", &["1", "2"]), false, None);
        let text = ann_text(&v);
        assert!(text.contains("<@1>") && text.contains("<@2>") && text.contains("**Nitro**"));
        // allowed_mentions pings the two winners, nothing else.
        assert_eq!(
            v["data"]["allowed_mentions"]["users"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            v["data"]["allowed_mentions"]["parse"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn announcement_reroll_says_so() {
        let v = announcement_message(&vars("Nitro", &["1"]), true, None);
        assert!(ann_text(&v).to_lowercase().contains("reroll"));
    }

    #[test]
    fn announcement_custom_template_substitutes_placeholders() {
        let v = announcement_message(
            &vars("Nitro", &["1"]),
            false,
            Some("GG {winners}, enjoy {prize}!"),
        );
        let text = ann_text(&v);
        assert!(text.contains("GG <@1>, enjoy Nitro!"));
    }

    #[test]
    fn join_mentions_reads_naturally() {
        assert_eq!(join_mentions(&[]), "no one");
        assert_eq!(join_mentions(&ids(&["1"])), "<@1>");
        assert_eq!(join_mentions(&ids(&["1", "2"])), "<@1> and <@2>");
        assert_eq!(join_mentions(&ids(&["1", "2", "3"])), "<@1>, <@2> and <@3>");
    }

    #[test]
    fn commas_groups_thousands() {
        assert_eq!(commas(0), "0");
        assert_eq!(commas(999), "999");
        assert_eq!(commas(1234), "1,234");
        assert_eq!(commas(1234567), "1,234,567");
    }

    // ── message placeholders ─────────────────────────────────────────────────
    fn open_vars(prize: &str, entries: i64) -> RenderVars {
        RenderVars {
            prize: prize.to_string(),
            entries,
            winner_count: 2,
            winners: vec![],
            status: Status::Open,
            host_user_id: Some("99".to_string()),
        }
    }

    #[test]
    fn substitute_resolves_known_tokens_and_keeps_unknown() {
        let v = open_vars("Nitro", 1234);
        assert_eq!(
            substitute(
                "Win {prize} · {entries} in · {winner_count} winner(s) · {status}",
                &v
            ),
            "Win Nitro · 1,234 in · 2 winner(s) · open"
        );
        // Host renders as a mention; an unknown token is left verbatim.
        assert_eq!(substitute("by {host} {unknown}", &v), "by <@99> {unknown}");
        // A malformed brace run is left alone (no token inside).
        assert_eq!(substitute("a { b } c", &v), "a { b } c");
    }

    #[test]
    fn winners_token_is_tbd_until_drawn_then_mentions() {
        let mut v = open_vars("Nitro", 3);
        assert_eq!(substitute("Winners: {winners}", &v), "Winners: TBD");
        v.winners = ids(&["1", "2"]);
        v.status = Status::Ended;
        assert_eq!(
            substitute("Winners: {winners}", &v),
            "Winners: <@1> and <@2>"
        );
    }

    #[test]
    fn substitute_does_not_inject_mass_pings() {
        // No token resolves to `@everyone` / `@here`; a winner is only ever a
        // `<@id>` from the stored set, never raw client text.
        let v = open_vars("@everyone", 1);
        // Even a prize literally containing @everyone is just text — the public
        // announcement's allowed_mentions (parse: []) is what stops it pinging.
        assert!(substitute("{prize}", &v).contains("@everyone"));
        // ...and the in-message UPDATE keeps parse empty (see the test below).
    }

    fn sample_template() -> Value {
        // A V2 layout: a container with a text display + an action-row Enter
        // button, plus a sibling text display that must survive untouched.
        json!([
            { "type": 17, "components": [
                { "type": 10, "content": "🎁 Win {prize}! Entered: {entries}. Winners: {winners}." },
                { "type": 1, "components": [
                    { "type": 2, "style": 3, "label": "🎉 Enter", "custom_id": "giveaway:abc" }
                ]}
            ]},
            { "type": 10, "content": "Good luck!" }
        ])
    }

    #[test]
    fn render_bound_message_substitutes_text_and_restyles_enter_button() {
        let tree = sample_template();
        let v = open_vars("Nitro", 3);
        let out =
            render_bound_message(&tree, &v, "giveaway:abc", Some("🎉 Enter (3)"), false, None);

        // Body text rendered; pre-draw winners show TBD.
        assert_eq!(
            out[0]["components"][0]["content"],
            "🎁 Win Nitro! Entered: 3. Winners: TBD."
        );
        // The sibling text display is preserved verbatim.
        assert_eq!(out[1]["content"], "Good luck!");
        // The Enter button got the computed label + explicit (false) disabled.
        let btn = &out[0]["components"][1]["components"][0];
        assert_eq!(btn["label"], "🎉 Enter (3)");
        assert_eq!(btn["disabled"], false);
        assert_eq!(btn["custom_id"], "giveaway:abc");
    }

    #[test]
    fn render_fills_winners_after_a_draw_and_is_idempotent() {
        let tree = sample_template();
        let drawn = RenderVars {
            prize: "Nitro".into(),
            entries: 9,
            winner_count: 2,
            winners: ids(&["1", "2"]),
            status: Status::Ended,
            host_user_id: None,
        };
        let once = render_bound_message(
            &tree,
            &drawn,
            "giveaway:abc",
            Some("🏁 Giveaway ended"),
            true,
            None,
        );
        assert_eq!(
            once[0]["components"][0]["content"],
            "🎁 Win Nitro! Entered: 9. Winners: <@1> and <@2>."
        );
        let btn = &once[0]["components"][1]["components"][0];
        assert_eq!(btn["label"], "🏁 Giveaway ended");
        assert_eq!(btn["disabled"], true);
        // Rendering again from the same (raw-token) template yields the same
        // result — re-render never compounds, so a reroll just swaps the winners.
        let twice = render_bound_message(
            &tree,
            &drawn,
            "giveaway:abc",
            Some("🏁 Giveaway ended"),
            true,
            None,
        );
        assert_eq!(once, twice);
    }

    /// First save: the template still carries the editor's default id, and
    /// another plugin's button comes first. The Enter button is found where the
    /// bound button sits in the live message — the neighbour keeps its own id.
    #[test]
    fn a_stale_template_binds_the_button_at_the_live_buttons_place() {
        let template = json!([
            { "type": 1, "components": [
                { "type": 2, "style": 2, "label": "Rules", "custom_id": "quickreplies:zzz" },
                { "type": 2, "style": 3, "label": "Enter", "custom_id": "btn_action" }
            ]}
        ]);
        let live = json!([
            { "type": 1, "components": [
                { "type": 2, "style": 2, "label": "Rules", "custom_id": "quickreplies:zzz" },
                { "type": 2, "style": 3, "label": "Enter", "custom_id": "giveaway:xyz" }
            ]}
        ]);
        let v = open_vars("Nitro", 0);
        let out = render_bound_message(
            &template,
            &v,
            "giveaway:xyz",
            Some("Enter (0)"),
            false,
            Some(&live),
        );
        let row = &out[0]["components"];
        assert_eq!(row[0]["custom_id"], "quickreplies:zzz");
        assert_eq!(row[0]["label"], "Rules");
        assert_eq!(row[1]["custom_id"], "giveaway:xyz");
        assert_eq!(row[1]["label"], "Enter (0)");
        // …and the count rides the Enter button's own wording.
        assert_eq!(
            enter_button_label(&template, Some(&live), "giveaway:xyz").as_deref(),
            Some("Enter")
        );
    }

    #[test]
    fn unsendable_media_names_uploads_and_every_file() {
        let template = json!([
            { "type": 12, "items": [
                { "media": { "url": "https://cdn.example/ok.png" } },
                { "media": { "url": "session://abc/banner.png" } }
            ]},
            { "type": 17, "components": [
                { "type": 9, "components": [{ "type": 10, "content": "x" }],
                  "accessory": { "type": 11, "media": { "url": "attachment://thumb.jpg" } } },
                { "type": 13, "file": { "url": "https://cdn.example/rules.pdf" } }
            ]}
        ]);
        // An upload is named by its file name; anything else as written.
        assert_eq!(
            unsendable_media(&template),
            vec!["banner.png", "thumb.jpg", "https://cdn.example/rules.pdf"]
        );
        let fine = json!([{ "type": 11, "media": { "url": "HTTPS://cdn.example/a.png" } }]);
        assert!(unsendable_media(&fine).is_empty());
    }

    #[test]
    fn an_echoed_message_is_cleaned_of_resolved_media_fields() {
        let msg = MessageRef {
            content: None,
            components: Some(json!([
                { "type": 12, "items": [{ "media": {
                    "url": "https://cdn.discordapp.com/attachments/1/2/a.png",
                    "proxy_url": "https://media.discordapp.net/a.png",
                    "width": 10, "height": 10, "content_type": "image/png",
                    "attachment_id": "2", "flags": 0, "id": "9"
                }}]},
                { "type": 1, "components": [
                    { "type": 2, "style": 3, "label": "Enter", "custom_id": "giveaway:xyz" }
                ]}
            ])),
            flags: Some(FLAG_IS_COMPONENTS_V2),
        };
        let v = update_button_response(&msg, "giveaway:xyz", Some("Enter (1)"), false).unwrap();
        let media = &v["data"]["components"][0]["items"][0]["media"];
        assert_eq!(
            media,
            &json!({ "url": "https://cdn.discordapp.com/attachments/1/2/a.png" })
        );
    }

    #[test]
    fn a_re_render_stays_inside_the_v2_text_budget() {
        let mut tree = json!([
            { "type": 10, "content": "a".repeat(3990) },
            { "type": 10, "content": "short" },
            { "type": 1, "components": [
                { "type": 2, "style": 3, "label": "Enter (1)", "custom_id": "giveaway:xyz" }
            ]}
        ]);
        fit_text_budget(&mut tree, MAX_V2_TEXT);
        assert!(text_units(&tree) <= MAX_V2_TEXT, "{}", text_units(&tree));
        // The long display took the cut; the short one and the label are intact.
        assert!(tree[0]["content"].as_str().unwrap().ends_with('…'));
        assert_eq!(tree[1]["content"], "short");
        // Already inside the budget: untouched.
        let mut ok = json!([{ "type": 10, "content": "hello" }]);
        fit_text_budget(&mut ok, MAX_V2_TEXT);
        assert_eq!(ok[0]["content"], "hello");
    }

    #[test]
    fn the_cancelled_panel_is_plain_content_like_the_others() {
        for status in [Status::Open, Status::Ended, Status::Cancelled] {
            let panel = host_panel("xyz", status, false, 0, 1);
            let flags = panel["data"]["flags"].as_u64().unwrap();
            assert_eq!(flags & FLAG_IS_COMPONENTS_V2, 0, "{status:?}: {panel}");
            assert_ne!(flags & FLAG_EPHEMERAL, 0, "{status:?}: {panel}");
        }
    }

    #[test]
    fn render_patches_the_button_even_with_a_stale_template_id() {
        // A freshly-attached template still carries the editor's default id; the
        // first interactive button is pinned to the real enter id on render.
        let tree = json!([
            { "type": 1, "components": [
                { "type": 2, "style": 3, "label": "Enter", "custom_id": "button_action" }
            ]}
        ]);
        let v = open_vars("Nitro", 0);
        let out =
            render_bound_message(&tree, &v, "giveaway:xyz", Some("🎉 Enter (0)"), false, None);
        let btn = &out[0]["components"][0];
        assert_eq!(btn["custom_id"], "giveaway:xyz");
        assert_eq!(btn["label"], "🎉 Enter (0)");
    }

    #[test]
    fn enter_button_label_reads_the_lone_interactive_button() {
        assert_eq!(
            enter_button_label(&sample_template(), None, "giveaway:abc").as_deref(),
            Some("🎉 Enter")
        );
        // A tree with only a link button (no custom_id) has no enter button.
        let link_only = json!([{ "type": 1, "components": [
            { "type": 2, "style": 5, "label": "Rules", "url": "https://x" }
        ]}]);
        assert_eq!(enter_button_label(&link_only, None, "giveaway:abc"), None);
    }

    #[test]
    fn update_from_template_preserves_v2_flag_and_keeps_mentions_closed() {
        let msg = MessageRef {
            content: Some(String::new()),
            components: Some(sample_template()),
            flags: Some(FLAG_IS_COMPONENTS_V2),
        };
        let drawn = RenderVars {
            prize: "Nitro".into(),
            entries: 9,
            winner_count: 1,
            winners: ids(&["1"]),
            status: Status::Ended,
            host_user_id: None,
        };
        let v = update_message_from_template(
            &msg,
            &sample_template(),
            &drawn,
            "giveaway:abc",
            Some("🏁 Giveaway ended"),
            true,
        );
        assert_eq!(v["type"], 7);
        assert_eq!(v["data"]["flags"], FLAG_IS_COMPONENTS_V2);
        assert!(v["data"].get("content").is_none()); // V2 forbids content
                                                     // A re-render never pings — even though a winner mention is now in the body.
        assert_eq!(
            v["data"]["allowed_mentions"]["parse"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert!(v["data"]["allowed_mentions"].get("users").is_none());
    }
}
