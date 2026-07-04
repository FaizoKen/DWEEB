//! Interactions dispatcher: the ONE public Discord interactions endpoint,
//! fanning out to plugin services by `custom_id` prefix.
//!
//! A Discord application has exactly one Interactions Endpoint URL, but every
//! DWEEB plugin that puts interactive components on a webhook message receives
//! its clicks through that single URL. Each plugin manifest declares a
//! `customIdPrefix` (e.g. `modalform:`), so the prefix doubles as the routing
//! key: this service verifies the Ed25519 signature, answers PINGs itself, and
//! forwards everything else — raw body and signature headers untouched, so the
//! plugin can (and does) re-verify — to the matching upstream.
//!
//! It also answers every application command inline (commands.rs): the
//! `/dashboard` slash command plus the right-click context-menu commands
//! ("Edit in DWEEB", "Export JSON", "Message Info", "Use as Webhook
//! Identity"). Each is a pure function of the interaction payload — no
//! Discord API call, no plugin, no forward hop. Register them once with
//! `node scripts/register-commands.mjs`. One custom_id namespace is the
//! dispatcher's own: clicks on `dweeb:`-prefixed components (the
//! permanent-slot toggle button on a "Message Info" reply) are answered
//! inline too, ahead of the plugin routing.
//!
//! Adding a plugin is one entry in the ROUTES env var; nothing here changes.
//!
//! Components also expire by default: a click on a message older than
//! COMPONENT_TTL_DAYS (the message id snowflake carries its send time) is
//! answered here with an UPDATE_MESSAGE that disables the clicked component,
//! and is never forwarded. A disabled component fires no further interactions,
//! so one expired click is the last traffic that message ever generates.
//! A click whose custom_id matches no route is answered the same way: the
//! component is disabled, so a message left behind by an uninstalled plugin
//! stops generating traffic after its first click.
//!
//! Each guild gets PERMANENT_SLOTS_PER_GUILD exemptions, managed two ways:
//! from the DWEEB dashboard — the proxy authenticates the user (Discord
//! login plus Manage Server on the guild) and calls the token-gated
//! /permanent API here, which owns the slots in SQLite — or from Discord,
//! via the toggle button on the "Message Info" context-menu reply
//! (commands.rs re-checks Manage Server against member.permissions).
//! Granting a slot also asks the proxy (SERVER_URL, same shared token in
//! reverse) to switch any TTL-disabled components back on, since the proxy
//! holds the webhook token needed to edit the posted message and this service
//! doesn't — see `App::trigger_reenable`.
//!
//! Custom apps: a guild may also register its OWN Discord application(s) —
//! CUSTOM_APPS_PER_GUILD each, default 1 (per-guild plan caps can replace the
//! env later without changing the API). The owner points their app's
//! Interactions Endpoint URL at this same dispatcher; requests are then
//! verified with the registered app's public key and served identically
//! (PING, TTL gate, plugin routing). The registry lives in SQLite next to the
//! permanent slots, managed through the token-gated /custom-apps API, and is
//! mirrored into an in-memory map at boot — this process is the registry's
//! only writer, so the interaction hot path never touches the database.
//!
//! Env:
//!   DISCORD_PUBLIC_KEY  app public key (64 hex chars), required
//!   ROUTES              JSON map of custom_id prefix -> upstream base URL,
//!                       e.g. {"modalform:":"http://modal-form:8090"}, required
//!   COMPONENT_TTL_DAYS  days a component stays clickable after its message
//!                       was sent, default 7; 0 = never expires
//!   PERMANENT_SLOTS_PER_GUILD
//!                       messages per guild exempt from the TTL, default 2;
//!                       0 stops new grants (existing ones stay honored)
//!   CUSTOM_APPS_PER_GUILD
//!                       custom Discord apps each guild may register, default
//!                       1; 0 stops new registrations (existing ones stay)
//!   DISPATCHER_FORWARD_SECRET
//!                       shared secret attesting the forwarded verifying key
//!                       to plugins (they verify custom-app signatures with
//!                       it); unset = plugins fall back to the primary key,
//!                       so custom-app clicks fail at the plugin hop
//!   INTERNAL_API_TOKEN  bearer token the proxy must send to the /permanent
//!                       and /custom-apps APIs; unset = those APIs are disabled
//!   DATABASE_PATH       SQLite file for the registries, default ./dispatcher.db
//!   DASHBOARD_URL       URL /dashboard replies with, default https://dweeb.faizo.net
//!   SHORTLINK_API       proxy endpoint that mints share short links, used as
//!                       the fallback when a message is too large to embed in
//!                       an "Edit in DWEEB"/"Export JSON" reply; default
//!                       http://proxy:8080/api/shortlink (the compose service).
//!                       Unreachable = the reply degrades to a plain note.
//!   PORT                bind port, default 8095

mod commands;
mod store;

use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    sync::{Arc, RwLock},
    time::Duration,
};

