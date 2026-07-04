//! Validation for instance config submitted by the (untrusted) browser.
//!
//! Two jobs. The security-critical one is the forward-webhook **SSRF guard**:
//! the target URL is user-supplied and we POST to it server-side, so we only
//! permit genuine Discord incoming-webhook URLs. Without this, a caller could
//! aim the service at internal/metadata endpoints. The rest keeps a stored form
//! *coherent and within Discord's limits* — a title and 1–5 fields, sane length
//! bounds, and a reply that will actually render — so a click never produces a
//! modal Discord rejects.

use std::collections::HashSet;

use crate::store::InstanceConfig;

/// Discord hosts that serve incoming webhooks.
const ALLOWED_WEBHOOK_HOSTS: &[&str] = &[
    "discord.com",
    "discordapp.com",
    "canary.discord.com",
    "ptb.discord.com",
];

/// Discord text-input ceiling for min/max length and prefilled values.
const TEXT_INPUT_MAX: u32 = 4000;
/// Webhook `username` overrides are capped by Discord at 80 characters.
const MAX_FORWARD_USERNAME: usize = 80;
const MAX_PLAIN_REPLY: usize = 2000;
const MAX_REPLY_BYTES: usize = 16_000;

pub fn validate_config(cfg: &InstanceConfig) -> Result<(), String> {
    let title = cfg.modal.title.trim();
    if title.is_empty() || title.chars().count() > 45 {
        return Err("Modal title must be 1–45 characters.".into());
    }

    if cfg.modal.fields.is_empty() || cfg.modal.fields.len() > 5 {
        return Err("A modal needs between 1 and 5 fields.".into());
    }

    let mut seen = HashSet::new();
    for f in &cfg.modal.fields {
        let id_len = f.id.chars().count();
        if id_len == 0 || id_len > 100 {
            return Err("Each field id must be 1–100 characters.".into());
        }
        if !seen.insert(f.id.as_str()) {
            return Err("Field ids must be unique.".into());
        }
        let label = f.label.trim();
        if label.is_empty() || label.chars().count() > 45 {
            return Err("Each field label must be 1–45 characters.".into());
        }
        if f.style != "short" && f.style != "paragraph" {
            return Err("Field style must be \"short\" or \"paragraph\".".into());
        }
        if let Some(m) = f.min_length {
            if m > TEXT_INPUT_MAX {
                return Err("Field min length can't exceed 4000.".into());
            }
        }
        if let Some(m) = f.max_length {
            if m == 0 || m > TEXT_INPUT_MAX {
                return Err("Field max length must be between 1 and 4000.".into());
            }
        }
        // Discord rejects a modal whose field has min_length > max_length, so
        // catch it here with a message that names the field rather than letting
        // the click fail with an opaque 400.
        if let (Some(min), Some(max)) = (f.min_length, f.max_length) {
            if min > max {
                return Err(format!(
                    "Field “{label}”: min length can't be larger than max length."
                ));
            }
        }
        if let Some(p) = &f.placeholder {
            if p.chars().count() > 100 {
                return Err("Field placeholder must be ≤ 100 characters.".into());
            }
        }
        if let Some(v) = &f.value {
            if v.chars().count() > TEXT_INPUT_MAX as usize {
                return Err("A field's prefilled text is too long (max 4000).".into());
            }
        }
    }

    validate_webhook(&cfg.forward_webhook)?;

    if let Some(name) = &cfg.forward_username {
        if name.chars().count() > MAX_FORWARD_USERNAME {
            return Err("The forward display name must be ≤ 80 characters.".into());
        }
    }

    // The reply is either a plain-text message or a saved Components V2 message.
    let has_components = cfg
        .reply
        .payload
        .as_ref()
        .and_then(|p| p.get("components"))
        .and_then(|c| c.as_array())
        .is_some_and(|a| !a.is_empty());
    let reply_text = cfg.reply.text.as_deref().map(str::trim).unwrap_or("");
    if !has_components && reply_text.is_empty() {
        return Err("Reply needs a plain-text message or a saved Components V2 message.".into());
    }
    if reply_text.chars().count() > MAX_PLAIN_REPLY {
        return Err("Plain-text reply must be ≤ 2000 characters.".into());
    }
    if let Some(payload) = &cfg.reply.payload {
        if serde_json::to_string(payload)
            .map(|s| s.len())
            .unwrap_or(usize::MAX)
            > MAX_REPLY_BYTES
        {
            return Err("Reply message is too large.".into());
        }
    }

    Ok(())
}

