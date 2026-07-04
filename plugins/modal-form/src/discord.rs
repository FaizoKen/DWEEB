//! Discord interaction protocol: signature verification, the request/response
//! shapes we care about, and the JSON responses we send back.
//!
//! This service is interaction-driven and *stateless on Discord's side*: it
//! never calls the Discord REST API or holds a bot token. It only (a) verifies
//! the Ed25519 signature Discord puts on every interaction, and (b) answers the
//! HTTP request with the right callback JSON (a modal, or a message), plus one
//! best-effort outbound POST to the configured forward webhook. The functions
//! that *build* those payloads are pure, so they are unit-tested below.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::store::{InstanceConfig, ModalDef, ReplyDef};

// Interaction request types.
pub const TYPE_PING: u8 = 1;
pub const TYPE_MESSAGE_COMPONENT: u8 = 3;
pub const TYPE_MODAL_SUBMIT: u8 = 5;

// Interaction callback (response) types.
const RESPONSE_PONG: u8 = 1;
const RESPONSE_CHANNEL_MESSAGE: u8 = 4;
const RESPONSE_MODAL: u8 = 9;

// Component / flag constants.
const COMPONENT_ACTION_ROW: u8 = 1;
const COMPONENT_TEXT_INPUT: u8 = 4;
const COMPONENT_TEXT_DISPLAY: u8 = 10;
const COMPONENT_CONTAINER: u8 = 17;
const TEXT_INPUT_SHORT: u8 = 1;
const TEXT_INPUT_PARAGRAPH: u8 = 2;
/// Discord's text-input ceiling, used to clamp min/max length and prefills.
const TEXT_INPUT_MAX: u32 = 4000;
/// Components V2 caps the total text across a message at this many characters.
const MAX_V2_TEXT: usize = 4000;
const FLAG_EPHEMERAL: u64 = 1 << 6; // 64
const FLAG_IS_COMPONENTS_V2: u64 = 1 << 15; // 32768

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
/// interactions are signed with their own keys — it forwards the verifying
/// key in `x-dweeb-public-key`, vouched for by the shared
/// DISPATCHER_FORWARD_SECRET in `x-dweeb-forward-auth`. The signature is
/// still verified HERE, on the raw bytes Discord signed; the secret only
/// authenticates *which key to use*. Without a valid secret the header is
/// ignored (None), so a caller reaching this service directly can never
/// substitute its own key.
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
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
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
    /// The clicking/submitting member's user id, however the payload carries it
    /// (guild interactions nest it under `member`, DMs put it at top level).
    /// Used to gate "one response per person".
    pub fn actor_id(&self) -> Option<&str> {
        self.member
            .as_ref()
            .and_then(|m| m.user.as_ref())
            .or(self.user.as_ref())
            .map(|u| u.id.as_str())
    }

    /// The user object behind this interaction, for naming the submitter.
    pub fn actor(&self) -> Option<&User> {
        self.member
            .as_ref()
            .and_then(|m| m.user.as_ref())
            .or(self.user.as_ref())
    }
}

/// Flatten the submitted modal fields into `(field_id, value)` pairs.
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

/// Build the MODAL callback from a stored modal definition. Carries each text
/// input's style, required flag, placeholder, prefilled value, and length
/// bounds — every property Discord's text input supports.
pub fn modal_response(submit_custom_id: &str, modal: &ModalDef) -> Value {
    let rows: Vec<Value> = modal
        .fields
        .iter()
        .take(5) // Discord allows at most 5 rows in a modal.
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
            if let Some(v) = &f.value {
                if !v.is_empty() {
                    input["value"] = json!(clamp(v, TEXT_INPUT_MAX as usize));
                }
            }
            if let Some(m) = f.min_length {
                input["min_length"] = json!(m.min(TEXT_INPUT_MAX));
            }
            if let Some(m) = f.max_length {
                input["max_length"] = json!(m.clamp(1, TEXT_INPUT_MAX));
            }
            json!({ "type": COMPONENT_ACTION_ROW, "components": [input] })
        })
        .collect();

    json!({
        "type": RESPONSE_MODAL,
        "data": {
            "custom_id": submit_custom_id,
            "title": clamp(&modal.title, 45),
            "components": rows,
        }
    })
}

