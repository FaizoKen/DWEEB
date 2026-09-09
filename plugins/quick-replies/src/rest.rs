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
                "The shared bot token was rejected by Discord. The operator needs to re-copy it from the Developer Portal → Bot → Reset Token.".into()
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
    /// slow: on 2026-08-20 one 2200 ms timeout on the self-role plugin's copy of
    /// this route paged the maintainer over nothing anyone could act on.
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
    /// self-role plugin's copy of this route paged over nothing anyone could act
    /// on. Keep all six honest.
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
