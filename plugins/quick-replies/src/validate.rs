//! Validation for instance config submitted by the (untrusted) browser.
//!
//! This service only ever calls `discord.com` (a fixed host) to list roles, so
//! there's no SSRF guard to write. The checks here keep a stored instance
//! *coherent and within Discord's limits*: a real target, a reply set that fits
//! the component (exactly one for a button, 1..=25 for a select), stable option
//! keys, bounded text, and real snowflake role ids on any gate — everything the
//! interaction path later trusts.

use std::collections::HashSet;

use crate::store::{InstanceConfig, QuickReply, RoleRef};

/// A string select tops out at 25 options, so a menu manages at most 25 replies.
const MAX_REPLIES: usize = 25;
/// Reply body cap. Components V2 allows ~4000 chars across a message; 1500 is a
/// generous single canned reply and leaves headroom for the title + variables.
const MAX_BODY: usize = 1500;
const MAX_TITLE: usize = 200;
/// Serialized byte ceiling for a saved-message payload. Generous enough for a
/// rich Components V2 message while keeping one stored reply from ballooning the
/// DB or the interaction response. Mirrors the Modal Form plugin.
const MAX_PAYLOAD_BYTES: usize = 16_000;
/// Discord's select-option label / description ceiling.
const MAX_OPTION_FIELD: usize = 100;
/// A generous bound for a (possibly multi-codepoint / ZWJ) unicode emoji.
const MAX_EMOJI: usize = 64;
/// Roles a single reply may be gated to.
const MAX_ROLES: usize = 25;

pub fn validate_config(cfg: &InstanceConfig) -> Result<(), String> {
    let is_button = match cfg.target.as_str() {
        "button" => true,
        "string_select" => false,
        _ => return Err("Unsupported component target.".into()),
    };

    // The guild is optional (a plain text reply is portable), but if one is set
    // it must look real — it's what `{server}` and role-gating resolve against.
    if let Some(gid) = cfg.guild_id.as_deref() {
        if !gid.is_empty() && !is_snowflake(gid) {
            return Err("That server id doesn't look right.".into());
        }
    }

    if cfg.replies.is_empty() {
        return Err("Add at least one reply.".into());
    }
    if cfg.replies.len() > MAX_REPLIES {
        return Err(format!("A menu can hold at most {MAX_REPLIES} replies."));
    }
    if is_button && cfg.replies.len() != 1 {
        return Err("A button has exactly one reply.".into());
    }

    let mut seen_keys = HashSet::new();
    for reply in &cfg.replies {
        validate_reply(reply, is_button)?;
        if !seen_keys.insert(reply.key.as_str()) {
            return Err("Two replies share the same key.".into());
        }
    }

    Ok(())
}

