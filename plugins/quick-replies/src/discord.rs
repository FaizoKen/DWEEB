//! Discord interaction protocol: signature verification, the request shapes we
//! read, the **pure** decision/builder logic, and the callback JSON we send back.
//!
//! A quick-reply click does no I/O: everything that *decides what to send* — the
//! `{user}`/`{server}` substitution, whether a member may use a role-gated reply,
//! and the Components V2 message that goes back — is a pure function here, so it
//! is exhaustively unit-tested. `routes.rs` is the thin shell that loads the
//! config and picks which reply a click maps to.

use std::collections::BTreeSet;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::store::{QuickReply, RoleRef};

// Interaction request types.
pub const TYPE_PING: u8 = 1;
pub const TYPE_MESSAGE_COMPONENT: u8 = 3;

// Interaction callback (response) types.
const RESPONSE_PONG: u8 = 1;
const RESPONSE_CHANNEL_MESSAGE: u8 = 4;

// Component / flag constants.
const COMPONENT_TYPE_BUTTON: u8 = 2;
const COMPONENT_TEXT_DISPLAY: u8 = 10;
const COMPONENT_CONTAINER: u8 = 17;
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
    /// The option values a string select submitted (we set these = reply keys).
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

    /// The clicking member's display name (global name, else username, else id).
    pub fn actor_name(&self) -> String {
        self.member
            .as_ref()
            .and_then(|m| m.user.as_ref())
            .or(self.user.as_ref())
            .map(display_name)
            .unwrap_or_else(|| "there".to_string())
    }

    /// The clicking member's role ids (empty outside a guild).
    pub fn actor_roles(&self) -> &[String] {
        self.member
            .as_ref()
            .map(|m| m.roles.as_slice())
            .unwrap_or(&[])
    }

    pub fn custom_id(&self) -> &str {
        self.data
            .as_ref()
            .and_then(|d| d.custom_id.as_deref())
            .unwrap_or_default()
    }

    pub fn is_button(&self) -> bool {
        self.data.as_ref().and_then(|d| d.component_type) == Some(COMPONENT_TYPE_BUTTON)
    }

    /// The option values a string select submitted (empty for a button).
    pub fn picked_values(&self) -> &[String] {
        self.data
            .as_ref()
            .and_then(|d| d.values.as_deref())
            .unwrap_or(&[])
    }
}

fn display_name(user: &User) -> String {
    user.global_name
        .clone()
        .or_else(|| user.username.clone())
        .unwrap_or_else(|| user.id.clone())
}

// ── Pure: variable substitution ──────────────────────────────────────────────

/// The values a reply's `{...}` variables resolve to for one click. Built from
/// the interaction payload (+ the instance's cached guild name) — no Discord
/// call.
pub struct ReplyContext {
    /// The clicking member's user id, for the `{user}` mention.
    pub user_id: String,
    /// Their display name, for `{username}`.
    pub user_name: String,
    /// The server name, for `{server}`.
    pub server_name: String,
}

/// Substitute the supported variables in `text`. Unknown `{...}` tokens are left
/// untouched, so an admin's literal braces survive.
///
/// `{username}` is replaced **before** `{user}` on purpose: `{user}` is a prefix
/// of `{username}`, so doing it the other way would corrupt the longer token.
pub fn substitute(text: &str, ctx: &ReplyContext) -> String {
    text.replace("{username}", &ctx.user_name)
        .replace("{user}", &format!("<@{}>", ctx.user_id))
        .replace("{server}", &ctx.server_name)
}

// ── Pure: role-gate decision ─────────────────────────────────────────────────

/// Whether a member may use this reply. A reply with no `allowed_roles` is open
/// to everyone; otherwise the member must hold **any one** of the allowed roles.
/// Trust is re-derived from the member's payload roles — never from a
/// client-supplied claim.
pub fn reply_allowed(allowed_roles: &[RoleRef], member_roles: &BTreeSet<String>) -> bool {
    if allowed_roles.is_empty() {
        return true;
    }
    allowed_roles.iter().any(|r| member_roles.contains(&r.id))
}

// ── Outgoing callbacks ───────────────────────────────────────────────────────

pub fn pong() -> Value {
    json!({ "type": RESPONSE_PONG })
}

