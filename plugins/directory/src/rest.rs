//! The Discord REST layer, and the bounded cache in front of it.
//!
//! Three reads, all authenticated with the deployment's shared **bot token**, all
//! read-only — this plugin never writes anything to a server — and all of them
//! answered by a bot that is merely a *member* of the guild:
//!   • `GET /guilds/{id}?with_counts=true` — the guild's name, plus its
//!     approximate member/online totals (see [`GuildStructure::member_count`]).
//!   • `GET /guilds/{id}/roles` — every role, with colours and permission bits.
//!   • `GET /guilds/{id}/channels` — every channel, with topics.
//!
//! The three are fetched concurrently, so a click answers **inline** — there is
//! no deferral path anywhere in this plugin, and nothing here can take longer
//! than one Discord round-trip.
//!
//! The only host ever contacted is `discord.com`, so there's no SSRF surface.
//!
//! ## What this layer deliberately cannot do
//!
//! Every *per-member* read Discord offers is gated behind the privileged
//! `GUILD_MEMBERS` intent: `GET /guilds/{id}/members` requires it outright, and
//! the one endpoint that doesn't (`/members/search`) needs a name prefix and
//! cannot filter by role, so it can't enumerate anything. A role object carries
//! no member count either. So "who holds this role" is not a feature this plugin
//! can implement, by any route — it was tried, and what shipped was an apology
//! line in the middle of members' messages. Don't reintroduce it without the
//! intent actually being on. Server-wide totals are the honest substitute, and
//! they come free with the guild fetch above.
//!
//! ## Why the cache is shaped the way it is
//!
//! Bounded by lifetime **and** cardinality, because either alone is insufficient:
//! a TTL-only cache grows without limit across guilds, a size-only cache serves a
//! stale roster forever.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

const API_BASE: &str = "https://discord.com/api/v10";

// ── Permission bits (Discord sends the bitfield as a decimal string) ─────────

const PERM_KICK_MEMBERS: u64 = 1 << 1;
const PERM_BAN_MEMBERS: u64 = 1 << 2;
const PERM_ADMINISTRATOR: u64 = 1 << 3;
const PERM_MANAGE_CHANNELS: u64 = 1 << 4;
const PERM_MANAGE_GUILD: u64 = 1 << 5;
const PERM_MANAGE_MESSAGES: u64 = 1 << 13;
const PERM_MANAGE_ROLES: u64 = 1 << 28;
const PERM_MODERATE_MEMBERS: u64 = 1 << 40;

/// The permissions that make a role "staff" for the `"staff"` role source. Any
/// one of them means the role can act on other people or the server itself.
const STAFF_PERMISSIONS: u64 = PERM_ADMINISTRATOR
    | PERM_MANAGE_GUILD
    | PERM_MANAGE_ROLES
    | PERM_MANAGE_CHANNELS
    | PERM_MANAGE_MESSAGES
    | PERM_KICK_MEMBERS
    | PERM_BAN_MEMBERS
    | PERM_MODERATE_MEMBERS;

/// Short, human labels for the permissions worth showing on a roster, in
/// priority order. `Administrator` short-circuits — it implies every other bit,
/// so listing them alongside it would be noise.
const PERMISSION_BADGES: &[(u64, &str)] = &[
    (PERM_MANAGE_GUILD, "Server"),
    (PERM_MANAGE_ROLES, "Roles"),
    (PERM_MANAGE_CHANNELS, "Channels"),
    (PERM_BAN_MEMBERS, "Bans"),
    (PERM_KICK_MEMBERS, "Kicks"),
    (PERM_MODERATE_MEMBERS, "Timeouts"),
    (PERM_MANAGE_MESSAGES, "Messages"),
];

/// How many badges one role shows before the line gets noisy.
const MAX_BADGES: usize = 3;

// ── Channel types ────────────────────────────────────────────────────────────

