//! The thin Discord REST layer, all authenticated with the shared **bot token**
//! (Manage Channels + Manage Roles).
//!
//! Two phases:
//!   • config time — list a guild's roles + channels and work out whether the bot
//!     has the two permissions a ticket needs, so the picker can warn *before* a
//!     member ever clicks (`connect`);
//!   • click time — create the private channel, post into it, rename/lock,
//!     delete, and pull messages for the transcript.
//!
//! The only host ever contacted is `discord.com`, so there is no SSRF surface
//! even though the token is operator-supplied. Every call inherits the shared
//! client's sub-3s timeout so a click still answers within Discord's window; the
//! heavier open/close flows run off the interaction's 3s path (see `routes.rs`).

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const API_BASE: &str = "https://discord.com/api/v10";

// Permission bits we care about (Discord sends the bitfield as a string).
const PERM_ADMINISTRATOR: u64 = 1 << 3;
const PERM_MANAGE_CHANNELS: u64 = 1 << 4;
const PERM_MANAGE_ROLES: u64 = 1 << 28;

// Discord channel types we surface to the picker.
const CHANNEL_GUILD_TEXT: u8 = 0;
const CHANNEL_GUILD_CATEGORY: u8 = 4;

/// Why a connect attempt failed, phrased for a human in the config UI.
#[derive(Debug)]
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
                "The Tickets bot token was rejected by Discord. The operator needs to re-copy it from the Developer Portal → Bot → Reset Token.".into()
            }
            ConnectError::BotNotInGuild => {
                "I can't see that server. Make sure the bot has been invited to it, then try again.".into()
            }
            ConnectError::RateLimited => {
                "Discord is rate-limiting us right now — try again in a moment.".into()
            }
            ConnectError::Network => "Couldn't reach Discord just now — try again in a moment.".into(),
        }
    }

    /// The HTTP status `/api/connect` answers with. Only a fault **on our side**
    /// may be 5xx: `TraceLayer`'s classifier turns any 5xx into an ERROR log,
    /// which the ops alerter forwards to Discord. The config iframe auto-connects
    /// on open, so an admin opening it for a server this plugin's bot was never
    /// invited to is a routine, user-caused outcome — it must not page anyone.
    pub fn status(&self) -> StatusCode {
        match self {
            // Our own credential is broken; every connect will fail until the
            // operator rotates it. This one *should* page.
            ConnectError::BadToken => StatusCode::INTERNAL_SERVER_ERROR,
            ConnectError::BotNotInGuild => StatusCode::NOT_FOUND,
            ConnectError::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            // Discord unreachable or 5xx — a real upstream failure, rare enough
            // to be worth an alert.
            ConnectError::Network => StatusCode::BAD_GATEWAY,
        }
    }
}

/// Why a click-time REST call didn't take. Kept distinct so the reply can blame
/// the right thing — collapsing them is what turns a transient blip into a
/// misleading "fix my permissions".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestError {
    /// Discord refused (a 400/403, or a 404 on the target). For tickets that's
    /// almost always a missing permission or role hierarchy: an admin fix.
    Denied,
    /// A 429 rate-limit, a 5xx, or a network error. Transient — try again.
    Busy,
}

impl RestError {
    fn from_status(code: u16) -> Self {
        match code {
            400 | 403 | 404 => RestError::Denied,
            _ => RestError::Busy,
        }
    }
}

/// One role as the config picker needs it.
#[derive(Debug, Serialize)]
pub struct RoleView {
    pub id: String,
    pub name: String,
    pub color: u32,
    pub position: i64,
    /// Integration/booster roles Discord owns.
    pub managed: bool,
    /// Whether the role can be pinged without the Mention Everyone permission —
    /// surfaced so the UI can hint when "ping staff" won't actually notify.
    pub mentionable: bool,
}

/// One channel (category or text) as the picker needs it.
#[derive(Debug, Serialize)]
pub struct ChannelView {
    pub id: String,
    pub name: String,
    pub position: i64,
}

/// Everything `POST /api/connect` returns on success.
#[derive(Debug, Serialize)]
pub struct ConnectResult {
    pub guild_id: String,
    pub guild_name: String,
    pub bot_id: String,
    pub bot_name: String,
    /// Whether the bot can create/delete channels.
    pub bot_can_manage_channels: bool,
    /// Whether the bot can set channel permission overwrites (Manage Roles).
    pub bot_can_manage_roles: bool,
    pub roles: Vec<RoleView>,
    pub categories: Vec<ChannelView>,
    pub text_channels: Vec<ChannelView>,
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
    #[serde(default)]
    mentionable: bool,
    #[serde(default)]
    permissions: String,
}

#[derive(Deserialize)]
struct Channel {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(rename = "type", default)]
    kind: u8,
    #[serde(default)]
    position: i64,
}

