//! Discord interaction protocol: signature verification, the request shapes we
//! read, the pure role-diff algorithm, and the callback JSON we send back.
//!
//! Signature verification is identical to the other DWEEB plugins. What's new
//! here is that a click leads to a Discord REST call (see `rest.rs`) — but the
//! *decision* of which roles to add/remove is a pure function (`plan_changes`)
//! of the member's current roles, the menu's managed roles, what they picked,
//! and the mode. Keeping it pure makes it trivially testable and keeps the
//! REST-touching code thin.

use std::collections::BTreeSet;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::store::{InstanceConfig, ManagedRole, Requirement, ResponseDef};

// Interaction request types.
pub const TYPE_PING: u8 = 1;
pub const TYPE_MESSAGE_COMPONENT: u8 = 3;

/// Discord's epoch (2015-01-01) in unix ms — the base for snowflake timestamps.
const DISCORD_EPOCH_MS: i64 = 1_420_070_400_000;
const MS_PER_DAY: i64 = 86_400_000;

/// Extract the creation time (unix ms) encoded in a Discord snowflake id. The
/// top 42 bits are a millisecond timestamp offset from Discord's epoch, so this
/// needs no API call. `None` if the id isn't a number.
pub fn snowflake_to_unix_ms(id: &str) -> Option<i64> {
    let raw: u64 = id.parse().ok()?;
    Some((raw >> 22) as i64 + DISCORD_EPOCH_MS)
}

// Interaction callback (response) types.
const RESPONSE_PONG: u8 = 1;
const RESPONSE_CHANNEL_MESSAGE: u8 = 4;

// Component / flag constants.
const COMPONENT_TYPE_BUTTON: u8 = 2;
const COMPONENT_TEXT_DISPLAY: u8 = 10;
const FLAG_EPHEMERAL: u64 = 1 << 6; // 64
const FLAG_IS_COMPONENTS_V2: u64 = 1 << 15; // 32768
/// Components V2 caps the total text across a message at this many characters.
const MAX_V2_TEXT: usize = 4000;

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
}

#[derive(Debug, Deserialize)]
pub struct InteractionData {
    #[serde(default)]
    pub custom_id: Option<String>,
    /// 2 = button, 3 = string select. Tells a button click apart from a select.
    #[serde(default)]
    pub component_type: Option<u8>,
    /// The option values a string select submitted (we set these = role ids).
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
}

#[derive(Debug, Deserialize, Clone)]
pub struct User {
    pub id: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub global_name: Option<String>,
}

impl Interaction {
    /// The clicking member's user id, however the payload carries it.
    pub fn actor_id(&self) -> Option<&str> {
        self.member
            .as_ref()
            .and_then(|m| m.user.as_ref())
            .or(self.user.as_ref())
            .map(|u| u.id.as_str())
    }

    pub fn actor_name(&self) -> String {
        self.member
            .as_ref()
            .and_then(|m| m.user.as_ref())
            .or(self.user.as_ref())
            .map(display_name)
            .unwrap_or_else(|| "a member".to_string())
    }

    pub fn is_button(&self) -> bool {
        self.data.as_ref().and_then(|d| d.component_type) == Some(COMPONENT_TYPE_BUTTON)
    }

    /// The role ids the member chose this click. For a button that's the whole
    /// managed set (the one button = its role); for a select it's the picked
    /// option values intersected with the managed set, so a crafted client
    /// can't smuggle in a role the menu doesn't manage.
    pub fn requested_roles(&self, managed: &BTreeSet<String>) -> BTreeSet<String> {
        if self.is_button() {
            return managed.clone();
        }
        let picked = self
            .data
            .as_ref()
            .and_then(|d| d.values.as_ref())
            .map(|v| v.iter().cloned().collect::<BTreeSet<_>>())
            .unwrap_or_default();
        picked.intersection(managed).cloned().collect()
    }
}

fn display_name(user: &User) -> String {
    user.global_name
        .clone()
        .or_else(|| user.username.clone())
        .unwrap_or_else(|| user.id.clone())
}

