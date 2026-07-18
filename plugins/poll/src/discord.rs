//! Discord interaction protocol: signature verification, the request shapes we
//! read, the **pure** decision/builder logic, and the callback JSON we send back.
//!
//! Everything that *decides what should happen* — who may vote, which picks are
//! valid, who counts as a host, how the live tallies are stamped onto the
//! message, what the results block says — is a pure function here, so it is
//! exhaustively unit-tested. The only I/O lives in `rest.rs` (the optional
//! role-list call and the token-free followup/edit calls); `routes.rs` is the
//! thin shell that glues the two and turns interaction responses into the live
//! tallies + public announcements, no bot token required.

use std::collections::BTreeSet;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::store::{PollOption, Requirements, Status};

// Interaction request types.
pub const TYPE_PING: u8 = 1;
pub const TYPE_MESSAGE_COMPONENT: u8 = 3;

// Interaction callback (response) types.
const RESPONSE_PONG: u8 = 1;
const RESPONSE_CHANNEL_MESSAGE: u8 = 4;
const RESPONSE_UPDATE_MESSAGE: u8 = 7;

// Component / button / flag constants.
const COMPONENT_TYPE_BUTTON: u8 = 2;
const COMPONENT_TYPE_STRING_SELECT: u8 = 3;
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
/// Discord select-placeholder ceiling.
const MAX_PLACEHOLDER: usize = 150;

// Member permission bits that, on their own, make someone a poll "host".
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
    /// components back (with the bound component restyled) to keep the live
    /// tallies current — the only way to edit a webhook-authored message.
    #[serde(default)]
    pub message: Option<MessageRef>,
    /// This interaction's webhook token. With the `application_id` it addresses
    /// `/webhooks/{app}/{token}` — used to post a *followup* (no bot token): a
    /// vote confirmation or the host panel rides here when the click's one
    /// reply is spent on the `UPDATE_MESSAGE` refresh. Valid ~15 minutes.
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
    /// The option values a string select submitted (we set these = option keys).
    #[serde(default)]
    pub values: Option<Vec<String>>,
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

/// We only ever need the actor's id (ballots are keyed by it, never by display
/// name), so this is deliberately minimal — extra payload fields are ignored.
#[derive(Debug, Deserialize, Clone)]
pub struct User {
    pub id: String,
}

/// The message a component sits on — its content, component tree, and flags, so
/// an `UPDATE_MESSAGE` can echo them back verbatim with one component restyled.
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
    /// True when this is an ephemeral message — one of our panels, never the
    /// public poll message. An ephemeral message must never be treated as a
    /// refresh target: its interaction token's `@original` is the panel, so
    /// caching it as a refresher would aim later public-message edits at the
    /// wrong message entirely.
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

    /// The option values a string select submitted (empty for a button).
    pub fn picked_values(&self) -> &[String] {
        self.data
            .as_ref()
            .and_then(|d| d.values.as_deref())
            .unwrap_or(&[])
    }
}

// ── custom_id routing ─────────────────────────────────────────────────────────

/// The plugin prefix every minted `custom_id` carries (and the dispatcher routes
/// on).
pub const PREFIX: &str = "poll:";

/// What a `custom_id` asks this plugin to do. The bound component DWEEB attaches
/// is a bare `poll:<id>` (no verb); the ephemeral panels' controls carry a verb.
/// Parsing is total — anything unrecognised is [`Action::Unknown`].
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    /// The bound component: a button click (open the voting panel) or a select
    /// pick (the interaction's `values` are the ballot).
    Vote {
        id: String,
    },
    /// The ephemeral voting panel's select — its `values` are the ballot.
    Pick {
        id: String,
    },
    /// Show the voting panel (from a confirmation's "Change vote" or the host
    /// panel's "Vote as participant"), replacing the ephemeral in place.
    Panel {
        id: String,
    },
    /// Withdraw the actor's own ballot.
    Retract {
        id: String,
    },
    /// Host panel: close voting and announce the results.
    Close {
        id: String,
    },
    /// Host panel: reopen a closed poll.
    Reopen {
        id: String,
    },
    /// Host panel: post the current results publicly without closing.
    Results {
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
        // No verb ⇒ the bound component. The id is the whole remainder.
        None => {
            if rest.is_empty() {
                Action::Unknown
            } else {
                Action::Vote {
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
                "pick" => Action::Pick { id },
                "panel" => Action::Panel { id },
                "retract" => Action::Retract { id },
                "close" => Action::Close { id },
                "reopen" => Action::Reopen { id },
                "results" => Action::Results { id },
                _ => Action::Unknown,
            }
        }
    }
}

/// Mint a control `custom_id`, e.g. `poll:close:<id>`.
pub fn control_id(verb: &str, id: &str) -> String {
    format!("{PREFIX}{verb}:{id}")
}

/// The bound component's `custom_id`, `poll:<id>`.
pub fn bound_id(id: &str) -> String {
    format!("{PREFIX}{id}")
}

// ── host & votability decisions (pure) ───────────────────────────────────────

/// Whether the acting member is a host for this poll: holding a configured host
/// role, or a server-management permission (Administrator or Manage Server,
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

/// Why a member may not vote — each a distinct, actionable case.
#[derive(Debug, PartialEq, Eq)]
pub enum Votable {
    Ok,
    /// The poll is closed.
    Closed,
    /// Past the deadline — the caller lazily closes and re-renders.
    DeadlinePassed,
    /// The member lacks the required role(s).
    MissingRoles,
    /// The member's account isn't old enough.
    AccountTooNew {
        needed_days: u32,
    },
}

/// Decide whether a member may vote — pure, no I/O. All inputs come from the
/// interaction payload (roles, the user-id snowflake) or stored config, so the
/// whole gate runs without a single Discord call.
pub fn check_votable(
    status: Status,
    ends_at: Option<i64>,
    now_ms: i64,
    member_roles: &[String],
    account_created_ms: Option<i64>,
    reqs: &Requirements,
) -> Votable {
    if status != Status::Open {
        return Votable::Closed;
    }
    if let Some(deadline_secs) = ends_at {
        if now_ms / 1000 > deadline_secs {
            return Votable::DeadlinePassed;
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
            return Votable::MissingRoles;
        }
    }
    if reqs.min_account_age_days > 0 {
        // If the id didn't parse we can't enforce the floor, so we let them in
        // rather than wall out a real member over a parsing quirk.
        if let Some(created) = account_created_ms {
            let age_days = (now_ms.saturating_sub(created)) / MS_PER_DAY;
            if age_days < reqs.min_account_age_days as i64 {
                return Votable::AccountTooNew {
                    needed_days: reqs.min_account_age_days,
                };
            }
        }
    }
    Votable::Ok
}

