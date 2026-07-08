//! Per-server message library: the SQLite-backed store + the HTTP API.
//!
//! The web builder used to remember posted messages only in the poster's own
//! browser (`localStorage`), which meant a teammate managing the same server
//! never saw them, and the embedded Activity — a different surface with its own
//! storage — saw nothing at all. The library moves that record server-side, per
//! **Discord server**: every message a manager posts (and any draft they choose
//! to save) lands in one shared, labelled list that both the web app and the
//! Activity read.
//!
//! Like a scheduled post, a library entry is an opt-in exception to DWEEB's
//! "nothing leaves your browser" rule, and it rides the exact same protections:
//! the message payload and the webhook execute URL are **sealed at rest**
//! (`seal.rs`, AES-256-GCM under the proxy's cookie key), so a leak of this
//! database alone yields neither a usable webhook nor any message content.
//!
//! Authorization matches the rest of the per-server surface: every route
//! requires Manage Webhooks in the guild (Administrator/owner included), via
//! the cookie session (web) **or** an Activity bearer — the same dual-identity
//! gate `activity_post` uses. That is the same trust level as the webhook
//! picker, which already reveals webhook tokens to these callers.
//!
//! Rows carry a `label`: `posted` (a live Discord message, upserted by its
//! message id so re-posting refreshes one entry) or `draft` (pure content,
//! saved deliberately). Scheduled and never-expire state are *not* duplicated
//! here — the frontend derives those labels from the existing schedule and
//! permanent-slot APIs, so there's one source of truth per feature.
//!
//! The per-server entry cap is the plan gate (`TierLimits::library`): Free
//! servers get a small shelf, paid tiers raise it. Quota only ever gates
//! *creation* — a downgraded server keeps every stored entry readable.

use std::path::Path as FsPath;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::PrivateCookieJar;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::AppError;
use crate::routes::{authorize_activity_webhooks, AppState};
use crate::schedule::unix_now;
use crate::schedule_validate::{
    is_snowflake, validate_dest_label, validate_payload, validate_title, validate_webhook,
    webhook_id,
};
use crate::seal;

/// Public entry id length — base62, same alphabet as short links / schedules.
const ID_LEN: usize = 10;
/// Hard ceiling on one list response, safely above any per-guild quota.
const LIST_LIMIT: usize = 500;

/// The two stored labels. Scheduled/permanent are derived client-side from
/// their own APIs, so they never appear here.
const LABELS: [&str; 2] = ["posted", "draft"];

// ── Row model ────────────────────────────────────────────────────────────────

/// All columns, in the order [`row_from`] reads them.
const COLS: &str = "id, guild_id, label, title, payload_sealed, webhook_sealed, webhook_id, \
     channel_id, message_id, thread_id, dest_label, created_by, created_at, updated_at";

/// A full stored entry. `Clone` so a handler can read-modify-write it.
#[derive(Clone)]
pub struct Row {
    pub id: String,
    pub guild_id: String,
    pub label: String,
    pub title: Option<String>,
    pub payload_sealed: String,
    /// Canonical webhook execute URL, sealed — present on posted entries so a
    /// later load can update the live message in place. Absent on drafts.
    pub webhook_sealed: Option<String>,
    pub webhook_id: Option<String>,
    pub channel_id: Option<String>,
    /// Discord message snowflake — the upsert key for posted entries.
    pub message_id: Option<String>,
    pub thread_id: Option<String>,
    /// Display-only destination ("#general"), like a schedule's `dest_label`.
    pub dest_label: Option<String>,
    /// Discord user id of whoever stored the entry (audit/display).
    pub created_by: String,
    pub created_at: i64,
    pub updated_at: i64,
}

fn row_from(r: &rusqlite::Row) -> rusqlite::Result<Row> {
    Ok(Row {
        id: r.get(0)?,
        guild_id: r.get(1)?,
        label: r.get(2)?,
        title: r.get(3)?,
        payload_sealed: r.get(4)?,
        webhook_sealed: r.get(5)?,
        webhook_id: r.get(6)?,
        channel_id: r.get(7)?,
        message_id: r.get(8)?,
        thread_id: r.get(9)?,
        dest_label: r.get(10)?,
        created_by: r.get(11)?,
        created_at: r.get(12)?,
        updated_at: r.get(13)?,
    })
}

/// Everything `create` needs (secrets already sealed by the caller).
pub struct NewEntry {
    pub guild_id: String,
    pub label: String,
    pub title: Option<String>,
    pub payload_sealed: String,
    pub webhook_sealed: Option<String>,
    pub webhook_id: Option<String>,
    pub channel_id: Option<String>,
    pub message_id: Option<String>,
    pub thread_id: Option<String>,
    pub dest_label: Option<String>,
    pub created_by: String,
}