// ── Access gate (who may use the menu) ───────────────────────────────────────

/// Whether a member is allowed to operate the menu at all — each variant a
/// distinct, actionable denial. Mirrors the giveaway plugin's `Eligibility`.
#[derive(Debug, PartialEq, Eq)]
pub enum Access {
    Ok,
    /// The member lacks the required role(s).
    MissingRoles,
    /// The member's account isn't old enough.
    AccountTooNew {
        needed_days: u32,
    },
}

/// Decide whether a member may use the menu — pure, no I/O. Every input comes
/// from the interaction payload (the member's roles, their user-id snowflake)
/// or stored config, so the gate runs without a single Discord call.
pub fn check_access(
    member_roles: &[String],
    account_created_ms: Option<i64>,
    now_ms: i64,
    req: &Requirement,
) -> Access {
    if !req.roles.is_empty() {
        let have: BTreeSet<&str> = member_roles.iter().map(String::as_str).collect();
        let mut needed = req.roles.iter().map(|r| r.id.as_str());
        let ok = if req.require_all {
            needed.all(|r| have.contains(r))
        } else {
            needed.any(|r| have.contains(r))
        };
        if !ok {
            return Access::MissingRoles;
        }
    }
    if req.min_account_age_days > 0 {
        // If the id didn't parse we can't enforce the floor, so we let them in
        // rather than wall out a real member over a parsing quirk.
        if let Some(created) = account_created_ms {
            let age_days = (now_ms.saturating_sub(created)) / MS_PER_DAY;
            if age_days < req.min_account_age_days as i64 {
                return Access::AccountTooNew {
                    needed_days: req.min_account_age_days,
                };
            }
        }
    }
    Access::Ok
}

/// A plain-language reason for a denial, naming required role(s) as mentions
/// (which render as the role name). Only called for non-`Ok` access.
pub fn access_denied_message(req: &Requirement, access: &Access) -> String {
    match access {
        Access::Ok => String::new(),
        Access::AccountTooNew { needed_days } => format!(
            "\u{1F512} Your account is too new to use this — it has to be at least {needed_days} day{} old.",
            if *needed_days == 1 { "" } else { "s" }
        ),
        Access::MissingRoles => {
            let mentions: Vec<String> =
                req.roles.iter().map(|r| format!("<@&{}>", r.id)).collect();
            match (req.require_all, mentions.as_slice()) {
                (_, [one]) => format!("\u{1F512} You need the {one} role to use this."),
                (true, many) => {
                    format!("\u{1F512} You need all of these roles to use this: {}.", many.join(" "))
                }
                (false, many) => {
                    format!("\u{1F512} You need one of these roles to use this: {}.", many.join(" "))
                }
            }
        }
    }
}

// ── Pure role-diff planning ──────────────────────────────────────────────────

/// What a click should change. `add`/`remove` are disjoint. `blocked` are roles
/// the member asked to gain but a [`max`](InstanceConfig::max) cap refused — they
/// changed nothing, but the reply explains why (separate from a Discord refusal).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct RoleChanges {
    pub add: Vec<String>,
    pub remove: Vec<String>,
    pub blocked: Vec<String>,
}

impl RoleChanges {
    /// No role actually moved (a cap-blocked click is "empty" in this sense; the
    /// caller checks `blocked` separately to still explain it).
    pub fn is_empty(&self) -> bool {
        self.add.is_empty() && self.remove.is_empty()
    }
}