/// A plain-language reason for a [`MissingRoles`](Votable::MissingRoles)
/// denial, naming the role(s) as mentions (which render as the role name).
pub fn missing_roles_message(reqs: &Requirements) -> String {
    let mentions: Vec<String> = reqs.roles.iter().map(|r| format!("<@&{}>", r.id)).collect();
    match (reqs.require_all, mentions.as_slice()) {
        (_, [one]) => format!("\u{1F512} You need the {one} role to vote in this poll."),
        (true, many) => format!(
            "\u{1F512} You need all of these roles to vote: {}.",
            many.join(" ")
        ),
        (false, many) => format!(
            "\u{1F512} You need one of these roles to vote: {}.",
            many.join(" ")
        ),
    }
}

// ── ballot validation (pure) ─────────────────────────────────────────────────

/// Why a submitted set of picks was refused.
#[derive(Debug, PartialEq, Eq)]
pub enum PickError {
    /// No usable pick survived (empty submit, or nothing recognised).
    Empty,
    /// A value isn't one of this poll's option keys. A `custom_id` — and a
    /// select's `values` — are client-forgeable, so unknown keys are refused,
    /// never counted. Also the honest answer when a reconfigure changed the
    /// options under an already-posted message.
    Unknown,
    /// More picks than the poll allows.
    TooMany { max: u32 },
}

/// Validate a submitted ballot against the poll's options: dedupe (preserving
/// submit order), require every value to be a known option key, and cap the
/// count at `max_choices`. Pure — the contract between the forgeable interaction
/// payload and the tallies.
pub fn sanitize_picks(
    values: &[String],
    options: &[PollOption],
    max_choices: u32,
) -> Result<Vec<String>, PickError> {
    let known: BTreeSet<&str> = options.iter().map(|o| o.key.as_str()).collect();
    let mut out: Vec<String> = Vec::new();
    for v in values {
        if !known.contains(v.as_str()) {
            return Err(PickError::Unknown);
        }
        if !out.iter().any(|seen| seen == v) {
            out.push(v.clone());
        }
    }
    if out.is_empty() {
        return Err(PickError::Empty);
    }
    if out.len() as u32 > max_choices.max(1) {
        return Err(PickError::TooMany {
            max: max_choices.max(1),
        });
    }
    Ok(out)
}

/// The display labels for a set of picked keys, in pick order. A key that no
/// longer exists (post-reconfigure ballot) renders as `an old option`.
pub fn labels_for(picks: &[String], options: &[PollOption]) -> Vec<String> {
    picks
        .iter()
        .map(|key| {
            options
                .iter()
                .find(|o| &o.key == key)
                .map(|o| clamp(&o.label, 60))
                .unwrap_or_else(|| "an old option".to_string())
        })
        .collect()
}

// ── live results rendering (pure) ────────────────────────────────────────────

/// The live values a poll message's placeholders resolve to right now. Built
/// from the stored config plus the current tallies / status.
pub struct RenderVars {
    pub question: String,
    /// Total ballots cast.
    pub votes: i64,
    /// Per-option counts, in config (display) order — zeros included.
    pub tallies: Vec<(PollOption, i64)>,
    pub status: Status,
    pub hide_results: bool,
    pub ends_at: Option<i64>,
}

impl RenderVars {
    /// Resolve one token to its rendered string, or `None` for a token this
    /// plugin doesn't own (left verbatim by [`substitute`], so a stray `{foo}`
    /// in prose survives untouched). Mirrors the DWEEB manifest's declared set.
    fn value_of(&self, token: &str) -> Option<String> {
        Some(match token {
            "question" => self.question.clone(),
            "votes" => commas(self.votes),
            "results" => results_block(self),
            "leader" => leader_label(self),
            "status" => self.status.as_str().to_string(),
            // Discord renders `<t:…:R>` as a live relative time ("in 2 hours",
            // then "2 hours ago"), so a deadline keeps itself current with no
            // re-render at all. Empty when the poll has no deadline.
            "closes" => match self.ends_at {
                Some(secs) => format!("<t:{secs}:R>"),
                None => String::new(),
            },
            _ => return None,
        })
    }
}

/// Whether per-option results are visible right now: always when the results
/// aren't hidden, and once the poll is closed even when they are.
fn results_visible(vars: &RenderVars) -> bool {
    !vars.hide_results || vars.status == Status::Closed
}

/// The keys currently tied for the lead (empty when nobody has voted).
fn leading_keys(vars: &RenderVars) -> BTreeSet<&str> {
    let max = vars.tallies.iter().map(|(_, n)| *n).max().unwrap_or(0);
    if max <= 0 {
        return BTreeSet::new();
    }
    vars.tallies
        .iter()
        .filter(|(_, n)| *n == max)
        .map(|(o, _)| o.key.as_str())
        .collect()
}

/// The `{leader}` value: the option(s) currently in front, `TBD` before any
/// vote, and `hidden` while a hidden poll is still open.
pub fn leader_label(vars: &RenderVars) -> String {
    if !results_visible(vars) {
        return "hidden".to_string();
    }
    let leaders = leading_keys(vars);
    if leaders.is_empty() {
        return "TBD".to_string();
    }
    let labels: Vec<String> = vars
        .tallies
        .iter()
        .filter(|(o, _)| leaders.contains(o.key.as_str()))
        .map(|(o, _)| format!("**{}**", clamp(&o.label, 60)))
        .collect();
    labels.join(" & ")
}

/// The `{results}` block: one line per option with a 10-cell bar, percentage
/// and count — or the lock note while a hidden poll is open. The closed poll
/// crowns the leader(s). Pure and idempotent (always rendered from raw tallies).
pub fn results_block(vars: &RenderVars) -> String {
    if !results_visible(vars) {
        return "\u{1F512} Results are hidden until the poll closes.".to_string();
    }
    let crowns = if vars.status == Status::Closed {
        leading_keys(vars)
    } else {
        BTreeSet::new()
    };
    let mut lines = Vec::with_capacity(vars.tallies.len());
    for (option, n) in &vars.tallies {
        let crown = if crowns.contains(option.key.as_str()) {
            "\u{1F3C6} "
        } else {
            ""
        };
        let emoji = option
            .emoji
            .as_ref()
            .and_then(emoji_markdown)
            .map(|e| format!("{e} "))
            .unwrap_or_default();
        lines.push(format!(
            "{crown}{emoji}**{}** {} {}% ({})",
            clamp(&option.label, 60),
            bar(*n, vars.votes),
            pct(*n, vars.votes),
            commas(*n),
        ));
    }
    lines.join("\n")
}

/// A 10-cell text bar, `▰▰▰▰▱▱▱▱▱▱`. Zero total renders all-empty.
fn bar(n: i64, total: i64) -> String {
    let filled = if total > 0 {
        (((n.max(0) * 10) + total / 2) / total).clamp(0, 10) as usize
    } else {
        0
    };
    let mut out = String::with_capacity(30);
    for _ in 0..filled {
        out.push('\u{25B0}');
    }
    for _ in filled..10 {
        out.push('\u{25B1}');
    }
    out
}

