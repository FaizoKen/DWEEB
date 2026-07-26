//! The Discord REST layer, and the bounded caches in front of it.
//!
//! Three reads, all authenticated with the deployment's shared **bot token**, and
//! all of them read-only — this plugin never writes anything to a server:
//!   • `GET /guilds/{id}` + `/roles` + `/channels` — the guild's *structure*.
//!     One cheap request each, fetched concurrently, so a click answers inline.
//!   • `GET /guilds/{id}/members` — the *member scan*, paged at 1000 at a time.
//!     This is the expensive one, and the only one that needs Discord's
//!     privileged `GUILD_MEMBERS` intent (roles and channels do not). It is
//!     therefore behind [`MemberScanOutcome`], which degrades instead of failing.
//!   • `PATCH /webhooks/{app}/{token}/messages/@original` — replacing a deferred
//!     placeholder with the finished directory.
//!
//! The only host ever contacted is `discord.com`, so there's no SSRF surface.
//!
//! ## Why the caches are shaped the way they are
//!
//! A member scan is unbounded work on someone else's data: a 200k-member guild
//! is 200 sequential Discord calls. Four bounds, all of them load-bearing:
//!   1. **Page cap** (`member_scan_max_pages`) — the hard ceiling on what one
//!      click can cost. A scan that hits it reports `truncated` and the reply
//!      says so, rather than pretending the roster is complete.
//!   2. **A scan indexes only the roles the caller asked about.** The whole
//!      member list is never retained — each of at most `MAX_ROLES` roles keeps
//!      up to [`MAX_INDEXED_HUMANS`] names — so a cached scan costs kilobytes,
//!      not megabytes, and the cache can't be grown into an OOM by guild size.
//!   3. **One permit pool** (`member_scan_concurrency`, default 1) doubles as
//!      single-flight: a queued click re-checks the cache after acquiring its
//!      permit, so a burst of clicks on one directory performs ONE scan.
//!   4. **A capped wait for that permit** ([`SCAN_QUEUE_WAIT`]). Each waiter is a
//!      spawned task holding a 15-minute interaction token, so an unbounded queue
//!      accumulates work that can only fail to deliver.
//!
//! Don't replace any of these with an unbounded wait queue or a whole-guild
//! member cache. Caches are bounded by lifetime **and** cardinality for the same
//! reason: a TTL alone grows without limit across guilds, a size cap alone serves
//! a stale roster forever.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const API_BASE: &str = "https://discord.com/api/v10";

/// Discord's maximum page size for `GET /guilds/{id}/members`.
const MEMBER_PAGE_SIZE: usize = 1000;

/// How long a click will wait for a member-scan permit before answering without
/// members. See the note in [`Cache::members`] — this is what stops a click storm
/// from queueing tasks whose interaction tokens will expire before their turn.
const SCAN_QUEUE_WAIT: Duration = Duration::from_secs(20);

/// Names kept per role in a cached scan. Must be ≥ the largest
/// `max_members_per_role` a config can ask for ([`crate::store::MAX_MEMBERS_PER_ROLE`]),
/// or a cached index couldn't satisfy a directory that wants more.
pub const MAX_INDEXED_HUMANS: usize = crate::store::MAX_MEMBERS_PER_ROLE as usize;
/// Bot names kept per role. Deliberately small: bots are an aside on a roster,
/// never its point.
pub const MAX_INDEXED_BOTS: usize = 10;

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

/// A guild's structure: everything a directory needs that isn't a member list.
#[derive(Debug, Clone, Serialize)]
pub struct GuildStructure {
    pub guild_id: String,
    pub guild_name: String,
    /// Highest-position first, ties broken by id (Discord's own ordering).
    pub roles: Vec<RoleView>,
    /// Categories and channels together, in Discord's display order.
    pub channels: Vec<ChannelView>,
}

impl GuildStructure {
    pub fn role(&self, id: &str) -> Option<&RoleView> {
        self.roles.iter().find(|r| r.id == id)
    }
    pub fn channel(&self, id: &str) -> Option<&ChannelView> {
        self.channels.iter().find(|c| c.id == id)
    }
}

