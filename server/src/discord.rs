//! Thin client over Discord's REST API.
//!
//! Two credentials are used, never mixed:
//!   - the **bot token** (`Authorization: Bot …`) to read a guild's roles,
//!     channels, and emojis. These reads are trimmed to the fields the builder
//!     needs and are funnelled through a semaphore so a traffic spike can't
//!     exceed Discord's global rate budget for the shared token.
//!   - a **user's OAuth access token** (`Authorization: Bearer …`) to identify
//!     the signed-in user and list *their* guilds, which is how we authorize a
//!     read (you can only see servers you belong to).
//!
//! None of this requires a running ("hosted") bot: these are stateless REST
//! reads. The bot behind `DISCORD_BOT_TOKEN` only needs to be a member of the
//! guild being read.

use std::sync::Arc;

use axum::http::StatusCode;
use reqwest::header::AUTHORIZATION;
use reqwest::Client;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Semaphore;

use crate::error::AppError;

const API_BASE: &str = "https://discord.com/api/v10";

/// `MANAGE_GUILD` permission bit — held by admins/owners; our default gate for
/// "may this user read this server in a webhook-builder tool".
pub const MANAGE_GUILD: u64 = 0x20;

pub struct Discord {
    http: Client,
    token: String,
    /// Caps concurrent bot-token calls to Discord (global rate-budget guard).
    bot_sem: Arc<Semaphore>,
}

/// Trimmed guild role. `color` is Discord's integer form; the frontend can
/// render it as `#rrggbb`. Extra fields from Discord are ignored on decode.
#[derive(Deserialize, Serialize)]
pub struct Role {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: i64,
    #[serde(default)]
    pub position: i64,
    #[serde(default)]
    pub mentionable: bool,
    #[serde(default)]
    pub hoist: bool,
    #[serde(default)]
    pub managed: bool,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub unicode_emoji: Option<String>,
}

/// Trimmed guild channel. `kind` is Discord's numeric channel `type`
/// (0 text, 2 voice, 4 category, …); the rename keeps the wire name `type`.
#[derive(Deserialize, Serialize)]
pub struct Channel {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub kind: i64,
    #[serde(default)]
    pub position: Option<i64>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub nsfw: Option<bool>,
}

/// Trimmed custom emoji. `id` + `name` are enough to build `<:name:id>` (or
/// `<a:name:id>` when `animated`).
#[derive(Deserialize, Serialize)]
pub struct Emoji {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub animated: bool,
    #[serde(default)]
    pub available: bool,
}

/// Discord's OAuth2 token response (only the fields we use).
///
/// On a `webhook.incoming` authorization the response also carries the freshly
/// created `webhook` (with its ready-to-use execute `url`); on a plain login it's
/// absent. We only read the `url` — the browser re-verifies it to fill in the
/// name/owner for recents.
#[derive(Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub expires_in: i64,
    #[serde(default)]
    pub webhook: Option<IncomingWebhook>,
}

/// The webhook returned by a `webhook.incoming` token exchange. `url` is the
/// full execute URL (`…/webhooks/{id}/{token}`); `channel_id`/`guild_id` let us
/// best-effort resolve human names so same-named webhooks stay distinguishable.
#[derive(Deserialize)]
pub struct IncomingWebhook {
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub guild_id: Option<String>,
}

/// The signed-in user, from `GET /users/@me`.
#[derive(Deserialize, Serialize, Clone)]
pub struct DiscordUser {
    pub id: String,
    pub username: String,
    #[serde(default)]
    pub global_name: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
}

/// A guild from the *user's* `GET /users/@me/guilds`. `permissions` is the
/// user's computed permission bitfield in that guild, as a decimal string.
#[derive(Deserialize)]
pub struct UserGuild {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub owner: bool,
    #[serde(default)]
    pub permissions: String,
}

