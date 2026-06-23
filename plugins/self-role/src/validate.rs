//! Validation for instance config submitted by the (untrusted) browser.
//!
//! The role-assignment path only ever calls `discord.com` (a fixed host), so the
//! one SSRF surface is the optional **audit-log webhook**: a user-supplied URL we
//! post to. [`validate_webhook`] pins it to genuine Discord incoming-webhook URLs
//! exactly like the Modal Form plugin. The rest keeps a stored instance
//! *coherent*: a real target, real snowflake ids, a mode/limit that fit the
//! target, and bounded strings.

use std::collections::HashSet;

use crate::store::InstanceConfig;

/// Roles a single menu may manage. Discord caps a string select at 25 options.
const MAX_ROLES: usize = 25;
const MAX_CUSTOM_REPLY: usize = 500;
const MAX_OPTION_DESCRIPTION: usize = 100;
/// Requirement roles to gate the menu behind — generous but bounded.
const MAX_REQUIREMENT_ROLES: usize = 10;
/// Account-age floor ceiling: a year is already an extreme anti-raid setting.
const MAX_ACCOUNT_AGE_DAYS: u32 = 366;
/// Temporary-role duration bounds: at least a minute, at most a year.
const MIN_EXPIRY_SECS: u64 = 60;
const MAX_EXPIRY_SECS: u64 = 31_536_000;

/// Discord hosts that serve incoming webhooks (mirrors Modal Form).
const ALLOWED_WEBHOOK_HOSTS: &[&str] = &[
    "discord.com",
    "discordapp.com",
    "canary.discord.com",
    "ptb.discord.com",
];

pub fn validate_config(cfg: &InstanceConfig) -> Result<(), String> {
    let is_button = match cfg.target.as_str() {
        "button" => true,
        "string_select" => false,
        _ => return Err("Unsupported component target.".into()),
    };

    if !is_snowflake(&cfg.guild_id) {
        return Err("Pick a server first (its id looks wrong).".into());
    }

    if cfg.roles.is_empty() {
        return Err("Choose at least one role.".into());
    }
    if cfg.roles.len() > MAX_ROLES {
        return Err(format!("A menu can manage at most {MAX_ROLES} roles."));
    }
    if is_button && cfg.roles.len() != 1 {
        return Err("A button gives exactly one role.".into());
    }

    let mut seen = HashSet::new();
    for role in &cfg.roles {
        if !is_snowflake(&role.id) {
            return Err("One of the roles has an invalid id.".into());
        }
        if !seen.insert(role.id.as_str()) {
            return Err("The same role is listed twice.".into());
        }
        if role.name.chars().count() > 100 {
            return Err("A role name is too long.".into());
        }
        if let Some(desc) = &role.description {
            if desc.chars().count() > MAX_OPTION_DESCRIPTION {
                return Err(format!(
                    "A role's dropdown subtitle must be \u{2264} {MAX_OPTION_DESCRIPTION} characters."
                ));
            }
        }
        // A custom emoji is identified by a snowflake id; a unicode emoji has no
        // id. Reject a malformed custom-emoji id (the glyph/name itself is
        // sanitized by DWEEB when it wires the option).
        if let Some(eid) = &role.emoji_id {
            if !is_snowflake(eid) {
                return Err("A role's custom emoji is invalid.".into());
            }
        }
    }

    // ── Behaviour + limit ────────────────────────────────────────────────────
    let adds = match cfg.mode.as_str() {
        "toggle" | "add" => true,
        "remove" => false,
        _ => return Err("That behaviour isn't available.".into()),
    };

    if let Some(max) = cfg.max {
        if is_button {
            return Err("A limit only applies to a select menu, not a button.".into());
        }
        if !adds {
            return Err("A limit only applies when the menu can add roles.".into());
        }
        if max < 1 || (max as usize) > cfg.roles.len() {
            return Err("The limit must be between 1 and the number of roles.".into());
        }
    }

    // ── Who can use it (requirement gate) ────────────────────────────────────
    let req = &cfg.requirement;
    if req.roles.len() > MAX_REQUIREMENT_ROLES {
        return Err(format!(
            "At most {MAX_REQUIREMENT_ROLES} roles can gate this menu."
        ));
    }
    let mut req_seen = HashSet::new();
    for r in &req.roles {
        if !is_snowflake(&r.id) {
            return Err("A required role has an invalid id.".into());
        }
        if !req_seen.insert(r.id.as_str()) {
            return Err("The same required role is listed twice.".into());
        }
    }
    if req.min_account_age_days > MAX_ACCOUNT_AGE_DAYS {
        return Err(format!(
            "Minimum account age can't exceed {MAX_ACCOUNT_AGE_DAYS} days."
        ));
    }

    // ── Temporary roles ──────────────────────────────────────────────────────
    if let Some(secs) = cfg.expires_after_secs {
        if !adds {
            return Err("A take-only menu can't grant temporary roles.".into());
        }
        if !(MIN_EXPIRY_SECS..=MAX_EXPIRY_SECS).contains(&secs) {
            return Err("Auto-remove time must be between 1 minute and 1 year.".into());
        }
    }

    // ── Audit-log webhook (the one SSRF surface) ─────────────────────────────
    if let Some(url) = &cfg.log_webhook {
        validate_webhook(url)?;
    }

    // ── Reply ────────────────────────────────────────────────────────────────
    match cfg.response.mode.as_str() {
        "summary" => {}
        "custom" => {
            let text = cfg.response.text.as_deref().unwrap_or("").trim();
            if text.is_empty() {
                return Err("Your custom reply is empty — type a message or switch to the automatic summary.".into());
            }
            if text.chars().count() > MAX_CUSTOM_REPLY {
                return Err(format!(
                    "Custom reply must be \u{2264} {MAX_CUSTOM_REPLY} characters."
                ));
            }
        }
        _ => return Err("Reply mode must be \"summary\" or \"custom\".".into()),
    }

    Ok(())
}

/// SSRF guard: only accept genuine Discord incoming-webhook URLs as the
/// audit-log destination. Without this, a stored config could make the service
/// POST to an arbitrary host.
pub fn validate_webhook(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|_| "The log webhook must be a valid URL.".to_string())?;
    if parsed.scheme() != "https" {
        return Err("The log webhook must use https.".into());
    }
    let host = parsed.host_str().unwrap_or_default();
    if !ALLOWED_WEBHOOK_HOSTS.contains(&host) || !parsed.path().starts_with("/api/webhooks/") {
        return Err("The log webhook must be a Discord webhook URL.".into());
    }
    Ok(())
}

/// Discord snowflakes are 17–20 digits today; accept a little slack.
pub fn is_snowflake(s: &str) -> bool {
    (15..=25).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webhook_guard_rejects_non_discord_and_non_https() {
        assert!(validate_webhook("http://discord.com/api/webhooks/1/x").is_err());
        assert!(validate_webhook("https://evil.example.com/api/webhooks/1/x").is_err());
        assert!(validate_webhook("https://discord.com/users/@me").is_err());
        assert!(validate_webhook("not a url").is_err());
    }

    #[test]
    fn webhook_guard_accepts_canonical_discord_urls() {
        assert!(validate_webhook("https://discord.com/api/webhooks/123/abcDEF").is_ok());
        assert!(validate_webhook("https://canary.discord.com/api/webhooks/1/tok").is_ok());
        assert!(validate_webhook("https://discordapp.com/api/webhooks/1/tok").is_ok());
    }
}