fn validate_reply(reply: &QuickReply, is_button: bool) -> Result<(), String> {
    // The key is the select option value (and DWEEB locks it), so it must be a
    // short, stable, option-value-safe token.
    let key_len = reply.key.chars().count();
    if key_len == 0 || key_len > MAX_OPTION_FIELD {
        return Err("A reply key is missing or too long.".into());
    }
    if !reply.key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err("A reply key has invalid characters.".into());
    }

    // A select's option needs a label (the dropdown row); a button has no
    // options, so its label is ignored.
    if !is_button {
        let label = reply.label.trim();
        if label.is_empty() {
            return Err("Every topic needs a label for its dropdown option.".into());
        }
        if label.chars().count() > MAX_OPTION_FIELD {
            return Err(format!("A topic label is too long (max {MAX_OPTION_FIELD} characters)."));
        }
    }

    if let Some(emoji) = reply.emoji.as_deref() {
        if emoji.chars().count() > MAX_EMOJI {
            return Err("A topic emoji is too long — use a single emoji.".into());
        }
    }
    // A custom emoji id must be a real snowflake (it's wired onto the select
    // option). Animated only makes sense alongside one.
    if let Some(id) = reply.emoji_id.as_deref() {
        if !is_snowflake(id) {
            return Err("A topic's custom emoji id is invalid.".into());
        }
    }

    if let Some(desc) = reply.description.as_deref() {
        if desc.chars().count() > MAX_OPTION_FIELD {
            return Err(format!("A topic description is too long (max {MAX_OPTION_FIELD} characters)."));
        }
    }

    if let Some(title) = reply.title.as_deref() {
        if title.chars().count() > MAX_TITLE {
            return Err(format!("A reply title is too long (max {MAX_TITLE} characters)."));
        }
    }

    // A reply sends either a typed body or a DWEEB saved message. A saved
    // message is usable only when it carries a non-empty Components V2
    // `components` array (what the click path actually sends).
    let has_payload = reply
        .payload
        .as_ref()
        .and_then(|p| p.get("components"))
        .and_then(|c| c.as_array())
        .is_some_and(|a| !a.is_empty());

    let body = reply.body.trim();
    if !has_payload && body.is_empty() {
        return Err("A reply is empty — type a message or pick a saved message.".into());
    }
    // The typed body is bounded whether or not it's the active source (it may
    // linger as a fallback), but a saved message has its own, larger bound.
    if body.chars().count() > MAX_BODY {
        return Err(format!("A reply is too long (max {MAX_BODY} characters)."));
    }
    if let Some(payload) = &reply.payload {
        if serde_json::to_string(payload).map(|s| s.len()).unwrap_or(usize::MAX) > MAX_PAYLOAD_BYTES {
            return Err("That saved message is too large to send.".into());
        }
    }

    validate_roles(&reply.allowed_roles)?;
    Ok(())
}

