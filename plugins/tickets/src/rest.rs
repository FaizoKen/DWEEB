//! The thin Discord REST layer, authenticated with the shared **bot token**
//! (Manage Channels + Manage Roles), plus the interaction-token calls that edit
//! a deferred reply.
//!
//! Three phases:
//!   • config time — list a guild's roles + channels and work out what the bot
//!     can actually do there (`connect`), so the picker warns *before* a member
//!     ever clicks;
//!   • click time, on the 3s path — at most a quick existence probe
//!     (`channel_exists`), used only when a member is refused at the open cap;
//!   • click time, deferred — create the private channel, post into it,
//!     rename/lock/delete, manage overwrites, pull history for the transcript.
//!
//! Every call goes to `discord.com` (the base is a constant; only tests point it
//! elsewhere), so there is no SSRF surface even though the token is
//! operator-supplied.
//!
//! **Retrying is by what Discord may already have done.** A 429 means Discord
//! did nothing, so any call waits out a short `retry_after` and goes again. A
//! failed *dial* means nothing reached Discord — same. But a 5xx or a timeout
//! on a `POST` may have created the channel or posted the message already, so
//! only idempotent calls (GET/PUT/PATCH/DELETE) are ever replayed after one.

use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::perms::{self, Overwrite, Scope};
use crate::transcript;

pub const API_BASE: &str = "https://discord.com/api/v10";

/// Deadline for one call made off the interaction's 3s path.
const BACKGROUND_TIMEOUT: Duration = Duration::from_secs(8);
/// Deadline for a probe made *on* the 3s path (the at-limit reconcile), which
/// must leave the click time to answer.
const PROBE_TIMEOUT: Duration = Duration::from_millis(1200);
/// The longest `retry_after` honoured. A longer one (a channel-rename limit
/// is minutes) is answered as Busy — no click waits that long.
const MAX_RATE_LIMIT_WAIT: Duration = Duration::from_secs(5);
/// Attempts per call, the first included.
const MAX_ATTEMPTS: u32 = 3;
/// Pages of 100 fetched for a transcript.
pub const HISTORY_PAGES: usize = 5;

// Discord channel types we surface to the picker.
const CHANNEL_GUILD_TEXT: u8 = 0;
const CHANNEL_GUILD_CATEGORY: u8 = 4;
const CHANNEL_GUILD_ANNOUNCEMENT: u8 = 5;

/// A channel a log line or transcript can be posted to.
pub fn is_text_channel(kind: u8) -> bool {
    matches!(kind, CHANNEL_GUILD_TEXT | CHANNEL_GUILD_ANNOUNCEMENT)
}

/// A category tickets can be created under.
pub fn is_category(kind: u8) -> bool {
    kind == CHANNEL_GUILD_CATEGORY
}

/// The application flags that mean "may read message content".
const APP_FLAG_MESSAGE_CONTENT: u64 = 1 << 18;
const APP_FLAG_MESSAGE_CONTENT_LIMITED: u64 = 1 << 19;

/// Why a connect attempt failed, phrased for a human in the config UI.
#[derive(Debug)]
pub enum ConnectError {
    /// 401 — the bot token is wrong or was reset.
    BadToken,
    /// 403/404 on the guild — the bot isn't in that server (or can't see it).
    BotNotInGuild,
    /// 429 — Discord is rate-limiting us. Transient.
    RateLimited,
    /// Discord took the request but didn't answer inside the client deadline.
    /// Transient, and not ours: nothing on this box makes Discord faster.
    Timeout,
    /// Discord answered 5xx, or the connection dropped mid-flight. Transient,
    /// and theirs.
    Upstream,
    /// Couldn't connect to Discord at all (DNS, refused, TLS), or its reply
    /// wasn't the shape we expect — this host's network, or our code.
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
            ConnectError::Timeout => {
                "Discord is slow to answer right now — try again in a moment.".into()
            }
            ConnectError::Upstream => {
                "Discord is having trouble right now — try again in a moment.".into()
            }
            ConnectError::Network => "Couldn't reach Discord just now — try again in a moment.".into(),
        }
    }

    /// The HTTP status `/api/connect` answers with — which is also the alerting
    /// decision: `crate::trace::on_failure` pages on any 5xx except the 503/504
    /// that mean "Discord, not us" (see `trace.rs`). A user-caused outcome is
    /// 4xx and is never logged at all. The config iframe auto-connects on open,
    /// so an admin opening it for a server this plugin's bot was never invited
    /// to is routine — it must not page anyone. Neither may Discord merely being
    /// slow: on 2026-08-20 one 2200 ms timeout on Self Role's identical route
    /// paged the maintainer over nothing anyone could act on.
    pub fn status(&self) -> StatusCode {
        match self {
            // Our own credential is broken; every connect will fail until the
            // operator rotates it. This one *should* page.
            ConnectError::BadToken => StatusCode::INTERNAL_SERVER_ERROR,
            ConnectError::BotNotInGuild => StatusCode::NOT_FOUND,
            ConnectError::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            // Discord took the request and ran long: theirs — logged, not paged.
            ConnectError::Timeout => StatusCode::GATEWAY_TIMEOUT,
            // Discord answered 5xx or hung up mid-flight: theirs — logged, not paged.
            ConnectError::Upstream => StatusCode::SERVICE_UNAVAILABLE,
            // We couldn't even connect, or couldn't read the reply — this host's
            // network or our code. Rare, and worth a page.
            ConnectError::Network => StatusCode::BAD_GATEWAY,
        }
    }
}

/// Why a click-time REST call didn't take. Kept distinct so the reply can blame
/// the right thing — collapsing them is what turns a transient blip into a
/// misleading "fix my permissions".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestError {
    /// Discord refused the request itself: an admin fix, or a target that's
    /// gone — see [`Refusal`].
    Refused(Refusal),
    /// A rate limit past our patience, a 5xx, or the network. Transient.
    Busy,
}

/// What kind of "no" Discord said, read from its JSON error `code`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// 50013 Missing Permissions / 50001 Missing Access (or a bare 403).
    MissingPermissions,
    /// The target doesn't exist: an Unknown Channel/Guild/Member/Message/
    /// Overwrite/User code, or a bare 404.
    NotFound,
    /// A form error on `parent_id`: the category is full (50 channels) or gone.
    CategoryProblem,
    /// 30013 — the server is at Discord's channel cap.
    ChannelLimit,
    /// 50007 — the user doesn't accept DMs from this bot.
    CannotDm,
    Other,
}

impl RestError {
    /// A refusal because the target no longer exists.
    pub fn is_not_found(self) -> bool {
        matches!(self, RestError::Refused(Refusal::NotFound))
    }
}

/// Classify a non-2xx, non-429, non-5xx answer by Discord's error `code`.
pub fn classify_refusal(status: u16, body: &str) -> Refusal {
    let code = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.get("code").and_then(Value::as_u64));
    match code {
        Some(50013 | 50001) => Refusal::MissingPermissions,
        Some(30013) => Refusal::ChannelLimit,
        Some(50007) => Refusal::CannotDm,
        Some(50035) if body.contains("parent_id") => Refusal::CategoryProblem,
        Some(10003 | 10004 | 10007 | 10008 | 10009 | 10013) => Refusal::NotFound,
        _ => match status {
            403 => Refusal::MissingPermissions,
            404 => Refusal::NotFound,
            _ => Refusal::Other,
        },
    }
}

