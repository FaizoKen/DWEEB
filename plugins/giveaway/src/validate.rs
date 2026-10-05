//! Validation for the giveaway config submitted by the (untrusted) browser.
//!
//! This service only ever calls `discord.com`, with a fixed host, so there's no
//! SSRF guard to write. The checks here keep a stored giveaway *coherent*: a
//! real guild, a non-empty prize, a sane winner count, real snowflake role ids,
//! and bounded text — everything the interaction path later trusts.

use std::collections::HashSet;

use crate::store::{InstanceConfig, RoleRef};

/// A giveaway can draw this many winners at most (Discord renders the mention
/// list, and more than this is rarely a real giveaway).
const MAX_WINNERS: u32 = 20;
/// Requirement / host role caps — a string select tops out at 25 anyway.
const MAX_ROLES: usize = 25;
const MAX_PRIZE: usize = 256;
const MAX_DESCRIPTION: usize = 1500;
const MAX_ANNOUNCEMENT: usize = 1500;
/// Cap on the stored message template (a Components V2 tree). A real V2 message
/// tops out near 4 KB of text plus component scaffolding; 16 KB is generous slack
/// while still bounding what a single row can hold.
const MAX_TEMPLATE_BYTES: usize = 16 * 1024;
/// Accept an account-age floor up to ~5 years; beyond that it's a typo.
const MAX_ACCOUNT_AGE_DAYS: u32 = 1825;

pub fn validate_config(cfg: &InstanceConfig) -> Result<(), String> {
    // A giveaway's one action is "enter", so a button is the only target.
    if cfg.target != "button" {
        return Err("A giveaway attaches to a button.".into());
    }

    if !is_snowflake(&cfg.guild_id) {
        return Err("Pick a server first (its id looks wrong).".into());
    }

    let prize = cfg.prize.trim();
    if prize.is_empty() {
        return Err("Give the giveaway a prize — what are people winning?".into());
    }
    if prize.chars().count() > MAX_PRIZE {
        return Err(format!(
            "The prize is too long (max {MAX_PRIZE} characters)."
        ));
    }

    if cfg.winner_count < 1 {
        return Err("A giveaway needs at least one winner.".into());
    }
    if cfg.winner_count > MAX_WINNERS {
        return Err(format!("At most {MAX_WINNERS} winners can be drawn."));
    }

    if let Some(desc) = cfg.description.as_deref() {
        if desc.chars().count() > MAX_DESCRIPTION {
            return Err(format!(
                "The description is too long (max {MAX_DESCRIPTION} characters)."
            ));
        }
    }

    if let Some(host) = cfg.host_user_id.as_deref() {
        if !host.is_empty() && !is_snowflake(host) {
            return Err("The host id doesn't look like a Discord user id.".into());
        }
    }

    if let Some(ends_at) = cfg.ends_at {
        // A unix-seconds timestamp in a sane window (after 2015, before ~2100).
        if !(1_420_070_400..=4_102_444_800).contains(&ends_at) {
            return Err("That end time looks wrong.".into());
        }
    }

    validate_roles(&cfg.requirements.roles, "requirement")?;
    validate_roles(&cfg.host_roles, "host")?;

    if cfg.requirements.min_account_age_days > MAX_ACCOUNT_AGE_DAYS {
        return Err("That minimum account age is unreasonably large.".into());
    }

    if let Some(text) = cfg.announcement.as_deref() {
        let text = text.trim();
        if !text.is_empty() && text.chars().count() > MAX_ANNOUNCEMENT {
            return Err(format!(
                "The custom announcement is too long (max {MAX_ANNOUNCEMENT} characters)."
            ));
        }
    }

    if let Some(template) = &cfg.message_template {
        // The template is the message's component tree — always a JSON array.
        if !template.is_array() {
            return Err("The message template is malformed.".into());
        }
        let len = serde_json::to_string(template)
            .map(|s| s.len())
            .unwrap_or(usize::MAX);
        if len > MAX_TEMPLATE_BYTES {
            return Err(
                "This message is too large to keep a live placeholder template for.".into(),
            );
        }
        // Live placeholders re-send the whole message from this service on every
        // click, and Discord refuses the entire edit over one picture it can't
        // fetch — so a template naming a browser-only upload would make every
        // click on the giveaway fail.
        let unsendable = crate::discord::unsendable_media(template);
        if !unsendable.is_empty() {
            return Err(unsendable_media_message(&unsendable));
        }
    }

    Ok(())
}