/// Validate a reply's gate roles: real snowflakes, no duplicates, bounded count
/// and name length.
fn validate_roles(roles: &[RoleRef]) -> Result<(), String> {
    if roles.len() > MAX_ROLES {
        return Err(format!("Too many roles on one reply's gate (max {MAX_ROLES})."));
    }
    let mut seen = HashSet::new();
    for role in roles {
        if !is_snowflake(&role.id) {
            return Err("One of the gate roles has an invalid id.".into());
        }
        if !seen.insert(role.id.as_str()) {
            return Err("The same role is listed twice on one reply.".into());
        }
        if role.name.chars().count() > 100 {
            return Err("A gate role name is too long.".into());
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

    fn reply(key: &str, body: &str) -> QuickReply {
        QuickReply {
            key: key.into(),
            label: "Topic".into(),
            emoji: None,
            emoji_id: None,
            emoji_animated: None,
            description: None,
            title: None,
            payload: None,
            body: body.into(),
            ephemeral: true,
            allowed_roles: vec![],
        }
    }

    fn cfg(target: &str, replies: Vec<QuickReply>) -> InstanceConfig {
        InstanceConfig {
            target: target.into(),
            guild_id: None,
            guild_name: String::new(),
            replies,
        }
    }

    #[test]
    fn minimal_button_and_select_are_valid() {
        assert!(validate_config(&cfg("button", vec![reply("k1", "Hello!")])).is_ok());
        assert!(validate_config(&cfg(
            "string_select",
            vec![reply("k1", "Rules…"), reply("k2", "Roles…")]
        ))
        .is_ok());
    }

    #[test]
    fn rejects_unknown_target() {
        assert!(validate_config(&cfg("role_select", vec![reply("k1", "x")])).is_err());
    }

    #[test]
    fn button_must_have_exactly_one_reply() {
        assert!(validate_config(&cfg("button", vec![])).is_err());
        assert!(validate_config(&cfg("button", vec![reply("k1", "a"), reply("k2", "b")])).is_err());
    }

    #[test]
    fn select_needs_one_to_twentyfive_replies() {
        assert!(validate_config(&cfg("string_select", vec![])).is_err());
        let many: Vec<_> = (0..26).map(|i| reply(&format!("k{i}"), "x")).collect();
        assert!(validate_config(&cfg("string_select", many)).is_err());
    }

    #[test]
    fn rejects_empty_and_overlong_body() {
        assert!(validate_config(&cfg("button", vec![reply("k1", "   ")])).is_err());
        let long = "x".repeat(MAX_BODY + 1);
        assert!(validate_config(&cfg("button", vec![reply("k1", &long)])).is_err());
    }

    #[test]
    fn a_saved_payload_satisfies_the_empty_body_check() {
        // No body, but a non-empty saved message → valid.
        let mut r = reply("k1", "   ");
        r.payload = Some(serde_json::json!({
            "components": [{ "type": 10, "content": "Saved!" }]
        }));
        assert!(validate_config(&cfg("button", vec![r])).is_ok());

        // A payload with no usable components doesn't rescue an empty body.
        let mut empty = reply("k1", "");
        empty.payload = Some(serde_json::json!({ "components": [] }));
        assert!(validate_config(&cfg("button", vec![empty])).is_err());
    }

    #[test]
    fn validates_custom_emoji_id() {
        let mut bad = reply("k1", "a");
        bad.emoji = Some("wave".into());
        bad.emoji_id = Some("not-a-snowflake".into());
        assert!(validate_config(&cfg("string_select", vec![bad])).is_err());

        let mut ok = reply("k1", "a");
        ok.emoji = Some("wave".into());
        ok.emoji_id = Some("123456789012345678".into());
        ok.emoji_animated = Some(true);
        assert!(validate_config(&cfg("string_select", vec![ok])).is_ok());

        // A plain unicode emoji (no id) is still fine.
        let mut uni = reply("k1", "a");
        uni.emoji = Some("📜".into());
        assert!(validate_config(&cfg("string_select", vec![uni])).is_ok());
    }

    #[test]
    fn rejects_an_oversized_saved_payload() {
        let mut r = reply("k1", "");
        let huge = "x".repeat(MAX_PAYLOAD_BYTES + 1);
        r.payload = Some(serde_json::json!({
            "components": [{ "type": 10, "content": huge }]
        }));
        assert!(validate_config(&cfg("button", vec![r])).is_err());
    }

    #[test]
    fn rejects_duplicate_keys() {
        let c = cfg("string_select", vec![reply("dup", "a"), reply("dup", "b")]);
        assert!(validate_config(&c).is_err());
    }

    #[test]
    fn rejects_bad_key_charset() {
        assert!(validate_config(&cfg("button", vec![reply("has space", "a")])).is_err());
        assert!(validate_config(&cfg("button", vec![reply("colon:bad", "a")])).is_err());
    }

    #[test]
    fn select_option_needs_a_label() {
        let mut r = reply("k1", "a");
        r.label = "  ".into();
        assert!(validate_config(&cfg("string_select", vec![r])).is_err());
        // A button ignores the label, so an empty one is fine there.
        let mut b = reply("k1", "a");
        b.label = String::new();
        assert!(validate_config(&cfg("button", vec![b])).is_ok());
    }

    #[test]
    fn validates_optional_guild_id() {
        let mut c = cfg("button", vec![reply("k1", "a")]);
        c.guild_id = Some("not-a-snowflake".into());
        assert!(validate_config(&c).is_err());
        c.guild_id = Some("123456789012345678".into());
        assert!(validate_config(&c).is_ok());
        c.guild_id = None;
        assert!(validate_config(&c).is_ok());
    }

    #[test]
    fn validates_gate_roles() {
        let mut r = reply("k1", "a");
        r.allowed_roles = vec![RoleRef { id: "nope".into(), name: "Bad".into(), color: 0 }];
        assert!(validate_config(&cfg("button", vec![r])).is_err());

        let mut dup = reply("k1", "a");
        let role = RoleRef { id: "123456789012345678".into(), name: "Sub".into(), color: 0 };
        dup.allowed_roles = vec![role.clone(), role];
        assert!(validate_config(&cfg("button", vec![dup])).is_err());

        let mut ok = reply("k1", "a");
        ok.allowed_roles = vec![RoleRef { id: "123456789012345678".into(), name: "Sub".into(), color: 0 }];
        assert!(validate_config(&cfg("button", vec![ok])).is_ok());
    }
}
