//! Validation for panel config submitted by the (untrusted) browser.
//!
//! Like self-role there is no SSRF guard to write — this service only ever calls
//! `discord.com`, a fixed host, and uses the deployment's shared bot token, so
//! there is no per-instance secret or URL to sanitise. The checks here keep a
//! stored panel *coherent and within Discord's limits*: a real target with a
//! real guild, snowflake ids, sane bounds on every count and string, and a
//! config whose pieces fit together (e.g. transcripts need a log channel) — so a
//! click never produces an action Discord rejects with an opaque error.

use std::collections::HashSet;

use crate::store::InstanceConfig;

const MAX_STAFF_ROLES: usize = 20;
const MAX_INTAKE: usize = 5;
const MAX_TOPICS: usize = 25; // Discord's string-select option ceiling.
const MAX_WELCOME: usize = 1500; // leaves headroom under the 2000-char content cap.
const MAX_CUSTOM_REPLY: usize = 500;
const MAX_OPEN_CAP: u32 = 50;
const MAX_COOLDOWN_SECS: u32 = 86_400; // a day.

pub fn validate_config(cfg: &InstanceConfig) -> Result<(), String> {
    let is_select = match cfg.target.as_str() {
        "button" => false,
        "string_select" => true,
        _ => return Err("Unsupported component target.".into()),
    };

    if !is_snowflake(&cfg.guild_id) {
        return Err("Pick a server first (its id looks wrong).".into());
    }

    // Staff roles — optional (admins always see tickets), but bounded and clean.
    if cfg.staff_roles.len() > MAX_STAFF_ROLES {
        return Err(format!("At most {MAX_STAFF_ROLES} staff roles."));
    }
    let mut seen = HashSet::new();
    for role in &cfg.staff_roles {
        if !is_snowflake(&role.id) {
            return Err("One of the staff roles has an invalid id.".into());
        }
        if !seen.insert(role.id.as_str()) {
            return Err("The same staff role is listed twice.".into());
        }
        if role.name.chars().count() > 100 {
            return Err("A staff role name is too long.".into());
        }
    }

    if let Some(cat) = &cfg.category_id {
        if !is_snowflake(cat) {
            return Err("That ticket category doesn't look right.".into());
        }
    }
    if let Some(log) = &cfg.log_channel_id {
        if !is_snowflake(log) {
            return Err("That log channel doesn't look right.".into());
        }
    }
    // Transcripts need somewhere to go.
    if cfg.transcripts && cfg.log_channel_id.is_none() {
        return Err("Pick a log channel to post transcripts to, or turn transcripts off.".into());
    }

    if cfg.naming != "number" && cfg.naming != "username" {
        return Err("Channel naming must be \"number\" or \"username\".".into());
    }

    let welcome = cfg.welcome.trim();
    if welcome.is_empty() {
        return Err("Write a welcome message for new tickets.".into());
    }
    if welcome.chars().count() > MAX_WELCOME {
        return Err(format!(
            "The welcome message must be \u{2264} {MAX_WELCOME} characters."
        ));
    }

    // Intake questions (0–5).
    if cfg.intake.len() > MAX_INTAKE {
        return Err(format!(
            "An intake form can have at most {MAX_INTAKE} questions."
        ));
    }
    let mut intake_ids = HashSet::new();
    for f in &cfg.intake {
        let id_len = f.id.chars().count();
        if id_len == 0 || id_len > 100 {
            return Err("Each intake field id must be 1–100 characters.".into());
        }
        if !intake_ids.insert(f.id.as_str()) {
            return Err("Intake field ids must be unique.".into());
        }
        let label = f.label.trim();
        if label.is_empty() || label.chars().count() > 45 {
            return Err("Each intake question must be 1–45 characters.".into());
        }
        if f.style != "short" && f.style != "paragraph" {
            return Err("Intake field style must be \"short\" or \"paragraph\".".into());
        }
        if let Some(p) = &f.placeholder {
            if p.chars().count() > 100 {
                return Err("An intake placeholder must be \u{2264} 100 characters.".into());
            }
        }
    }

    // Topics: required (1–25) for a select, forbidden for a button.
    if is_select {
        if cfg.topics.is_empty() {
            return Err("Add at least one topic for the menu.".into());
        }
        if cfg.topics.len() > MAX_TOPICS {
            return Err(format!("A menu can have at most {MAX_TOPICS} topics."));
        }
        let mut topic_ids = HashSet::new();
        for t in &cfg.topics {
            let id_len = t.id.chars().count();
            if id_len == 0 || id_len > 100 {
                return Err("Each topic id must be 1–100 characters.".into());
            }
            if !topic_ids.insert(t.id.as_str()) {
                return Err("Topic ids must be unique.".into());
            }
            let label = t.label.trim();
            if label.is_empty() || label.chars().count() > 100 {
                return Err("Each topic label must be 1–100 characters.".into());
            }
            if let Some(d) = &t.description {
                if d.chars().count() > 100 {
                    return Err("A topic description must be \u{2264} 100 characters.".into());
                }
            }
        }
    } else if !cfg.topics.is_empty() {
        return Err("A button panel doesn't use topics.".into());
    }

    if cfg.close_mode != "delete" && cfg.close_mode != "lock" {
        return Err("Close behaviour must be \"delete\" or \"lock\".".into());
    }

    if cfg.max_open_per_user > MAX_OPEN_CAP {
        return Err(format!(
            "The per-user open limit can't exceed {MAX_OPEN_CAP}."
        ));
    }
    if cfg.cooldown_secs > MAX_COOLDOWN_SECS {
        return Err("The cooldown can't exceed a day.".into());
    }

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

/// Discord snowflakes are 17–20 digits today; accept a little slack.
pub fn is_snowflake(s: &str) -> bool {
    (15..=25).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{IntakeField, ResponseDef, StaffRole, Topic};

    const GUILD: &str = "123456789012345678";
    const ROLE: &str = "223456789012345678";

    fn button_cfg() -> InstanceConfig {
        InstanceConfig {
            target: "button".into(),
            guild_id: GUILD.into(),
            guild_name: "Server".into(),
            staff_roles: vec![StaffRole {
                id: ROLE.into(),
                name: "Support".into(),
                color: 0,
            }],
            category_id: None,
            category_name: String::new(),
            log_channel_id: None,
            log_channel_name: String::new(),
            naming: "number".into(),
            welcome: "Hi {user}!".into(),
            ping_opener: true,
            ping_staff: false,
            intake: vec![],
            topics: vec![],
            close_mode: "delete".into(),
            close_confirmation: true,
            allow_opener_close: true,
            claim_enabled: true,
            transcripts: false,
            max_open_per_user: 1,
            cooldown_secs: 30,
            response: ResponseDef::default(),
        }
    }

    #[test]
    fn a_minimal_button_config_is_valid() {
        assert!(validate_config(&button_cfg()).is_ok());
    }

    #[test]
    fn rejects_bad_target_and_guild() {
        let mut c = button_cfg();
        c.target = "user_select".into();
        assert!(validate_config(&c).is_err());
        let mut c = button_cfg();
        c.guild_id = "nope".into();
        assert!(validate_config(&c).is_err());
    }

    #[test]
    fn empty_or_overlong_welcome_is_rejected() {
        let mut c = button_cfg();
        c.welcome = "   ".into();
        assert!(validate_config(&c).is_err());
        c.welcome = "x".repeat(MAX_WELCOME + 1);
        assert!(validate_config(&c).is_err());
    }

    #[test]
    fn transcripts_require_a_log_channel() {
        let mut c = button_cfg();
        c.transcripts = true;
        assert!(validate_config(&c).is_err());
        c.log_channel_id = Some("323456789012345678".into());
        assert!(validate_config(&c).is_ok());
    }

    #[test]
    fn intake_is_bounded_and_unique() {
        let mut c = button_cfg();
        c.intake = (0..6)
            .map(|i| IntakeField {
                id: format!("f{i}"),
                label: "Q".into(),
                style: "short".into(),
                required: false,
                placeholder: None,
            })
            .collect();
        assert!(validate_config(&c).is_err()); // 6 > 5
        c.intake = vec![
            IntakeField {
                id: "dup".into(),
                label: "Q".into(),
                style: "short".into(),
                required: false,
                placeholder: None,
            },
            IntakeField {
                id: "dup".into(),
                label: "Q".into(),
                style: "short".into(),
                required: false,
                placeholder: None,
            },
        ];
        assert!(validate_config(&c).is_err()); // duplicate id
    }

    #[test]
    fn a_select_needs_topics_and_a_button_forbids_them() {
        let mut c = button_cfg();
        c.target = "string_select".into();
        // select with no topics → error
        assert!(validate_config(&c).is_err());
        c.topics = vec![Topic {
            id: "t1".into(),
            label: "Billing".into(),
            emoji: None,
            description: None,
        }];
        assert!(validate_config(&c).is_ok());
        // a button with topics → error
        let mut b = button_cfg();
        b.topics = vec![Topic {
            id: "t1".into(),
            label: "Billing".into(),
            emoji: None,
            description: None,
        }];
        assert!(validate_config(&b).is_err());
    }

    #[test]
    fn duplicate_staff_roles_and_bad_ids_rejected() {
        let mut c = button_cfg();
        c.staff_roles = vec![
            StaffRole {
                id: ROLE.into(),
                name: "A".into(),
                color: 0,
            },
            StaffRole {
                id: ROLE.into(),
                name: "B".into(),
                color: 0,
            },
        ];
        assert!(validate_config(&c).is_err());
        c.staff_roles = vec![StaffRole {
            id: "bad".into(),
            name: "A".into(),
            color: 0,
        }];
        assert!(validate_config(&c).is_err());
    }

    #[test]
    fn bounds_on_limit_and_cooldown() {
        let mut c = button_cfg();
        c.max_open_per_user = MAX_OPEN_CAP + 1;
        assert!(validate_config(&c).is_err());
        let mut c = button_cfg();
        c.cooldown_secs = MAX_COOLDOWN_SECS + 1;
        assert!(validate_config(&c).is_err());
    }

    #[test]
    fn custom_reply_must_be_nonempty_and_bounded() {
        let mut c = button_cfg();
        c.response = ResponseDef {
            mode: "custom".into(),
            text: Some("  ".into()),
        };
        assert!(validate_config(&c).is_err());
        c.response = ResponseDef {
            mode: "custom".into(),
            text: Some("x".repeat(MAX_CUSTOM_REPLY + 1)),
        };
        assert!(validate_config(&c).is_err());
        c.response = ResponseDef {
            mode: "custom".into(),
            text: Some("Thanks!".into()),
        };
        assert!(validate_config(&c).is_ok());
    }
}