#[derive(Deserialize)]
struct BotMember {
    #[serde(default)]
    roles: Vec<String>,
}

/// A fetched message, trimmed to what the transcript renders.
#[derive(Deserialize)]
pub struct RawMessage {
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub timestamp: String,
    #[serde(default)]
    pub author: RawAuthor,
}

#[derive(Deserialize, Default)]
pub struct RawAuthor {
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub global_name: Option<String>,
}

fn auth(token: &str) -> String {
    format!("Bot {token}")
}

// ── config-time: connect / preflight ────────────────────────────────────────

/// Inspect a guild through the bot: who the bot is, the guild name, its roles
/// and channels, and whether the bot holds the two permissions tickets need.
pub async fn connect(
    http: &reqwest::Client,
    token: &str,
    guild_id: &str,
) -> Result<ConnectResult, ConnectError> {
    let me: SelfUser = get_json(http, token, &format!("{API_BASE}/users/@me")).await?;
    let bot_name = me
        .global_name
        .clone()
        .or(me.username.clone())
        .unwrap_or_else(|| "the bot".into());

    // The guild doubles as our "is the bot in here?" probe (403/404 → not in).
    let guild: Guild = get_json(http, token, &format!("{API_BASE}/guilds/{guild_id}")).await?;
    let roles: Vec<Role> =
        get_json(http, token, &format!("{API_BASE}/guilds/{guild_id}/roles")).await?;
    let channels: Vec<Channel> = get_json(
        http,
        token,
        &format!("{API_BASE}/guilds/{guild_id}/channels"),
    )
    .await?;
    let bot_member: BotMember = get_json(
        http,
        token,
        &format!("{API_BASE}/guilds/{guild_id}/members/{}", me.id),
    )
    .await?;

    // Union the bot's role permissions to see what it can actually do.
    let mut bits: u64 = 0;
    for rid in &bot_member.roles {
        if let Some(role) = roles.iter().find(|r| &r.id == rid) {
            bits |= role.permissions.parse::<u64>().unwrap_or(0);
        }
    }
    let admin = bits & PERM_ADMINISTRATOR != 0;
    let bot_can_manage_channels = admin || bits & PERM_MANAGE_CHANNELS != 0;
    let bot_can_manage_roles = admin || bits & PERM_MANAGE_ROLES != 0;

    // Roles for the staff picker: drop @everyone (id == guild id) and managed
    // (integration/booster) roles, highest-first.
    let mut role_views: Vec<RoleView> = roles
        .into_iter()
        .filter(|r| r.id != guild_id && !r.managed)
        .map(|r| RoleView {
            id: r.id,
            name: r.name,
            color: r.color,
            position: r.position,
            managed: r.managed,
            mentionable: r.mentionable,
        })
        .collect();
    role_views.sort_by_key(|r| std::cmp::Reverse(r.position));

    let mut categories: Vec<ChannelView> = Vec::new();
    let mut text_channels: Vec<ChannelView> = Vec::new();
    for c in channels {
        let view = ChannelView {
            id: c.id,
            name: c.name,
            position: c.position,
        };
        match c.kind {
            CHANNEL_GUILD_CATEGORY => categories.push(view),
            CHANNEL_GUILD_TEXT => text_channels.push(view),
            _ => {}
        }
    }
    categories.sort_by_key(|c| c.position);
    text_channels.sort_by_key(|c| c.position);

    Ok(ConnectResult {
        guild_id: guild_id.to_string(),
        guild_name: guild.name,
        bot_id: me.id,
        bot_name,
        bot_can_manage_channels,
        bot_can_manage_roles,
        roles: role_views,
        categories,
        text_channels,
    })
}

/// Fetch just the bot's own user id (cached by the caller). Used so the ticket
/// channel's overwrites can grant the shared bot access even when a *custom*
/// app posted the panel (whose application id isn't this bot's).
pub async fn bot_user_id(http: &reqwest::Client, token: &str) -> Result<String, ConnectError> {
    let me: SelfUser = get_json(http, token, &format!("{API_BASE}/users/@me")).await?;
    Ok(me.id)
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
        429 => ConnectError::RateLimited,
        _ => ConnectError::Network,
    })
}

// ── click-time: channel lifecycle ───────────────────────────────────────────