/// Whether a call may be sent again after Discord might have acted on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Replay {
    /// GET/PUT/PATCH/DELETE: doing it twice is doing it once.
    Idempotent,
    /// POST: replayed only when Discord certainly did nothing (429, or a dial
    /// that never connected).
    OnlyIfUntouched,
}

/// The shared bot's identity, fetched once.
#[derive(Debug, Clone)]
pub struct BotUser {
    pub id: String,
    pub name: String,
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
    /// The category a text channel sits in (None at the top level).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// Permissions the bot has server-wide but loses *here* (a channel or
    /// category overwrite), for this channel's job — creating tickets in a
    /// category, posting logs in a text channel. Empty = fine. A permission
    /// missing server-wide is reported once, in `bot_missing_required` /
    /// `bot_missing_optional`, not flagged on every channel.
    pub bot_missing: Vec<&'static str>,
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
    /// Server-wide permissions the bot needs for any ticket to open.
    pub bot_missing_required: Vec<&'static str>,
    /// Server-wide permissions without which tickets open, but members can't
    /// attach files, embed links or react in them.
    pub bot_missing_optional: Vec<&'static str>,
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
pub struct Role {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub color: u32,
    #[serde(default)]
    pub position: i64,
    #[serde(default)]
    pub managed: bool,
    #[serde(default)]
    pub mentionable: bool,
    #[serde(default)]
    pub permissions: String,
}

#[derive(Deserialize)]
pub struct Channel {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(rename = "type", default)]
    pub kind: u8,
    #[serde(default)]
    pub position: i64,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub permission_overwrites: Vec<RawOverwrite>,
}

#[derive(Deserialize)]
pub struct RawOverwrite {
    pub id: String,
    #[serde(rename = "type", default)]
    pub kind: u8,
    #[serde(default)]
    pub allow: String,
    #[serde(default)]
    pub deny: String,
}

impl RawOverwrite {
    fn parsed(&self) -> Overwrite {
        Overwrite {
            id: self.id.clone(),
            kind: self.kind,
            allow: perms::parse_bits(&self.allow),
            deny: perms::parse_bits(&self.deny),
        }
    }
}

#[derive(Deserialize)]
struct BotMember {
    #[serde(default)]
    roles: Vec<String>,
}

/// A fetched message, trimmed to what the transcript renders.
#[derive(Deserialize, Default)]
struct RawMessage {
    #[serde(default)]
    id: String,
    #[serde(rename = "type", default)]
    kind: u8,
    #[serde(default)]
    content: String,
    #[serde(default)]
    timestamp: String,
    #[serde(default)]
    edited_timestamp: Option<String>,
    #[serde(default)]
    author: RawAuthor,
    #[serde(default)]
    attachments: Vec<RawAttachment>,
    #[serde(default)]
    embeds: Vec<RawEmbed>,
    #[serde(default)]
    sticker_items: Vec<RawSticker>,
    #[serde(default)]
    mentions: Vec<RawAuthor>,
    #[serde(default)]
    components: Vec<Value>,
}

#[derive(Deserialize, Default)]
struct RawAuthor {
    #[serde(default)]
    id: String,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    global_name: Option<String>,
    #[serde(default)]
    bot: bool,
}

impl RawAuthor {
    fn name(&self) -> String {
        self.global_name
            .clone()
            .or_else(|| self.username.clone())
            .unwrap_or_else(|| "unknown".to_string())
    }
}

#[derive(Deserialize, Default)]
struct RawAttachment {
    #[serde(default)]
    filename: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    size: u64,
}

#[derive(Deserialize, Default)]
struct RawEmbed {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    fields: Vec<RawEmbedField>,
    #[serde(default)]
    color: Option<u32>,
}

#[derive(Deserialize, Default)]
struct RawEmbedField {
    #[serde(default)]
    name: String,
    #[serde(default)]
    value: String,
}

#[derive(Deserialize, Default)]
struct RawSticker {
    #[serde(default)]
    name: String,
}

/// A channel's history, ready for [`transcript::render`].
pub struct History {
    /// Oldest first.
    pub messages: Vec<transcript::Message>,
    /// Display names of everyone who wrote or was mentioned, by user id.
    pub users: std::collections::HashMap<String, String>,
    /// More history existed than [`HISTORY_PAGES`] pages.
    pub truncated: bool,
}

/// Whether a channel still exists, as far as a quick probe can tell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Probe {
    Exists,
    /// Discord says Unknown Channel: it was deleted.
    Gone,
    /// The probe didn't get a clear answer — treat the channel as present.
    Unknown,
}

/// The Discord client: the shared HTTP pool, the API base, and the bot token.
#[derive(Clone)]
pub struct Discord {
    http: reqwest::Client,
    base: Arc<str>,
    token: Option<Arc<str>>,
}

impl Discord {
    pub fn new(http: reqwest::Client, base: &str, token: Option<&str>) -> Self {
        Self {
            http,
            base: base.trim_end_matches('/').into(),
            token: token.map(Into::into),
        }
    }

    pub fn has_token(&self) -> bool {
        self.token.is_some()
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn auth(&self) -> String {
        format!("Bot {}", self.token.as_deref().unwrap_or_default())
    }

    /// Send with the retry policy in the module docs. `build` makes a fresh
    /// request per attempt (a multipart body can't be cloned).
    async fn send(
        &self,
        build: impl Fn() -> reqwest::RequestBuilder,
        replay: Replay,
        timeout: Duration,
    ) -> Result<reqwest::Response, RestError> {
        let mut attempt = 0;
        loop {
            attempt += 1;
            let last = attempt >= MAX_ATTEMPTS;
            match build().timeout(timeout).send().await {
                Ok(resp) if resp.status().is_success() => return Ok(resp),
                Ok(resp) if resp.status() == StatusCode::TOO_MANY_REQUESTS => {
                    let wait = rate_limit_wait(resp).await;
                    if last || wait > MAX_RATE_LIMIT_WAIT {
                        tracing::warn!(
                            wait_ms = wait.as_millis() as u64,
                            "discord rate limit outlasted our patience"
                        );
                        return Err(RestError::Busy);
                    }
                    tokio::time::sleep(wait).await;
                }
                Ok(resp) if resp.status().is_server_error() => {
                    if last || replay != Replay::Idempotent {
                        tracing::warn!(status = %resp.status(), "discord server error");
                        return Err(RestError::Busy);
                    }
                    tokio::time::sleep(backoff(attempt)).await;
                }
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    let body = resp.text().await.unwrap_or_default();
                    let refusal = classify_refusal(status, &body);
                    if refusal != Refusal::NotFound {
                        tracing::warn!(status, ?refusal, "discord refused a request");
                    }
                    return Err(RestError::Refused(refusal));
                }
                Err(e) => {
                    // A dial that never connected reached nothing; a timeout
                    // after connecting may have done the work.
                    let untouched = e.is_connect();
                    let retry =
                        !last && (untouched || (replay == Replay::Idempotent && e.is_timeout()));
                    if !retry {
                        tracing::warn!(error = %describe(&e), "discord request failed");
                        return Err(RestError::Busy);
                    }
                    tokio::time::sleep(backoff(attempt)).await;
                }
            }
        }
    }