/// SSRF guard: only accept Discord incoming-webhook URLs as a forward target.
pub fn validate_webhook(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|_| "Forward webhook must be a valid URL.".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Forward webhook must use https.".into());
    }
    let host = parsed.host_str().unwrap_or_default();
    if !ALLOWED_WEBHOOK_HOSTS.contains(&host) || !parsed.path().starts_with("/api/webhooks/") {
        return Err("Forward webhook must be a Discord webhook URL.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{ModalDef, ModalField, ReplyDef};

    const WEBHOOK: &str = "https://discord.com/api/webhooks/123456789012345678/abcDEF";

    fn field(id: &str) -> ModalField {
        ModalField {
            id: id.into(),
            label: "Your answer".into(),
            style: "short".into(),
            required: false,
            placeholder: None,
            value: None,
            min_length: None,
            max_length: None,
        }
    }

    fn cfg(fields: Vec<ModalField>) -> InstanceConfig {
        InstanceConfig {
            modal: ModalDef {
                title: "Application".into(),
                fields,
            },
            forward_webhook: WEBHOOK.into(),
            forward_username: None,
            include_submitter: true,
            limit_one: false,
            reply: ReplyDef {
                payload: None,
                text: Some("Thanks!".into()),
            },
        }
    }

    #[test]
    fn a_minimal_config_is_valid() {
        assert!(validate_config(&cfg(vec![field("f1")])).is_ok());
    }

    #[test]
    fn rejects_empty_and_overlong_titles() {
        let mut c = cfg(vec![field("f1")]);
        c.modal.title = "   ".into();
        assert!(validate_config(&c).is_err());
        c.modal.title = "x".repeat(46);
        assert!(validate_config(&c).is_err());
    }

    #[test]
    fn requires_one_to_five_fields() {
        assert!(validate_config(&cfg(vec![])).is_err());
        let many = (0..6).map(|i| field(&format!("f{i}"))).collect();
        assert!(validate_config(&cfg(many)).is_err());
    }

    #[test]
    fn rejects_duplicate_field_ids() {
        let c = cfg(vec![field("dup"), field("dup")]);
        assert!(validate_config(&c).is_err());
    }

    #[test]
    fn rejects_min_length_above_max_length() {
        let mut f = field("f1");
        f.min_length = Some(100);
        f.max_length = Some(10);
        assert!(validate_config(&cfg(vec![f])).is_err());
    }

    #[test]
    fn accepts_min_length_equal_to_max_length() {
        let mut f = field("f1");
        f.min_length = Some(10);
        f.max_length = Some(10);
        assert!(validate_config(&cfg(vec![f])).is_ok());
    }

    #[test]
    fn rejects_overlong_forward_username() {
        let mut c = cfg(vec![field("f1")]);
        c.forward_username = Some("x".repeat(81));
        assert!(validate_config(&c).is_err());
        c.forward_username = Some("Suggestions Bot".into());
        assert!(validate_config(&c).is_ok());
    }

    #[test]
    fn reply_needs_text_or_payload() {
        let mut c = cfg(vec![field("f1")]);
        c.reply = ReplyDef {
            payload: None,
            text: None,
        };
        assert!(validate_config(&c).is_err());
        // A non-empty saved payload satisfies it even with no text.
        c.reply = ReplyDef {
            payload: Some(serde_json::json!({ "components": [{ "type": 10, "content": "hi" }] })),
            text: None,
        };
        assert!(validate_config(&c).is_ok());
    }

    #[test]
    fn webhook_guard_rejects_non_discord_and_non_https() {
        assert!(validate_webhook("http://discord.com/api/webhooks/1/x").is_err()); // http
        assert!(validate_webhook("https://evil.example.com/api/webhooks/1/x").is_err()); // host
        assert!(validate_webhook("https://discord.com/users/@me").is_err()); // path
        assert!(validate_webhook("not a url").is_err());
    }

    #[test]
    fn webhook_guard_accepts_canonical_discord_urls() {
        assert!(validate_webhook(WEBHOOK).is_ok());
        assert!(validate_webhook("https://canary.discord.com/api/webhooks/1/tok").is_ok());
        assert!(validate_webhook("https://discordapp.com/api/webhooks/1/tok").is_ok());
    }
}