pub const CHANNEL_TEXT: u8 = 0;
pub const CHANNEL_VOICE: u8 = 2;
pub const CHANNEL_CATEGORY: u8 = 4;
pub const CHANNEL_ANNOUNCEMENT: u8 = 5;
pub const CHANNEL_STAGE: u8 = 13;
pub const CHANNEL_FORUM: u8 = 15;
pub const CHANNEL_MEDIA: u8 = 16;

/// The channel kinds a directory lists when the host hasn't narrowed it.
///
/// Threads (10/11/12) are excluded on purpose: they come and go, there can be
/// thousands, and a channel index is about the server's *shape*. Categories (4)
/// are excluded because they're rendered as the headings, not as entries.
pub const DEFAULT_CHANNEL_KINDS: &[u8] = &[
    CHANNEL_TEXT,
    CHANNEL_ANNOUNCEMENT,
    CHANNEL_FORUM,
    CHANNEL_MEDIA,
    CHANNEL_VOICE,
    CHANNEL_STAGE,
];

/// Why a read failed, in terms the config UI can phrase for a human.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectError {
    /// 401 — the bot token is wrong or was reset.
    BadToken,
    /// 403/404 on the guild — the bot isn't in that server (or can't see it).
    BotNotInGuild,
    /// 429 — Discord is rate-limiting us. Transient.
    RateLimited,
    /// Couldn't reach Discord, or it returned something unexpected.
    Network,
}

impl ConnectError {
    pub fn message(&self) -> String {
        match self {
            ConnectError::BadToken => {
                "This deployment's bot token was rejected by Discord. The operator needs to refresh it.".into()
            }
            ConnectError::BotNotInGuild => {
                "I can't see that server. Make sure the bot has been invited to it, then try again.".into()
            }
            ConnectError::RateLimited => {
                "Discord is rate-limiting us right now — try again in a moment.".into()
            }
            ConnectError::Network => {
                "Couldn't reach Discord just now — try again in a moment.".into()
            }
        }
    }

    /// The HTTP status `/api/connect` answers with. Only a fault **on our side**
    /// may be 5xx: `TraceLayer`'s classifier turns any 5xx into an ERROR log,
    /// which the ops alerter forwards to Discord. The config iframe auto-connects
    /// on open, so an admin opening it for a server this deployment's bot was
    /// never invited to is a routine, user-caused outcome — it must not page
    /// anyone.
    pub fn status(&self) -> StatusCode {
        match self {
            // Our own credential is broken; every read will fail until the
            // operator rotates it. This one *should* page.
            ConnectError::BadToken => StatusCode::INTERNAL_SERVER_ERROR,
            ConnectError::BotNotInGuild => StatusCode::NOT_FOUND,
            ConnectError::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            // Discord unreachable or 5xx — a real upstream failure, rare enough
            // to be worth an alert.
            ConnectError::Network => StatusCode::BAD_GATEWAY,
        }
    }

    /// What a member of the server should be told when a *click* couldn't read
    /// the server. Never mentions tokens or intents — that's operator language.
    pub fn member_message(&self) -> &'static str {
        match self {
            ConnectError::BotNotInGuild => {
                "I can't read this server's list — an admin needs to re-add the DWEEB bot."
            }
            ConnectError::RateLimited | ConnectError::Network => {
                "Discord is being slow right now — try that again in a moment."
            }
            ConnectError::BadToken => "This list is temporarily unavailable. Try again later.",
        }
    }
}

// ── Views (the shapes the config UI and the renderer consume) ────────────────

/// One role, as both the config picker and the renderer need it.
#[derive(Debug, Clone, Serialize)]
pub struct RoleView {
    pub id: String,
    pub name: String,
    pub color: u32,
    pub position: i64,
    /// Displayed separately in Discord's own member list — the server's existing
    /// signal for "this role is notable", and the `"hoisted"` role source.
    pub hoist: bool,
    /// Integration/booster roles Discord owns.
    pub managed: bool,
    /// True when the role carries any [`STAFF_PERMISSIONS`] bit.
    pub staff: bool,
    /// Short permission labels, e.g. `["Admin"]` or `["Bans", "Timeouts"]`.
    pub badges: Vec<String>,
    /// A role's own unicode emoji, when it has one (shown before the name).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unicode_emoji: Option<String>,
}