    // ── config time ──────────────────────────────────────────────────────────

    /// The bot's own identity (cached by the caller).
    pub async fn bot_user(&self) -> Result<BotUser, ConnectError> {
        let me: SelfUser = self.get_json("/users/@me").await?;
        let name = me
            .global_name
            .or(me.username)
            .unwrap_or_else(|| "the bot".into());
        Ok(BotUser { id: me.id, name })
    }

    /// Whether this application may read message content — which decides if a
    /// transcript can contain what members typed (see `transcript.rs`).
    pub async fn message_content_intent(&self) -> Result<bool, ConnectError> {
        #[derive(Deserialize)]
        struct App {
            #[serde(default)]
            flags: u64,
        }
        let app: App = self.get_json("/applications/@me").await?;
        Ok(app.flags & (APP_FLAG_MESSAGE_CONTENT | APP_FLAG_MESSAGE_CONTENT_LIMITED) != 0)
    }

    /// Inspect a guild through the bot: the guild name, its roles and channels,
    /// and what the bot can do server-wide and in each channel. The four reads
    /// are independent, so they run together.
    pub async fn connect(
        &self,
        guild_id: &str,
        bot: &BotUser,
    ) -> Result<ConnectResult, ConnectError> {
        // The guild doubles as our "is the bot in here?" probe (403/404 → not in).
        let (guild_path, roles_path, channels_path, member_path) = (
            format!("/guilds/{guild_id}"),
            format!("/guilds/{guild_id}/roles"),
            format!("/guilds/{guild_id}/channels"),
            format!("/guilds/{guild_id}/members/{}", bot.id),
        );
        let (guild, roles, channels, member) = tokio::try_join!(
            self.get_json::<Guild>(&guild_path),
            self.get_json::<Vec<Role>>(&roles_path),
            self.get_json::<Vec<Channel>>(&channels_path),
            self.get_json::<BotMember>(&member_path),
        )?;
        Ok(preflight(
            guild_id,
            guild.name,
            bot,
            roles,
            channels,
            &member.roles,
        ))
    }

    /// A guild's channels, as the bot sees them (every channel, whatever its
    /// permissions).
    pub async fn guild_channels(&self, guild_id: &str) -> Result<Vec<Channel>, ConnectError> {
        self.get_json(&format!("/guilds/{guild_id}/channels")).await
    }

    async fn get_json<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T, ConnectError> {
        let resp = self
            .http
            .get(self.url(path))
            .header("Authorization", self.auth())
            .send()
            .await
            .map_err(transport_error)?;
        let status = resp.status();
        if status.is_success() {
            return resp.json::<T>().await.map_err(body_error);
        }
        Err(match status.as_u16() {
            401 => ConnectError::BadToken,
            403 | 404 => ConnectError::BotNotInGuild,
            429 => ConnectError::RateLimited,
            500..=599 => ConnectError::Upstream,
            _ => ConnectError::Network,
        })
    }

    // ── click time, on the 3s path ───────────────────────────────────────────

    /// Does this channel still exist? One quick GET, no retries: it runs while
    /// a click waits. Only Discord's explicit Unknown Channel counts as gone.
    pub async fn channel_exists(&self, channel_id: &str) -> Probe {
        let resp = self
            .http
            .get(self.url(&format!("/channels/{channel_id}")))
            .header("Authorization", self.auth())
            .timeout(PROBE_TIMEOUT)
            .send()
            .await;
        match resp {
            Ok(r) if r.status().is_success() => Probe::Exists,
            Ok(r) if r.status() == StatusCode::NOT_FOUND => {
                let body = r.text().await.unwrap_or_default();
                let code = serde_json::from_str::<Value>(&body)
                    .ok()
                    .and_then(|v| v.get("code").and_then(Value::as_u64));
                if code == Some(10003) {
                    Probe::Gone
                } else {
                    Probe::Unknown
                }
            }
            _ => Probe::Unknown,
        }
    }

    // ── click time, deferred ─────────────────────────────────────────────────

    /// Create the private ticket channel and return its id.
    pub async fn create_channel(
        &self,
        guild_id: &str,
        spec: &ChannelSpec<'_>,
    ) -> Result<String, RestError> {
        let mut body = serde_json::json!({
            "name": spec.name,
            "type": CHANNEL_GUILD_TEXT,
            "permission_overwrites": spec.overwrites,
        });
        if let Some(parent) = spec.parent_id {
            body["parent_id"] = serde_json::json!(parent);
        }
        if !spec.topic.is_empty() {
            body["topic"] = serde_json::json!(clamp(spec.topic, 1024));
        }
        let url = self.url(&format!("/guilds/{guild_id}/channels"));
        let reason = audit_reason(spec.reason);
        let resp = self
            .send(
                || {
                    self.http
                        .post(&url)
                        .header("Authorization", self.auth())
                        .header("X-Audit-Log-Reason", &reason)
                        .json(&body)
                },
                Replay::OnlyIfUntouched,
                BACKGROUND_TIMEOUT,
            )
            .await?;
        #[derive(Deserialize)]
        struct Created {
            id: String,
        }
        resp.json::<Created>()
            .await
            .map(|c| c.id)
            .map_err(|_| RestError::Busy)
    }

    /// Post a message; returns its id.
    pub async fn post_message(
        &self,
        channel_id: &str,
        payload: &Value,
    ) -> Result<String, RestError> {
        let url = self.url(&format!("/channels/{channel_id}/messages"));
        let resp = self
            .send(
                || {
                    self.http
                        .post(&url)
                        .header("Authorization", self.auth())
                        .json(payload)
                },
                Replay::OnlyIfUntouched,
                BACKGROUND_TIMEOUT,
            )
            .await?;
        #[derive(Deserialize)]
        struct Posted {
            #[serde(default)]
            id: String,
        }
        Ok(resp
            .json::<Posted>()
            .await
            .map(|p| p.id)
            .unwrap_or_default())
    }

    /// Edit one of the bot's own messages (retiring stale controls).
    pub async fn edit_message(
        &self,
        channel_id: &str,
        message_id: &str,
        payload: &Value,
    ) -> Result<(), RestError> {
        let url = self.url(&format!("/channels/{channel_id}/messages/{message_id}"));
        self.send(
            || {
                self.http
                    .patch(&url)
                    .header("Authorization", self.auth())
                    .json(payload)
            },
            Replay::Idempotent,
            BACKGROUND_TIMEOUT,
        )
        .await
        .map(drop)
    }