/// A bare ephemeral text reply (Components V2: the text rides in a Text Display,
/// since V2 forbids the plain `content` field). Used for the not-found / gate /
/// error notices.
pub fn ephemeral_text(content: &str) -> Value {
    json!({
        "type": RESPONSE_CHANNEL_MESSAGE,
        "data": {
            "flags": FLAG_IS_COMPONENTS_V2 | FLAG_EPHEMERAL,
            "components": [{ "type": COMPONENT_TEXT_DISPLAY, "content": clamp(content, MAX_V2_TEXT) }],
        }
    })
}

/// Build the configured reply for one click — pure. A reply is either a DWEEB
/// **saved message** (a Components V2 payload, used as-is with its `{...}`
/// variables substituted) or a typed title/body that rides in a Components V2
/// Container (a tidy card); either way it is ephemeral or public per the reply's
/// setting.
///
/// `allowed_mentions` pins the only ping that may fire to the clicker
/// themselves (so a `{user}` greeting works), while `parse: []` neutralises any
/// `@everyone`/`@here`/role mention a stray name, pasted link, or saved-message
/// body might carry — a public reply must never let arbitrary text ping the
/// channel.
pub fn build_reply(reply: &QuickReply, ctx: &ReplyContext) -> Value {
    let mut flags = FLAG_IS_COMPONENTS_V2;
    if reply.ephemeral {
        flags |= FLAG_EPHEMERAL;
    }

    // A saved message takes priority over the typed title/body: send its own
    // Components V2 layout, with every text node's `{...}` variables substituted.
    if let Some(components) = saved_components(reply, ctx) {
        return json!({
            "type": RESPONSE_CHANNEL_MESSAGE,
            "data": {
                "flags": flags,
                "allowed_mentions": { "parse": [], "users": [ctx.user_id] },
                "components": components,
            }
        });
    }

    let mut text = String::new();
    if let Some(title) = reply
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        text.push_str("### ");
        text.push_str(&substitute(title, ctx));
        text.push('\n');
    }
    text.push_str(&substitute(&reply.body, ctx));

    json!({
        "type": RESPONSE_CHANNEL_MESSAGE,
        "data": {
            "flags": flags,
            "allowed_mentions": { "parse": [], "users": [ctx.user_id] },
            "components": [{
                "type": COMPONENT_CONTAINER,
                "components": [{
                    "type": COMPONENT_TEXT_DISPLAY,
                    "content": clamp(&text, MAX_V2_TEXT),
                }],
            }],
        }
    })
}

/// The saved message's `components`, with this click's variables substituted —
/// or `None` if the reply has no usable saved payload (so the caller falls back
/// to the typed body). We only treat a payload as a saved message when it
/// carries a **non-empty** `components` array (matching the Components V2 shape
/// DWEEB hands over); a `content`/`embeds`-only payload is ignored, since a V2
/// interaction response can't carry those fields.
fn saved_components(reply: &QuickReply, ctx: &ReplyContext) -> Option<Value> {
    let components = reply.payload.as_ref()?.get("components")?;
    if components.as_array().is_none_or(|a| a.is_empty()) {
        return None;
    }
    let mut components = components.clone();
    substitute_in_content(&mut components, ctx);
    Some(components)
}

/// Recursively substitute `{user}`/`{username}`/`{server}` into every Components
/// V2 **`content`** string (Text Displays, container/section text). Only
/// `content` is touched on purpose — URLs, `custom_id`s and other machine fields
/// live under different keys, so a `{token}` there is never mangled, and a saved
/// message can greet the clicker the same way a typed one does.
fn substitute_in_content(value: &mut Value, ctx: &ReplyContext) {
    match value {
        Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                if k == "content" {
                    if let Value::String(s) = v {
                        *s = substitute(s, ctx);
                        continue;
                    }
                }
                substitute_in_content(v, ctx);
            }
        }
        Value::Array(items) => {
            for item in items {
                substitute_in_content(item, ctx);
            }
        }
        _ => {}
    }
}

