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

use axum::http::StatusCode;
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
                "That bot token was rejected by Discord. Copy it again from the Developer Portal → Bot → Reset Token.".into()
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
    /// slow: on 2026-08-20 one 2200 ms timeout on this route paged the maintainer
    /// over nothing anyone could act on.
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

/// One custom emoji as the config UI's emoji picker needs it.
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
    /// Whether the bot has Manage Roles (or Administrator) at all. When false,
    /// nothing is assignable and the UI shows one clear "fix the permission"
    /// banner instead of a warning per role.
    pub bot_can_manage_roles: bool,
    pub roles: Vec<RoleView>,
    /// The guild's custom emoji, so the select-option emoji picker can offer the
    /// server's own emoji alongside standard unicode ones.
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
    /// Permission bitfield, sent as a decimal string.
    #[serde(default)]
    permissions: String,
}

#[derive(Deserialize)]
struct BotMember {
    #[serde(default)]
    roles: Vec<String>,
}

#[derive(Deserialize, Default)]
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
    let bot_name = me
        .global_name
        .or(me.username)
        .unwrap_or_else(|| "the bot".into());

    // The guild — also our "is the bot actually in here?" probe. `get_json`
    // already maps a 403/404 here to `BotNotInGuild`, which is what it means.
    let guild: Guild = get_json(http, token, &format!("{API_BASE}/guilds/{guild_id}")).await?;

    let roles: Vec<Role> =
        get_json(http, token, &format!("{API_BASE}/guilds/{guild_id}/roles")).await?;
    let bot_member: BotMember = get_json(
        http,
        token,
        &format!("{API_BASE}/guilds/{guild_id}/members/{}", me.id),
    )
    .await?;
    // Custom emoji feed the option emoji picker. A fetch failure is treated as
    // "no custom emoji" rather than failing the whole connect — roles still work.
    let emojis: Vec<Emoji> = get_json(http, token, &format!("{API_BASE}/guilds/{guild_id}/emojis"))
        .await
        .unwrap_or_default();

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
        bot_can_manage_roles: can_manage,
        roles: views,
        emojis: emoji_views,
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
    role_op(
        http.put(role_url(guild_id, user_id, role_id)),
        token,
        reason,
    )
    .await
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

async fn role_op(req: reqwest::RequestBuilder, token: &str, reason: &str) -> Result<(), RoleError> {
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

/// Best-effort post of one line to an admin-chosen Discord audit-log webhook.
///
/// The URL is SSRF-guarded at save (`validate::validate_webhook`), so it can
/// only be a Discord webhook. `allowed_mentions.parse = []` makes the line inert
/// — it can name roles/users without pinging anyone. Failure is swallowed (this
/// is logging, never on the member's reply path); the caller fires it detached
/// so it can't eat into Discord's interaction window.
pub async fn post_webhook_log(http: &reqwest::Client, webhook_url: &str, content: &str) {
    let body = serde_json::json!({
        "content": content,
        "allowed_mentions": { "parse": [] },
    });
    match http.post(webhook_url).json(&body).send().await {
        Ok(resp) if resp.status().is_success() => {}
        Ok(resp) => tracing::warn!(status = %resp.status(), "audit-log webhook rejected"),
        Err(e) => {
            let kind = if e.is_timeout() {
                "timeout"
            } else if e.is_connect() {
                "connect"
            } else {
                "transport"
            };
            tracing::warn!(kind, "audit-log webhook unreachable");
        }
    }
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
    /// maintainer for a non-event; on 2026-08-20 a 2200 ms Discord timeout on the
    /// same route paged over nothing anyone could act on. Keep all six honest.
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
        use std::time::Duration;

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
}