#[derive(Debug)]
pub enum CreateError {
    /// Global row cap reached — answer 503, existing entries stay readable.
    Full,
    /// Per-server quota reached (carries the limit for the message) — 409.
    PerGuildFull(i64),
    Storage(String),
}

// ── Store ────────────────────────────────────────────────────────────────────

pub struct LibraryStore {
    conn: Mutex<Connection>,
    max_entries: i64,
    /// Max entries per server when plan entitlement is disabled — the
    /// standalone-deployment default the tier limits override.
    max_per_guild: i64,
    /// Approximate total row count, kept in step with inserts/deletes so the
    /// global cap check is a load, not a `COUNT(*)`.
    count: AtomicI64,
}

impl LibraryStore {
    pub fn open(path: &str, max_entries: u64, max_per_guild: u64) -> Result<Self, String> {
        if let Some(parent) = FsPath::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
            }
        }
        let conn = Connection::open(path).map_err(|e| format!("could not open {path}: {e}"))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| format!("journal_mode: {e}"))?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| format!("synchronous: {e}"))?;
        conn.pragma_update(None, "busy_timeout", 5_000)
            .map_err(|e| format!("busy_timeout: {e}"))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS library_messages (
                 id             TEXT PRIMARY KEY,
                 guild_id       TEXT NOT NULL,
                 label          TEXT NOT NULL,
                 title          TEXT,
                 payload_sealed TEXT NOT NULL,
                 webhook_sealed TEXT,
                 webhook_id     TEXT,
                 channel_id     TEXT,
                 message_id     TEXT,
                 thread_id      TEXT,
                 dest_label     TEXT,
                 created_by     TEXT NOT NULL,
                 created_at     INTEGER NOT NULL,
                 updated_at     INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_library_guild
                 ON library_messages(guild_id, updated_at);
             CREATE INDEX IF NOT EXISTS idx_library_msg
                 ON library_messages(guild_id, message_id);",
        )
        .map_err(|e| format!("schema: {e}"))?;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM library_messages", [], |r| r.get(0))
            .map_err(|e| format!("count: {e}"))?;
        Ok(LibraryStore {
            conn: Mutex::new(conn),
            max_entries: max_entries as i64,
            max_per_guild: max_per_guild as i64,
            count: AtomicI64::new(count),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The standalone per-server quota, surfaced so the list can show
    /// "used / cap" exactly the way the create path enforces it.
    pub fn max_per_guild(&self) -> i64 {
        self.max_per_guild
    }

    /// Insert `n`, or — when it's a posted entry whose `message_id` already has
    /// a row in the guild — refresh that row in place (re-posting or updating a
    /// live message must never pile up duplicates; an update doesn't grow the
    /// table, so within quota it bypasses the caps).
    /// Returns the entry's id (existing on refresh, `n_id` on insert).
    ///
    /// The per-guild cap is `limit_override` when given (the destination
    /// server's plan-tier limit) or the store default; the global cap always
    /// applies to inserts.
    ///
    /// **Over-quota content freeze**: while the server holds *more* entries than
    /// its cap (it filled up on a higher tier, then downgraded), refreshes are
    /// refused too, not just inserts. Otherwise the surplus rows would work as
    /// rotating storage — keep 500 entries from a paid month and rewrite their
    /// content forever on Free. Entries stay readable/deletable regardless; at
    /// or under the cap refreshes behave as before.
    pub fn upsert(
        &self,
        n: &NewEntry,
        n_id: &str,
        now: i64,
        limit_override: Option<i64>,
    ) -> Result<String, CreateError> {
        let conn = self.lock();
        let cap = limit_override.unwrap_or(self.max_per_guild);
        let in_guild: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM library_messages WHERE guild_id=?1",
                [&n.guild_id],
                |r| r.get(0),
            )
            .map_err(|e| CreateError::Storage(e.to_string()))?;
        if n.label == "posted" {
            if let Some(mid) = &n.message_id {
                let existing: Option<String> = conn
                    .query_row(
                        "SELECT id FROM library_messages WHERE guild_id=?1 AND message_id=?2",
                        params![n.guild_id, mid],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| CreateError::Storage(e.to_string()))?;
                if let Some(id) = existing {
                    if in_guild > cap {
                        return Err(CreateError::PerGuildFull(cap));
                    }
                    conn.execute(
                        "UPDATE library_messages SET label='posted', payload_sealed=?2, \
                         webhook_sealed=COALESCE(?3, webhook_sealed), \
                         webhook_id=COALESCE(?4, webhook_id), \
                         channel_id=COALESCE(?5, channel_id), thread_id=?6, \
                         dest_label=COALESCE(?7, dest_label), \
                         title=COALESCE(?8, title), updated_at=?9 \
                         WHERE id=?1",
                        params![
                            id,
                            n.payload_sealed,
                            n.webhook_sealed,
                            n.webhook_id,
                            n.channel_id,
                            n.thread_id,
                            n.dest_label,
                            n.title,
                            now
                        ],
                    )
                    .map_err(|e| CreateError::Storage(e.to_string()))?;
                    return Ok(id);
                }
            }
        }
        if self.count.load(Ordering::Relaxed) >= self.max_entries {
            return Err(CreateError::Full);
        }
        if in_guild >= cap {
            return Err(CreateError::PerGuildFull(cap));
        }
        conn.execute(
            "INSERT INTO library_messages \
             (id, guild_id, label, title, payload_sealed, webhook_sealed, webhook_id, \
              channel_id, message_id, thread_id, dest_label, created_by, created_at, updated_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13)",
            params![
                n_id,
                n.guild_id,
                n.label,
                n.title,
                n.payload_sealed,
                n.webhook_sealed,
                n.webhook_id,
                n.channel_id,
                n.message_id,
                n.thread_id,
                n.dest_label,
                n.created_by,
                now
            ],
        )
        .map_err(|e| CreateError::Storage(e.to_string()))?;
        self.count.fetch_add(1, Ordering::Relaxed);
        Ok(n_id.to_string())
    }

    /// A server's entries, most recently touched first.
    pub fn list_for_guild(&self, guild: &str, limit: usize) -> Result<Vec<Row>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {COLS} FROM library_messages WHERE guild_id=?1 \
                 ORDER BY updated_at DESC LIMIT ?2"
            ))
            .map_err(e2s)?;
        let rows = stmt
            .query_map((guild, limit as i64), row_from)
            .map_err(e2s)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(e2s)
    }

    /// One entry, scoped to its guild so a guessed id from another server 404s.
    pub fn get(&self, guild: &str, id: &str) -> Result<Option<Row>, String> {
        let conn = self.lock();
        conn.query_row(
            &format!("SELECT {COLS} FROM library_messages WHERE guild_id=?1 AND id=?2"),
            params![guild, id],
            row_from,
        )
        .optional()
        .map_err(e2s)
    }

    /// Persist a handler's read-modify-write of `row` (everything editable).
    pub fn save(&self, row: &Row, now: i64) -> Result<(), String> {
        let conn = self.lock();
        conn.execute(
            "UPDATE library_messages SET label=?2, title=?3, payload_sealed=?4, \
             webhook_sealed=?5, webhook_id=?6, channel_id=?7, message_id=?8, thread_id=?9, \
             dest_label=?10, updated_at=?11 WHERE id=?1",
            params![
                row.id,
                row.label,
                row.title,
                row.payload_sealed,
                row.webhook_sealed,
                row.webhook_id,
                row.channel_id,
                row.message_id,
                row.thread_id,
                row.dest_label,
                now
            ],
        )
        .map_err(e2s)?;
        Ok(())
    }

    /// Delete one entry (guild-scoped). True when a row was removed.
    pub fn delete(&self, guild: &str, id: &str) -> Result<bool, String> {
        let conn = self.lock();
        let n = conn
            .execute(
                "DELETE FROM library_messages WHERE guild_id=?1 AND id=?2",
                params![guild, id],
            )
            .map_err(e2s)?;
        if n > 0 {
            self.count.fetch_sub(n as i64, Ordering::Relaxed);
        }
        Ok(n > 0)
    }

    /// Whether a server holds *more* entries than its cap — the over-quota
    /// content-freeze condition (see [`upsert`]). Exactly at the cap is fine:
    /// the stored set is what the plan allows, only growth beyond it isn't.
    pub fn over_cap(&self, guild: &str, limit_override: Option<i64>) -> Result<bool, String> {
        let cap = limit_override.unwrap_or(self.max_per_guild);
        Ok(self.count_for_guild(guild)? > cap)
    }

    /// How many entries a server holds (the list's `used` figure).
    pub fn count_for_guild(&self, guild: &str) -> Result<i64, String> {
        let conn = self.lock();
        conn.query_row(
            "SELECT COUNT(*) FROM library_messages WHERE guild_id=?1",
            [guild],
            |r| r.get(0),
        )
        .map_err(e2s)
    }
}

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ── Auto-record (best-effort, off the critical path) ─────────────────────────

