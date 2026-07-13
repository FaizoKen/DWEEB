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
//! The two labels are quota'd **independently**, because they mean different
//! things:
//!
//!  - `posted` is *history*: a rolling window of the last N messages sent
//!    through DWEEB (`TierLimits::library_posted`). It syncs automatically —
//!    recording a post past the window evicts the oldest entry instead of
//!    failing, so the history is always current and auto-record can't be
//!    starved by a full shelf. Never-expire messages are the exception: their
//!    ids (fetched from the dispatcher's permanent slots, see
//!    [`permanent_message_ids`]) ride above the window — never evicted and not
//!    counted against it — so pinning a message on Discord also pins its
//!    history record. Entries can't be created by hand (a posted row always
//!    names a real Discord message) and their content can't be edited (it
//!    mirrors what was actually sent); deleting one is allowed, so a sensitive
//!    record doesn't have to wait to age out.
//!  - `draft` is the *curated shelf*: every entry was a deliberate save, gated
//!    on the plan cap (`TierLimits::library`) — full means full, delete or
//!    upgrade. Quota only ever gates creation; a downgraded server keeps every
//!    stored draft readable.

use std::collections::HashSet;
use std::path::Path as FsPath;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use crate::sqlite_pool::SqlitePool;

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
     application_id, channel_id, message_id, thread_id, dest_label, created_by, \
     created_at, updated_at";

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
    /// The custom bot a posted entry was posted as (its application id), when
    /// it wasn't DWEEB — recorded by the Activity's post/edit so a later
    /// gallery load can update the message through the *same* identity (the
    /// custom bot's connected webhook, not the DWEEB path, which can't read a
    /// foreign webhook's token). `None` = DWEEB, or a row recorded before this
    /// was tracked / by a surface that can't know it (the web posts by URL).
    pub application_id: Option<String>,
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
        application_id: r.get(7)?,
        channel_id: r.get(8)?,
        message_id: r.get(9)?,
        thread_id: r.get(10)?,
        dest_label: r.get(11)?,
        created_by: r.get(12)?,
        created_at: r.get(13)?,
        updated_at: r.get(14)?,
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
    /// See [`Row::application_id`]. `None` when the identity is DWEEB or the
    /// recording surface can't know it — an upsert refresh never *clears* a
    /// stored id with `None` (a message's authoring webhook is immutable).
    pub application_id: Option<String>,
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
    /// Per-server draft quota reached (carries the limit for the message) —
    /// 409. Never raised for posted entries: their window evicts instead.
    PerGuildFull(i64),
    Storage(String),
}

// ── Store ────────────────────────────────────────────────────────────────────

pub struct LibraryStore {
    pool: SqlitePool,
    max_entries: i64,
    /// Max saved drafts per server when plan entitlement is disabled — the
    /// standalone-deployment default the tier limits override.
    max_drafts_per_guild: i64,
    /// Posted-history window per server when plan entitlement is disabled —
    /// how many auto-recorded posts a server keeps before eviction.
    posted_per_guild: i64,
    /// Approximate total row count, kept in step with inserts/deletes so the
    /// global cap check is a load, not a `COUNT(*)`.
    count: AtomicI64,
}

