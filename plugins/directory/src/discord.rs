//! Discord interaction protocol: signature verification, the request shapes we
//! read, the access gate, and the callback JSON we send back.
//!
//! Everything here is pure or near-pure. The interesting decisions a click makes
//! — who may use this directory, and whether the answer can be produced inside
//! Discord's ~3s window or has to be deferred — are plain functions of the
//! payload and the config, which is what makes them testable without a network.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::store::{InstanceConfig, Requirement};

/// Every `custom_id` this plugin mints starts with this; the dispatcher routes
/// on it, and DWEEB re-identifies the owning plugin by it on reload.
pub const PREFIX: &str = "directory:";

// Interaction request types.
pub const TYPE_PING: u8 = 1;
pub const TYPE_MESSAGE_COMPONENT: u8 = 3;

// Interaction callback (response) types.
const RESPONSE_PONG: u8 = 1;
const RESPONSE_CHANNEL_MESSAGE: u8 = 4;
/// "Thinking…" — buys up to 15 minutes to send the real answer as an edit of the
/// original response. Used only when a member scan has to run (see
/// [`needs_defer`]); everything else answers inline.
const RESPONSE_DEFERRED_CHANNEL_MESSAGE: u8 = 5;

// Component types + message flags. A directory reply is text only — a Container
// holding Text Displays — so no interactive component types appear here.
pub const COMPONENT_TEXT_DISPLAY: u8 = 10;
pub const COMPONENT_SEPARATOR: u8 = 14;
pub const COMPONENT_CONTAINER: u8 = 17;
pub const FLAG_EPHEMERAL: u64 = 1 << 6; // 64
pub const FLAG_IS_COMPONENTS_V2: u64 = 1 << 15; // 32768

/// Components V2 caps the total text across a message at this many characters.
pub const MAX_V2_TEXT: usize = 4000;

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
    /// Needed to edit the original response after a deferred reply
    /// (`PATCH /webhooks/{application_id}/{token}/messages/@original`).
    #[serde(default)]
    pub application_id: Option<String>,
    /// The interaction token — the credential for that follow-up edit. Never
    /// logged, never stored.
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub data: Option<InteractionData>,
    #[serde(default)]
    pub member: Option<Member>,
    #[serde(default)]
    pub user: Option<User>,
}

/// A directory needs no `component_type`: a button click carries no `values`, so
/// it resolves to "no section picked" — which is exactly the whole-directory
/// render a button should produce.
#[derive(Debug, Deserialize)]
pub struct InteractionData {
    #[serde(default)]
    pub custom_id: Option<String>,
    /// The option values a string select submitted (we set these = section keys).
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

/// Only the id is read: the gate needs it for the account-age check, and the
/// reply never names the clicker (it renders the *server*, not them).
#[derive(Debug, Deserialize, Clone)]
pub struct User {
    pub id: String,
}

impl Interaction {
    pub fn custom_id(&self) -> &str {
        self.data
            .as_ref()
            .and_then(|d| d.custom_id.as_deref())
            .unwrap_or("")
    }

    /// The clicking member's user id, however the payload carries it.
    pub fn actor_id(&self) -> Option<&str> {
        self.member
            .as_ref()
            .and_then(|m| m.user.as_ref())
            .or(self.user.as_ref())
            .map(|u| u.id.as_str())
    }

    /// Role ids the clicker holds, for the access gate. Empty outside a guild.
    pub fn actor_roles(&self) -> &[String] {
        self.member
            .as_ref()
            .map(|m| m.roles.as_slice())
            .unwrap_or(&[])
    }