/// Record a message the proxy itself just posted (the Activity's publish/update,
/// or a fired schedule) into the destination server's library. Best-effort by
/// design: the post has already landed, so any problem here — quota reached,
/// store unavailable — is logged and swallowed rather than surfaced. Runs the
/// blocking store call off the async path.
#[allow(clippy::too_many_arguments)]
pub async fn record_posted_best_effort(
    st: &AppState,
    guild: &str,
    channel_id: Option<&str>,
    message_id: &str,
    thread_id: Option<&str>,
    webhook_url: Option<&str>,
    payload: &Value,
    title: Option<&str>,
    dest_label: Option<&str>,
    created_by: &str,
) {
    let Some(store) = &st.library else {
        return;
    };
    if !st.config.library_enabled || message_id.is_empty() {
        return;
    }
    let Ok(payload_str) = serde_json::to_string(payload) else {
        return;
    };
    let Some(payload_sealed) = seal::seal(&st.key, &payload_str) else {
        tracing::warn!(target: "library", "could not seal payload for auto-record");
        return;
    };
    let webhook_sealed = webhook_url.and_then(|u| seal::seal(&st.key, u.trim()));
    let n = NewEntry {
        guild_id: guild.to_string(),
        label: "posted".into(),
        title: title.map(str::to_string),
        payload_sealed,
        webhook_id: webhook_url.and_then(webhook_id),
        webhook_sealed,
        channel_id: channel_id.map(str::to_string),
        message_id: Some(message_id.to_string()),
        thread_id: thread_id.map(str::to_string),
        dest_label: dest_label.map(str::to_string),
        created_by: created_by.to_string(),
    };
    let limit_override = st.entitlements.library_limit(guild).await;
    let store = Arc::clone(store);
    let id = match random_id() {
        Some(id) => id,
        None => return,
    };
    let now = unix_now();
    let res = tokio::task::spawn_blocking(move || store.upsert(&n, &id, now, limit_override)).await;
    match res {
        Ok(Ok(_)) => {}
        // Quota/capacity is an expected steady state, not an error — the send
        // itself succeeded, the library just didn't grow.
        Ok(Err(CreateError::PerGuildFull(_))) | Ok(Err(CreateError::Full)) => {}
        Ok(Err(CreateError::Storage(e))) => {
            tracing::warn!(target: "library", "auto-record failed: {e}");
        }
        Err(e) => tracing::warn!(target: "library", "auto-record panicked: {e}"),
    }
}