/// One channel, as both the config picker and the renderer need it.
#[derive(Debug, Clone, Serialize)]
pub struct ChannelView {
    pub id: String,
    pub name: String,
    /// Discord channel type.
    pub kind: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub position: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    pub nsfw: bool,
}

/// A guild's structure: everything a directory reads, in one value.
#[derive(Debug, Clone, Serialize)]
pub struct GuildStructure {
    pub guild_id: String,
    pub guild_name: String,
    /// Highest-position first, ties broken by id (Discord's own ordering).
    pub roles: Vec<RoleView>,
    /// Categories and channels together, in Discord's display order.
    pub channels: Vec<ChannelView>,
    /// The guild's approximate member total, from `?with_counts=true`.
    ///
    /// `None` when Discord didn't send it. Rendered only when present: a
    /// server-count line is a nicety, and inventing a `0` would state something
    /// false about the server. Both counts are Discord's own approximations —
    /// this is not a member read and needs no privileged intent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_count: Option<u64>,
    /// The guild's approximate *online* total, same caveats as `member_count`.
    /// Tracked separately because Discord may send one without the other.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub online_count: Option<u64>,
}

impl GuildStructure {
    pub fn role(&self, id: &str) -> Option<&RoleView> {
        self.roles.iter().find(|r| r.id == id)
    }
    pub fn channel(&self, id: &str) -> Option<&ChannelView> {
        self.channels.iter().find(|c| c.id == id)
    }
}

/// Everything `POST /api/connect` returns on success.
#[derive(Debug, Serialize)]
pub struct ConnectResult {
    #[serde(flatten)]
    pub structure: GuildStructure,
    pub bot_id: String,
    pub bot_name: String,
}

// ── Raw Discord shapes (only the fields we read) ─────────────────────────────

#[derive(Deserialize)]
struct SelfUser {
    id: String,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    global_name: Option<String>,
}

#[derive(Deserialize)]
struct RawGuild {
    #[serde(default)]
    name: String,
    /// Present only because the fetch asks for `?with_counts=true`. Optional on
    /// purpose — an absent count renders as no count, never as zero.
    #[serde(default)]
    approximate_member_count: Option<u64>,
    #[serde(default)]
    approximate_presence_count: Option<u64>,
}

#[derive(Deserialize)]
struct RawRole {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    color: u32,
    #[serde(default)]
    position: i64,
    #[serde(default)]
    hoist: bool,
    #[serde(default)]
    managed: bool,
    #[serde(default)]
    permissions: String,
    #[serde(default)]
    unicode_emoji: Option<String>,
}

#[derive(Deserialize)]
struct RawChannel {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(rename = "type", default)]
    kind: u8,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default)]
    position: i64,
    #[serde(default)]
    topic: Option<String>,
    #[serde(default)]
    nsfw: bool,
}

fn auth(token: &str) -> String {
    format!("Bot {token}")
}

/// Parse a Discord snowflake id for numeric comparison. Snowflakes are 64-bit
/// integers, so a lexical string compare would misrank ids of different lengths;
/// compare the numbers instead. A malformed id sorts last.
fn snowflake(id: &str) -> u64 {
    id.parse().unwrap_or(u64::MAX)
}

/// The badge labels for a permission bitfield. `Administrator` short-circuits.
pub fn permission_badges(bits: u64) -> Vec<String> {
    if bits & PERM_ADMINISTRATOR != 0 {
        return vec!["Admin".to_string()];
    }
    PERMISSION_BADGES
        .iter()
        .filter(|(bit, _)| bits & bit != 0)
        .take(MAX_BADGES)
        .map(|(_, label)| (*label).to_string())
        .collect()
}