/// Create the private ticket channel and return its id.
#[allow(clippy::too_many_arguments)]
pub async fn create_channel(
    http: &reqwest::Client,
    token: &str,
    guild_id: &str,
    name: &str,
    parent_id: Option<&str>,
    topic: &str,
    overwrites: Vec<Value>,
    reason: &str,
) -> Result<String, RestError> {
    let mut body = serde_json::json!({
        "name": name,
        "type": CHANNEL_GUILD_TEXT,
        "permission_overwrites": overwrites,
    });
    if let Some(parent) = parent_id {
        body["parent_id"] = serde_json::json!(parent);
    }
    if !topic.is_empty() {
        body["topic"] = serde_json::json!(clamp(topic, 1024));
    }
    let resp = http
        .post(format!("{API_BASE}/guilds/{guild_id}/channels"))
        .header("Authorization", auth(token))
        .header("X-Audit-Log-Reason", clamp_reason(reason))
        .json(&body)
        .send()
        .await
        .map_err(|_| RestError::Busy)?;
    let status = resp.status();
    if !status.is_success() {
        tracing::warn!(status = %status, "create channel rejected");
        return Err(RestError::from_status(status.as_u16()));
    }
    #[derive(Deserialize)]
    struct Created {
        id: String,
    }
    resp.json::<Created>()
        .await
        .map(|c| c.id)
        .map_err(|_| RestError::Busy)
}

/// Post a message into a channel; returns the message id when Discord reports one.
pub async fn post_message(
    http: &reqwest::Client,
    token: &str,
    channel_id: &str,
    payload: &Value,
) -> Result<Option<String>, RestError> {
    let resp = http
        .post(format!("{API_BASE}/channels/{channel_id}/messages"))
        .header("Authorization", auth(token))
        .json(payload)
        .send()
        .await
        .map_err(|_| RestError::Busy)?;
    let status = resp.status();
    if !status.is_success() {
        tracing::warn!(status = %status, "post message rejected");
        return Err(RestError::from_status(status.as_u16()));
    }
    #[derive(Deserialize)]
    struct Posted {
        #[serde(default)]
        id: Option<String>,
    }
    Ok(resp.json::<Posted>().await.ok().and_then(|p| p.id))
}

/// Delete a channel (closing a ticket in "delete" mode).
pub async fn delete_channel(
    http: &reqwest::Client,
    token: &str,
    channel_id: &str,
    reason: &str,
) -> Result<(), RestError> {
    let resp = http
        .delete(format!("{API_BASE}/channels/{channel_id}"))
        .header("Authorization", auth(token))
        .header("X-Audit-Log-Reason", clamp_reason(reason))
        .send()
        .await
        .map_err(|_| RestError::Busy)?;
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        tracing::warn!(status = %status, "delete channel rejected");
        Err(RestError::from_status(status.as_u16()))
    }
}

/// Rename a channel (e.g. `ticket-0001` → `closed-0001`).
pub async fn rename_channel(
    http: &reqwest::Client,
    token: &str,
    channel_id: &str,
    name: &str,
) -> Result<(), RestError> {
    patch_channel(
        http,
        token,
        channel_id,
        &serde_json::json!({ "name": clamp(name, 100) }),
    )
    .await
}

async fn patch_channel(
    http: &reqwest::Client,
    token: &str,
    channel_id: &str,
    body: &Value,
) -> Result<(), RestError> {
    let resp = http
        .patch(format!("{API_BASE}/channels/{channel_id}"))
        .header("Authorization", auth(token))
        .json(body)
        .send()
        .await
        .map_err(|_| RestError::Busy)?;
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        tracing::warn!(status = %status, "patch channel rejected");
        Err(RestError::from_status(status.as_u16()))
    }
}

/// Set a single permission overwrite (`PUT …/permissions/{id}`). Used to revoke
/// the opener's write access on lock, and to restore it on reopen. `allow`/`deny`
/// are permission bitfields; `kind` is 0 (role) or 1 (member).
pub async fn set_overwrite(
    http: &reqwest::Client,
    token: &str,
    channel_id: &str,
    target_id: &str,
    kind: u8,
    allow: u64,
    deny: u64,
) -> Result<(), RestError> {
    let resp = http
        .put(format!(
            "{API_BASE}/channels/{channel_id}/permissions/{target_id}"
        ))
        .header("Authorization", auth(token))
        .json(&serde_json::json!({
            "type": kind,
            "allow": allow.to_string(),
            "deny": deny.to_string(),
        }))
        .send()
        .await
        .map_err(|_| RestError::Busy)?;
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        tracing::warn!(status = %status, "set overwrite rejected");
        Err(RestError::from_status(status.as_u16()))
    }
}

