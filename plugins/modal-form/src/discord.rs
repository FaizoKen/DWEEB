//! Discord interaction protocol: signature verification, the request/response
//! shapes we care about, and the JSON responses we send back.
//!
//! This service is interaction-driven and *stateless on Discord's side*: it
//! never calls the Discord REST API or holds a bot token. It only (a) verifies
//! the Ed25519 signature Discord puts on every interaction, and (b) answers the
//! HTTP request with the right callback JSON (a modal, or a message).

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::store::{ModalDef, ReplyDef};

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
const TEXT_INPUT_SHORT: u8 = 1;
const TEXT_INPUT_PARAGRAPH: u8 = 2;
const FLAG_EPHEMERAL: u64 = 1 << 6; // 64
const FLAG_IS_COMPONENTS_V2: u64 = 1 << 15; // 32768

/// Verify Discord's `X-Signature-Ed25519` over `timestamp || body`. Any
/// malformed input fails closed (returns false). This MUST run on the raw body
/// bytes, before JSON parsing.
pub fn verify_signature(public_key_hex: &str, signature_hex: &str, timestamp: &str, body: &[u8]) -> bool {
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

pub fn ephemeral_text(content: &str) -> Value {
    json!({
        "type": RESPONSE_CHANNEL_MESSAGE,
        "data": { "flags": FLAG_EPHEMERAL, "content": content }
    })
}

/// Build the MODAL callback from a stored modal definition.
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
            if let Some(m) = f.min_length {
                input["min_length"] = json!(m.min(4000));
            }
            if let Some(m) = f.max_length {
                input["max_length"] = json!(m.clamp(1, 4000));
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

/// Reply to the user with the saved Components V2 message, ephemeral. Falls back
/// to a plain acknowledgement if the saved payload has no usable components.
pub fn reply_with_payload(reply: &ReplyDef) -> Value {
    match reply.payload.get("components") {
        Some(components) if components.as_array().is_some_and(|a| !a.is_empty()) => json!({
            "type": RESPONSE_CHANNEL_MESSAGE,
            "data": {
                "flags": FLAG_IS_COMPONENTS_V2 | FLAG_EPHEMERAL,
                "components": components,
            }
        }),
        _ => ephemeral_text("Thanks — your response was recorded."),
    }
}

/// Build the Discord webhook payload that forwards a submission.
pub fn build_forward_message(
    modal: &ModalDef,
    values: &[(String, String)],
    submitter: Option<&User>,
) -> Value {
    let fields: Vec<Value> = values
        .iter()
        .map(|(id, value)| {
            let label = modal
                .fields
                .iter()
                .find(|f| &f.id == id)
                .map(|f| f.label.clone())
                .unwrap_or_else(|| id.clone());
            json!({
                "name": clamp(&label, 256),
                "value": value_or_dash(value),
                "inline": false,
            })
        })
        .collect();

    let who = submitter.map(display_name).unwrap_or_else(|| "someone".to_string());

    json!({
        "username": "Modal Form",
        "embeds": [{
            "title": clamp(&format!("New submission · {}", modal.title), 256),
            "fields": fields,
            "footer": { "text": clamp(&format!("from {who}"), 2048) },
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