    /// Delete a channel. Already gone counts as done.
    pub async fn delete_channel(&self, channel_id: &str, reason: &str) -> Result<(), RestError> {
        let url = self.url(&format!("/channels/{channel_id}"));
        let reason = audit_reason(reason);
        match self
            .send(
                || {
                    self.http
                        .delete(&url)
                        .header("Authorization", self.auth())
                        .header("X-Audit-Log-Reason", &reason)
                },
                Replay::Idempotent,
                BACKGROUND_TIMEOUT,
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(e) if e.is_not_found() => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Rename a channel (`ticket-0001` ↔ `closed-0001`). Discord allows two
    /// renames per channel per ten minutes, so callers treat this as
    /// best-effort — a lock must not fail over a name.
    pub async fn rename_channel(
        &self,
        channel_id: &str,
        name: &str,
        reason: &str,
    ) -> Result<(), RestError> {
        let url = self.url(&format!("/channels/{channel_id}"));
        let reason = audit_reason(reason);
        let body = serde_json::json!({ "name": clamp(name, 100) });
        self.send(
            || {
                self.http
                    .patch(&url)
                    .header("Authorization", self.auth())
                    .header("X-Audit-Log-Reason", &reason)
                    .json(&body)
            },
            Replay::Idempotent,
            BACKGROUND_TIMEOUT,
        )
        .await
        .map(drop)
    }

    /// A channel's permission overwrites.
    pub async fn channel_overwrites(&self, channel_id: &str) -> Result<Vec<Overwrite>, RestError> {
        let url = self.url(&format!("/channels/{channel_id}"));
        let resp = self
            .send(
                || self.http.get(&url).header("Authorization", self.auth()),
                Replay::Idempotent,
                BACKGROUND_TIMEOUT,
            )
            .await?;
        let channel: Channel = resp.json().await.map_err(|_| RestError::Busy)?;
        Ok(channel
            .permission_overwrites
            .iter()
            .map(RawOverwrite::parsed)
            .collect())
    }

    /// Set a single permission overwrite (`PUT …/permissions/{id}`). `kind` is
    /// 0 (role) or 1 (member).
    pub async fn set_overwrite(
        &self,
        channel_id: &str,
        target_id: &str,
        kind: u8,
        allow: u64,
        deny: u64,
        reason: &str,
    ) -> Result<(), RestError> {
        let url = self.url(&format!("/channels/{channel_id}/permissions/{target_id}"));
        let reason = audit_reason(reason);
        let body = serde_json::json!({
            "type": kind,
            "allow": allow.to_string(),
            "deny": deny.to_string(),
        });
        self.send(
            || {
                self.http
                    .put(&url)
                    .header("Authorization", self.auth())
                    .header("X-Audit-Log-Reason", &reason)
                    .json(&body)
            },
            Replay::Idempotent,
            BACKGROUND_TIMEOUT,
        )
        .await
        .map(drop)
    }

    /// Remove a permission overwrite. Already absent counts as done.
    pub async fn delete_overwrite(
        &self,
        channel_id: &str,
        target_id: &str,
        reason: &str,
    ) -> Result<(), RestError> {
        let url = self.url(&format!("/channels/{channel_id}/permissions/{target_id}"));
        let reason = audit_reason(reason);
        match self
            .send(
                || {
                    self.http
                        .delete(&url)
                        .header("Authorization", self.auth())
                        .header("X-Audit-Log-Reason", &reason)
                },
                Replay::Idempotent,
                BACKGROUND_TIMEOUT,
            )
            .await
        {
            Err(e) if e.is_not_found() => Ok(()),
            other => other.map(drop),
        }
    }

    /// Fetch up to [`HISTORY_PAGES`] × 100 of a channel's most recent messages,
    /// oldest first. Best-effort: a failed page ends the fetch with what we
    /// have.
    pub async fn fetch_history(&self, channel_id: &str) -> History {
        let mut raw: Vec<RawMessage> = Vec::new();
        let mut before: Option<String> = None;
        let mut truncated = false;
        for page in 0..HISTORY_PAGES {
            let mut url = self.url(&format!("/channels/{channel_id}/messages?limit=100"));
            if let Some(b) = &before {
                url.push_str(&format!("&before={b}"));
            }
            let batch: Vec<RawMessage> = match self
                .send(
                    || self.http.get(&url).header("Authorization", self.auth()),
                    Replay::Idempotent,
                    BACKGROUND_TIMEOUT,
                )
                .await
            {
                Ok(resp) => match resp.json().await {
                    Ok(v) => v,
                    Err(_) => break,
                },
                Err(_) => break,
            };
            let full = batch.len() >= 100;
            // Discord returns newest-first; the last one is the next cursor.
            before = batch.last().map(|m| m.id.clone());
            raw.extend(batch);
            if !full {
                break;
            }
            if page + 1 == HISTORY_PAGES {
                truncated = true;
            }
        }
        raw.reverse(); // oldest-first reads like a conversation.
        history_from(raw, truncated)
    }

    /// Upload a file (a transcript) with a message, to a channel or a DM.
    pub async fn upload_file(
        &self,
        channel_id: &str,
        filename: &str,
        bytes: &[u8],
        mime: &str,
        content: &str,
    ) -> Result<(), RestError> {
        let payload = serde_json::json!({
            "content": clamp(content, 2000),
            "allowed_mentions": { "parse": [] },
            "attachments": [{ "id": 0, "filename": filename }],
        })
        .to_string();
        let url = self.url(&format!("/channels/{channel_id}/messages"));
        self.send(
            || {
                let part = reqwest::multipart::Part::bytes(bytes.to_vec())
                    .file_name(filename.to_string())
                    .mime_str(mime)
                    .expect("a static mime type parses");
                let form = reqwest::multipart::Form::new()
                    .text("payload_json", payload.clone())
                    .part("files[0]", part);
                self.http
                    .post(&url)
                    .header("Authorization", self.auth())
                    .multipart(form)
            },
            Replay::OnlyIfUntouched,
            BACKGROUND_TIMEOUT,
        )
        .await
        .map(drop)
    }

    /// Open (or reuse) the DM channel with a user.
    pub async fn open_dm(&self, user_id: &str) -> Result<String, RestError> {
        let url = self.url("/users/@me/channels");
        let body = serde_json::json!({ "recipient_id": user_id });
        let resp = self
            .send(
                || {
                    self.http
                        .post(&url)
                        .header("Authorization", self.auth())
                        .json(&body)
                },
                Replay::Idempotent, // opening a DM is get-or-create
                BACKGROUND_TIMEOUT,
            )
            .await?;
        #[derive(Deserialize)]
        struct Dm {
            id: String,
        }
        resp.json::<Dm>()
            .await
            .map(|d| d.id)
            .map_err(|_| RestError::Busy)
    }

    /// Edit the deferred interaction reply in place (`PATCH @original`). The
    /// interaction `token` authenticates this — no bot token — so it works for
    /// the main app and a custom app alike. `with_components` keeps a reply's
    /// components (the Members picker) on this webhook-style endpoint.
    pub async fn edit_original(
        &self,
        application_id: &str,
        interaction_token: &str,
        payload: &Value,
    ) -> Result<(), RestError> {
        let url = self.url(&format!(
            "/webhooks/{application_id}/{interaction_token}/messages/@original?with_components=true"
        ));
        // A quick flow can reach Discord before its own deferred reply does
        // (that ack travels back through the dispatcher and the proxy; this
        // edit goes straight to Discord), and the edit then finds no message.
        // So "not found" is retried briefly before it's believed.
        let mut result = Err(RestError::Busy);
        for wait_ms in [0, 400, 1200] {
            if wait_ms > 0 {
                tokio::time::sleep(Duration::from_millis(wait_ms)).await;
            }
            result = self
                .send(
                    || self.http.patch(&url).json(payload),
                    Replay::Idempotent,
                    BACKGROUND_TIMEOUT,
                )
                .await
                .map(drop);
            if !matches!(result, Err(e) if e.is_not_found()) {
                break;
            }
        }
        result
    }
}

/// Everything a ticket channel is created with.
pub struct ChannelSpec<'a> {
    pub name: &'a str,
    pub parent_id: Option<&'a str>,
    pub topic: &'a str,
    pub overwrites: Vec<Value>,
    pub reason: &'a str,
}

/// Work out, from a guild's roles and channels, what the bot can do — pure, so
/// the whole pre-flight is testable without Discord.
pub fn preflight(
    guild_id: &str,
    guild_name: String,
    bot: &BotUser,
    roles: Vec<Role>,
    channels: Vec<Channel>,
    bot_roles: &[String],
) -> ConnectResult {
    let everyone = roles
        .iter()
        .find(|r| r.id == guild_id)
        .map(|r| perms::parse_bits(&r.permissions))
        .unwrap_or(0);
    let base = perms::guild_permissions(
        everyone,
        bot_roles
            .iter()
            .filter_map(|rid| roles.iter().find(|r| &r.id == rid))
            .map(|r| perms::parse_bits(&r.permissions)),
    );

    let mut categories: Vec<ChannelView> = Vec::new();
    let mut text_channels: Vec<ChannelView> = Vec::new();
    let category_position: std::collections::HashMap<&str, i64> = channels
        .iter()
        .filter(|c| c.kind == CHANNEL_GUILD_CATEGORY)
        .map(|c| (c.id.as_str(), c.position))
        .collect();
    let mut sort_keys: Vec<(i64, i64)> = Vec::new();
    for c in &channels {
        let overwrites: Vec<Overwrite> = c
            .permission_overwrites
            .iter()
            .map(RawOverwrite::parsed)
            .collect();
        let here = perms::channel_permissions(base, guild_id, &bot.id, bot_roles, &overwrites);
        match c.kind {
            CHANNEL_GUILD_CATEGORY => categories.push(ChannelView {
                id: c.id.clone(),
                name: c.name.clone(),
                position: c.position,
                parent_id: None,
                bot_missing: perms::missing(here, perms::CATEGORY_BITS & base, Scope::Category),
            }),
            CHANNEL_GUILD_TEXT | CHANNEL_GUILD_ANNOUNCEMENT => {
                // Top-level channels list first, then each category's in order.
                let parent_pos = c
                    .parent_id
                    .as_deref()
                    .and_then(|p| category_position.get(p))
                    .copied()
                    .unwrap_or(-1);
                sort_keys.push((parent_pos, c.position));
                text_channels.push(ChannelView {
                    id: c.id.clone(),
                    name: c.name.clone(),
                    position: c.position,
                    parent_id: c.parent_id.clone(),
                    bot_missing: perms::missing(here, perms::LOG_BITS & base, Scope::Channel),
                });
            }
            _ => {}
        }
    }
    categories.sort_by_key(|c| c.position);
    let mut keyed: Vec<((i64, i64), ChannelView)> =
        sort_keys.into_iter().zip(text_channels).collect();
    keyed.sort_by_key(|(k, _)| *k);
    let text_channels = keyed.into_iter().map(|(_, v)| v).collect();

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

    ConnectResult {
        guild_id: guild_id.to_string(),
        guild_name,
        bot_id: bot.id.clone(),
        bot_name: bot.name.clone(),
        bot_can_manage_channels: base & perms::MANAGE_CHANNELS != 0,
        bot_can_manage_roles: base & perms::MANAGE_ROLES != 0,
        bot_missing_required: perms::missing(
            base,
            perms::REQUIRED_SERVER_BITS | perms::MANAGE_ROLES,
            Scope::Server,
        ),
        bot_missing_optional: perms::missing(base, perms::OPTIONAL_SERVER_BITS, Scope::Server),
        roles: role_views,
        categories,
        text_channels,
    }
}

/// Reduce fetched messages (oldest first) to the transcript's shape.
fn history_from(raw: Vec<RawMessage>, truncated: bool) -> History {
    let mut users = std::collections::HashMap::new();
    let mut messages = Vec::with_capacity(raw.len());
    for m in raw {
        users.insert(m.author.id.clone(), m.author.name());
        for mention in &m.mentions {
            users.insert(mention.id.clone(), mention.name());
        }
        let system = !matches!(m.kind, 0 | 19 | 20 | 23);
        let mut content = m.content;
        if content.is_empty() && !m.components.is_empty() {
            // A Components V2 message carries its text in Text Displays.
            let mut texts = Vec::new();
            collect_text_displays(&m.components, &mut texts);
            content = texts.join("\n");
        }
        if system {
            content = system_description(m.kind).to_string();
        }
        messages.push(transcript::Message {
            author_id: m.author.id.clone(),
            author_name: m.author.name(),
            author_bot: m.author.bot,
            timestamp: m.timestamp,
            edited: m.edited_timestamp.is_some(),
            system,
            content,
            attachments: m
                .attachments
                .into_iter()
                .map(|a| transcript::Attachment {
                    filename: a.filename,
                    url: a.url,
                    size: a.size,
                })
                .collect(),
            embeds: m
                .embeds
                .into_iter()
                .filter(|e| e.title.is_some() || e.description.is_some() || !e.fields.is_empty())
                .map(|e| transcript::Embed {
                    title: e.title.unwrap_or_default(),
                    description: e.description.unwrap_or_default(),
                    fields: e.fields.into_iter().map(|f| (f.name, f.value)).collect(),
                    color: e.color,
                })
                .collect(),
            stickers: m.sticker_items.into_iter().map(|s| s.name).collect(),
        });
    }
    History {
        messages,
        users,
        truncated,
    }
}

fn collect_text_displays(components: &[Value], out: &mut Vec<String>) {
    for c in components {
        if c.get("type").and_then(Value::as_u64) == Some(10) {
            if let Some(text) = c.get("content").and_then(Value::as_str) {
                out.push(text.to_string());
            }
        }
        if let Some(children) = c.get("components").and_then(Value::as_array) {
            collect_text_displays(children, out);
        }
    }
}

fn system_description(kind: u8) -> &'static str {
    match kind {
        6 => "pinned a message",
        7 => "joined the server",
        8..=11 => "boosted the server",
        18 => "started a thread",
        24 => "AutoMod took an action",
        46 => "a poll ended",
        _ => "system message",
    }
}