impl LibraryStore {
    pub fn open(
        path: &str,
        max_entries: u64,
        max_drafts_per_guild: u64,
        posted_per_guild: u64,
    ) -> Result<Self, String> {
        if let Some(parent) = FsPath::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
            }
        }
        let pool = SqlitePool::open_default(path, |c: &Connection| {
            c.pragma_update(None, "journal_mode", "WAL")
                .map_err(|e| format!("journal_mode: {e}"))?;
            c.pragma_update(None, "synchronous", "NORMAL")
                .map_err(|e| format!("synchronous: {e}"))?;
            c.pragma_update(None, "busy_timeout", 5_000)
                .map_err(|e| format!("busy_timeout: {e}"))?;
            Ok(())
        })?;
        // Schema + migrations + initial count are one-time, so run them once on a
        // single checked-out connection rather than in the per-connection init.
        {
            let conn = pool.get();
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS library_messages (
                     id             TEXT PRIMARY KEY,
                     guild_id       TEXT NOT NULL,
                     label          TEXT NOT NULL,
                     title          TEXT,
                     payload_sealed TEXT NOT NULL,
                     webhook_sealed TEXT,
                     webhook_id     TEXT,
                     application_id TEXT,
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
            // Migrate DBs created before `application_id` existed (SQLite has no
            // ADD COLUMN IF NOT EXISTS) — which custom bot authored a posted
            // entry, so the Activity can update it through the right identity.
            let has_app: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('library_messages') \
                     WHERE name = 'application_id'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if has_app == 0 {
                conn.execute_batch("ALTER TABLE library_messages ADD COLUMN application_id TEXT;")
                    .map_err(|e| format!("migrate application_id: {e}"))?;
            }
        }
        let count: i64 = pool
            .get()
            .query_row("SELECT COUNT(*) FROM library_messages", [], |r| r.get(0))
            .map_err(|e| format!("count: {e}"))?;
        Ok(LibraryStore {
            pool,
            max_entries: max_entries as i64,
            max_drafts_per_guild: max_drafts_per_guild as i64,
            posted_per_guild: posted_per_guild as i64,
            count: AtomicI64::new(count),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.pool.get()
    }

    /// Cheap connectivity probe for the readiness endpoint: proves the DB file
    /// is open and answering (catches an unwritable volume / wedged lock) without
    /// touching any real data. Runs on the shared connection like every other
    /// call, so a probe that returns also means the store isn't dead-locked.
    pub fn ping(&self) -> Result<(), String> {
        self.lock()
            .query_row("SELECT 1", [], |_| Ok(()))
            .map_err(e2s)
    }

    /// The standalone per-server draft quota, surfaced so the list can show
    /// "used / cap" exactly the way the create path enforces it.
    pub fn max_drafts_per_guild(&self) -> i64 {
        self.max_drafts_per_guild
    }

    /// The standalone posted-history window (see [`Self::open`]).
    pub fn posted_per_guild(&self) -> i64 {
        self.posted_per_guild
    }

    /// Insert `n`, or — when it's a posted entry whose `message_id` already has
    /// a posted row in the guild — refresh that row in place (re-posting or
    /// updating a live message must never pile up duplicates).
    /// Returns the entry's id (existing on refresh, `n_id` on insert).
    ///
    /// `limit_override` is the destination server's plan-tier cap **for `n`'s
    /// label** (the posted window or the draft quota), falling back to the
    /// matching store default; the global cap always applies to inserts. The
    /// two labels enforce it differently:
    ///
    ///  - **posted** is a rolling history window: a refresh is never gated (it
    ///    doesn't grow anything), and an insert past the window *evicts the
    ///    oldest posted rows* instead of failing — so recording a post always
    ///    succeeds and a downgraded server's surplus history simply trims on
    ///    its next post. Draft rows are never touched by eviction.
    ///  - **draft** is a hard cap: at the cap, the insert is refused with
    ///    [`CreateError::PerGuildFull`]. Posted rows don't count against it.
    ///
    /// `protected` is the guild's never-expire message ids (from the
    /// dispatcher's permanent slots): those posted rows sit *above* the window
    /// — never evicted, and not consuming its slots — so marking a message
    /// never-expire also pins its history record. Only consulted on posted
    /// inserts; pass an empty set for drafts.
    pub fn upsert(
        &self,
        n: &NewEntry,
        n_id: &str,
        now: i64,
        limit_override: Option<i64>,
        protected: &HashSet<String>,
    ) -> Result<String, CreateError> {
        let conn = self.lock();
        if n.label == "posted" {
            if let Some(mid) = &n.message_id {
                let existing: Option<String> = conn
                    .query_row(
                        "SELECT id FROM library_messages \
                         WHERE guild_id=?1 AND message_id=?2 AND label='posted'",
                        params![n.guild_id, mid],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| CreateError::Storage(e.to_string()))?;
                if let Some(id) = existing {
                    // `application_id` COALESCEs like the webhook fields: a
                    // message's authoring identity never changes, so a refresh
                    // from a surface that can't know it (the web records by
                    // URL) must not blank a stamp the Activity already made.
                    conn.execute(
                        "UPDATE library_messages SET payload_sealed=?2, \
                         webhook_sealed=COALESCE(?3, webhook_sealed), \
                         webhook_id=COALESCE(?4, webhook_id), \
                         application_id=COALESCE(?5, application_id), \
                         channel_id=COALESCE(?6, channel_id), thread_id=?7, \
                         dest_label=COALESCE(?8, dest_label), \
                         title=COALESCE(?9, title), updated_at=?10 \
                         WHERE id=?1",
                        params![
                            id,
                            n.payload_sealed,
                            n.webhook_sealed,
                            n.webhook_id,
                            n.application_id,
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
        } else {
            let cap = limit_override.unwrap_or(self.max_drafts_per_guild);
            let drafts_in_guild: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM library_messages WHERE guild_id=?1 AND label='draft'",
                    [&n.guild_id],
                    |r| r.get(0),
                )
                .map_err(|e| CreateError::Storage(e.to_string()))?;
            if drafts_in_guild >= cap {
                return Err(CreateError::PerGuildFull(cap));
            }
        }
        if self.count.load(Ordering::Relaxed) >= self.max_entries {
            return Err(CreateError::Full);
        }
        conn.execute(
            "INSERT INTO library_messages \
             (id, guild_id, label, title, payload_sealed, webhook_sealed, webhook_id, \
              application_id, channel_id, message_id, thread_id, dest_label, created_by, \
              created_at, updated_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14)",
            params![
                n_id,
                n.guild_id,
                n.label,
                n.title,
                n.payload_sealed,
                n.webhook_sealed,
                n.webhook_id,
                n.application_id,
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
        if n.label == "posted" {
            let window = limit_override.unwrap_or(self.posted_per_guild);
            if window < i64::MAX {
                // Trim the history to its window, newest first (rowid breaks
                // same-second ties in insertion order). Runs after the insert
                // so "window = N" always means "the N most recent posts,
                // including this one". Walked in Rust rather than one DELETE so
                // `protected` rows (never-expire messages) can be skipped —
                // they neither evict nor count; the per-guild set is small
                // (window + permanent slots), so this stays cheap.
                let rows: Vec<(String, Option<String>)> = {
                    let mut stmt = conn
                        .prepare_cached(
                            "SELECT id, message_id FROM library_messages \
                             WHERE guild_id=?1 AND label='posted' \
                             ORDER BY updated_at DESC, rowid DESC",
                        )
                        .map_err(|e| CreateError::Storage(e.to_string()))?;
                    let iter = stmt
                        .query_map([&n.guild_id], |r| Ok((r.get(0)?, r.get(1)?)))
                        .map_err(|e| CreateError::Storage(e.to_string()))?;
                    iter.collect::<rusqlite::Result<_>>()
                        .map_err(|e| CreateError::Storage(e.to_string()))?
                };
                let mut kept: i64 = 0;
                let mut evicted: usize = 0;
                for (id, mid) in rows {
                    if mid.is_some_and(|m| protected.contains(&m)) {
                        continue;
                    }
                    kept += 1;
                    if kept > window.max(0) {
                        evicted += conn
                            .execute("DELETE FROM library_messages WHERE id=?1", [&id])
                            .map_err(|e| CreateError::Storage(e.to_string()))?;
                    }
                }
                if evicted > 0 {
                    self.count.fetch_sub(evicted as i64, Ordering::Relaxed);
                }
            }
        }
        Ok(n_id.to_string())
    }

    /// A server's entries, most recently touched first.
    pub fn list_for_guild(&self, guild: &str, limit: usize) -> Result<Vec<Row>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare_cached(&format!(
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
             webhook_sealed=?5, webhook_id=?6, application_id=?7, channel_id=?8, \
             message_id=?9, thread_id=?10, dest_label=?11, updated_at=?12 WHERE id=?1",
            params![
                row.id,
                row.label,
                row.title,
                row.payload_sealed,
                row.webhook_sealed,
                row.webhook_id,
                row.application_id,
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

    /// Whether a server holds *more drafts* than its cap — the over-quota
    /// content-freeze condition (see [`Self::upsert`]). Exactly at the cap is
    /// fine: the stored set is what the plan allows, only growth beyond it
    /// isn't. Posted rows never count — their window self-corrects by
    /// eviction, so there's nothing to freeze.
    pub fn drafts_over_cap(
        &self,
        guild: &str,
        limit_override: Option<i64>,
    ) -> Result<bool, String> {
        let cap = limit_override.unwrap_or(self.max_drafts_per_guild);
        Ok(self.counts_for_guild(guild)?.1 > cap)
    }

    /// How many entries a server holds, as `(posted, drafts)` — the list's
    /// per-bucket `used` figures.
    pub fn counts_for_guild(&self, guild: &str) -> Result<(i64, i64), String> {
        let conn = self.lock();
        conn.query_row(
            "SELECT COALESCE(SUM(label='posted'),0), COALESCE(SUM(label='draft'),0) \
             FROM library_messages WHERE guild_id=?1",
            [guild],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(e2s)
    }
}

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ── Never-expire protection ──────────────────────────────────────────────────

/// The guild's never-expire message ids, from the dispatcher (the permanent
/// slots' owner) — the posted rows the rolling window must not evict, so
/// marking a message never-expire also pins its library record. Suspended
/// grants (over a downgraded plan cap) are included: the grant still exists
/// and upgrading restores it, so its history shouldn't roll off meanwhile.
/// Best-effort: no dispatcher configured, or any error, degrades to an empty
/// set — plain window behaviour, never a failed record.
pub async fn permanent_message_ids(
    dispatcher: Option<&Arc<crate::routes::DispatcherApi>>,
    guild: &str,
) -> HashSet<String> {
    let Some(api) = dispatcher else {
        return HashSet::new();
    };
    let resp = match api
        .http
        .get(format!("{}/permanent/{guild}", api.base))
        .bearer_auth(&api.token)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            tracing::warn!(target: "library", status = %r.status(), "permanent lookup failed");
            return HashSet::new();
        }
        Err(e) => {
            tracing::warn!(target: "library", "permanent lookup unreachable: {e}");
            return HashSet::new();
        }
    };
    let Ok(v) = resp.json::<Value>().await else {
        return HashSet::new();
    };
    v.get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|i| i.get("message_id").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
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
    application_id: Option<&str>,
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
        // The custom bot the message was posted as (`None` = DWEEB) — what
        // lets a later gallery load update it through the same identity.
        application_id: application_id.map(str::to_string),
        channel_id: channel_id.map(str::to_string),
        message_id: Some(message_id.to_string()),
        thread_id: thread_id.map(str::to_string),
        dest_label: dest_label.map(str::to_string),
        created_by: created_by.to_string(),
    };
    let limit_override = st.entitlements.library_posted_limit(guild).await;
    let protected = permanent_message_ids(st.dispatcher.as_ref(), guild).await;
    let store = Arc::clone(store);
    let id = match random_id() {
        Some(id) => id,
        None => return,
    };
    let now = unix_now();
    let res =
        tokio::task::spawn_blocking(move || store.upsert(&n, &id, now, limit_override, &protected))
            .await;
    match res {
        Ok(Ok(_)) => {}
        // The posted window evicts instead of filling, so only the global
        // capacity cap can still refuse — an expected steady state, not an
        // error (the send itself succeeded).
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
    dispatcher: Option<&Arc<crate::routes::DispatcherApi>>,
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
        // Schedules always fire as DWEEB (a custom bot's roaming webhook could
        // have drifted to another channel by fire time).
        application_id: None,
        channel_id: channel_id.map(str::to_string),
        message_id: Some(message_id.to_string()),
        thread_id: thread_id.map(str::to_string),
        dest_label: dest_label.map(str::to_string),
        // A schedule can outlive its creator's session; fall back to a stable
        // marker so the row still says where it came from.
        created_by: created_by.unwrap_or("schedule").to_string(),
    };
    let limit_override = entitlements.library_posted_limit(guild).await;
    let protected = permanent_message_ids(dispatcher, guild).await;
    let Some(id) = random_id() else { return };
    let now = unix_now();
    let store = Arc::clone(store);
    let res =
        tokio::task::spawn_blocking(move || store.upsert(&n, &id, now, limit_override, &protected))
            .await;
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
    let posted_cap = posted_cap(&st, store.as_ref(), &guild).await;
    let draft_cap = draft_cap(&st, store.as_ref(), &guild).await;
    let g = guild.clone();
    let s = Arc::clone(&store);
    let (posted_used, draft_used) = tokio::task::spawn_blocking(move || s.counts_for_guild(&g))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(AppError::Internal)?;
    let g = guild.clone();
    let rows = tokio::task::spawn_blocking(move || store.list_for_guild(&g, LIST_LIMIT))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(AppError::Internal)?;
    let items: Vec<Value> = rows.iter().map(|r| view(&st, r)).collect();
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        // `used`/`quota` are the pre-split totals kept for cached frontends;
        // the buckets are the real contract (quota `null` = unlimited).
        Json(json!({
            "items": items,
            "used": rows.len(),
            "quota": match (posted_cap, draft_cap) {
                (Some(p), Some(d)) => json!(p + d),
                _ => Value::Null,
            },
            "posted": { "used": posted_used, "quota": cap_json(posted_cap) },
            "drafts": { "used": draft_used, "quota": cap_json(draft_cap) },
        })),
    )
        .into_response())
}

/// `POST /api/guilds/:guild_id/library` — store a message. A `posted` entry is
/// the record of a real Discord message (its `message_id` is required) and
/// upserts into the rolling history window — re-posting refreshes its one row,
/// a new post past the window evicts the oldest. A `draft` inserts, gated on
/// the server's plan quota.
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
    // The posted history records what was actually sent — an entry that names
    // no Discord message can't be one, and letting it through would make the
    // sync-only history hand-curated.
    if body.label == "posted" && body.message_id.as_deref().unwrap_or("").is_empty() {
        return Err(bad_request(
            "a posted entry records a sent message and needs its message_id — save a draft instead",
        ));
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
        // Manual creates come from surfaces that post by webhook URL and can't
        // know the authoring app; an upsert refresh keeps any existing stamp.
        application_id: None,
        channel_id: body.channel_id.filter(|v| !v.is_empty()),
        message_id: body.message_id.filter(|v| !v.is_empty()),
        thread_id: body.thread_id.filter(|v| !v.is_empty()),
        dest_label: body.dest_label.filter(|l| !l.trim().is_empty()),
        created_by: session.uid,
    };
    // The override is the plan cap for *this entry's bucket* — the posted
    // window or the draft quota. Posted inserts also carry the guild's
    // never-expire ids so the window trim can't roll a pinned message off.
    let (limit_override, protected) = if n.label == "posted" {
        (
            st.entitlements.library_posted_limit(&guild).await,
            permanent_message_ids(st.dispatcher.as_ref(), &guild).await,
        )
    } else {
        (st.entitlements.library_limit(&guild).await, HashSet::new())
    };
    let id = random_id().ok_or_else(|| AppError::Internal("rng".into()))?;
    let now = unix_now();
    let s = Arc::clone(&store);
    let res =
        tokio::task::spawn_blocking(move || s.upsert(&n, &id, now, limit_override, &protected))
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
                "This server's saved messages are full ({limit}) — remove one to save another, or upgrade the server's plan for more space."
            ),
            retry_after: None,
        }),
        Err(CreateError::Storage(e)) => Err(AppError::Internal(format!("library store: {e}"))),
    }
}