fn role_view(raw: RawRole, guild_id: &str) -> Option<RoleView> {
    // @everyone's id equals the guild id. It's held by definition, carries the
    // baseline permissions, and would top every roster meaninglessly.
    if raw.id == guild_id {
        return None;
    }
    let bits: u64 = raw.permissions.parse().unwrap_or(0);
    Some(RoleView {
        id: raw.id,
        name: raw.name,
        color: raw.color,
        position: raw.position,
        hoist: raw.hoist,
        managed: raw.managed,
        staff: bits & STAFF_PERMISSIONS != 0,
        badges: permission_badges(bits),
        unicode_emoji: raw.unicode_emoji.filter(|e| !e.is_empty()),
    })
}

/// Read a guild's structure: its name and totals, roles, and channels.
///
/// The three requests are independent, so they run concurrently — one round trip
/// instead of three, which is what keeps every directory click inside Discord's
/// ~3s interaction window without any deferring.
///
/// `with_counts=true` is free here: it rides on a request already being made, and
/// it is a property of the *guild*, not a member read, so no intent is involved.
pub async fn fetch_structure(
    http: &reqwest::Client,
    token: &str,
    guild_id: &str,
) -> Result<GuildStructure, ConnectError> {
    let guild_url = format!("{API_BASE}/guilds/{guild_id}?with_counts=true");
    let roles_url = format!("{API_BASE}/guilds/{guild_id}/roles");
    let channels_url = format!("{API_BASE}/guilds/{guild_id}/channels");
    let (guild, roles, channels): (RawGuild, Vec<RawRole>, Vec<RawChannel>) = tokio::try_join!(
        get_json(http, token, &guild_url),
        get_json(http, token, &roles_url),
        get_json(http, token, &channels_url),
    )?;

    let mut role_views: Vec<RoleView> = roles
        .into_iter()
        .filter_map(|r| role_view(r, guild_id))
        .collect();
    // Discord's own hierarchy order: highest position first, and among equal
    // positions the older (lower) id sits higher.
    role_views.sort_by(|a, b| {
        b.position
            .cmp(&a.position)
            .then_with(|| snowflake(&a.id).cmp(&snowflake(&b.id)))
    });

    let mut channel_views: Vec<ChannelView> = channels
        .into_iter()
        .map(|c| ChannelView {
            id: c.id,
            name: c.name,
            kind: c.kind,
            parent_id: c.parent_id,
            position: c.position,
            topic: c.topic.filter(|t| !t.trim().is_empty()),
            nsfw: c.nsfw,
        })
        .collect();
    channel_views.sort_by(|a, b| {
        a.position
            .cmp(&b.position)
            .then_with(|| snowflake(&a.id).cmp(&snowflake(&b.id)))
    });

    Ok(GuildStructure {
        guild_id: guild_id.to_string(),
        guild_name: guild.name,
        roles: role_views,
        channels: channel_views,
        member_count: guild.approximate_member_count,
        online_count: guild.approximate_presence_count,
    })
}

/// Who is the bot? One call, used by the config UI to name the account a host
/// has to invite.
pub async fn identify(
    http: &reqwest::Client,
    token: &str,
) -> Result<(String, String), ConnectError> {
    let me: SelfUser = get_json(http, token, &format!("{API_BASE}/users/@me")).await?;
    let bot_name = me
        .global_name
        .clone()
        .or(me.username.clone())
        .unwrap_or_else(|| "the bot".into());
    Ok((me.id, bot_name))
}