use axum::{
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::{json, Value};

const TYPE_PING: u64 = 1;
const TYPE_APPLICATION_COMMAND: u64 = 2;
const TYPE_MESSAGE_COMPONENT: u64 = 3;
const RESPONSE_PONG: u64 = 1;
const RESPONSE_CHANNEL_MESSAGE: u64 = 4;
const RESPONSE_UPDATE_MESSAGE: u64 = 7;
/// Text Display — how a Components V2 message carries text (V2 forbids the
/// plain `content` field).
const TYPE_TEXT_DISPLAY: u64 = 10;
const FLAG_EPHEMERAL: u64 = 1 << 6; // 64
const FLAG_IS_COMPONENTS_V2: u64 = 1 << 15; // 32768
/// First millisecond of 2015 — the epoch Discord snowflakes count from.
const DISCORD_EPOCH_MS: u64 = 1_420_070_400_000;
/// Discord snowflakes are 17–20 digits today; accept a small range with slack.
fn is_snowflake(s: &str) -> bool {
    (15..=25).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

struct App {
    /// The main app's verifying key, decoded once at boot — the hot path
    /// never re-parses hex.
    primary_key: VerifyingKey,
    /// Hex form of the same key, forwarded to plugins so they re-verify
    /// against the key that actually signed the request.
    primary_key_hex: String,
    /// Guild-registered custom apps: application_id → (verifying key, hex).
    /// Seeded from SQLite at boot and kept in sync by the /custom-apps API —
    /// this process is the registry's only writer, so the map is
    /// authoritative and interactions never touch the database for keys.
    custom_keys: RwLock<HashMap<String, (VerifyingKey, String)>>,
    /// App ids whose "first verified interaction" has already been persisted
    /// this process — an in-memory guard so the latency-sensitive interaction
    /// path touches SQLite at most once per app (the first time we see it),
    /// then never again. Empty at boot; the DB write is idempotent regardless.
    custom_verified: RwLock<HashSet<String>>,
    /// Custom-app registrations each guild may hold. Today a deployment-wide
    /// env; per-guild plan caps can replace this without changing the API
    /// (every response already carries `cap`).
    custom_apps_cap: u32,
    /// Shared secret that vouches for the forwarded verifying-key header to
    /// plugins. `None` = header not sent (custom-app clicks then fail the
    /// plugins' own re-verification).
    forward_secret: Option<String>,
    /// (custom_id prefix, upstream base URL) — longest prefix wins.
    routes: Vec<(String, String)>,
    /// How long a component stays clickable after its message was sent.
    /// `None` = never expires (COMPONENT_TTL_DAYS=0).
    component_ttl_ms: Option<u64>,
    /// TTL-exempt messages each guild may hold at once.
    permanent_slots: u32,
    /// Which messages are TTL-exempt + the custom-app registry.
    store: store::Store,
    /// Bearer token the proxy presents to the /permanent and /custom-apps
    /// management APIs. `None` disables those APIs entirely.
    internal_token: Option<String>,
    /// What `/dashboard` replies with.
    dashboard_url: String,
    /// Proxy endpoint that mints share short links — the fallback when a
    /// message is too large to embed in a reply link (see `commands::too_large`).
    shortlink_api: String,
    /// Proxy base URL the dispatcher calls to revive a message's components after
    /// granting it a never-expire slot (`POST /internal/permanent/reenable`). The
    /// dispatcher holds no webhook token, so the proxy — which does — performs the
    /// edit. Defaults to the compose proxy address; the call is best-effort and
    /// authenticated by the shared [`App::internal_token`].
    server_url: String,
    client: reqwest::Client,
}

fn main() {
    // Right-size the async runtime: the dispatcher mostly awaits the forward
    // hop, so the default of one worker per CPU just reserves idle thread stacks
    // and per-thread allocator arenas. Default to two workers — enough to keep
    // signature verification off the accept path under a burst — and let
    // TOKIO_WORKER_THREADS scale it without a rebuild.
    let worker_threads = std::env::var("TOKIO_WORKER_THREADS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|n| *n >= 1)
        .unwrap_or(2);
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(worker_threads)
        .enable_all()
        .build()
        .expect("failed to build Tokio runtime")
        .block_on(run());
}

async fn run() {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let primary_key_hex = std::env::var("DISCORD_PUBLIC_KEY")
        .expect("DISCORD_PUBLIC_KEY is required (app public key, 64 hex chars)")
        .trim()
        .to_lowercase();
    let primary_key = parse_verifying_key(&primary_key_hex)
        .expect("DISCORD_PUBLIC_KEY must be a valid Ed25519 public key (64 hex chars)");

    let routes_json = std::env::var("ROUTES")
        .expect(r#"ROUTES is required, e.g. {"modalform:":"http://modal-form:8090"}"#);
    let parsed: Value = serde_json::from_str(&routes_json).expect("ROUTES must be a JSON object");
    let mut routes: Vec<(String, String)> = parsed
        .as_object()
        .expect("ROUTES must be a JSON object")
        .iter()
        .map(|(prefix, base)| {
            let base = base
                .as_str()
                .expect("ROUTES values must be URL strings")
                .trim_end_matches('/')
                .to_string();
            (prefix.clone(), base)
        })
        .collect();
    // Longest prefix first, so "modalform-v2:" beats "modalform" if both exist.
    routes.sort_by_key(|r| std::cmp::Reverse(r.0.len()));
    for (prefix, base) in &routes {
        tracing::info!(prefix, upstream = %base, "route registered");
    }

    let component_ttl_days: u64 = std::env::var("COMPONENT_TTL_DAYS")
        .ok()
        .map(|v| {
            v.trim()
                .parse()
                .expect("COMPONENT_TTL_DAYS must be a whole number of days (0 = never expires)")
        })
        .unwrap_or(7);
    let component_ttl_ms = (component_ttl_days > 0).then(|| component_ttl_days * 86_400_000);
    tracing::info!(
        days = component_ttl_days,
        "component TTL (0 = never expires)"
    );

    let permanent_slots: u32 = std::env::var("PERMANENT_SLOTS_PER_GUILD")
        .ok()
        .map(|v| {
            v.trim()
                .parse()
                .expect("PERMANENT_SLOTS_PER_GUILD must be a whole number (0 stops new grants)")
        })
        .unwrap_or(2);
    let custom_apps_cap: u32 = std::env::var("CUSTOM_APPS_PER_GUILD")
        .ok()
        .map(|v| {
            v.trim()
                .parse()
                .expect("CUSTOM_APPS_PER_GUILD must be a whole number (0 stops new registrations)")
        })
        .unwrap_or(1);
    let forward_secret = std::env::var("DISPATCHER_FORWARD_SECRET")
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());

    let database_path = std::env::var("DATABASE_PATH").unwrap_or_else(|_| "./dispatcher.db".into());
    let store = store::Store::open(&database_path).expect("open permanent-message store");
    let internal_token = std::env::var("INTERNAL_API_TOKEN")
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    tracing::info!(
        path = %database_path,
        slots = permanent_slots,
        api_enabled = internal_token.is_some(),
        "permanent store ready"
    );

    // Seed the custom-app key map. A row whose stored key no longer parses is
    // skipped with a warning — its app simply fails verification (401), the
    // same as if it were never registered; re-registering repairs it.
    let mut custom_keys = HashMap::new();
    for (app_id, key_hex) in store.custom_apps_all().expect("load custom apps") {
        match parse_verifying_key(&key_hex) {
            Some(key) => {
                custom_keys.insert(app_id, (key, key_hex));
            }
            None => {
                tracing::warn!(application_id = %app_id, "stored custom-app key invalid, skipping")
            }
        }
    }
    tracing::info!(
        apps = custom_keys.len(),
        cap = custom_apps_cap,
        attest = forward_secret.is_some(),
        "custom apps loaded (cap 0 stops new registrations)"
    );

    let dashboard_url = std::env::var("DASHBOARD_URL")
        .unwrap_or_else(|_| "https://dweeb.faizo.net".into())
        .trim_end_matches('/')
        .to_string();

    // Where `too_large` mints a short link. Defaults to the proxy's compose
    // service address — like ROUTES, this service addresses peers by name. A
    // deployment without the proxy reachable just sees the graceful fallback.
    let shortlink_api = std::env::var("SHORTLINK_API")
        .unwrap_or_else(|_| "http://proxy:8080/api/shortlink".into())
        .trim()
        .to_string();

    // Proxy base URL for the never-expire component revival call. Same convention
    // as SHORTLINK_API — addressed by compose service name, with a graceful no-op
    // when the proxy isn't reachable (the grant still succeeds, just no revival).
    let server_url = std::env::var("SERVER_URL")
        .unwrap_or_else(|_| "http://proxy:8080".into())
        .trim()
        .trim_end_matches('/')
        .to_string();

    let app = Arc::new(App {
        primary_key,
        primary_key_hex,
        custom_keys: RwLock::new(custom_keys),
        custom_verified: RwLock::new(HashSet::new()),
        custom_apps_cap,
        forward_secret,
        routes,
        component_ttl_ms,
        permanent_slots,
        store,
        internal_token,
        dashboard_url,
        shortlink_api,
        server_url,
        client: reqwest::Client::builder()
            // Discord gives the whole chain 3s; leave headroom to still send
            // the fallback reply if an upstream stalls.
            .timeout(Duration::from_millis(2500))
            // Keep upstream connections warm — the forward hop stays sub-ms.
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .expect("reqwest client"),
    });

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8095);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    let router = Router::new()
        .route("/health", get(health))
        // Public endpoint at the root: the hostname (interactions.<domain>) is
        // the whole address, no path component.
        .route("/", post(interactions))
        // Permanent-slot management, called by the proxy on behalf of the
        // dashboard. Token-gated (INTERNAL_API_TOKEN) — Caddy also refuses
        // /permanent on the public hostname, but the token is the real gate.
        .route(
            "/permanent/:guild_id",
            get(permanent_list).post(permanent_add),
        )
        .route(
            "/permanent/:guild_id/:message_id",
            axum::routing::delete(permanent_remove),
        )
        // Custom-app registry, same trust chain as /permanent: proxy-only,
        // token-gated, and refused at the edge by Caddy.
        .route(
            "/custom-apps/:guild_id",
            get(custom_apps_list).post(custom_apps_add),
        )
        .route(
            "/custom-apps/:guild_id/:application_id",
            axum::routing::delete(custom_apps_remove),
        )
        // The sealed client secret for the proxy's "create webhook under
        // this app" flow. Opaque ciphertext here — only the proxy can open it.
        .route(
            "/custom-apps/:guild_id/:application_id/secret",
            get(custom_app_secret),
        )
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(app);

    tracing::info!(%addr, "interactions dispatcher listening");
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server");
}

/// Resolve on Ctrl-C or (on Unix) SIGTERM, so `docker stop` / `compose down`
/// shuts the dispatcher down cleanly — in-flight interactions finish inside the
/// grace window instead of being hard-killed. Docker sends SIGTERM, not SIGINT,
/// so without the SIGTERM arm every redeploy would drop live requests.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}

async fn health() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
}

impl App {
    /// Note that a validly-signed interaction just arrived for a custom app —
    /// the signal the dashboard reads as "this bot is connected". The first
    /// sighting per process is persisted (`verified_at`); after that the
    /// read-lock fast path returns immediately, so the interaction hot path
    /// stays allocation- and DB-free for every subsequent click.
    fn note_custom_verified(&self, app_id: &str) {
        if self.custom_verified.read().unwrap().contains(app_id) {
            return;
        }
        if !self
            .custom_verified
            .write()
            .unwrap()
            .insert(app_id.to_string())
        {
            return; // lost a race — the winner is persisting it
        }
        match self.store.mark_custom_verified(app_id) {
            Ok(true) => {
                tracing::info!(application_id = %app_id, "custom app verified (first interaction)")
            }
            // Already stamped on a previous run — fine, the flag stands.
            Ok(false) => {}
            Err(err) => {
                tracing::warn!(%err, application_id = %app_id, "couldn't persist custom-app verified flag");
                // Drop it from the guard so a later interaction retries.
                self.custom_verified.write().unwrap().remove(app_id);
            }
        }
    }

    /// Best-effort: ask the proxy to re-enable any components the TTL gate
    /// disabled on `message_id`, now that it holds a never-expire slot. The
    /// dispatcher can't edit the posted message itself — the grant click lands on
    /// an ephemeral reply and it has no webhook token — so it hands the work to
    /// the proxy (`POST /internal/permanent/reenable`), which does. Fire-and-forget:
    /// the grant and its UPDATE_MESSAGE reply never wait on this, and a failure
    /// only means the buttons stay greyed until the message is re-posted. No-op
    /// without `internal_token` (the shared secret that authenticates the call).
    fn trigger_reenable(&self, guild_id: &str, channel_id: &str, message_id: &str) {
        let Some(token) = self.internal_token.clone() else {
            return;
        };
        let client = self.client.clone();
        let url = format!("{}/internal/permanent/reenable", self.server_url);
        let body = json!({
            "guild_id": guild_id,
            "channel_id": channel_id,
            "message_id": message_id,
        });
        let message_id = message_id.to_string();
        tokio::spawn(async move {
            match client
                .post(&url)
                .bearer_auth(&token)
                .json(&body)
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    tracing::info!(%message_id, "asked proxy to revive components after never-expire grant")
                }
                Ok(resp) => {
                    tracing::warn!(status = %resp.status(), %message_id, "proxy rejected component revival request")
                }
                Err(err) => {
                    tracing::warn!(%err, %message_id, "couldn't reach proxy to revive components")
                }
            }
        });
    }
}

