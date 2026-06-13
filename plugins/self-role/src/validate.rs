//! Validation for instance config submitted by the (untrusted) browser.
//!
//! Unlike Modal Form there is no SSRF guard to write — this service only ever
//! calls `discord.com`, with a fixed host. The checks here are about keeping a
//! stored instance *coherent*: a real target, real snowflake role ids, and a
//! mode that fits the target. Role assignment uses the shared bot, so there is
//! no per-instance token to validate.

use std::collections::HashSet;

use crate::store::InstanceConfig;

/// Roles a single menu may manage. Discord caps a string select at 25 options.
const MAX_ROLES: usize = 25;
const MAX_CUSTOM_REPLY: usize = 500;

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
    }

    let mode_ok = match cfg.mode.as_str() {
        "toggle" | "add" | "remove" => true,
        // "Pick one / swap" only makes sense across a set, i.e. a select.
        "unique" => !is_button,
        _ => false,
    };
    if !mode_ok {
        return Err("That mode isn't available for this component.".into());
    }

    match cfg.response.mode.as_str() {
        "summary" => {}
        "custom" => {
            let text = cfg.response.text.as_deref().unwrap_or("").trim();
            if text.is_empty() {
                return Err("Your custom reply is empty — type a message or switch to the automatic summary.".into());
            }
            if text.chars().count() > MAX_CUSTOM_REPLY {
                return Err(format!("Custom reply must be \u{2264} {MAX_CUSTOM_REPLY} characters."));
            }
        }
        _ => return Err("Reply mode must be \"summary\" or \"custom\".".into()),
    }

    Ok(())
}

/// Discord snowflakes are 17–20 digits today; accept a little slack.
pub fn is_snowflake(s: &str) -> bool {
    (15..=25).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}