/// The members holding one role, capped for retention. `*_total` are the true
/// counts — the names are only the first page of them.
#[derive(Debug, Clone, Default)]
pub struct RoleMembers {
    /// Up to [`MAX_INDEXED_HUMANS`] `(user id, display name)` pairs, name-sorted.
    pub humans: Vec<(String, String)>,
    pub human_total: usize,
    /// Up to [`MAX_INDEXED_BOTS`] bot `(user id, display name)` pairs.
    pub bots: Vec<(String, String)>,
    pub bot_total: usize,
}

/// A finished member scan, indexed by role id.
#[derive(Debug, Clone, Default)]
pub struct MemberIndex {
    pub by_role: HashMap<String, RoleMembers>,
    /// How many members were read.
    pub scanned: usize,
    /// True when the scan stopped at the page cap, so the counts are lower
    /// bounds. The reply says so rather than implying a complete roster.
    pub truncated: bool,
}

impl MemberIndex {
    pub fn for_role(&self, role_id: &str) -> Option<&RoleMembers> {
        self.by_role.get(role_id)
    }
}

/// The result of asking for members — never an `Err` the caller has to handle by
/// abandoning the reply.
///
/// This enum is the whole reason member expansion is safe to offer: `Unavailable`
/// is the ordinary state of a deployment whose app doesn't have the privileged
/// `GUILD_MEMBERS` intent enabled, and it must render as a roster *without*
/// members plus one honest note — not as an error, and certainly not as a 5xx.
#[derive(Debug, Clone)]
pub enum MemberScanOutcome {
    Ok(MemberIndex),
    /// Discord refused the member list. Overwhelmingly this means the privileged
    /// `GUILD_MEMBERS` intent is off for the application; it can also mean the
    /// bot was removed between the structure read and the scan.
    Unavailable,
    /// A rate-limit, a 5xx, or a network blip. Transient; try again later.
    Busy,
}

/// Everything `POST /api/connect` returns on success.
#[derive(Debug, Serialize)]
pub struct ConnectResult {
    #[serde(flatten)]
    pub structure: GuildStructure,
    pub bot_id: String,
    pub bot_name: String,
    /// Whether `GET /guilds/{id}/members` actually works for this app — i.e.
    /// whether the privileged `GUILD_MEMBERS` intent is enabled. The config UI
    /// uses it to tell the host, *before* they save, whether turning on member
    /// expansion will do anything.
    pub members_available: bool,
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

#[derive(Deserialize)]
struct RawMember {
    #[serde(default)]
    user: Option<RawMemberUser>,
    #[serde(default)]
    nick: Option<String>,
    #[serde(default)]
    roles: Vec<String>,
}

#[derive(Deserialize)]
struct RawMemberUser {
    id: String,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    global_name: Option<String>,
    #[serde(default)]
    bot: bool,
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

/// Read a guild's structure: its name, roles and channels.
///
/// The three requests are independent, so they run concurrently — one round trip
/// instead of three, which is what keeps a channel index (and a roster with
/// member expansion off) inside Discord's ~3s interaction window without any
/// deferring.
pub async fn fetch_structure(
    http: &reqwest::Client,
    token: &str,
    guild_id: &str,
) -> Result<GuildStructure, ConnectError> {
    let guild_url = format!("{API_BASE}/guilds/{guild_id}");
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
    })
}

/// Who is the bot, and can it list members?
pub async fn identify(
    http: &reqwest::Client,
    token: &str,
    guild_id: &str,
) -> Result<(String, String, bool), ConnectError> {
    let me: SelfUser = get_json(http, token, &format!("{API_BASE}/users/@me")).await?;
    let bot_name = me
        .global_name
        .clone()
        .or(me.username.clone())
        .unwrap_or_else(|| "the bot".into());
    // A one-member probe: the cheapest possible question that gets the same
    // answer the real scan would. Its 401/403 IS the "privileged intent is off"
    // signal — there's no capability endpoint that reports it directly.
    let members_available = get_json::<Vec<RawMember>>(
        http,
        token,
        &format!("{API_BASE}/guilds/{guild_id}/members?limit=1"),
    )
    .await
    .is_ok();
    Ok((me.id, bot_name, members_available))
}