/// Decide the role changes for one click — pure, no I/O.
///
/// * `managed`   every role id this menu controls.
/// * `current`   role ids the member already has (from the interaction).
/// * `requested` the managed roles they asked for this click (see
///   [`Interaction::requested_roles`]).
/// * `mode`      one of `toggle` / `add` / `remove` (what a click *attempts*).
/// * `max`       the most managed roles the member may hold from this menu:
///   `None` = unlimited; `Some(1)` = swap/pick-one; `Some(n≥2)` = a cap.
///
/// Behaviour:
/// * `toggle`  flip each requested role.
/// * `add`     give each requested role they lack (never removes).
/// * `remove`  take each requested role they have (never adds).
///
/// Then `max` is applied to the *adding* modes (`toggle`/`add`):
/// * `Some(1)` → **swap**: their managed roles become exactly `requested` —
///   gaining the pick evicts the other managed roles. With a one-choice select
///   this is "swap to this role" (colour / region / pronoun pickers). This is
///   the modern form of the old `unique` mode.
/// * `Some(n≥2)` → **cap**: if the click would leave them holding more than `n`
///   managed roles, none of its adds are applied — they land in `blocked` so the
///   reply can say "you can hold at most n; remove one first". Removes still go.
pub fn plan_changes(
    managed: &BTreeSet<String>,
    current: &BTreeSet<String>,
    requested: &BTreeSet<String>,
    mode: &str,
    max: Option<usize>,
) -> RoleChanges {
    let mut changes = RoleChanges::default();
    match mode {
        "add" => {
            for r in requested {
                if !current.contains(r) {
                    changes.add.push(r.clone());
                }
            }
        }
        "remove" => {
            for r in requested {
                if current.contains(r) {
                    changes.remove.push(r.clone());
                }
            }
        }
        // Default: "toggle".
        _ => {
            for r in requested {
                if current.contains(r) {
                    changes.remove.push(r.clone());
                } else {
                    changes.add.push(r.clone());
                }
            }
        }
    }

    // `remove` only ever takes roles away, so a "hold at most n" cap is moot.
    let adds_allowed = mode != "remove";
    let held_managed = current.intersection(managed).count();
    match max {
        Some(1) if adds_allowed => {
            // Swap: the managed roles they end up with are exactly `requested`.
            // Recompute from scratch so re-clicking the held pick is a no-op
            // (you switch within the menu, you don't fall back to zero).
            changes.add = requested.difference(current).cloned().collect();
            changes.remove = current
                .intersection(managed)
                .filter(|r| !requested.contains(*r))
                .cloned()
                .collect();
        }
        Some(n) if n >= 2 && adds_allowed => {
            let after_removes = held_managed - changes.remove.len();
            if after_removes + changes.add.len() > n {
                // Over the cap — refuse every add on this click (we can't pick
                // which of the already-held roles to evict). Removes still land.
                changes.blocked = std::mem::take(&mut changes.add);
            }
        }
        _ => {}
    }
    changes
}

// ── Outgoing callbacks ───────────────────────────────────────────────────────

pub fn pong() -> Value {
    json!({ "type": RESPONSE_PONG })
}

/// An ephemeral reply, always Components V2: the text rides in a Text Display
/// rather than the plain `content` field (which V2 forbids).
pub fn ephemeral_text(content: &str) -> Value {
    json!({
        "type": RESPONSE_CHANNEL_MESSAGE,
        "data": {
            "flags": FLAG_IS_COMPONENTS_V2 | FLAG_EPHEMERAL,
            "components": [{ "type": COMPONENT_TEXT_DISPLAY, "content": clamp(content, MAX_V2_TEXT) }],
        }
    })
}

/// Look up a managed role's display name, falling back to a mention so the user
/// still sees *which* role even if the cached name is stale/empty.
fn role_label(roles: &[ManagedRole], id: &str) -> String {
    roles
        .iter()
        .find(|r| r.id == id)
        .map(|r| {
            if r.name.trim().is_empty() {
                format!("<@&{id}>")
            } else {
                format!("**{}**", r.name)
            }
        })
        .unwrap_or_else(|| format!("<@&{id}>"))
}

