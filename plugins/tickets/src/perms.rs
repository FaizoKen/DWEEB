//! Discord permission arithmetic — pure, no I/O.
//!
//! Two things in this plugin depend on what the shared bot is *actually* allowed
//! to do, and both are decided here so they can be tested without Discord:
//!
//! - **The grants on a new ticket channel.** Discord only lets a bot put a bit
//!   into a channel's permission overwrites if the bot holds that bit in the
//!   guild itself ("only permissions your bot has in the guild can be
//!   allowed/denied"). The shared bot's invite carries just Manage Channels +
//!   Manage Roles (+ two bits other plugins need), so View Channels, Send
//!   Messages, Attach Files … all come from `@everyone`. A server that has
//!   stripped those from `@everyone` — an anti-spam "members can't attach
//!   files" setup is common — used to fail *every* ticket with a bare "missing
//!   permissions". [`Grants`] names the full and the essential sets, so a click
//!   can fall back to the essential one and still open the ticket.
//! - **The config pre-flight.** Before a panel is saved, the config UI shows
//!   exactly which permission is missing and where: server-wide, in the ticket
//!   category (a private "Tickets" category that hides itself from the bot is
//!   the classic setup mistake), or in the log channel.
//!
//! The effective-permission algorithm is Discord's own (Topics → Permissions →
//! "Permission Overwrites"): the base is `@everyone` plus every role the member
//! holds, Administrator short-circuits to everything, then the channel's
//! `@everyone` overwrite, then the union of the member's role overwrites (all
//! denies before all allows), then the member's own overwrite.

pub const CREATE_INSTANT_INVITE: u64 = 1 << 0;
pub const ADMINISTRATOR: u64 = 1 << 3;
pub const MANAGE_CHANNELS: u64 = 1 << 4;
pub const MANAGE_GUILD: u64 = 1 << 5;
pub const ADD_REACTIONS: u64 = 1 << 6;
pub const VIEW_CHANNEL: u64 = 1 << 10;
pub const SEND_MESSAGES: u64 = 1 << 11;
pub const EMBED_LINKS: u64 = 1 << 14;
pub const ATTACH_FILES: u64 = 1 << 15;
pub const READ_MESSAGE_HISTORY: u64 = 1 << 16;
pub const MANAGE_ROLES: u64 = 1 << 28;

/// Every bit — what Administrator amounts to.
const ALL: u64 = u64::MAX;

/// Overwrite target kinds, as Discord numbers them.
pub const OVERWRITE_ROLE: u8 = 0;
pub const OVERWRITE_MEMBER: u8 = 1;

/// What a ticket's participants (opener, staff, added members) are granted.
///
/// `Full` is the comfortable set; `Essential` is the least a ticket can work
/// with — see, write, read back — used when the bot can't grant the rest (the
/// module docs explain why it sometimes can't).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Grants {
    Full,
    Essential,
}

impl Grants {
    /// The allow bits for a participant (opener, staff role, added member).
    pub fn participant(self) -> u64 {
        match self {
            Grants::Full => {
                VIEW_CHANNEL
                    | SEND_MESSAGES
                    | READ_MESSAGE_HISTORY
                    | EMBED_LINKS
                    | ATTACH_FILES
                    | ADD_REACTIONS
            }
            Grants::Essential => VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY,
        }
    }

    /// The bot's own overwrite: a participant that can also rename and delete
    /// the channel it made.
    pub fn bot(self) -> u64 {
        self.participant() | MANAGE_CHANNELS
    }

    /// On a locked ticket a non-staff participant keeps read access — they can
    /// still see the resolution — but can no longer post.
    pub fn locked_allow(self) -> u64 {
        VIEW_CHANNEL | READ_MESSAGE_HISTORY
    }

    /// What a lock takes away. A *deny* is held to the same rule as an allow
    /// (the bot must hold the bit itself), so the essential set denies only
    /// what every working bot holds.
    pub fn locked_deny(self) -> u64 {
        match self {
            Grants::Full => SEND_MESSAGES | ADD_REACTIONS,
            Grants::Essential => SEND_MESSAGES,
        }
    }
}

/// Bits the bot must hold server-wide or no ticket can open at all: it has to
/// see and write the channels it grants, and create them.
pub const REQUIRED_SERVER_BITS: u64 =
    VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY | MANAGE_CHANNELS;
/// Bits the bot should hold server-wide so members can attach screenshots,
/// embed links and react. Without them tickets still open — with the
/// [`Grants::Essential`] set.
pub const OPTIONAL_SERVER_BITS: u64 = EMBED_LINKS | ATTACH_FILES | ADD_REACTIONS;

/// In the ticket category the bot has to see it, create channels in it, and
/// set their permissions (a category that denies the bot Manage Permissions
/// can refuse the overwrites a new ticket is created with).
pub const CATEGORY_BITS: u64 = VIEW_CHANNEL | MANAGE_CHANNELS | MANAGE_ROLES;
/// In the log channel the bot posts open/close lines and uploads transcripts.
pub const LOG_BITS: u64 = VIEW_CHANNEL | SEND_MESSAGES | ATTACH_FILES;

