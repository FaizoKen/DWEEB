//! Validation for the poll config submitted by the (untrusted) browser.
//!
//! This service only ever calls `discord.com`, with a fixed host, so there's no
//! SSRF guard to write. The checks here keep a stored poll *coherent*: a real
//! guild, a non-empty question, 2+ well-keyed options, a sane choice cap, real
//! snowflake role ids, and bounded text — everything the interaction path later
//! trusts (in particular the option **keys**, which `sanitize_picks` treats as
//! the authoritative vocabulary for every forgeable ballot).

use std::collections::HashSet;

use crate::store::{InstanceConfig, PollOption, RoleRef};

/// Discord's string-select ceiling — and a sane poll size.
const MAX_OPTIONS: usize = 25;
const MIN_OPTIONS: usize = 2;
/// Requirement / host role caps — a string select tops out at 25 anyway.
const MAX_ROLES: usize = 25;
const MAX_QUESTION: usize = 300;
/// Discord's per-field cap for a select option label/description.
const MAX_OPTION_TEXT: usize = 100;
const MAX_ANNOUNCEMENT: usize = 1500;
/// Cap on the stored message template (a Components V2 tree). A real V2 message
/// tops out near 4 KB of text plus component scaffolding; 16 KB is generous slack
/// while still bounding what a single row can hold.
const MAX_TEMPLATE_BYTES: usize = 16 * 1024;
/// Accept an account-age floor up to ~5 years; beyond that it's a typo.
const MAX_ACCOUNT_AGE_DAYS: u32 = 1825;

