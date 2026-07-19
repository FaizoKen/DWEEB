//! The thin Discord REST layer. One call uses the shared **bot token**, and it
//! is **optional**:
//!   • config time — list a guild's roles so the vote-gate / host-role pickers
//!     can show real role names instead of asking for raw ids (`connect`).
//! Two more calls need **no bot token at all** — they use an interaction's own
//! webhook token, so they work on every deployment:
//!   • `create_followup_message` carries the ephemeral voting panel / vote
//!     confirmation / host panel when a click spends its single reply on the
//!     public message's `UPDATE_MESSAGE` refresh;
//!   • `edit_original_message` brings the public message current out of band
//!     (reusing an earlier click's token) after an action on an ephemeral panel
//!     — a pick, retract, close or reopen — which can't otherwise reach it.
//!
//! The core poll (vote / tallies / close / announce) uses no bot-token calls —
//! it runs entirely on interaction responses. So a deployment with no
//! `BOT_TOKEN` still works; it just can't populate the role picker.
//!
//! The only host ever contacted is `discord.com`, so there is no SSRF surface
//! even though the token is operator-supplied. Every call inherits the shared
//! client's sub-3s timeout.

use axum::http::StatusCode;
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
    /// 429 — Discord is rate-limiting us. Transient.
    RateLimited,
    /// Couldn't reach Discord, or it returned something unexpected.
    Network,
}

impl ConnectError {
    pub fn message(&self) -> String {
        match self {
            ConnectError::BadToken => {
                "The poll bot token was rejected by Discord. The operator needs to re-copy it from the Developer Portal → Bot → Reset Token.".into()
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

/// One role as the vote-gate / host-role picker needs it.
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
/// roles (for the vote-gate / host pickers). Used by the config UI's connect
/// step. Stores nothing.
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
    role_views.sort_by_key(|r| std::cmp::Reverse(r.position));

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
        429 => ConnectError::RateLimited,
        _ => ConnectError::Network,
    })
}

/// Post a followup message to an interaction, using the interaction's **own
/// webhook token** — no bot token, no `Authorization` header (the token in the
/// path *is* the credential). Used to deliver the ephemeral voting panel / vote
/// confirmation / host panel *after* the public poll message has been refreshed
/// in the interaction's own `UPDATE_MESSAGE` reply: a component interaction
/// allows exactly one reply, so the message edit takes the reply and the
/// (ephemeral) panel rides here.
///
/// `data` is a normal interaction-response `data` body (`content`/`components`/
/// `flags`); the ephemeral flag in it keeps the panel private.
/// `with_components=true` is required for the panel's rows to survive on this
/// webhook-style endpoint — without it Discord silently drops them. Best-effort:
/// the interaction token is valid ~15 minutes, and a failure just means the
/// member re-clicks, so the result is only logged.
pub async fn create_followup_message(
    http: &reqwest::Client,
    application_id: &str,
    token: &str,
    data: &Value,
) -> bool {
    let url = format!("{API_BASE}/webhooks/{application_id}/{token}?with_components=true");
    matches!(http.post(url).json(data).send().await, Ok(resp) if resp.status().is_success())
}

/// Edit an interaction's original response via its **own webhook token** (no bot
/// token). When that interaction was a click on the public message we answered
/// with an `UPDATE_MESSAGE`, `@original` *is* the poll message — so a later
/// action on an ephemeral panel (a pick, retract, close or reopen, all out of
/// reach of the message) can still bring it current by reusing that earlier
/// click's token. `data` is the same edit body an `UPDATE_MESSAGE` reply
/// carries; `with_components=true` keeps the (V2) components. Best-effort: the
/// token is valid ~15 minutes, and on any failure the message just waits for
/// the next click on it, so the result is only logged.
pub async fn edit_original_message(
    http: &reqwest::Client,
    application_id: &str,
    token: &str,
    data: &Value,
) -> bool {
    let url = format!(
        "{API_BASE}/webhooks/{application_id}/{token}/messages/@original?with_components=true"
    );
    matches!(http.patch(url).json(data).send().await, Ok(resp) if resp.status().is_success())
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