fn pct(n: i64, total: i64) -> i64 {
    if total <= 0 {
        0
    } else {
        ((n.max(0) * 100) + total / 2) / total
    }
}

/// The inline markdown for a stored option emoji: the raw glyph for unicode, the
/// `<:name:id>` / `<a:name:id>` token for a custom emoji. None when empty.
fn emoji_markdown(e: &crate::store::EmojiRef) -> Option<String> {
    match (&e.id, &e.name) {
        (Some(id), name) => {
            let name = name.as_deref().filter(|n| !n.is_empty()).unwrap_or("_");
            Some(format!(
                "<{}:{}:{}>",
                if e.animated { "a" } else { "" },
                name,
                id
            ))
        }
        (None, Some(name)) if !name.is_empty() => Some(name.clone()),
        _ => None,
    }
}

// ── message placeholders (pure) ──────────────────────────────────────────────
//
// The host message can carry `{token}` placeholders the poll fills in: the live
// ballot count, the per-option results, the leader, the status. DWEEB paints the
// first values at send time; from then on only THIS service can keep the
// (webhook-authored) message current, by re-rendering its stored template on
// each click and replying `UPDATE_MESSAGE`. Re-rendering from the raw-token
// *template* (never from the already-rendered message) is what makes it
// idempotent — the bars restamp and `{status}` flips on the next click after a
// close.

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

// ── bound-component restyle (pure) ───────────────────────────────────────────

/// How to restyle the bound component for the poll's current state. A button
/// carries the live count on its `label`; a select carries it on `placeholder`
/// (`None` = leave the author's own placeholder alone). `disabled` is always
/// written explicitly so a reopen re-enables what a close disabled.
pub struct BoundPatch {
    pub label: Option<String>,
    pub placeholder: Option<String>,
    pub disabled: bool,
}

/// The current label of the button with this `custom_id`, found anywhere in the
/// (possibly Components-V2, deeply nested) component tree.
pub fn find_button_label(components: &Value, custom_id: &str) -> Option<String> {
    find_field(components, custom_id, "label")
}

/// The current placeholder of the select with this `custom_id`.
pub fn find_select_placeholder(components: &Value, custom_id: &str) -> Option<String> {
    find_field(components, custom_id, "placeholder")
}

fn find_field(components: &Value, custom_id: &str, field: &str) -> Option<String> {
    fn walk(v: &Value, custom_id: &str, field: &str) -> Option<String> {
        match v {
            Value::Array(a) => a.iter().find_map(|x| walk(x, custom_id, field)),
            Value::Object(o) => {
                if o.get("custom_id").and_then(Value::as_str) == Some(custom_id) {
                    return o.get(field).and_then(Value::as_str).map(str::to_string);
                }
                o.values().find_map(|x| walk(x, custom_id, field))
            }
            _ => None,
        }
    }
    walk(components, custom_id, field)
}

/// Clone a component tree, restyling the component with this `custom_id` per the
/// patch. Everything else — the user's own message design — is preserved
/// verbatim, which is exactly what lets an `UPDATE_MESSAGE` keep the live
/// tallies current without flattening their layout.
pub fn restyle_bound(components: &Value, custom_id: &str, patch: &BoundPatch) -> Value {
    let mut out = components.clone();
    let mut hit = false;
    patch_matching(&mut out, custom_id, patch, &mut hit);
    out
}

fn patch_matching(v: &mut Value, custom_id: &str, patch: &BoundPatch, hit: &mut bool) {
    match v {
        Value::Array(a) => {
            for item in a.iter_mut() {
                patch_matching(item, custom_id, patch, hit);
            }
        }
        Value::Object(o) => {
            if o.get("custom_id").and_then(Value::as_str) == Some(custom_id) {
                apply_patch(o, custom_id, patch);
                *hit = true;
            }
            for val in o.values_mut() {
                patch_matching(val, custom_id, patch, hit);
            }
        }
        _ => {}
    }
}

/// Write the patch onto one component object, respecting its kind: `label` only
/// lands on a button, `placeholder` only on a string select, `disabled` on both.
fn apply_patch(o: &mut Map<String, Value>, custom_id: &str, patch: &BoundPatch) {
    o.insert("custom_id".into(), json!(custom_id));
    let kind = o.get("type").and_then(Value::as_u64);
    if kind == Some(COMPONENT_TYPE_BUTTON as u64) {
        if let Some(label) = &patch.label {
            o.insert("label".into(), json!(clamp(label, MAX_LABEL)));
        }
    }
    if kind == Some(COMPONENT_TYPE_STRING_SELECT as u64) {
        if let Some(placeholder) = &patch.placeholder {
            o.insert(
                "placeholder".into(),
                json!(clamp(placeholder, MAX_PLACEHOLDER)),
            );
        }
    }
    o.insert("disabled".into(), json!(patch.disabled));
}

/// An object that is an interactive button or string select carrying a
/// `custom_id` (never a Link/Premium button, which have none).
fn is_bindable_component(o: &Map<String, Value>) -> bool {
    let kind = o.get("type").and_then(Value::as_u64);
    (kind == Some(COMPONENT_TYPE_BUTTON as u64)
        || kind == Some(COMPONENT_TYPE_STRING_SELECT as u64))
        && o.contains_key("custom_id")
}

/// Patch the first bindable component found (depth-first), pinning it to
/// `custom_id`. Returns whether one was patched. Fallback for a freshly-attached
/// template that still carries the editor's default id.
fn patch_first_bindable(tree: &mut Value, custom_id: &str, patch: &BoundPatch) -> bool {
    match tree {
        Value::Array(a) => a
            .iter_mut()
            .any(|item| patch_first_bindable(item, custom_id, patch)),
        Value::Object(o) => {
            if is_bindable_component(o) {
                apply_patch(o, custom_id, patch);
                return true;
            }
            o.values_mut()
                .any(|val| patch_first_bindable(val, custom_id, patch))
        }
        _ => false,
    }
}

/// Render the bound poll message from its stored `template` (the host's own
/// message, captured with raw `{tokens}`): substitute every Text Display
/// content, button label and select placeholder, then restyle the bound
/// component (patch + pin its `custom_id`). Returns the component tree for an
/// `UPDATE_MESSAGE`. Pure — the template is cloned, never mutated.
pub fn render_bound_message(
    template: &Value,
    vars: &RenderVars,
    custom_id: &str,
    patch: &BoundPatch,
) -> Value {
    let mut out = template.clone();
    substitute_tree(&mut out, vars);
    // Patch the bound component last so its computed label/placeholder (live
    // count / "closed") wins over any substitution done to it above.
    let mut hit = false;
    patch_matching(&mut out, custom_id, patch, &mut hit);
    if !hit {
        patch_first_bindable(&mut out, custom_id, patch);
    }
    out
}

