//! End-to-end flows against a fake Discord.
//!
//! The pure core is unit-tested where it lives. These drive the *real* router —
//! signed interactions in, REST calls out — against an in-process stand-in for
//! Discord's API that keeps just enough state (channels, overwrites, messages,
//! deferred-reply edits) to answer like the real one. They pin what only the
//! glue can get wrong: a double-click opening one ticket, a channel deleted by
//! hand releasing its opener, a failed close putting the ticket back, a full
//! category falling back to the top level, stale buttons doing nothing.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use tokio::sync::OnceCell;

use crate::config::Config;
use crate::perms;
use crate::rest::Discord;
use crate::routes::AppState;
use crate::store::{Status, Store};

const GUILD: &str = "100000000000000001";
const CATEGORY: &str = "100000000000000002";
const LOG: &str = "100000000000000003";
const STAFF_ROLE: &str = "100000000000000004";
const BILLING_ROLE: &str = "100000000000000005";
const BILLING_CATEGORY: &str = "100000000000000006";
const BOT: &str = "100000000000000900";
const OPENER: &str = "200000000000000001";
const STAFF: &str = "200000000000000002";
const STAFF_2: &str = "200000000000000003";
const MEMBER: &str = "200000000000000004";
const GUEST: &str = "200000000000000005";

// ── the fake Discord ─────────────────────────────────────────────────────────

#[derive(Default)]
struct World {
    next_id: u64,
    channels: HashMap<String, FakeChannel>,
    /// Every `PATCH @original`, by interaction token.
    originals: HashMap<String, Vec<Value>>,
    // Behaviour knobs.
    /// Creating a channel under this category answers "category full".
    full_category: Option<String>,
    /// Creating a channel under this category answers Missing Permissions.
    closed_category: Option<String>,
    /// Bits the bot doesn't hold server-wide: any overwrite naming one is
    /// refused, as Discord does.
    missing_bits: u64,
    /// Channel deletes are refused.
    refuse_delete: bool,
    /// How long a channel create takes.
    create_delay: Duration,
    /// Whether the app has the Message Content intent.
    message_content: bool,
    /// A message POST whose content contains this answers 500 — a Discord
    /// blip on exactly one step of a flow.
    fail_posts_containing: Option<String>,
    /// `/users/@me` answers 500.
    me_fails: bool,
    /// The first `PATCH @original` for each interaction token answers
    /// Unknown Message — the edit arriving before its own deferred reply.
    original_arrives_late: bool,
}

#[derive(Default, Clone)]
struct FakeChannel {
    name: String,
    /// Discord's channel type: 0 text (the default), 4 category.
    kind: u8,
    parent: Option<String>,
    overwrites: Vec<Value>,
    messages: Vec<FakeMessage>,
    deleted: bool,
}

#[derive(Default, Clone)]
struct FakeMessage {
    id: String,
    author: String,
    bot: bool,
    body: Value,
    /// A multipart upload's raw body (the transcript file lives in it).
    upload: Option<String>,
    edits: Vec<Value>,
}

type Shared = Arc<Mutex<World>>;

impl World {
    fn id(&mut self) -> String {
        self.next_id += 1;
        format!("{}", 700_000_000_000_000_000u64 + self.next_id)
    }

    fn live(&self) -> Vec<(&String, &FakeChannel)> {
        let mut v: Vec<_> = self
            .channels
            .iter()
            .filter(|(_, c)| !c.deleted && !c.name.starts_with("dm-"))
            .collect();
        v.sort_by_key(|(id, _)| (*id).clone());
        v
    }

    fn channel(&self, id: &str) -> &FakeChannel {
        self.channels.get(id).expect("no such channel")
    }

    fn overwrite(&self, channel: &str, target: &str) -> Option<(u64, u64)> {
        self.channel(channel)
            .overwrites
            .iter()
            .find(|o| o["id"] == target)
            .map(|o| (bits(&o["allow"]), bits(&o["deny"])))
    }

    /// An overwrite in full — its type too: a role's overwrite swapped for a
    /// member's with the same bits is a different, broken thing.
    fn overwrite_full(&self, channel: &str, target: &str) -> Option<(u64, u64, u64)> {
        self.channel(channel)
            .overwrites
            .iter()
            .find(|o| o["id"] == target)
            .map(|o| {
                (
                    o["type"].as_u64().unwrap_or(99),
                    bits(&o["allow"]),
                    bits(&o["deny"]),
                )
            })
    }
}

fn bits(v: &Value) -> u64 {
    v.as_str().and_then(|s| s.parse().ok()).unwrap_or(0)
}

fn discord_error(status: u16, body: Value) -> Response {
    (StatusCode::from_u16(status).unwrap(), Json(body)).into_response()
}

fn unknown_channel() -> Response {
    discord_error(404, json!({ "message": "Unknown Channel", "code": 10003 }))
}

fn missing_permissions() -> Response {
    discord_error(
        403,
        json!({ "message": "Missing Permissions", "code": 50013 }),
    )
}