async fn interactions(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> Response {
    // Verify before acting; Discord probes with invalid signatures and a 401
    // here is what makes the endpoint pass their validation.
    let signature = headers
        .get("x-signature-ed25519")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let timestamp = headers
        .get("x-signature-timestamp")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();

    // The primary app first: virtually all traffic, and the precomputed key
    // makes a failed try nearly free. Only then the custom-app path, which
    // must parse the (still untrusted, but inert) JSON to learn which
    // application signed — `application_id` selects the key, and nothing
    // else is acted on until a signature checks out.
    let (interaction, verified_key_hex): (Value, std::borrow::Cow<'_, str>) =
        if verify_signature(&app.primary_key, signature, timestamp, &body) {
            match serde_json::from_slice(&body) {
                Ok(v) => (v, std::borrow::Cow::Borrowed(app.primary_key_hex.as_str())),
                Err(_) => {
                    return (StatusCode::BAD_REQUEST, "malformed interaction").into_response()
                }
            }
        } else {
            let Ok(parsed) = serde_json::from_slice::<Value>(&body) else {
                // Unattributable garbage — for Discord's endpoint validation
                // this must read as a signature failure, not a parse error.
                return (StatusCode::UNAUTHORIZED, "bad signature").into_response();
            };
            let app_id = parsed
                .get("application_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let custom = app
                .custom_keys
                .read()
                .unwrap()
                .get(app_id)
                .map(|(key, hex)| (*key, hex.clone()));
            let Some((key, hex)) = custom else {
                return (StatusCode::UNAUTHORIZED, "bad signature").into_response();
            };
            if !verify_signature(&key, signature, timestamp, &body) {
                return (StatusCode::UNAUTHORIZED, "bad signature").into_response();
            }
            // A real, correctly-signed interaction reached us for this app —
            // record it as the dashboard's "connected" proof (once per app).
            app.note_custom_verified(app_id);
            (parsed, std::borrow::Cow::Owned(hex))
        };

    match interaction.get("type").and_then(Value::as_u64) {
        Some(TYPE_PING) => return Json(json!({ "type": RESPONSE_PONG })).into_response(),
        // Application commands (slash + context menus) route by name, not
        // custom_id, and every one of them is a pure function of the payload
        // Discord just sent — so they are all answered inline (commands.rs),
        // skipping the forward hop entirely.
        Some(TYPE_APPLICATION_COMMAND) => return commands::respond(&app, &interaction).await,
        _ => {}
    }

    // Components and modal submits both carry the routing key here.
    let custom_id = interaction
        .pointer("/data/custom_id")
        .and_then(Value::as_str)
        .unwrap_or_default();

    // The dispatcher's own components — the permanent-slot toggle button on
    // a "Message Info" reply — are answered inline: they have no upstream,
    // and they sit on ephemeral replies that are gone long before any TTL.
    if interaction.get("type").and_then(Value::as_u64) == Some(TYPE_MESSAGE_COMPONENT)
        && custom_id.starts_with(commands::CUSTOM_ID_PREFIX)
    {
        return commands::component(&app, &interaction);
    }

    // Components expire COMPONENT_TTL_DAYS after their message was sent (the
    // message id snowflake carries the send time — no registry of instances
    // needed), unless an admin spent one of the guild's permanent slots on
    // the message. An expired click is answered by disabling the component on
    // the message itself, so it never reaches a plugin and never fires again.
    // Modal submits are exempt: opening the modal already passed this gate.
    // Only already-expired clicks pay the store lookup; fresh traffic never
    // touches the database.
    if interaction.get("type").and_then(Value::as_u64) == Some(TYPE_MESSAGE_COMPONENT) {
        if let (Some(ttl_ms), Some(sent_ms)) = (app.component_ttl_ms, message_sent_ms(&interaction))
        {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let message_id = interaction
                .pointer("/message/id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if now_ms.saturating_sub(sent_ms) > ttl_ms && !app.store.is_permanent(message_id) {
                tracing::info!(custom_id, "component past TTL, disabling");
                return disable_clicked(&interaction, custom_id, "This component has expired.");
            }
        }
    }

    let Some((prefix, base)) = app
        .routes
        .iter()
        .find(|(prefix, _)| custom_id.starts_with(prefix.as_str()))
    else {
        tracing::warn!(custom_id, "no route for interaction, answering with notice");
        // An unrouted component's plugin isn't installed/assigned. Don't
        // disable the button — that hides the problem and stops it firing.
        // Answer every click (and modal submit) with an ephemeral note so
        // whoever clicks, and the message's owner, can see what's wrong and
        // fix the wiring instead of staring at a silently dead button.
        return ephemeral("This component isn't wired to any installed plugin.");
    };

    // Forward raw body + signature headers so the plugin re-verifies the exact
    // bytes Discord signed. The receive timestamp (unix µs) lets latency-aware
    // plugins (e.g. ping-pong) report the dispatcher hop; it is informational
    // only — it isn't part of the signed material.
    let received_us = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros())
        .unwrap_or(0);
    let mut request = app
        .client
        .post(format!("{base}/interactions"))
        .header("content-type", "application/json")
        .header("x-signature-ed25519", signature)
        .header("x-signature-timestamp", timestamp)
        .header("x-dweeb-dispatcher-received", received_us.to_string());
    // Tell the plugin which key verified this request, vouched for by the
    // shared secret — that's what lets it re-verify a custom app's signature
    // itself. Plugins ignore the key header without a valid secret, so a
    // caller reaching a plugin directly can never substitute its own key.
    if let Some(secret) = &app.forward_secret {
        request = request
            .header("x-dweeb-public-key", verified_key_hex.as_ref())
            .header("x-dweeb-forward-auth", secret);
    }
    let forwarded = request.body(body.clone()).send().await;

    match forwarded {
        Ok(resp) => {
            let status =
                StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let content_type = resp
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/json")
                .to_string();
            let bytes = resp.bytes().await.unwrap_or_default();
            (
                status,
                [(axum::http::header::CONTENT_TYPE, content_type)],
                bytes,
            )
                .into_response()
        }
        Err(err) => {
            // Still answer Discord within its 3s window so the user sees a
            // message instead of "This interaction failed".
            tracing::error!(prefix, upstream = %base, %err, "forward failed");
            ephemeral("The plugin behind this component didn't respond — try again shortly.")
        }
    }
}

/// When the message a component sits on was sent, from its snowflake id.
fn message_sent_ms(interaction: &Value) -> Option<u64> {
    let id: u64 = interaction.pointer("/message/id")?.as_str()?.parse().ok()?;
    Some((id >> 22) + DISCORD_EPOCH_MS)
}

/// Answer a dead click (expired or unrouted) by editing the message to disable
/// the clicked component. Discord stops sending interactions for a disabled
/// component, so this is also the last request the message ever generates.
fn disable_clicked(interaction: &Value, custom_id: &str, fallback: &str) -> Response {
    // Echo the message's own component tree back with the one component
    // disabled. If the tree is somehow absent, fall back to an ephemeral note
    // rather than wiping the message's components with an empty list.
    let Some(mut components) = interaction.pointer("/message/components").cloned() else {
        return ephemeral(fallback);
    };
    disable_component(&mut components, custom_id);
    Json(json!({
        "type": RESPONSE_UPDATE_MESSAGE,
        "data": { "components": components }
    }))
    .into_response()
}

/// Recursively set `disabled: true` on every component matching `custom_id`.
/// Handles Components V2 nesting: containers/sections/action rows hold
/// children under `components`, a section's button under `accessory`.
fn disable_component(node: &mut Value, custom_id: &str) {
    match node {
        Value::Array(items) => {
            for item in items {
                disable_component(item, custom_id);
            }
        }
        Value::Object(map) => {
            if map.get("custom_id").and_then(Value::as_str) == Some(custom_id) {
                map.insert("disabled".into(), Value::Bool(true));
            }
            if let Some(children) = map.get_mut("components") {
                disable_component(children, custom_id);
            }
            if let Some(accessory) = map.get_mut("accessory") {
                disable_component(accessory, custom_id);
            }
        }
        _ => {}
    }
}

// ── Permanent-slot management API (called by the proxy) ─────────────────────
//
// The dashboard is the only client: browser → proxy (Discord login + Manage
// Server check on the guild) → here, with INTERNAL_API_TOKEN as a bearer.
// This service stays the single owner of the slots the TTL gate consults.

/// `GET /permanent/:guild_id` — slot usage + the current permanent messages.
async fn permanent_list(
    State(app): State<Arc<App>>,
    Path(guild_id): Path<String>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Response {
    if let Some(denied) = deny_internal(&app, &headers, &[&guild_id]) {
        return denied;
    }
    let cap = cap_override(raw.as_deref(), app.permanent_slots);
    match app.store.list(&guild_id) {
        Ok(rows) => slots_json(&app, &rows, cap).into_response(),
        Err(err) => internal_error(err),
    }
}

/// `POST /permanent/:guild_id` `{ message_id, channel_id, added_by }` —
/// spend a slot. Idempotent: adding an already-permanent message is a 200.
async fn permanent_add(
    State(app): State<Arc<App>>,
    Path(guild_id): Path<String>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Some(denied) = deny_internal(&app, &headers, &[&guild_id]) {
        return denied;
    }
    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return bad_request("body must be JSON"),
    };
    let field = |k: &str| parsed.get(k).and_then(Value::as_str).unwrap_or_default();
    let (message_id, channel_id, added_by) =
        (field("message_id"), field("channel_id"), field("added_by"));
    if !is_snowflake(message_id) || !is_snowflake(channel_id) {
        return bad_request("message_id and channel_id must be snowflakes");
    }

    let cap = cap_override(raw.as_deref(), app.permanent_slots);
    let added = app
        .store
        .add(&guild_id, channel_id, message_id, added_by, cap);
    let outcome = match added {
        Ok(o) => o,
        Err(err) => return internal_error(err),
    };
    match app.store.list(&guild_id) {
        Ok(rows) => match outcome {
            store::Add::Added | store::Add::Already => slots_json(&app, &rows, cap).into_response(),
            store::Add::Full => (
                StatusCode::CONFLICT,
                slots_error_json(&app, &rows, cap, "slots_full"),
            )
                .into_response(),
        },
        Err(err) => internal_error(err),
    }
}

/// `DELETE /permanent/:guild_id/:message_id` — give the slot back.
async fn permanent_remove(
    State(app): State<Arc<App>>,
    Path((guild_id, message_id)): Path<(String, String)>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Response {
    if let Some(denied) = deny_internal(&app, &headers, &[&guild_id, &message_id]) {
        return denied;
    }
    let removed = match app.store.remove(&guild_id, &message_id) {
        Ok(r) => r,
        Err(err) => return internal_error(err),
    };
    if !removed {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "not_permanent" })),
        )
            .into_response();
    }
    let cap = cap_override(raw.as_deref(), app.permanent_slots);
    match app.store.list(&guild_id) {
        Ok(rows) => slots_json(&app, &rows, cap).into_response(),
        Err(err) => internal_error(err),
    }
}