pub fn validate_config(cfg: &InstanceConfig) -> Result<(), String> {
    if cfg.target != "button" && cfg.target != "string_select" {
        return Err("A poll attaches to a button or a select menu.".into());
    }

    if !is_snowflake(&cfg.guild_id) {
        return Err("Pick a server first (its id looks wrong).".into());
    }

    let question = cfg.question.trim();
    if question.is_empty() {
        return Err("Give the poll a question — what are people voting on?".into());
    }
    if question.chars().count() > MAX_QUESTION {
        return Err(format!(
            "The question is too long (max {MAX_QUESTION} characters)."
        ));
    }

    validate_options(&cfg.options)?;

    if cfg.max_choices < 1 {
        return Err("A ballot must allow at least one pick.".into());
    }
    if cfg.max_choices as usize > cfg.options.len() {
        return Err("A ballot can't allow more picks than there are options.".into());
    }

    if let Some(ends_at) = cfg.ends_at {
        // A unix-seconds timestamp in a sane window (after 2015, before ~2100).
        if !(1_420_070_400..=4_102_444_800).contains(&ends_at) {
            return Err("That closing time looks wrong.".into());
        }
    }

    validate_roles(&cfg.requirements.roles, "vote-gate")?;
    validate_roles(&cfg.host_roles, "host")?;

    if cfg.requirements.min_account_age_days > MAX_ACCOUNT_AGE_DAYS {
        return Err("That minimum account age is unreasonably large.".into());
    }

    if let Some(text) = cfg.close_announcement.as_deref() {
        let text = text.trim();
        if !text.is_empty() && text.chars().count() > MAX_ANNOUNCEMENT {
            return Err(format!(
                "The custom close announcement is too long (max {MAX_ANNOUNCEMENT} characters)."
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
    }

    Ok(())
}

/// Validate the option list: bounded count, unique well-formed keys (the
/// vocabulary every ballot is checked against), non-empty bounded labels, and
/// bounded descriptions/emoji.
fn validate_options(options: &[PollOption]) -> Result<(), String> {
    if options.len() < MIN_OPTIONS {
        return Err("A poll needs at least two options.".into());
    }
    if options.len() > MAX_OPTIONS {
        return Err(format!("A poll can hold at most {MAX_OPTIONS} options."));
    }
    let mut seen = HashSet::new();
    for option in options {
        if !is_option_key(&option.key) {
            return Err("One of the options has a malformed key.".into());
        }
        if !seen.insert(option.key.as_str()) {
            return Err("Two options share the same key.".into());
        }
        let label = option.label.trim();
        if label.is_empty() {
            return Err("Every option needs a label.".into());
        }
        if label.chars().count() > MAX_OPTION_TEXT {
            return Err(format!(
                "An option label is too long (max {MAX_OPTION_TEXT} characters)."
            ));
        }
        if let Some(desc) = option.description.as_deref() {
            if desc.chars().count() > MAX_OPTION_TEXT {
                return Err(format!(
                    "An option description is too long (max {MAX_OPTION_TEXT} characters)."
                ));
            }
        }
        if let Some(emoji) = &option.emoji {
            if let Some(id) = emoji.id.as_deref() {
                if !is_snowflake(id) {
                    return Err("An option's custom emoji id looks wrong.".into());
                }
            }
            if emoji
                .name
                .as_deref()
                .is_some_and(|n| n.chars().count() > 64)
            {
                return Err("An option's emoji is too long.".into());
            }
        }
    }
    Ok(())
}

/// An option key: 1–32 of `[a-z0-9_-]`, and it must not start with `_` — the
/// store reserves the `_`-prefixed namespace (e.g. `_total`) for its own
/// counters, so a crafted key can never collide with them.
fn is_option_key(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && !s.starts_with('_')
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// Validate a list of role references: real snowflakes, no duplicates, bounded
/// count and name length. `kind` names the list in any error ("vote-gate"/"host").
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

/// Discord snowflakes are 17–20 digits today; accept a little slack.
pub fn is_snowflake(s: &str) -> bool {
    (15..=25).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{EmojiRef, Requirements};

    fn opt(key: &str, label: &str) -> PollOption {
        PollOption {
            key: key.into(),
            label: label.into(),
            description: None,
            emoji: None,
        }
    }

    fn cfg(target: &str, options: Vec<PollOption>) -> InstanceConfig {
        InstanceConfig {
            target: target.into(),
            guild_id: "123456789012345678".into(),
            guild_name: String::new(),
            question: "What next?".into(),
            options,
            max_choices: 1,
            allow_change: true,
            hide_results: false,
            ends_at: None,
            requirements: Requirements::default(),
            host_roles: vec![],
            close_announcement: None,
            message_template: None,
        }
    }

    fn two() -> Vec<PollOption> {
        vec![opt("a", "Alpha"), opt("b", "Beta")]
    }

    #[test]
    fn accepts_a_sane_config_on_both_targets() {
        assert!(validate_config(&cfg("button", two())).is_ok());
        assert!(validate_config(&cfg("string_select", two())).is_ok());
        assert!(validate_config(&cfg("user_select", two())).is_err());
    }

    #[test]
    fn requires_a_question_and_a_real_guild() {
        let mut c = cfg("button", two());
        c.question = "  ".into();
        assert!(validate_config(&c).is_err());
        let mut c = cfg("button", two());
        c.guild_id = "nope".into();
        assert!(validate_config(&c).is_err());
    }

    #[test]
    fn bounds_the_option_list() {
        assert!(validate_config(&cfg("button", vec![opt("a", "Only")])).is_err());
        let many: Vec<PollOption> = (0..26).map(|i| opt(&format!("o{i}"), "X")).collect();
        assert!(validate_config(&cfg("button", many)).is_err());
    }

    #[test]
    fn rejects_bad_keys_duplicates_and_reserved_prefixes() {
        assert!(validate_config(&cfg("button", vec![opt("a", "A"), opt("a", "B")])).is_err());
        assert!(validate_config(&cfg("button", vec![opt("a", "A"), opt("UPPER", "B")])).is_err());
        // `_`-prefixed keys are reserved for the store's own counters.
        assert!(validate_config(&cfg("button", vec![opt("a", "A"), opt("_total", "B")])).is_err());
        assert!(validate_config(&cfg("button", vec![opt("a", "A"), opt("", "B")])).is_err());
    }

    #[test]
    fn bounds_choices_to_the_option_count() {
        let mut c = cfg("string_select", two());
        c.max_choices = 0;
        assert!(validate_config(&c).is_err());
        c.max_choices = 3;
        assert!(validate_config(&c).is_err());
        c.max_choices = 2;
        assert!(validate_config(&c).is_ok());
    }

    #[test]
    fn validates_emoji_shapes() {
        let mut bad = opt("a", "A");
        bad.emoji = Some(EmojiRef {
            id: Some("nope".into()),
            name: None,
            animated: false,
        });
        assert!(validate_config(&cfg("button", vec![bad, opt("b", "B")])).is_err());
        let mut good = opt("a", "A");
        good.emoji = Some(EmojiRef {
            id: None,
            name: Some("🎉".into()),
            animated: false,
        });
        assert!(validate_config(&cfg("button", vec![good, opt("b", "B")])).is_ok());
    }

    #[test]
    fn bounds_the_deadline_and_template() {
        let mut c = cfg("button", two());
        c.ends_at = Some(1);
        assert!(validate_config(&c).is_err());
        let mut c = cfg("button", two());
        c.message_template = Some(serde_json::json!({ "not": "an array" }));
        assert!(validate_config(&c).is_err());
        let mut c = cfg("button", two());
        c.message_template = Some(serde_json::json!([{ "type": 10, "content": "{results}" }]));
        assert!(validate_config(&c).is_ok());
    }
}