/// Fetch up to `pages` × 100 of a channel's most recent messages, oldest-first,
/// for the transcript. Best-effort: a failed page just ends the fetch with what
/// we have. Bounded so a long-lived ticket can't blow the budget.
pub async fn fetch_recent_messages(
    http: &reqwest::Client,
    token: &str,
    channel_id: &str,
    pages: usize,
) -> Vec<RawMessage> {
    let mut all: Vec<RawMessage> = Vec::new();
    let mut before: Option<String> = None;
    for _ in 0..pages {
        let mut url = format!("{API_BASE}/channels/{channel_id}/messages?limit=100");
        if let Some(b) = &before {
            url.push_str(&format!("&before={b}"));
        }
        let resp = match http
            .get(&url)
            .header("Authorization", auth(token))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r,
            _ => break,
        };
        // Discord returns newest-first; capture the last id to page further back.
        let raw: Vec<Value> = match resp.json().await {
            Ok(v) => v,
            Err(_) => break,
        };
        if raw.is_empty() {
            break;
        }
        before = raw
            .last()
            .and_then(|m| m.get("id"))
            .and_then(|v| v.as_str())
            .map(String::from);
        let n = raw.len();
        for m in raw {
            if let Ok(msg) = serde_json::from_value::<RawMessage>(m) {
                all.push(msg);
            }
        }
        if n < 100 {
            break;
        }
    }
    all.reverse(); // oldest-first reads like a conversation.
    all
}

/// Upload an HTML transcript (plus a short note) to the log channel, as a file
/// attachment. Best-effort — the close flow proceeds regardless of the outcome.
pub async fn upload_transcript(
    http: &reqwest::Client,
    token: &str,
    channel_id: &str,
    filename: &str,
    html: String,
    note: &str,
) -> Result<(), RestError> {
    let payload = serde_json::json!({
        "content": clamp(note, 2000),
        "allowed_mentions": { "parse": [] },
        "attachments": [{ "id": 0, "filename": filename }],
    });
    let file_part = reqwest::multipart::Part::bytes(html.into_bytes())
        .file_name(filename.to_string())
        .mime_str("text/html")
        .map_err(|_| RestError::Busy)?;
    let form = reqwest::multipart::Form::new()
        .text("payload_json", payload.to_string())
        .part("files[0]", file_part);
    let resp = http
        .post(format!("{API_BASE}/channels/{channel_id}/messages"))
        .header("Authorization", auth(token))
        .multipart(form)
        .send()
        .await
        .map_err(|_| RestError::Busy)?;
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        tracing::warn!(status = %status, "transcript upload rejected");
        Err(RestError::from_status(status.as_u16()))
    }
}

/// Edit the deferred interaction reply in place (`PATCH @original`). The
/// interaction `token` authenticates this, so it works for the main app and a
/// custom app alike, with no bot token.
pub async fn edit_original_response(
    http: &reqwest::Client,
    application_id: &str,
    interaction_token: &str,
    payload: &Value,
) -> Result<(), RestError> {
    let resp = http
        .patch(format!(
            "{API_BASE}/webhooks/{application_id}/{interaction_token}/messages/@original"
        ))
        .json(payload)
        .send()
        .await
        .map_err(|_| RestError::Busy)?;
    if resp.status().is_success() {
        Ok(())
    } else {
        tracing::warn!(status = %resp.status(), "edit @original rejected");
        Err(RestError::from_status(resp.status().as_u16()))
    }
}

/// Audit-log reasons travel in an HTTP header, and `HeaderValue` rejects any
/// byte outside visible ASCII — so a member whose display name has non-ASCII
/// characters (extremely common) would otherwise make the header invalid and
/// fail the whole op. Keep only printable ASCII (+ space); drop the rest. The
/// reason is cosmetic, so losing a few characters from a name is harmless.
fn clamp_reason(reason: &str) -> String {
    reason
        .chars()
        .filter(|c| c.is_ascii_graphic() || *c == ' ')
        .take(400)
        .collect()
}

fn clamp(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

impl RawAuthor {
    /// Consume the author so transcript construction can move, not clone, its
    /// strings while holding a few hundred fetched messages in memory.
    pub fn into_name(self) -> String {
        self.global_name
            .or(self.username)
            .unwrap_or_else(|| "user".to_string())
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
    /// for a server this plugin's bot was never invited to used to answer 502 and
    /// page the maintainer for a non-event. Keep these four honest.
    #[test]
    fn only_our_own_faults_are_server_errors() {
        // Not a fault of ours — the caller named a guild we can't see, or Discord
        // asked us to slow down. Neither may reach the alerter.
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

        // Genuinely broken: our credential is rejected, or Discord is unreachable.
        // These *should* page.
        assert_eq!(
            ConnectError::BadToken.status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(ConnectError::Network.status(), StatusCode::BAD_GATEWAY);
        for e in [ConnectError::BadToken, ConnectError::Network] {
            assert!(e.status().is_server_error(), "{e:?} should alert");
        }
    }

    /// Every variant carries a human-readable message for the config UI, which
    /// renders `data.error` verbatim on any non-ok response.
    #[test]
    fn every_variant_explains_itself() {
        for e in [
            ConnectError::BadToken,
            ConnectError::BotNotInGuild,
            ConnectError::RateLimited,
            ConnectError::Network,
        ] {
            assert!(!e.message().trim().is_empty(), "{e:?} has no message");
        }
    }
}