/// How long a 429 asks us to wait: the JSON `retry_after` (seconds, may be
/// fractional), else the `Retry-After` header, else a second.
async fn rate_limit_wait(resp: reqwest::Response) -> Duration {
    let header = resp
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<f64>().ok());
    let body = resp.text().await.unwrap_or_default();
    let json = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v.get("retry_after").and_then(Value::as_f64));
    let secs = json.or(header).unwrap_or(1.0);
    if !secs.is_finite() || secs < 0.0 {
        return Duration::from_secs(1);
    }
    // A hair of slack so the retry lands after the window, not on its edge.
    Duration::from_secs_f64(secs.min(3600.0)) + Duration::from_millis(50)
}

fn backoff(attempt: u32) -> Duration {
    Duration::from_millis(250 * attempt as u64)
}

/// Classify a transport failure reaching Discord. `is_connect()` is checked
/// first: a connect *timeout* answers true to both `is_connect()` and
/// `is_timeout()` and belongs with the dial failures — the same ordering the
/// dispatcher uses for its forward to a plugin. A dial that fails is this host
/// unable to reach discord.com at all: ours. Anything after a connection is
/// Discord taking the request and running long, or dropping it: theirs.
fn transport_error(e: reqwest::Error) -> ConnectError {
    if e.is_connect() || e.is_builder() {
        ConnectError::Network
    } else if e.is_timeout() {
        ConnectError::Timeout
    } else {
        ConnectError::Upstream
    }
}