/// Record a message a fired schedule just posted. The schedule row already
/// holds the payload + webhook **sealed under the same key**, so they're reused
/// verbatim — no unseal/reseal round trip. Same best-effort contract as
/// [`record_posted_best_effort`]: quota or storage trouble is logged, never
/// surfaced (the post already landed).
#[allow(clippy::too_many_arguments)]
pub async fn record_fired_schedule(
    library: Option<&Arc<LibraryStore>>,
    entitlements: &Arc<crate::entitlement::Entitlement>,
    guild: &str,
    channel_id: Option<&str>,
    message_id: &str,
    payload_sealed: &str,
    webhook_sealed: &str,
    webhook_id: &str,
    thread_id: Option<&str>,
    title: Option<&str>,
    dest_label: Option<&str>,
    created_by: Option<&str>,
) {
    let Some(store) = library else {
        return;
    };
    if message_id.is_empty() {
        return;
    }
    let n = NewEntry {
        guild_id: guild.to_string(),
        label: "posted".into(),
        title: title.map(str::to_string),
        payload_sealed: payload_sealed.to_string(),
        webhook_sealed: Some(webhook_sealed.to_string()),
        webhook_id: Some(webhook_id.to_string()),
        channel_id: channel_id.map(str::to_string),
        message_id: Some(message_id.to_string()),
        thread_id: thread_id.map(str::to_string),
        dest_label: dest_label.map(str::to_string),
        // A schedule can outlive its creator's session; fall back to a stable
        // marker so the row still says where it came from.
        created_by: created_by.unwrap_or("schedule").to_string(),
    };
    let limit_override = entitlements.library_limit(guild).await;
    let Some(id) = random_id() else { return };
    let now = unix_now();
    let store = Arc::clone(store);
    let res = tokio::task::spawn_blocking(move || store.upsert(&n, &id, now, limit_override)).await;
    match res {
        Ok(Ok(_)) => {}
        Ok(Err(CreateError::PerGuildFull(_))) | Ok(Err(CreateError::Full)) => {}
        Ok(Err(CreateError::Storage(e))) => {
            tracing::warn!(target: "library", "schedule auto-record failed: {e}");
        }
        Err(e) => tracing::warn!(target: "library", "schedule auto-record panicked: {e}"),
    }
}

// ── HTTP handlers ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateBody {
    pub label: String,
    #[serde(default)]
    pub title: Option<String>,
    pub payload: Value,
    #[serde(default)]
    pub webhook_url: Option<String>,
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub dest_label: Option<String>,
}

#[derive(Deserialize)]
pub struct PatchBody {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub payload: Option<Value>,
}