/// Walk a component tree, substituting placeholders in the user-text fields:
/// Text Display `content`, button `label`, and select `placeholder`. Generic
/// descent keeps it correct as the layout nests (containers, sections, rows).
fn substitute_tree(v: &mut Value, vars: &RenderVars) {
    match v {
        Value::Array(a) => {
            for item in a.iter_mut() {
                substitute_tree(item, vars);
            }
        }
        Value::Object(o) => {
            for field in ["content", "label", "placeholder"] {
                // Compute first (ends the immutable borrow) then write.
                if let Some(rendered) = o
                    .get(field)
                    .and_then(Value::as_str)
                    .map(|s| substitute(s, vars))
                {
                    o.insert(field.into(), Value::String(rendered));
                }
            }
            for val in o.values_mut() {
                substitute_tree(val, vars);
            }
        }
        _ => {}
    }
}

/// The label of the bound button in a (raw) template — the first bindable
/// component when it's a button — so the live count can ride the host's own
/// wording. None when the template's bound component isn't a button.
pub fn template_button_label(template: &Value) -> Option<String> {
    fn walk(v: &Value) -> Option<Option<String>> {
        match v {
            Value::Array(a) => a.iter().find_map(walk),
            Value::Object(o) => {
                if is_bindable_component(o) {
                    let is_button =
                        o.get("type").and_then(Value::as_u64) == Some(COMPONENT_TYPE_BUTTON as u64);
                    return Some(if is_button {
                        Some(
                            o.get("label")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                        )
                    } else {
                        None
                    });
                }
                o.values().find_map(walk)
            }
            _ => None,
        }
    }
    walk(template).flatten()
}

/// Build an `UPDATE_MESSAGE` that re-renders the live message with the bound
/// component restyled, preserving the rest of the message (content + V2 layout +
/// flags). None when the message carried no components to edit.
pub fn update_component_response(
    message: &MessageRef,
    custom_id: &str,
    patch: &BoundPatch,
) -> Option<Value> {
    let components = message.components.as_ref()?;
    let patched = restyle_bound(components, custom_id, patch);
    Some(wrap_update(message, patched))
}

/// Build the `UPDATE_MESSAGE` that re-renders the bound message from `template`
/// with current `vars`. Preserves the live message's V2 flag / plain content
/// exactly like [`update_component_response`]. `allowed_mentions.parse = []` so
/// a re-render can never ping `@everyone`.
pub fn update_message_from_template(
    message: &MessageRef,
    template: &Value,
    vars: &RenderVars,
    custom_id: &str,
    patch: &BoundPatch,
) -> Value {
    let components = render_bound_message(template, vars, custom_id, patch);
    wrap_update(message, components)
}

fn wrap_update(message: &MessageRef, components: Value) -> Value {
    let mut data = json!({
        "components": components,
        "allowed_mentions": { "parse": [] },
    });
    let flags = message.flags.unwrap_or(0);
    if flags & FLAG_IS_COMPONENTS_V2 != 0 {
        // V2 forbids `content`; the text already lives inside `components`.
        data["flags"] = json!(FLAG_IS_COMPONENTS_V2);
    } else if let Some(content) = message.content.as_deref() {
        // Preserve the plain content so the edit doesn't blank the message body.
        data["content"] = json!(content);
    }
    json!({ "type": RESPONSE_UPDATE_MESSAGE, "data": data })
}

// ── live count suffixes (pure) ───────────────────────────────────────────────

/// Strip a trailing ` (123)` count suffix from a button label, so restamping the
/// count never compounds (`Vote (1)` → `Vote (2)`, not `Vote (1) (2)`). Only a
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

/// A button label with the ballot count appended, e.g. `🗳️ Vote (1,234)`.
pub fn label_with_count(label: &str, count: i64) -> String {
    let base = strip_count_suffix(label);
    let out = format!("{base} ({})", commas(count));
    clamp(&out, MAX_LABEL)
}

/// Strip a trailing ` · N votes` suffix a previous restamp added to a select
/// placeholder, so it never compounds either.
fn strip_votes_suffix(placeholder: &str) -> &str {
    let t = placeholder.trim_end();
    if let Some(pos) = t.rfind(" \u{B7} ") {
        let tail = &t[pos + " \u{B7} ".len()..];
        let word_ok = tail.ends_with(" votes") || tail.ends_with(" vote");
        let digits = tail
            .trim_end_matches(" votes")
            .trim_end_matches(" vote")
            .trim_end();
        if word_ok && !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit() || c == ',') {
            return t[..pos].trim_end();
        }
    }
    t
}

