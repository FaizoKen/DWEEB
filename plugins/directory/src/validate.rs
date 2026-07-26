//! Server-side validation of a config the iframe posted.
//!
//! The config UI does its own checking for a fast, friendly form, but that runs
//! in an untrusted browser — so every rule that matters is re-checked here. Each
//! message is written to be shown verbatim to the person configuring the
//! directory (the UI renders `data.error`), which is why they name the field and
//! say what to do rather than reporting a constraint.

use crate::store::{
    InstanceConfig, CHANNEL_SOURCE_CATEGORIES, CHANNEL_SOURCE_PICKED, MAX_CATEGORIES, MAX_CHANNELS,
    MAX_GROUPS, MAX_NOTES, MAX_ROLES, ROLE_SOURCE_PICKED, TARGET_STRING_SELECT,
};

/// Discord snowflakes are 64-bit ints rendered in decimal; every id we accept
/// (guild, role, channel) is one.
pub fn is_snowflake(s: &str) -> bool {
    let s = s.trim();
    (15..=25).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

/// Discord's cap on options in a select menu — the ceiling on how many sections
/// a `string_select` directory can offer.
const MAX_SELECT_OPTIONS: usize = 25;

pub fn validate_config(cfg: &InstanceConfig) -> Result<(), String> {
    if !is_snowflake(&cfg.guild_id) {
        return Err("That server id doesn't look right — it should be 17–20 digits.".into());
    }

    for note in &cfg.notes {
        if !is_snowflake(&note.id) {
            return Err("One of the notes is attached to something that isn't a valid id.".into());
        }
    }
    if cfg.notes.len() > MAX_NOTES {
        return Err(format!("You can add at most {MAX_NOTES} notes."));
    }
    for role in &cfg.requirements.roles {
        if !is_snowflake(&role.id) {
            return Err("One of the 'who can use this' roles isn't a valid role.".into());
        }
    }
    if cfg.requirements.min_account_age_days > 365 {
        return Err("The minimum account age can't be more than a year.".into());
    }

    if cfg.is_roles() {
        validate_roles_mode(cfg)?;
    } else {
        validate_channels_mode(cfg)?;
    }

    // A select needs something to put in its menu, and Discord caps that at 25.
    // Checked *after* the per-mode rules so the more specific complaint wins.
    if cfg.target == TARGET_STRING_SELECT {
        let sections = section_count(cfg);
        if sections == 0 {
            return Err(
                "A menu needs at least one section to choose from. Add a group (roles) or pick some categories (channels), or attach this to a button instead."
                    .into(),
            );
        }
        if sections > MAX_SELECT_OPTIONS {
            return Err(format!(
                "A menu can offer at most {MAX_SELECT_OPTIONS} sections — you have {sections}."
            ));
        }
    }

    Ok(())
}

fn validate_roles_mode(cfg: &InstanceConfig) -> Result<(), String> {
    if cfg.groups.len() > MAX_GROUPS {
        return Err(format!("You can have at most {MAX_GROUPS} groups."));
    }
    for group in &cfg.groups {
        if group.key.trim().is_empty() {
            return Err(
                "A group is missing its internal key — reload the panel and try again.".into(),
            );
        }
        for id in &group.role_ids {
            if !is_snowflake(id) {
                return Err(format!(
                    "The group \"{}\" contains something that isn't a role.",
                    display_name(&group.name, "Untitled")
                ));
            }
        }
        if group.role_ids.len() > MAX_ROLES {
            return Err(format!("A group can hold at most {MAX_ROLES} roles."));
        }
    }
    // Duplicate keys would make two select options resolve to the same section.
    let mut keys: Vec<&str> = cfg.groups.iter().map(|g| g.key.as_str()).collect();
    keys.sort_unstable();
    let before = keys.len();
    keys.dedup();
    if keys.len() != before {
        return Err(
            "Two groups share the same internal key — reload the panel and try again.".into(),
        );
    }

    for role in &cfg.roles {
        if !is_snowflake(&role.id) {
            return Err("One of the picked roles isn't a valid role.".into());
        }
    }
    if cfg.roles.len() > MAX_ROLES {
        return Err(format!("You can list at most {MAX_ROLES} roles."));
    }

    // Only the hand-picked source needs a list; "hoisted" and "staff" derive
    // theirs from the server, so an empty pick list is correct for them.
    if cfg.role_source == ROLE_SOURCE_PICKED && cfg.picked_role_ids().is_empty() {
        return Err(
            "Pick at least one role to list — or switch to \"roles shown separately\" / \"roles with moderation powers\" to build the list from the server automatically."
                .into(),
        );
    }
    Ok(())
}

fn validate_channels_mode(cfg: &InstanceConfig) -> Result<(), String> {
    for ch in &cfg.channels {
        if !is_snowflake(&ch.id) {
            return Err("One of the picked channels isn't a valid channel.".into());
        }
    }
    if cfg.channels.len() > MAX_CHANNELS {
        return Err(format!("You can list at most {MAX_CHANNELS} channels."));
    }
    for cat in &cfg.categories {
        if !is_snowflake(&cat.id) {
            return Err("One of the picked categories isn't a valid category.".into());
        }
    }
    if cfg.categories.len() > MAX_CATEGORIES {
        return Err(format!("You can pick at most {MAX_CATEGORIES} categories."));
    }
    if cfg.channel_source == CHANNEL_SOURCE_PICKED && cfg.channels.is_empty() {
        return Err("Pick at least one channel to list — or switch to \"every channel\".".into());
    }
    if cfg.channel_source == CHANNEL_SOURCE_CATEGORIES && cfg.categories.is_empty() {
        return Err("Pick at least one category to list — or switch to \"every channel\".".into());
    }
    Ok(())
}

/// How many sections a `string_select` directory would offer.
///
/// This has to agree with what the config UI wires onto the menu, and with what
/// the renderer resolves a pick against: role groups in roles mode, chosen
/// categories in channels mode (a category sweep is the only channels shape with
/// nameable sections).
fn section_count(cfg: &InstanceConfig) -> usize {
    if cfg.is_roles() {
        cfg.groups.len()
    } else if cfg.channel_source == CHANNEL_SOURCE_CATEGORIES {
        cfg.categories.len()
    } else {
        0
    }
}

fn display_name<'a>(name: &'a str, fallback: &'a str) -> &'a str {
    if name.trim().is_empty() {
        fallback
    } else {
        name.trim()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{
        tests::base_config, ChannelRef, Group, Note, RoleRef, CHANNEL_SOURCE_ALL, MODE_CHANNELS,
        ROLE_SOURCE_HOISTED, ROLE_SOURCE_STAFF, TARGET_BUTTON,
    };

    fn role_ref(id: &str) -> RoleRef {
        RoleRef {
            id: id.into(),
            name: "R".into(),
            color: 0,
        }
    }
    fn good_role_id() -> String {
        "123456789012345678".to_string()
    }

    #[test]
    fn snowflake_shape() {
        assert!(is_snowflake("123456789012345678"));
        assert!(is_snowflake("  123456789012345678  "));
        assert!(!is_snowflake("12345"));
        assert!(!is_snowflake("12345678901234567a"));
        assert!(!is_snowflake(""));
    }

    #[test]
    fn a_minimal_picked_roster_is_valid() {
        let mut cfg = base_config();
        cfg.roles = vec![role_ref(&good_role_id())];
        assert!(validate_config(&cfg).is_ok(), "{:?}", validate_config(&cfg));
    }

    #[test]
    fn a_bad_guild_id_is_rejected_first() {
        let mut cfg = base_config();
        cfg.guild_id = "nope".into();
        cfg.roles = vec![role_ref(&good_role_id())];
        assert!(validate_config(&cfg).unwrap_err().contains("server id"));
    }

    /// A hand-picked roster with nothing picked would render an empty card, so
    /// it's refused at save with a message that points at the two derived
    /// sources as the alternative.
    #[test]
    fn a_picked_roster_needs_at_least_one_role() {
        let cfg = base_config();
        let err = validate_config(&cfg).unwrap_err();
        assert!(err.contains("Pick at least one role"), "{err}");
    }

    /// The derived sources build their list from the server, so an empty pick
    /// list is the correct state for them — not an error.
    #[test]
    fn derived_role_sources_need_no_picks() {
        for source in [ROLE_SOURCE_HOISTED, ROLE_SOURCE_STAFF] {
            let mut cfg = base_config();
            cfg.role_source = source.into();
            assert!(
                validate_config(&cfg).is_ok(),
                "{source} should not need picks"
            );
        }
    }

    #[test]
    fn groups_satisfy_the_pick_requirement() {
        let mut cfg = base_config();
        cfg.groups = vec![Group {
            key: "g1".into(),
            name: "Staff".into(),
            emoji: None,
            role_ids: vec![good_role_id()],
        }];
        assert!(validate_config(&cfg).is_ok(), "{:?}", validate_config(&cfg));
    }

    /// Two groups on one key would make two select options resolve to the same
    /// section — a silent, confusing bug rather than a visible error.
    #[test]
    fn duplicate_group_keys_are_rejected() {
        let mut cfg = base_config();
        let g = |key: &str, name: &str| Group {
            key: key.into(),
            name: name.into(),
            emoji: None,
            role_ids: vec![good_role_id()],
        };
        cfg.groups = vec![g("dup", "A"), g("dup", "B")];
        assert!(validate_config(&cfg)
            .unwrap_err()
            .contains("same internal key"));

        cfg.groups = vec![g("a", "A"), g("b", "B")];
        assert!(validate_config(&cfg).is_ok());
    }

    #[test]
    fn a_group_naming_a_non_role_is_rejected_by_name() {
        let mut cfg = base_config();
        cfg.groups = vec![Group {
            key: "g1".into(),
            name: "Leadership".into(),
            emoji: None,
            role_ids: vec!["not-an-id".into()],
        }];
        let err = validate_config(&cfg).unwrap_err();
        assert!(
            err.contains("Leadership"),
            "the error must name the group: {err}"
        );
    }

    #[test]
    fn over_the_limits_is_rejected() {
        let mut cfg = base_config();
        cfg.roles = (0..MAX_ROLES + 1)
            .map(|i| role_ref(&format!("{:018}", i + 1)))
            .collect();
        assert!(validate_config(&cfg).unwrap_err().contains("at most"));

        let mut cfg = base_config();
        cfg.roles = vec![role_ref(&good_role_id())];
        cfg.notes = (0..MAX_NOTES + 1)
            .map(|i| Note {
                id: format!("{:018}", i + 1),
                text: "x".into(),
            })
            .collect();
        assert!(validate_config(&cfg).unwrap_err().contains("notes"));
    }

    #[test]
    fn a_note_on_a_non_id_is_rejected() {
        let mut cfg = base_config();
        cfg.roles = vec![role_ref(&good_role_id())];
        cfg.notes = vec![Note {
            id: "whatever".into(),
            text: "hi".into(),
        }];
        assert!(validate_config(&cfg).unwrap_err().contains("valid id"));
    }

    #[test]
    fn a_gate_role_must_be_a_role_and_the_age_is_bounded() {
        let mut cfg = base_config();
        cfg.roles = vec![role_ref(&good_role_id())];
        cfg.requirements.roles = vec![role_ref("nope")];
        assert!(validate_config(&cfg)
            .unwrap_err()
            .contains("who can use this"));

        cfg.requirements.roles = vec![role_ref(&good_role_id())];
        cfg.requirements.min_account_age_days = 400;
        assert!(validate_config(&cfg).unwrap_err().contains("year"));
    }

    // ── Channels mode ───────────────────────────────────────────────────────

    #[test]
    fn a_channel_sweep_needs_no_picks_but_a_pick_list_does() {
        let mut cfg = base_config();
        cfg.mode = MODE_CHANNELS.into();
        cfg.channel_source = CHANNEL_SOURCE_ALL.into();
        assert!(validate_config(&cfg).is_ok());

        cfg.channel_source = CHANNEL_SOURCE_PICKED.into();
        assert!(validate_config(&cfg)
            .unwrap_err()
            .contains("at least one channel"));
        cfg.channels = vec![ChannelRef {
            id: good_role_id(),
            name: "c".into(),
            kind: 0,
        }];
        assert!(validate_config(&cfg).is_ok());

        cfg.channel_source = CHANNEL_SOURCE_CATEGORIES.into();
        assert!(validate_config(&cfg)
            .unwrap_err()
            .contains("at least one category"));
        cfg.categories = vec![ChannelRef {
            id: good_role_id(),
            name: "cat".into(),
            kind: 4,
        }];
        assert!(validate_config(&cfg).is_ok());
    }

    // ── Select targets ──────────────────────────────────────────────────────

    /// A select with no sections would post a menu with no options, which
    /// Discord rejects — so it's caught here, with a message that offers the
    /// button as the way out.
    #[test]
    fn a_select_needs_sections() {
        let mut cfg = base_config();
        cfg.target = TARGET_STRING_SELECT.into();
        cfg.roles = vec![role_ref(&good_role_id())];
        let err = validate_config(&cfg).unwrap_err();
        assert!(err.contains("at least one section"), "{err}");

        // Groups give it sections.
        cfg.groups = vec![Group {
            key: "g1".into(),
            name: "Staff".into(),
            emoji: None,
            role_ids: vec![good_role_id()],
        }];
        assert!(validate_config(&cfg).is_ok());

        // A button has no such requirement.
        let mut cfg = base_config();
        cfg.target = TARGET_BUTTON.into();
        cfg.roles = vec![role_ref(&good_role_id())];
        assert!(validate_config(&cfg).is_ok());
    }

    #[test]
    fn a_channels_select_takes_its_sections_from_categories() {
        let mut cfg = base_config();
        cfg.mode = MODE_CHANNELS.into();
        cfg.target = TARGET_STRING_SELECT.into();
        cfg.channel_source = CHANNEL_SOURCE_ALL.into();
        // "every channel" has no nameable sections.
        assert!(validate_config(&cfg)
            .unwrap_err()
            .contains("at least one section"));

        cfg.channel_source = CHANNEL_SOURCE_CATEGORIES.into();
        cfg.categories = (0..3)
            .map(|i| ChannelRef {
                id: format!("{:018}", i + 1),
                name: "cat".into(),
                kind: 4,
            })
            .collect();
        assert!(validate_config(&cfg).is_ok());
    }

    #[test]
    fn a_select_cannot_exceed_discords_option_cap() {
        let mut cfg = base_config();
        cfg.mode = MODE_CHANNELS.into();
        cfg.target = TARGET_STRING_SELECT.into();
        cfg.channel_source = CHANNEL_SOURCE_CATEGORIES.into();
        // MAX_CATEGORIES is 25, exactly Discord's option cap, so the store limit
        // is what bites first — pin the pair so raising one alone can't let a
        // config through that Discord would then reject.
        const _: () = assert!(MAX_CATEGORIES <= MAX_SELECT_OPTIONS);
        cfg.categories = (0..MAX_CATEGORIES + 1)
            .map(|i| ChannelRef {
                id: format!("{:018}", i + 1),
                name: "cat".into(),
                kind: 4,
            })
            .collect();
        assert!(validate_config(&cfg).unwrap_err().contains("at most"));
    }
}
