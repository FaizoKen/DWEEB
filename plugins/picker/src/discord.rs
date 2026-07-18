//! Discord interaction protocol: signature verification, the request shapes we
//! read, the **pure** decision/builder logic, and the callback JSON we send back.
//!
//! A pick does no I/O: everything that *decides what to send* — turning the
//! selected snowflakes into mentions, the `{picks}`/`{user}`/… substitution, the
//! mention-safety policy, and the Components V2 message that goes back — is a
//! pure function here, so it is exhaustively unit-tested. `routes.rs` is the thin
//! shell that loads the config and hands it this module.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::store::InstanceConfig;

// Interaction request types.
pub const TYPE_PING: u8 = 1;
pub const TYPE_MESSAGE_COMPONENT: u8 = 3;

// Interaction callback (response) types.
const RESPONSE_PONG: u8 = 1;
const RESPONSE_CHANNEL_MESSAGE: u8 = 4;

// Component / flag constants.
const COMPONENT_USER_SELECT: u8 = 5;
const COMPONENT_ROLE_SELECT: u8 = 6;
const COMPONENT_MENTIONABLE_SELECT: u8 = 7;
const COMPONENT_CHANNEL_SELECT: u8 = 8;
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
    /// 5 = user, 6 = role, 7 = mentionable, 8 = channel select. Authoritative for
    /// what kind of thing each picked snowflake is.
    #[serde(default)]
    pub component_type: Option<u8>,
    /// The selected snowflake ids (members, roles, channels — or a mix, for a
    /// mentionable select).
    #[serde(default)]
    pub values: Option<Vec<String>>,
    /// Discord's resolved objects for the picks. We only consult its `roles` map:
    /// for a *mentionable* select it's the sole way to tell which picked ids are
    /// roles (rendered `<@&id>`) versus users (`<@id>`).
    #[serde(default)]
    pub resolved: Option<Resolved>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Resolved {
    #[serde(default)]
    pub roles: Map<String, Value>,
}

#[derive(Debug, Deserialize)]
pub struct Member {
    #[serde(default)]
    pub user: Option<User>,
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
    /// The acting member's user id, however the payload carries it.
    pub fn actor_id(&self) -> Option<&str> {
        self.member
            .as_ref()
            .and_then(|m| m.user.as_ref())
            .or(self.user.as_ref())
            .map(|u| u.id.as_str())
    }

    /// The acting member's display name (global name, else username, else id).
    pub fn actor_name(&self) -> String {
        self.member
            .as_ref()
            .and_then(|m| m.user.as_ref())
            .or(self.user.as_ref())
            .map(display_name)
            .unwrap_or_else(|| "there".to_string())
    }

    pub fn custom_id(&self) -> &str {
        self.data
            .as_ref()
            .and_then(|d| d.custom_id.as_deref())
            .unwrap_or_default()
    }

    /// Resolve the picks into typed mentions, classifying each picked snowflake
    /// by the interaction's `component_type` (and, for a mentionable select,
    /// Discord's `resolved.roles` map). Returns an empty vec when nothing was
    /// picked or the component isn't one of our four selects.
    pub fn picks(&self) -> Vec<Pick> {
        let Some(data) = self.data.as_ref() else {
            return Vec::new();
        };
        let values = data.values.as_deref().unwrap_or(&[]);
        let empty = Resolved::default();
        let resolved = data.resolved.as_ref().unwrap_or(&empty);
        classify_picks(data.component_type.unwrap_or(0), values, resolved)
    }
}

fn display_name(user: &User) -> String {
    user.global_name
        .clone()
        .or_else(|| user.username.clone())
        .unwrap_or_else(|| user.id.clone())
}

// ── Pure: classify + render picks ────────────────────────────────────────────

/// What a single picked snowflake refers to. Drives both how it renders as a
/// mention and whether it can be pinged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickKind {
    User,
    Role,
    Channel,
}

/// One resolved selection: a snowflake plus what it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pick {
    pub kind: PickKind,
    pub id: String,
}