impl UserGuild {
    /// Does the user own, or hold `MANAGE_GUILD` in, this guild?
    pub fn can_manage(&self) -> bool {
        if self.owner {
            return true;
        }
        self.permissions
            .parse::<u64>()
            .map(|p| p & MANAGE_GUILD != 0)
            .unwrap_or(false)
    }
}

impl Discord {
    pub fn new(token: String, max_concurrency: usize) -> Self {
        let http = Client::builder()
            // Discord asks every API client to identify itself.
            .user_agent("DWEEB-Proxy/0.2 (+https://github.com/)")
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("failed to build HTTP client");
        Discord {
            http,
            token,
            bot_sem: Arc::new(Semaphore::new(max_concurrency.max(1))),
        }
    }

    // ── Bot-token reads (rate-budget guarded) ──────────────────────────────

    pub async fn roles(&self, guild: &str) -> Result<Vec<Role>, AppError> {
        self.get_bot(&format!("/guilds/{guild}/roles")).await
    }

    pub async fn channels(&self, guild: &str) -> Result<Vec<Channel>, AppError> {
        self.get_bot(&format!("/guilds/{guild}/channels")).await
    }

    pub async fn emojis(&self, guild: &str) -> Result<Vec<Emoji>, AppError> {
        self.get_bot(&format!("/guilds/{guild}/emojis")).await
    }

    /// Best-effort channel name for a `webhook.incoming` webhook's channel, so
    /// the builder can label same-named webhooks by destination. Returns None if
    /// the bot can't see the channel (not in that guild) — no login required when
    /// it can. `None` on any error; never fails the caller.
    pub async fn channel_name(&self, channel_id: &str) -> Option<String> {
        #[derive(Deserialize)]
        struct Named {
            #[serde(default)]
            name: Option<String>,
        }
        self.get_bot::<Named>(&format!("/channels/{channel_id}"))
            .await
            .ok()
            .and_then(|c| c.name)
    }

    /// Best-effort guild name (same contract as `channel_name`).
    pub async fn guild_name(&self, guild_id: &str) -> Option<String> {
        #[derive(Deserialize)]
        struct Named {
            #[serde(default)]
            name: Option<String>,
        }
        self.get_bot::<Named>(&format!("/guilds/{guild_id}"))
            .await
            .ok()
            .and_then(|g| g.name)
    }

    /// Every guild id the bot is a member of (paginated, 200 per page). Used to
    /// tell the user which of their servers are "ready" vs need the bot added.
    pub async fn bot_guild_ids(&self) -> Result<Vec<String>, AppError> {
        #[derive(Deserialize)]
        struct PartialGuild {
            id: String,
        }
        let mut out = Vec::new();
        let mut after: Option<String> = None;
        // Hard cap the loop so a pathological response can't spin forever.
        for _ in 0..50 {
            let path = match &after {
                Some(a) => format!("/users/@me/guilds?limit=200&after={a}"),
                None => "/users/@me/guilds?limit=200".to_string(),
            };
            let page: Vec<PartialGuild> = self.get_bot(&path).await?;
            let len = page.len();
            if let Some(last) = page.last() {
                after = Some(last.id.clone());
            }
            out.extend(page.into_iter().map(|g| g.id));
            if len < 200 {
                break;
            }
        }
        Ok(out)
    }

    /// Authenticated bot GET, decoded as `T`, with the concurrency permit held
    /// across the request.
    async fn get_bot<T: DeserializeOwned>(&self, path: &str) -> Result<T, AppError> {
        let _permit = self
            .bot_sem
            .acquire()
            .await
            .map_err(|_| AppError::Internal("rate-limit semaphore closed".into()))?;
        let auth = format!("Bot {}", self.token);
        self.get_json(path, &auth, false).await
    }

    // ── OAuth + user-token calls ───────────────────────────────────────────

