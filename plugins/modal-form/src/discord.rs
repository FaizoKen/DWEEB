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

use crate::store::{kind, InstanceConfig, ModalDef, ModalField, ReplyDef};

// Interaction request types.
pub const TYPE_PING: u8 = 1;
pub const TYPE_MESSAGE_COMPONENT: u8 = 3;
pub const TYPE_MODAL_SUBMIT: u8 = 5;

// Interaction callback (response) types.
const RESPONSE_PONG: u8 = 1;
const RESPONSE_CHANNEL_MESSAGE: u8 = 4;
const RESPONSE_MODAL: u8 = 9;

// Component / flag constants.
const COMPONENT_STRING_SELECT: u64 = 3;
const COMPONENT_TEXT_INPUT: u64 = 4;
const COMPONENT_USER_SELECT: u64 = 5;
const COMPONENT_ROLE_SELECT: u64 = 6;
const COMPONENT_MENTIONABLE_SELECT: u64 = 7;
const COMPONENT_CHANNEL_SELECT: u64 = 8;
const COMPONENT_TEXT_DISPLAY: u64 = 10;
const COMPONENT_CONTAINER: u64 = 17;
/// A modal question's frame: its label and description, around one input.
/// Discord deprecated the Action Row + labelled Text Input modal (2025-08-25)
/// in its favour, and every modal-only input added since — selects, radio
/// groups, checkboxes — exists only inside one.
const COMPONENT_LABEL: u64 = 18;
const COMPONENT_RADIO_GROUP: u64 = 21;
const COMPONENT_CHECKBOX_GROUP: u64 = 22;
const COMPONENT_CHECKBOX: u64 = 23;
/// Discord allows at most this many top-level components in a modal.
pub const MAX_MODAL_COMPONENTS: usize = 5;
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
    /// Present on MODAL_SUBMIT: one entry per top-level modal component — a
    /// Label wrapping the answered input, a Text Display (no answer), or, for
    /// a modal opened before the Label upgrade was deployed, an Action Row
    /// holding a Text Input. Read loosely by [`collect_modal_values`], since an
    /// unknown shape must cost one answer, never the whole submission.
    #[serde(default)]
    pub components: Option<Vec<Value>>,
    /// Users, roles and channels the member picked, as Discord resolved them.
    /// Read only to tell a mentionable pick's users from its roles.
    #[serde(default)]
    pub resolved: Option<Value>,
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

/// Flatten the submitted modal into `(field_id, answer)` pairs, in the
/// modal's order, each answer already worded for the forwarded message: text
/// as typed, a choice by its label (not its stored value), a checkbox as
/// Yes/No, and a picked member, role or channel as its mention. An empty
/// answer is an empty string (the forward shows a dash for it).
pub fn collect_modal_values(data: &InteractionData, modal: &ModalDef) -> Vec<(String, String)> {
    let resolved = data.resolved.as_ref();
    let mut out = Vec::new();
    // Read by shape, not by `type`: a Label carries one `component`, an Action
    // Row (a modal opened before the Label upgrade, submitted after it) a
    // `components` list, and a Text Display — which answers nothing — neither.
    // An answer is never dropped over a discriminator.
    for top in data.components.iter().flatten() {
        if let Some(child) = top.get("component") {
            out.extend(answer_of(child, modal, resolved));
        } else if let Some(children) = top.get("components").and_then(Value::as_array) {
            for child in children {
                out.extend(answer_of(child, modal, resolved));
            }
        }
    }
    out
}

