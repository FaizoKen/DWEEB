//! Validation for instance config submitted by the (untrusted) browser.
//!
//! The security-critical check here is the forward-webhook **SSRF guard**: the
//! target URL is user-supplied and we POST to it server-side, so we only permit
//! genuine Discord incoming-webhook URLs. Without this, a caller could aim the
//! service at internal/metadata endpoints.

use std::collections::HashSet;

use crate::store::InstanceConfig;

/// Discord hosts that serve incoming webhooks.
const ALLOWED_WEBHOOK_HOSTS: &[&str] =
    &["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"];

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
        if let Some(m) = f.max_length {
            if m == 0 || m > 4000 {
                return Err("Field max length must be between 1 and 4000.".into());
            }
        }
        if let Some(p) = &f.placeholder {
            if p.chars().count() > 100 {
                return Err("Field placeholder must be ≤ 100 characters.".into());
            }
        }
    }

    validate_webhook(&cfg.forward_webhook)?;

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
    if reply_text.chars().count() > 2000 {
        return Err("Plain-text reply must be ≤ 2000 characters.".into());
    }
    if let Some(payload) = &cfg.reply.payload {
        if serde_json::to_string(payload).map(|s| s.len()).unwrap_or(usize::MAX) > MAX_REPLY_BYTES {
            return Err("Reply message is too large.".into());
        }
    }

    Ok(())
}

/// SSRF guard: only accept Discord incoming-webhook URLs as a forward target.
pub fn validate_webhook(url: &str) -> Result<(), String> {
    let parsed =
        reqwest::Url::parse(url.trim()).map_err(|_| "Forward webhook must be a valid URL.".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Forward webhook must use https.".into());
    }
    let host = parsed.host_str().unwrap_or_default();
    if !ALLOWED_WEBHOOK_HOSTS.contains(&host) || !parsed.path().starts_with("/api/webhooks/") {
        return Err("Forward webhook must be a Discord webhook URL.".into());
    }
    Ok(())
}