/// `PATCH /api/guilds/:guild_id/library/:id` — rename an entry, or save new
/// content over a draft. Labels are fixed at creation (history stays history,
/// drafts stay drafts), and a posted entry's content is read-only — it mirrors
/// what was actually sent, so the only way to change it is to send again.
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

    if body.payload.is_some() {
        // History is sync-only: a posted entry's content mirrors the sent
        // message and can't be rewritten by hand.
        if row.label == "posted" {
            return Err(bad_request(
                "a posted entry's content syncs from what was sent and can't be edited — save a draft instead",
            ));
        }
        // Over-quota content freeze (the PATCH twin of the create gate): while
        // the server holds more drafts than its plan cap, rewriting a draft's
        // *content* is refused — otherwise a downgraded server's surplus rows
        // would work as rotating storage. Renaming stays allowed (it changes
        // no content), as do reading and deleting.
        let limit_override = st.entitlements.library_limit(&guild).await;
        let s = Arc::clone(&store);
        let g = guild.clone();
        let over = tokio::task::spawn_blocking(move || s.drafts_over_cap(&g, limit_override))
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?
            .map_err(AppError::Internal)?;
        if over {
            return Err(over_quota(
                limit_override.unwrap_or(store.max_drafts_per_guild()),
            ));
        }
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
        "application_id": r.application_id,
        "channel_id": r.channel_id,
        "message_id": r.message_id,
        "thread_id": r.thread_id,
        "dest_label": r.dest_label,
        "created_by": r.created_by,
        "created_at": r.created_at,
        "updated_at": r.updated_at,
    })
}