/// `GET /api/guilds/:guild_id/library` — the server's whole library, decrypted:
/// each entry carries its payload (the content is the product — thumbnails need
/// it) and, on posted entries, the webhook execute URL so a load can update the
/// live message in place. Revealing that URL matches `webhooks_list`, which
/// already hands the same callers every webhook token in the server.
pub async fn library_list(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    headers: HeaderMap,
    Path(guild): Path<String>,
) -> Result<Response, AppError> {
    let store = store(&st)?;
    let session = crate::activity::resolve_identity(&st, &jar, &headers).await?;
    authorize_activity_webhooks(&st, session, &guild).await?;
    let quota = quota_json(&st, store.as_ref(), &guild).await;
    let g = guild.clone();
    let rows = tokio::task::spawn_blocking(move || store.list_for_guild(&g, LIST_LIMIT))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(AppError::Internal)?;
    let items: Vec<Value> = rows.iter().map(|r| view(&st, r)).collect();
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "items": items, "used": rows.len(), "quota": quota })),
    )
        .into_response())
}

/// `POST /api/guilds/:guild_id/library` — store a message. A `posted` entry
/// with a `message_id` upserts (re-posting refreshes its one row); everything
/// else inserts, gated on the server's plan quota.
pub async fn library_create(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    headers: HeaderMap,
    Path(guild): Path<String>,
    Json(body): Json<CreateBody>,
) -> Result<Response, AppError> {
    let store = store(&st)?;
    let session = crate::activity::resolve_identity(&st, &jar, &headers).await?;
    let session = authorize_activity_webhooks(&st, session, &guild).await?;

    if !LABELS.contains(&body.label.as_str()) {
        return Err(bad_request("label must be \"posted\" or \"draft\""));
    }
    validate_payload(&body.payload).map_err(bad_request_s)?;
    if let Some(t) = &body.title {
        validate_title(t).map_err(bad_request_s)?;
    }
    if let Some(l) = &body.dest_label {
        validate_dest_label(l).map_err(bad_request_s)?;
    }
    for (name, id) in [
        ("channel_id", &body.channel_id),
        ("message_id", &body.message_id),
        ("thread_id", &body.thread_id),
    ] {
        if let Some(v) = id {
            if !v.is_empty() && !is_snowflake(v) {
                return Err(bad_request_s(format!("{name} must be a Discord id")));
            }
        }
    }
    let webhook_sealed = match &body.webhook_url {
        Some(u) if !u.trim().is_empty() => {
            validate_webhook(u).map_err(bad_request_s)?;
            Some(
                seal::seal(&st.key, u.trim())
                    .ok_or_else(|| AppError::Internal("could not seal webhook".into()))?,
            )
        }
        _ => None,
    };
    let payload_str =
        serde_json::to_string(&body.payload).map_err(|e| AppError::Internal(e.to_string()))?;
    let payload_sealed = seal::seal(&st.key, &payload_str)
        .ok_or_else(|| AppError::Internal("could not seal payload".into()))?;

    let n = NewEntry {
        guild_id: guild.clone(),
        label: body.label,
        title: body.title.filter(|t| !t.trim().is_empty()),
        payload_sealed,
        webhook_id: body.webhook_url.as_deref().and_then(webhook_id),
        webhook_sealed,
        channel_id: body.channel_id.filter(|v| !v.is_empty()),
        message_id: body.message_id.filter(|v| !v.is_empty()),
        thread_id: body.thread_id.filter(|v| !v.is_empty()),
        dest_label: body.dest_label.filter(|l| !l.trim().is_empty()),
        created_by: session.uid,
    };
    let limit_override = st.entitlements.library_limit(&guild).await;
    let id = random_id().ok_or_else(|| AppError::Internal("rng".into()))?;
    let now = unix_now();
    let s = Arc::clone(&store);
    let res = tokio::task::spawn_blocking(move || s.upsert(&n, &id, now, limit_override))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    match res {
        Ok(stored_id) => {
            let g = guild.clone();
            let row = tokio::task::spawn_blocking(move || store.get(&g, &stored_id))
                .await
                .map_err(|e| AppError::Internal(e.to_string()))?
                .map_err(AppError::Internal)?
                .ok_or_else(|| AppError::Internal("stored entry vanished".into()))?;
            Ok((
                StatusCode::CREATED,
                [(header::CACHE_CONTROL, "no-store")],
                Json(view(&st, &row)),
            )
                .into_response())
        }
        Err(CreateError::Full) => Err(AppError::Status {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: "The library is at capacity right now — try again later.".into(),
            retry_after: None,
        }),
        Err(CreateError::PerGuildFull(limit)) => Err(AppError::Status {
            status: StatusCode::CONFLICT,
            message: format!(
                "This server's library is full ({limit} messages) — delete one to add another, or upgrade the server's plan for more space."
            ),
            retry_after: None,
        }),
        Err(CreateError::Storage(e)) => Err(AppError::Internal(format!("library store: {e}"))),
    }
}

