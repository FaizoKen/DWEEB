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

use crate::store::{InstanceConfig, ManagedRole, ResponseDef};

// Interaction request types.
pub const TYPE_PING: u8 = 1;
pub const TYPE_MESSAGE_COMPONENT: u8 = 3;

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
    let pk: [u8; 32] = match hex::decode(public_key_hex).ok().and_then(|b| b.try_into().ok()) {
        Some(arr) => arr,
        None => return false,
    };
    let verifying_key = match VerifyingKey::from_bytes(&pk) {
        Ok(k) => k,
        Err(_) => return false,
    };
    let sig: [u8; 64] = match hex::decode(signature_hex).ok().and_then(|b| b.try_into().ok()) {
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
pub fn attested_key<'h>(headers: &'h axum::http::HeaderMap, secret: Option<&str>) -> Option<&'h str> {
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
        self.data
            .as_ref()
            .and_then(|d| d.component_type)
            == Some(COMPONENT_TYPE_BUTTON)
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

// ── Pure role-diff planning ──────────────────────────────────────────────────

/// What a click should change. Disjoint sets: a role is never in both.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct RoleChanges {
    pub add: Vec<String>,
    pub remove: Vec<String>,
}

impl RoleChanges {
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
/// * `mode`      one of `toggle` / `add` / `remove` / `unique`.
///
/// `toggle`  flip each requested role.
/// `add`     give each requested role they lack (never removes).
/// `remove`  take each requested role they have (never adds).
/// `unique`  their managed roles become exactly `requested` — give the picked
///           ones they lack, take the managed ones they didn't pick. With a
///           one-choice select this is "swap to this role"; the natural fit for
///           colour / region / pronoun pickers.
pub fn plan_changes(
    managed: &BTreeSet<String>,
    current: &BTreeSet<String>,
    requested: &BTreeSet<String>,
    mode: &str,
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
        "unique" => {
            for r in requested {
                if !current.contains(r) {
                    changes.add.push(r.clone());
                }
            }
            for r in managed.difference(requested) {
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
/// Discord refused (almost always role hierarchy) and `busy` are ones a
/// transient error (rate-limit / 5xx / network) stopped — each gets its own
/// plain-language line, because "nothing happened," or the *wrong* reason for
/// it, is the most confusing outcome for a self-role menu.
pub fn build_reply(
    cfg: &InstanceConfig,
    added: &[String],
    removed: &[String],
    denied: &[String],
    busy: &[String],
) -> Value {
    let mut lines: Vec<String> = Vec::new();

    // A custom message replaces the auto summary of *what* changed, but a
    // hierarchy failure is always reported — it's actionable, not cosmetic.
    let custom = match (cfg.response.mode.as_str(), cfg.response.text.as_deref()) {
        ("custom", Some(t)) if !t.trim().is_empty() => Some(t.trim()),
        _ => None,
    };

    if let Some(text) = custom {
        if !added.is_empty() || !removed.is_empty() {
            lines.push(text.to_string());
        }
    } else {
        if !added.is_empty() {
            let names: Vec<String> = added.iter().map(|id| role_label(&cfg.roles, id)).collect();
            lines.push(format!("\u{2705} Added {}", join_human(&names)));
        }
        if !removed.is_empty() {
            let names: Vec<String> = removed.iter().map(|id| role_label(&cfg.roles, id)).collect();
            lines.push(format!("\u{274C} Removed {}", join_human(&names)));
        }
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

    #[test]
    fn toggle_flips_each_requested_role() {
        let managed = set(&["a", "b", "c"]);
        let current = set(&["a"]); // member already has `a`
        let requested = set(&["a", "b"]); // they clicked a + b
        let c = plan_changes(&managed, &current, &requested, "toggle");
        assert_eq!(sorted(c.add), vec!["b"]); // didn't have b → add
        assert_eq!(sorted(c.remove), vec!["a"]); // had a → remove
    }

    #[test]
    fn add_only_never_removes() {
        let managed = set(&["a", "b"]);
        let current = set(&["a"]);
        let requested = set(&["a", "b"]);
        let c = plan_changes(&managed, &current, &requested, "add");
        assert_eq!(sorted(c.add), vec!["b"]);
        assert!(c.remove.is_empty());
    }

    #[test]
    fn remove_only_never_adds() {
        let managed = set(&["a", "b"]);
        let current = set(&["a"]);
        let requested = set(&["a", "b"]);
        let c = plan_changes(&managed, &current, &requested, "remove");
        assert!(c.add.is_empty());
        assert_eq!(sorted(c.remove), vec!["a"]); // only the one they had
    }

    #[test]
    fn unique_makes_managed_roles_equal_the_picks() {
        let managed = set(&["red", "green", "blue"]);
        let current = set(&["red"]); // currently red
        let requested = set(&["blue"]); // picked blue
        let c = plan_changes(&managed, &current, &requested, "unique");
        assert_eq!(sorted(c.add), vec!["blue"]); // gain the pick
        assert_eq!(sorted(c.remove), vec!["red"]); // drop the other managed role
    }

    #[test]
    fn unique_leaves_unmanaged_roles_untouched() {
        let managed = set(&["red", "green"]);
        let current = set(&["red", "moderator"]); // moderator is NOT managed
        let requested = set(&["green"]);
        let c = plan_changes(&managed, &current, &requested, "unique");
        assert_eq!(sorted(c.add), vec!["green"]);
        assert_eq!(sorted(c.remove), vec!["red"]); // moderator is never removed
    }

    #[test]
    fn no_op_when_nothing_changes() {
        let managed = set(&["a"]);
        let current = set(&["a"]);
        let requested = set(&["a"]);
        let c = plan_changes(&managed, &current, &requested, "add");
        assert!(c.is_empty());
    }

    #[test]
    fn reply_separates_denied_from_busy() {
        let id = "1".repeat(18);
        let cfg = InstanceConfig {
            target: "button".into(),
            guild_id: id.clone(),
            guild_name: String::new(),
            roles: vec![ManagedRole { id: id.clone(), name: "Red".into(), color: 0 }],
            mode: "toggle".into(),
            response: ResponseDef::default(),
        };
        let text = |v: &Value| {
            v["data"]["components"][0]["content"]
                .as_str()
                .unwrap()
                .to_string()
        };
        // A refusal blames hierarchy; a transient blip tells them to retry.
        let denied = build_reply(&cfg, &[], &[], std::slice::from_ref(&id), &[]);
        assert!(text(&denied).contains("above"));
        let busy = build_reply(&cfg, &[], &[], &[], std::slice::from_ref(&id));
        assert!(text(&busy).contains("busy"));
    }
}