// ── Custom-app registry API (called by the proxy) ───────────────────────────
//
// Same trust chain as /permanent: browser → proxy (Discord login + Manage
// Server check on the guild) → here, with INTERNAL_API_TOKEN as a bearer.
// This service owns the registry; every mutation also updates the in-memory
// key map the interaction hot path verifies with.

/// `GET /custom-apps/:guild_id` — quota usage + the guild's registered apps.
async fn custom_apps_list(
    State(app): State<Arc<App>>,
    Path(guild_id): Path<String>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Response {
    if let Some(denied) = deny_internal(&app, &headers, &[&guild_id]) {
        return denied;
    }
    let cap = cap_override(raw.as_deref(), app.custom_apps_cap);
    match app.store.custom_apps_list(&guild_id) {
        Ok(rows) => custom_apps_json(&rows, cap).into_response(),
        Err(err) => internal_error(err),
    }
}

/// `POST /custom-apps/:guild_id`
/// `{ application_id, public_key, name?, added_by }` — register an app under
/// one of the guild's quota slots. Re-registering the guild's own app updates
/// its key/name in place (the fix path for a mistyped key) without spending a
/// new slot.
async fn custom_apps_add(
    State(app): State<Arc<App>>,
    Path(guild_id): Path<String>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Some(denied) = deny_internal(&app, &headers, &[&guild_id]) {
        return denied;
    }
    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return bad_request("body must be JSON"),
    };
    let field = |k: &str| parsed.get(k).and_then(Value::as_str).unwrap_or_default();
    let application_id = field("application_id");
    let public_key = field("public_key").trim().to_lowercase();
    let added_by = field("added_by");
    // The app's client secret, already sealed by the proxy (opaque here).
    // Empty = none stored; the dashboard then can't offer one-click webhook
    // creation for this app.
    let client_secret_enc = field("client_secret_enc");
    if !is_snowflake(application_id) {
        return bad_request("application_id must be a snowflake");
    }
    if client_secret_enc.len() > 2048 {
        return bad_request("client_secret_enc too large");
    }
    let Some(key) = parse_verifying_key(&public_key) else {
        return bad_request("public_key must be a valid Ed25519 public key (64 hex chars)");
    };
    if public_key == app.primary_key_hex {
        // Registering the main app's own key would be pure confusion — the
        // primary key already verifies first, unconditionally.
        return bad_request("that is this deployment's own public key");
    }
    // Display name is cosmetic: control characters out, length bounded.
    let name: String = field("name")
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(100)
        .collect();

    let cap = cap_override(raw.as_deref(), app.custom_apps_cap);
    let added = app.store.custom_app_add(
        &guild_id,
        application_id,
        &public_key,
        &name,
        client_secret_enc,
        added_by,
        cap,
    );
    let outcome = match added {
        Ok(o) => o,
        Err(err) => return internal_error(err),
    };
    if let store::AddApp::Added = outcome {
        // Keep the hot-path map in lockstep with the registry.
        app.custom_keys
            .write()
            .unwrap()
            .insert(application_id.to_string(), (key, public_key));
    }
    match app.store.custom_apps_list(&guild_id) {
        Ok(rows) => match outcome {
            store::AddApp::Added => custom_apps_json(&rows, cap).into_response(),
            store::AddApp::Full => (
                StatusCode::CONFLICT,
                custom_apps_error_json(&rows, cap, "quota_full"),
            )
                .into_response(),
            store::AddApp::Taken => (
                StatusCode::CONFLICT,
                custom_apps_error_json(&rows, cap, "app_taken"),
            )
                .into_response(),
        },
        Err(err) => internal_error(err),
    }
}