/// Page the guild's members, keeping only what the named roles need.
///
/// Nothing about the whole member list is retained — see the module note. Stops
/// at `max_pages` and reports `truncated`, so the worst case of one click is
/// fixed by configuration rather than by how big somebody's server is.
pub async fn scan_members(
    http: &reqwest::Client,
    token: &str,
    guild_id: &str,
    roles_of_interest: &[String],
    max_pages: usize,
) -> MemberScanOutcome {
    let mut index = MemberIndex::default();
    for id in roles_of_interest {
        index.by_role.entry(id.clone()).or_default();
    }

    let mut after = String::from("0");
    for page in 0..max_pages.max(1) {
        let url =
            format!("{API_BASE}/guilds/{guild_id}/members?limit={MEMBER_PAGE_SIZE}&after={after}");
        let members: Vec<RawMember> = match get_json(http, token, &url).await {
            Ok(m) => m,
            Err(ConnectError::BadToken) | Err(ConnectError::BotNotInGuild) => {
                // The overwhelmingly likely cause is the privileged
                // GUILD_MEMBERS intent being off for this application. Logged at
                // INFO, not WARN: it's a deployment's steady state, not an
                // incident, and this target must never page anyone.
                tracing::info!(
                    guild_id,
                    page,
                    "member list refused by Discord (privileged GUILD_MEMBERS intent likely off)"
                );
                return MemberScanOutcome::Unavailable;
            }
            Err(e) => {
                tracing::warn!(guild_id, page, error = ?e, "member scan interrupted");
                // A blip after some pages still yields a usable partial roster —
                // better than nothing, and honestly labelled.
                if index.scanned > 0 {
                    index.truncated = true;
                    finish_index(&mut index);
                    return MemberScanOutcome::Ok(index);
                }
                return MemberScanOutcome::Busy;
            }
        };

        let page_len = members.len();
        let mut highest = after.clone();
        for m in members {
            let Some(user) = m.user else { continue };
            if snowflake(&user.id) > snowflake(&highest) || highest == "0" {
                highest = user.id.clone();
            }
            index.scanned += 1;
            let display = m
                .nick
                .filter(|n| !n.trim().is_empty())
                .or(user.global_name.filter(|n| !n.trim().is_empty()))
                .or(user.username)
                .unwrap_or_else(|| user.id.clone());
            for role_id in &m.roles {
                let Some(slot) = index.by_role.get_mut(role_id) else {
                    continue; // a role this directory doesn't list
                };
                if user.bot {
                    slot.bot_total += 1;
                    if slot.bots.len() < MAX_INDEXED_BOTS {
                        slot.bots.push((user.id.clone(), display.clone()));
                    }
                } else {
                    slot.human_total += 1;
                    if slot.humans.len() < MAX_INDEXED_HUMANS {
                        slot.humans.push((user.id.clone(), display.clone()));
                    }
                }
            }
        }

        // A short page means we've reached the end of the guild.
        if page_len < MEMBER_PAGE_SIZE {
            finish_index(&mut index);
            return MemberScanOutcome::Ok(index);
        }
        // No forward progress would loop forever on a malformed page.
        if highest == after {
            break;
        }
        after = highest;
    }

    index.truncated = true;
    finish_index(&mut index);
    MemberScanOutcome::Ok(index)
}