/// Reply to the user (ephemeral) with whichever the instance is configured for:
/// a saved Components V2 message if one is set, otherwise a plain-text message.
/// Falls back to a plain acknowledgement if neither is usable.
pub fn build_reply(reply: &ReplyDef) -> Value {
    // A saved Components V2 message takes priority over flat text.
    if let Some(components) = reply.payload.as_ref().and_then(|p| p.get("components")) {
        if components.as_array().is_some_and(|a| !a.is_empty()) {
            return json!({
                "type": RESPONSE_CHANNEL_MESSAGE,
                "data": {
                    "flags": FLAG_IS_COMPONENTS_V2 | FLAG_EPHEMERAL,
                    "components": components,
                }
            });
        }
    }
    if let Some(text) = reply.text.as_deref() {
        if !text.trim().is_empty() {
            return ephemeral_text(&clamp(text, 2000));
        }
    }
    ephemeral_text("Thanks — your response was recorded.")
}

/// Build the Discord webhook payload that forwards a submission, as a
/// Components V2 message: a Container holding the title, one block per answer,
/// and a footer — the V2 stand-in for the old embed's title/fields/footer.
///
/// Two safety/behaviour points:
///   • `allowed_mentions: { parse: [] }` neutralizes any `@everyone`/`@here`/role
///     mention a submitter pastes into an answer (V2 text would otherwise ping
///     the destination channel from arbitrary member input).
///   • the footer names the submitter only when `include_submitter` is set;
///     turning it off makes the form an anonymous suggestion/report box.
///
/// The execute call must carry `with_components=true` and this sets the
/// IS_COMPONENTS_V2 flag, since V2 forbids the `content`/`embeds` fields.
pub fn build_forward_message(
    cfg: &InstanceConfig,
    values: &[(String, String)],
    submitter: Option<&User>,
) -> Value {
    let modal = &cfg.modal;

    // Assemble title + answers + footer as one Markdown block. Each answer keeps
    // the old embed's per-field clamp; the whole block is then clamped to V2's
    // message-wide text budget so a long submission can't get rejected.
    let mut body = format!(
        "### {}",
        clamp(&format!("New submission · {}", modal.title), 256)
    );
    for (id, value) in values {
        let label = modal
            .fields
            .iter()
            .find(|f| &f.id == id)
            .map(|f| f.label.clone())
            .unwrap_or_else(|| id.clone());
        body.push_str(&format!(
            "\n\n**{}**\n{}",
            clamp(&label, 256),
            value_or_dash(value)
        ));
    }
    let ts = unix_secs();
    if cfg.include_submitter {
        let who = submitter
            .map(display_name)
            .unwrap_or_else(|| "someone".to_string());
        body.push_str(&format!("\n\n-# from {who} · <t:{ts}:f>"));
    } else {
        body.push_str(&format!("\n\n-# Anonymous submission · <t:{ts}:f>"));
    }

    let username = cfg
        .forward_username
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Modal Form");

    json!({
        "username": clamp(username, 80),
        "flags": FLAG_IS_COMPONENTS_V2,
        "allowed_mentions": { "parse": [] },
        "components": [{
            "type": COMPONENT_CONTAINER,
            "components": [{
                "type": COMPONENT_TEXT_DISPLAY,
                "content": clamp(&body, MAX_V2_TEXT),
            }],
        }]
    })
}

fn display_name(user: &User) -> String {
    user.global_name
        .clone()
        .or_else(|| user.username.clone())
        .unwrap_or_else(|| user.id.clone())
}