/// `DELETE /custom-apps/:guild_id/:application_id` — unregister; the app's
/// interactions start failing verification (401) immediately.
async fn custom_apps_remove(
    State(app): State<Arc<App>>,
    Path((guild_id, application_id)): Path<(String, String)>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Response {
    if let Some(denied) = deny_internal(&app, &headers, &[&guild_id, &application_id]) {
        return denied;
    }
    let removed = match app.store.custom_app_remove(&guild_id, &application_id) {
        Ok(r) => r,
        Err(err) => return internal_error(err),
    };
    if !removed {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "not_registered" })),
        )
            .into_response();
    }
    app.custom_keys.write().unwrap().remove(&application_id);
    // Forget the in-memory "already persisted" guard too, so a later
    // re-registration of the same id starts unverified and re-checks.
    app.custom_verified.write().unwrap().remove(&application_id);
    let cap = cap_override(raw.as_deref(), app.custom_apps_cap);
    match app.store.custom_apps_list(&guild_id) {
        Ok(rows) => custom_apps_json(&rows, cap).into_response(),
        Err(err) => internal_error(err),
    }
}

/// `GET /custom-apps/:guild_id/:application_id/secret` — the sealed client
/// secret the proxy stored at registration (empty string when none). The
/// ciphertext is opaque to this service; only the proxy holds the key.
async fn custom_app_secret(
    State(app): State<Arc<App>>,
    Path((guild_id, application_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if let Some(denied) = deny_internal(&app, &headers, &[&guild_id, &application_id]) {
        return denied;
    }
    match app.store.custom_app_secret(&guild_id, &application_id) {
        Ok(Some(sealed)) => Json(json!({ "client_secret_enc": sealed })).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "not_registered" })),
        )
            .into_response(),
        Err(err) => internal_error(err),
    }
}