/// The ephemeral notice a member gets when they use a reply they're not allowed
/// to — names the gating role(s) so they know what they'd need. Always
/// ephemeral, so a denial never clutters the channel.
pub fn gate_denied(allowed_roles: &[RoleRef]) -> Value {
    let mentions: Vec<String> = allowed_roles
        .iter()
        .map(|r| format!("<@&{}>", r.id))
        .collect();
    let who = match mentions.as_slice() {
        [] => "members with the right role".to_string(), // unreachable (gate only set with roles)
        many => join_human(many),
    };
    ephemeral_text(&format!(
        "\u{1F512} This reply is only for {who}. If you think that's a mistake, ask a moderator."
    ))
}

/// Join names as "A", "A or B", or "A, B or C" — phrased for "any one of".
fn join_human(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [a] => a.clone(),
        [a, b] => format!("{a} or {b}"),
        [rest @ .., last] => format!("{} or {}", rest.join(", "), last),
    }
}

/// Truncate to at most `max` characters (respecting char boundaries).
fn clamp(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> ReplyContext {
        ReplyContext {
            user_id: "42".into(),
            user_name: "Ada".into(),
            server_name: "Cool Server".into(),
        }
    }

    fn roles(ids: &[&str]) -> Vec<RoleRef> {
        ids.iter()
            .map(|id| RoleRef {
                id: id.to_string(),
                name: format!("Role {id}"),
                color: 0,
            })
            .collect()
    }

    fn set(ids: &[&str]) -> BTreeSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    fn reply(body: &str) -> QuickReply {
        QuickReply {
            key: "k1".into(),
            label: "Topic".into(),
            emoji: None,
            emoji_id: None,
            emoji_animated: None,
            description: None,
            title: None,
            payload: None,
            body: body.into(),
            ephemeral: true,
            allowed_roles: vec![],
        }
    }

    // ── substitution ────────────────────────────────────────────────────────
    #[test]
    fn substitute_fills_each_variable() {
        let out = substitute("Hi {user} ({username}) — welcome to {server}!", &ctx());
        assert_eq!(out, "Hi <@42> (Ada) — welcome to Cool Server!");
    }

    #[test]
    fn substitute_handles_username_before_user_prefix() {
        // {user} is a prefix of {username}; the longer token must win, not get
        // mangled into "<@42>name}".
        assert_eq!(substitute("{username}", &ctx()), "Ada");
        assert_eq!(substitute("{user}", &ctx()), "<@42>");
    }

    #[test]
    fn substitute_leaves_unknown_tokens_and_repeats_all() {
        let out = substitute("{user} {user} {bogus}", &ctx());
        assert_eq!(out, "<@42> <@42> {bogus}");
    }

    // ── role gate ─────────────────────────────────────────────────────────────
    #[test]
    fn no_gate_means_everyone() {
        assert!(reply_allowed(&[], &set(&[])));
        assert!(reply_allowed(&[], &set(&["999"])));
    }

    #[test]
    fn gate_admits_on_any_one_role_and_denies_otherwise() {
        let gate = roles(&["a", "b"]);
        assert!(reply_allowed(&gate, &set(&["b"]))); // has one → in
        assert!(reply_allowed(&gate, &set(&["x", "a"]))); // has one of several → in
        assert!(!reply_allowed(&gate, &set(&["x", "y"]))); // has none → out
        assert!(!reply_allowed(&gate, &set(&[]))); // no roles at all → out
    }

    // ── reply builder ──────────────────────────────────────────────────────────
    fn body_text(v: &Value) -> String {
        v["data"]["components"][0]["components"][0]["content"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn build_reply_is_ephemeral_v2_and_pins_mentions_to_the_clicker() {
        let v = build_reply(&reply("Hello {user}"), &ctx());
        assert_eq!(v["type"], RESPONSE_CHANNEL_MESSAGE);
        // Ephemeral + V2 flags both set.
        let flags = v["data"]["flags"].as_u64().unwrap();
        assert_eq!(flags, FLAG_IS_COMPONENTS_V2 | FLAG_EPHEMERAL);
        // The text was substituted inside a Container → Text Display.
        assert_eq!(v["data"]["components"][0]["type"], COMPONENT_CONTAINER);
        assert_eq!(body_text(&v), "Hello <@42>");
        // Only the clicker may be pinged; @everyone/role mentions are neutralised.
        assert_eq!(
            v["data"]["allowed_mentions"]["parse"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert_eq!(v["data"]["allowed_mentions"]["users"][0], "42");
    }

    #[test]
    fn build_reply_public_drops_only_the_ephemeral_flag() {
        let mut r = reply("Public note");
        r.ephemeral = false;
        let v = build_reply(&r, &ctx());
        assert_eq!(v["data"]["flags"].as_u64().unwrap(), FLAG_IS_COMPONENTS_V2);
    }

    #[test]
    fn build_reply_prepends_a_title_as_a_heading() {
        let mut r = reply("the body");
        r.title = Some("Server Rules".into());
        let text = body_text(&build_reply(&r, &ctx()));
        assert!(text.starts_with("### Server Rules\n"));
        assert!(text.contains("the body"));
    }

    // ── saved-message reply ──────────────────────────────────────────────────────
    #[test]
    fn build_reply_uses_a_saved_payload_over_the_typed_body() {
        let mut r = reply("ignored typed body");
        r.title = Some("ignored title".into());
        r.payload = Some(json!({
            "components": [{
                "type": COMPONENT_CONTAINER,
                "components": [{ "type": COMPONENT_TEXT_DISPLAY, "content": "Hi {user} from {server}!" }],
            }],
        }));
        let v = build_reply(&r, &ctx());
        // The saved layout is sent, with variables substituted in its content…
        let content = v["data"]["components"][0]["components"][0]["content"]
            .as_str()
            .unwrap();
        assert_eq!(content, "Hi <@42> from Cool Server!");
        // …the typed body/title are not present…
        assert!(!serde_json::to_string(&v).unwrap().contains("ignored"));
        // …and mention safety still pins pings to the clicker.
        assert_eq!(
            v["data"]["allowed_mentions"]["parse"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert_eq!(v["data"]["allowed_mentions"]["users"][0], "42");
    }

    #[test]
    fn build_reply_public_saved_payload_keeps_only_the_v2_flag() {
        let mut r = reply("");
        r.ephemeral = false;
        r.payload =
            Some(json!({ "components": [{ "type": COMPONENT_TEXT_DISPLAY, "content": "hi" }] }));
        let v = build_reply(&r, &ctx());
        assert_eq!(v["data"]["flags"].as_u64().unwrap(), FLAG_IS_COMPONENTS_V2);
    }

    #[test]
    fn build_reply_falls_back_to_body_for_an_empty_or_componentless_payload() {
        // Empty components array → not a usable saved message → typed body wins.
        let mut r = reply("typed wins");
        r.payload = Some(json!({ "components": [] }));
        assert_eq!(body_text(&build_reply(&r, &ctx())), "typed wins");
        // A content/embeds-only payload (no V2 components) is ignored too.
        let mut r2 = reply("typed wins again");
        r2.payload = Some(json!({ "content": "plain", "embeds": [] }));
        assert_eq!(body_text(&build_reply(&r2, &ctx())), "typed wins again");
    }

    #[test]
    fn substitute_in_content_leaves_non_content_fields_untouched() {
        let mut v = json!({
            "components": [{
                "type": COMPONENT_TEXT_DISPLAY,
                "content": "Hello {user}",
                "url": "https://example.com/{user}",
                "custom_id": "thing:{user}",
            }],
        });
        substitute_in_content(&mut v, &ctx());
        assert_eq!(v["components"][0]["content"], "Hello <@42>");
        // URLs and custom_ids keep their literal braces — only `content` is filled.
        assert_eq!(v["components"][0]["url"], "https://example.com/{user}");
        assert_eq!(v["components"][0]["custom_id"], "thing:{user}");
    }

    // ── gate-denied notice ──────────────────────────────────────────────────────
    #[test]
    fn gate_denied_names_the_roles_and_is_ephemeral() {
        let v = gate_denied(&roles(&["1", "2"]));
        let flags = v["data"]["flags"].as_u64().unwrap();
        assert!(flags & FLAG_EPHEMERAL != 0);
        let text = v["data"]["components"][0]["content"].as_str().unwrap();
        assert!(text.contains("<@&1>") && text.contains("<@&2>") && text.contains("or"));
    }

    #[test]
    fn join_human_reads_naturally() {
        assert_eq!(join_human(&["A".into()]), "A");
        assert_eq!(join_human(&["A".into(), "B".into()]), "A or B");
        assert_eq!(
            join_human(&["A".into(), "B".into(), "C".into()]),
            "A, B or C"
        );
    }
}
