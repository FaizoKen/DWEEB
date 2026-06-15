//! The thin Discord REST layer.
//!
//! Two jobs, both authenticated with a **bot token** (Manage Roles):
//!   • config time — list a guild's roles and work out which ones the bot can
//!     actually hand out (hierarchy + permission), so the picker can warn before
//!     a member ever clicks (`connect`);
//!   • click time — add or remove a single role on a member (`add_role`,
//!     `remove_role`), fired concurrently from the interaction handler.
//!
//! The only host ever contacted is `discord.com`, so there is no SSRF surface
//! even though the token is user-supplied. Every call carries a short timeout
//! (inherited from the shared client) so a click still answers within Discord's
//! 3s window.

use serde::{Deserialize, Serialize};

const API_BASE: &str = "https://discord.com/api/v10";

// Permission bits we care about (Discord sends the bitfield as a string).
const PERM_ADMINISTRATOR: u64 = 1 << 3;
const PERM_MANAGE_ROLES: u64 = 1 << 28;

/// Why a connect attempt failed, in terms the config UI can phrase for a human.
#[derive(Debug)]
pub enum ConnectError {
    /// 401 — the bot token is wrong or was reset.
    BadToken,
    /// 403/404 on the guild — the bot isn't in that server (or can't see it).
    BotNotInGuild,
    /// Couldn't reach Discord, or it returned something unexpected.
    Network,
}

impl ConnectError {
    pub fn message(&self) -> String {
        match self {
            ConnectError::BadToken => {
                "That bot token was rejected by Discord. Copy it again from the Developer Portal → Bot → Reset Token.".into()
            }
            ConnectError::BotNotInGuild => {
                "I can't see that server. Make sure the bot has been invited to it, then try again.".into()
            }
            ConnectError::Network => "Couldn't reach Discord just now — try again in a moment.".into(),
        }
    }
}

/// Why a click-time role add/remove didn't take. The interaction reply phrases
/// these two very differently, so collapsing them (as a bare `Err(())` would)
/// is exactly what makes a transient blip read as "move my role up."
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoleError {
    /// Discord refused the change — a 403, or a 404 on the member/role. Almost
    /// always role hierarchy or a missing Manage Roles permission: admin fix.
    Denied,
    /// A 429 rate-limit, a 5xx, or a network error reaching Discord. Transient
    /// and not the admin's fault — the member should just try again shortly.
    Busy,
}

/// One role as the config picker needs it.
#[derive(Debug, Serialize)]
pub struct RoleView {
    pub id: String,
    pub name: String,
    pub color: u32,
    pub position: i64,
    /// Integration/booster roles Discord owns — never manually assignable.
    pub managed: bool,
    /// True when the bot can actually give/take this role right now (has the
    /// permission, sits above it, and it isn't @everyone or a managed role).
    pub assignable: bool,
}

