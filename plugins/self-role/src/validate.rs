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

// ── Roles a self-role menu may never hand out ───────────────────────────────

/// Permission bits that make a role a *staff* role: moderation, server
/// administration, or reach into members' privacy. A self-role menu may never
/// hand one out.
///
/// Why this exists: creating a menu needs no Discord identity (instance
/// creation is anonymous, like every DWEEB plugin), and a click is judged only
/// by the menu's own config — so anyone able to post a DWEEB message carrying a
/// `selfrole:` button (a member with Manage Webhooks in one channel, or anyone
/// holding a leaked webhook URL) could otherwise save a menu listing the
/// server's Moderator role and give it to themselves with the shared bot.
/// Discord only checks the bot's role hierarchy, which says nothing about who
/// configured the menu.
pub const STAFF_PERMISSIONS: u64 = (1 << 1) // KICK_MEMBERS
    | (1 << 2) // BAN_MEMBERS
    | (1 << 3) // ADMINISTRATOR
    | (1 << 4) // MANAGE_CHANNELS
    | (1 << 5) // MANAGE_GUILD
    | (1 << 7) // VIEW_AUDIT_LOG
    | (1 << 13) // MANAGE_MESSAGES
    | (1 << 17) // MENTION_EVERYONE
    | (1 << 19) // VIEW_GUILD_INSIGHTS
    | (1 << 22) // MUTE_MEMBERS
    | (1 << 23) // DEAFEN_MEMBERS
    | (1 << 24) // MOVE_MEMBERS
    | (1 << 27) // MANAGE_NICKNAMES
    | (1 << 28) // MANAGE_ROLES
    | (1 << 29) // MANAGE_WEBHOOKS
    | (1 << 30) // MANAGE_GUILD_EXPRESSIONS
    | (1 << 33) // MANAGE_EVENTS
    | (1 << 34) // MANAGE_THREADS
    | (1 << 40) // MODERATE_MEMBERS
    | (1 << 41); // VIEW_CREATOR_MONETIZATION_ANALYTICS

/// Why a role can't be part of a self-role menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoleBlock {
    /// `@everyone` (its id is the guild id) — every member already has it.
    Everyone,
    /// An integration's own role or the booster role — Discord manages it.
    Managed,
    /// It carries a [`STAFF_PERMISSIONS`] bit.
    Staff,
    /// Not one of this server's roles (deleted, or from another server).
    Missing,
}

impl RoleBlock {
    /// The reason, phrased to follow a role name ("**Moderator** — …").
    pub fn reason(self) -> &'static str {
        match self {
            RoleBlock::Everyone => "every member already has @everyone",
            RoleBlock::Managed => "Discord manages it (a bot's own role or the booster role)",
            RoleBlock::Staff => "it carries moderator or admin permissions",
            RoleBlock::Missing => "it isn't one of this server's roles any more",
        }
    }
}

/// Whether `role_id` may be handed out by a self-role menu in `guild_id`, judged
/// against the guild's live role list. `None` = fine.
pub fn role_block(
    role_id: &str,
    guild_id: &str,
    roles: &[crate::rest::RoleInfo],
) -> Option<RoleBlock> {
    if role_id == guild_id {
        return Some(RoleBlock::Everyone);
    }
    let Some(role) = roles.iter().find(|r| r.id == role_id) else {
        return Some(RoleBlock::Missing);
    };
    if role.managed {
        return Some(RoleBlock::Managed);
    }
    if role.permissions & STAFF_PERMISSIONS != 0 {
        return Some(RoleBlock::Staff);
    }
    None
}

/// The save-time refusal for a menu listing roles it may never hand out,
/// naming each with its reason so the admin knows what to change.
pub fn blocked_roles_message(blocked: &[(String, RoleBlock)]) -> String {
    let list = blocked
        .iter()
        .take(5)
        .map(|(name, why)| format!("**{name}** ({})", why.reason()))
        .collect::<Vec<_>>()
        .join(", ");
    let more = if blocked.len() > 5 { ", …" } else { "" };
    format!(
        "A self-role menu can't hand out {list}{more}. Pick roles without moderator or admin permissions — give staff powers through a separate role members can't pick."
    )
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

    #[test]
    fn webhook_guard_rejects_non_discord_and_non_https() {
        assert!(validate_webhook("http://discord.com/api/webhooks/1/x").is_err());
        assert!(validate_webhook("https://evil.example.com/api/webhooks/1/x").is_err());
        assert!(validate_webhook("https://discord.com/users/@me").is_err());
        assert!(validate_webhook("not a url").is_err());
    }

    fn role(id: &str, managed: bool, permissions: u64) -> crate::rest::RoleInfo {
        crate::rest::RoleInfo {
            id: id.into(),
            name: format!("Role {id}"),
            managed,
            permissions,
        }
    }

    #[test]
    fn staff_managed_everyone_and_foreign_roles_are_never_handed_out() {
        let guild = "100000000000000000";
        let roles = vec![
            role(guild, false, 0),                      // @everyone
            role("200000000000000001", false, 1 << 10), // VIEW_CHANNEL only
            role("200000000000000002", false, 1 << 3),  // Administrator
            role("200000000000000003", false, 1 << 2),  // Ban Members
            role("200000000000000004", false, 1 << 40), // Timeout members
            role("200000000000000005", true, 0),        // a bot's own role
            role("200000000000000006", false, 1 << 26), // Change own nickname
        ];
        assert_eq!(role_block("200000000000000001", guild, &roles), None);
        assert_eq!(role_block("200000000000000006", guild, &roles), None);
        assert_eq!(role_block(guild, guild, &roles), Some(RoleBlock::Everyone));
        for staff in [
            "200000000000000002",
            "200000000000000003",
            "200000000000000004",
        ] {
            assert_eq!(role_block(staff, guild, &roles), Some(RoleBlock::Staff));
        }
        assert_eq!(
            role_block("200000000000000005", guild, &roles),
            Some(RoleBlock::Managed)
        );
        assert_eq!(
            role_block("999999999999999999", guild, &roles),
            Some(RoleBlock::Missing)
        );
        let msg = blocked_roles_message(&[("Moderator".into(), RoleBlock::Staff)]);
        assert!(msg.contains("**Moderator**"), "{msg}");
        assert!(msg.contains("moderator or admin"), "{msg}");
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
    fn webhook_guard_accepts_canonical_discord_urls() {
        assert!(validate_webhook("https://discord.com/api/webhooks/123/abcDEF").is_ok());
        assert!(validate_webhook("https://canary.discord.com/api/webhooks/1/tok").is_ok());
        assert!(validate_webhook("https://discordapp.com/api/webhooks/1/tok").is_ok());
    }
}
