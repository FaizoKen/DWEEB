//! The thin Discord REST layer — a few **optional** reads, all in one `connect`:
//! a guild's roles (so the role-gate picker shows real names, not raw ids) and
//! its custom emoji (so the emoji picker offers the server's own emoji). The
//! emoji read is best-effort — if it fails, connect still returns roles.
//!
//! The core of this plugin (click → reply) uses none of this — it runs entirely
//! on the interaction payload. So a deployment with no `BOT_TOKEN` still works;
//! it just can't populate the pickers (the UI says so: role-gating is
//! unavailable and the emoji picker offers standard unicode emoji only).
//!
//! The only host ever contacted is `discord.com`, so there is no SSRF surface
//! even though the token is operator-supplied. The call inherits the shared
//! client's sub-3s timeout.

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

const API_BASE: &str = "https://discord.com/api/v10";

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
                "The shared bot token was rejected by Discord. The operator needs to re-copy it from the Developer Portal → Bot → Reset Token.".into()
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

/// One role as the gate picker needs it.
#[derive(Debug, Serialize)]
pub struct RoleView {
    pub id: String,
    pub name: String,
    pub color: u32,
    pub position: i64,
    /// Integration/booster roles Discord owns.
    pub managed: bool,
}

/// One custom emoji as the emoji picker needs it.
#[derive(Debug, Serialize)]
pub struct EmojiView {
    pub id: String,
    pub name: String,
    pub animated: bool,
}

/// Everything `POST /api/connect` returns on success.
#[derive(Debug, Serialize)]
pub struct ConnectResult {
    pub guild_id: String,
    pub guild_name: String,
    pub bot_id: String,
    pub bot_name: String,
    pub roles: Vec<RoleView>,
    /// The guild's custom emoji, for the config UI's emoji picker.
    pub emojis: Vec<EmojiView>,
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

#[derive(Deserialize)]
struct Emoji {
    /// Standard (unicode) emoji come back with a null id; we only want custom ones.
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    animated: bool,
    /// False while an emoji is unusable (e.g. lost to a server's boost downgrade).
    #[serde(default = "default_true")]
    available: bool,
}

fn default_true() -> bool {
    true
}

fn auth(token: &str) -> String {
    format!("Bot {token}")
}

/// Inspect a guild through the bot: who the bot is, the guild name, and its
/// roles (for the gate picker). Used by the config UI's connect step. Stores
/// nothing.
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
    // Emoji power the config UI's picker. Treat a fetch failure as "no custom
    // emoji" rather than failing the whole connect — roles/gating still work.
    let emojis: Vec<Emoji> = get_json(http, token, &format!("{API_BASE}/guilds/{guild_id}/emojis"))
        .await
        .unwrap_or_default();

    // Drop @everyone (id == guild id) and managed (integration/booster) roles —
    // they're not useful gate targets. Surface highest-first like the other
    // plugins.
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
    role_views.sort_by_key(|r| std::cmp::Reverse(r.position));

    // Keep only usable custom emoji (real id, available); standard unicode emoji
    // (null id) are offered client-side, so we don't echo them here.
    let emoji_views: Vec<EmojiView> = emojis
        .into_iter()
        .filter(|e| e.available)
        .filter_map(|e| match (e.id, e.name) {
            (Some(id), Some(name)) if !id.is_empty() && !name.is_empty() => Some(EmojiView {
                id,
                name,
                animated: e.animated,
            }),
            _ => None,
        })
        .collect();

    Ok(ConnectResult {
        guild_id: guild_id.to_string(),
        guild_name: guild.name,
        bot_id: me.id,
        bot_name,
        roles: role_views,
        emojis: emoji_views,
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
        429 => ConnectError::RateLimited,
        _ => ConnectError::Network,
    })
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