impl Pick {
    /// The Discord mention syntax for this pick.
    pub fn mention(&self) -> String {
        match self.kind {
            PickKind::User => format!("<@{}>", self.id),
            PickKind::Role => format!("<@&{}>", self.id),
            PickKind::Channel => format!("<#{}>", self.id),
        }
    }
}

/// Turn the interaction's selected ids into typed [`Pick`]s. For user/role/
/// channel selects the kind is fixed by the component type; for a *mentionable*
/// select each id is a role iff Discord listed it under `resolved.roles`, else a
/// user. Non-snowflake values are dropped — the interaction path never trusts a
/// raw client-supplied id beyond echoing it back as a mention.
pub fn classify_picks(component_type: u8, values: &[String], resolved: &Resolved) -> Vec<Pick> {
    values
        .iter()
        .filter(|id| is_snowflake(id))
        .filter_map(|id| {
            let kind = match component_type {
                COMPONENT_USER_SELECT => PickKind::User,
                COMPONENT_ROLE_SELECT => PickKind::Role,
                COMPONENT_CHANNEL_SELECT => PickKind::Channel,
                COMPONENT_MENTIONABLE_SELECT => {
                    if resolved.roles.contains_key(id) {
                        PickKind::Role
                    } else {
                        PickKind::User
                    }
                }
                _ => return None,
            };
            Some(Pick {
                kind,
                id: id.clone(),
            })
        })
        .collect()
}

/// Render the picks as a human-readable mention list: "A", "A and B",
/// "A, B and C".
pub fn render_picks(picks: &[Pick]) -> String {
    join_human(&picks.iter().map(Pick::mention).collect::<Vec<_>>())
}

/// Join items as "A", "A and B", or "A, B and C".
fn join_human(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [a] => a.clone(),
        [a, b] => format!("{a} and {b}"),
        [rest @ .., last] => format!("{} and {}", rest.join(", "), last),
    }
}

// ── Pure: variable substitution ──────────────────────────────────────────────

/// The values a reply's `{...}` tokens resolve to for one pick. Built from the
/// interaction payload (+ the instance's cached guild name) — no Discord call.
pub struct PickContext {
    /// The acting member's user id, for the `{user}` mention.
    pub user_id: String,
    /// Their display name, for `{username}`.
    pub user_name: String,
    /// The server name, for `{server}`.
    pub server_name: String,
    /// The resolved selections, for `{picks}` and `{count}`.
    pub picks: Vec<Pick>,
}

/// Substitute the supported tokens in `text`. Unknown `{...}` tokens are left
/// untouched, so an admin's literal braces survive.
///
/// `{username}` is replaced **before** `{user}` on purpose: `{user}` is a prefix
/// of `{username}`, so doing it the other way would corrupt the longer token.
pub fn substitute(text: &str, ctx: &PickContext) -> String {
    text.replace("{picks}", &render_picks(&ctx.picks))
        .replace("{count}", &ctx.picks.len().to_string())
        .replace("{username}", &ctx.user_name)
        .replace("{user}", &format!("<@{}>", ctx.user_id))
        .replace("{server}", &ctx.server_name)
}

// ── Outgoing callbacks ───────────────────────────────────────────────────────

pub fn pong() -> Value {
    json!({ "type": RESPONSE_PONG })
}

/// A bare ephemeral text reply (Components V2: the text rides in a Text Display,
/// since V2 forbids the plain `content` field). Used for the not-found /
/// empty-selection / error notices.
pub fn ephemeral_text(content: &str) -> Value {
    json!({
        "type": RESPONSE_CHANNEL_MESSAGE,
        "data": {
            "flags": FLAG_IS_COMPONENTS_V2 | FLAG_EPHEMERAL,
            "components": [{ "type": COMPONENT_TEXT_DISPLAY, "content": clamp(content, MAX_V2_TEXT) }],
        }
    })
}

