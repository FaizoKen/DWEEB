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
use std::time::Duration;

use axum::http::StatusCode;
use reqwest::header::{AUTHORIZATION, RETRY_AFTER};
use reqwest::Client;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::sync::Semaphore;

use crate::error::AppError;

const API_BASE: &str = "https://discord.com/api/v10";

/// How many times a `429`'d request is re-issued, and the longest `Retry-After`
/// we'll wait out before giving up. Discord's per-route limits clear in well
/// under a second, so a small budget absorbs the common transient case; capping
/// the wait means a genuine hard limit still surfaces promptly instead of
/// hanging the caller behind a held concurrency permit.
const MAX_RETRIES: u32 = 2;
const MAX_RETRY_WAIT: Duration = Duration::from_secs(4);

/// `MANAGE_GUILD` permission bit — held by admins/owners; our default gate for
/// "may this user read this server in a webhook-builder tool".
pub const MANAGE_GUILD: u64 = 0x20;

/// `ADMINISTRATOR` permission bit — implies every other permission, so it's the
/// catch-all when checking whether a user could do something in Discord itself.
pub const ADMINISTRATOR: u64 = 0x8;

/// `MANAGE_WEBHOOKS` permission bit (`1 << 29`). The Send/Restore webhook picker
/// mirrors Discord's own gating: only a user who holds this (or Administrator, or
/// is the owner) may see a guild's webhook tokens or create one, even though the
/// bot is what actually performs the calls.
pub const MANAGE_WEBHOOKS: u64 = 0x2000_0000;

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

/// A guild/channel webhook as Discord returns it from the management endpoints
/// (`GET /guilds/{id}/webhooks`, `POST /channels/{id}/webhooks`, …). These calls
/// require the bot to hold `MANAGE_WEBHOOKS`, and the response carries fields a
/// plain token GET never exposes: the creating `user` and, for type-1 incoming
/// webhooks, the `token` itself. The handler decides what to forward to the
/// browser (see `routes::webhooks_list`). `kind` keeps the wire name `type`.
#[derive(Deserialize, Serialize)]
pub struct Webhook {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: i64,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub guild_id: Option<String>,
    #[serde(default)]
    pub application_id: Option<String>,
    /// Present only for type-1 (incoming) webhooks. The execute URL is
    /// `…/webhooks/{id}/{token}`; this is the credential the Manager can recover.
    #[serde(default)]
    pub token: Option<String>,
    /// The member who created the webhook — only included when the request held
    /// `MANAGE_WEBHOOKS`, so it's the one new bit of attribution the permission buys.
    #[serde(default)]
    pub user: Option<WebhookUser>,
}

/// Trimmed creator object on a [`Webhook`]. `username`/`global_name` may both be
/// present; the handler prefers the global (display) name when building output.
#[derive(Deserialize, Serialize)]
pub struct WebhookUser {
    pub id: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub global_name: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
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

