//! Validation for instance config submitted by the (untrusted) browser.
//!
//! Two jobs. The security-critical one is the forward-webhook **SSRF guard**:
//! the target URL is user-supplied and we POST to it server-side, so we only
//! permit genuine Discord incoming-webhook URLs. Without this, a caller could
//! aim the service at internal/metadata endpoints. The rest keeps a stored form
//! *coherent and within Discord's limits* — a title, an optional intro and
//! 1–5 questions in at most five slots, each question's input inside the
//! bounds Discord documents for its kind, and a reply that will actually
//! render — so a click never produces a modal Discord rejects.

use std::collections::HashSet;

use crate::store::{kind, InstanceConfig, ModalField};

/// The modal's intro text (a Text Display) is capped here, well inside
/// Discord's own text budget: a modal is a form, not an article.
pub const MAX_INTRO: usize = 1000;
/// Discord: a String Select holds at most 25 options; a Radio Group 2–10; a
/// Checkbox Group 1–10.
const MAX_SELECT_OPTIONS: usize = 25;
const MAX_GROUP_OPTIONS: usize = 10;
/// Discord: the most picks a select allows.
const MAX_SELECT_PICKS: u8 = 25;

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
    if let Some(intro) = cfg.modal.intro.as_deref() {
        if intro.chars().count() > MAX_INTRO {
            return Err(format!("The intro text must be ≤ {MAX_INTRO} characters."));
        }
    }
    // The intro takes one of the modal's five top-level slots.
    let slots = cfg.modal.fields.len() + usize::from(cfg.modal.intro_text().is_some());
    if slots > crate::discord::MAX_MODAL_COMPONENTS {
        return Err("With an intro, a modal has room for 4 questions.".into());
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
        if !kind::ALL.contains(&f.kind.as_str()) {
            return Err(format!("Question “{label}” has an unknown answer type."));
        }
        if let Some(d) = &f.description {
            if d.chars().count() > 100 {
                return Err(format!(
                    "Question “{label}”: the help text must be ≤ 100 characters."
                ));
            }
        }
        if f.kind != kind::TEXT {
            validate_choice_field(f, label)?;
            continue;
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

/// The bounds Discord documents for every question that isn't a text input.
fn validate_choice_field(f: &ModalField, label: &str) -> Result<(), String> {
    let k = f.kind.as_str();
    if k == kind::CHECKBOX {
        // Discord: "A Checkbox cannot be marked required" — it suggests a
        // one-option Checkbox Group for that.
        if f.required {
            return Err(format!(
                "Question “{label}”: a single checkbox can't be required. Use a Checkboxes \
                 question with one option instead."
            ));
        }
        return Ok(());
    }

    if kind::has_options(k) {
        let (min, max) = match k {
            kind::SELECT => (1, MAX_SELECT_OPTIONS),
            kind::RADIO => (2, MAX_GROUP_OPTIONS),
            _ => (1, MAX_GROUP_OPTIONS),
        };
        let n = f.options.len();
        if n < min || n > max {
            return Err(format!(
                "Question “{label}” needs between {min} and {max} choices."
            ));
        }
        let mut values = HashSet::new();
        for o in &f.options {
            let (l, v) = (o.label.trim(), o.value.trim());
            if l.is_empty() || l.chars().count() > 100 || v.is_empty() || v.chars().count() > 100 {
                return Err(format!(
                    "Question “{label}”: every choice needs a name of 1–100 characters."
                ));
            }
            if o.description
                .as_deref()
                .is_some_and(|d| d.chars().count() > 100)
            {
                return Err(format!(
                    "Question “{label}”: a choice's description must be ≤ 100 characters."
                ));
            }
            if !values.insert(v) {
                return Err(format!("Question “{label}” lists the same choice twice."));
            }
        }
        let defaults = f.options.iter().filter(|o| o.default).count();
        if k == kind::RADIO && defaults > 1 {
            return Err(format!(
                "Question “{label}”: only one choice can be picked ahead of time."
            ));
        }
        if k == kind::SELECT && defaults > usize::from(f.max_values.unwrap_or(1).max(1)) {
            return Err(format!(
                "Question “{label}” picks more choices ahead of time than it allows."
            ));
        }
    }

    if let Some(p) = &f.placeholder {
        if p.chars().count() > 150 {
            return Err(format!(
                "Question “{label}”: the placeholder must be ≤ 150 characters."
            ));
        }
    }

    if kind::takes_pick_count(k) {
        let cap = if k == kind::CHECKBOXES {
            MAX_GROUP_OPTIONS as u8
        } else {
            MAX_SELECT_PICKS
        };
        // A select of options can't ask for more picks than it has.
        let ceiling = if kind::has_options(k) {
            cap.min(f.options.len() as u8)
        } else {
            cap
        };
        if let Some(max) = f.max_values {
            if max == 0 || max > ceiling {
                return Err(format!(
                    "Question “{label}”: the most picks must be between 1 and {ceiling}."
                ));
            }
        }
        if let Some(min) = f.min_values {
            if min > ceiling {
                return Err(format!(
                    "Question “{label}”: the fewest picks can't be more than {ceiling}."
                ));
            }
            // Discord: min_values "must be omitted or at least 1 when required
            // is omitted or true".
            if min == 0 && f.required {
                return Err(format!(
                    "Question “{label}” is required, so it needs at least 1 pick."
                ));
            }
            // A Checkbox Group's max defaults to its option count, a select's to 1.
            let max = f
                .max_values
                .unwrap_or(if k == kind::CHECKBOXES { ceiling } else { 1 });
            if min > max {
                return Err(format!(
                    "Question “{label}”: the fewest picks can't be more than the most."
                ));
            }
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
    use crate::store::{FieldOption, ModalDef, ModalField, ReplyDef};

    const WEBHOOK: &str = "https://discord.com/api/webhooks/123456789012345678/abcDEF";

    fn field(id: &str) -> ModalField {
        ModalField {
            id: id.into(),
            label: "Your answer".into(),
            ..ModalField::default()
        }
    }

    fn choices(n: usize) -> Vec<FieldOption> {
        (0..n)
            .map(|i| FieldOption {
                label: format!("Choice {i}"),
                value: format!("c{i}"),
                ..Default::default()
            })
            .collect()
    }

    fn of_kind(k: &str, options: usize) -> ModalField {
        ModalField {
            kind: k.into(),
            options: choices(options),
            ..field("q")
        }
    }

    fn cfg(fields: Vec<ModalField>) -> InstanceConfig {
        InstanceConfig {
            modal: ModalDef {
                title: "Application".into(),
                intro: None,
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
    fn the_intro_takes_one_of_the_five_slots() {
        let four = (0..4).map(|i| field(&format!("f{i}"))).collect::<Vec<_>>();
        let mut c = cfg(four.clone());
        c.modal.intro = Some("Please read the rules first.".into());
        assert!(validate_config(&c).is_ok());
        let mut five = four;
        five.push(field("f4"));
        c.modal.fields = five;
        assert!(validate_config(&c).is_err());
        // A blank intro shows nothing and takes nothing.
        c.modal.intro = Some("   ".into());
        assert!(validate_config(&c).is_ok());
        c.modal.intro = Some("x".repeat(MAX_INTRO + 1));
        assert!(validate_config(&c).is_err());
    }

    #[test]
    fn choice_counts_follow_discords_bounds_for_each_kind() {
        let ok = |f: ModalField| validate_config(&cfg(vec![f])).is_ok();
        assert!(ok(of_kind(kind::SELECT, 1)) && ok(of_kind(kind::SELECT, 25)));
        assert!(!ok(of_kind(kind::SELECT, 0)) && !ok(of_kind(kind::SELECT, 26)));
        // A radio group is a choice between at least two.
        assert!(!ok(of_kind(kind::RADIO, 1)) && ok(of_kind(kind::RADIO, 2)));
        assert!(ok(of_kind(kind::RADIO, 10)) && !ok(of_kind(kind::RADIO, 11)));
        assert!(ok(of_kind(kind::CHECKBOXES, 1)) && !ok(of_kind(kind::CHECKBOXES, 11)));
        // Entity selects and a checkbox take no options.
        for k in [
            kind::USER,
            kind::ROLE,
            kind::MENTIONABLE,
            kind::CHANNEL,
            kind::CHECKBOX,
        ] {
            assert!(ok(of_kind(k, 0)), "{k}");
        }
        let mut unknown = field("q");
        unknown.kind = "slider".into();
        assert!(!ok(unknown));
    }

    #[test]
    fn choices_must_be_named_and_distinct() {
        let mut f = of_kind(kind::SELECT, 2);
        f.options[1].value = "c0".into();
        assert!(validate_config(&cfg(vec![f])).is_err());
        let mut f = of_kind(kind::RADIO, 2);
        f.options[0].label = "  ".into();
        assert!(validate_config(&cfg(vec![f])).is_err());
        let mut f = of_kind(kind::RADIO, 3);
        f.options[0].default = true;
        f.options[1].default = true;
        assert!(
            validate_config(&cfg(vec![f])).is_err(),
            "two radio defaults"
        );
    }

    #[test]
    fn pick_counts_are_checked_against_the_choices_and_required() {
        let ok = |f: ModalField| validate_config(&cfg(vec![f])).is_ok();
        let mut f = of_kind(kind::CHECKBOXES, 3);
        f.max_values = Some(3);
        assert!(ok(f.clone()));
        f.max_values = Some(4); // more picks than choices
        assert!(!ok(f.clone()));
        // Discord: a required question can't allow zero picks.
        let mut f = of_kind(kind::SELECT, 3);
        f.required = true;
        f.min_values = Some(0);
        assert!(!ok(f.clone()));
        f.required = false;
        assert!(ok(f.clone()));
        f.min_values = Some(2); // more than the default max of 1
        assert!(!ok(f.clone()));
        f.max_values = Some(3);
        assert!(ok(f));
        let mut f = of_kind(kind::USER, 0);
        f.max_values = Some(25);
        assert!(ok(f.clone()));
        f.max_values = Some(26);
        assert!(!ok(f));
    }

    #[test]
    fn a_single_checkbox_cannot_be_required() {
        let mut f = of_kind(kind::CHECKBOX, 0);
        f.required = true;
        assert!(validate_config(&cfg(vec![f.clone()])).is_err());
        f.required = false;
        f.checked = true;
        assert!(validate_config(&cfg(vec![f])).is_ok());
    }

    #[test]
    fn help_text_is_capped_at_discords_label_description() {
        let mut f = field("f1");
        f.description = Some("x".repeat(100));
        assert!(validate_config(&cfg(vec![f.clone()])).is_ok());
        f.description = Some("x".repeat(101));
        assert!(validate_config(&cfg(vec![f])).is_err());
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