/// Build the configured reply for one pick — pure. The optional title becomes a
/// `### heading`; the body follows, both with `{...}` tokens substituted. The
/// result rides in a Components V2 Container (a tidy card).
///
/// The reply is **always ephemeral** — only the person who used the menu sees
/// it, a private "here's what you picked" confirmation. An ephemeral reply never
/// produces a notification, but `allowed_mentions.parse = []` is pinned anyway so
/// the rendered `{picks}`/template mentions can never ping `@everyone`/`@here` or
/// a role.
pub fn build_reply(cfg: &InstanceConfig, ctx: &PickContext) -> Value {
    let mut text = String::new();
    if let Some(title) = cfg
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        text.push_str("### ");
        text.push_str(&substitute(title, ctx));
        text.push('\n');
    }
    text.push_str(&substitute(&cfg.body, ctx));

    json!({
        "type": RESPONSE_CHANNEL_MESSAGE,
        "data": {
            "flags": FLAG_IS_COMPONENTS_V2 | FLAG_EPHEMERAL,
            "allowed_mentions": { "parse": [] },
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

/// Truncate to at most `max` characters (respecting char boundaries).
fn clamp(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Discord snowflakes are 17–20 digits today; accept a little slack.
pub fn is_snowflake(s: &str) -> bool {
    (15..=25).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{TARGET_CHANNEL, TARGET_ROLE, TARGET_USER};

    fn cfg(target: &str, body: &str) -> InstanceConfig {
        InstanceConfig {
            target: target.into(),
            guild_id: None,
            guild_name: "Cool Server".into(),
            title: None,
            body: body.into(),
        }
    }

    fn ctx(picks: Vec<Pick>) -> PickContext {
        PickContext {
            user_id: "42".into(),
            user_name: "Ada".into(),
            server_name: "Cool Server".into(),
            picks,
        }
    }

    fn user(id: &str) -> Pick {
        Pick {
            kind: PickKind::User,
            id: id.into(),
        }
    }
    fn role(id: &str) -> Pick {
        Pick {
            kind: PickKind::Role,
            id: id.into(),
        }
    }
    fn channel(id: &str) -> Pick {
        Pick {
            kind: PickKind::Channel,
            id: id.into(),
        }
    }

    fn resolved_roles(ids: &[&str]) -> Resolved {
        let mut roles = Map::new();
        for id in ids {
            roles.insert((*id).to_string(), json!({ "id": id }));
        }
        Resolved { roles }
    }

    // ── classify ──────────────────────────────────────────────────────────────
    #[test]
    fn classifies_each_select_kind_by_component_type() {
        let ids = vec![
            "100000000000000000".to_string(),
            "200000000000000000".to_string(),
        ];
        let none = Resolved::default();
        assert_eq!(
            classify_picks(5, &ids, &none)
                .iter()
                .map(|p| p.kind)
                .collect::<Vec<_>>(),
            vec![PickKind::User, PickKind::User]
        );
        assert_eq!(
            classify_picks(6, &ids, &none)
                .iter()
                .map(|p| p.kind)
                .collect::<Vec<_>>(),
            vec![PickKind::Role, PickKind::Role]
        );
        assert_eq!(
            classify_picks(8, &ids, &none)
                .iter()
                .map(|p| p.kind)
                .collect::<Vec<_>>(),
            vec![PickKind::Channel, PickKind::Channel]
        );
    }

    #[test]
    fn mentionable_uses_resolved_roles_to_split_users_from_roles() {
        let user_id = "100000000000000000";
        let role_id = "200000000000000000";
        let ids = vec![user_id.to_string(), role_id.to_string()];
        let resolved = resolved_roles(&[role_id]);
        let picks = classify_picks(7, &ids, &resolved);
        assert_eq!(picks, vec![user(user_id), role(role_id)]);
        assert_eq!(picks[0].mention(), format!("<@{user_id}>"));
        assert_eq!(picks[1].mention(), format!("<@&{role_id}>"));
    }

    #[test]
    fn drops_non_snowflakes_and_unknown_component_types() {
        let ids = vec![
            "not-a-snowflake".to_string(),
            "100000000000000000".to_string(),
        ];
        assert_eq!(classify_picks(5, &ids, &Resolved::default()).len(), 1);
        // A component type that isn't one of our four selects yields nothing.
        assert!(classify_picks(2, &ids, &Resolved::default()).is_empty());
    }

    // ── join / render ─────────────────────────────────────────────────────────
    #[test]
    fn render_picks_reads_naturally() {
        assert_eq!(render_picks(&[]), "");
        assert_eq!(render_picks(&[user("1")]), "<@1>");
        assert_eq!(render_picks(&[user("1"), role("2")]), "<@1> and <@&2>");
        assert_eq!(
            render_picks(&[user("1"), role("2"), channel("3")]),
            "<@1>, <@&2> and <#3>"
        );
    }

    // ── substitution ────────────────────────────────────────────────────────
    #[test]
    fn substitute_fills_each_token() {
        let c = ctx(vec![user("1"), user("2")]);
        let out = substitute(
            "{user} ({username}) picked {count}: {picks} in {server}",
            &c,
        );
        assert_eq!(out, "<@42> (Ada) picked 2: <@1> and <@2> in Cool Server");
    }

    #[test]
    fn substitute_handles_username_before_user_prefix() {
        let c = ctx(vec![]);
        assert_eq!(substitute("{username}", &c), "Ada");
        assert_eq!(substitute("{user}", &c), "<@42>");
    }

    // ── reply builder ──────────────────────────────────────────────────────────
    fn body_text(v: &Value) -> String {
        v["data"]["components"][0]["components"][0]["content"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn reply_is_always_ephemeral_v2_and_neutralises_pings() {
        let v = build_reply(
            &cfg(TARGET_USER, "You selected {picks}"),
            &ctx(vec![user("1"), user("2")]),
        );
        assert_eq!(v["type"], RESPONSE_CHANNEL_MESSAGE);
        // Every reply is private (ephemeral) + Components V2.
        assert_eq!(
            v["data"]["flags"].as_u64().unwrap(),
            FLAG_IS_COMPONENTS_V2 | FLAG_EPHEMERAL
        );
        assert_eq!(v["data"]["components"][0]["type"], COMPONENT_CONTAINER);
        assert_eq!(body_text(&v), "You selected <@1> and <@2>");
        // No mention can ping: parse is empty and there is no allow-list.
        assert_eq!(
            v["data"]["allowed_mentions"]["parse"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert!(v["data"]["allowed_mentions"].get("users").is_none());
        assert!(v["data"]["allowed_mentions"].get("roles").is_none());
    }

    #[test]
    fn role_and_channel_picks_render_but_never_ping() {
        // Roles render as role mentions, channels as channel links — all inert
        // (ephemeral + parse:[]), whatever the target.
        let roles_reply = build_reply(
            &cfg(TARGET_ROLE, "Picked {picks}"),
            &ctx(vec![role("2"), role("3")]),
        );
        assert_eq!(body_text(&roles_reply), "Picked <@&2> and <@&3>");
        assert_eq!(
            roles_reply["data"]["flags"].as_u64().unwrap(),
            FLAG_IS_COMPONENTS_V2 | FLAG_EPHEMERAL
        );

        let chan_reply = build_reply(
            &cfg(TARGET_CHANNEL, "Go to {picks}"),
            &ctx(vec![channel("2")]),
        );
        assert_eq!(body_text(&chan_reply), "Go to <#2>");
        assert_eq!(
            chan_reply["data"]["allowed_mentions"]["parse"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn title_renders_as_a_heading() {
        let mut c = cfg(TARGET_USER, "the body");
        c.title = Some("Your picks".into());
        let text = body_text(&build_reply(&c, &ctx(vec![])));
        assert!(text.starts_with("### Your picks\n"));
        assert!(text.contains("the body"));
    }
}