/// `PATCH /api/guilds/:guild_id/library/:id` — rename, relabel, or save new
/// content over an entry.
pub async fn library_patch(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    headers: HeaderMap,
    Path((guild, id)): Path<(String, String)>,
    Json(body): Json<PatchBody>,
) -> Result<Response, AppError> {
    let store = store(&st)?;
    let session = crate::activity::resolve_identity(&st, &jar, &headers).await?;
    authorize_activity_webhooks(&st, session, &guild).await?;
    let g = guild.clone();
    let i = id.clone();
    let s = Arc::clone(&store);
    let mut row = tokio::task::spawn_blocking(move || s.get(&g, &i))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(AppError::Internal)?
        .ok_or_else(not_found)?;

    // Over-quota content freeze (the PATCH twin of the `upsert` refresh gate):
    // while the server holds more entries than its plan cap, rewriting an
    // entry's *content* is refused — otherwise a downgraded server's surplus
    // rows would work as rotating storage. Rename/relabel stay allowed (they
    // change no content), as do reading and deleting.
    if body.payload.is_some() {
        let limit_override = st.entitlements.library_limit(&guild).await;
        let s = Arc::clone(&store);
        let g = guild.clone();
        let over = tokio::task::spawn_blocking(move || s.over_cap(&g, limit_override))
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?
            .map_err(AppError::Internal)?;
        if over {
            return Err(over_quota(limit_override.unwrap_or(store.max_per_guild())));
        }
    }

    if let Some(label) = body.label {
        if !LABELS.contains(&label.as_str()) {
            return Err(bad_request("label must be \"posted\" or \"draft\""));
        }
        row.label = label;
    }
    if let Some(title) = body.title {
        validate_title(&title).map_err(bad_request_s)?;
        row.title = Some(title).filter(|t| !t.trim().is_empty());
    }
    if let Some(payload) = body.payload {
        validate_payload(&payload).map_err(bad_request_s)?;
        let s = serde_json::to_string(&payload).map_err(|e| AppError::Internal(e.to_string()))?;
        row.payload_sealed =
            seal::seal(&st.key, &s).ok_or_else(|| AppError::Internal("seal payload".into()))?;
    }

    let now = unix_now();
    let saved = row.clone();
    tokio::task::spawn_blocking(move || store.save(&saved, now))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(AppError::Internal)?;
    row.updated_at = now;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(view(&st, &row))).into_response())
}