/// Build the ephemeral confirmation after a (possibly partial) change.
///
/// `added`/`removed` are the role ids that actually changed. `denied` are ones
/// Discord refused (almost always role hierarchy), `busy` are ones a transient
/// error (rate-limit / 5xx / network) stopped, and `blocked` are adds a `max`
/// cap refused — each gets its own plain-language line, because "nothing
/// happened," or the *wrong* reason for it, is the most confusing outcome for a
/// self-role menu. When the menu grants temporary roles, `expires_at_unix` (the
/// removal time, unix seconds) is appended to the "Added …" line.
pub fn build_reply(
    cfg: &InstanceConfig,
    added: &[String],
    removed: &[String],
    denied: &[String],
    busy: &[String],
    blocked: &[String],
    expires_at_unix: Option<i64>,
) -> Value {
    let mut lines: Vec<String> = Vec::new();

    // A custom message replaces the auto summary of *what* changed, but a
    // hierarchy failure is always reported — it's actionable, not cosmetic.
    let custom = match (cfg.response.mode.as_str(), cfg.response.text.as_deref()) {
        ("custom", Some(t)) if !t.trim().is_empty() => Some(t.trim()),
        _ => None,
    };

    // A relative-time suffix ("expires in 2 hours") for granted temporary roles.
    let expiry_suffix = match expires_at_unix {
        Some(ts) if !added.is_empty() => format!(" \u{2014} expires <t:{ts}:R>"),
        _ => String::new(),
    };

    if let Some(text) = custom {
        if !added.is_empty() || !removed.is_empty() {
            lines.push(text.to_string());
        }
    } else {
        if !added.is_empty() {
            let names: Vec<String> = added.iter().map(|id| role_label(&cfg.roles, id)).collect();
            lines.push(format!(
                "\u{2705} Added {}{}",
                join_human(&names),
                expiry_suffix
            ));
        }
        if !removed.is_empty() {
            let names: Vec<String> = removed
                .iter()
                .map(|id| role_label(&cfg.roles, id))
                .collect();
            lines.push(format!("\u{274C} Removed {}", join_human(&names)));
        }
    }

    if !blocked.is_empty() {
        let names: Vec<String> = blocked
            .iter()
            .map(|id| role_label(&cfg.roles, id))
            .collect();
        let cap = cfg.max.unwrap_or(0);
        lines.push(format!(
            "\u{26A0}\u{FE0F} You can hold at most **{cap}** role{} from this menu, so I didn't add {} — remove one first.",
            if cap == 1 { "" } else { "s" },
            join_human(&names)
        ));
    }

    if !denied.is_empty() {
        let names: Vec<String> = denied.iter().map(|id| role_label(&cfg.roles, id)).collect();
        lines.push(format!(
            "\u{26A0}\u{FE0F} I couldn't change {} — my role must sit **above** it and I need the **Manage Roles** permission. Ask an admin to move my role up.",
            join_human(&names)
        ));
    }

    if !busy.is_empty() {
        let names: Vec<String> = busy.iter().map(|id| role_label(&cfg.roles, id)).collect();
        lines.push(format!(
            "\u{26A0}\u{FE0F} Discord was busy and I couldn't finish {} — give it a moment and click again.",
            join_human(&names)
        ));
    }

    if lines.is_empty() {
        // Genuinely nothing to do (e.g. toggled off then on within the managed
        // set, or an add-only role they already had).
        return ephemeral_text("No changes \u{2014} you're all set. \u{1F44C}");
    }

    ephemeral_text(&lines.join("\n"))
}

/// Join names as "A", "A and B", or "A, B and C".
fn join_human(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [a] => a.clone(),
        [a, b] => format!("{a} and {b}"),
        [rest @ .., last] => format!("{} and {}", rest.join(", "), last),
    }
}

/// Default summary text helper used when `ResponseDef` is left at its default.
#[allow(dead_code)]
pub fn default_response() -> ResponseDef {
    ResponseDef::default()
}