/// A 2xx whose body couldn't be read or decoded. reqwest reports both a body
/// that died mid-read and a body serde refuses under `is_decode()`, so the split
/// is by the error's source: only serde refusing the shape is ours.
fn body_error(e: reqwest::Error) -> ConnectError {
    let wrong_shape = std::error::Error::source(&e).is_some_and(|s| s.is::<serde_json::Error>());
    if wrong_shape {
        ConnectError::Network
    } else {
        ConnectError::Upstream
    }
}

/// A transport error's cause chain, without the URL reqwest's `Display`
/// appends — some of these URLs are interaction webhooks, and an interaction
/// token is a credential for fifteen minutes.
fn describe(e: &reqwest::Error) -> String {
    let mut out = String::new();
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        if !out.is_empty() {
            out.push_str(": ");
        }
        out.push_str(&s.to_string());
        source = s.source();
    }
    if out.is_empty() {
        out = if e.is_timeout() {
            "timed out".into()
        } else if e.is_connect() {
            "could not connect".into()
        } else {
            "request failed".into()
        };
    }
    out
}

/// The `X-Audit-Log-Reason` header value: Discord takes the reason
/// percent-encoded (up to 512 characters once decoded — discord.js sends it
/// through `encodeURIComponent`), which is also what makes a member's
/// non-ASCII display name legal in an HTTP header at all. Control characters
/// are dropped; nothing here can break the header.
pub fn audit_reason(reason: &str) -> String {
    let mut out = String::new();
    for ch in reason.chars().filter(|c| !c.is_control()).take(512) {
        if ch.is_ascii_alphanumeric() || "-_.!~*'()".contains(ch) {
            out.push(ch);
        } else {
            let mut buf = [0u8; 4];
            for b in ch.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{b:02X}"));
            }
        }
    }
    out
}