/// A server's posted-history window as the list reports it: the plan-tier cap
/// when entitlement is on, else the store default. `None` = unlimited.
async fn posted_cap(st: &AppState, store: &LibraryStore, guild: &str) -> Option<i64> {
    let cap = st
        .entitlements
        .library_posted_limit(guild)
        .await
        .unwrap_or(store.posted_per_guild());
    (cap != i64::MAX).then_some(cap)
}

/// A server's saved-draft quota as the list reports it. `None` = unlimited.
async fn draft_cap(st: &AppState, store: &LibraryStore, guild: &str) -> Option<i64> {
    let cap = st
        .entitlements
        .library_limit(guild)
        .await
        .unwrap_or(store.max_drafts_per_guild());
    (cap != i64::MAX).then_some(cap)
}

/// A cap as the API reports it: the number, or JSON `null` for unlimited.
fn cap_json(cap: Option<i64>) -> Value {
    match cap {
        Some(n) => json!(n),
        None => Value::Null,
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
/// `drafts_over_cap` can't be true there).
fn over_quota(limit: i64) -> AppError {
    AppError::Status {
        status: StatusCode::CONFLICT,
        message: format!(
            "This server holds more saved messages than its plan allows ({limit}) — their content \
             is read-only until you delete down to the limit or upgrade. Renaming and deleting \
             still work."
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

    fn temp_store(
        tag: &str,
        max: u64,
        drafts_per_guild: u64,
        posted_per_guild: u64,
    ) -> (LibraryStore, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "dweeb-library-test-{}-{tag}.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        (
            LibraryStore::open(
                path.to_str().unwrap(),
                max,
                drafts_per_guild,
                posted_per_guild,
            )
            .unwrap(),
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
            application_id: None,
            channel_id: Some("7".into()),
            message_id: message_id.map(str::to_string),
            thread_id: None,
            dest_label: Some("#general".into()),
            created_by: "user-1".into(),
        }
    }

    /// `upsert` with no never-expire pins — what most tests exercise.
    fn upsert(
        store: &LibraryStore,
        n: &NewEntry,
        n_id: &str,
        now: i64,
        limit_override: Option<i64>,
    ) -> Result<String, CreateError> {
        store.upsert(n, n_id, now, limit_override, &HashSet::new())
    }

    #[test]
    fn insert_list_get_delete_roundtrip() {
        let (store, path) = temp_store("roundtrip", 100, 10, 10);
        let id = upsert(
            &store,
            &entry("g1", "draft", None),
            "aaaaaaaaaa",
            1_000,
            None,
        )
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
        assert_eq!(store.counts_for_guild("g1").unwrap(), (0, 0));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn posted_upserts_by_message_id() {
        let (store, path) = temp_store("upsert", 100, 10, 10);
        let first = upsert(
            &store,
            &entry("g1", "posted", Some("m1")),
            "id-first-x",
            1_000,
            None,
        )
        .unwrap();
        // Same guild + message: refreshes the one row, keeps its id — even
        // under a window override the guild currently exceeds.
        let mut refreshed = entry("g1", "posted", Some("m1"));
        refreshed.payload_sealed = "sealed-v2".into();
        let second = upsert(&store, &refreshed, "id-second-x", 2_000, Some(1)).unwrap();
        assert_eq!(first, second);
        let rows = store.list_for_guild("g1", 100).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].payload_sealed, "sealed-v2");
        assert_eq!(rows[0].updated_at, 2_000);
        // A different message in the same guild is a fresh row.
        upsert(
            &store,
            &entry("g1", "posted", Some("m2")),
            "id-third-xx",
            3_000,
            None,
        )
        .unwrap();
        assert_eq!(store.counts_for_guild("g1").unwrap(), (2, 0));
        // The same message id in a DIFFERENT guild is independent.
        upsert(
            &store,
            &entry("g2", "posted", Some("m1")),
            "id-fourth-x",
            3_000,
            None,
        )
        .unwrap();
        assert_eq!(store.counts_for_guild("g2").unwrap(), (1, 0));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn migrates_db_without_application_id_column() {
        // Simulate a DB created before `application_id` existed (the prod
        // case), then open it through the store — the migration must add the
        // column without losing existing rows, and a legacy row reads as NULL.
        let path = std::env::temp_dir().join(format!(
            "dweeb-library-test-{}-migrate.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE library_messages (
                     id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, label TEXT NOT NULL,
                     title TEXT, payload_sealed TEXT NOT NULL, webhook_sealed TEXT,
                     webhook_id TEXT, channel_id TEXT, message_id TEXT, thread_id TEXT,
                     dest_label TEXT, created_by TEXT NOT NULL,
                     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
                 );
                 INSERT INTO library_messages
                   (id, guild_id, label, payload_sealed, message_id, created_by,
                    created_at, updated_at)
                 VALUES ('legacyxxxx','g1','posted','sealed','m1','user-1',1,1);",
            )
            .unwrap();
        }
        let store = LibraryStore::open(path.to_str().unwrap(), 100, 10, 10).unwrap();
        let row = store.get("g1", "legacyxxxx").unwrap().unwrap();
        assert_eq!(row.application_id, None);
        // New rows can carry the stamp, and a refresh backfills the legacy row.
        let mut n = entry("g1", "posted", Some("m1"));
        n.application_id = Some("777".into());
        store
            .upsert(&n, "id-new-xxxx", 2_000, None, &HashSet::new())
            .unwrap();
        let row = store.get("g1", "legacyxxxx").unwrap().unwrap();
        assert_eq!(row.application_id.as_deref(), Some("777"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn posted_refresh_keeps_but_can_backfill_application_id() {
        let (store, path) = temp_store("appid", 100, 10, 10);
        // Posted as a custom bot — the Activity stamps the authoring app.
        let mut n = entry("g1", "posted", Some("m1"));
        n.application_id = Some("777".into());
        let id = upsert(&store, &n, "id-appid-xx", 1_000, None).unwrap();
        // A refresh from a surface that can't know the identity (the web
        // records by webhook URL — `application_id: None`) must not blank the
        // stamp: a message's authoring webhook never changes.
        let ignorant = entry("g1", "posted", Some("m1"));
        upsert(&store, &ignorant, "id-other-xx", 2_000, None).unwrap();
        let row = store.get("g1", &id).unwrap().unwrap();
        assert_eq!(row.application_id.as_deref(), Some("777"));
        // And a legacy row recorded before the stamp existed picks it up from
        // the first refresh that knows it (COALESCE takes the new non-NULL).
        let legacy = upsert(
            &store,
            &entry("g1", "posted", Some("m2")),
            "id-legacy-xx",
            3_000,
            None,
        )
        .unwrap();
        let mut knowing = entry("g1", "posted", Some("m2"));
        knowing.application_id = Some("888".into());
        upsert(&store, &knowing, "id-know-xxx", 4_000, None).unwrap();
        let row = store.get("g1", &legacy).unwrap().unwrap();
        assert_eq!(row.application_id.as_deref(), Some("888"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn draft_cap_gates_drafts_only() {
        let (store, path) = temp_store("quota", 100, 2, 10);
        // Posted history never counts against the draft cap.
        upsert(&store, &entry("g1", "posted", Some("m1")), "id-p1", 1, None).unwrap();
        upsert(&store, &entry("g1", "posted", Some("m2")), "id-p2", 1, None).unwrap();
        upsert(&store, &entry("g1", "draft", None), "id-a", 1, None).unwrap();
        upsert(&store, &entry("g1", "draft", None), "id-b", 1, None).unwrap();
        // Store default (2 drafts) reached → third draft is rejected with the cap.
        match upsert(&store, &entry("g1", "draft", None), "id-c", 1, None) {
            Err(CreateError::PerGuildFull(2)) => {}
            other => panic!("expected PerGuildFull(2), got {other:?}"),
        }
        // A plan override raises it.
        upsert(&store, &entry("g1", "draft", None), "id-c", 1, Some(3)).unwrap();
        // Another guild is unaffected.
        upsert(&store, &entry("g2", "draft", None), "id-d", 1, None).unwrap();
        // And the full draft shelf never blocks recording a post.
        upsert(&store, &entry("g1", "posted", Some("m3")), "id-p3", 2, None).unwrap();
        assert_eq!(store.counts_for_guild("g1").unwrap(), (3, 3));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn posted_window_evicts_oldest_and_leaves_drafts() {
        let (store, path) = temp_store("window", 100, 10, 2);
        upsert(&store, &entry("g1", "draft", None), "id-draft-a", 500, None).unwrap();
        upsert(
            &store,
            &entry("g1", "posted", Some("m1")),
            "id-p1",
            1_000,
            None,
        )
        .unwrap();
        upsert(
            &store,
            &entry("g1", "posted", Some("m2")),
            "id-p2",
            2_000,
            None,
        )
        .unwrap();
        // Third post past the window of 2: recorded, the OLDEST post evicted,
        // the draft untouched.
        upsert(
            &store,
            &entry("g1", "posted", Some("m3")),
            "id-p3",
            3_000,
            None,
        )
        .unwrap();
        assert_eq!(store.counts_for_guild("g1").unwrap(), (2, 1));
        let rows = store.list_for_guild("g1", 100).unwrap();
        let message_ids: Vec<_> = rows.iter().filter_map(|r| r.message_id.clone()).collect();
        assert!(message_ids.contains(&"m2".to_string()));
        assert!(message_ids.contains(&"m3".to_string()));
        assert!(!message_ids.contains(&"m1".to_string()));
        // Refreshing an existing post bumps it to the front of the window
        // instead of consuming a slot.
        upsert(
            &store,
            &entry("g1", "posted", Some("m2")),
            "id-refresh",
            4_000,
            None,
        )
        .unwrap();
        assert_eq!(store.counts_for_guild("g1").unwrap(), (2, 1));
        // A downgrade (window 2 → 1) trims on the NEXT post, not before.
        upsert(
            &store,
            &entry("g1", "posted", Some("m4")),
            "id-p4",
            5_000,
            Some(1),
        )
        .unwrap();
        let rows = store.list_for_guild("g1", 100).unwrap();
        let posted: Vec<_> = rows.iter().filter(|r| r.label == "posted").collect();
        assert_eq!(posted.len(), 1);
        assert_eq!(posted[0].message_id.as_deref(), Some("m4"));
        // The eviction kept the global counter honest: 1 posted + 1 draft.
        assert_eq!(store.counts_for_guild("g1").unwrap(), (1, 1));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn never_expire_posts_ride_above_the_window() {
        let (store, path) = temp_store("pinned", 100, 10, 2);
        let pins: HashSet<String> = ["m1".to_string()].into();
        store
            .upsert(
                &entry("g1", "posted", Some("m1")),
                "id-p1",
                1_000,
                None,
                &pins,
            )
            .unwrap();
        store
            .upsert(
                &entry("g1", "posted", Some("m2")),
                "id-p2",
                2_000,
                None,
                &pins,
            )
            .unwrap();
        store
            .upsert(
                &entry("g1", "posted", Some("m3")),
                "id-p3",
                3_000,
                None,
                &pins,
            )
            .unwrap();
        // m1 is the oldest but pinned: it neither evicts nor occupies a window
        // slot, so the window of 2 holds m2 + m3 and nothing was trimmed.
        assert_eq!(store.counts_for_guild("g1").unwrap(), (3, 0));
        // The next post past the window evicts the oldest UNPINNED row (m2).
        store
            .upsert(
                &entry("g1", "posted", Some("m4")),
                "id-p4",
                4_000,
                None,
                &pins,
            )
            .unwrap();
        let message_ids: Vec<_> = store
            .list_for_guild("g1", 100)
            .unwrap()
            .iter()
            .filter_map(|r| r.message_id.clone())
            .collect();
        assert!(message_ids.contains(&"m1".to_string()));
        assert!(!message_ids.contains(&"m2".to_string()));
        assert!(message_ids.contains(&"m3".to_string()));
        assert!(message_ids.contains(&"m4".to_string()));
        // Once the pin is gone (slot freed), the row rejoins the window and the
        // next post trims it like any other.
        store
            .upsert(
                &entry("g1", "posted", Some("m5")),
                "id-p5",
                5_000,
                None,
                &HashSet::new(),
            )
            .unwrap();
        let message_ids: Vec<_> = store
            .list_for_guild("g1", 100)
            .unwrap()
            .iter()
            .filter_map(|r| r.message_id.clone())
            .collect();
        assert_eq!(message_ids.len(), 2);
        assert!(message_ids.contains(&"m4".to_string()));
        assert!(message_ids.contains(&"m5".to_string()));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn unlimited_window_never_evicts() {
        let (store, path) = temp_store("nowindow", 100, 10, 1);
        for (i, mid) in ["m1", "m2", "m3"].iter().enumerate() {
            upsert(
                &store,
                &entry("g1", "posted", Some(mid)),
                &format!("id-fill-{i}"),
                1_000 + i as i64,
                Some(i64::MAX),
            )
            .unwrap();
        }
        assert_eq!(store.counts_for_guild("g1").unwrap(), (3, 0));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn global_cap_answers_full() {
        let (store, path) = temp_store("full", 1, 10, 10);
        upsert(&store, &entry("g1", "draft", None), "id-a", 1, None).unwrap();
        match upsert(&store, &entry("g2", "draft", None), "id-b", 1, None) {
            Err(CreateError::Full) => {}
            other => panic!("expected Full, got {other:?}"),
        }
        // A new posted row (no existing message to refresh) is still capped —
        // the global bound protects the disk, unlike the per-guild window.
        upsert(&store, &entry("g1", "posted", Some("m1")), "id-c", 1, None)
            .expect_err("insert of a new posted row is still capped");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn drafts_over_cap_ignores_posted_rows() {
        let (store, path) = temp_store("overcap", 100, 2, 10);
        upsert(&store, &entry("g1", "posted", Some("m1")), "id-p1", 1, None).unwrap();
        upsert(&store, &entry("g1", "draft", None), "id-a", 1, None).unwrap();
        upsert(&store, &entry("g1", "draft", None), "id-b", 1, None).unwrap();
        // Exactly at the store-default draft cap (2): not over — the posted
        // row doesn't count.
        assert!(!store.drafts_over_cap("g1", None).unwrap());
        // A downgrade override below the held draft count: over.
        assert!(store.drafts_over_cap("g1", Some(1)).unwrap());
        // Unlimited (i64::MAX, what the entitlement hands over for Pro): never.
        assert!(!store.drafts_over_cap("g1", Some(i64::MAX)).unwrap());
        // An empty guild is never over.
        assert!(!store.drafts_over_cap("g2", Some(1)).unwrap());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn save_updates_everything_editable() {
        let (store, path) = temp_store("save", 100, 10, 10);
        let id = upsert(
            &store,
            &entry("g1", "posted", Some("m1")),
            "id-a",
            1_000,
            None,
        )
        .unwrap();
        let mut row = store.get("g1", &id).unwrap().unwrap();
        row.title = Some("Renamed".into());
        store.save(&row, 2_000).unwrap();
        let back = store.get("g1", &id).unwrap().unwrap();
        assert_eq!(back.title.as_deref(), Some("Renamed"));
        assert_eq!(back.updated_at, 2_000);
        let _ = std::fs::remove_file(path);
    }
}