/// Truncate to at most `max` characters (respecting char boundaries).
fn clamp(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(ids: &[&str]) -> BTreeSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }
    /// Sort so assertions don't depend on iteration order.
    fn sorted(v: Vec<String>) -> Vec<String> {
        let mut v = v;
        v.sort();
        v
    }

    fn mrole(id: &str, name: &str) -> ManagedRole {
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

    /// A minimal config whose only meaningful field for reply tests is `roles`.
    fn cfg_with(roles: Vec<ManagedRole>, max: Option<u32>) -> InstanceConfig {
        InstanceConfig {
            target: "string_select".into(),
            guild_id: "1".repeat(18),
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

    fn reqs(ids: &[&str], all: bool, age: u32) -> Requirement {
        Requirement {
            roles: ids
                .iter()
                .map(|id| crate::store::RoleRef {
                    id: (*id).into(),
                    name: String::new(),
                    color: 0,
                })
                .collect(),
            require_all: all,
            min_account_age_days: age,
        }
    }

    #[test]
    fn toggle_flips_each_requested_role() {
        let managed = set(&["a", "b", "c"]);
        let current = set(&["a"]); // member already has `a`
        let requested = set(&["a", "b"]); // they clicked a + b
        let c = plan_changes(&managed, &current, &requested, "toggle", None);
        assert_eq!(sorted(c.add), vec!["b"]); // didn't have b → add
        assert_eq!(sorted(c.remove), vec!["a"]); // had a → remove
    }

    #[test]
    fn add_only_never_removes() {
        let managed = set(&["a", "b"]);
        let current = set(&["a"]);
        let requested = set(&["a", "b"]);
        let c = plan_changes(&managed, &current, &requested, "add", None);
        assert_eq!(sorted(c.add), vec!["b"]);
        assert!(c.remove.is_empty());
    }

    #[test]
    fn remove_only_never_adds() {
        let managed = set(&["a", "b"]);
        let current = set(&["a"]);
        let requested = set(&["a", "b"]);
        let c = plan_changes(&managed, &current, &requested, "remove", None);
        assert!(c.add.is_empty());
        assert_eq!(sorted(c.remove), vec!["a"]); // only the one they had
    }

    #[test]
    fn max_one_swaps_like_the_old_unique_mode() {
        let managed = set(&["red", "green", "blue"]);
        let current = set(&["red"]); // currently red
        let requested = set(&["blue"]); // picked blue
        let c = plan_changes(&managed, &current, &requested, "toggle", Some(1));
        assert_eq!(sorted(c.add), vec!["blue"]); // gain the pick
        assert_eq!(sorted(c.remove), vec!["red"]); // drop the other managed role
        assert!(c.blocked.is_empty());
    }

    #[test]
    fn max_one_leaves_unmanaged_roles_untouched() {
        let managed = set(&["red", "green"]);
        let current = set(&["red", "moderator"]); // moderator is NOT managed
        let requested = set(&["green"]);
        let c = plan_changes(&managed, &current, &requested, "toggle", Some(1));
        assert_eq!(sorted(c.add), vec!["green"]);
        assert_eq!(sorted(c.remove), vec!["red"]); // moderator is never removed
    }

    #[test]
    fn max_one_reclicking_the_held_pick_is_a_noop() {
        // Swap never drops you back to zero — clicking your current pick keeps it.
        let managed = set(&["red", "green"]);
        let current = set(&["red"]);
        let requested = set(&["red"]);
        let c = plan_changes(&managed, &current, &requested, "toggle", Some(1));
        assert!(c.is_empty());
    }

    #[test]
    fn cap_blocks_an_add_past_the_limit_but_keeps_removes() {
        // Holding 2 of a max-2 menu; picking a 3rd is refused, not silently
        // dropped. The 3rd lands in `blocked`; nothing is added.
        let managed = set(&["a", "b", "c", "d"]);
        let current = set(&["a", "b"]);
        let requested = set(&["c"]);
        let c = plan_changes(&managed, &current, &requested, "add", Some(2));
        assert!(c.add.is_empty());
        assert_eq!(c.blocked, vec!["c"]);
    }

    #[test]
    fn cap_allows_an_add_that_fits_under_the_limit() {
        let managed = set(&["a", "b", "c"]);
        let current = set(&["a"]);
        let requested = set(&["b"]);
        let c = plan_changes(&managed, &current, &requested, "add", Some(2));
        assert_eq!(c.add, vec!["b"]);
        assert!(c.blocked.is_empty());
    }

    #[test]
    fn cap_lets_a_swap_in_one_click_stay_within_the_limit() {
        // Toggle at the cap: removing one and adding another in the same click
        // nets to the same count, so it's allowed.
        let managed = set(&["a", "b", "c"]);
        let current = set(&["a", "b"]);
        let requested = set(&["a", "c"]); // drop a, gain c
        let c = plan_changes(&managed, &current, &requested, "toggle", Some(2));
        assert_eq!(sorted(c.add), vec!["c"]);
        assert_eq!(sorted(c.remove), vec!["a"]);
        assert!(c.blocked.is_empty());
    }

    #[test]
    fn no_op_when_nothing_changes() {
        let managed = set(&["a"]);
        let current = set(&["a"]);
        let requested = set(&["a"]);
        let c = plan_changes(&managed, &current, &requested, "add", None);
        assert!(c.is_empty());
    }

    #[test]
    fn access_gate_any_vs_all_roles() {
        let member = ["a".to_string()];
        // ANY of {a,b}: holding a passes.
        assert_eq!(
            check_access(&member, None, 0, &reqs(&["a", "b"], false, 0)),
            Access::Ok
        );
        // ALL of {a,b}: holding only a fails.
        assert_eq!(
            check_access(&member, None, 0, &reqs(&["a", "b"], true, 0)),
            Access::MissingRoles
        );
        // No requirement: anyone passes.
        assert_eq!(
            check_access(&[], None, 0, &Requirement::default()),
            Access::Ok
        );
    }

    #[test]
    fn access_gate_account_age_floor() {
        let now = 100 * MS_PER_DAY;
        let r = reqs(&[], false, 7);
        // 3-day-old account is walled out…
        assert!(matches!(
            check_access(&[], Some(now - 3 * MS_PER_DAY), now, &r),
            Access::AccountTooNew { needed_days: 7 }
        ));
        // …a 30-day-old one is fine.
        assert_eq!(
            check_access(&[], Some(now - 30 * MS_PER_DAY), now, &r),
            Access::Ok
        );
    }

    #[test]
    fn snowflake_decodes_to_a_creation_time() {
        assert_eq!(snowflake_to_unix_ms("0"), Some(DISCORD_EPOCH_MS));
        let id = 175928847299117063u64;
        assert_eq!(
            snowflake_to_unix_ms(&id.to_string()),
            Some((id >> 22) as i64 + DISCORD_EPOCH_MS)
        );
        assert_eq!(snowflake_to_unix_ms("not-a-number"), None);
    }

    fn reply_text(v: &Value) -> String {
        v["data"]["components"][0]["content"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn reply_separates_denied_from_busy() {
        let id = "1".repeat(18);
        let cfg = cfg_with(vec![mrole(&id, "Red")], None);
        // A refusal blames hierarchy; a transient blip tells them to retry.
        let denied = build_reply(&cfg, &[], &[], std::slice::from_ref(&id), &[], &[], None);
        assert!(reply_text(&denied).contains("above"));
        let busy = build_reply(&cfg, &[], &[], &[], std::slice::from_ref(&id), &[], None);
        assert!(reply_text(&busy).contains("busy"));
    }

    #[test]
    fn reply_reports_a_cap_block() {
        let id = "1".repeat(18);
        let cfg = cfg_with(vec![mrole(&id, "Red")], Some(2));
        let v = build_reply(&cfg, &[], &[], &[], &[], std::slice::from_ref(&id), None);
        let t = reply_text(&v);
        assert!(t.contains("at most"));
        assert!(t.contains("2"));
    }

    #[test]
    fn reply_appends_expiry_to_added_roles() {
        let id = "1".repeat(18);
        let cfg = cfg_with(vec![mrole(&id, "Red")], None);
        let v = build_reply(
            &cfg,
            std::slice::from_ref(&id),
            &[],
            &[],
            &[],
            &[],
            Some(1_700_000_000),
        );
        let t = reply_text(&v);
        assert!(t.contains("Added"));
        assert!(t.contains("<t:1700000000:R>"));
    }
}