/// The refusal for a template that names pictures or files this service can't
/// send, naming them so the author can find and fix them.
fn unsendable_media_message(names: &[String]) -> String {
    let quoted = names
        .iter()
        .take(3)
        .map(|n| format!("“{n}”"))
        .collect::<Vec<_>>()
        .join(", ");
    let more = if names.len() > 3 { ", …" } else { "" };
    format!(
        "Your message uses live placeholders, so this service re-sends it on every click — and it can't send {quoted}{more}. A picture uploaded from your computer stays in your browser: paste an image link (https://…) into its URL field instead, and take out any File component (a re-sent message can't carry one). Or remove the giveaway placeholders from the message."
    )
}

/// Validate a list of role references: real snowflakes, no duplicates, bounded
/// count and name length. `kind` names the list in any error ("requirement"/"host").
fn validate_roles(roles: &[RoleRef], kind: &str) -> Result<(), String> {
    if roles.len() > MAX_ROLES {
        return Err(format!("Too many {kind} roles (max {MAX_ROLES})."));
    }
    let mut seen = HashSet::new();
    for role in roles {
        if !is_snowflake(&role.id) {
            return Err(format!("One of the {kind} roles has an invalid id."));
        }
        if !seen.insert(role.id.as_str()) {
            return Err(format!("The same {kind} role is listed twice."));
        }
        if role.name.chars().count() > 100 {
            return Err(format!("A {kind} role name is too long."));
        }
    }
    Ok(())
}

/// A Discord snowflake: 17–20 digits that fit the u64 Discord stores them in.
/// The old 15–25-digit slack let through ids past u64 that Discord answers
/// with a 400 — reachable by anyone through the open config API, and mapped to
/// a paging 502 before `ConnectError::InvalidId` existed.
pub fn is_snowflake(s: &str) -> bool {
    (17..=20).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_digit())
        && s.parse::<u64>().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Requirements;
    use serde_json::json;

    fn cfg(template: Option<serde_json::Value>) -> InstanceConfig {
        InstanceConfig {
            target: "button".into(),
            guild_id: "123456789012345678".into(),
            guild_name: String::new(),
            prize: "Nitro".into(),
            winner_count: 1,
            description: None,
            host_user_id: None,
            ends_at: None,
            requirements: Requirements::default(),
            host_roles: vec![],
            dm_winners: false,
            announcement: None,
            message_template: template,
        }
    }

    #[test]
    fn a_snowflake_is_17_to_20_digits_that_fit_a_u64() {
        assert!(is_snowflake("80351110224678912")); // 17 digits
        assert!(is_snowflake("123456789012345678"));
        assert!(is_snowflake("18446744073709551615")); // u64::MAX
        assert!(!is_snowflake("1234567890123456")); // 16 digits
        assert!(!is_snowflake("99999999999999999999")); // 20 digits, past u64
        assert!(!is_snowflake("123456789012345678901")); // 21 digits
        assert!(!is_snowflake("12345678901234567a"));
        assert!(!is_snowflake(""));
    }

    #[test]
    fn a_template_naming_a_browser_upload_is_refused_by_name() {
        let template = json!([
            { "type": 10, "content": "Win {prize}!" },
            { "type": 9, "components": [{ "type": 10, "content": "x" }],
              "accessory": { "type": 11, "media": { "url": "session://k1/banner.png" } } }
        ]);
        let err = validate_config(&cfg(Some(template))).unwrap_err();
        assert!(err.contains("banner.png"), "{err}");

        let file = json!([{ "type": 13, "file": { "url": "attachment://rules.pdf" } }]);
        assert!(validate_config(&cfg(Some(file))).is_err());

        let linked = json!([
            { "type": 10, "content": "Win {prize}!" },
            { "type": 12, "items": [{ "media": { "url": "https://cdn.example/p.png" } }] }
        ]);
        assert!(validate_config(&cfg(Some(linked))).is_ok());
        assert!(validate_config(&cfg(None)).is_ok());
    }
}