    /// Could the user manage this guild's webhooks in Discord itself? Owner,
    /// Administrator, or the explicit `MANAGE_WEBHOOKS` bit. This is the gate
    /// for the Send/Restore webhook picker — the bot does the work, but we only
    /// reveal a guild's webhook tokens to someone who could already see them in
    /// Discord.
    pub fn can_manage_webhooks(&self) -> bool {
        if self.owner {
            return true;
        }
        self.permissions
            .parse::<u64>()
            .map(|p| p & ADMINISTRATOR != 0 || p & MANAGE_WEBHOOKS != 0)
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

    // ── Webhook management (needs the bot to hold MANAGE_WEBHOOKS) ──────────
    //
    // Enumerate a guild's webhooks (the one call that hard-requires the bit),
    // create one in a channel, and rename/re-avatar/move or delete any of them —
    // the feed + inline management behind the Send/Restore picker. The writes
    // thread an optional audit-log reason; a 403 from any maps to an actionable
    // "re-add the bot" message (the permission bit isn't on the bot's role yet —
    // the server hasn't re-invited since the union was bumped).

    /// Every webhook in a guild, across all its channels. The single Discord
    /// call that genuinely needs `MANAGE_WEBHOOKS`; the response includes each
    /// incoming webhook's token and its creator.
    ///
    /// Uses the webhook-flavoured error mapping (not the plain bot-read one):
    /// unlike roles/channels/emojis, a 403 here is the *bot* missing
    /// `MANAGE_WEBHOOKS`, which the user fixes by re-adding the bot. Surfacing it
    /// as an actionable 403 (rather than a generic 502) lets the picker offer the
    /// re-invite, matching what the create/modify/delete calls already do.
    pub async fn guild_webhooks(&self, guild: &str) -> Result<Vec<Webhook>, AppError> {
        let resp = self
            .send_bot(
                reqwest::Method::GET,
                &format!("/guilds/{guild}/webhooks"),
                None,
                None,
            )
            .await?;
        if resp.status().is_success() {
            return resp.json::<Vec<Webhook>>().await.map_err(|e| {
                AppError::BadGateway(format!("unexpected response from Discord: {e}"))
            });
        }
        Err(webhook_error_from(resp).await)
    }

    /// Create an incoming webhook in a channel. `avatar` is an image data URI
    /// (`data:image/png;base64,…`) or None for Discord's default picture.
    pub async fn create_webhook(
        &self,
        channel_id: &str,
        name: &str,
        avatar: Option<&str>,
        reason: Option<&str>,
    ) -> Result<Webhook, AppError> {
        let mut body = Map::new();
        body.insert("name".into(), Value::String(name.to_string()));
        if let Some(a) = avatar {
            body.insert("avatar".into(), Value::String(a.to_string()));
        }
        self.send_bot_json(
            reqwest::Method::POST,
            &format!("/channels/{channel_id}/webhooks"),
            Value::Object(body),
            reason,
        )
        .await
    }

    /// Modify a webhook by id. `name` renames; `avatar` is `None` to leave it,
    /// `Some(Null)` to clear it, or `Some(String)` (a data URI) to set it;
    /// `channel_id` moves it to another channel.
    pub async fn modify_webhook(
        &self,
        webhook_id: &str,
        name: Option<&str>,
        avatar: Option<Value>,
        channel_id: Option<&str>,
        reason: Option<&str>,
    ) -> Result<Webhook, AppError> {
        let mut body = Map::new();
        if let Some(n) = name {
            body.insert("name".into(), Value::String(n.to_string()));
        }
        if let Some(a) = avatar {
            body.insert("avatar".into(), a);
        }
        if let Some(c) = channel_id {
            body.insert("channel_id".into(), Value::String(c.to_string()));
        }
        self.send_bot_json(
            reqwest::Method::PATCH,
            &format!("/webhooks/{webhook_id}"),
            Value::Object(body),
            reason,
        )
        .await
    }

    /// Delete a webhook by id (204 on success).
    pub async fn delete_webhook(
        &self,
        webhook_id: &str,
        reason: Option<&str>,
    ) -> Result<(), AppError> {
        self.send_bot_unit(
            reqwest::Method::DELETE,
            &format!("/webhooks/{webhook_id}"),
            reason,
        )
        .await
    }

    // ── Webhook-message edits (webhook token; NOT the bot token) ────────────
    //
    // Editing a message a webhook authored needs only that webhook's own token
    // (`/webhooks/{id}/{token}/messages/{id}`) — the very credential DWEEB
    // already uses to *post*, never the bot token. Used to revive the
    // components the interactions dispatcher's TTL gate disabled, once a message
    // is granted a never-expire slot (see `routes::permanent_reenable`). No
    // `bot_sem` permit: a webhook token is a different credential on its own
    // rate-limit buckets, so it never draws on the shared bot budget.

    /// Fetch a webhook's own message by id, with the webhook token. `Ok(None)`
    /// when this webhook didn't author it (404) — the signal to try the next
    /// candidate webhook in the channel; `Ok(Some(message))` on success.
    pub async fn webhook_message(
        &self,
        webhook_id: &str,
        token: &str,
        message_id: &str,
    ) -> Result<Option<Value>, AppError> {
        let url = format!("{API_BASE}/webhooks/{webhook_id}/{token}/messages/{message_id}");
        let resp = send_with_retry(self.http.get(&url))
            .await
            .map_err(|e| AppError::BadGateway(format!("could not reach Discord: {e}")))?;
        if resp.status().is_success() {
            return resp.json::<Value>().await.map(Some).map_err(|e| {
                AppError::BadGateway(format!("unexpected response from Discord: {e}"))
            });
        }
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        Err(webhook_error_from(resp).await)
    }

    /// Edit a webhook's own message by id, with the webhook token. `body` is a
    /// partial edit (the caller sends `components`, plus `flags` for a V2
    /// message); fields left out — content, embeds, attachments — are untouched
    /// by Discord.
    pub async fn edit_webhook_message(
        &self,
        webhook_id: &str,
        token: &str,
        message_id: &str,
        body: Value,
    ) -> Result<(), AppError> {
        let url = format!("{API_BASE}/webhooks/{webhook_id}/{token}/messages/{message_id}");
        let resp = send_with_retry(self.http.patch(&url).json(&body))
            .await
            .map_err(|e| AppError::BadGateway(format!("could not reach Discord: {e}")))?;
        if resp.status().is_success() {
            return Ok(());
        }
        Err(webhook_error_from(resp).await)
    }

    /// Post a message **through** an incoming webhook, with the webhook's own
    /// token (never the bot token — the same credential the browser posts with,
    /// on its own rate-limit buckets, so no `bot_sem` permit). `payload` is the
    /// full wire body the builder built (components + flags + username/avatar_url
    /// …). `?wait=true` makes Discord echo the created message back, so the caller
    /// can hand the browser a jump link. Used by the embedded Activity, which —
    /// unlike the web builder — can't POST to discord.com directly from inside
    /// Discord's sandboxed iframe, so the proxy posts on its behalf.
    pub async fn execute_webhook(
        &self,
        webhook_id: &str,
        token: &str,
        payload: &Value,
    ) -> Result<Value, AppError> {
        let url =
            format!("{API_BASE}/webhooks/{webhook_id}/{token}?wait=true&with_components=true");
        let resp = send_with_retry(self.http.post(&url).json(payload))
            .await
            .map_err(|e| AppError::BadGateway(format!("could not reach Discord: {e}")))?;
        if resp.status().is_success() {
            return resp.json::<Value>().await.map_err(|e| {
                AppError::BadGateway(format!("unexpected response from Discord: {e}"))
            });
        }
        Err(webhook_error_from(resp).await)
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

    /// Best-effort public application name, from `GET /applications/{id}/rpc`
    /// — an endpoint Discord serves without credentials, so it works for apps
    /// the DWEEB bot has no relationship with. A few (mostly ancient) apps
    /// 404 there despite existing, so `None` means "couldn't resolve", not
    /// "no such app"; never fails the caller.
    pub async fn application_name(&self, application_id: &str) -> Option<String> {
        #[derive(Deserialize)]
        struct Named {
            #[serde(default)]
            name: Option<String>,
        }
        let resp = self
            .http
            .get(format!("{API_BASE}/applications/{application_id}/rpc"))
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        resp.json::<Named>().await.ok()?.name
    }

    /// Best-effort application name using the app's own credentials: a
    /// client-credentials grant, then `GET /oauth2/@me`, whose response
    /// always carries the application object. Covers the apps the public
    /// lookup misses, for callers holding a client secret anyway.
    pub async fn application_name_via_secret(
        &self,
        client_id: &str,
        client_secret: &str,
    ) -> Option<String> {
        #[derive(Deserialize)]
        struct Grant {
            access_token: String,
        }
        #[derive(Deserialize)]
        struct AppInfo {
            #[serde(default)]
            name: Option<String>,
        }
        #[derive(Deserialize)]
        struct OauthMe {
            application: AppInfo,
        }
        let resp = self
            .http
            .post(format!("{API_BASE}/oauth2/token"))
            .form(&[
                ("client_id", client_id),
                ("client_secret", client_secret),
                ("grant_type", "client_credentials"),
                ("scope", "identify"),
            ])
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let grant = resp.json::<Grant>().await.ok()?;
        let resp = self
            .http
            .get(format!("{API_BASE}/oauth2/@me"))
            .header(AUTHORIZATION, format!("Bearer {}", grant.access_token))
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        resp.json::<OauthMe>().await.ok()?.application.name
    }

    /// Best-effort: install the DWEEB application-command set on an app using
    /// its own credentials. Run for custom apps at registration so their bot
    /// gets the same right-click menus as the main app (the dispatcher
    /// answers them regardless of which app the interaction arrives under).
    /// `false` on any failure; callers never block on this.
    pub async fn install_commands_via_secret(&self, client_id: &str, client_secret: &str) -> bool {
        self.put_commands_via_secret(client_id, client_secret, &command_set())
            .await
    }

    /// Best-effort: clear an app's command set when it is unregistered, so
    /// its context menus don't dangle once the dispatcher stops serving it.
    pub async fn clear_commands_via_secret(&self, client_id: &str, client_secret: &str) -> bool {
        self.put_commands_via_secret(client_id, client_secret, &serde_json::json!([]))
            .await
    }

    /// PUT an app's full global command list using its own credentials: a
    /// client-credentials grant with the `applications.commands.update`
    /// scope, then `PUT /applications/{id}/commands` with the Bearer token —
    /// no bot token involved, exactly what the stored client secret allows.
    async fn put_commands_via_secret(
        &self,
        client_id: &str,
        client_secret: &str,
        commands: &Value,
    ) -> bool {
        #[derive(Deserialize)]
        struct Grant {
            access_token: String,
        }
        let Ok(resp) = self
            .http
            .post(format!("{API_BASE}/oauth2/token"))
            .form(&[
                ("client_id", client_id),
                ("client_secret", client_secret),
                ("grant_type", "client_credentials"),
                ("scope", "applications.commands.update"),
            ])
            .send()
            .await
        else {
            return false;
        };
        if !resp.status().is_success() {
            return false;
        }
        let Ok(grant) = resp.json::<Grant>().await else {
            return false;
        };
        let Ok(resp) = self
            .http
            .put(format!("{API_BASE}/applications/{client_id}/commands"))
            .header(AUTHORIZATION, format!("Bearer {}", grant.access_token))
            .json(commands)
            .send()
            .await
        else {
            return false;
        };
        resp.status().is_success()
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

    /// Authenticated bot request carrying a JSON body, decoded as `T`. Holds the
    /// rate-budget permit across the call and threads an optional audit-log
    /// reason (so the action is attributable in the server's audit log). Used by
    /// the webhook create/modify calls; webhook-flavoured error mapping.
    async fn send_bot_json<T: DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Value,
        reason: Option<&str>,
    ) -> Result<T, AppError> {
        let resp = self.send_bot(method, path, Some(body), reason).await?;
        if resp.status().is_success() {
            return resp.json::<T>().await.map_err(|e| {
                AppError::BadGateway(format!("unexpected response from Discord: {e}"))
            });
        }
        Err(webhook_error_from(resp).await)
    }

    /// Like `send_bot_json` but for calls that answer with no body (DELETE → 204).
    async fn send_bot_unit(
        &self,
        method: reqwest::Method,
        path: &str,
        reason: Option<&str>,
    ) -> Result<(), AppError> {
        let resp = self.send_bot(method, path, None, reason).await?;
        if resp.status().is_success() {
            return Ok(());
        }
        Err(webhook_error_from(resp).await)
    }

    /// Shared transport for the write helpers: acquire the permit, attach the
    /// bot auth + optional reason + optional JSON body, and return the raw
    /// response for the caller to interpret. Only transport failures map to an
    /// error here; HTTP status is the caller's to handle.
    async fn send_bot(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        reason: Option<&str>,
    ) -> Result<reqwest::Response, AppError> {
        let _permit = self
            .bot_sem
            .acquire()
            .await
            .map_err(|_| AppError::Internal("rate-limit semaphore closed".into()))?;
        let mut req = self
            .http
            .request(method, format!("{API_BASE}{path}"))
            .header(AUTHORIZATION, format!("Bot {}", self.token));
        if let Some(r) = reason.map(audit_reason).filter(|r| !r.is_empty()) {
            req = req.header("X-Audit-Log-Reason", r);
        }
        if let Some(body) = body {
            req = req.json(&body);
        }
        send_with_retry(req)
            .await
            .map_err(|e| AppError::BadGateway(format!("could not reach Discord: {e}")))
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

    /// Exchange an embedded-Activity authorization `code` for a user access
    /// token. Identical to [`exchange_code`] but omits `redirect_uri`: the
    /// Embedded App SDK's `authorize` command issues the code over RPC, not a
    /// browser redirect, so Discord neither expects nor accepts one here.
    pub async fn exchange_code_embedded(
        &self,
        client_id: &str,
        client_secret: &str,
        code: &str,
    ) -> Result<TokenResponse, AppError> {
        let resp = self
            .http
            .post(format!("{API_BASE}/oauth2/token"))
            .form(&[
                ("client_id", client_id),
                ("client_secret", client_secret),
                ("grant_type", "authorization_code"),
                ("code", code),
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
        Err(AppError::Unauthorized(
            "Discord rejected the activity authorization (the code may have expired). Try again."
                .into(),
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
        let resp = send_with_retry(self.http.get(&url).header(AUTHORIZATION, auth))
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

/// The application-command set every DWEEB-served app carries: the
/// `/dashboard` slash command plus the right-click context-menu commands the
/// dispatcher answers inline (plugins/dispatcher/src/commands.rs). Mirrors
/// `scripts/register-commands.mjs` — the canonical copy, used for the main
/// app — change both together.
fn command_set() -> Value {
    const CHAT_INPUT: u8 = 1;
    const USER: u8 = 2;
    const MESSAGE: u8 = 3;
    const GUILD_INSTALL: u8 = 0;
    const GUILD_CONTEXT: u8 = 0;
    serde_json::json!([
        {
            "name": "dashboard",
            "description": "Get the link to the DWEEB dashboard.",
            "type": CHAT_INPUT,
            "integration_types": [GUILD_INSTALL],
            "contexts": [GUILD_CONTEXT],
        },
        {
            "name": "Edit in DWEEB",
            "type": MESSAGE,
            "integration_types": [GUILD_INSTALL],
            "contexts": [GUILD_CONTEXT],
        },
        {
            "name": "Export JSON",
            "type": MESSAGE,
            "integration_types": [GUILD_INSTALL],
            "contexts": [GUILD_CONTEXT],
        },
        {
            "name": "Message Info",
            "type": MESSAGE,
            "integration_types": [GUILD_INSTALL],
            "contexts": [GUILD_CONTEXT],
        },
        {
            "name": "Use as Webhook Identity",
            "type": USER,
            "integration_types": [GUILD_INSTALL],
            "contexts": [GUILD_CONTEXT],
        },
    ])
}

/// Issue a request, transparently retrying when Discord answers `429`: it sleeps
/// for the `Retry-After` Discord returns (bounded by [`MAX_RETRY_WAIT`], at most
/// [`MAX_RETRIES`] times), then re-sends. This is precisely the back-off Discord
/// asks clients to do — without it a brief rate limit (common right after a login
/// warms several cold caches at once) surfaces straight to the user as "Rate
/// limited by Discord". A request whose body can't be cloned is sent once,
/// un-retried. The final response (a success, or the last `429`/error) is returned
/// for the caller to interpret as before.
///
/// Note the caller may hold the bot concurrency permit across this, so a sleep
/// here also throttles the whole proxy while Discord is asking us to slow down —
/// the back-pressure that keeps a burst from compounding.
async fn send_with_retry(
    req: reqwest::RequestBuilder,
) -> Result<reqwest::Response, reqwest::Error> {
    let mut attempt = 0u32;
    loop {
        // `try_clone` only fails for a streaming body, which none of our calls
        // use (JSON or no body); fall back to a single shot if it ever does.
        let Some(this) = req.try_clone() else {
            return req.send().await;
        };
        let resp = this.send().await?;
        if resp.status().as_u16() != 429 || attempt >= MAX_RETRIES {
            return Ok(resp);
        }
        match retry_after(&resp) {
            Some(wait) if wait <= MAX_RETRY_WAIT => {
                attempt += 1;
                tracing::warn!(
                    attempt,
                    wait_ms = wait.as_millis() as u64,
                    "Discord rate-limited the request; backing off and retrying"
                );
                tokio::time::sleep(wait).await;
            }
            // No hint, or a wait longer than we'll hold the caller for: surface
            // the 429 so it isn't blocked for ages on a hard limit.
            _ => return Ok(resp),
        }
    }
}

/// The `Retry-After` from a `429` response, if present and well-formed.
fn retry_after(resp: &reqwest::Response) -> Option<Duration> {
    resp.headers()
        .get(RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_retry_after)
}

/// Parse a `Retry-After` value (seconds, possibly fractional) into a duration,
/// with a little padding so we don't retry a hair early on rounding or clock
/// skew. `None` when it's missing, negative, or unparseable.
fn parse_retry_after(raw: &str) -> Option<Duration> {
    let secs = raw
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|s| s.is_finite() && *s >= 0.0)?;
    Some(Duration::from_secs_f64(secs) + Duration::from_millis(50))
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

/// Map a non-success response from a webhook-management call onto an `AppError`.
///
/// Differs from `map_discord_error` in the 403 case: for these calls a 403 means
/// the *bot* doesn't hold `MANAGE_WEBHOOKS` in the guild — which the user can fix
/// by re-adding the bot now that the invite asks for it — so it surfaces as an
/// actionable 403 rather than a generic 502. 404 (webhook/channel gone) and 429
/// pass through with the right status.
async fn webhook_error_from(resp: reqwest::Response) -> AppError {
    let status = resp.status();
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

    match status.as_u16() {
        401 => AppError::BadGateway("Discord rejected the bot token — check DISCORD_BOT_TOKEN".into()),
        403 => AppError::Status {
            status: StatusCode::FORBIDDEN,
            message:
                "DWEEB's bot can't manage webhooks here yet — it needs the Manage Webhooks permission. \
                 Re-add the bot to this server (Account → Add to another server) to grant it, then try again."
                    .into(),
            retry_after: None,
        },
        404 => AppError::Status {
            status: StatusCode::NOT_FOUND,
            message: "That webhook or channel no longer exists on Discord.".into(),
            retry_after: None,
        },
        429 => AppError::Status {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: "Rate limited by Discord — try again shortly.".into(),
            retry_after,
        },
        400 => AppError::Status {
            status: StatusCode::BAD_REQUEST,
            message: format!("Discord rejected the request: {message}"),
            retry_after: None,
        },
        other => AppError::BadGateway(format!("Discord error {other}: {message}")),
    }
}

/// Sanitise a string for the `X-Audit-Log-Reason` header: keep printable ASCII,
/// replace anything else with a space (the header is a latin-1 value and Discord
/// caps the reason at 512 chars), and trim to a safe length. Empty → empty,
/// which the caller drops so no header is sent.
fn audit_reason(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if c.is_ascii_graphic() || c == ' ' {
                c
            } else {
                ' '
            }
        })
        .take(400)
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fractional_retry_after_with_padding() {
        // Discord's per-route limit hint is sub-second and fractional.
        let d = parse_retry_after("0.35").expect("parses");
        assert_eq!(d, Duration::from_millis(350) + Duration::from_millis(50));
        assert!(
            d <= MAX_RETRY_WAIT,
            "a sub-second hint is worth waiting out"
        );
    }

    #[test]
    fn parses_integer_and_zero() {
        assert_eq!(
            parse_retry_after(" 2 "),
            Some(Duration::from_secs(2) + Duration::from_millis(50))
        );
        assert_eq!(parse_retry_after("0"), Some(Duration::from_millis(50)));
    }

    #[test]
    fn rejects_garbage_and_negatives() {
        assert_eq!(parse_retry_after(""), None);
        assert_eq!(parse_retry_after("soon"), None);
        assert_eq!(parse_retry_after("-1"), None);
        assert_eq!(parse_retry_after("NaN"), None);
    }

    #[test]
    fn a_long_hint_exceeds_the_wait_cap() {
        // A multi-second global limit shouldn't be slept off behind a permit;
        // the caller surfaces it instead (the `> MAX_RETRY_WAIT` branch).
        let d = parse_retry_after("30").expect("parses");
        assert!(d > MAX_RETRY_WAIT);
    }
}