/// Name-sort each role's retained names.
///
/// Discord pages members in user-id order, which reads as random. Sorting by
/// display name (case-insensitively) is the difference between a roster and a
/// pile. Only the retained slice is sorted — it's already capped, so this is
/// bounded work, but it does mean the *names shown* are the first-by-id ones
/// sorted, not the alphabetically-first overall. That only shows on a role past
/// the cap, where the reply already says "+N more".
fn finish_index(index: &mut MemberIndex) {
    for slot in index.by_role.values_mut() {
        slot.humans.sort_by_key(|(_, name)| name.to_lowercase());
        slot.bots.sort_by_key(|(_, name)| name.to_lowercase());
    }
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

/// Replace a deferred interaction's placeholder with the finished directory.
///
/// The interaction token is the credential here — no bot token is involved — and
/// it stays valid for 15 minutes, so this comfortably outlives even a capped
/// member scan. Failure is logged and swallowed: by this point Discord has
/// already been answered, and there is no second channel to complain through.
pub async fn edit_original(
    http: &reqwest::Client,
    application_id: &str,
    interaction_token: &str,
    body: &serde_json::Value,
) {
    let url =
        format!("{API_BASE}/webhooks/{application_id}/{interaction_token}/messages/@original");
    match http.patch(&url).json(body).send().await {
        Ok(resp) if resp.status().is_success() => {}
        Ok(resp) => {
            // Deliberately WARN, not ERROR: a failed follow-up is a bad reply for
            // one member, not a service fault, and ERROR is the paging channel.
            tracing::warn!(status = %resp.status(), "follow-up edit rejected by Discord");
        }
        Err(e) => {
            let kind = if e.is_timeout() {
                "timeout"
            } else if e.is_connect() {
                "connect"
            } else {
                "transport"
            };
            tracing::warn!(kind, "follow-up edit unreachable");
        }
    }
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

/// The caches and the scan permit pool, shared by every request.
pub struct Cache {
    structure: TtlCache<GuildStructure>,
    members: TtlCache<MemberIndex>,
    /// Bounds concurrent member scans **and** provides single-flight: a waiter
    /// re-checks the cache after acquiring a permit.
    scan_permits: tokio::sync::Semaphore,
    max_pages: usize,
}

impl Cache {
    pub fn new(cfg: &crate::config::Config) -> Self {
        Self {
            structure: TtlCache::new(cfg.structure_cache_secs, cfg.cache_max_guilds),
            members: TtlCache::new(cfg.member_cache_secs, cfg.cache_max_guilds),
            scan_permits: tokio::sync::Semaphore::new(cfg.member_scan_concurrency.max(1)),
            max_pages: cfg.member_scan_max_pages.max(1),
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
        // Member entries are keyed by guild *and* role set, so clear every key
        // that belongs to this guild.
        let prefix = format!("{guild_id}:");
        self.members.lock().retain(|k, _| !k.starts_with(&prefix));
    }

    /// A member scan for exactly these roles, from cache when warm.
    ///
    /// The cache key covers the role set as well as the guild, because an index
    /// built for one directory's roles can't answer another's. The permit
    /// acquired on a miss doubles as single-flight — hence the second cache
    /// check once it's in hand.
    pub async fn members(
        &self,
        http: &reqwest::Client,
        token: &str,
        guild_id: &str,
        roles_of_interest: &[String],
    ) -> MemberScanOutcome {
        if roles_of_interest.is_empty() {
            return MemberScanOutcome::Ok(MemberIndex::default());
        }
        let key = member_cache_key(guild_id, roles_of_interest);
        if let Some(hit) = self.members.get(&key) {
            return MemberScanOutcome::Ok((*hit).clone());
        }
        // Bounded: a burst of clicks queues here rather than fanning out into one
        // Discord scan each.
        //
        // The wait is capped because each waiter is a spawned task holding an
        // interaction token that expires in 15 minutes. An *unbounded* wait
        // behind a one-permit pool means a click storm piles up tasks whose
        // follow-ups will all be too late to deliver — work that can only fail.
        // Giving up early instead is cheap and honest: the reply renders without
        // members and says "try again in a moment", and by then the first scan
        // has warmed the cache, so the retry is a hit.
        //
        // `acquire` itself only fails on a closed semaphore, which never happens
        // here — treat it as transient rather than panicking.
        let permit = tokio::time::timeout(SCAN_QUEUE_WAIT, self.scan_permits.acquire()).await;
        let Ok(Ok(_permit)) = permit else {
            tracing::info!(
                guild_id,
                "member scan queue full — answering without members"
            );
            return MemberScanOutcome::Busy;
        };
        // Single-flight: whoever queued behind the scan finds it done.
        if let Some(hit) = self.members.get(&key) {
            return MemberScanOutcome::Ok((*hit).clone());
        }
        let outcome = scan_members(http, token, guild_id, roles_of_interest, self.max_pages).await;
        if let MemberScanOutcome::Ok(index) = &outcome {
            self.members.put(key, std::sync::Arc::new(index.clone()));
        }
        outcome
    }
}

/// Cache key for a member scan: the guild plus a digest of the role set.
///
/// The ids are sorted first so two directories listing the same roles in
/// different orders share one scan.
fn member_cache_key(guild_id: &str, roles: &[String]) -> String {
    let mut sorted: Vec<&str> = roles.iter().map(|s| s.as_str()).collect();
    sorted.sort_unstable();
    sorted.dedup();
    let mut hasher = Sha256::new();
    for id in sorted {
        hasher.update(id.as_bytes());
        hasher.update(b",");
    }
    format!("{guild_id}:{}", hex::encode(&hasher.finalize()[..8]))
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

    /// A directory listing the same roles in a different order must share one
    /// scan; a different role set must not.
    #[test]
    fn member_cache_key_is_order_insensitive_but_set_sensitive() {
        let a = member_cache_key("g1", &["r1".into(), "r2".into()]);
        let b = member_cache_key("g1", &["r2".into(), "r1".into()]);
        let c = member_cache_key("g1", &["r1".into(), "r3".into()]);
        let d = member_cache_key("g2", &["r1".into(), "r2".into()]);
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, d, "the guild must be part of the key");
        assert!(a.starts_with("g1:"), "invalidate() matches on this prefix");
        // A duplicated id is the same set.
        assert_eq!(
            a,
            member_cache_key("g1", &["r1".into(), "r2".into(), "r1".into()])
        );
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

    /// Only the roles a directory asked about are indexed. This is the bound
    /// that keeps a cached scan measured in kilobytes regardless of guild size.
    #[test]
    fn the_index_retains_only_requested_roles_and_caps_each() {
        let mut index = MemberIndex::default();
        index
            .by_role
            .insert("wanted".into(), RoleMembers::default());
        // Simulate what `scan_members` does per member.
        for i in 0..(MAX_INDEXED_HUMANS + 25) {
            let slot = index.by_role.get_mut("wanted").unwrap();
            slot.human_total += 1;
            if slot.humans.len() < MAX_INDEXED_HUMANS {
                slot.humans.push((format!("{i}"), format!("user{i:03}")));
            }
            // An unrequested role is simply skipped.
            assert!(index.by_role.get_mut("unwanted").is_none());
        }
        let slot = index.for_role("wanted").unwrap();
        assert_eq!(slot.humans.len(), MAX_INDEXED_HUMANS);
        assert_eq!(slot.human_total, MAX_INDEXED_HUMANS + 25);
        assert!(index.for_role("unwanted").is_none());
    }

    /// The retention cap must be able to satisfy the largest configurable
    /// per-role display, or a cached index would silently under-serve.
    #[test]
    fn retention_cap_covers_the_largest_configurable_display() {
        assert!(MAX_INDEXED_HUMANS >= crate::store::MAX_MEMBERS_PER_ROLE as usize);
    }

    #[test]
    fn finish_index_sorts_names_case_insensitively() {
        let mut index = MemberIndex::default();
        index.by_role.insert(
            "r".into(),
            RoleMembers {
                humans: vec![
                    ("1".into(), "zoe".into()),
                    ("2".into(), "Alice".into()),
                    ("3".into(), "bob".into()),
                ],
                human_total: 3,
                bots: vec![],
                bot_total: 0,
            },
        );
        finish_index(&mut index);
        let names: Vec<&str> = index.by_role["r"]
            .humans
            .iter()
            .map(|(_, n)| n.as_str())
            .collect();
        assert_eq!(names, vec!["Alice", "bob", "zoe"]);
    }

    /// The queue wait must leave plenty of room inside Discord's 15-minute
    /// interaction-token window, or a waiter that *does* get its turn would
    /// finish a scan it can no longer deliver.
    #[test]
    fn the_scan_queue_wait_fits_inside_the_interaction_token_window() {
        assert!(SCAN_QUEUE_WAIT < Duration::from_secs(15 * 60));
        // And long enough to actually benefit from single-flight rather than
        // giving up before the in-progress scan warms the cache.
        assert!(SCAN_QUEUE_WAIT >= Duration::from_secs(5));
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