    /// Exchange an OAuth2 authorization `code` for a user access token.
    pub async fn exchange_code(
        &self,
        client_id: &str,
        client_secret: &str,
        code: &str,
        redirect_uri: &str,
    ) -> Result<TokenResponse, AppError> {
        let resp = self
            .http
            .post(format!("{API_BASE}/oauth2/token"))
            .form(&[
                ("client_id", client_id),
                ("client_secret", client_secret),
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", redirect_uri),
            ])
            .send()
            .await
            .map_err(|e| AppError::BadGateway(format!("could not reach Discord: {e}")))?;

        if resp.status().is_success() {
            return resp
                .json::<TokenResponse>()
                .await
                .map_err(|e| AppError::BadGateway(format!("bad token response: {e}")));
        }
        // A bad/expired code is the caller's problem, not ours.
        Err(AppError::Unauthorized(
            "Discord rejected the login (the code may have expired). Try again.".into(),
        ))
    }

    /// `GET /users/@me` with the user's bearer token.
    pub async fn current_user(&self, access_token: &str) -> Result<DiscordUser, AppError> {
        self.get_json("/users/@me", &format!("Bearer {access_token}"), true)
            .await
    }

    /// `GET /users/@me/guilds` with the user's bearer token.
    pub async fn current_user_guilds(
        &self,
        access_token: &str,
    ) -> Result<Vec<UserGuild>, AppError> {
        self.get_json("/users/@me/guilds", &format!("Bearer {access_token}"), true)
            .await
    }

    /// Issue an authenticated GET and decode the JSON body, mapping any non-2xx
    /// status onto a meaningful `AppError`. `bearer` selects how a 401 is read:
    /// for a user token it means the *session* is dead (re-login); for the bot
    /// token it's a server misconfiguration.
    async fn get_json<T: DeserializeOwned>(
        &self,
        path: &str,
        auth: &str,
        bearer: bool,
    ) -> Result<T, AppError> {
        let url = format!("{API_BASE}{path}");
        let resp = self
            .http
            .get(&url)
            .header(AUTHORIZATION, auth)
            .send()
            .await
            .map_err(|e| AppError::BadGateway(format!("could not reach Discord: {e}")))?;

        let status = resp.status();
        if status.is_success() {
            return resp.json::<T>().await.map_err(|e| {
                AppError::BadGateway(format!("unexpected response from Discord: {e}"))
            });
        }

        // On 429 Discord tells us how long to wait; surface it to the caller.
        let retry_after = if status.as_u16() == 429 {
            resp.headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<f64>().ok())
        } else {
            None
        };

        let text = resp.text().await.unwrap_or_default();
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("message")
                    .and_then(|m| m.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "Discord returned an error".to_string());

        Err(map_discord_error(status, message, retry_after, bearer))
    }
}

/// Translate Discord's status into something useful for the proxy's caller.
///
/// For **bot-token** reads: 401/403 mean the proxy is misconfigured (bad token,
/// or the bot isn't in the guild) — that's our problem, surfaced as 502. 404
/// (unknown guild / bot not a member) and 429 (rate limit) pass through.
///
/// For **user-token** (bearer) calls a 401 means the user's session is expired
/// or revoked, so it surfaces as 401 to make the browser re-authenticate.
fn map_discord_error(
    status: StatusCode,
    message: String,
    retry_after: Option<f64>,
    bearer: bool,
) -> AppError {
    match status.as_u16() {
        401 if bearer => {
            AppError::Unauthorized("Your Discord session expired — sign in again.".into())
        }
        401 => {
            AppError::BadGateway("Discord rejected the bot token — check DISCORD_BOT_TOKEN".into())
        }
        403 => AppError::BadGateway(format!("the bot lacks access to this guild ({message})")),
        404 => AppError::Status {
            status: StatusCode::NOT_FOUND,
            message: "Server not found — make sure the DWEEB bot has been added to it.".into(),
            retry_after: None,
        },
        429 => AppError::Status {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: "Rate limited by Discord — try again shortly.".into(),
            retry_after,
        },
        other => AppError::BadGateway(format!("Discord error {other}: {message}")),
    }
}