/// Truncate to at most `max` characters (respecting char boundaries).
fn clamp(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn value_or_dash(v: &str) -> String {
    if v.trim().is_empty() {
        "—".to_string()
    } else {
        clamp(v, 1024)
    }
}

fn unix_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{ModalField, ReplyDef};

    fn field(id: &str, label: &str) -> ModalField {
        ModalField {
            id: id.into(),
            label: label.into(),
            style: "short".into(),
            required: false,
            placeholder: None,
            value: None,
            min_length: None,
            max_length: None,
        }
    }

    fn base_cfg() -> InstanceConfig {
        InstanceConfig {
            modal: ModalDef {
                title: "Application".into(),
                fields: vec![field("f1", "Name"), field("f2", "Why")],
            },
            forward_webhook: "https://discord.com/api/webhooks/1/tok".into(),
            forward_username: None,
            include_submitter: true,
            limit_one: false,
            reply: ReplyDef::default(),
        }
    }

    fn user() -> User {
        User {
            id: "42".into(),
            username: Some("ada".into()),
            global_name: Some("Ada L".into()),
        }
    }

    fn forward_text(v: &Value) -> String {
        v["components"][0]["components"][0]["content"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn collect_flattens_submitted_values_in_order() {
        let data = InteractionData {
            custom_id: Some("modalform:submit:x".into()),
            components: Some(vec![
                ModalRow {
                    components: vec![ModalRowChild {
                        custom_id: Some("f1".into()),
                        value: Some("Ada".into()),
                    }],
                },
                ModalRow {
                    components: vec![ModalRowChild {
                        custom_id: Some("f2".into()),
                        value: Some("Because".into()),
                    }],
                },
            ]),
        };
        assert_eq!(
            collect_modal_values(&data),
            vec![("f1".into(), "Ada".into()), ("f2".into(), "Because".into())]
        );
    }

    #[test]
    fn forward_named_carries_answers_submitter_and_suppresses_mentions() {
        let vals = vec![
            ("f1".into(), "Ada".into()),
            ("f2".into(), "@everyone hi".into()),
        ];
        let msg = build_forward_message(&base_cfg(), &vals, Some(&user()));
        let text = forward_text(&msg);
        assert!(text.contains("**Name**") && text.contains("Ada"));
        assert!(text.contains("**Why**") && text.contains("@everyone hi"));
        assert!(text.contains("Ada L")); // submitter named in the footer
        assert_eq!(msg["username"], "Modal Form");
        // A pasted @everyone must never ping the destination channel.
        assert_eq!(
            msg["allowed_mentions"]["parse"].as_array().unwrap().len(),
            0
        );
    }

    #[test]
    fn forward_anonymous_hides_submitter_and_honours_username_override() {
        let mut cfg = base_cfg();
        cfg.include_submitter = false;
        cfg.forward_username = Some("Suggestions".into());
        let msg = build_forward_message(&cfg, &[("f1".into(), "Secret".into())], Some(&user()));
        let text = forward_text(&msg);
        assert!(!text.contains("Ada L"));
        assert!(text.to_lowercase().contains("anonymous"));
        assert_eq!(msg["username"], "Suggestions");
    }

    #[test]
    fn empty_answer_renders_as_a_dash() {
        let msg = build_forward_message(&base_cfg(), &[("f1".into(), "   ".into())], None);
        assert!(forward_text(&msg).contains("—"));
    }

    #[test]
    fn reply_prefers_saved_payload_then_text_then_default() {
        let saved = ReplyDef {
            payload: Some(json!({ "components": [{ "type": 10, "content": "Saved!" }] })),
            text: Some("ignored".into()),
        };
        assert_eq!(
            build_reply(&saved)["data"]["components"][0]["content"],
            "Saved!"
        );

        let plain = ReplyDef {
            payload: None,
            text: Some("Thanks".into()),
        };
        assert_eq!(
            build_reply(&plain)["data"]["components"][0]["content"],
            "Thanks"
        );

        let def = build_reply(&ReplyDef::default());
        assert!(def["data"]["components"][0]["content"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .contains("recorded"));
    }

    #[test]
    fn modal_response_carries_prefill_and_length_bounds() {
        let mut f = field("f1", "Bug");
        f.value = Some("Steps:\n1. ".into());
        f.min_length = Some(5);
        f.max_length = Some(200);
        f.placeholder = Some("Describe".into());
        f.required = true;
        f.style = "paragraph".into();
        let modal = ModalDef {
            title: "Report".into(),
            fields: vec![f],
        };
        let v = modal_response("modalform:submit:x", &modal);
        let input = &v["data"]["components"][0]["components"][0];
        assert_eq!(input["custom_id"], "f1");
        assert_eq!(input["style"], TEXT_INPUT_PARAGRAPH);
        assert_eq!(input["value"], "Steps:\n1. ");
        assert_eq!(input["min_length"], 5);
        assert_eq!(input["max_length"], 200);
        assert_eq!(input["placeholder"], "Describe");
        assert_eq!(input["required"], true);
        assert_eq!(v["data"]["title"], "Report");
    }
}