async fn fake_discord(
    State(world): State<Shared>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let segs: Vec<String> = uri
        .path()
        .split('/')
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
    let segs: Vec<&str> = segs.iter().map(String::as_str).collect();
    let json_body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);

    if let ("POST", ["guilds", _, "channels"]) = (method.as_str(), segs.as_slice()) {
        let delay = world.lock().unwrap().create_delay;
        tokio::time::sleep(delay).await;
    }

    let mut w = world.lock().unwrap();
    match (method.as_str(), segs.as_slice()) {
        ("GET", ["users", "@me"]) => {
            if w.me_fails {
                return discord_error(500, json!({ "message": "Internal Server Error" }));
            }
            Json(json!({ "id": BOT, "username": "DWEEB" })).into_response()
        }
        ("GET", ["guilds", _, "channels"]) => {
            let list: Vec<Value> = w
                .channels
                .iter()
                .filter(|(_, c)| !c.deleted && !c.name.starts_with("dm-"))
                .map(|(id, c)| {
                    json!({ "id": id, "name": c.name, "type": c.kind, "position": 0,
                            "parent_id": c.parent, "permission_overwrites": c.overwrites })
                })
                .collect();
            Json(Value::Array(list)).into_response()
        }
        ("GET", ["applications", "@me"]) => {
            let flags = if w.message_content { 1u64 << 19 } else { 0 };
            Json(json!({ "id": "app", "flags": flags })).into_response()
        }
        ("POST", ["guilds", _, "channels"]) => {
            let parent = json_body["parent_id"].as_str().map(String::from);
            if parent.is_some() && parent == w.full_category {
                return discord_error(
                    400,
                    json!({ "code": 50035, "message": "Invalid Form Body", "errors": { "parent_id": { "_errors": [{ "code": "CHANNEL_PARENT_MAX_CHANNELS", "message": "Maximum number of channels in category reached (50)" }] } } }),
                );
            }
            if parent.is_some() && parent == w.closed_category {
                return missing_permissions();
            }
            let overwrites = json_body["permission_overwrites"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if overwrites
                .iter()
                .any(|o| (bits(&o["allow"]) | bits(&o["deny"])) & w.missing_bits != 0)
            {
                return missing_permissions();
            }
            let id = w.id();
            w.channels.insert(
                id.clone(),
                FakeChannel {
                    name: json_body["name"].as_str().unwrap_or_default().to_string(),
                    parent,
                    overwrites,
                    ..Default::default()
                },
            );
            Json(json!({ "id": id })).into_response()
        }
        ("GET", ["channels", id]) => match w.channels.get(*id) {
            Some(c) if !c.deleted => {
                Json(json!({ "id": id, "name": c.name, "permission_overwrites": c.overwrites }))
                    .into_response()
            }
            _ => unknown_channel(),
        },
        ("PATCH", ["channels", id]) => match w.channels.get_mut(*id) {
            Some(c) if !c.deleted => {
                if let Some(name) = json_body["name"].as_str() {
                    c.name = name.to_string();
                }
                Json(json!({ "id": id })).into_response()
            }
            _ => unknown_channel(),
        },
        ("DELETE", ["channels", id]) => {
            if w.refuse_delete {
                return missing_permissions();
            }
            match w.channels.get_mut(*id) {
                Some(c) if !c.deleted => {
                    c.deleted = true;
                    Json(json!({ "id": id })).into_response()
                }
                _ => unknown_channel(),
            }
        }
        ("PUT", ["channels", id, "permissions", target]) => {
            if (bits(&json_body["allow"]) | bits(&json_body["deny"])) & w.missing_bits != 0 {
                return missing_permissions();
            }
            match w.channels.get_mut(*id) {
                Some(c) if !c.deleted => {
                    c.overwrites.retain(|o| o["id"] != *target);
                    c.overwrites.push(json!({
                        "id": target, "type": json_body["type"], "allow": json_body["allow"], "deny": json_body["deny"],
                    }));
                    StatusCode::NO_CONTENT.into_response()
                }
                _ => unknown_channel(),
            }
        }
        ("DELETE", ["channels", id, "permissions", target]) => match w.channels.get_mut(*id) {
            Some(c) if !c.deleted => {
                let before = c.overwrites.len();
                c.overwrites.retain(|o| o["id"] != *target);
                if c.overwrites.len() == before {
                    discord_error(
                        404,
                        json!({ "message": "Unknown Overwrite", "code": 10009 }),
                    )
                } else {
                    StatusCode::NO_CONTENT.into_response()
                }
            }
            _ => unknown_channel(),
        },
        ("POST", ["channels", id, "messages"]) => {
            let content = json_body["content"].as_str().unwrap_or_default();
            if let Some(needle) = &w.fail_posts_containing {
                if content.contains(needle.as_str()) {
                    return discord_error(500, json!({ "message": "Internal Server Error" }));
                }
            }
            let mid = w.id();
            let multipart = headers
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.starts_with("multipart/"));
            match w.channels.get_mut(*id) {
                Some(c) if !c.deleted => {
                    c.messages.push(FakeMessage {
                        id: mid.clone(),
                        author: BOT.into(),
                        bot: true,
                        body: json_body,
                        upload: multipart.then(|| String::from_utf8_lossy(&body).into_owned()),
                        edits: vec![],
                    });
                    Json(json!({ "id": mid })).into_response()
                }
                _ => unknown_channel(),
            }
        }
        ("GET", ["channels", id, "messages"]) => match w.channels.get(*id) {
            Some(c) if !c.deleted => {
                let list: Vec<Value> = c
                    .messages
                    .iter()
                    .rev()
                    .map(|m| {
                        json!({
                            "id": m.id, "type": 0,
                            "content": m.body["content"].as_str().unwrap_or_default(),
                            "timestamp": "2026-06-15T12:00:00+00:00",
                            "author": { "id": m.author, "username": format!("user-{}", m.author), "bot": m.bot },
                        })
                    })
                    .collect();
                Json(Value::Array(list)).into_response()
            }
            _ => unknown_channel(),
        },
        ("PATCH", ["channels", id, "messages", mid]) => match w.channels.get_mut(*id) {
            Some(c) if !c.deleted => match c.messages.iter_mut().find(|m| m.id == *mid) {
                Some(m) => {
                    m.edits.push(json_body);
                    Json(json!({ "id": mid })).into_response()
                }
                None => discord_error(404, json!({ "message": "Unknown Message", "code": 10008 })),
            },
            _ => unknown_channel(),
        },
        ("POST", ["users", "@me", "channels"]) => {
            let recipient = json_body["recipient_id"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let id = format!("dm-{recipient}");
            w.channels.entry(id.clone()).or_insert_with(|| FakeChannel {
                name: id.clone(),
                ..Default::default()
            });
            Json(json!({ "id": id })).into_response()
        }
        ("PATCH", ["webhooks", _, token, "messages", "@original"]) => {
            if w.original_arrives_late && !w.originals.contains_key(*token) {
                // Remember the token so the retry lands, as the real ack would.
                w.originals.insert(token.to_string(), Vec::new());
                return discord_error(404, json!({ "message": "Unknown Message", "code": 10008 }));
            }
            w.originals
                .entry(token.to_string())
                .or_default()
                .push(json_body);
            Json(json!({ "id": "orig" })).into_response()
        }
        _ => discord_error(
            404,
            json!({ "message": format!("unhandled {method} {}", uri.path()) }),
        ),
    }
}

// ── the harness ──────────────────────────────────────────────────────────────

#[derive(Clone)]
struct Who {
    id: &'static str,
    roles: Vec<&'static str>,
    perms: u64,
}

fn opener() -> Who {
    Who {
        id: OPENER,
        roles: vec![],
        perms: 0,
    }
}
fn staff() -> Who {
    Who {
        id: STAFF,
        roles: vec![STAFF_ROLE],
        perms: 0,
    }
}
fn staff_2() -> Who {
    Who {
        id: STAFF_2,
        roles: vec![STAFF_ROLE],
        perms: 0,
    }
}
fn member() -> Who {
    Who {
        id: MEMBER,
        roles: vec![],
        perms: 0,
    }
}
fn admin() -> Who {
    Who {
        id: "200000000000000009",
        roles: vec![],
        perms: perms::ADMINISTRATOR,
    }
}

struct Harness {
    world: Shared,
    plugin: String,
    key: SigningKey,
    http: reqwest::Client,
    state: AppState,
    tokens: AtomicUsize,
}

/// The last interaction's token, to find its deferred-reply edits.
struct Sent {
    token: String,
    body: Value,
}

impl Harness {
    async fn start() -> Harness {
        Self::with_grace(Duration::ZERO).await
    }