/// One submitted input's `(field_id, answer)`, or `None` when it carries no
/// custom id at all.
fn answer_of(
    child: &Value,
    modal: &ModalDef,
    resolved: Option<&Value>,
) -> Option<(String, String)> {
    let id = child.get("custom_id").and_then(Value::as_str)?.to_string();
    let field = modal.fields.iter().find(|f| f.id == id);
    let strings = |key: &str| -> Vec<String> {
        child
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    };
    let answer = match child.get("type").and_then(Value::as_u64) {
        Some(COMPONENT_STRING_SELECT | COMPONENT_CHECKBOX_GROUP) => {
            choice_labels(field, &strings("values"))
        }
        Some(COMPONENT_RADIO_GROUP) => {
            let picked: Vec<String> = child
                .get("value")
                .and_then(Value::as_str)
                .map(|v| vec![v.to_string()])
                .unwrap_or_default();
            choice_labels(field, &picked)
        }
        Some(COMPONENT_CHECKBOX) => match child.get("value").and_then(Value::as_bool) {
            Some(true) => "Yes".to_string(),
            Some(false) => "No".to_string(),
            None => String::new(),
        },
        Some(COMPONENT_USER_SELECT) => mentions(&strings("values"), |id| format!("<@{id}>")),
        Some(COMPONENT_ROLE_SELECT) => mentions(&strings("values"), |id| format!("<@&{id}>")),
        Some(COMPONENT_CHANNEL_SELECT) => mentions(&strings("values"), |id| format!("<#{id}>")),
        Some(COMPONENT_MENTIONABLE_SELECT) => {
            let is_user = |id: &str| {
                resolved
                    .and_then(|r| r.get("users"))
                    .and_then(|u| u.get(id))
                    .is_some()
            };
            mentions(&strings("values"), |id| {
                if is_user(id) {
                    format!("<@{id}>")
                } else {
                    format!("<@&{id}>")
                }
            })
        }
        // A Text Input (4), or a type this build doesn't know but which
        // carries a plain `value`: take the text.
        _ => child
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    };
    Some((id, answer))
}