/// `DELETE /api/guilds/:guild_id/library/:id`.
pub async fn library_delete(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    headers: HeaderMap,
    Path((guild, id)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let store = store(&st)?;
    let session = crate::activity::resolve_identity(&st, &jar, &headers).await?;
    authorize_activity_webhooks(&st, session, &guild).await?;
    let removed = tokio::task::spawn_blocking(move || store.delete(&guild, &id))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(AppError::Internal)?;
    if !removed {
        return Err(not_found());
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// One entry as the API returns it: metadata plus the decrypted payload and (on
/// posted entries) the decrypted webhook execute URL. An unopenable seal (a
/// rotated SESSION_SECRET) degrades to `null` rather than failing the list.
fn view(st: &AppState, r: &Row) -> Value {
    let payload = seal::open(&st.key, &r.payload_sealed)
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(Value::Null);
    let webhook_url = r
        .webhook_sealed
        .as_deref()
        .and_then(|s| seal::open(&st.key, s))
        .map(Value::String)
        .unwrap_or(Value::Null);
    json!({
        "id": r.id,
        "guild_id": r.guild_id,
        "label": r.label,
        "title": r.title,
        "payload": payload,
        "webhook_url": webhook_url,
        "webhook_id": r.webhook_id,
        "channel_id": r.channel_id,
        "message_id": r.message_id,
        "thread_id": r.thread_id,
        "dest_label": r.dest_label,
        "created_by": r.created_by,
        "created_at": r.created_at,
        "updated_at": r.updated_at,
    })
}

/// The per-server quota as the list reports it: the plan-tier cap when
/// entitlement is on (unlimited → JSON `null`), else the store default —
/// mirroring `schedule_list_for_guild`.
async fn quota_json(st: &AppState, store: &LibraryStore, guild: &str) -> Value {
    if st.entitlements.enabled() {
        match st.entitlements.library_limit(guild).await {
            Some(n) if n == i64::MAX => Value::Null,
            Some(n) => json!(n),
            None => json!(store.max_per_guild()),
        }
    } else {
        json!(store.max_per_guild())
    }
}

fn store(st: &AppState) -> Result<Arc<LibraryStore>, AppError> {
    if !st.config.library_enabled {
        return Err(AppError::Status {
            status: StatusCode::NOT_IMPLEMENTED,
            message: "The message library isn't enabled on this deployment.".into(),
            retry_after: None,
        });
    }
    st.library.clone().ok_or(AppError::Status {
        status: StatusCode::NOT_IMPLEMENTED,
        message: "The message library isn't available on this deployment.".into(),
        retry_after: None,
    })
}

fn bad_request(message: &str) -> AppError {
    AppError::Status {
        status: StatusCode::BAD_REQUEST,
        message: message.into(),
        retry_after: None,
    }
}

fn bad_request_s(message: String) -> AppError {
    AppError::Status {
        status: StatusCode::BAD_REQUEST,
        message,
        retry_after: None,
    }
}

fn not_found() -> AppError {
    AppError::Status {
        status: StatusCode::NOT_FOUND,
        message: "No such library entry.".into(),
        retry_after: None,
    }
}

/// The over-quota content-freeze refusal (never reached on an unlimited cap —
/// `over_cap` can't be true there).
fn over_quota(limit: i64) -> AppError {
    AppError::Status {
        status: StatusCode::CONFLICT,
        message: format!(
            "This server holds more library messages than its plan allows ({limit}) — content is \
             read-only until you delete down to the limit or upgrade. Renaming and deleting still \
             work."
        ),
        retry_after: None,
    }
}

/// base62 entry id — the same unbiased construction as the schedule ids.
fn random_id() -> Option<String> {
    crate::schedule::random_base62(ID_LEN)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(tag: &str, max: u64, per_guild: u64) -> (LibraryStore, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "dweeb-library-test-{}-{tag}.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        (
            LibraryStore::open(path.to_str().unwrap(), max, per_guild).unwrap(),
            path,
        )
    }

    fn entry(guild: &str, label: &str, message_id: Option<&str>) -> NewEntry {
        NewEntry {
            guild_id: guild.into(),
            label: label.into(),
            title: None,
            payload_sealed: "sealed-payload".into(),
            webhook_sealed: Some("sealed-hook".into()),
            webhook_id: Some("42".into()),
            channel_id: Some("7".into()),
            message_id: message_id.map(str::to_string),
            thread_id: None,
            dest_label: Some("#general".into()),
            created_by: "user-1".into(),
        }
    }

    #[test]
    fn insert_list_get_delete_roundtrip() {
        let (store, path) = temp_store("roundtrip", 100, 10);
        let id = store
            .upsert(&entry("g1", "draft", None), "aaaaaaaaaa", 1_000, None)
            .unwrap();
        assert_eq!(id, "aaaaaaaaaa");
        let rows = store.list_for_guild("g1", 100).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "draft");
        // Guild-scoped get: right guild finds it, wrong guild doesn't.
        assert!(store.get("g1", &id).unwrap().is_some());
        assert!(store.get("g2", &id).unwrap().is_none());
        assert!(store.delete("g1", &id).unwrap());
        assert!(!store.delete("g1", &id).unwrap());
        assert_eq!(store.count_for_guild("g1").unwrap(), 0);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn posted_upserts_by_message_id() {
        let (store, path) = temp_store("upsert", 100, 10);
        let first = store
            .upsert(
                &entry("g1", "posted", Some("m1")),
                "id-first-x",
                1_000,
                None,
            )
            .unwrap();
        // Same guild + message: refreshes the one row, keeps its id, ignores caps.
        let mut refreshed = entry("g1", "posted", Some("m1"));
        refreshed.payload_sealed = "sealed-v2".into();
        let second = store
            .upsert(&refreshed, "id-second-x", 2_000, Some(1))
            .unwrap();
        assert_eq!(first, second);
        let rows = store.list_for_guild("g1", 100).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].payload_sealed, "sealed-v2");
        assert_eq!(rows[0].updated_at, 2_000);
        // A different message in the same guild is a fresh row.
        store
            .upsert(
                &entry("g1", "posted", Some("m2")),
                "id-third-xx",
                3_000,
                None,
            )
            .unwrap();
        assert_eq!(store.count_for_guild("g1").unwrap(), 2);
        // The same message id in a DIFFERENT guild is independent.
        store
            .upsert(
                &entry("g2", "posted", Some("m1")),
                "id-fourth-x",
                3_000,
                None,
            )
            .unwrap();
        assert_eq!(store.count_for_guild("g2").unwrap(), 1);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn per_guild_quota_gates_inserts_only() {
        let (store, path) = temp_store("quota", 100, 2);
        store
            .upsert(&entry("g1", "draft", None), "id-a", 1, None)
            .unwrap();
        store
            .upsert(&entry("g1", "draft", None), "id-b", 1, None)
            .unwrap();
        // Store default (2) reached → third insert is rejected with the cap.
        match store.upsert(&entry("g1", "draft", None), "id-c", 1, None) {
            Err(CreateError::PerGuildFull(2)) => {}
            other => panic!("expected PerGuildFull(2), got {other:?}"),
        }
        // A plan override raises it.
        store
            .upsert(&entry("g1", "draft", None), "id-c", 1, Some(3))
            .unwrap();
        // Another guild is unaffected.
        store
            .upsert(&entry("g2", "draft", None), "id-d", 1, None)
            .unwrap();
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn global_cap_answers_full() {
        let (store, path) = temp_store("full", 1, 10);
        store
            .upsert(&entry("g1", "draft", None), "id-a", 1, None)
            .unwrap();
        match store.upsert(&entry("g2", "draft", None), "id-b", 1, None) {
            Err(CreateError::Full) => {}
            other => panic!("expected Full, got {other:?}"),
        }
        // A new posted row (no existing message to refresh) is still capped.
        store
            .upsert(&entry("g1", "posted", Some("m1")), "id-c", 1, None)
            .expect_err("insert of a new posted row is still capped");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn over_cap_freezes_posted_refreshes_but_at_cap_is_fine() {
        let (store, path) = temp_store("freeze", 100, 10);
        // Fill three rows under a generous (paid-tier) override.
        for (i, mid) in ["m1", "m2", "m3"].iter().enumerate() {
            store
                .upsert(
                    &entry("g1", "posted", Some(mid)),
                    &format!("id-fill-{i}"),
                    1_000,
                    Some(10),
                )
                .unwrap();
        }
        // Downgraded to a cap of 3 — exactly AT the cap, refreshing stays fine.
        let mut refreshed = entry("g1", "posted", Some("m1"));
        refreshed.payload_sealed = "sealed-v2".into();
        store
            .upsert(&refreshed, "id-refresh-a", 2_000, Some(3))
            .unwrap();
        // Downgraded further to a cap of 2 — now OVER the cap: the refresh is
        // refused (rotating-storage guard), carrying the cap for the message.
        match store.upsert(&refreshed, "id-refresh-b", 3_000, Some(2)) {
            Err(CreateError::PerGuildFull(2)) => {}
            other => panic!("expected PerGuildFull(2), got {other:?}"),
        }
        // The frozen row kept its at-cap content, and nothing was deleted.
        let rows = store.list_for_guild("g1", 100).unwrap();
        assert_eq!(rows.len(), 3);
        let m1 = rows.iter().find(|r| r.message_id.as_deref() == Some("m1"));
        assert_eq!(m1.unwrap().payload_sealed, "sealed-v2");
        // Deleting is the way back under quota — then refreshes work again.
        let victim = rows
            .iter()
            .find(|r| r.message_id.as_deref() == Some("m3"))
            .unwrap()
            .id
            .clone();
        assert!(store.delete("g1", &victim).unwrap());
        store
            .upsert(&refreshed, "id-refresh-c", 4_000, Some(2))
            .unwrap();
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn over_cap_reports_strictly_over() {
        let (store, path) = temp_store("overcap", 100, 2);
        store
            .upsert(&entry("g1", "draft", None), "id-a", 1, None)
            .unwrap();
        store
            .upsert(&entry("g1", "draft", None), "id-b", 1, None)
            .unwrap();
        // Exactly at the store-default cap (2): not over.
        assert!(!store.over_cap("g1", None).unwrap());
        // A downgrade override below the held count: over.
        assert!(store.over_cap("g1", Some(1)).unwrap());
        // Unlimited (i64::MAX, what the entitlement hands over for Pro): never.
        assert!(!store.over_cap("g1", Some(i64::MAX)).unwrap());
        // An empty guild is never over.
        assert!(!store.over_cap("g2", Some(1)).unwrap());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn save_updates_everything_editable() {
        let (store, path) = temp_store("save", 100, 10);
        let id = store
            .upsert(&entry("g1", "posted", Some("m1")), "id-a", 1_000, None)
            .unwrap();
        let mut row = store.get("g1", &id).unwrap().unwrap();
        row.label = "draft".into();
        row.title = Some("Renamed".into());
        store.save(&row, 2_000).unwrap();
        let back = store.get("g1", &id).unwrap().unwrap();
        assert_eq!(back.label, "draft");
        assert_eq!(back.title.as_deref(), Some("Renamed"));
        assert_eq!(back.updated_at, 2_000);
        let _ = std::fs::remove_file(path);
    }
}