    async fn with_grace(grace: Duration) -> Harness {
        let world: Shared = Arc::new(Mutex::new(World::default()));
        let fake = Router::new()
            .fallback(fake_discord)
            .with_state(world.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let discord_base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, fake).await.unwrap() });

        let key = SigningKey::from_bytes(&[7u8; 32]);
        let config = Config {
            port: 0,
            public_base_url: "http://localhost".into(),
            discord_public_key: hex::encode(key.verifying_key().to_bytes()),
            dispatcher_forward_secret: None,
            database_path: ":memory:".into(),
            default_bot_token: Some("bot-token".into()),
            bot_invite_url: None,
        };
        let state = AppState {
            store: Arc::new(Store::open(":memory:").unwrap()),
            discord: Discord::new(reqwest::Client::new(), &discord_base, Some("bot-token")),
            config: Arc::new(config),
            primary_key: key.verifying_key(),
            bot: Arc::new(OnceCell::new()),
            message_content: Arc::new(crate::routes::IntentCache::default()),
            seen_channels: Arc::new(Mutex::new(HashMap::new())),
            delete_grace: grace,
            tasks: crate::tasks::Tasks::default(),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let plugin = format!("http://{}", listener.local_addr().unwrap());
        let app = crate::app(state.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        Harness {
            world,
            plugin,
            key,
            http: reqwest::Client::new(),
            state,
            tokens: AtomicUsize::new(0),
        }
    }

    fn world(&self) -> std::sync::MutexGuard<'_, World> {
        self.world.lock().unwrap()
    }

    /// Save a panel through the real config API; returns its id.
    async fn panel(&self, overrides: Value) -> String {
        let mut cfg = json!({
            "target": "button",
            "guild_id": GUILD,
            "guild_name": "Test Server",
            "staff_roles": [{ "id": STAFF_ROLE, "name": "Support", "color": 0 }],
            "category_id": CATEGORY,
            "log_channel_id": LOG,
            "welcome": "Hi {user}, {staff} will help.",
            "close_confirmation": false,
            "transcripts": true,
            "max_open_per_user": 1,
            "cooldown_secs": 0,
        });
        for (k, v) in overrides.as_object().unwrap() {
            cfg[k] = v.clone();
        }
        // The server's own channels: saving checks the panel names only
        // these, and the log channel receives posts.
        {
            let mut w = self.world();
            for (id, name, kind) in [
                (LOG, "logs", 0),
                (CATEGORY, "Tickets", 4),
                (BILLING_CATEGORY, "Billing", 4),
            ] {
                w.channels.entry(id.into()).or_insert_with(|| FakeChannel {
                    name: name.into(),
                    kind,
                    ..Default::default()
                });
            }
        }
        let resp = self
            .http
            .post(format!("{}/api/instances", self.plugin))
            .json(&cfg)
            .send()
            .await
            .unwrap();
        let status = resp.status();
        let body: Value = resp.json().await.unwrap();
        assert_eq!(status, 201, "panel rejected: {body}");
        body["id"].as_str().unwrap().to_string()
    }

    fn interaction(
        &self,
        kind: u8,
        channel: &str,
        who: &Who,
        data: Value,
        message: Option<Value>,
    ) -> (String, Value) {
        let n = self.tokens.fetch_add(1, Ordering::SeqCst);
        let token = format!("tok{n}");
        let mut ix = json!({
            "type": kind,
            "application_id": "app",
            "token": token,
            "guild_id": GUILD,
            "channel_id": channel,
            "member": {
                "user": { "id": who.id, "username": format!("user{}", &who.id[who.id.len() - 2..]) },
                "roles": who.roles,
                "permissions": who.perms.to_string(),
            },
            "data": data,
        });
        if let Some(m) = message {
            ix["message"] = m;
        }
        (token, ix)
    }

    async fn send(&self, ix: (String, Value)) -> Sent {
        let (token, ix) = ix;
        let raw = serde_json::to_string(&ix).unwrap();
        let timestamp = "1700000000";
        let mut signed = timestamp.as_bytes().to_vec();
        signed.extend_from_slice(raw.as_bytes());
        let signature = hex::encode(self.key.sign(&signed).to_bytes());
        let resp = self
            .http
            .post(format!("{}/interactions", self.plugin))
            .header("content-type", "application/json")
            .header("x-signature-ed25519", signature)
            .header("x-signature-timestamp", timestamp)
            .body(raw)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        Sent {
            token,
            body: resp.json().await.unwrap(),
        }
    }

    async fn click(&self, custom_id: &str, channel: &str, who: &Who) -> Sent {
        self.click_on(custom_id, channel, who, None).await
    }

    async fn click_on(
        &self,
        custom_id: &str,
        channel: &str,
        who: &Who,
        message: Option<Value>,
    ) -> Sent {
        let ix = self.interaction(
            3,
            channel,
            who,
            json!({ "custom_id": custom_id, "component_type": 2 }),
            message,
        );
        self.send(ix).await
    }

    /// A select pick, with the `resolved.users` Discord attaches to a user
    /// select (harmless on a string select, which never reads it).
    async fn pick(&self, custom_id: &str, channel: &str, who: &Who, values: &[&str]) -> Sent {
        self.pick_resolved(custom_id, channel, who, values, values)
            .await
    }

    /// A pick whose `resolved.users` the test chooses — to play a client that
    /// sends values Discord wouldn't resolve as users.
    async fn pick_resolved(
        &self,
        custom_id: &str,
        channel: &str,
        who: &Who,
        values: &[&str],
        resolved: &[&str],
    ) -> Sent {
        let users: serde_json::Map<String, Value> = resolved
            .iter()
            .map(|id| (id.to_string(), json!({ "id": id, "username": "someone" })))
            .collect();
        let ix = self.interaction(
            3,
            channel,
            who,
            json!({ "custom_id": custom_id, "values": values, "resolved": { "users": users } }),
            None,
        );
        self.send(ix).await
    }

    async fn submit(
        &self,
        custom_id: &str,
        channel: &str,
        who: &Who,
        fields: &[(&str, &str)],
        message: Option<Value>,
    ) -> Sent {
        let rows: Vec<Value> = fields
            .iter()
            .map(|(id, v)| json!({ "type": 1, "components": [{ "type": 4, "custom_id": id, "value": v }] }))
            .collect();
        let ix = self.interaction(
            5,
            channel,
            who,
            json!({ "custom_id": custom_id, "components": rows }),
            message,
        );
        self.send(ix).await
    }

    /// Wait for the deferred work behind `sent` to edit its reply; returns
    /// the latest edit's content. (Flows that edit twice — a delete-mode close
    /// says "Closing…" first — are waited on through the store instead.)
    async fn outcome(&self, sent: &Sent) -> String {
        let token = sent.token.clone();
        self.eventually(move |w| {
            w.originals
                .get(&token)
                .and_then(|edits| edits.last())
                .and_then(|e| e["content"].as_str())
                .map(String::from)
        })
        .await
    }

    /// Poll the fake world until `f` answers.
    async fn eventually<T>(&self, mut f: impl FnMut(&World) -> Option<T>) -> T {
        for _ in 0..250 {
            if let Some(v) = f(&self.world()) {
                return v;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("condition never held");
    }

    /// Poll the store until the ticket in `channel` reaches `status`.
    async fn status_becomes(&self, channel: &str, status: Status) {
        for _ in 0..250 {
            if self
                .state
                .store
                .get_ticket(channel)
                .unwrap()
                .is_some_and(|t| t.status == status)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!(
            "ticket {channel} never became {status:?} (is {:?})",
            self.state
                .store
                .get_ticket(channel)
                .unwrap()
                .map(|t| t.status)
        );
    }

    /// Open a ticket as `who` and wait for it; returns the channel id.
    async fn open(&self, panel: &str, who: &Who) -> String {
        let sent = self
            .click(&format!("tickets:open:{panel}"), "999", who)
            .await;
        assert_eq!(sent.body["type"], 5, "open wasn't deferred: {}", sent.body);
        let reply = self.outcome(&sent).await;
        let start = reply.find("<#").expect(&reply) + 2;
        let end = reply[start..].find('>').unwrap() + start;
        reply[start..end].to_string()
    }

    /// The text of an immediate ephemeral reply.
    fn text(sent: &Sent) -> String {
        sent.body["data"]["components"][0]["content"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    }

    /// The control message (welcome) in a ticket: its id and body.
    fn control_message(&self, channel: &str) -> (String, Value) {
        let w = self.world();
        let m = w
            .channel(channel)
            .messages
            .iter()
            .rev()
            .find(|m| {
                m.body["components"]
                    .as_array()
                    .is_some_and(|c| !c.is_empty())
            })
            .expect("no control message");
        (m.id.clone(), m.body.clone())
    }
}

fn message_ref(id: &str, body: &Value) -> Option<Value> {
    Some(json!({ "id": id, "content": body["content"] }))
}

// ── opening ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn opening_creates_a_private_channel_and_says_where() {
    let h = Harness::start().await;
    let panel = h.panel(json!({})).await;
    let channel = h.open(&panel, &opener()).await;

    let w = h.world();
    let c = w.channel(&channel);
    assert_eq!(c.name, "ticket-0001");
    assert_eq!(c.parent.as_deref(), Some(CATEGORY));
    // @everyone hidden; opener, staff and bot let in; the bot can manage it.
    let (_, everyone_deny) = w.overwrite(&channel, GUILD).unwrap();
    assert_ne!(everyone_deny & perms::VIEW_CHANNEL, 0);
    let (opener_allow, _) = w.overwrite(&channel, OPENER).unwrap();
    assert_ne!(opener_allow & perms::ATTACH_FILES, 0);
    assert!(w.overwrite(&channel, STAFF_ROLE).is_some());
    let (bot_allow, _) = w.overwrite(&channel, BOT).unwrap();
    assert_ne!(bot_allow & perms::MANAGE_CHANNELS, 0);

    // The welcome carries the controls and pings only the opener.
    let welcome = &c.messages[0].body;
    assert!(welcome["content"]
        .as_str()
        .unwrap()
        .contains(&format!("<@{OPENER}>")));
    assert_eq!(welcome["allowed_mentions"]["users"], json!([OPENER]));
    let ids: Vec<&str> = welcome["components"][0]["components"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["custom_id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        [
            format!("tickets:close:{panel}"),
            format!("tickets:claim:{panel}"),
            format!("tickets:members:{panel}")
        ]
    );
    // The log channel heard about it.
    let log = &w.channel(LOG).messages[0].body["content"];
    assert!(log.as_str().unwrap().contains(&format!("<#{channel}>")));
    drop(w);
    assert_eq!(
        h.state.store.get_ticket(&channel).unwrap().unwrap().status,
        Status::Open
    );
}

#[tokio::test]
async fn a_double_click_opens_one_ticket_even_without_limits() {
    let h = Harness::start().await;
    // No cap, no cooldown: only the in-flight guard stands between a
    // double-click and two tickets.
    let panel = h.panel(json!({ "max_open_per_user": 0 })).await;
    h.world().create_delay = Duration::from_millis(400);
    let first = h
        .click(&format!("tickets:open:{panel}"), "999", &opener())
        .await;
    let second = h
        .click(&format!("tickets:open:{panel}"), "999", &opener())
        .await;
    assert_eq!(first.body["type"], 5);
    assert!(
        Harness::text(&second).contains("already being created"),
        "{}",
        second.body
    );
    h.outcome(&first).await;
    let tickets = h
        .world()
        .live()
        .iter()
        .filter(|(_, c)| c.name.starts_with("ticket-"))
        .count();
    assert_eq!(tickets, 1);
}

#[tokio::test]
async fn at_the_limit_the_member_is_pointed_at_their_ticket() {
    let h = Harness::start().await;
    let panel = h.panel(json!({})).await;
    let channel = h.open(&panel, &opener()).await;
    let again = h
        .click(&format!("tickets:open:{panel}"), "999", &opener())
        .await;
    let text = Harness::text(&again);
    assert!(text.contains(&format!("<#{channel}>")), "{text}");
    // Someone else is unaffected.
    h.open(&panel, &member()).await;
}

#[tokio::test]
async fn a_ticket_deleted_by_hand_releases_its_opener() {
    let h = Harness::start().await;
    let panel = h.panel(json!({})).await;
    let channel = h.open(&panel, &opener()).await;
    // A moderator deletes the channel in Discord; the plugin never hears.
    h.world().channels.get_mut(&channel).unwrap().deleted = true;
    // The next open notices, releases the stale slot, and goes ahead.
    let second = h.open(&panel, &opener()).await;
    assert_ne!(second, channel);
    assert_eq!(
        h.state.store.get_ticket(&channel).unwrap().unwrap().status,
        Status::Closed
    );
}

#[tokio::test]
async fn locked_tickets_do_not_count_against_the_limit() {
    let h = Harness::start().await;
    let panel = h.panel(json!({ "close_mode": "lock" })).await;
    let channel = h.open(&panel, &opener()).await;
    let close = h
        .click(&format!("tickets:close:{panel}"), &channel, &opener())
        .await;
    h.outcome(&close).await;
    h.status_becomes(&channel, Status::Locked).await;
    // Closed from their side — they may open a new one.
    h.open(&panel, &opener()).await;
}

#[tokio::test]
async fn intake_answers_follow_the_welcome_in_full() {
    let h = Harness::start().await;
    let panel = h
        .panel(json!({ "intake": [
            { "id": "q1", "label": "What happened?", "style": "paragraph", "required": true },
            { "id": "q2", "label": "Order id", "style": "short" },
        ] }))
        .await;
    let modal = h
        .click(&format!("tickets:open:{panel}"), "999", &opener())
        .await;
    assert_eq!(modal.body["type"], 9);
    let input = &modal.body["data"]["components"][0]["components"][0];
    assert_eq!(input["max_length"], 1024);
    let long = "x".repeat(1024);
    let sent = h
        .submit(
            &format!("tickets:intake:{panel}"),
            "999",
            &opener(),
            &[("q1", &long), ("q2", "A-17")],
            None,
        )
        .await;
    assert_eq!(sent.body["type"], 5);
    let reply = h.outcome(&sent).await;
    let channel = reply[reply.find("<#").unwrap() + 2..reply.find('>').unwrap()].to_string();
    let w = h.world();
    let texts: String = w
        .channel(&channel)
        .messages
        .iter()
        .skip(1)
        .map(|m| m.body["content"].as_str().unwrap().to_string())
        .collect();
    assert!(texts.contains(&long), "the long answer was cut");
    assert!(texts.contains("**Order id**") && texts.contains("A-17"));
}

#[tokio::test]
async fn a_topic_routes_its_ticket_and_its_staff() {
    let h = Harness::start().await;
    let panel = h
        .panel(json!({
            "target": "string_select",
            "topics": [
                { "id": "billing", "label": "Billing", "category_id": BILLING_CATEGORY,
                  "staff_roles": [{ "id": BILLING_ROLE, "name": "Billing team" }] },
                { "id": "other", "label": "Other" },
            ],
        }))
        .await;
    // A crafted value is refused.
    let bogus = h
        .pick(
            &format!("tickets:open:{panel}"),
            "999",
            &opener(),
            &["evil"],
        )
        .await;
    assert!(Harness::text(&bogus).contains("Pick a topic"));

    let sent = h
        .pick(
            &format!("tickets:open:{panel}"),
            "999",
            &opener(),
            &["billing"],
        )
        .await;
    let reply = h.outcome(&sent).await;
    let channel = reply[reply.find("<#").unwrap() + 2..reply.find('>').unwrap()].to_string();
    {
        let w = h.world();
        assert_eq!(
            w.channel(&channel).parent.as_deref(),
            Some(BILLING_CATEGORY)
        );
        assert!(w.overwrite(&channel, BILLING_ROLE).is_some());
        assert!(w.overwrite(&channel, STAFF_ROLE).is_some());
    }
    // The topic's staff are staff inside its tickets.
    let billing = Who {
        id: GUEST,
        roles: vec![BILLING_ROLE],
        perms: 0,
    };
    let (mid, body) = h.control_message(&channel);
    let claim = h
        .click_on(
            &format!("tickets:claim:{panel}"),
            &channel,
            &billing,
            message_ref(&mid, &body),
        )
        .await;
    assert_eq!(claim.body["type"], 7, "{}", claim.body);
}

// ── degrading instead of failing ─────────────────────────────────────────────

#[tokio::test]
async fn a_full_category_falls_back_to_the_top_level_and_says_so() {
    let h = Harness::start().await;
    let panel = h.panel(json!({})).await;
    h.world().full_category = Some(CATEGORY.into());
    let channel = h.open(&panel, &opener()).await;
    let w = h.world();
    assert_eq!(w.channel(&channel).parent, None);
    let log = w.channel(LOG).messages[0].body["content"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(log.contains("top of the server"), "{log}");
}

#[tokio::test]
async fn a_category_closed_to_the_bot_falls_back_too() {
    let h = Harness::start().await;
    let panel = h.panel(json!({})).await;
    h.world().closed_category = Some(CATEGORY.into());
    let channel = h.open(&panel, &opener()).await;
    let w = h.world();
    assert_eq!(w.channel(&channel).parent, None);
    let log = w.channel(LOG).messages[0].body["content"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(log.contains("isn't allowed to create channels"), "{log}");
}

#[tokio::test]
async fn a_bot_without_optional_permissions_still_opens_tickets() {
    let h = Harness::start().await;
    let panel = h.panel(json!({})).await;
    // The server stripped Attach Files etc. from @everyone, so the bot can't
    // grant them.
    h.world().missing_bits = perms::ATTACH_FILES | perms::EMBED_LINKS | perms::ADD_REACTIONS;
    let channel = h.open(&panel, &opener()).await;
    let w = h.world();
    assert_eq!(w.channel(&channel).parent.as_deref(), Some(CATEGORY));
    let (allow, _) = w.overwrite(&channel, OPENER).unwrap();
    assert_ne!(allow & perms::SEND_MESSAGES, 0);
    assert_eq!(allow & perms::ATTACH_FILES, 0);
}

#[tokio::test]
async fn a_bot_missing_required_permissions_explains_and_holds_no_slot() {
    let h = Harness::start().await;
    let panel = h.panel(json!({})).await;
    h.world().missing_bits = perms::SEND_MESSAGES;
    let sent = h
        .click(&format!("tickets:open:{panel}"), "999", &opener())
        .await;
    let reply = h.outcome(&sent).await;
    assert!(reply.contains("missing a permission"), "{reply}");
    // The failed open released its reservation: fixing the bot and clicking
    // again works at once.
    h.world().missing_bits = 0;
    h.open(&panel, &opener()).await;
}

// ── closing ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn closing_deletes_after_filing_the_transcript() {
    let h = Harness::start().await;
    let panel = h.panel(json!({})).await;
    let channel = h.open(&panel, &opener()).await;
    // A member's message, as Discord returns it to an app without the
    // Message Content intent: no text at all.
    h.world()
        .channels
        .get_mut(&channel)
        .unwrap()
        .messages
        .push(FakeMessage {
            id: "800000000000000001".into(),
            author: OPENER.into(),
            body: json!({ "content": "" }),
            ..Default::default()
        });

    let close = h
        .click(&format!("tickets:close:{panel}"), &channel, &opener())
        .await;
    assert_eq!(close.body["type"], 5);
    h.status_becomes(&channel, Status::Closed).await;

    let w = h.world();
    let c = w.channel(&channel);
    assert!(c.deleted);
    // Everyone in the channel was told first.
    assert!(c.messages.iter().any(|m| m.body["content"]
        .as_str()
        .unwrap_or("")
        .contains("will be deleted")));
    // The transcript was filed with the close line, and says honestly that
    // the member's words couldn't be read.
    let upload = w
        .channel(LOG)
        .messages
        .iter()
        .find_map(|m| m.upload.clone())
        .expect("no transcript uploaded");
    assert!(upload.contains("ticket-0001-transcript.html"));
    assert!(upload.contains("closed by"));
    assert!(upload.contains("Message Content"));
    assert!(upload.contains("text not available"));
}

#[tokio::test]
async fn a_failed_delete_puts_the_ticket_back_and_says_why() {
    let h = Harness::start().await;
    let panel = h.panel(json!({ "transcripts": false })).await;
    let channel = h.open(&panel, &opener()).await;
    h.world().refuse_delete = true;
    let close = h
        .click(&format!("tickets:close:{panel}"), &channel, &staff())
        .await;
    let token = close.token.clone();
    let reply = h
        .eventually(move |w| {
            w.originals
                .get(&token)?
                .iter()
                .filter_map(|e| e["content"].as_str())
                .find(|c| c.contains("Manage Channels"))
                .map(String::from)
        })
        .await;
    assert!(reply.contains("stays open"), "{reply}");
    h.status_becomes(&channel, Status::Open).await;
    // Nothing claims the ticket closed.
    assert!(
        h.world().channel(LOG).messages.len() == 1,
        "only the open line"
    );
    // And once fixed, it closes.
    h.world().refuse_delete = false;
    h.click(&format!("tickets:close:{panel}"), &channel, &staff())
        .await;
    h.status_becomes(&channel, Status::Closed).await;
}

#[tokio::test]
async fn two_closes_at_once_close_once() {
    let h = Harness::with_grace(Duration::from_millis(400)).await;
    let panel = h.panel(json!({})).await;
    let channel = h.open(&panel, &opener()).await;
    let first = h
        .click(&format!("tickets:close:{panel}"), &channel, &staff())
        .await;
    let second = h
        .click(&format!("tickets:close:{panel}"), &channel, &staff_2())
        .await;
    assert_eq!(first.body["type"], 5);
    assert!(
        Harness::text(&second).contains("already being closed"),
        "{}",
        second.body
    );
    h.status_becomes(&channel, Status::Closed).await;
    let uploads = h
        .world()
        .channel(LOG)
        .messages
        .iter()
        .filter(|m| m.upload.is_some())
        .count();
    assert_eq!(uploads, 1);
}

#[tokio::test]
async fn only_staff_or_the_allowed_opener_may_close() {
    let h = Harness::start().await;
    let panel = h.panel(json!({ "allow_opener_close": false })).await;
    let channel = h.open(&panel, &opener()).await;
    for who in [opener(), member()] {
        let r = h
            .click(&format!("tickets:close:{panel}"), &channel, &who)
            .await;
        assert!(Harness::text(&r).contains("Only staff"), "{}", r.body);
    }
    // A server manager is always staff.
    let r = h
        .click(&format!("tickets:close:{panel}"), &channel, &admin())
        .await;
    assert_eq!(r.body["type"], 5);
}

#[tokio::test]
async fn the_close_reason_modal_carries_the_reason_through() {
    let h = Harness::start().await;
    let panel = h
        .panel(json!({ "close_confirmation": true, "transcripts": false }))
        .await;
    let channel = h.open(&panel, &opener()).await;
    let modal = h
        .click(&format!("tickets:close:{panel}"), &channel, &opener())
        .await;
    assert_eq!(modal.body["type"], 9);
    h.submit(
        &format!("tickets:doclose:{panel}"),
        &channel,
        &opener(),
        &[("reason", "all sorted")],
        None,
    )
    .await;
    h.status_becomes(&channel, Status::Closed).await;
    let log = h.world().channel(LOG).messages[1].body["content"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        log.contains("all sorted") && log.contains("closed by"),
        "{log}"
    );
}

// ── lock mode ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn lock_reopen_and_delete_move_through_the_states() {
    let h = Harness::start().await;
    let panel = h
        .panel(json!({ "close_mode": "lock", "transcripts": false }))
        .await;
    let channel = h.open(&panel, &opener()).await;
    let (welcome_id, welcome) = h.control_message(&channel);

    // Close → locked: the opener can read but not post, the old controls are
    // retired, the channel is renamed.
    let close = h
        .click_on(
            &format!("tickets:close:{panel}"),
            &channel,
            &staff(),
            message_ref(&welcome_id, &welcome),
        )
        .await;
    h.outcome(&close).await;
    h.status_becomes(&channel, Status::Locked).await;
    let locked_id = {
        let w = h.world();
        let (allow, deny) = w.overwrite(&channel, OPENER).unwrap();
        assert_ne!(allow & perms::VIEW_CHANNEL, 0);
        assert_ne!(deny & perms::SEND_MESSAGES, 0);
        let c = w.channel(&channel);
        assert_eq!(c.name, "closed-0001");
        let welcome = c.messages.iter().find(|m| m.id == welcome_id).unwrap();
        assert_eq!(welcome.edits.last().unwrap()["components"], json!([]));
        c.messages.last().unwrap().id.clone()
    };
    // A stale Close on the old welcome does nothing now.
    let stale = h
        .click(&format!("tickets:close:{panel}"), &channel, &opener())
        .await;
    assert!(Harness::text(&stale).contains("closed"), "{}", stale.body);
    // Members can't reopen.
    let denied = h
        .click(&format!("tickets:reopen:{panel}"), &channel, &opener())
        .await;
    assert!(Harness::text(&denied).contains("Only staff"));

    // Reopen → open: access restored, the locked banner's buttons retired,
    // fresh controls posted, the name restored.
    let locked_body = h
        .world()
        .channel(&channel)
        .messages
        .last()
        .unwrap()
        .body
        .clone();
    let reopen = h
        .click_on(
            &format!("tickets:reopen:{panel}"),
            &channel,
            &staff(),
            message_ref(&locked_id, &locked_body),
        )
        .await;
    h.outcome(&reopen).await;
    h.status_becomes(&channel, Status::Open).await;
    {
        let w = h.world();
        let (allow, deny) = w.overwrite(&channel, OPENER).unwrap();
        assert_ne!(allow & perms::SEND_MESSAGES, 0);
        assert_eq!(deny & perms::SEND_MESSAGES, 0);
        let c = w.channel(&channel);
        assert_eq!(c.name, "ticket-0001");
        let banner = c.messages.iter().find(|m| m.id == locked_id).unwrap();
        assert_eq!(banner.edits.last().unwrap()["components"], json!([]));
    }
    // The stale Reopen and a Delete on an open ticket both do nothing.
    let again = h
        .click(&format!("tickets:reopen:{panel}"), &channel, &staff())
        .await;
    assert!(Harness::text(&again).contains("already open"));
    let early = h
        .click(&format!("tickets:delete:{panel}"), &channel, &staff())
        .await;
    assert!(Harness::text(&early).contains("close it before deleting"));

    // Close again, then delete for good.
    let close = h
        .click(&format!("tickets:close:{panel}"), &channel, &staff())
        .await;
    h.outcome(&close).await;
    h.status_becomes(&channel, Status::Locked).await;
    h.click(&format!("tickets:delete:{panel}"), &channel, &staff())
        .await;
    h.status_becomes(&channel, Status::Closed).await;
    assert!(h.world().channel(&channel).deleted);
}

// ── staff tools ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn claims_are_exclusive_and_releasable() {
    let h = Harness::start().await;
    let panel = h.panel(json!({})).await;
    let channel = h.open(&panel, &opener()).await;
    let (mid, body) = h.control_message(&channel);
    let msg = || message_ref(&mid, &body);

    let not_staff = h
        .click_on(
            &format!("tickets:claim:{panel}"),
            &channel,
            &opener(),
            msg(),
        )
        .await;
    assert!(Harness::text(&not_staff).contains("Only staff"));

    let claimed = h
        .click_on(&format!("tickets:claim:{panel}"), &channel, &staff(), msg())
        .await;
    assert_eq!(claimed.body["type"], 7);
    assert!(claimed.body["data"]["content"]
        .as_str()
        .unwrap()
        .contains(&format!("Claimed by <@{STAFF}>")));

    let taken = h
        .click_on(
            &format!("tickets:claim:{panel}"),
            &channel,
            &staff_2(),
            msg(),
        )
        .await;
    assert!(Harness::text(&taken).contains("already claimed"));
    let not_theirs = h
        .click_on(
            &format!("tickets:unclaim:{panel}"),
            &channel,
            &staff_2(),
            msg(),
        )
        .await;
    assert!(Harness::text(&not_theirs).contains("only they or a server manager"));

    let released = h
        .click_on(
            &format!("tickets:unclaim:{panel}"),
            &channel,
            &staff(),
            msg(),
        )
        .await;
    assert_eq!(released.body["type"], 7);
    assert!(!released.body["data"]["content"]
        .as_str()
        .unwrap()
        .contains("Claimed by"));
    assert_eq!(
        h.state
            .store
            .get_ticket(&channel)
            .unwrap()
            .unwrap()
            .claimed_by,
        None
    );
}

#[tokio::test]
async fn staff_add_and_remove_people() {
    let h = Harness::start().await;
    let panel = h.panel(json!({})).await;
    let channel = h.open(&panel, &opener()).await;

    let denied = h
        .click(&format!("tickets:members:{panel}"), &channel, &member())
        .await;
    assert!(Harness::text(&denied).contains("Only staff"));
    let picker = h
        .click(&format!("tickets:members:{panel}"), &channel, &staff())
        .await;
    assert_eq!(picker.body["type"], 4);
    assert_eq!(picker.body["data"]["flags"], 64);

    // Add a guest: they get access and a ping.
    let add = h
        .pick(
            &format!("tickets:addmember:{panel}"),
            &channel,
            &staff(),
            &[GUEST],
        )
        .await;
    assert_eq!(add.body["type"], 6);
    let reply = h.outcome(&add).await;
    assert!(reply.contains(&format!("Added <@{GUEST}>")), "{reply}");
    {
        let w = h.world();
        let (allow, _) = w.overwrite(&channel, GUEST).unwrap();
        assert_ne!(allow & perms::SEND_MESSAGES, 0);
        let note = &w.channel(&channel).messages.last().unwrap().body;
        assert_eq!(note["allowed_mentions"]["users"], json!([GUEST]));
    }
    // The bot never adds or removes itself.
    let me = h
        .pick(
            &format!("tickets:addmember:{panel}"),
            &channel,
            &staff(),
            &[BOT],
        )
        .await;
    h.outcome(&me).await;
    let (bot_allow, _) = h.world().overwrite(&channel, BOT).unwrap();
    assert_ne!(bot_allow & perms::MANAGE_CHANNELS, 0);
}

#[tokio::test]
async fn removing_people_spares_the_opener() {
    let h = Harness::start().await;
    let panel = h
        .panel(json!({ "close_mode": "lock", "transcripts": false }))
        .await;
    let channel = h.open(&panel, &opener()).await;
    let add = h
        .pick(
            &format!("tickets:addmember:{panel}"),
            &channel,
            &staff(),
            &[GUEST],
        )
        .await;
    h.outcome(&add).await;

    // A lock mutes the added guest as well as the opener.
    let close = h
        .click(&format!("tickets:close:{panel}"), &channel, &staff())
        .await;
    h.outcome(&close).await;
    h.status_becomes(&channel, Status::Locked).await;
    {
        let w = h.world();
        let (_, deny) = w.overwrite(&channel, GUEST).unwrap();
        assert_ne!(deny & perms::SEND_MESSAGES, 0);
    }
    let reopen = h
        .click(&format!("tickets:reopen:{panel}"), &channel, &staff())
        .await;
    h.outcome(&reopen).await;
    h.status_becomes(&channel, Status::Open).await;

    let remove = h
        .pick(
            &format!("tickets:rmmember:{panel}"),
            &channel,
            &staff(),
            &[GUEST, OPENER],
        )
        .await;
    let reply = h.outcome(&remove).await;
    assert!(reply.contains(&format!("Removed <@{GUEST}>")), "{reply}");
    assert!(reply.contains("close it instead"), "{reply}");
    let w = h.world();
    assert!(w.overwrite(&channel, GUEST).is_none());
    assert!(w.overwrite(&channel, OPENER).is_some());
}

#[tokio::test]
async fn a_crafted_pick_can_never_touch_a_role_overwrite() {
    let h = Harness::start().await;
    let panel = h.panel(json!({})).await;
    let channel = h.open(&panel, &opener()).await;
    let everyone_before = h.world().overwrite_full(&channel, GUILD).unwrap();
    let staff_before = h.world().overwrite_full(&channel, STAFF_ROLE).unwrap();
    assert_eq!(everyone_before.0, 0, "@everyone's is a role overwrite");
    let untouched = |h: &Harness| {
        let w = h.world();
        assert_eq!(w.overwrite_full(&channel, GUILD), Some(everyone_before));
        assert_eq!(w.overwrite_full(&channel, STAFF_ROLE), Some(staff_before));
    };

    // Values Discord didn't resolve as users do nothing at all…
    let unresolved = h
        .pick_resolved(
            &format!("tickets:rmmember:{panel}"),
            &channel,
            &staff(),
            &[GUILD],
            &[],
        )
        .await;
    h.outcome(&unresolved).await;
    untouched(&h);
    // …and even if a role id rode in as a "user", a role's overwrite is never
    // deleted (which would expose the ticket, or lock staff out) or replaced
    // by a member's. Checked after each step: a delete followed by a re-add
    // could otherwise restore the same bits under the wrong type.
    for verb in ["rmmember", "addmember"] {
        let sent = h
            .pick_resolved(
                &format!("tickets:{verb}:{panel}"),
                &channel,
                &staff(),
                &[GUILD, STAFF_ROLE],
                &[GUILD, STAFF_ROLE],
            )
            .await;
        h.outcome(&sent).await;
        untouched(&h);
    }
}

#[tokio::test]
async fn the_overview_lists_live_tickets_for_staff_only() {
    let h = Harness::start().await;
    let panel = h.panel(json!({})).await;
    let kept = h.open(&panel, &opener()).await;
    let gone = h.open(&panel, &member()).await;
    h.world().channels.get_mut(&gone).unwrap().deleted = true;

    let denied = h
        .click(&format!("tickets:manage:{panel}"), "555", &member())
        .await;
    assert!(Harness::text(&denied).contains("Only this panel's staff"));
    let sent = h
        .click(&format!("tickets:manage:{panel}"), "555", &staff())
        .await;
    let text = h.outcome(&sent).await;
    assert!(text.contains(&format!("<#{kept}>")), "{text}");
    assert!(!text.contains(&format!("<#{gone}>")), "{text}");
    assert!(text.contains("1 open"), "{text}");
}

#[tokio::test]
async fn controls_from_another_panel_are_refused() {
    let h = Harness::start().await;
    let a = h.panel(json!({})).await;
    let b = h
        .panel(json!({ "staff_roles": [{ "id": BILLING_ROLE, "name": "Other staff" }] }))
        .await;
    let channel = h.open(&a, &opener()).await;
    // Panel B's staff crafting a Close for B inside A's ticket.
    let other_staff = Who {
        id: GUEST,
        roles: vec![BILLING_ROLE],
        perms: 0,
    };
    let r = h
        .click(&format!("tickets:close:{b}"), &channel, &other_staff)
        .await;
    assert!(
        Harness::text(&r).contains("don't belong to this ticket"),
        "{}",
        r.body
    );
    assert_eq!(
        h.state.store.get_ticket(&channel).unwrap().unwrap().status,
        Status::Open
    );
}

#[tokio::test]
async fn transcripts_can_be_sent_to_the_opener() {
    let h = Harness::start().await;
    let panel = h.panel(json!({ "transcript_dm": true })).await;
    h.world().message_content = true;
    let channel = h.open(&panel, &opener()).await;
    h.click(&format!("tickets:close:{panel}"), &channel, &staff())
        .await;
    h.status_becomes(&channel, Status::Closed).await;
    let dm = h
        .eventually(|w| {
            w.channels
                .get(&format!("dm-{OPENER}"))
                .and_then(|c| c.messages.first())
                .and_then(|m| m.upload.clone())
        })
        .await;
    assert!(dm.contains("Test Server") && dm.contains("ticket-0001-transcript.html"));
}

#[tokio::test]
async fn a_stale_intent_answer_never_mislabels_a_transcript() {
    let h = Harness::start().await;
    let panel = h.panel(json!({})).await;
    // The cache still says "no intent" (it was just granted)…
    h.state.message_content.set(false);
    let channel = h.open(&panel, &opener()).await;
    // …but Discord now returns what members type.
    h.world()
        .channels
        .get_mut(&channel)
        .unwrap()
        .messages
        .push(FakeMessage {
            id: "800000000000000002".into(),
            author: OPENER.into(),
            body: json!({ "content": "my order never arrived" }),
            ..Default::default()
        });
    h.click(&format!("tickets:close:{panel}"), &channel, &staff())
        .await;
    h.status_becomes(&channel, Status::Closed).await;
    let upload = h
        .eventually(|w| {
            w.channel(LOG)
                .messages
                .iter()
                .find_map(|m| m.upload.clone())
        })
        .await;
    assert!(upload.contains("my order never arrived"));
    assert!(
        !upload.contains("isn't in this transcript"),
        "the transcript claimed text was withheld while showing it"
    );
}

#[tokio::test]
async fn meta_learns_the_intent_and_relearns_it() {
    let h = Harness::start().await;
    let meta = || async {
        h.http
            .get(format!("{}/api/meta", h.plugin))
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap()
    };
    // Unknown at first; asking kicks off a refresh in the background.
    assert_eq!(meta().await["messageContent"], Value::Null);
    for _ in 0..100 {
        if h.state.message_content.get().is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(meta().await["messageContent"], false);
    // Granted later: a refresh picks it up without a restart.
    h.world().message_content = true;
    crate::routes::refresh_message_content(&h.state).await;
    assert_eq!(meta().await["messageContent"], true);
}

// ── what the adversarial review found ────────────────────────────────────────

impl Harness {
    /// A ticket that already exists — its channel in the fake Discord, its
    /// row in the store — without going through an open (so nothing has
    /// fetched the bot's identity yet, as after a restart).
    fn seed_ticket(&self, panel: &str, opener_id: &str) -> String {
        let channel = {
            let mut w = self.world();
            let id = w.id();
            let participant = perms::Grants::Full.participant().to_string();
            w.channels.insert(
                id.clone(),
                FakeChannel {
                    name: "ticket-0001".into(),
                    overwrites: vec![
                        json!({ "id": GUILD, "type": 0, "allow": "0", "deny": perms::VIEW_CHANNEL.to_string() }),
                        json!({ "id": opener_id, "type": 1, "allow": participant, "deny": "0" }),
                        json!({ "id": BOT, "type": 1, "allow": perms::Grants::Full.bot().to_string(), "deny": "0" }),
                    ],
                    ..Default::default()
                },
            );
            id
        };
        let req = crate::store::OpenRequest {
            instance_id: panel,
            guild_id: GUILD,
            opener_id,
            opener_name: "Ada",
            topic: "",
            topic_id: "",
            now_ms: crate::store::unix_millis(),
        };
        let crate::store::Reserve::Reserved { key, number } =
            self.state.store.reserve_open(&req, |_| None::<()>).unwrap()
        else {
            panic!("seed reservation refused")
        };
        let ticket = crate::store::Ticket {
            channel_id: channel.clone(),
            instance_id: panel.into(),
            guild_id: GUILD.into(),
            number,
            opener_id: opener_id.into(),
            opener_name: "Ada".into(),
            topic: String::new(),
            topic_id: String::new(),
            channel_name: "ticket-0001".into(),
            claimed_by: None,
            status: Status::Open,
            created_at: crate::store::unix_millis(),
            closed_at: None,
            closed_by: None,
        };
        self.state.store.activate(&key, &ticket).unwrap();
        channel
    }

    /// Wait for a deferred reply edit containing `needle`.
    async fn reply_containing(&self, sent: &Sent, needle: &str) -> String {
        let token = sent.token.clone();
        let needle = needle.to_string();
        self.eventually(move |w| {
            w.originals
                .get(&token)?
                .iter()
                .filter_map(|e| e["content"].as_str())
                .find(|c| c.contains(&needle))
                .map(String::from)
        })
        .await
    }
}

#[tokio::test]
async fn a_lock_whose_banner_cannot_post_is_undone() {
    let h = Harness::start().await;
    let panel = h
        .panel(json!({ "close_mode": "lock", "transcripts": false }))
        .await;
    let channel = h.open(&panel, &opener()).await;
    let (welcome_id, welcome) = h.control_message(&channel);
    h.world().fail_posts_containing = Some("Ticket closed by".into());

    let close = h
        .click_on(
            &format!("tickets:close:{panel}"),
            &channel,
            &staff(),
            message_ref(&welcome_id, &welcome),
        )
        .await;
    h.reply_containing(&close, "didn't close").await;
    h.status_becomes(&channel, Status::Open).await;
    let w = h.world();
    // The opener can post again, and the old Close is still there to retry.
    let (_, deny) = w.overwrite(&channel, OPENER).unwrap();
    assert_eq!(deny & perms::SEND_MESSAGES, 0);
    let welcome = w
        .channel(&channel)
        .messages
        .iter()
        .find(|m| m.id == welcome_id)
        .unwrap();
    assert!(
        welcome.edits.is_empty(),
        "the working controls were retired"
    );
}

#[tokio::test]
async fn a_reopen_whose_controls_cannot_post_stays_locked() {
    let h = Harness::start().await;
    let panel = h
        .panel(json!({ "close_mode": "lock", "transcripts": false }))
        .await;
    let channel = h.open(&panel, &opener()).await;
    let close = h
        .click(&format!("tickets:close:{panel}"), &channel, &staff())
        .await;
    h.outcome(&close).await;
    h.status_becomes(&channel, Status::Locked).await;
    let (banner_id, banner) = h.control_message(&channel);
    h.world().fail_posts_containing = Some("Reopened by".into());

    let reopen = h
        .click_on(
            &format!("tickets:reopen:{panel}"),
            &channel,
            &staff(),
            message_ref(&banner_id, &banner),
        )
        .await;
    h.reply_containing(&reopen, "didn't reopen").await;
    h.status_becomes(&channel, Status::Locked).await;
    let w = h.world();
    // Still read-only for the opener, and Reopen is still on the banner.
    let (_, deny) = w.overwrite(&channel, OPENER).unwrap();
    assert_ne!(deny & perms::SEND_MESSAGES, 0);
    let banner = w
        .channel(&channel)
        .messages
        .iter()
        .find(|m| m.id == banner_id)
        .unwrap();
    assert!(
        banner.edits.is_empty(),
        "the locked banner's Reopen was retired"
    );
}

#[tokio::test]
async fn the_bot_is_never_muted_when_its_identity_is_unknown() {
    let h = Harness::start().await;
    let panel = h
        .panel(json!({ "close_mode": "lock", "transcripts": false }))
        .await;
    let channel = h.seed_ticket(&panel, OPENER);
    h.world().me_fails = true;
    let bot_before = h.world().overwrite_full(&channel, BOT).unwrap();

    let close = h
        .click(&format!("tickets:close:{panel}"), &channel, &staff())
        .await;
    h.reply_containing(&close, "busy").await;
    h.status_becomes(&channel, Status::Open).await;
    assert_eq!(h.world().overwrite_full(&channel, BOT), Some(bot_before));
}

#[tokio::test]
async fn a_panel_cannot_log_into_another_server() {
    let h = Harness::start().await;
    h.panel(json!({})).await; // seeds this server's channels
    let hr = &h;
    let save = move |cfg: Value| async move {
        let resp = hr
            .http
            .post(format!("{}/api/instances", hr.plugin))
            .json(&cfg)
            .send()
            .await
            .unwrap();
        (resp.status().as_u16(), resp.json::<Value>().await.unwrap())
    };
    let base =
        json!({ "target": "button", "guild_id": GUILD, "welcome": "Hi", "transcripts": true });

    // A channel the bot can reach in *another* server: refused.
    let mut foreign = base.clone();
    foreign["log_channel_id"] = json!("999999999999999999");
    let (status, body) = save(foreign).await;
    assert_eq!(status, 400, "{body}");
    assert!(body["error"]
        .as_str()
        .unwrap()
        .contains("isn't in this server"));

    // A category given as the log channel: refused.
    let mut category = base.clone();
    category["log_channel_id"] = json!(CATEGORY);
    assert_eq!(save(category).await.0, 400);

    // A foreign category, even on a topic: refused.
    let mut routed = base.clone();
    routed["log_channel_id"] = json!(LOG);
    routed["target"] = json!("string_select");
    routed["topics"] =
        json!([{ "id": "t1", "label": "Billing", "category_id": "888888888888888888" }]);
    assert_eq!(save(routed).await.0, 400);

    // This server's own channels: fine.
    let mut own = base;
    own["log_channel_id"] = json!(LOG);
    own["category_id"] = json!(CATEGORY);
    assert_eq!(save(own).await.0, 201);
}

#[tokio::test]
async fn lost_intake_answers_are_reported_to_the_opener() {
    let h = Harness::start().await;
    let panel = h
        .panel(
            json!({ "intake": [{ "id": "q1", "label": "What happened?", "style": "paragraph" }] }),
        )
        .await;
    h.world().fail_posts_containing = Some("Intake answers".into());
    let sent = h
        .submit(
            &format!("tickets:intake:{panel}"),
            "999",
            &opener(),
            &[("q1", "it broke")],
            None,
        )
        .await;
    let reply = h.outcome(&sent).await;
    assert!(reply.contains("Opened your ticket"), "{reply}");
    assert!(reply.contains("didn't take your form answers"), "{reply}");
}

#[tokio::test]
async fn a_deferred_edit_that_beats_its_ack_still_lands() {
    let h = Harness::start().await;
    let panel = h.panel(json!({})).await;
    h.world().original_arrives_late = true;
    // The overview has nothing to probe, so it edits its reply at once —
    // the case where the edit can overtake the deferred ack.
    let sent = h
        .click(&format!("tickets:manage:{panel}"), "555", &staff())
        .await;
    let text = h.outcome(&sent).await;
    assert!(text.contains("No tickets are open"), "{text}");
}
