//! Validation for instance config submitted by the (untrusted) browser.
//!
//! This service never calls a third party, so there's no SSRF guard to write.
//! The checks here keep a stored instance *coherent and within Discord's
//! limits*: one of the four auto-populated select targets, an optional real
//! guild id (cosmetic, for `{server}`), and a non-empty, bounded reply — all the
//! interaction path later trusts.

use crate::store::{InstanceConfig, TARGET_CHANNEL, TARGET_MENTIONABLE, TARGET_ROLE, TARGET_USER};

/// Reply body cap. Components V2 allows ~4000 chars across a message; 1500 is a
/// generous confirmation and leaves headroom for the title + resolved mentions.
const MAX_BODY: usize = 1500;
const MAX_TITLE: usize = 200;

pub fn validate_config(cfg: &InstanceConfig) -> Result<(), String> {
    match cfg.target.as_str() {
        TARGET_USER | TARGET_ROLE | TARGET_MENTIONABLE | TARGET_CHANNEL => {}
        _ => return Err("Unsupported component target.".into()),
    }

    // The guild is optional (the reply is portable), but if one is set it must
    // look real — it's what `{server}` renders against.
    if let Some(gid) = cfg.guild_id.as_deref() {
        if !gid.is_empty() && !is_snowflake(gid) {
            return Err("That server id doesn't look right.".into());
        }
    }

    if let Some(title) = cfg.title.as_deref() {
        if title.chars().count() > MAX_TITLE {
            return Err(format!(
                "The heading is too long (max {MAX_TITLE} characters)."
            ));
        }
    }

    let body = cfg.body.trim();
    if body.is_empty() {
        return Err(
            "The reply message is empty — write what people should see when they pick.".into(),
        );
    }
    if cfg.body.chars().count() > MAX_BODY {
        return Err(format!(
            "The reply is too long (max {MAX_BODY} characters)."
        ));
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

    fn cfg(target: &str, body: &str) -> InstanceConfig {
        InstanceConfig {
            target: target.into(),
            guild_id: None,
            guild_name: String::new(),
            title: None,
            body: body.into(),
        }
    }

    #[test]
    fn each_of_the_four_targets_is_valid() {
        for t in [TARGET_USER, TARGET_ROLE, TARGET_MENTIONABLE, TARGET_CHANNEL] {
            assert!(
                validate_config(&cfg(t, "You picked {picks}.")).is_ok(),
                "{t}"
            );
        }
    }

    #[test]
    fn rejects_unknown_or_string_select_target() {
        assert!(validate_config(&cfg("string_select", "x")).is_err());
        assert!(validate_config(&cfg("button", "x")).is_err());
    }

    #[test]
    fn rejects_empty_and_overlong_body() {
        assert!(validate_config(&cfg(TARGET_USER, "   ")).is_err());
        let long = "x".repeat(MAX_BODY + 1);
        assert!(validate_config(&cfg(TARGET_USER, &long)).is_err());
    }

    #[test]
    fn rejects_overlong_title() {
        let mut c = cfg(TARGET_USER, "ok");
        c.title = Some("t".repeat(MAX_TITLE + 1));
        assert!(validate_config(&c).is_err());
    }

    #[test]
    fn validates_optional_guild_id() {
        let mut c = cfg(TARGET_USER, "ok");
        c.guild_id = Some("not-a-snowflake".into());
        assert!(validate_config(&c).is_err());
        c.guild_id = Some("123456789012345678".into());
        assert!(validate_config(&c).is_ok());
        c.guild_id = None;
        assert!(validate_config(&c).is_ok());
    }
}