    /// The single section key a select submitted, if any. A directory select is
    /// pinned to exactly one pick, so anything past the first is ignored rather
    /// than merged — a crafted client can't turn one pick into ten renders.
    pub fn picked_section(&self) -> Option<&str> {
        self.data
            .as_ref()
            .and_then(|d| d.values.as_ref())
            .and_then(|v| v.first())
            .map(|s| s.as_str())
            .filter(|s| !s.is_empty())
    }
}

/// Why a click was refused, phrased for the member. `None` = allowed.
///
/// Pure: the gate is decided entirely from the interaction payload (the roles
/// Discord already sent, and the account age encoded in the user snowflake), so
/// a refusal costs no Discord call and can't be slowed down by one.
pub fn gate_denial(req: &Requirement, member_roles: &[String], user_id: &str) -> Option<String> {
    if req.is_open() {
        return None;
    }
    if !req.roles.is_empty() {
        let has = |id: &String| member_roles.iter().any(|r| r == id);
        let ok = if req.require_all {
            req.roles.iter().all(|r| has(&r.id))
        } else {
            req.roles.iter().any(|r| has(&r.id))
        };
        if !ok {
            let names: Vec<String> = req
                .roles
                .iter()
                .map(|r| {
                    if r.name.trim().is_empty() {
                        format!("<@&{}>", r.id)
                    } else {
                        format!("**{}**", r.name)
                    }
                })
                .collect();
            let joiner = if req.require_all { " and " } else { " or " };
            return Some(format!("This list is for {}.", names.join(joiner)));
        }
    }
    if req.min_account_age_days > 0 {
        // A snowflake we can't parse fails OPEN. The gate is a courtesy filter on
        // a read-only list, not a security boundary, and refusing a member over an
        // id we couldn't read would be a bug they can't do anything about.
        if let Some(created_ms) = snowflake_to_unix_ms(user_id) {
            let age_days = (now_unix_ms() - created_ms) / MS_PER_DAY;
            if age_days < req.min_account_age_days as i64 {
                return Some(format!(
                    "Your account needs to be at least {} days old to use this.",
                    req.min_account_age_days
                ));
            }
        }
    }
    None
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// True when answering this click requires a member scan, and therefore a
/// deferred reply.
///
/// Only a roles-mode directory with member expansion on can be slow: it pages
/// `GET /guilds/{id}/members` at 1000 members a call. Roles and channels are one
/// cheap request each and comfortably answer inline, so deferring them would
/// only add a visible "thinking…" flicker for nothing.
pub fn needs_defer(cfg: &InstanceConfig) -> bool {
    cfg.is_roles() && cfg.show_members
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

/// Wrap already-built Components V2 `components` as an immediate reply.
pub fn message_reply(components: Vec<Value>, public: bool) -> Value {
    json!({
        "type": RESPONSE_CHANNEL_MESSAGE,
        "data": message_data(components, public),
    })
}

/// "Thinking…" — the placeholder that buys time for a member scan. The
/// ephemeral choice must match the eventual reply's, because Discord fixes a
/// response's visibility at the *defer*: a public directory that deferred
/// ephemerally can never become public afterwards.
pub fn deferred(public: bool) -> Value {
    json!({
        "type": RESPONSE_DEFERRED_CHANNEL_MESSAGE,
        "data": { "flags": if public { 0 } else { FLAG_EPHEMERAL } },
    })
}

/// The body of the follow-up `PATCH …/messages/@original` that replaces a
/// deferred placeholder with the finished directory.
///
/// The ephemeral bit is deliberately not repeated — it was fixed by the defer —
/// but `IS_COMPONENTS_V2` must be, or Discord rejects the `components` array on
/// the edit. [`SILENT_MENTIONS`] applies here for the same reason it does on a
/// direct reply.
pub fn followup_body(components: Vec<Value>) -> Value {
    json!({
        "flags": FLAG_IS_COMPONENTS_V2,
        "components": components,
        "allowed_mentions": silent_mentions(),
    })
}

/// `allowed_mentions` that renders every mention but notifies nobody.
///
/// **This is load-bearing, not politeness.** A roster is built out of `<@user>`
/// and `<@&role>` mentions — that's what makes it clickable, colour-correct, and
/// immune to renames. Without an empty `parse` list, a *public* staff directory
/// would ping every person and every role it lists, every single time anyone
/// clicked the button. It also neutralises an `@everyone` smuggled into a
/// channel topic, which is member-written text we render.
fn silent_mentions() -> Value {
    json!({ "parse": [] })
}

fn message_data(components: Vec<Value>, public: bool) -> Value {
    let mut flags = FLAG_IS_COMPONENTS_V2;
    if !public {
        flags |= FLAG_EPHEMERAL;
    }
    json!({
        "flags": flags,
        "components": components,
        "allowed_mentions": silent_mentions(),
    })
}

fn clamp(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{tests::base_config, RoleRef};

    fn req(roles: &[&str], all: bool, age: u32) -> Requirement {
        Requirement {
            roles: roles
                .iter()
                .map(|id| RoleRef {
                    id: (*id).into(),
                    name: format!("Role {id}"),
                    color: 0,
                })
                .collect(),
            require_all: all,
            min_account_age_days: age,
        }
    }

    /// A snowflake whose encoded creation time is `days` ago.
    fn snowflake_aged(days: i64) -> String {
        let created = now_unix_ms() - days * MS_PER_DAY;
        (((created - DISCORD_EPOCH_MS) as u64) << 22).to_string()
    }

    #[test]
    fn an_open_gate_admits_everyone() {
        assert!(gate_denial(&Requirement::default(), &[], "123").is_none());
    }

    #[test]
    fn any_of_versus_all_of_role_gates() {
        let holds_one = vec!["a".to_string()];
        assert!(gate_denial(&req(&["a", "b"], false, 0), &holds_one, "1").is_none());
        // require_all: holding one of two is not enough.
        assert!(gate_denial(&req(&["a", "b"], true, 0), &holds_one, "1").is_some());
        assert!(gate_denial(
            &req(&["a", "b"], true, 0),
            &["a".to_string(), "b".to_string()],
            "1"
        )
        .is_none());
        // Holding none of them.
        assert!(gate_denial(&req(&["a"], false, 0), &[], "1").is_some());
    }

    /// The refusal must name what's needed and use the right conjunction, or the
    /// member can't tell an "any of" gate from an "all of" one.
    #[test]
    fn a_role_refusal_names_the_roles_with_the_right_conjunction() {
        let any = gate_denial(&req(&["a", "b"], false, 0), &[], "1").unwrap();
        assert!(any.contains("Role a"), "{any}");
        assert!(any.contains(" or "), "{any}");
        let all = gate_denial(&req(&["a", "b"], true, 0), &[], "1").unwrap();
        assert!(all.contains(" and "), "{all}");
    }

    #[test]
    fn account_age_gate_uses_the_user_snowflake() {
        let old = snowflake_aged(90);
        let fresh = snowflake_aged(1);
        assert!(gate_denial(&req(&[], false, 30), &[], &old).is_none());
        let denial = gate_denial(&req(&[], false, 30), &[], &fresh).unwrap();
        assert!(denial.contains("30 days"), "{denial}");
    }

    /// An unparseable user id must not lock a member out of a read-only list.
    #[test]
    fn an_unreadable_snowflake_fails_open_on_the_age_gate() {
        assert!(gate_denial(&req(&[], false, 30), &[], "not-a-snowflake").is_none());
    }

    /// Only the expensive path defers. Deferring a cheap one would add a visible
    /// "thinking…" flicker; NOT deferring the expensive one risks Discord's 3s
    /// timeout killing the interaction outright.
    #[test]
    fn only_a_member_expanding_roster_defers() {
        let mut cfg = base_config();
        assert!(!needs_defer(&cfg));
        cfg.show_members = true;
        assert!(needs_defer(&cfg));
        // Channels mode never scans members, even if the flag is somehow set.
        cfg.mode = crate::store::MODE_CHANNELS.into();
        assert!(!needs_defer(&cfg));
    }

    /// Discord fixes a response's visibility at the defer, so the placeholder's
    /// ephemeral bit must track the config — a public directory that deferred
    /// ephemerally can never surface publicly afterwards.
    #[test]
    fn the_defer_carries_the_eventual_visibility() {
        assert_eq!(deferred(false)["data"]["flags"], json!(FLAG_EPHEMERAL));
        assert_eq!(deferred(true)["data"]["flags"], json!(0));
    }

    /// Every reply is Components V2 (V2 forbids the plain `content` field), and
    /// the ephemeral bit is set unless the directory is explicitly public.
    #[test]
    fn replies_are_components_v2_and_default_to_private() {
        let private = message_reply(
            vec![json!({"type": COMPONENT_TEXT_DISPLAY, "content": "x"})],
            false,
        );
        assert_eq!(
            private["data"]["flags"],
            json!(FLAG_IS_COMPONENTS_V2 | FLAG_EPHEMERAL)
        );
        let public = message_reply(
            vec![json!({"type": COMPONENT_TEXT_DISPLAY, "content": "x"})],
            true,
        );
        assert_eq!(public["data"]["flags"], json!(FLAG_IS_COMPONENTS_V2));

        assert_eq!(
            ephemeral_text("hi")["data"]["flags"],
            json!(FLAG_IS_COMPONENTS_V2 | FLAG_EPHEMERAL)
        );
        // The text must ride in a Text Display, never `content`.
        assert!(ephemeral_text("hi")["data"]["content"].is_null());
        assert_eq!(
            ephemeral_text("hi")["data"]["components"][0]["type"],
            json!(COMPONENT_TEXT_DISPLAY)
        );
    }

    /// The follow-up edit must repeat `IS_COMPONENTS_V2` or Discord rejects the
    /// `components` array outright.
    #[test]
    fn the_followup_repeats_the_v2_flag() {
        let body = followup_body(vec![
            json!({"type": COMPONENT_TEXT_DISPLAY, "content": "x"}),
        ]);
        assert_eq!(body["flags"], json!(FLAG_IS_COMPONENTS_V2));
    }

    /// A roster is built out of user and role mentions. Every path that can
    /// carry them MUST suppress notifications, or one click on a public staff
    /// directory pings the entire team (and any role it lists).
    #[test]
    fn every_mention_carrying_reply_is_silent() {
        let block = vec![json!({"type": COMPONENT_TEXT_DISPLAY, "content": "<@1> <@&2>"})];
        for body in [
            message_reply(block.clone(), true)["data"].clone(),
            message_reply(block.clone(), false)["data"].clone(),
            followup_body(block),
        ] {
            assert_eq!(
                body["allowed_mentions"]["parse"],
                json!([]),
                "a mention-carrying reply must not notify: {body}"
            );
        }
    }

    #[test]
    fn ephemeral_text_is_clamped_to_the_v2_budget() {
        let long = "x".repeat(MAX_V2_TEXT + 500);
        let reply = ephemeral_text(&long);
        let rendered = reply["data"]["components"][0]["content"].as_str().unwrap();
        assert_eq!(rendered.chars().count(), MAX_V2_TEXT);
    }

    /// A select is pinned to one pick; extra values must be ignored, not merged.
    #[test]
    fn picked_section_takes_only_the_first_value() {
        let i: Interaction = serde_json::from_value(json!({
            "type": 3,
            "data": { "custom_id": "directory:abc", "component_type": 3, "values": ["g:1", "g:2"] }
        }))
        .unwrap();
        assert_eq!(i.custom_id(), "directory:abc");
        assert_eq!(i.picked_section(), Some("g:1"));
    }

    /// A button carries no `values`, which resolves to "no section" — i.e. the
    /// whole directory. That's the intended button behaviour, so no
    /// component-type branch is needed anywhere.
    #[test]
    fn a_button_click_resolves_to_the_whole_directory() {
        let button: Interaction = serde_json::from_value(json!({
            "type": 3,
            "data": { "custom_id": "directory:abc", "component_type": 2 }
        }))
        .unwrap();
        assert_eq!(button.picked_section(), None);

        // An empty-string value must not be mistaken for a real pick either.
        let blank: Interaction = serde_json::from_value(json!({
            "type": 3,
            "data": { "custom_id": "directory:abc", "values": [""] }
        }))
        .unwrap();
        assert_eq!(blank.picked_section(), None);
    }

    /// Outside a guild there are no member roles, so a role gate can only refuse
    /// — which is what the caller's "this only works in its server" check relies
    /// on happening first.
    #[test]
    fn actor_roles_is_empty_outside_a_guild() {
        let dm: Interaction = serde_json::from_value(json!({
            "type": 3,
            "user": { "id": "42" },
            "data": { "custom_id": "directory:abc" }
        }))
        .unwrap();
        assert_eq!(dm.actor_id(), Some("42"));
        assert!(dm.actor_roles().is_empty());

        // In a guild the roles ride on `member`, and the id is nested there.
        let guild: Interaction = serde_json::from_value(json!({
            "type": 3,
            "guild_id": "9",
            "member": { "user": { "id": "7" }, "roles": ["r1", "r2"] },
            "data": { "custom_id": "directory:abc" }
        }))
        .unwrap();
        assert_eq!(guild.actor_id(), Some("7"));
        assert_eq!(guild.actor_roles(), &["r1".to_string(), "r2".to_string()]);
    }

    #[test]
    fn snowflake_decoding_matches_discords_epoch() {
        // Discord's documented example: 175928847299117063 → 2016-04-30.
        let ms = snowflake_to_unix_ms("175928847299117063").unwrap();
        assert_eq!(ms, 1_462_015_105_796);
        assert!(snowflake_to_unix_ms("nope").is_none());
    }

    #[test]
    fn signature_verification_fails_closed_on_garbage() {
        assert!(!verify_signature("zz", "zz", "1", b"{}"));
        assert!(parse_verifying_key("not hex").is_none());
    }

    #[test]
    fn constant_time_eq_compares_contents_and_length() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }

    /// The attested-key header is honoured only behind a matching shared secret,
    /// so a caller reaching this service directly can't substitute its own key.
    #[test]
    fn an_attested_key_needs_the_forward_secret() {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("x-dweeb-public-key", "deadbeef".parse().unwrap());
        headers.insert("x-dweeb-forward-auth", "s3cret".parse().unwrap());
        assert_eq!(attested_key(&headers, Some("s3cret")), Some("deadbeef"));
        assert_eq!(attested_key(&headers, Some("wrong")), None);
        // No secret configured ⇒ the header is ignored entirely.
        assert_eq!(attested_key(&headers, None), None);
    }
}