/// The registry state every custom-app response carries. `cap` comes from the
/// deployment env today; a per-guild plan lookup can replace it later without
/// touching this shape.
fn custom_apps_json(rows: &[store::CustomAppRow], cap: u32) -> Json<Value> {
    Json(json!({
        "cap": cap,
        "used": rows.len(),
        "items": rows.iter().map(|r| json!({
            "application_id": r.application_id,
            "name": r.name,
            "added_at": r.added_at,
            "has_secret": r.has_secret,
            // True once Discord has delivered a validly-signed interaction —
            // i.e. the owner finished the Interactions Endpoint URL step.
            "verified": r.verified_at.is_some(),
        })).collect::<Vec<_>>(),
    }))
}

/// Same state plus an error code, for the 409 quota-full / app-taken responses.
fn custom_apps_error_json(rows: &[store::CustomAppRow], cap: u32, error: &str) -> Json<Value> {
    let mut body = custom_apps_json(rows, cap).0;
    body["error"] = json!(error);
    Json(body)
}

/// Shared admission check for the management API: bearer token (constant-time
/// compare; a missing INTERNAL_API_TOKEN disables the API outright) and
/// snowflake-shaped path ids. `None` means proceed.
fn deny_internal(app: &App, headers: &HeaderMap, ids: &[&str]) -> Option<Response> {
    let Some(expected) = app.internal_token.as_deref() else {
        return Some(
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "management API disabled (INTERNAL_API_TOKEN unset)" })),
            )
                .into_response(),
        );
    };
    let supplied = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();
    if !constant_time_eq(supplied.as_bytes(), expected.as_bytes()) {
        return Some(
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "unauthorized" })),
            )
                .into_response(),
        );
    }
    if ids.iter().any(|id| !is_snowflake(id)) {
        return Some(bad_request("ids must be snowflakes"));
    }
    None
}

