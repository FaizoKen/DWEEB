//! The thin Discord REST layer. Two calls use the shared **bot token**, and both
//! are **optional**:
//!   • config time — list a guild's roles so the requirement / host-role pickers
//!     can show real role names instead of asking for raw ids (`connect`);
//!   • draw time — DM each winner so they don't miss the news (`dm_user`),
//!     fired concurrently and best-effort off the interaction's reply path.
//! A third call, `create_followup_message`, needs **no bot token at all**: it
//! posts a followup through the interaction's own webhook token, so it works on
//! every deployment (it carries the host panel when a host's Enter click spends
//! its single reply refreshing the public message).
//!
//! The core giveaway (enter / live count / draw / announce) uses none of the
//! bot-token calls — it runs entirely on interaction responses. So a deployment
//! with no `BOT_TOKEN` still works; it just can't populate the role picker or DM
//! winners.
//!
//! The only host ever contacted is `discord.com`, so there is no SSRF surface
//! even though the token is operator-supplied. Every call inherits the shared
//! client's sub-3s timeout.

use serde::{Deserialize, Serialize};
use serde_json::Value;

const API_BASE: &str = "https://discord.com/api/v10";

/// Why a connect attempt failed, phrased for a human in the config UI.
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
                "The giveaway bot token was rejected by Discord. The operator needs to re-copy it from the Developer Portal → Bot → Reset Token.".into()
            }
            ConnectError::BotNotInGuild => {
                "I can't see that server. Make sure the bot has been invited to it, then try again.".into()
            }
            ConnectError::Network => "Couldn't reach Discord just now — try again in a moment.".into(),
        }
    }
}

/// One role as the requirement / host-role picker needs it.
#[derive(Debug, Serialize)]
pub struct RoleView {
    pub id: String,
    pub name: String,
    pub color: u32,
    pub position: i64,
    /// Integration/booster roles Discord owns.
    pub managed: bool,
}

/// Everything `POST /api/connect` returns on success.
#[derive(Debug, Serialize)]
pub struct ConnectResult {
    pub guild_id: String,
    pub guild_name: String,
    pub bot_id: String,
    pub bot_name: String,
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
}

fn auth(token: &str) -> String {
    format!("Bot {token}")
}

/// Inspect a guild through the bot: who the bot is, the guild name, and its
/// roles (for the requirement / host pickers). Used by the config UI's connect
/// step. Stores nothing.
pub async fn connect(
    http: &reqwest::Client,
    token: &str,
    guild_id: &str,
) -> Result<ConnectResult, ConnectError> {
    let me: SelfUser = get_json(http, token, &format!("{API_BASE}/users/@me")).await?;
    let bot_name = me.global_name.clone().or(me.username.clone()).unwrap_or_else(|| "the bot".into());

    // The guild doubles as our "is the bot in here?" probe (403/404 → not in).
    let guild: Guild = get_json(http, token, &format!("{API_BASE}/guilds/{guild_id}")).await?;
    let roles: Vec<Role> = get_json(http, token, &format!("{API_BASE}/guilds/{guild_id}/roles")).await?;

    // Drop @everyone (id == guild id) and managed (integration/booster) roles;
    // surface highest-first like the other plugins.
    let mut role_views: Vec<RoleView> = roles
        .into_iter()
        .filter(|r| r.id != guild_id && !r.managed)
        .map(|r| RoleView {
            id: r.id,
            name: r.name,
            color: r.color,
            position: r.position,
            managed: r.managed,
        })
        .collect();
    role_views.sort_by(|a, b| b.position.cmp(&a.position));

    Ok(ConnectResult {
        guild_id: guild_id.to_string(),
        guild_name: guild.name,
        bot_id: me.id,
        bot_name,
        roles: role_views,
    })
}

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

/// DM a single user the given plain-text content. Best-effort: opens (or reuses)
/// the DM channel, then posts. Returns whether it landed — the caller logs but
/// never fails the draw over a DM (a closed-DMs user is normal, not an error).
pub async fn dm_user(http: &reqwest::Client, token: &str, user_id: &str, content: &str) -> bool {
    // 1) Open the DM channel.
    let chan: Result<DmChannel, _> = async {
        let resp = http
            .post(format!("{API_BASE}/users/@me/channels"))
            .header("Authorization", auth(token))
            .json(&serde_json::json!({ "recipient_id": user_id }))
            .send()
            .await
            .map_err(|_| ())?;
        if !resp.status().is_success() {
            return Err(());
        }
        resp.json::<DmChannel>().await.map_err(|_| ())
    }
    .await;
    let Ok(chan) = chan else { return false };

    // 2) Post the message (mentions suppressed — it's a DM, but be tidy).
    let posted = http
        .post(format!("{API_BASE}/channels/{}/messages", chan.id))
        .header("Authorization", auth(token))
        .json(&serde_json::json!({ "content": content, "allowed_mentions": { "parse": [] } }))
        .send()
        .await;
    matches!(posted, Ok(resp) if resp.status().is_success())
}

#[derive(Deserialize)]
struct DmChannel {
    id: String,
}

/// Post a followup message to an interaction, using the interaction's **own
/// webhook token** — no bot token, no `Authorization` header (the token in the
/// path *is* the credential). Used to deliver the host control panel *after* the
/// public giveaway message has been refreshed in the interaction's own
/// `UPDATE_MESSAGE` reply: a component interaction allows exactly one reply, so
/// the message edit takes the reply and the (ephemeral) panel rides here.
///
/// `data` is a normal interaction-response `data` body (`content`/`components`/
/// `flags`); the ephemeral flag in it keeps the panel host-only.
/// `with_components=true` is required for the panel's buttons to survive on this
/// webhook-style endpoint — without it Discord silently drops them. Best-effort:
/// the interaction token is valid ~15 minutes, and a failure just means the host
/// re-clicks Enter, so the result is only logged.
pub async fn create_followup_message(
    http: &reqwest::Client,
    application_id: &str,
    token: &str,
    data: &Value,
) -> bool {
    let url = format!("{API_BASE}/webhooks/{application_id}/{token}?with_components=true");
    matches!(http.post(url).json(data).send().await, Ok(resp) if resp.status().is_success())
}
