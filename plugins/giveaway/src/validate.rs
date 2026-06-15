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
        return Err(format!("The prize is too long (max {MAX_PRIZE} characters)."));
    }

    if cfg.winner_count < 1 {
        return Err("A giveaway needs at least one winner.".into());
    }
    if cfg.winner_count > MAX_WINNERS {
        return Err(format!("At most {MAX_WINNERS} winners can be drawn."));
    }

    if let Some(desc) = cfg.description.as_deref() {
        if desc.chars().count() > MAX_DESCRIPTION {
            return Err(format!("The description is too long (max {MAX_DESCRIPTION} characters)."));
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
            return Err(format!("The custom announcement is too long (max {MAX_ANNOUNCEMENT} characters)."));
        }
    }

    Ok(())
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

/// Discord snowflakes are 17–20 digits today; accept a little slack.
pub fn is_snowflake(s: &str) -> bool {
    (15..=25).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}