/// The effective per-guild cap for a management request: the `?cap=N` the proxy
/// passes (the caller's plan tier) when present, else this deployment's env
/// default. Keeping the plan lookup in the proxy lets this service stay a dumb
/// enforcer of a provided number — no plan awareness here.
fn cap_override(raw: Option<&str>, default: u32) -> u32 {
    let Some(q) = raw else { return default };
    for pair in q.split('&') {
        if let Some(v) = pair.strip_prefix("cap=") {
            if let Ok(n) = v.parse::<u32>() {
                return n;
            }
        }
    }
    default
}

/// The slot state every management response carries. `ttl_days` is null when
/// components never expire on this deployment (COMPONENT_TTL_DAYS=0) — the
/// dashboard hides the feature then. `cap` is the effective per-guild cap (the
/// caller's plan tier, or the env default).
fn slots_json(app: &App, rows: &[store::PermanentRow], cap: u32) -> Json<Value> {
    Json(json!({
        "cap": cap,
        "used": rows.len(),
        "ttl_days": app.component_ttl_ms.map(|ms| ms / 86_400_000),
        "items": rows.iter().map(|r| json!({
            "message_id": r.message_id,
            "channel_id": r.channel_id,
            "added_at": r.added_at,
        })).collect::<Vec<_>>(),
    }))
}