fn clamp(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A routine, user-caused connect outcome must never answer 5xx, and a
    /// transient Discord failure may answer 5xx but must never page.
    ///
    /// `TraceLayer` reports every 5xx through `on_failure`, and `crate::trace`
    /// logs it at ERROR — which the ops alerter forwards to Discord — unless the
    /// status is the 503/504 that means "Discord, not us". The config iframe
    /// auto-connects whenever it opens, so an admin opening it for a server this
    /// plugin's bot was never invited to used to answer 502 and page the
    /// maintainer for a non-event; on 2026-08-20 a 2200 ms Discord timeout on
    /// Self Role's identical route paged over nothing anyone could act on. Keep
    /// all six honest.
    #[test]
    fn only_our_own_faults_page() {
        use crate::trace::status_pages;

        // Not a fault of ours — the caller named a guild we can't see, or Discord
        // asked us to slow down. Neither is even a server error.
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

        // Discord being slow or briefly broken: honestly a server error to the
        // caller, but nothing on this box can fix it — logged, never paged.
        assert_eq!(ConnectError::Timeout.status(), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(
            ConnectError::Upstream.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        for e in [ConnectError::Timeout, ConnectError::Upstream] {
            assert!(
                e.status().is_server_error(),
                "{e:?} is still a server error"
            );
            assert!(!status_pages(e.status()), "{e:?} must not page");
        }

        // Genuinely broken: our credential is rejected, or we can't reach
        // Discord at all. These *should* page.
        assert_eq!(
            ConnectError::BadToken.status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(ConnectError::Network.status(), StatusCode::BAD_GATEWAY);
        for e in [ConnectError::BadToken, ConnectError::Network] {
            assert!(status_pages(e.status()), "{e:?} should page");
        }
    }

    /// The transport split, pinned against real reqwest errors: a server that
    /// takes the request and never answers is a `Timeout`; a refused connection
    /// is `Network`; a 200 whose body isn't the JSON we expect is `Network`; a
    /// 200 cut off mid-body is `Upstream`. The last two both report
    /// `is_decode()` — the error's source is what tells them apart.
    #[tokio::test]
    async fn transport_failures_are_split_by_what_actually_failed() {
        use std::io::Write as _;
        use std::net::TcpListener;

        // Short deadline only for the deliberate stall. Everything else gets a
        // patient client: Windows reports a refused loopback connect only after
        // retransmitting the SYN (~1 s), and a total deadline that fires first
        // is reported as a plain timeout — which would be the wrong verdict for
        // the wrong reason.
        let quick = reqwest::Client::builder()
            .timeout(Duration::from_millis(400))
            .build()
            .unwrap();
        let patient = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();

        let stall = TcpListener::bind("127.0.0.1:0").unwrap();
        let stall_addr = stall.local_addr().unwrap();
        std::thread::spawn(move || {
            let (sock, _) = stall.accept().unwrap();
            std::thread::sleep(Duration::from_secs(3));
            drop(sock);
        });
        let e = quick
            .get(format!("http://{stall_addr}/"))
            .send()
            .await
            .unwrap_err();
        assert!(matches!(transport_error(e), ConnectError::Timeout));

        let refused_addr = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap()
        };
        let e = patient
            .get(format!("http://{refused_addr}/"))
            .send()
            .await
            .unwrap_err();
        assert!(e.is_connect(), "{e}");
        assert!(matches!(transport_error(e), ConnectError::Network));

        let client = patient;
        let junk = TcpListener::bind("127.0.0.1:0").unwrap();
        let junk_addr = junk.local_addr().unwrap();
        // A fake server must consume the request before answering and closing:
        // closing with unread bytes in the receive buffer sends an RST, and the
        // client then discards the response it already had (Windows, notably).
        fn read_request(sock: &mut std::net::TcpStream) {
            use std::io::Read as _;
            let mut buf = Vec::new();
            let mut byte = [0u8; 1];
            while !buf.ends_with(b"\r\n\r\n") {
                if sock.read(&mut byte).unwrap() == 0 {
                    break;
                }
                buf.push(byte[0]);
            }
        }
        std::thread::spawn(move || {
            let (mut sock, _) = junk.accept().unwrap();
            read_request(&mut sock);
            sock.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 8\r\nConnection: close\r\n\r\nnot json",
            )
            .unwrap();
            sock.shutdown(std::net::Shutdown::Both).ok();
        });
        let e = client
            .get(format!("http://{junk_addr}/"))
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap_err();
        assert!(matches!(body_error(e), ConnectError::Network));

        let cut = TcpListener::bind("127.0.0.1:0").unwrap();
        let cut_addr = cut.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut sock, _) = cut.accept().unwrap();
            read_request(&mut sock);
            sock.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"a\":",
            )
            .unwrap();
            sock.shutdown(std::net::Shutdown::Both).ok();
        });
        let e = client
            .get(format!("http://{cut_addr}/"))
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap_err();
        assert!(matches!(body_error(e), ConnectError::Upstream));
    }

    /// Every variant carries a human-readable message for the config UI, which
    /// renders `data.error` verbatim on any non-ok response.
    #[test]
    fn every_variant_explains_itself() {
        for e in [
            ConnectError::BadToken,
            ConnectError::BotNotInGuild,
            ConnectError::RateLimited,
            ConnectError::Timeout,
            ConnectError::Upstream,
            ConnectError::Network,
        ] {
            assert!(!e.message().trim().is_empty(), "{e:?} has no message");
        }
    }

    #[test]
    fn refusals_are_read_from_discords_error_codes() {
        assert_eq!(
            classify_refusal(403, r#"{"message":"Missing Permissions","code":50013}"#),
            Refusal::MissingPermissions
        );
        assert_eq!(
            classify_refusal(403, r#"{"message":"Missing Access","code":50001}"#),
            Refusal::MissingPermissions
        );
        assert_eq!(
            classify_refusal(
                400,
                r#"{"code":30013,"message":"Maximum number of guild channels reached (500)"}"#
            ),
            Refusal::ChannelLimit
        );
        // A full category is a form error on parent_id.
        assert_eq!(
            classify_refusal(
                400,
                r#"{"code":50035,"errors":{"parent_id":{"_errors":[{"code":"CHANNEL_PARENT_MAX_CHANNELS","message":"Maximum number of channels in category reached (50)"}]}},"message":"Invalid Form Body"}"#
            ),
            Refusal::CategoryProblem
        );
        // A form error elsewhere isn't a category problem.
        assert_eq!(
            classify_refusal(400, r#"{"code":50035,"errors":{"name":{}}}"#),
            Refusal::Other
        );
        assert_eq!(
            classify_refusal(404, r#"{"message":"Unknown Channel","code":10003}"#),
            Refusal::NotFound
        );
        assert_eq!(
            classify_refusal(403, r#"{"code":50007}"#),
            Refusal::CannotDm
        );
        // Without a body the status decides.
        assert_eq!(classify_refusal(403, ""), Refusal::MissingPermissions);
        assert_eq!(classify_refusal(404, "<html>"), Refusal::NotFound);
        assert_eq!(classify_refusal(400, ""), Refusal::Other);
    }

    #[test]
    fn audit_reasons_are_percent_encoded_utf8() {
        assert_eq!(
            audit_reason("Ticket opened by Ada"),
            "Ticket%20opened%20by%20Ada"
        );
        // A non-ASCII name survives instead of being stripped…
        assert_eq!(audit_reason("by Zoë"), "by%20Zo%C3%AB");
        // …and nothing can break the header.
        let v = audit_reason("evil\r\nX-Injected: 1 ✨");
        assert!(axum::http::HeaderValue::from_str(&v).is_ok());
        assert!(!v.contains('\r') && !v.contains('\n'));
        // Clamped to Discord's 512 decoded characters.
        assert_eq!(audit_reason(&"a".repeat(600)).len(), 512);
    }

    fn role(id: &str, perms_bits: u64) -> Role {
        Role {
            id: id.into(),
            name: format!("r{id}"),
            color: 0,
            position: 1,
            managed: false,
            mentionable: true,
            permissions: perms_bits.to_string(),
        }
    }

    fn channel(
        id: &str,
        kind: u8,
        position: i64,
        parent: Option<&str>,
        ow: Vec<RawOverwrite>,
    ) -> Channel {
        Channel {
            id: id.into(),
            name: format!("c{id}"),
            kind,
            position,
            parent_id: parent.map(Into::into),
            permission_overwrites: ow,
        }
    }

    fn raw_ow(id: &str, allow: u64, deny: u64) -> RawOverwrite {
        RawOverwrite {
            id: id.into(),
            kind: perms::OVERWRITE_ROLE,
            allow: allow.to_string(),
            deny: deny.to_string(),
        }
    }

    #[test]
    fn preflight_reads_everyone_and_per_channel_access() {
        let guild = "100";
        let bot = BotUser {
            id: "900".into(),
            name: "DWEEB".into(),
        };
        // @everyone keeps the defaults minus Attach Files; the bot's own role
        // carries just what the invite grants.
        let everyone = perms::VIEW_CHANNEL
            | perms::SEND_MESSAGES
            | perms::READ_MESSAGE_HISTORY
            | perms::EMBED_LINKS
            | perms::ADD_REACTIONS;
        let bot_role = perms::MANAGE_CHANNELS | perms::MANAGE_ROLES;
        let roles = vec![role(guild, everyone), role("200", bot_role)];
        let channels = vec![
            // A private category nobody let the bot into.
            channel(
                "10",
                4,
                1,
                None,
                vec![raw_ow(guild, 0, perms::VIEW_CHANNEL)],
            ),
            // A private category the bot's role was allowed into.
            channel(
                "11",
                4,
                0,
                None,
                vec![
                    raw_ow(guild, 0, perms::VIEW_CHANNEL),
                    raw_ow("200", perms::VIEW_CHANNEL, 0),
                ],
            ),
            // A read-only announcements channel: the bot loses Send here.
            channel(
                "20",
                0,
                5,
                Some("10"),
                vec![raw_ow(guild, 0, perms::SEND_MESSAGES)],
            ),
            channel("21", 0, 0, None, vec![]),
            channel("22", 5, 1, Some("11"), vec![]),
            channel("23", 2, 0, None, vec![]), // voice: not listed
        ];
        let r = preflight(
            guild,
            "Srv".into(),
            &bot,
            roles,
            channels,
            &["200".to_string()],
        );
        assert!(r.bot_can_manage_channels && r.bot_can_manage_roles);
        assert!(r.bot_missing_required.is_empty());
        assert_eq!(r.bot_missing_optional, vec!["Attach Files"]);

        // Categories in position order, each with what the bot lacks there.
        assert_eq!(r.categories[0].id, "11");
        assert!(r.categories[0].bot_missing.is_empty());
        assert_eq!(r.categories[1].id, "10");
        assert_eq!(r.categories[1].bot_missing, vec!["View Channels"]);

        // Text channels: top-level first, then by category order.
        let order: Vec<_> = r.text_channels.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(order, ["21", "22", "20"]);
        // Attach Files is missing server-wide: reported once above, never
        // flagged on every channel — only a channel's *own* denial is.
        assert!(r.text_channels[0].bot_missing.is_empty());
        assert_eq!(r.text_channels[2].bot_missing, vec!["Send Messages"]);
        // Roles: @everyone dropped.
        assert!(r.roles.iter().all(|x| x.id != guild));
    }

    #[test]
    fn preflight_with_administrator_needs_nothing() {
        let bot = BotUser {
            id: "900".into(),
            name: "DWEEB".into(),
        };
        let roles = vec![role("100", 0), role("200", perms::ADMINISTRATOR)];
        let channels = vec![channel("10", 4, 0, None, vec![raw_ow("100", 0, u64::MAX)])];
        let r = preflight(
            "100",
            "Srv".into(),
            &bot,
            roles,
            channels,
            &["200".to_string()],
        );
        assert!(r.bot_missing_required.is_empty() && r.bot_missing_optional.is_empty());
        assert!(r.categories[0].bot_missing.is_empty());
    }

    #[test]
    fn history_resolves_names_system_messages_and_v2_text() {
        let raw: Vec<RawMessage> = serde_json::from_value(serde_json::json!([
            { "id": "1", "type": 0, "content": "hi <@2>", "timestamp": "2026-06-15T12:31:00+00:00",
              "author": { "id": "1", "username": "ada", "global_name": "Ada" },
              "mentions": [{ "id": "2", "username": "bob" }] },
            { "id": "2", "type": 6, "content": "", "timestamp": "2026-06-15T12:32:00+00:00",
              "author": { "id": "2", "username": "bob" } },
            { "id": "3", "type": 0, "content": "", "timestamp": "2026-06-15T12:33:00+00:00", "flags": 32768,
              "author": { "id": "9", "username": "DWEEB", "bot": true },
              "components": [{ "type": 17, "components": [{ "type": 10, "content": "V2 text" }] }] }
        ]))
        .unwrap();
        let h = history_from(raw, false);
        assert_eq!(h.users.get("2").map(String::as_str), Some("bob"));
        assert_eq!(h.users.get("1").map(String::as_str), Some("Ada"));
        assert!(h.messages[1].system);
        assert_eq!(h.messages[1].content, "pinned a message");
        assert_eq!(h.messages[2].content, "V2 text");
        assert!(h.messages[2].author_bot);
    }

    // ── the retry policy, against a fake Discord ──────────────────────────────

    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Serve `answers` in order (the last repeats), counting requests.
    async fn fake_discord(answers: Vec<(u16, &'static str)>) -> (String, Arc<AtomicUsize>) {
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        let answers = Arc::new(answers);
        let app = axum::Router::new().fallback(move || {
            let counter = counter.clone();
            let answers = answers.clone();
            async move {
                let n = counter.fetch_add(1, Ordering::SeqCst);
                let (status, body) = answers[n.min(answers.len() - 1)];
                (
                    StatusCode::from_u16(status).unwrap(),
                    [("content-type", "application/json")],
                    body,
                )
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), hits)
    }

    fn client(base: &str) -> Discord {
        Discord::new(reqwest::Client::new(), base, Some("token"))
    }

    #[tokio::test]
    async fn a_short_rate_limit_is_waited_out_on_any_call() {
        let (base, hits) = fake_discord(vec![
            (
                429,
                r#"{"message":"You are being rate limited.","retry_after":0.05,"global":false}"#,
            ),
            (200, r#"{"id":"555"}"#),
        ])
        .await;
        // Even a POST: a 429 means Discord did nothing.
        let id = client(&base)
            .post_message("1", &serde_json::json!({}))
            .await;
        assert_eq!(id, Ok("555".to_string()));
        assert_eq!(hits.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_long_rate_limit_is_busy_not_a_wait() {
        let (base, hits) = fake_discord(vec![(429, r#"{"retry_after":600}"#)]).await;
        let r = client(&base).rename_channel("1", "x", "r").await;
        assert_eq!(r, Err(RestError::Busy));
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_server_error_is_retried_only_when_idempotent() {
        let (base, hits) = fake_discord(vec![(502, "{}"), (200, "{}")]).await;
        assert_eq!(client(&base).rename_channel("1", "x", "r").await, Ok(()));
        assert_eq!(hits.load(Ordering::SeqCst), 2);

        // A POST that 5xx'd may have created the channel: never sent twice.
        let (base, hits) = fake_discord(vec![(502, "{}"), (200, r#"{"id":"1"}"#)]).await;
        let spec = ChannelSpec {
            name: "ticket-0001",
            parent_id: None,
            topic: "",
            overwrites: vec![],
            reason: "r",
        };
        assert_eq!(
            client(&base).create_channel("g", &spec).await,
            Err(RestError::Busy)
        );
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn refusals_are_classified_and_not_retried() {
        let (base, hits) = fake_discord(vec![(
            403,
            r#"{"message":"Missing Permissions","code":50013}"#,
        )])
        .await;
        let spec = ChannelSpec {
            name: "ticket-0001",
            parent_id: Some("5"),
            topic: "",
            overwrites: vec![],
            reason: "r",
        };
        assert_eq!(
            client(&base).create_channel("g", &spec).await,
            Err(RestError::Refused(Refusal::MissingPermissions))
        );
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn deleting_what_is_already_gone_is_done() {
        let (base, _) =
            fake_discord(vec![(404, r#"{"message":"Unknown Channel","code":10003}"#)]).await;
        assert_eq!(client(&base).delete_channel("1", "r").await, Ok(()));
        assert_eq!(client(&base).delete_overwrite("1", "2", "r").await, Ok(()));
    }

    #[tokio::test]
    async fn only_unknown_channel_counts_as_gone() {
        let (base, _) =
            fake_discord(vec![(404, r#"{"message":"Unknown Channel","code":10003}"#)]).await;
        assert_eq!(client(&base).channel_exists("1").await, Probe::Gone);
        let (base, _) = fake_discord(vec![(403, r#"{"code":50001}"#)]).await;
        assert_eq!(client(&base).channel_exists("1").await, Probe::Unknown);
        let (base, _) = fake_discord(vec![(200, r#"{"id":"1"}"#)]).await;
        assert_eq!(client(&base).channel_exists("1").await, Probe::Exists);
    }

    #[tokio::test]
    async fn history_pages_until_a_short_page_and_flags_truncation() {
        let page: Vec<Value> = (0..100)
            .map(|i| serde_json::json!({ "id": format!("{}", 1000 - i), "content": "x", "author": { "id": "1" } }))
            .collect();
        let full: &'static str = Box::leak(serde_json::to_string(&page).unwrap().into_boxed_str());
        let (base, hits) = fake_discord(vec![(200, full)]).await;
        let h = client(&base).fetch_history("1").await;
        assert_eq!(hits.load(Ordering::SeqCst), HISTORY_PAGES);
        assert!(h.truncated);
        assert_eq!(h.messages.len(), 100 * HISTORY_PAGES);

        let (base, hits) = fake_discord(vec![(
            200,
            r#"[{"id":"1","content":"only","author":{"id":"1"}}]"#,
        )])
        .await;
        let h = client(&base).fetch_history("1").await;
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        assert!(!h.truncated);
        assert_eq!(h.messages[0].content, "only");
    }
}