/// One channel permission overwrite, bitfields already parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Overwrite {
    pub id: String,
    pub kind: u8,
    pub allow: u64,
    pub deny: u64,
}

/// A member's server-wide permissions: `@everyone` plus every role they hold.
/// Administrator means everything.
pub fn guild_permissions(everyone: u64, member_roles: impl IntoIterator<Item = u64>) -> u64 {
    let bits = member_roles.into_iter().fold(everyone, |acc, r| acc | r);
    if bits & ADMINISTRATOR != 0 {
        ALL
    } else {
        bits
    }
}

/// A member's effective permissions in one channel, from their server-wide
/// `base` and the channel's overwrites. `@everyone`'s overwrite is the one whose
/// id is the guild id.
pub fn channel_permissions(
    base: u64,
    guild_id: &str,
    member_id: &str,
    member_roles: &[String],
    overwrites: &[Overwrite],
) -> u64 {
    if base & ADMINISTRATOR != 0 {
        return ALL;
    }
    let mut bits = base;
    if let Some(o) = overwrites
        .iter()
        .find(|o| o.kind == OVERWRITE_ROLE && o.id == guild_id)
    {
        bits &= !o.deny;
        bits |= o.allow;
    }
    let (mut allow, mut deny) = (0u64, 0u64);
    for o in overwrites
        .iter()
        .filter(|o| o.kind == OVERWRITE_ROLE && o.id != guild_id && member_roles.contains(&o.id))
    {
        allow |= o.allow;
        deny |= o.deny;
    }
    bits &= !deny;
    bits |= allow;
    if let Some(o) = overwrites
        .iter()
        .find(|o| o.kind == OVERWRITE_MEMBER && o.id == member_id)
    {
        bits &= !o.deny;
        bits |= o.allow;
    }
    bits
}

/// Where a permission is being set — Discord labels some bits differently in
/// each settings screen, and the pre-flight should use the label the admin is
/// about to look for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// Server Settings → Roles.
    Server,
    /// A category's permission settings.
    Category,
    /// A single channel's permission settings.
    Channel,
}

/// The human names of the bits in `wanted` that `have` lacks, in a stable
/// order — what the pre-flight shows an admin.
pub fn missing(have: u64, wanted: u64, scope: Scope) -> Vec<&'static str> {
    let label = |bit: u64| -> &'static str {
        match (bit, scope) {
            (VIEW_CHANNEL, Scope::Channel) => "View Channel",
            (VIEW_CHANNEL, _) => "View Channels",
            (MANAGE_CHANNELS, Scope::Channel) => "Manage Channel",
            (MANAGE_CHANNELS, _) => "Manage Channels",
            (MANAGE_ROLES, Scope::Server) => "Manage Roles",
            (MANAGE_ROLES, _) => "Manage Permissions",
            (SEND_MESSAGES, _) => "Send Messages",
            (READ_MESSAGE_HISTORY, _) => "Read Message History",
            (ATTACH_FILES, _) => "Attach Files",
            (EMBED_LINKS, _) => "Embed Links",
            (ADD_REACTIONS, _) => "Add Reactions",
            (CREATE_INSTANT_INVITE, _) => "Create Invite",
            _ => "an unnamed permission",
        }
    };
    const ORDER: [u64; 9] = [
        VIEW_CHANNEL,
        SEND_MESSAGES,
        READ_MESSAGE_HISTORY,
        MANAGE_CHANNELS,
        MANAGE_ROLES,
        ATTACH_FILES,
        EMBED_LINKS,
        ADD_REACTIONS,
        CREATE_INSTANT_INVITE,
    ];
    ORDER
        .iter()
        .filter(|bit| wanted & **bit != 0 && have & **bit == 0)
        .map(|bit| label(*bit))
        .collect()
}