/// Picked option values, worded by their labels where the form still has them.
fn choice_labels(field: Option<&ModalField>, picked: &[String]) -> String {
    picked
        .iter()
        .map(|value| {
            field
                .and_then(|f| f.options.iter().find(|o| &o.value == value))
                .map(|o| o.label.clone())
                .unwrap_or_else(|| value.clone())
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Snowflake picks as mentions. Anything that isn't a snowflake is dropped:
/// a submission is member input, and an id pasted into a mention must not be
/// able to carry markdown into the forwarded message.
fn mentions(ids: &[String], mention: impl Fn(&str) -> String) -> String {
    ids.iter()
        .filter(|id| !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit()))
        .map(|id| mention(id))
        .collect::<Vec<_>>()
        .join(", ")
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

/// Build the MODAL callback from a stored modal definition: the optional
/// intro as a Text Display, then one Label per question — its label and
/// description around the input the question's kind names (a text input, a
/// select, a radio or checkbox group, a checkbox). At most five in all.
pub fn modal_response(submit_custom_id: &str, modal: &ModalDef) -> Value {
    let mut components: Vec<Value> = Vec::new();
    if let Some(intro) = modal.intro_text() {
        components.push(json!({
            "type": COMPONENT_TEXT_DISPLAY,
            "content": clamp(intro, crate::validate::MAX_INTRO),
        }));
    }
    for f in &modal.fields {
        if components.len() >= MAX_MODAL_COMPONENTS {
            break;
        }
        let mut label = json!({
            "type": COMPONENT_LABEL,
            "label": clamp(&f.label, 45),
            "component": field_input(f),
        });
        if let Some(d) = f
            .description
            .as_deref()
            .map(str::trim)
            .filter(|d| !d.is_empty())
        {
            label["description"] = json!(clamp(d, 100));
        }
        components.push(label);
    }

    json!({
        "type": RESPONSE_MODAL,
        "data": {
            "custom_id": submit_custom_id,
            "title": clamp(&modal.title, 45),
            "components": components,
        }
    })
}

/// The input inside a question's Label. No `label` here: inside a Label it is
/// the Label's, and on a Text Input Discord deprecated it.
fn field_input(f: &ModalField) -> Value {
    let custom_id = clamp(&f.id, 100);
    let options = || -> Vec<Value> {
        f.options
            .iter()
            .map(|o| {
                let mut opt = json!({
                    "label": clamp(&o.label, 100),
                    "value": clamp(&o.value, 100),
                });
                if let Some(d) = o.description.as_deref().filter(|d| !d.trim().is_empty()) {
                    opt["description"] = json!(clamp(d, 100));
                }
                if o.default {
                    opt["default"] = json!(true);
                }
                opt
            })
            .collect()
    };
    let picks = |input: &mut Value| {
        if let Some(min) = f.min_values {
            input["min_values"] = json!(min);
        }
        if let Some(max) = f.max_values {
            input["max_values"] = json!(max);
        }
    };
    let placeholder = |input: &mut Value| {
        if let Some(p) = f.placeholder.as_deref().filter(|p| !p.trim().is_empty()) {
            input["placeholder"] = json!(clamp(p, 150));
        }
    };
    match f.kind.as_str() {
        kind::SELECT => {
            let mut input = json!({
                "type": COMPONENT_STRING_SELECT,
                "custom_id": custom_id,
                "options": options(),
                "required": f.required,
            });
            picks(&mut input);
            placeholder(&mut input);
            input
        }
        kind::RADIO => json!({
            "type": COMPONENT_RADIO_GROUP,
            "custom_id": custom_id,
            "options": options(),
            "required": f.required,
        }),
        kind::CHECKBOXES => {
            let mut input = json!({
                "type": COMPONENT_CHECKBOX_GROUP,
                "custom_id": custom_id,
                "options": options(),
                "required": f.required,
            });
            picks(&mut input);
            input
        }
        // Discord can't make a lone checkbox required; never send the field.
        kind::CHECKBOX => json!({
            "type": COMPONENT_CHECKBOX,
            "custom_id": custom_id,
            "default": f.checked,
        }),
        kind::USER | kind::ROLE | kind::MENTIONABLE | kind::CHANNEL => {
            let component = match f.kind.as_str() {
                kind::USER => COMPONENT_USER_SELECT,
                kind::ROLE => COMPONENT_ROLE_SELECT,
                kind::MENTIONABLE => COMPONENT_MENTIONABLE_SELECT,
                _ => COMPONENT_CHANNEL_SELECT,
            };
            let mut input = json!({
                "type": component,
                "custom_id": custom_id,
                "required": f.required,
            });
            picks(&mut input);
            placeholder(&mut input);
            input
        }
        // kind::TEXT, and anything validation would have refused.
        _ => {
            let style = if f.style == "paragraph" {
                TEXT_INPUT_PARAGRAPH
            } else {
                TEXT_INPUT_SHORT
            };
            let mut input = json!({
                "type": COMPONENT_TEXT_INPUT,
                "custom_id": custom_id,
                "style": style,
                "required": f.required,
            });
            if let Some(p) = f.placeholder.as_deref().filter(|p| !p.is_empty()) {
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
            input
        }
    }
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
            ..ModalField::default()
        }
    }

    fn base_cfg() -> InstanceConfig {
        InstanceConfig {
            modal: ModalDef {
                title: "Application".into(),
                intro: None,
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

    fn submit(components: Value, resolved: Option<Value>) -> InteractionData {
        serde_json::from_value(json!({
            "custom_id": "modalform:submit:x",
            "components": components,
            "resolved": resolved,
        }))
        .unwrap()
    }

    /// A modal opened before the Label upgrade was deployed still submits in
    /// the old Action Row shape, and its answers must still arrive.
    #[test]
    fn collect_reads_a_legacy_action_row_submission() {
        let data = submit(
            json!([
                { "type": 1, "components": [{ "type": 4, "custom_id": "f1", "value": "Ada" }] },
                { "type": 1, "components": [{ "type": 4, "custom_id": "f2", "value": "Because" }] },
            ]),
            None,
        );
        assert_eq!(
            collect_modal_values(&data, &base_cfg().modal),
            vec![("f1".into(), "Ada".into()), ("f2".into(), "Because".into())]
        );
    }

    fn option(label: &str, value: &str) -> crate::store::FieldOption {
        crate::store::FieldOption {
            label: label.into(),
            value: value.into(),
            ..Default::default()
        }
    }

    fn every_kind_modal() -> ModalDef {
        let with = |id: &str, kind_: &str, options: Vec<crate::store::FieldOption>| ModalField {
            id: id.into(),
            label: id.into(),
            kind: kind_.into(),
            options,
            ..ModalField::default()
        };
        ModalDef {
            title: "Every kind".into(),
            intro: Some("Read the **rules** first.".into()),
            fields: vec![
                with("text", kind::TEXT, vec![]),
                with(
                    "pick",
                    kind::SELECT,
                    vec![option("Europe", "eu"), option("Asia", "as")],
                ),
                with(
                    "one",
                    kind::RADIO,
                    vec![option("Yes please", "y"), option("No thanks", "n")],
                ),
                with(
                    "many",
                    kind::CHECKBOXES,
                    vec![option("Mod", "m"), option("Events", "e")],
                ),
            ],
        }
    }

    /// The Label-shaped submission: each answer worded for the forward.
    #[test]
    fn collect_words_every_kind_of_answer() {
        let modal = every_kind_modal();
        let data = submit(
            json!([
                { "type": 10, "id": 1 },
                { "type": 18, "id": 2, "component": { "type": 4, "id": 3, "custom_id": "text", "value": "hello" } },
                { "type": 18, "id": 4, "component": { "type": 3, "id": 5, "custom_id": "pick", "values": ["as"] } },
                { "type": 18, "id": 6, "component": { "type": 21, "id": 7, "custom_id": "one", "value": "n" } },
                { "type": 18, "id": 8, "component": { "type": 22, "id": 9, "custom_id": "many", "values": ["m", "e"] } },
                { "type": 18, "id": 10, "component": { "type": 23, "id": 11, "custom_id": "agree", "value": true } },
                { "type": 18, "id": 12, "component": { "type": 5, "custom_id": "who", "values": ["111111111111111111"] } },
                { "type": 18, "id": 13, "component": { "type": 6, "custom_id": "role", "values": ["222222222222222222"] } },
                { "type": 18, "id": 14, "component": { "type": 8, "custom_id": "where", "values": ["333333333333333333"] } },
                { "type": 18, "id": 15, "component": { "type": 7, "custom_id": "ment",
                    "values": ["444444444444444444", "555555555555555555"] } },
            ]),
            Some(
                json!({ "users": { "444444444444444444": { "id": "444444444444444444" } },
                         "roles": { "555555555555555555": { "id": "555555555555555555" } } }),
            ),
        );
        let got = collect_modal_values(&data, &modal);
        let answer = |id: &str| got.iter().find(|(k, _)| k == id).map(|(_, v)| v.as_str());
        assert_eq!(answer("text"), Some("hello"));
        // Choices by their labels, never their stored values.
        assert_eq!(answer("pick"), Some("Asia"));
        assert_eq!(answer("one"), Some("No thanks"));
        assert_eq!(answer("many"), Some("Mod, Events"));
        assert_eq!(answer("agree"), Some("Yes"));
        assert_eq!(answer("who"), Some("<@111111111111111111>"));
        assert_eq!(answer("role"), Some("<@&222222222222222222>"));
        assert_eq!(answer("where"), Some("<#333333333333333333>"));
        // A mentionable pick is a user when Discord resolved it as one.
        assert_eq!(
            answer("ment"),
            Some("<@444444444444444444>, <@&555555555555555555>")
        );
        // The Text Display answered nothing; the order is the modal's.
        assert_eq!(got.len(), 9);
        assert_eq!(got[0].0, "text");
    }

    /// An unpicked choice is empty (the forward shows a dash), and a pick that
    /// isn't a snowflake never becomes a mention.
    #[test]
    fn empty_and_forged_picks_say_nothing() {
        let modal = every_kind_modal();
        let data = submit(
            json!([
                { "type": 18, "component": { "type": 21, "custom_id": "one", "value": null } },
                { "type": 18, "component": { "type": 22, "custom_id": "many", "values": [] } },
                { "type": 18, "component": { "type": 5, "custom_id": "who", "values": ["1)**bold**", ""] } },
            ]),
            None,
        );
        let got = collect_modal_values(&data, &modal);
        assert!(got.iter().all(|(_, v)| v.is_empty()), "{got:?}");
    }

    #[test]
    fn the_modal_is_built_from_labels_around_each_kind_of_input() {
        let mut modal = every_kind_modal();
        modal.fields[1].required = true;
        modal.fields[1].max_values = Some(2);
        modal.fields[1].placeholder = Some("Pick one".into());
        modal.fields[2].options[0].default = true;
        modal.fields[3].description = Some("Pick all that apply".into());
        let v = modal_response("modalform:submit:x", &modal);
        let comps = v["data"]["components"].as_array().unwrap();
        // The intro takes the first of the five slots.
        assert_eq!(comps.len(), 5);
        assert_eq!(comps[0]["type"], 10);
        assert_eq!(comps[0]["content"], "Read the **rules** first.");
        for label in &comps[1..] {
            assert_eq!(label["type"], 18);
            // The label lives on the Label, never on the input.
            assert!(label["component"].get("label").is_none(), "{label}");
        }
        assert_eq!(comps[1]["component"]["type"], 4);
        let select = &comps[2]["component"];
        assert_eq!(select["type"], 3);
        assert_eq!(select["required"], true);
        assert_eq!(select["max_values"], 2);
        assert_eq!(select["placeholder"], "Pick one");
        assert_eq!(select["options"][1]["value"], "as");
        assert!(select.get("disabled").is_none(), "modals refuse `disabled`");
        let radio = &comps[3]["component"];
        assert_eq!(radio["type"], 21);
        assert_eq!(radio["options"][0]["default"], true);
        assert!(radio["options"][1].get("default").is_none());
        assert_eq!(comps[4]["description"], "Pick all that apply");
        assert_eq!(comps[4]["component"]["type"], 22);
    }

    #[test]
    fn a_checkbox_is_never_sent_as_required() {
        let mut f = field("agree", "I agree to the rules");
        f.kind = kind::CHECKBOX.into();
        f.required = true;
        f.checked = true;
        let input = field_input(&f);
        assert_eq!(input["type"], 23);
        assert_eq!(input["default"], true);
        assert!(input.get("required").is_none(), "{input}");
    }

    #[test]
    fn entity_selects_carry_their_picks_and_placeholder() {
        for (k, t) in [
            (kind::USER, 5),
            (kind::ROLE, 6),
            (kind::MENTIONABLE, 7),
            (kind::CHANNEL, 8),
        ] {
            let mut f = field("p", "Pick");
            f.kind = k.into();
            f.min_values = Some(1);
            f.max_values = Some(3);
            f.placeholder = Some("Choose".into());
            let input = field_input(&f);
            assert_eq!(input["type"], t, "{k}");
            assert_eq!(input["min_values"], 1);
            assert_eq!(input["max_values"], 3);
            assert_eq!(input["placeholder"], "Choose");
        }
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
            intro: None,
            fields: vec![f],
        };
        let v = modal_response("modalform:submit:x", &modal);
        let label = &v["data"]["components"][0];
        assert_eq!(label["type"], 18);
        assert_eq!(label["label"], "Bug");
        let input = &label["component"];
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