/// A select placeholder with the live ballot count appended, e.g.
/// `Cast your vote · 42 votes`.
pub fn placeholder_with_count(placeholder: &str, count: i64) -> String {
    let base = strip_votes_suffix(placeholder);
    let base = if base.is_empty() {
        "Cast your vote"
    } else {
        base
    };
    let word = if count == 1 { "vote" } else { "votes" };
    clamp(
        &format!("{base} \u{B7} {} {word}", commas(count)),
        MAX_PLACEHOLDER,
    )
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

/// An ephemeral message carrying interactive rows (a plain-content message, not
/// V2, so it can hold both `content` and classic action rows — and so every
/// panel can replace every other panel in place via `UPDATE_MESSAGE`, which
/// forbids switching a message between V2 and non-V2).
fn ephemeral_with_rows(content: &str, rows: Vec<Value>) -> Value {
    let mut data = json!({
        "flags": FLAG_EPHEMERAL,
        "content": clamp(content, MAX_CONTENT),
        "allowed_mentions": { "parse": [] },
    });
    if !rows.is_empty() {
        data["components"] = json!(rows);
    }
    json!({ "type": RESPONSE_CHANNEL_MESSAGE, "data": data })
}

fn button(style: u8, label: &str, custom_id: String) -> Value {
    json!({ "type": COMPONENT_TYPE_BUTTON, "style": style, "label": label, "custom_id": custom_id })
}

fn row(components: Vec<Value>) -> Value {
    json!({ "type": COMPONENT_ACTION_ROW, "components": components })
}

/// One select option for the ephemeral voting panel, `default`-marked when it's
/// part of the member's current ballot (so reopening the panel shows their vote).
fn panel_option(option: &PollOption, picked: bool) -> Value {
    let mut o = json!({
        "label": clamp(&option.label, 100),
        "value": option.key,
    });
    if let Some(desc) = option.description.as_deref().filter(|d| !d.is_empty()) {
        o["description"] = json!(clamp(desc, 100));
    }
    if let Some(e) = option.emoji.as_ref().filter(|e| !e.is_empty()) {
        let mut emoji = Map::new();
        if let Some(id) = &e.id {
            emoji.insert("id".into(), json!(id));
        }
        if let Some(name) = &e.name {
            emoji.insert("name".into(), json!(name));
        }
        if e.animated {
            emoji.insert("animated".into(), json!(true));
        }
        o["emoji"] = Value::Object(emoji);
    }
    if picked {
        o["default"] = json!(true);
    }
    o
}

/// The ephemeral voting panel: a string select of the poll's options (the
/// member's current picks pre-selected), plus a Retract button when they have a
/// changeable ballot. This is how a *button*-bound poll collects votes, and how
/// "Change vote" re-opens the ballot.
pub fn vote_panel(
    id: &str,
    options: &[PollOption],
    max_choices: u32,
    current: &[String],
    allow_change: bool,
    votes: i64,
) -> Value {
    let max = (max_choices.max(1) as usize).min(options.len().max(1));
    let opts: Vec<Value> = options
        .iter()
        .map(|o| panel_option(o, current.iter().any(|k| k == &o.key)))
        .collect();
    let select = json!({
        "type": COMPONENT_TYPE_STRING_SELECT,
        "custom_id": control_id("pick", id),
        "placeholder": if max > 1 { format!("Pick up to {max} options") } else { "Pick an option".to_string() },
        "min_values": 1,
        "max_values": max,
        "options": opts,
    });
    let mut rows = vec![row(vec![select])];
    if !current.is_empty() && allow_change {
        rows.push(row(vec![button(
            BUTTON_DANGER,
            "Retract my vote",
            control_id("retract", id),
        )]));
    }
    let count_line = format!(
        "**{}** ballot{} so far.",
        commas(votes),
        if votes == 1 { "" } else { "s" }
    );
    let content = if current.is_empty() {
        format!(
            "\u{1F5F3}\u{FE0F} **Cast your vote** \u{2014} pick {} below. {count_line}",
            if max > 1 {
                format!("up to {max} options")
            } else {
                "an option".to_string()
            }
        )
    } else if allow_change {
        format!("\u{2705} You've voted \u{2014} pick again below to change it. {count_line}")
    } else {
        format!("\u{2705} You've voted \u{2014} your ballot is locked in. {count_line}")
    };
    ephemeral_with_rows(&content, rows)
}

/// The confirmation after a ballot lands (or is found unchanged): what they
/// picked, how many have voted, and the change/retract controls. A host's
/// confirmation also carries their control row (`host_status`), since in select
/// mode their pick *is* their click and there's no other door to the controls.
pub fn vote_confirmation(
    id: &str,
    picked_labels: &[String],
    votes: i64,
    allow_change: bool,
    host_status: Option<Status>,
) -> Value {
    let list = picked_labels
        .iter()
        .map(|l| format!("**{l}**"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut content = format!(
        "\u{2705} Vote recorded: {list} \u{2014} you're one of **{}** voter{}.",
        commas(votes),
        if votes == 1 { "" } else { "s" }
    );
    content.push_str(if allow_change {
        " You can change or retract it anytime."
    } else {
        " Ballots are locked \u{2014} no changes on this poll."
    });
    let mut rows = Vec::new();
    if allow_change {
        rows.push(row(vec![
            button(BUTTON_SECONDARY, "Change vote", control_id("panel", id)),
            button(BUTTON_DANGER, "Retract my vote", control_id("retract", id)),
        ]));
    }
    if let Some(status) = host_status {
        content.push_str("\n\u{1F6E0}\u{FE0F} You manage this poll:");
        rows.push(host_controls_row(id, status));
    }
    ephemeral_with_rows(&content, rows)
}

/// The notice after a member retracts. Built the same (non-V2) way as the other
/// panels so it can replace them *in place* via `UPDATE_MESSAGE`.
pub fn retracted_notice(id: &str) -> Value {
    ephemeral_with_rows(
        "\u{1F44B} Your ballot has been withdrawn. Vote again anytime while the poll is open.",
        vec![row(vec![button(
            BUTTON_PRIMARY,
            "Vote again",
            control_id("panel", id),
        )])],
    )
}

fn host_controls_row(id: &str, status: Status) -> Value {
    match status {
        Status::Open => row(vec![
            button(
                BUTTON_SECONDARY,
                "\u{1F4CA} Post results",
                control_id("results", id),
            ),
            button(
                BUTTON_DANGER,
                "\u{1F512} Close poll",
                control_id("close", id),
            ),
        ]),
        Status::Closed => row(vec![
            button(
                BUTTON_SECONDARY,
                "\u{1F4CA} Post results",
                control_id("results", id),
            ),
            button(
                BUTTON_SUCCESS,
                "\u{1F513} Reopen poll",
                control_id("reopen", id),
            ),
        ]),
    }
}

/// The host control panel (ephemeral), shown when a Manage-Server holder (or a
/// configured host role) clicks the bound button. Adapts to the poll's status.
pub fn host_panel(id: &str, status: Status, votes: i64) -> Value {
    let mut rows = vec![row(vec![button(
        BUTTON_PRIMARY,
        "\u{1F5F3}\u{FE0F} Vote as participant",
        control_id("panel", id),
    )])];
    rows.push(host_controls_row(id, status));
    let content = match status {
        Status::Open => format!(
            "\u{1F6E0}\u{FE0F} **Host controls** \u{2014} you manage this server.\n**{}** ballot{} so far. Close whenever you're ready \u{2014} closing announces the results.",
            commas(votes),
            if votes == 1 { "" } else { "s" }
        ),
        Status::Closed => format!(
            "\u{1F512} **This poll is closed.** {} ballot{} were cast. You can post the results again, or reopen it.",
            commas(votes),
            if votes == 1 { "" } else { "s" }
        ),
    };
    ephemeral_with_rows(&content, rows)
}

/// The public results announcement (a non-ephemeral interaction response, so it
/// posts in the channel with **no bot token**). Used by Close (final) and by the
/// host's "Post results" (interim). A custom close template runs through the
/// same [`substitute`] as the in-message placeholders, so `{results}`,
/// `{question}`, `{votes}`, `{leader}` … all work here too. Never pings anyone.
pub fn results_announcement(vars: &RenderVars, closed_now: bool, custom: Option<&str>) -> Value {
    let text = match (closed_now, custom.map(str::trim).filter(|t| !t.is_empty())) {
        (true, Some(t)) => substitute(t, vars),
        (true, None) => format!(
            "\u{1F4CA} **Poll closed:** {}\n\n{}\n\n\u{1F5F3}\u{FE0F} {} ballot{} \u{2014} thanks for voting!",
            clamp(&vars.question, 300),
            results_block(vars),
            commas(vars.votes),
            if vars.votes == 1 { "" } else { "s" }
        ),
        (false, _) => format!(
            "\u{1F4CA} **Poll results so far:** {}\n\n{}\n\n\u{1F5F3}\u{FE0F} {} ballot{} \u{2014} voting is still open!",
            clamp(&vars.question, 300),
            results_block(vars),
            commas(vars.votes),
            if vars.votes == 1 { "" } else { "s" }
        ),
    };
    json!({
        "type": RESPONSE_CHANNEL_MESSAGE,
        "data": {
            "content": clamp(&text, MAX_CONTENT),
            "allowed_mentions": { "parse": [] }
        }
    })
}

// ── small formatting helpers (pure) ──────────────────────────────────────────

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
    use crate::store::{EmojiRef, RoleRef};

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
    fn opt(key: &str, label: &str) -> PollOption {
        PollOption {
            key: key.into(),
            label: label.into(),
            description: None,
            emoji: None,
        }
    }

    // ── custom_id routing ───────────────────────────────────────────────────
    #[test]
    fn parse_action_reads_the_bound_component() {
        assert_eq!(
            parse_action("poll:abc123"),
            Action::Vote {
                id: "abc123".into()
            }
        );
    }

    #[test]
    fn parse_action_reads_the_controls() {
        assert_eq!(
            parse_action("poll:pick:abc"),
            Action::Pick { id: "abc".into() }
        );
        assert_eq!(
            parse_action("poll:panel:abc"),
            Action::Panel { id: "abc".into() }
        );
        assert_eq!(
            parse_action("poll:retract:abc"),
            Action::Retract { id: "abc".into() }
        );
        assert_eq!(
            parse_action("poll:close:abc"),
            Action::Close { id: "abc".into() }
        );
        assert_eq!(
            parse_action("poll:reopen:abc"),
            Action::Reopen { id: "abc".into() }
        );
        assert_eq!(
            parse_action("poll:results:abc"),
            Action::Results { id: "abc".into() }
        );
    }

    #[test]
    fn parse_action_rejects_foreign_or_empty() {
        assert_eq!(parse_action("other:abc"), Action::Unknown);
        assert_eq!(parse_action("poll:"), Action::Unknown);
        assert_eq!(parse_action("poll:close:"), Action::Unknown);
        assert_eq!(parse_action("poll:bogus:abc"), Action::Unknown);
        assert_eq!(parse_action(""), Action::Unknown);
    }

    #[test]
    fn bound_id_round_trips_through_parse() {
        let id = "deadbeef";
        assert_eq!(parse_action(&bound_id(id)), Action::Vote { id: id.into() });
    }

    // ── host check ──────────────────────────────────────────────────────────
    #[test]
    fn host_by_role_or_management_permission() {
        let hosts = roles(&["100"]);
        assert!(is_host(&ids(&["100"]), 0, &hosts));
        assert!(!is_host(&ids(&["999"]), 0, &hosts));
        assert!(is_host(&[], PERM_ADMINISTRATOR, &hosts));
        assert!(is_host(&[], PERM_MANAGE_GUILD, &hosts));
        assert!(!is_host(&[], 0, &hosts));
    }

    // ── votability ──────────────────────────────────────────────────────────
    fn reqs_role_any(ids_: &[&str]) -> Requirements {
        Requirements {
            roles: roles(ids_),
            require_all: false,
            min_account_age_days: 0,
        }
    }

    #[test]
    fn open_poll_with_no_requirements_admits_anyone() {
        let r = Requirements::default();
        assert_eq!(
            check_votable(Status::Open, None, 0, &[], None, &r),
            Votable::Ok
        );
    }

    #[test]
    fn closed_poll_refuses_votes() {
        let r = Requirements::default();
        assert_eq!(
            check_votable(Status::Closed, None, 0, &[], None, &r),
            Votable::Closed
        );
    }

    #[test]
    fn past_the_deadline_reports_deadline_passed() {
        let r = Requirements::default();
        let now_ms = 2_000_000;
        let deadline = now_ms / 1000 - 1;
        assert_eq!(
            check_votable(Status::Open, Some(deadline), now_ms, &[], None, &r),
            Votable::DeadlinePassed
        );
        assert_eq!(
            check_votable(
                Status::Open,
                Some(now_ms / 1000 + 100),
                now_ms,
                &[],
                None,
                &r
            ),
            Votable::Ok
        );
    }

    #[test]
    fn role_requirement_any_vs_all() {
        let any = reqs_role_any(&["a", "b"]);
        assert_eq!(
            check_votable(Status::Open, None, 0, &ids(&["b"]), None, &any),
            Votable::Ok
        );
        assert_eq!(
            check_votable(Status::Open, None, 0, &ids(&["z"]), None, &any),
            Votable::MissingRoles
        );
        let all = Requirements {
            roles: roles(&["a", "b"]),
            require_all: true,
            min_account_age_days: 0,
        };
        assert_eq!(
            check_votable(Status::Open, None, 0, &ids(&["a"]), None, &all),
            Votable::MissingRoles
        );
        assert_eq!(
            check_votable(Status::Open, None, 0, &ids(&["a", "b"]), None, &all),
            Votable::Ok
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
        assert_eq!(
            check_votable(Status::Open, None, now, &[], Some(now - 3 * MS_PER_DAY), &r),
            Votable::AccountTooNew { needed_days: 7 }
        );
        assert_eq!(
            check_votable(
                Status::Open,
                None,
                now,
                &[],
                Some(now - 30 * MS_PER_DAY),
                &r
            ),
            Votable::Ok
        );
        // Unparseable creation time can't be enforced → admitted, not walled out.
        assert_eq!(
            check_votable(Status::Open, None, now, &[], None, &r),
            Votable::Ok
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

    // ── ballot validation ───────────────────────────────────────────────────
    #[test]
    fn sanitize_picks_accepts_known_keys_and_dedupes() {
        let options = vec![opt("a", "A"), opt("b", "B")];
        assert_eq!(
            sanitize_picks(&ids(&["b", "a", "b"]), &options, 2),
            Ok(ids(&["b", "a"]))
        );
    }

    #[test]
    fn sanitize_picks_refuses_forged_or_oversized_ballots() {
        let options = vec![opt("a", "A"), opt("b", "B"), opt("c", "C")];
        // A forged/stale value is refused outright — never partially counted.
        assert_eq!(
            sanitize_picks(&ids(&["a", "zzz"]), &options, 3),
            Err(PickError::Unknown)
        );
        assert_eq!(sanitize_picks(&[], &options, 3), Err(PickError::Empty));
        assert_eq!(
            sanitize_picks(&ids(&["a", "b"]), &options, 1),
            Err(PickError::TooMany { max: 1 })
        );
        // A zero max_choices (bad config) still admits a single pick.
        assert_eq!(sanitize_picks(&ids(&["a"]), &options, 0), Ok(ids(&["a"])));
    }

    #[test]
    fn labels_for_survives_a_removed_option() {
        let options = vec![opt("a", "Alpha")];
        assert_eq!(
            labels_for(&ids(&["a", "gone"]), &options),
            vec!["Alpha".to_string(), "an old option".to_string()]
        );
    }

    // ── results rendering ───────────────────────────────────────────────────
    fn vars(tallies: Vec<(PollOption, i64)>, status: Status, hide: bool) -> RenderVars {
        let votes = tallies.iter().map(|(_, n)| *n).sum();
        RenderVars {
            question: "What next?".into(),
            votes,
            tallies,
            status,
            hide_results: hide,
            ends_at: None,
        }
    }

    #[test]
    fn results_block_renders_bars_percentages_and_counts() {
        let v = vars(
            vec![(opt("a", "Movie night"), 3), (opt("b", "Game night"), 1)],
            Status::Open,
            false,
        );
        let block = results_block(&v);
        let lines: Vec<&str> = block.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("**Movie night**"), "{block}");
        assert!(lines[0].contains("75% (3)"), "{block}");
        assert!(
            lines[0].contains("\u{25B0}\u{25B0}\u{25B0}\u{25B0}\u{25B0}\u{25B0}\u{25B0}\u{25B1}"),
            "{block}"
        );
        assert!(lines[1].contains("25% (1)"), "{block}");
        // No crowns while open.
        assert!(!block.contains("\u{1F3C6}"), "{block}");
    }

    #[test]
    fn results_block_hides_open_hidden_polls_and_reveals_on_close() {
        let tallies = vec![(opt("a", "A"), 2), (opt("b", "B"), 1)];
        let open = vars(tallies.clone(), Status::Open, true);
        assert!(results_block(&open).contains("hidden until the poll closes"));
        assert_eq!(leader_label(&open), "hidden");
        let closed = vars(tallies, Status::Closed, true);
        let block = results_block(&closed);
        assert!(block.contains("**A**"), "{block}");
        // The closed leader is crowned.
        assert!(
            block.lines().next().unwrap().starts_with("\u{1F3C6} "),
            "{block}"
        );
        assert_eq!(leader_label(&closed), "**A**");
    }

    #[test]
    fn leader_reports_ties_and_tbd() {
        let none = vars(
            vec![(opt("a", "A"), 0), (opt("b", "B"), 0)],
            Status::Open,
            false,
        );
        assert_eq!(leader_label(&none), "TBD");
        let tied = vars(
            vec![(opt("a", "A"), 2), (opt("b", "B"), 2)],
            Status::Open,
            false,
        );
        assert_eq!(leader_label(&tied), "**A** & **B**");
    }

    #[test]
    fn zero_votes_renders_empty_bars_not_division_errors() {
        let v = vars(vec![(opt("a", "A"), 0)], Status::Open, false);
        let block = results_block(&v);
        assert!(block.contains("\u{25B1}\u{25B1}\u{25B1}\u{25B1}\u{25B1}\u{25B1}\u{25B1}\u{25B1}\u{25B1}\u{25B1} 0% (0)"), "{block}");
    }

    #[test]
    fn option_emoji_renders_unicode_and_custom_tokens() {
        let unicode = PollOption {
            emoji: Some(EmojiRef {
                id: None,
                name: Some("\u{1F37F}".into()),
                animated: false,
            }),
            ..opt("a", "Popcorn")
        };
        let custom = PollOption {
            emoji: Some(EmojiRef {
                id: Some("123".into()),
                name: Some("pog".into()),
                animated: true,
            }),
            ..opt("b", "Pog")
        };
        let v = vars(vec![(unicode, 1), (custom, 1)], Status::Open, false);
        let block = results_block(&v);
        assert!(block.contains("\u{1F37F} **Popcorn**"), "{block}");
        assert!(block.contains("<a:pog:123> **Pog**"), "{block}");
    }

    // ── placeholders ────────────────────────────────────────────────────────
    #[test]
    fn substitute_resolves_known_tokens_and_keeps_unknown() {
        let v = RenderVars {
            question: "Best snack?".into(),
            votes: 1234,
            tallies: vec![(opt("a", "Chips"), 1234)],
            status: Status::Open,
            hide_results: false,
            ends_at: Some(1_800_000_000),
        };
        assert_eq!(
            substitute(
                "{question} \u{B7} {votes} in \u{B7} {status} \u{B7} closes {closes}",
                &v
            ),
            "Best snack? \u{B7} 1,234 in \u{B7} open \u{B7} closes <t:1800000000:R>"
        );
        assert_eq!(
            substitute("{unknown} { b } stays", &v),
            "{unknown} { b } stays"
        );
    }

    #[test]
    fn closes_token_is_empty_without_a_deadline() {
        let v = vars(vec![(opt("a", "A"), 0)], Status::Open, false);
        assert_eq!(substitute("[{closes}]", &v), "[]");
    }

    // ── bound-component restyle ─────────────────────────────────────────────
    fn select_tree(id: &str) -> Value {
        json!([
            { "type": 17, "components": [
                { "type": 10, "content": "Vote! {results}" },
                { "type": 1, "components": [
                    { "type": 3, "custom_id": format!("poll:{id}"), "placeholder": "Cast your vote", "options": [
                        { "label": "A", "value": "a" }, { "label": "B", "value": "b" }
                    ]}
                ]}
            ]}
        ])
    }

    fn button_tree(id: &str) -> Value {
        json!([
            { "type": 17, "components": [
                { "type": 10, "content": "Vote! {results}" },
                { "type": 1, "components": [
                    { "type": 2, "style": 1, "label": "\u{1F5F3}\u{FE0F} Vote", "custom_id": format!("poll:{id}") }
                ]}
            ]}
        ])
    }

    #[test]
    fn restyle_patches_a_button_label_and_a_select_placeholder_by_kind() {
        let patch = BoundPatch {
            label: Some("Vote (3)".into()),
            placeholder: Some("Cast your vote \u{B7} 3 votes".into()),
            disabled: false,
        };
        let b = restyle_bound(&button_tree("x"), "poll:x", &patch);
        let btn = &b[0]["components"][1]["components"][0];
        assert_eq!(btn["label"], "Vote (3)");
        assert!(btn.get("placeholder").is_none());
        assert_eq!(btn["disabled"], false);

        let s = restyle_bound(&select_tree("x"), "poll:x", &patch);
        let sel = &s[0]["components"][1]["components"][0];
        assert_eq!(sel["placeholder"], "Cast your vote \u{B7} 3 votes");
        assert_eq!(sel["disabled"], false);
        // The wired options are preserved verbatim.
        assert_eq!(sel["options"][0]["value"], "a");
    }

    #[test]
    fn render_bound_message_substitutes_and_patches_the_bound_component() {
        let v = vars(
            vec![(opt("a", "A"), 2), (opt("b", "B"), 0)],
            Status::Open,
            false,
        );
        let patch = BoundPatch {
            label: None,
            placeholder: None,
            disabled: false,
        };
        let out = render_bound_message(&select_tree("abc"), &v, "poll:abc", &patch);
        let content = out[0]["components"][0]["content"].as_str().unwrap();
        assert!(content.contains("**A**"), "{content}");
        assert!(content.contains("100% (2)"), "{content}");
        // The author's own placeholder survives when the patch leaves it alone.
        let sel = &out[0]["components"][1]["components"][0];
        assert_eq!(sel["placeholder"], "Cast your vote");
        assert_eq!(sel["disabled"], false);
    }

    #[test]
    fn render_patches_the_component_even_with_a_stale_template_id() {
        // A freshly-attached template still carries the editor's default id; the
        // first bindable component is pinned to the real bound id on render.
        let tree = json!([
            { "type": 1, "components": [
                { "type": 3, "custom_id": "select_action", "options": [{ "label": "A", "value": "a" }] }
            ]}
        ]);
        let v = vars(vec![(opt("a", "A"), 0)], Status::Open, false);
        let patch = BoundPatch {
            label: None,
            placeholder: Some("Cast your vote \u{B7} 0 votes".into()),
            disabled: false,
        };
        let out = render_bound_message(&tree, &v, "poll:xyz", &patch);
        let sel = &out[0]["components"][0];
        assert_eq!(sel["custom_id"], "poll:xyz");
        assert_eq!(sel["placeholder"], "Cast your vote \u{B7} 0 votes");
    }

    #[test]
    fn template_button_label_only_reads_buttons() {
        assert_eq!(
            template_button_label(&button_tree("x")).as_deref(),
            Some("\u{1F5F3}\u{FE0F} Vote")
        );
        assert_eq!(template_button_label(&select_tree("x")), None);
    }

    #[test]
    fn update_component_response_preserves_v2_flag_and_drops_content() {
        let msg = MessageRef {
            content: Some(String::new()),
            components: Some(button_tree("xyz")),
            flags: Some(FLAG_IS_COMPONENTS_V2),
        };
        let patch = BoundPatch {
            label: Some("Vote (1)".into()),
            placeholder: None,
            disabled: false,
        };
        let v = update_component_response(&msg, "poll:xyz", &patch).unwrap();
        assert_eq!(v["type"], RESPONSE_UPDATE_MESSAGE);
        assert_eq!(v["data"]["flags"], FLAG_IS_COMPONENTS_V2);
        assert!(v["data"].get("content").is_none()); // V2 forbids content
        assert_eq!(
            v["data"]["components"][0]["components"][1]["components"][0]["label"],
            "Vote (1)"
        );
    }

    #[test]
    fn update_component_response_is_none_without_components() {
        let msg = MessageRef {
            content: Some("hi".into()),
            components: None,
            flags: None,
        };
        let patch = BoundPatch {
            label: None,
            placeholder: None,
            disabled: true,
        };
        assert!(update_component_response(&msg, "poll:xyz", &patch).is_none());
    }

    // ── live count suffixes ─────────────────────────────────────────────────
    #[test]
    fn label_with_count_appends_and_never_compounds() {
        assert_eq!(
            label_with_count("\u{1F5F3}\u{FE0F} Vote", 5),
            "\u{1F5F3}\u{FE0F} Vote (5)"
        );
        assert_eq!(
            label_with_count("\u{1F5F3}\u{FE0F} Vote (5)", 6),
            "\u{1F5F3}\u{FE0F} Vote (6)"
        );
        assert_eq!(label_with_count("Vote", 1234), "Vote (1,234)");
        assert_eq!(label_with_count("Vote (now)", 2), "Vote (now) (2)");
    }

    #[test]
    fn placeholder_with_count_appends_and_never_compounds() {
        assert_eq!(
            placeholder_with_count("Cast your vote", 1),
            "Cast your vote \u{B7} 1 vote"
        );
        assert_eq!(
            placeholder_with_count("Cast your vote \u{B7} 1 vote", 1234),
            "Cast your vote \u{B7} 1,234 votes"
        );
        // An empty live placeholder falls back to a sensible base.
        assert_eq!(
            placeholder_with_count("", 2),
            "Cast your vote \u{B7} 2 votes"
        );
        // A legitimate " · text" tail is preserved.
        assert_eq!(
            placeholder_with_count("Pick \u{B7} choose wisely", 2),
            "Pick \u{B7} choose wisely \u{B7} 2 votes"
        );
    }

    // ── panels & announcements ──────────────────────────────────────────────
    #[test]
    fn vote_panel_preselects_current_picks_and_offers_retract() {
        let options = vec![opt("a", "A"), opt("b", "B")];
        let v = vote_panel("abc", &options, 2, &ids(&["b"]), true, 7);
        let s = v.to_string();
        assert_eq!(v["type"], RESPONSE_CHANNEL_MESSAGE);
        assert!(s.contains("poll:pick:abc"), "{s}");
        assert!(s.contains("poll:retract:abc"), "{s}");
        let select = &v["data"]["components"][0]["components"][0];
        assert_eq!(select["max_values"], 2);
        assert_eq!(select["options"][1]["default"], true);
        assert!(select["options"][0].get("default").is_none());
    }

    #[test]
    fn vote_panel_clamps_max_choices_to_the_option_count() {
        let options = vec![opt("a", "A"), opt("b", "B")];
        let v = vote_panel("abc", &options, 25, &[], true, 0);
        assert_eq!(v["data"]["components"][0]["components"][0]["max_values"], 2);
    }

    #[test]
    fn confirmation_carries_change_controls_and_host_row_only_for_hosts() {
        let plain = vote_confirmation("abc", &["A".into()], 3, true, None);
        let s = plain.to_string();
        assert!(s.contains("poll:panel:abc"), "{s}");
        assert!(s.contains("poll:retract:abc"), "{s}");
        assert!(!s.contains("poll:close:abc"), "{s}");

        let host = vote_confirmation("abc", &["A".into()], 3, true, Some(Status::Open));
        let s = host.to_string();
        assert!(s.contains("poll:close:abc"), "{s}");
        assert!(s.contains("poll:results:abc"), "{s}");

        let locked = vote_confirmation("abc", &["A".into()], 3, false, None);
        assert!(locked["data"].get("components").is_none());
        assert!(locked.to_string().contains("locked"), "{locked}");
    }

    #[test]
    fn announcement_never_pings_and_substitutes_custom_templates() {
        let v = vars(
            vec![(opt("a", "A"), 2), (opt("b", "B"), 1)],
            Status::Closed,
            false,
        );
        let closed = results_announcement(&v, true, None);
        let text = closed["data"]["content"].as_str().unwrap();
        assert!(text.contains("Poll closed"), "{text}");
        assert!(text.contains("**A**"), "{text}");
        assert_eq!(
            closed["data"]["allowed_mentions"]["parse"]
                .as_array()
                .unwrap()
                .len(),
            0
        );

        let custom = results_announcement(&v, true, Some("Done! {leader} wins with {votes} in."));
        assert_eq!(
            custom["data"]["content"].as_str().unwrap(),
            "Done! **A** wins with 3 in."
        );

        let interim = results_announcement(&v, false, Some("ignored while open"));
        assert!(interim["data"]["content"]
            .as_str()
            .unwrap()
            .contains("still open"));
    }

    #[test]
    fn commas_groups_thousands() {
        assert_eq!(commas(0), "0");
        assert_eq!(commas(999), "999");
        assert_eq!(commas(1234), "1,234");
        assert_eq!(commas(1234567), "1,234,567");
    }
}