/// Parse a Discord permission bitfield (sent as a decimal string). Anything
/// unparseable is treated as "no permissions" — never as "all of them".
pub fn parse_bits(s: &str) -> u64 {
    s.trim().parse().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GUILD: &str = "100";
    const BOT: &str = "200";

    fn ow(id: &str, kind: u8, allow: u64, deny: u64) -> Overwrite {
        Overwrite {
            id: id.into(),
            kind,
            allow,
            deny,
        }
    }

    #[test]
    fn server_permissions_union_everyone_and_roles() {
        assert_eq!(
            guild_permissions(VIEW_CHANNEL, [SEND_MESSAGES, MANAGE_CHANNELS]),
            VIEW_CHANNEL | SEND_MESSAGES | MANAGE_CHANNELS
        );
        // Administrator on any role means everything.
        assert_eq!(guild_permissions(0, [ADMINISTRATOR]), u64::MAX);
    }

    #[test]
    fn overwrites_apply_everyone_then_roles_then_member() {
        let roles = vec!["r1".to_string(), "r2".to_string()];
        let base = VIEW_CHANNEL | SEND_MESSAGES;
        // A private category: @everyone loses View; nothing grants it back.
        let private = [ow(GUILD, OVERWRITE_ROLE, 0, VIEW_CHANNEL)];
        let p = channel_permissions(base, GUILD, BOT, &roles, &private);
        assert_eq!(p & VIEW_CHANNEL, 0);

        // One of the bot's roles is allowed back in.
        let with_role = [
            ow(GUILD, OVERWRITE_ROLE, 0, VIEW_CHANNEL),
            ow("r2", OVERWRITE_ROLE, VIEW_CHANNEL | MANAGE_CHANNELS, 0),
        ];
        let p = channel_permissions(base, GUILD, BOT, &roles, &with_role);
        assert_ne!(p & VIEW_CHANNEL, 0);
        assert_ne!(p & MANAGE_CHANNELS, 0);

        // Role overwrites combine denies before allows: an allow on one role
        // beats a deny on another.
        let mixed = [
            ow("r1", OVERWRITE_ROLE, 0, SEND_MESSAGES),
            ow("r2", OVERWRITE_ROLE, SEND_MESSAGES, 0),
        ];
        let p = channel_permissions(base, GUILD, BOT, &roles, &mixed);
        assert_ne!(p & SEND_MESSAGES, 0);

        // The member's own overwrite has the last word.
        let member = [
            ow("r2", OVERWRITE_ROLE, SEND_MESSAGES, 0),
            ow(BOT, OVERWRITE_MEMBER, 0, SEND_MESSAGES),
        ];
        let p = channel_permissions(base, GUILD, BOT, &roles, &member);
        assert_eq!(p & SEND_MESSAGES, 0);

        // A role the member doesn't hold is irrelevant.
        let foreign = [ow("r9", OVERWRITE_ROLE, 0, VIEW_CHANNEL)];
        let p = channel_permissions(base, GUILD, BOT, &roles, &foreign);
        assert_ne!(p & VIEW_CHANNEL, 0);
    }

    #[test]
    fn administrator_ignores_overwrites() {
        let deny_all = [ow(GUILD, OVERWRITE_ROLE, 0, u64::MAX)];
        assert_eq!(
            channel_permissions(u64::MAX, GUILD, BOT, &[], &deny_all),
            u64::MAX
        );
    }

    #[test]
    fn missing_names_only_the_wanted_bits_that_are_absent() {
        assert_eq!(
            missing(
                VIEW_CHANNEL,
                VIEW_CHANNEL | SEND_MESSAGES | ATTACH_FILES,
                Scope::Server
            ),
            vec!["Send Messages", "Attach Files"]
        );
        assert!(missing(u64::MAX, REQUIRED_SERVER_BITS, Scope::Server).is_empty());
    }

    #[test]
    fn labels_follow_the_settings_screen() {
        assert_eq!(
            missing(0, VIEW_CHANNEL | MANAGE_ROLES, Scope::Server),
            vec!["View Channels", "Manage Roles"]
        );
        assert_eq!(
            missing(
                0,
                VIEW_CHANNEL | MANAGE_CHANNELS | MANAGE_ROLES,
                Scope::Category
            ),
            vec!["View Channels", "Manage Channels", "Manage Permissions"]
        );
        assert_eq!(
            missing(0, VIEW_CHANNEL | MANAGE_CHANNELS, Scope::Channel),
            vec!["View Channel", "Manage Channel"]
        );
    }

    #[test]
    fn essential_grants_are_a_subset_of_full() {
        for g in [Grants::Full, Grants::Essential] {
            assert_eq!(g.participant() & VIEW_CHANNEL, VIEW_CHANNEL);
            assert_eq!(g.bot() & MANAGE_CHANNELS, MANAGE_CHANNELS);
        }
        assert_eq!(
            Grants::Essential.participant() & Grants::Full.participant(),
            Grants::Essential.participant()
        );
        // The essential set is exactly what REQUIRED_SERVER_BITS guarantees, so
        // a bot that passes the required pre-flight can always grant it — the
        // lock's allow and deny included.
        let essential = Grants::Essential;
        for bits in [
            essential.bot(),
            essential.locked_allow(),
            essential.locked_deny(),
        ] {
            assert_eq!(bits & !REQUIRED_SERVER_BITS, 0);
        }
        let full = Grants::Full;
        for bits in [full.bot(), full.locked_allow(), full.locked_deny()] {
            assert_eq!(bits & !(REQUIRED_SERVER_BITS | OPTIONAL_SERVER_BITS), 0);
        }
    }

    #[test]
    fn unparseable_bits_mean_none() {
        assert_eq!(parse_bits("not a number"), 0);
        assert_eq!(parse_bits(" 1024 "), 1024);
    }
}