/// Same state plus an error code, for the 409 slots-full response.
fn slots_error_json(app: &App, rows: &[store::PermanentRow], cap: u32, error: &str) -> Json<Value> {
    let mut body = slots_json(app, rows, cap).0;
    body["error"] = json!(error);
    Json(body)
}

fn bad_request(message: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response()
}

fn internal_error(err: rusqlite::Error) -> Response {
    tracing::error!(%err, "permanent store error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "storage error" })),
    )
        .into_response()
}

/// Byte-wise comparison that doesn't leak the match length through timing.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Minimal user-facing reply for the cases where no plugin answered. Always
/// Components V2: the text rides in a Text Display, not the plain `content`
/// field (which the V2 flag forbids).
pub(crate) fn ephemeral(message: &str) -> Response {
    Json(json!({
        "type": RESPONSE_CHANNEL_MESSAGE,
        "data": {
            "flags": FLAG_EPHEMERAL | FLAG_IS_COMPONENTS_V2,
            "components": [{ "type": TYPE_TEXT_DISPLAY, "content": message }],
        }
    }))
    .into_response()
}

/// Decode a 64-hex-char Ed25519 public key. None on any malformed input —
/// including a key that isn't a valid curve point.
fn parse_verifying_key(public_key_hex: &str) -> Option<VerifyingKey> {
    let pk: [u8; 32] = hex::decode(public_key_hex).ok()?.try_into().ok()?;
    VerifyingKey::from_bytes(&pk).ok()
}

/// Verify Discord's `X-Signature-Ed25519` over `timestamp || body`. Any
/// malformed input fails closed (returns false). This MUST run on the raw body
/// bytes. (Same logic as the modal-form plugin, minus the per-request key
/// decode — keys here are parsed once, at boot or registration.)
fn verify_signature(key: &VerifyingKey, signature_hex: &str, timestamp: &str, body: &[u8]) -> bool {
    let sig: [u8; 64] = match hex::decode(signature_hex)
        .ok()
        .and_then(|b| b.try_into().ok())
    {
        Some(arr) => arr,
        None => return false,
    };
    let signature = Signature::from_bytes(&sig);

    let mut message = Vec::with_capacity(timestamp.len() + body.len());
    message.extend_from_slice(timestamp.as_bytes());
    message.extend_from_slice(body);
    key.verify(&message, &signature).is_ok()
}