/// `GET` a JSON resource with the bot token, mapping HTTP status to a
/// [`ConnectError`].
async fn get_json<T: for<'de> Deserialize<'de>>(
    http: &reqwest::Client,
    token: &str,
    url: &str,
) -> Result<T, ConnectError> {
    let resp = http
        .get(url)
        .header("Authorization", auth(token))
        .send()
        .await
        .map_err(|_| ConnectError::Network)?;
    let status = resp.status();
    if status.is_success() {
        return resp.json::<T>().await.map_err(|_| ConnectError::Network);
    }
    Err(match status.as_u16() {
        401 => ConnectError::BadToken,
        403 | 404 => ConnectError::BotNotInGuild,
        429 => ConnectError::RateLimited,
        _ => ConnectError::Network,
    })
}

// ── Bounded TTL cache ────────────────────────────────────────────────────────

/// A cache bounded by **both** lifetime and cardinality.
///
/// Either bound alone is insufficient: a TTL-only cache grows without limit
/// across many guilds, and a size-only cache serves a stale roster forever. Past
/// the cap, expired entries are reclaimed first and only then is the coldest
/// live entry evicted — so a busy deployment degrades into more Discord calls,
/// never into unbounded memory.
struct TtlCache<V> {
    entries: Mutex<HashMap<String, (Instant, std::sync::Arc<V>)>>,
    ttl: Duration,
    max: usize,
}