/// Everything `POST /api/connect` returns on success.
#[derive(Debug, Serialize)]
pub struct ConnectResult {
    pub guild_id: String,
    pub guild_name: String,
    pub bot_id: String,
    pub bot_name: String,
    /// Whether the bot has Manage Roles (or Administrator) at all. When false,
    /// nothing is assignable and the UI shows one clear "fix the permission"
    /// banner instead of a warning per role.
    pub bot_can_manage_roles: bool,
    pub roles: Vec<RoleView>,
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
struct Guild {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct Role {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    color: u32,
    #[serde(default)]
    position: i64,
    #[serde(default)]
    managed: bool,
    /// Permission bitfield, sent as a decimal string.
    #[serde(default)]
    permissions: String,
}

#[derive(Deserialize)]
struct BotMember {
    #[serde(default)]
    roles: Vec<String>,
}

fn auth(token: &str) -> String {
    format!("Bot {token}")
}

/// Parse a Discord snowflake id for numeric comparison. Snowflakes are 64-bit
/// integers, so a lexical string compare would misrank ids of different lengths
/// (e.g. a 17-digit id vs an 18-digit one); compare the numbers instead. A
/// malformed id falls back to the maximum, ranking it lowest in the hierarchy.
fn snowflake(id: &str) -> u64 {
    id.parse().unwrap_or(u64::MAX)
}

/// Inspect a guild through the bot: list its roles and decide which ones the bot
/// can hand out. Used by the config UI's "Connect" step.
pub async fn connect(
    http: &reqwest::Client,
    token: &str,
    guild_id: &str,
) -> Result<ConnectResult, ConnectError> {
    // Who is the bot? (Used to find its own member + skip self-assignment.)
    let me: SelfUser = get_json(http, token, &format!("{API_BASE}/users/@me")).await?;
    let bot_name = me.global_name.or(me.username).unwrap_or_else(|| "the bot".into());

    // The guild — also our "is the bot actually in here?" probe. `get_json`
    // already maps a 403/404 here to `BotNotInGuild`, which is what it means.
    let guild: Guild = get_json(http, token, &format!("{API_BASE}/guilds/{guild_id}")).await?;

    let roles: Vec<Role> = get_json(http, token, &format!("{API_BASE}/guilds/{guild_id}/roles")).await?;
    let bot_member: BotMember =
        get_json(http, token, &format!("{API_BASE}/guilds/{guild_id}/members/{}", me.id)).await?;

    // The bot's top role, and whether any of its roles grants Manage Roles (or
    // Administrator, which implies it). Discord ranks roles by position and
    // breaks ties by id — the *older*, lower-id role sits higher. So the bot's
    // top role is its highest position, and among equal positions its lowest id.
    // We keep both so the assignability test below can apply the same tie-break.
    let mut bot_top_pos: i64 = 0;
    let mut bot_top_id: u64 = u64::MAX;
    let mut can_manage = false;
    for rid in &bot_member.roles {
        if let Some(role) = roles.iter().find(|r| &r.id == rid) {
            let id = snowflake(&role.id);
            if role.position > bot_top_pos || (role.position == bot_top_pos && id < bot_top_id) {
                bot_top_pos = role.position;
                bot_top_id = id;
            }
            let bits: u64 = role.permissions.parse().unwrap_or(0);
            if bits & (PERM_ADMINISTRATOR | PERM_MANAGE_ROLES) != 0 {
                can_manage = true;
            }
        }
    }

    // Surface roles in Discord's own hierarchy order (highest-first, ties broken
    // by id). Drop @everyone (its id equals the guild id) — it can't be
    // self-assigned.
    let mut views: Vec<RoleView> = roles
        .into_iter()
        .filter(|r| r.id != guild_id)
        .map(|r| {
            // The bot can hand out a role only if that role sits strictly below
            // its top role in Discord's ordering: a lower position, or the same
            // position with a higher (younger) id. Matching Discord's tie-break
            // is what stops a freshly-created role you've dragged just under the
            // bot — and which therefore shares its position — from being wrongly
            // flagged "above bot".
            let below_bot = r.position < bot_top_pos
                || (r.position == bot_top_pos && snowflake(&r.id) > bot_top_id);
            let assignable = can_manage && !r.managed && below_bot;
            RoleView {
                id: r.id,
                name: r.name,
                color: r.color,
                position: r.position,
                managed: r.managed,
                assignable,
            }
        })
        .collect();
    views.sort_by(|a, b| {
        b.position
            .cmp(&a.position)
            .then_with(|| snowflake(&a.id).cmp(&snowflake(&b.id)))
    });

    Ok(ConnectResult {
        guild_id: guild_id.to_string(),
        guild_name: guild.name,
        bot_id: me.id,
        bot_name,
        bot_can_manage_roles: can_manage,
        roles: views,
    })
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
        _ => ConnectError::Network,
    })
}

/// Add one role to a member. `Ok(())` on success; on failure, [`RoleError`]
/// tells the reply whether to blame role hierarchy (`Denied`) or a transient
/// blip (`Busy`) — collapsing the two is what produces a misleading message.
pub async fn add_role(
    http: &reqwest::Client,
    token: &str,
    guild_id: &str,
    user_id: &str,
    role_id: &str,
    reason: &str,
) -> Result<(), RoleError> {
    role_op(http.put(role_url(guild_id, user_id, role_id)), token, reason).await
}

/// Remove one role from a member.
pub async fn remove_role(
    http: &reqwest::Client,
    token: &str,
    guild_id: &str,
    user_id: &str,
    role_id: &str,
    reason: &str,
) -> Result<(), RoleError> {
    role_op(
        http.delete(role_url(guild_id, user_id, role_id)),
        token,
        reason,
    )
    .await
}

fn role_url(guild_id: &str, user_id: &str, role_id: &str) -> String {
    format!("{API_BASE}/guilds/{guild_id}/members/{user_id}/roles/{role_id}")
}

async fn role_op(
    req: reqwest::RequestBuilder,
    token: &str,
    reason: &str,
) -> Result<(), RoleError> {
    let resp = req
        .header("Authorization", auth(token))
        // Shows up in the server's audit log so admins can see what happened.
        .header("X-Audit-Log-Reason", clamp_reason(reason))
        .send()
        .await
        .map_err(|_| RoleError::Busy)?;
    let status = resp.status();
    if status.is_success() {
        return Ok(());
    }
    tracing::warn!(status = %status, "role op rejected by Discord");
    // A 403, or a 404 on the member/role, means Discord refused the change
    // itself — for self-role that's almost always role hierarchy or a missing
    // Manage Roles permission, which only an admin can fix. Everything else
    // (429 rate-limit, 5xx, or the network error mapped above) is transient:
    // tell the member to try again rather than sending them to re-rank roles.
    Err(match status.as_u16() {
        403 | 404 => RoleError::Denied,
        _ => RoleError::Busy,
    })
}

/// Audit-log reasons travel in an HTTP header, and `HeaderValue` rejects any
/// byte outside visible ASCII — so a member whose display name has non-ASCII
/// characters (extremely common) would otherwise make the header invalid and
/// fail the whole role op. Keep only printable ASCII (+ space); drop the rest.
/// The reason is cosmetic, so losing a few characters from a name is harmless.
fn clamp_reason(reason: &str) -> String {
    reason
        .chars()
        .filter(|c| c.is_ascii_graphic() || *c == ' ')
        .take(400)
        .collect()
}