impl<V> TtlCache<V> {
    fn new(ttl_secs: u64, max: usize) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            ttl: Duration::from_secs(ttl_secs),
            max: max.max(1),
        }
    }

    /// A zero TTL disables the cache entirely — useful while watching a live
    /// edit take effect, and it must be a real bypass rather than a 0-second
    /// expiry that still allocates.
    fn enabled(&self) -> bool {
        !self.ttl.is_zero()
    }

    fn get(&self, key: &str) -> Option<std::sync::Arc<V>> {
        if !self.enabled() {
            return None;
        }
        let mut entries = self.lock();
        match entries.get(key) {
            Some((at, v)) if at.elapsed() < self.ttl => Some(v.clone()),
            Some(_) => {
                entries.remove(key);
                None
            }
            None => None,
        }
    }

    fn put(&self, key: String, value: std::sync::Arc<V>) {
        if !self.enabled() {
            return;
        }
        let mut entries = self.lock();
        if entries.len() >= self.max && !entries.contains_key(&key) {
            let ttl = self.ttl;
            entries.retain(|_, (at, _)| at.elapsed() < ttl);
            while entries.len() >= self.max {
                let coldest = entries
                    .iter()
                    .min_by_key(|(_, (at, _))| *at)
                    .map(|(k, _)| k.clone());
                match coldest {
                    Some(k) => {
                        entries.remove(&k);
                    }
                    None => break,
                }
            }
        }
        entries.insert(key, (Instant::now(), value));
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, (Instant, std::sync::Arc<V>)>> {
        // Only map operations run under this lock — no awaits, no user code — so
        // poisoning is unreachable. Recovering rather than unwrapping keeps one
        // unlucky panic from bricking the cache for the process's life.
        self.entries
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
}

/// The guild-structure cache, shared by every request.
pub struct Cache {
    structure: TtlCache<GuildStructure>,
}

impl Cache {
    pub fn new(cfg: &crate::config::Config) -> Self {
        Self {
            structure: TtlCache::new(cfg.structure_cache_secs, cfg.cache_max_guilds),
        }
    }

    /// A guild's structure, from cache when warm.
    pub async fn structure(
        &self,
        http: &reqwest::Client,
        token: &str,
        guild_id: &str,
    ) -> Result<std::sync::Arc<GuildStructure>, ConnectError> {
        if let Some(hit) = self.structure.get(guild_id) {
            return Ok(hit);
        }
        let fresh = std::sync::Arc::new(fetch_structure(http, token, guild_id).await?);
        self.structure.put(guild_id.to_string(), fresh.clone());
        Ok(fresh)
    }

    /// Drop a guild's cached structure — used after a config save so the host
    /// sees their own edit reflected on the next click instead of waiting out
    /// the TTL.
    pub fn invalidate(&self, guild_id: &str) {
        self.structure.lock().remove(guild_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A routine, user-caused connect outcome must never answer 5xx.
    ///
    /// `TraceLayer`'s default classifier reports every 5xx through `on_failure`
    /// at ERROR level, and the ops alerter forwards backend ERRORs to Discord.
    /// The config iframe auto-connects whenever it opens, so an admin opening it
    /// for a server this deployment's bot was never invited to must not page the
    /// maintainer.
    #[test]
    fn only_our_own_faults_are_server_errors() {
        assert_eq!(ConnectError::BotNotInGuild.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            ConnectError::RateLimited.status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        for e in [ConnectError::BotNotInGuild, ConnectError::RateLimited] {
            assert!(
                !e.status().is_server_error(),
                "{e:?} must not be reported as a server error"
            );
        }
        // Genuinely broken: our credential is rejected, or Discord is
        // unreachable. These *should* page.
        assert_eq!(
            ConnectError::BadToken.status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(ConnectError::Network.status(), StatusCode::BAD_GATEWAY);
        for e in [ConnectError::BadToken, ConnectError::Network] {
            assert!(e.status().is_server_error(), "{e:?} should alert");
        }
    }

    /// Every variant explains itself twice: once in operator language for the
    /// config UI (which renders `data.error` verbatim) and once in member
    /// language for a click, which must never mention tokens or intents.
    #[test]
    fn every_variant_explains_itself_to_both_audiences() {
        for e in [
            ConnectError::BadToken,
            ConnectError::BotNotInGuild,
            ConnectError::RateLimited,
            ConnectError::Network,
        ] {
            assert!(!e.message().trim().is_empty(), "{e:?} has no admin message");
            let member = e.member_message();
            assert!(!member.trim().is_empty(), "{e:?} has no member message");
            let lowered = member.to_lowercase();
            for leak in ["token", "intent", "401", "403"] {
                assert!(
                    !lowered.contains(leak),
                    "{e:?} leaks operator detail {leak:?} to members: {member}"
                );
            }
        }
    }

    #[test]
    fn administrator_collapses_every_other_badge() {
        let bits = PERM_ADMINISTRATOR | PERM_BAN_MEMBERS | PERM_MANAGE_ROLES;
        assert_eq!(permission_badges(bits), vec!["Admin".to_string()]);
    }

    #[test]
    fn badges_are_capped_and_ordered_by_significance() {
        let bits = PERM_MANAGE_MESSAGES
            | PERM_MODERATE_MEMBERS
            | PERM_BAN_MEMBERS
            | PERM_MANAGE_GUILD
            | PERM_MANAGE_ROLES;
        let badges = permission_badges(bits);
        assert_eq!(badges.len(), MAX_BADGES);
        // Manage Server outranks the moderation bits, so it leads.
        assert_eq!(badges[0], "Server");
        assert_eq!(badges[1], "Roles");
    }

    #[test]
    fn a_role_with_no_notable_permissions_gets_no_badges() {
        assert!(permission_badges(0).is_empty());
    }

    /// @everyone is held by definition and carries the baseline permissions —
    /// it would top every roster meaninglessly, so it is dropped at parse time.
    #[test]
    fn everyone_is_never_a_roster_role() {
        let guild = "999";
        let raw = RawRole {
            id: guild.to_string(),
            name: "@everyone".into(),
            color: 0,
            position: 0,
            hoist: false,
            managed: false,
            permissions: "0".into(),
            unicode_emoji: None,
        };
        assert!(role_view(raw, guild).is_none());
    }

    #[test]
    fn staff_is_derived_from_the_permission_bitfield() {
        let mk = |perms: &str| {
            role_view(
                RawRole {
                    id: "1".into(),
                    name: "R".into(),
                    color: 0,
                    position: 1,
                    hoist: false,
                    managed: false,
                    permissions: perms.into(),
                    unicode_emoji: None,
                },
                "999",
            )
            .unwrap()
        };
        assert!(mk(&PERM_BAN_MEMBERS.to_string()).staff);
        assert!(mk(&PERM_ADMINISTRATOR.to_string()).staff);
        assert!(!mk("0").staff);
        // A garbage bitfield must read as "no permissions", never panic.
        assert!(!mk("not-a-number").staff);
    }

    /// The guild totals are optional all the way through the parse.
    ///
    /// Discord sends them only in response to `?with_counts=true`, and the
    /// renderer must be able to tell "the server has no members" (impossible)
    /// from "Discord didn't say" (routine). Defaulting either to `0` would print
    /// a confident falsehood into a public message.
    #[test]
    fn guild_counts_are_optional_and_never_default_to_zero() {
        let with: RawGuild = serde_json::from_value(serde_json::json!({
            "name": "Guild",
            "approximate_member_count": 1204,
            "approximate_presence_count": 87,
        }))
        .unwrap();
        assert_eq!(with.approximate_member_count, Some(1204));
        assert_eq!(with.approximate_presence_count, Some(87));

        // No counts at all — the shape of an ordinary `GET /guilds/{id}`.
        let without: RawGuild = serde_json::from_value(serde_json::json!({ "name": "Guild" }))
            .expect("a guild without counts must still parse");
        assert_eq!(without.approximate_member_count, None);
        assert_eq!(without.approximate_presence_count, None);

        // And one without the other, which is why they're tracked separately.
        let partial: RawGuild = serde_json::from_value(serde_json::json!({
            "name": "Guild",
            "approximate_member_count": 5,
        }))
        .unwrap();
        assert_eq!(partial.approximate_member_count, Some(5));
        assert_eq!(partial.approximate_presence_count, None);
    }

    #[test]
    fn cache_serves_within_ttl_and_expires_after() {
        let cache: TtlCache<u32> = TtlCache::new(60, 4);
        cache.put("a".into(), std::sync::Arc::new(1));
        assert_eq!(cache.get("a").map(|v| *v), Some(1));
        assert!(cache.get("missing").is_none());

        // A zero TTL is a real bypass, not a 0-second expiry.
        let off: TtlCache<u32> = TtlCache::new(0, 4);
        off.put("a".into(), std::sync::Arc::new(1));
        assert!(off.get("a").is_none());
        assert!(off.entries.lock().unwrap().is_empty());
    }

    /// Past the cardinality cap the cache must evict rather than grow — the
    /// bound that keeps a deployment serving many servers inside its memory
    /// limit.
    #[test]
    fn cache_evicts_the_coldest_entry_past_the_cap() {
        let cache: TtlCache<u32> = TtlCache::new(60, 2);
        cache.put("a".into(), std::sync::Arc::new(1));
        std::thread::sleep(Duration::from_millis(5));
        cache.put("b".into(), std::sync::Arc::new(2));
        std::thread::sleep(Duration::from_millis(5));
        cache.put("c".into(), std::sync::Arc::new(3));
        assert!(cache.entries.lock().unwrap().len() <= 2);
        // "a" was coldest, so it went first; the newest is always retained.
        assert!(cache.get("a").is_none());
        assert_eq!(cache.get("c").map(|v| *v), Some(3));

        // Overwriting an existing key must not trigger an eviction.
        cache.put("c".into(), std::sync::Arc::new(4));
        assert_eq!(cache.get("c").map(|v| *v), Some(4));
    }

    #[test]
    fn default_channel_kinds_exclude_threads_and_categories() {
        assert!(!DEFAULT_CHANNEL_KINDS.contains(&CHANNEL_CATEGORY));
        for thread_kind in [10u8, 11, 12] {
            assert!(!DEFAULT_CHANNEL_KINDS.contains(&thread_kind));
        }
        assert!(DEFAULT_CHANNEL_KINDS.contains(&CHANNEL_TEXT));
        assert!(DEFAULT_CHANNEL_KINDS.contains(&CHANNEL_FORUM));
    }
}
