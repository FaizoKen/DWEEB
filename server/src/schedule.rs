//! Scheduled posts: the SQLite-backed job store + the HTTP API.
//!
//! A scheduled post is the opt-in exception to DWEEB's "nothing leaves your
//! browser" rule, exactly like a short link: to fire while the browser is
//! closed, the server must hold the destination webhook URL and the message
//! payload until run time. Both are **sealed at rest** (`seal.rs`, AES-256-GCM
//! under the proxy's cookie key) so a leak of this database alone yields neither
//! a usable webhook nor the message; the worker opens them only to send.
//!
//! Ownership is hybrid. Every row carries an unguessable **manage token** (only
//! its SHA-256 is stored); the browser keeps the token in `localStorage`, so an
//! anonymous creator can manage the schedule with no account. When the creator
//! was signed in, the row is also stamped with their Discord user id, so they
//! can list/manage it across devices via the session cookie. Either capability
//! authorizes a read/edit/cancel.
//!
//! The worker (`schedule_worker.rs`) drains due rows on a timer, modelled on the
//! self-role temporary-role reaper: a bounded batch per tick, an atomic
//! `active → sending` claim with a lease so a crashed worker's rows are
//! reclaimed, and a transient-vs-permanent failure split.

use std::path::Path as FsPath;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::PrivateCookieJar;
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::routes::{current_session, AppState};
use crate::schedule_rule::{next_after, Recurrence};
use crate::schedule_validate::{
    is_snowflake, parse_tz, validate_dest_label, validate_payload, validate_recurrence,
    validate_title, validate_webhook, webhook_id,
};
use crate::seal;

/// base62, URL-clean — same alphabet as the short-link ids.
const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/// Public schedule id length (62^10 ≈ 8×10^17 — collisions are a non-event).
const ID_LEN: usize = 10;
/// Manage-token length — the bearer capability, so longer than the id.
const TOKEN_LEN: usize = 40;
/// How many of a signed-in user's schedules a list returns.
const LIST_LIMIT: usize = 200;

/// All columns, in the order [`row_from`] reads them.
const COLS: &str = "id, manage_token_hash, owner_user_id, webhook_id, webhook_sealed, thread_id, \
     payload_sealed, title, dest_label, tz, recurrence_json, next_run_at, status, lease_until, \
     attempts, last_status, last_error, last_run_at, last_message_id, runs_count, end_at, \
     max_runs, created_at, updated_at, guild_id, make_permanent, last_channel_id";

// ── Row model ────────────────────────────────────────────────────────────────

/// A full stored schedule. `Clone` so a handler can read-modify-write it.
#[derive(Clone)]
pub struct Row {
    pub id: String,
    pub manage_token_hash: String,
    pub owner_user_id: Option<String>,
    pub webhook_id: String,
    pub webhook_sealed: String,
    pub thread_id: Option<String>,
    pub payload_sealed: String,
    pub title: Option<String>,
    pub dest_label: Option<String>,
    pub tz: String,
    pub recurrence_json: String,
    pub next_run_at: i64,
    pub status: String,
    pub attempts: i64,
    pub last_status: Option<i64>,
    pub last_error: Option<String>,
    pub last_run_at: Option<i64>,
    pub last_message_id: Option<String>,
    /// The channel (or thread) the last run posted into — paired with
    /// `last_message_id` it forms a direct Discord link in the management UI.
    pub last_channel_id: Option<String>,
    pub runs_count: i64,
    pub end_at: Option<i64>,
    pub max_runs: Option<i64>,
    pub created_at: i64,
    /// Destination guild, cached at creation so a server manager can list every
    /// schedule for their server. None when the webhook's guild wasn't known.
    pub guild_id: Option<String>,
    /// The message carries interactive components and the creator asked to keep
    /// them from expiring: when it fires, the worker spends one of the guild's
    /// never-expire slots on the freshly-posted message (see `schedule_worker`).
    /// Only honourable when `guild_id` is known and the dispatcher is configured.
    pub make_permanent: bool,
}

fn row_from(r: &rusqlite::Row) -> rusqlite::Result<Row> {
    Ok(Row {
        id: r.get(0)?,
        manage_token_hash: r.get(1)?,
        owner_user_id: r.get(2)?,
        webhook_id: r.get(3)?,
        webhook_sealed: r.get(4)?,
        thread_id: r.get(5)?,
        payload_sealed: r.get(6)?,
        title: r.get(7)?,
        dest_label: r.get(8)?,
        tz: r.get(9)?,
        recurrence_json: r.get(10)?,
        next_run_at: r.get(11)?,
        status: r.get(12)?,
        // 13 = lease_until — internal to the worker, not carried on `Row`.
        attempts: r.get(14)?,
        last_status: r.get(15)?,
        last_error: r.get(16)?,
        last_run_at: r.get(17)?,
        last_message_id: r.get(18)?,
        runs_count: r.get(19)?,
        end_at: r.get(20)?,
        max_runs: r.get(21)?,
        created_at: r.get(22)?,
        // 23 = updated_at — not needed in memory.
        guild_id: r.get(24)?,
        make_permanent: r.get::<_, i64>(25)? != 0,
        last_channel_id: r.get(26)?,
    })
}

/// The fields a worker needs to fire one occurrence.
pub struct ClaimedJob {
    pub id: String,
    pub webhook_id: String,
    pub webhook_sealed: String,
    pub thread_id: Option<String>,
    pub payload_sealed: String,
    pub tz: String,
    pub recurrence_json: String,
    pub end_at: Option<i64>,
    pub max_runs: Option<i64>,
    pub runs_count: i64,
    pub attempts: i64,
    /// Destination guild, needed to spend a never-expire slot after posting.
    pub guild_id: Option<String>,
    /// Whether to make the posted message permanent (claim a slot). Honoured
    /// only when `guild_id` is set and the dispatcher is configured.
    pub make_permanent: bool,
    /// The signed-in creator, recorded as `added_by` on the slot grant (audit).
    pub owner_user_id: Option<String>,
}

/// Everything `create` needs (secrets already sealed by the handler).
pub struct NewSchedule {
    pub id: String,
    pub manage_token_hash: String,
    pub owner_user_id: Option<String>,
    pub webhook_id: String,
    pub webhook_sealed: String,
    pub thread_id: Option<String>,
    pub payload_sealed: String,
    pub title: Option<String>,
    pub dest_label: Option<String>,
    pub tz: String,
    pub recurrence_json: String,
    pub next_run_at: i64,
    pub end_at: Option<i64>,
    pub max_runs: Option<i64>,
    pub created_at: i64,
    pub guild_id: Option<String>,
    pub make_permanent: bool,
}

#[derive(Debug)]
pub enum CreateError {
    /// Global row cap reached — answer 503, existing schedules keep running.
    Full,
    /// Per-webhook cap reached — answer 409.
    PerWebhookFull,
    /// Per-server quota reached (carries the limit for the message) — answer 409.
    PerGuildFull(i64),
    Storage(String),
}

// ── Store ────────────────────────────────────────────────────────────────────

pub struct ScheduleStore {
    conn: Mutex<Connection>,
    max_entries: i64,
    max_per_webhook: i64,
    /// Max active schedules per destination server — the user-facing quota.
    max_per_guild: i64,
    /// Approximate total row count, kept in step with inserts/deletes so the cap
    /// check is a load, not a `COUNT(*)`.
    count: AtomicI64,
}

impl ScheduleStore {
    pub fn open(
        path: &str,
        max_entries: u64,
        max_per_webhook: u64,
        max_per_guild: u64,
    ) -> Result<Self, String> {
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
            "CREATE TABLE IF NOT EXISTS scheduled_posts (
                 id                TEXT PRIMARY KEY,
                 manage_token_hash TEXT NOT NULL,
                 owner_user_id     TEXT,
                 webhook_id        TEXT NOT NULL,
                 webhook_sealed    TEXT NOT NULL,
                 thread_id         TEXT,
                 payload_sealed    TEXT NOT NULL,
                 title             TEXT,
                 dest_label        TEXT,
                 tz                TEXT NOT NULL,
                 recurrence_json   TEXT NOT NULL,
                 next_run_at       INTEGER NOT NULL,
                 status            TEXT NOT NULL,
                 lease_until       INTEGER,
                 attempts          INTEGER NOT NULL DEFAULT 0,
                 last_status       INTEGER,
                 last_error        TEXT,
                 last_run_at       INTEGER,
                 last_message_id   TEXT,
                 runs_count        INTEGER NOT NULL DEFAULT 0,
                 end_at            INTEGER,
                 max_runs          INTEGER,
                 created_at        INTEGER NOT NULL,
                 updated_at        INTEGER NOT NULL,
                 guild_id          TEXT,
                 make_permanent    INTEGER NOT NULL DEFAULT 0,
                 last_channel_id   TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_sched_due ON scheduled_posts(status, next_run_at);
             CREATE INDEX IF NOT EXISTS idx_sched_owner ON scheduled_posts(owner_user_id);
             CREATE INDEX IF NOT EXISTS idx_sched_webhook ON scheduled_posts(webhook_id);",
        )
        .map_err(|e| format!("schema: {e}"))?;
        // Migrate DBs created before the `guild_id` column existed (SQLite has no
        // ADD COLUMN IF NOT EXISTS), then index it for the per-server list.
        let has_guild: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('scheduled_posts') WHERE name = 'guild_id'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if has_guild == 0 {
            conn.execute_batch("ALTER TABLE scheduled_posts ADD COLUMN guild_id TEXT;")
                .map_err(|e| format!("migrate guild_id: {e}"))?;
        }
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_sched_guild ON scheduled_posts(guild_id);",
        )
        .map_err(|e| format!("index guild_id: {e}"))?;
        // Migrate DBs created before the `make_permanent` column existed.
        let has_perm: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('scheduled_posts') \
                 WHERE name = 'make_permanent'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if has_perm == 0 {
            conn.execute_batch(
                "ALTER TABLE scheduled_posts ADD COLUMN make_permanent INTEGER NOT NULL DEFAULT 0;",
            )
            .map_err(|e| format!("migrate make_permanent: {e}"))?;
        }
        // Migrate DBs created before `last_channel_id` (powers the direct
        // "View on Discord" link for posted schedules).
        let has_channel: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('scheduled_posts') \
                 WHERE name = 'last_channel_id'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if has_channel == 0 {
            conn.execute_batch("ALTER TABLE scheduled_posts ADD COLUMN last_channel_id TEXT;")
                .map_err(|e| format!("migrate last_channel_id: {e}"))?;
        }
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM scheduled_posts", [], |r| r.get(0))
            .map_err(|e| format!("count: {e}"))?;
        Ok(ScheduleStore {
            conn: Mutex::new(conn),
            max_entries: max_entries as i64,
            max_per_webhook: max_per_webhook as i64,
            max_per_guild: max_per_guild as i64,
            count: AtomicI64::new(count),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The per-server active-schedule quota, surfaced so the management UI can
    /// show "used / cap" the way the create path enforces it.
    pub fn max_per_guild(&self) -> i64 {
        self.max_per_guild
    }

    pub fn create(&self, n: &NewSchedule) -> Result<(), CreateError> {
        self.create_with_limit(n, None)
    }

    /// Like [`create`], but the per-server quota is `limit_override` when given
    /// (the acting user's plan-tier limit) instead of the store default. `None`
    /// keeps the configured `max_per_guild` — used when plan entitlement is
    /// disabled, so a standalone deployment is unchanged.
    pub fn create_with_limit(
        &self,
        n: &NewSchedule,
        limit_override: Option<i64>,
    ) -> Result<(), CreateError> {
        if self.count.load(Ordering::Relaxed) >= self.max_entries {
            return Err(CreateError::Full);
        }
        let per_guild_cap = limit_override.unwrap_or(self.max_per_guild);
        let conn = self.lock();
        let active: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM scheduled_posts \
                 WHERE webhook_id = ?1 AND status IN ('active','sending','paused')",
                [&n.webhook_id],
                |r| r.get(0),
            )
            .map_err(|e| CreateError::Storage(e.to_string()))?;
        if active >= self.max_per_webhook {
            return Err(CreateError::PerWebhookFull);
        }
        // Per-server quota — the user-facing limit. Only enforceable when the
        // destination guild is known (the normal picker/verified-webhook flow).
        if let Some(guild) = &n.guild_id {
            let in_guild: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM scheduled_posts \
                     WHERE guild_id = ?1 AND status IN ('active','sending','paused')",
                    [guild],
                    |r| r.get(0),
                )
                .map_err(|e| CreateError::Storage(e.to_string()))?;
            if in_guild >= per_guild_cap {
                return Err(CreateError::PerGuildFull(per_guild_cap));
            }
        }
        conn.execute(
            "INSERT INTO scheduled_posts \
             (id, manage_token_hash, owner_user_id, webhook_id, webhook_sealed, thread_id, \
              payload_sealed, title, dest_label, tz, recurrence_json, next_run_at, status, \
              attempts, runs_count, end_at, max_runs, created_at, updated_at, guild_id, \
              make_permanent) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'active',0,0,?13,?14,?15,?15,?16,?17)",
            params![
                n.id,
                n.manage_token_hash,
                n.owner_user_id,
                n.webhook_id,
                n.webhook_sealed,
                n.thread_id,
                n.payload_sealed,
                n.title,
                n.dest_label,
                n.tz,
                n.recurrence_json,
                n.next_run_at,
                n.end_at,
                n.max_runs,
                n.created_at,
                n.guild_id,
                n.make_permanent as i64,
            ],
        )
        .map_err(|e| CreateError::Storage(e.to_string()))?;
        self.count.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    /// Reconcile a server's scheduled posts against its plan `cap`: keep the
    /// **oldest `cap`** live and suspend the rest, reviving any that now fit —
    /// the mirror of the dispatcher's slot reconcile, and the anti-abuse point
    /// for schedules. Only user-owned live rows move (`active`/`paused` ↔
    /// `suspended`); an in-flight (`sending`) or terminal (`done`/`failed`) row
    /// is left alone. A revived row keeps its original run time if still in the
    /// future, else fires on the next tick — one catch-up post, exactly the
    /// worker's existing catch-up policy. Idempotent: same cap ⇒ same state, so
    /// it serves both the downgrade and the re-upgrade. Suspended rows don't
    /// count toward the create quota (see `create_with_limit`), so a server can
    /// always fill up to `cap` live schedules. Returns `(active, suspended)`.
    pub fn reconcile_guild(&self, guild: &str, cap: i64) -> Result<(i64, i64), String> {
        let conn = self.lock();
        let now = unix_now();
        let cap = cap.max(0);
        // Suspend everything ranked at/after the cap. Ranking spans all live
        // rows (active/paused/suspended) so the kept set is stable no matter the
        // current suspension state; `-1` LIMIT = "all rows past the offset".
        conn.execute(
            "UPDATE scheduled_posts SET status='suspended', updated_at=?1 \
             WHERE guild_id=?2 AND status IN ('active','paused') AND id IN ( \
                 SELECT id FROM scheduled_posts \
                 WHERE guild_id=?2 AND status IN ('active','paused','suspended') \
                 ORDER BY created_at, id LIMIT -1 OFFSET ?3)",
            params![now, guild, cap],
        )
        .map_err(e2s)?;
        // Revive the oldest `cap` that were suspended. next_run_at = max(old, now)
        // keeps a future run on time and lets a lapsed one fire next tick.
        conn.execute(
            "UPDATE scheduled_posts SET status='active', attempts=0, \
             next_run_at=MAX(next_run_at, ?1), updated_at=?1 \
             WHERE guild_id=?2 AND status='suspended' AND id IN ( \
                 SELECT id FROM scheduled_posts \
                 WHERE guild_id=?2 AND status IN ('active','paused','suspended') \
                 ORDER BY created_at, id LIMIT ?3)",
            params![now, guild, cap],
        )
        .map_err(e2s)?;
        let active: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM scheduled_posts \
                 WHERE guild_id=?1 AND status IN ('active','paused','sending')",
                [guild],
                |r| r.get(0),
            )
            .map_err(e2s)?;
        let suspended: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM scheduled_posts WHERE guild_id=?1 AND status='suspended'",
                [guild],
                |r| r.get(0),
            )
            .map_err(e2s)?;
        Ok((active, suspended))
    }

    pub fn get(&self, id: &str) -> Result<Option<Row>, String> {
        let conn = self.lock();
        conn.query_row(
            &format!("SELECT {COLS} FROM scheduled_posts WHERE id = ?1"),
            [id],
            row_from,
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })
    }

    pub fn list_for_owner(&self, uid: &str, limit: usize) -> Result<Vec<Row>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {COLS} FROM scheduled_posts \
                 WHERE owner_user_id = ?1 ORDER BY created_at DESC LIMIT ?2"
            ))
            .map_err(e2s)?;
        let rows = stmt.query_map((uid, limit as i64), row_from).map_err(e2s)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(e2s)
    }

    /// Every schedule whose destination is `guild_id` — the per-server list. The
    /// HTTP layer gates this on the caller holding Manage Webhooks in that guild.
    pub fn list_for_guild(&self, guild_id: &str, limit: usize) -> Result<Vec<Row>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {COLS} FROM scheduled_posts \
                 WHERE guild_id = ?1 ORDER BY next_run_at ASC LIMIT ?2"
            ))
            .map_err(e2s)?;
        let rows = stmt
            .query_map((guild_id, limit as i64), row_from)
            .map_err(e2s)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(e2s)
    }

    /// Overwrite the user-mutable columns of an existing row (never the lease,
    /// run counters, or last-* result fields, which only the worker owns).
    pub fn replace_mutable(&self, r: &Row) -> Result<bool, String> {
        let conn = self.lock();
        let n = conn
            .execute(
                "UPDATE scheduled_posts SET \
                 webhook_id=?2, webhook_sealed=?3, thread_id=?4, payload_sealed=?5, title=?6, \
                 dest_label=?7, tz=?8, recurrence_json=?9, next_run_at=?10, status=?11, \
                 attempts=?12, end_at=?13, max_runs=?14, updated_at=?15 WHERE id=?1",
                params![
                    r.id,
                    r.webhook_id,
                    r.webhook_sealed,
                    r.thread_id,
                    r.payload_sealed,
                    r.title,
                    r.dest_label,
                    r.tz,
                    r.recurrence_json,
                    r.next_run_at,
                    r.status,
                    r.attempts,
                    r.end_at,
                    r.max_runs,
                    unix_now(),
                ],
            )
            .map_err(e2s)?;
        Ok(n > 0)
    }

    pub fn delete(&self, id: &str) -> Result<bool, String> {
        let conn = self.lock();
        let n = conn
            .execute("DELETE FROM scheduled_posts WHERE id = ?1", [id])
            .map_err(e2s)?;
        if n > 0 {
            self.count.fetch_sub(1, Ordering::Relaxed);
        }
        Ok(n > 0)
    }

    /// Atomically reclaim crashed leases, then claim up to `batch` due rows by
    /// flipping them `active → sending` under a lease. The flip is the
    /// duplicate-send guard: a row can only be claimed by one pass.
    pub fn claim_due(
        &self,
        now: i64,
        lease_secs: i64,
        batch: usize,
    ) -> Result<Vec<ClaimedJob>, String> {
        let mut guard = self.lock();
        let tx = guard.transaction().map_err(e2s)?;
        // Reclaim rows a previous worker claimed but never resolved (it crashed):
        // an expired lease means nobody owns it anymore.
        tx.execute(
            "UPDATE scheduled_posts SET status='active', lease_until=NULL \
             WHERE status='sending' AND (lease_until IS NULL OR lease_until < ?1)",
            [now],
        )
        .map_err(e2s)?;
        let ids: Vec<String> = {
            let mut stmt = tx
                .prepare(
                    "SELECT id FROM scheduled_posts \
                     WHERE status='active' AND next_run_at <= ?1 \
                     ORDER BY next_run_at ASC LIMIT ?2",
                )
                .map_err(e2s)?;
            let rows = stmt
                .query_map((now, batch as i64), |r| r.get::<_, String>(0))
                .map_err(e2s)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(e2s)?
        };
        let mut jobs = Vec::with_capacity(ids.len());
        for id in &ids {
            tx.execute(
                "UPDATE scheduled_posts SET status='sending', lease_until=?2 \
                 WHERE id=?1 AND status='active'",
                (id, now + lease_secs),
            )
            .map_err(e2s)?;
            let job = tx
                .query_row(
                    "SELECT id, webhook_id, webhook_sealed, thread_id, payload_sealed, tz, \
                     recurrence_json, end_at, max_runs, runs_count, attempts, guild_id, \
                     make_permanent, owner_user_id \
                     FROM scheduled_posts WHERE id=?1",
                    [id],
                    |r| {
                        Ok(ClaimedJob {
                            id: r.get(0)?,
                            webhook_id: r.get(1)?,
                            webhook_sealed: r.get(2)?,
                            thread_id: r.get(3)?,
                            payload_sealed: r.get(4)?,
                            tz: r.get(5)?,
                            recurrence_json: r.get(6)?,
                            end_at: r.get(7)?,
                            max_runs: r.get(8)?,
                            runs_count: r.get(9)?,
                            attempts: r.get(10)?,
                            guild_id: r.get(11)?,
                            make_permanent: r.get::<_, i64>(12)? != 0,
                            owner_user_id: r.get(13)?,
                        })
                    },
                )
                .map_err(e2s)?;
            jobs.push(job);
        }
        tx.commit().map_err(e2s)?;
        Ok(jobs)
    }

    /// Record a successful send. `next_run_at = Some` reschedules a recurring
    /// series; `None` marks it `done`. `note` is a non-fatal info line stored in
    /// `last_error` (the run-detail field the UI surfaces) — e.g. "posted, but
    /// the never-expire slot couldn't be claimed". `None` clears it.
    #[allow(clippy::too_many_arguments)]
    pub fn record_success(
        &self,
        id: &str,
        now: i64,
        message_id: Option<&str>,
        channel_id: Option<&str>,
        http_status: i64,
        next_run_at: Option<i64>,
        note: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.lock();
        match next_run_at {
            Some(next) => conn.execute(
                "UPDATE scheduled_posts SET status='active', next_run_at=?2, lease_until=NULL, \
                 attempts=0, last_status=?3, last_error=?6, last_run_at=?4, last_message_id=?5, \
                 last_channel_id=?7, runs_count=runs_count+1, updated_at=?4 WHERE id=?1",
                params![id, next, http_status, now, message_id, note, channel_id],
            ),
            None => conn.execute(
                "UPDATE scheduled_posts SET status='done', lease_until=NULL, attempts=0, \
                 last_status=?2, last_error=?5, last_run_at=?3, last_message_id=?4, \
                 last_channel_id=?6, runs_count=runs_count+1, updated_at=?3 WHERE id=?1",
                params![id, http_status, now, message_id, note, channel_id],
            ),
        }
        .map_err(e2s)?;
        Ok(())
    }

    /// Record a transient failure: keep the row active, retry at `retry_at`.
    pub fn record_transient(
        &self,
        id: &str,
        retry_at: i64,
        attempts: i64,
        http_status: Option<i64>,
        err: &str,
        now: i64,
    ) -> Result<(), String> {
        let conn = self.lock();
        conn.execute(
            "UPDATE scheduled_posts SET status='active', next_run_at=?2, lease_until=NULL, \
             attempts=?3, last_status=?4, last_error=?5, updated_at=?6 WHERE id=?1",
            params![id, retry_at, attempts, http_status, err, now],
        )
        .map_err(e2s)?;
        Ok(())
    }

    /// Record a permanent failure: the series stops, the reason is kept for the UI.
    pub fn record_permanent_fail(
        &self,
        id: &str,
        now: i64,
        http_status: Option<i64>,
        err: &str,
    ) -> Result<(), String> {
        let conn = self.lock();
        conn.execute(
            "UPDATE scheduled_posts SET status='failed', lease_until=NULL, last_status=?2, \
             last_error=?3, last_run_at=?4, updated_at=?4 WHERE id=?1",
            params![id, http_status, err, now],
        )
        .map_err(e2s)?;
        Ok(())
    }

    /// Delete terminal rows (`done`/`failed`) older than `retention_secs`, so the
    /// table stays small. Reads never see them anyway, this just reclaims space.
    pub fn sweep(&self, now: i64, retention_secs: i64) -> Result<usize, String> {
        let conn = self.lock();
        let n = conn
            .execute(
                "DELETE FROM scheduled_posts \
                 WHERE status IN ('done','failed') AND COALESCE(last_run_at, updated_at) < ?1",
                [now - retention_secs],
            )
            .map_err(e2s)?;
        self.count.fetch_sub(n as i64, Ordering::Relaxed);
        Ok(n)
    }
}

// ── HTTP handlers ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CreateBody {
    pub webhook_url: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    pub payload: Value,
    pub tz: String,
    pub recurrence: Recurrence,
    /// Absolute fire time for a `once` schedule (and the lower bound for the
    /// first run otherwise). Required when `recurrence` is `once`.
    #[serde(default)]
    pub start_at: Option<i64>,
    #[serde(default)]
    pub end_at: Option<i64>,
    #[serde(default)]
    pub max_runs: Option<i64>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub dest_label: Option<String>,
    /// Destination guild, so a server manager can list it later. Cosmetic for
    /// the owner; never trusted for auth (the manage token / owner is).
    #[serde(default)]
    pub guild_id: Option<String>,
    /// Keep this post's interactive components from expiring: the worker spends
    /// one of the guild's never-expire slots on the message once it's posted.
    /// Only honoured when `guild_id` is set (no guild → nowhere to spend a slot).
    #[serde(default)]
    pub make_permanent: bool,
}

#[derive(Deserialize)]
pub struct PatchBody {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub dest_label: Option<String>,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub payload: Option<Value>,
    #[serde(default)]
    pub webhook_url: Option<String>,
    #[serde(default)]
    pub tz: Option<String>,
    #[serde(default)]
    pub recurrence: Option<Recurrence>,
    #[serde(default)]
    pub start_at: Option<i64>,
    /// `<= 0` clears the end date.
    #[serde(default)]
    pub end_at: Option<i64>,
    /// `<= 0` clears the run cap.
    #[serde(default)]
    pub max_runs: Option<i64>,
    #[serde(default)]
    pub paused: Option<bool>,
}

#[derive(Deserialize)]
pub struct TokenQuery {
    #[serde(default)]
    pub token: Option<String>,
}

/// `POST /api/schedules` → `201 { id, manage_token, next_run_at, status }`.
/// The manage token is returned exactly once — the browser must keep it.
pub async fn schedule_create(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Json(body): Json<CreateBody>,
) -> Result<Response, AppError> {
    let store = store(&st)?;

    // Scheduling requires a Discord login: the schedule is owned by the account
    // (manageable across devices, and counts against the per-server quota under a
    // real identity). Checked up front so an anonymous request fails fast.
    let session = current_session(&jar)
        .ok_or_else(|| AppError::Unauthorized("Sign in with Discord to schedule a post.".into()))?;

    validate_webhook(&body.webhook_url).map_err(bad_request_s)?;
    let wid = webhook_id(&body.webhook_url)
        .ok_or_else(|| bad_request("That webhook URL is malformed."))?;
    if let Some(t) = &body.thread_id {
        if !t.is_empty() && !is_snowflake(t) {
            return Err(bad_request("That thread ID looks wrong."));
        }
    }
    let tz = parse_tz(&body.tz).map_err(bad_request_s)?;
    validate_recurrence(&body.recurrence).map_err(bad_request_s)?;
    validate_payload(&body.payload).map_err(bad_request_s)?;
    if let Some(t) = &body.title {
        validate_title(t).map_err(bad_request_s)?;
    }
    if let Some(l) = &body.dest_label {
        validate_dest_label(l).map_err(bad_request_s)?;
    }
    if let Some(g) = &body.guild_id {
        if !g.is_empty() && !is_snowflake(g) {
            return Err(bad_request("That server ID looks wrong."));
        }
    }
    if let Some(m) = body.max_runs {
        if m < 1 {
            return Err(bad_request("Max runs must be at least 1."));
        }
    }

    let now = unix_now();
    let horizon = now + st.config.schedule_max_horizon_days as i64 * 86_400;
    let next_run_at = if body.recurrence.is_repeating() {
        let n = next_after(&body.recurrence, tz, now)
            .ok_or_else(|| bad_request("That schedule has no upcoming run."))?;
        if let Some(end) = body.end_at {
            if n > end {
                return Err(bad_request("The end date is before the first run."));
            }
        }
        n
    } else {
        let start = body
            .start_at
            .ok_or_else(|| bad_request("Pick a date and time for the post."))?;
        if start < now - 60 {
            return Err(bad_request("That time is in the past."));
        }
        start
    };
    if next_run_at > horizon {
        return Err(bad_request("That's too far in the future."));
    }

    let webhook_sealed = seal::seal(&st.key, body.webhook_url.trim())
        .ok_or_else(|| AppError::Internal("could not seal webhook".into()))?;
    let payload_str =
        serde_json::to_string(&body.payload).map_err(|e| AppError::Internal(e.to_string()))?;
    let payload_sealed = seal::seal(&st.key, &payload_str)
        .ok_or_else(|| AppError::Internal("could not seal payload".into()))?;
    let recurrence_json =
        serde_json::to_string(&body.recurrence).map_err(|e| AppError::Internal(e.to_string()))?;

    let token = random_base62(TOKEN_LEN).ok_or_else(|| AppError::Internal("rng".into()))?;
    let id = random_base62(ID_LEN).ok_or_else(|| AppError::Internal("rng".into()))?;

    let guild_id = body.guild_id.filter(|g| !g.is_empty());
    // A never-expire slot can only be spent against a known guild — drop the flag
    // when the destination guild is unknown so the worker never tries, and the
    // row honestly records that it won't keep the message permanent.
    let make_permanent = body.make_permanent && guild_id.is_some();

    // The destination server's plan tier caps how many scheduled posts it may
    // hold (per-server premium). `None` when entitlement is disabled, or when the
    // post has no known guild (nothing to bill) → the store default applies, so a
    // standalone deployment is unchanged.
    let limit_override = match &guild_id {
        Some(g) => st.entitlements.schedule_limit(g).await,
        None => None,
    };

    let new = NewSchedule {
        id: id.clone(),
        manage_token_hash: hash_token(&token),
        owner_user_id: Some(session.uid),
        webhook_id: wid,
        webhook_sealed,
        thread_id: body.thread_id.filter(|t| !t.is_empty()),
        payload_sealed,
        title: body.title.filter(|t| !t.trim().is_empty()),
        dest_label: body.dest_label.filter(|l| !l.trim().is_empty()),
        tz: body.tz.trim().to_string(),
        recurrence_json,
        next_run_at,
        end_at: body.end_at.filter(|e| *e > 0),
        max_runs: body.max_runs,
        created_at: now,
        guild_id,
        make_permanent,
    };

    let res = tokio::task::spawn_blocking(move || store.create_with_limit(&new, limit_override))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    match res {
        Ok(()) => Ok((
            StatusCode::CREATED,
            [(header::CACHE_CONTROL, "no-store")],
            Json(json!({
                "id": id,
                "manage_token": token,
                "next_run_at": next_run_at,
                "status": "active",
            })),
        )
            .into_response()),
        Err(CreateError::Full) => Err(AppError::Status {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: "Scheduling is at capacity right now — try again later.".into(),
            retry_after: None,
        }),
        Err(CreateError::PerWebhookFull) => Err(AppError::Status {
            status: StatusCode::CONFLICT,
            message: format!(
                "That webhook already has the maximum of {} active schedules.",
                st.config.schedule_max_per_webhook
            ),
            retry_after: None,
        }),
        Err(CreateError::PerGuildFull(limit)) => Err(AppError::Status {
            status: StatusCode::CONFLICT,
            message: format!(
                "This server already has the maximum of {limit} scheduled posts — cancel one to add another."
            ),
            retry_after: None,
        }),
        Err(CreateError::Storage(e)) => Err(AppError::Internal(format!("schedule store: {e}"))),
    }
}

/// `GET /api/schedules/:id` → masked view **plus** the decrypted payload (so the
/// browser can reload it into the editor). The webhook URL/token is never echoed.
pub async fn schedule_get(
    State(st): State<AppState>,
    Path(id): Path<String>,
    jar: PrivateCookieJar,
    headers: HeaderMap,
    Query(q): Query<TokenQuery>,
) -> Result<Response, AppError> {
    let store = store(&st)?;
    let row = load(&store, &id).await?;
    let token = manage_token_from(&headers).or(q.token);
    if !authorize_row(&st, &jar, token.as_deref(), &row).await {
        return Err(forbidden());
    }
    let owned = is_owner(&jar, &row);
    let payload = seal::open(&st.key, &row.payload_sealed)
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(Value::Null);
    let mut v = view(&row, owned);
    if let Value::Object(ref mut m) = v {
        m.insert("payload".into(), payload);
    }
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(v)).into_response())
}

/// `GET /api/schedules` → the signed-in user's schedules (cross-device list).
pub async fn schedule_list(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
) -> Result<Response, AppError> {
    let store = store(&st)?;
    let session = current_session(&jar)
        .ok_or_else(|| AppError::Unauthorized("Sign in to list your schedules.".into()))?;
    let uid = session.uid;
    let rows = tokio::task::spawn_blocking(move || store.list_for_owner(&uid, LIST_LIMIT))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(AppError::Internal)?;
    let items: Vec<Value> = rows.iter().map(|r| view(r, true)).collect();
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "items": items })),
    )
        .into_response())
}

/// `GET /api/guilds/:guild_id/schedules` → every schedule for that server.
/// Gated like the webhook picker: the caller must hold Manage Webhooks in the
/// guild (the bot does too). Masked — no webhook URLs/tokens, no payloads.
pub async fn schedule_list_for_guild(
    State(st): State<AppState>,
    Path(guild): Path<String>,
    jar: PrivateCookieJar,
) -> Result<Response, AppError> {
    let store = store(&st)?;
    // Authorize first (a Discord-gated membership + Manage-Webhooks check).
    crate::routes::authorize_webhooks(&st, &jar, &guild).await?;
    let session = current_session(&jar);
    // The per-server quota travels with the list so the UI can show "used / cap"
    // (the `used` count is derived client-side from the live rows below), and the
    // retention window so it can note when posted/failed rows auto-clear. When
    // plan entitlement is on, the cap reflects *this server's* tier (unlimited →
    // JSON null); otherwise it's the store default.
    let quota: Value = if st.entitlements.enabled() {
        match st.entitlements.schedule_limit(&guild).await {
            Some(n) if n == i64::MAX => Value::Null,
            Some(n) => json!(n),
            None => json!(store.max_per_guild()),
        }
    } else {
        json!(store.max_per_guild())
    };
    let retention_days = st.config.schedule_retention_days;
    let g = guild.clone();
    let rows = tokio::task::spawn_blocking(move || store.list_for_guild(&g, LIST_LIMIT))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(AppError::Internal)?;
    let me = session.as_ref().map(|s| s.uid.as_str());
    let items: Vec<Value> = rows
        .iter()
        .map(|r| view(r, r.owner_user_id.as_deref() == me))
        .collect();
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "items": items, "quota": quota, "retention_days": retention_days })),
    )
        .into_response())
}

/// `PATCH /api/schedules/:id` — edit / reschedule / pause / resume / cancel-end.
pub async fn schedule_patch(
    State(st): State<AppState>,
    Path(id): Path<String>,
    jar: PrivateCookieJar,
    headers: HeaderMap,
    Json(body): Json<PatchBody>,
) -> Result<Response, AppError> {
    let store = store(&st)?;
    let mut row = load(&store, &id).await?;
    let token = manage_token_from(&headers);
    if !authorize_row(&st, &jar, token.as_deref(), &row).await {
        return Err(forbidden());
    }

    let now = unix_now();
    let mut timing_changed = false;

    if let Some(title) = body.title {
        validate_title(&title).map_err(bad_request_s)?;
        row.title = Some(title).filter(|t| !t.trim().is_empty());
    }
    if let Some(label) = body.dest_label {
        validate_dest_label(&label).map_err(bad_request_s)?;
        row.dest_label = Some(label).filter(|l| !l.trim().is_empty());
    }
    if let Some(thread) = body.thread_id {
        if !thread.is_empty() && !is_snowflake(&thread) {
            return Err(bad_request("That thread ID looks wrong."));
        }
        row.thread_id = Some(thread).filter(|t| !t.is_empty());
    }
    if let Some(payload) = body.payload {
        validate_payload(&payload).map_err(bad_request_s)?;
        let s = serde_json::to_string(&payload).map_err(|e| AppError::Internal(e.to_string()))?;
        row.payload_sealed =
            seal::seal(&st.key, &s).ok_or_else(|| AppError::Internal("seal payload".into()))?;
    }
    if let Some(url) = body.webhook_url {
        validate_webhook(&url).map_err(bad_request_s)?;
        let wid = webhook_id(&url).ok_or_else(|| bad_request("That webhook URL is malformed."))?;
        row.webhook_sealed = seal::seal(&st.key, url.trim())
            .ok_or_else(|| AppError::Internal("seal webhook".into()))?;
        row.webhook_id = wid;
    }
    if let Some(tzname) = body.tz {
        parse_tz(&tzname).map_err(bad_request_s)?;
        row.tz = tzname.trim().to_string();
        timing_changed = true;
    }
    if let Some(rec) = body.recurrence {
        validate_recurrence(&rec).map_err(bad_request_s)?;
        row.recurrence_json =
            serde_json::to_string(&rec).map_err(|e| AppError::Internal(e.to_string()))?;
        timing_changed = true;
    }
    if let Some(end) = body.end_at {
        row.end_at = if end <= 0 { None } else { Some(end) };
        timing_changed = true;
    }
    if let Some(m) = body.max_runs {
        row.max_runs = if m <= 0 { None } else { Some(m) };
    }
    if let Some(start) = body.start_at {
        row.next_run_at = start;
        timing_changed = true;
    }

    if let Some(paused) = body.paused {
        // A plan-suspended schedule (over the server's tier cap) can only be
        // revived by re-upgrading — never by the owner toggling pause, which
        // would defeat the quota. Editing its other fields stays allowed.
        if row.status == "suspended" {
            return Err(bad_request(
                "This schedule is paused because the server is over its plan limit. \
                 Upgrade the server to resume it.",
            ));
        }
        if paused {
            row.status = "paused".into();
        } else {
            // Resume from paused/failed/done → reactivate, recompute below.
            row.status = "active".into();
            row.attempts = 0;
            timing_changed = true;
        }
    }

    if timing_changed && row.status == "active" {
        let rec: Recurrence = serde_json::from_str(&row.recurrence_json)
            .map_err(|e| AppError::Internal(e.to_string()))?;
        let tz = parse_tz(&row.tz).map_err(bad_request_s)?;
        if rec.is_repeating() {
            let n = next_after(&rec, tz, now)
                .ok_or_else(|| bad_request("That schedule has no upcoming run."))?;
            if let Some(end) = row.end_at {
                if n > end {
                    return Err(bad_request("The end date is before the next run."));
                }
            }
            row.next_run_at = n;
        } else if row.next_run_at < now - 60 {
            return Err(bad_request("That time is in the past."));
        }
        let horizon = now + st.config.schedule_max_horizon_days as i64 * 86_400;
        if row.next_run_at > horizon {
            return Err(bad_request("That's too far in the future."));
        }
    }

    let owned = is_owner(&jar, &row);
    let view_value = view(&row, owned);
    let rowc = row.clone();
    let found = tokio::task::spawn_blocking(move || store.replace_mutable(&rowc))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(AppError::Internal)?;
    if !found {
        return Err(not_found());
    }
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(view_value)).into_response())
}

/// `DELETE /api/schedules/:id` — cancel (hard-delete; the series stops at once).
pub async fn schedule_delete(
    State(st): State<AppState>,
    Path(id): Path<String>,
    jar: PrivateCookieJar,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let store = store(&st)?;
    let row = load(&store, &id).await?;
    let token = manage_token_from(&headers);
    if !authorize_row(&st, &jar, token.as_deref(), &row).await {
        return Err(forbidden());
    }
    tokio::task::spawn_blocking(move || store.delete(&id))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(AppError::Internal)?;
    Ok((StatusCode::OK, Json(json!({ "ok": true }))).into_response())
}

// ── Handler helpers ──────────────────────────────────────────────────────────

/// The store, or a clear "not enabled here" for deployments that turned the
/// feature off (`SCHEDULES_ENABLED=false`).
fn store(st: &AppState) -> Result<Arc<ScheduleStore>, AppError> {
    st.schedules
        .as_ref()
        .map(Arc::clone)
        .ok_or_else(|| AppError::Status {
            status: StatusCode::NOT_IMPLEMENTED,
            message: "Scheduled posts aren't enabled on this deployment.".into(),
            retry_after: None,
        })
}

async fn load(store: &Arc<ScheduleStore>, id: &str) -> Result<Row, AppError> {
    let s = Arc::clone(store);
    let idc = id.to_string();
    let row = tokio::task::spawn_blocking(move || s.get(&idc))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(AppError::Internal)?;
    row.ok_or_else(not_found)
}

/// A request may manage a row if it presents the matching manage token, or holds
/// a session whose user id stamped the row at creation.
fn is_authorized(jar: &PrivateCookieJar, token: Option<&str>, row: &Row) -> bool {
    if let Some(t) = token {
        if !t.is_empty() && hash_token(t) == row.manage_token_hash {
            return true;
        }
    }
    is_owner(jar, row)
}

/// Like [`is_authorized`], plus: a server manager (Manage Webhooks in the row's
/// destination guild) may manage any schedule for their server — mirroring the
/// per-server list. The guild check is a Discord-gated call, so it's only made
/// when the cheap token/owner check fails.
async fn authorize_row(
    st: &AppState,
    jar: &PrivateCookieJar,
    token: Option<&str>,
    row: &Row,
) -> bool {
    if is_authorized(jar, token, row) {
        return true;
    }
    if let Some(guild) = &row.guild_id {
        if crate::routes::authorize_webhooks(st, jar, guild)
            .await
            .is_ok()
        {
            return true;
        }
    }
    false
}

fn is_owner(jar: &PrivateCookieJar, row: &Row) -> bool {
    match (current_session(jar), row.owner_user_id.as_deref()) {
        (Some(s), Some(owner)) => s.uid == owner,
        _ => false,
    }
}

fn manage_token_from(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-manage-token")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// The masked list/detail view. Never includes the webhook URL/token; the
/// payload is added by [`schedule_get`] only.
fn view(row: &Row, owned: bool) -> Value {
    json!({
        "id": row.id,
        "title": row.title,
        "webhook_id": row.webhook_id,
        "guild_id": row.guild_id,
        "dest_label": row.dest_label,
        "thread_id": row.thread_id,
        "tz": row.tz,
        "recurrence": serde_json::from_str::<Value>(&row.recurrence_json).unwrap_or(Value::Null),
        "next_run_at": row.next_run_at,
        "status": row.status,
        "attempts": row.attempts,
        "last_status": row.last_status,
        "last_error": row.last_error,
        "last_run_at": row.last_run_at,
        "last_message_id": row.last_message_id,
        "last_channel_id": row.last_channel_id,
        "runs_count": row.runs_count,
        "end_at": row.end_at,
        "max_runs": row.max_runs,
        "created_at": row.created_at,
        "make_permanent": row.make_permanent,
        "owned": owned,
    })
}

fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn bad_request(message: &str) -> AppError {
    AppError::Status {
        status: StatusCode::BAD_REQUEST,
        message: message.into(),
        retry_after: None,
    }
}

fn bad_request_s(message: String) -> AppError {
    bad_request(&message)
}

fn forbidden() -> AppError {
    AppError::Forbidden(
        "You don't have permission to manage this schedule (wrong or missing manage token).".into(),
    )
}

fn not_found() -> AppError {
    AppError::Status {
        status: StatusCode::NOT_FOUND,
        message: "No such schedule (it may have been canceled or completed and removed).".into(),
        retry_after: None,
    }
}

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Current unix time in seconds.
pub fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Unbiased random base62 string (rejection sampling, like the short-link ids).
fn random_base62(len: usize) -> Option<String> {
    let max = 256 - (256 % ALPHABET.len());
    let mut out = String::with_capacity(len);
    while out.len() < len {
        let mut buf = [0u8; 32];
        getrandom::getrandom(&mut buf).ok()?;
        for b in buf {
            if (b as usize) < max && out.len() < len {
                out.push(ALPHABET[b as usize % ALPHABET.len()] as char);
            }
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(tag: &str) -> (ScheduleStore, std::path::PathBuf) {
        // Generous per-guild cap so the shared tests don't trip it; the
        // per-guild quota has its own dedicated test below.
        temp_store_caps(tag, 3, 100)
    }

    fn temp_store_caps(
        tag: &str,
        max_per_webhook: u64,
        max_per_guild: u64,
    ) -> (ScheduleStore, std::path::PathBuf) {
        let path =
            std::env::temp_dir().join(format!("dweeb-sched-test-{}-{tag}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let store =
            ScheduleStore::open(path.to_str().unwrap(), 1000, max_per_webhook, max_per_guild)
                .unwrap();
        (store, path)
    }

    fn sample(id: &str, webhook_id: &str, next_run_at: i64) -> NewSchedule {
        NewSchedule {
            id: id.into(),
            manage_token_hash: hash_token("tok"),
            owner_user_id: Some("user-1".into()),
            webhook_id: webhook_id.into(),
            webhook_sealed: "sealed-webhook".into(),
            thread_id: None,
            payload_sealed: "sealed-payload".into(),
            title: Some("Daily".into()),
            dest_label: None,
            tz: "UTC".into(),
            recurrence_json: r#"{"kind":"daily","time":{"hour":9,"minute":0}}"#.into(),
            next_run_at,
            end_at: None,
            max_runs: None,
            created_at: 1000,
            guild_id: Some("guild-9".into()),
            make_permanent: false,
        }
    }

    #[test]
    fn create_get_roundtrip() {
        let (store, path) = temp_store("roundtrip");
        store.create(&sample("abc", "111", 5000)).unwrap();
        let row = store.get("abc").unwrap().unwrap();
        assert_eq!(row.webhook_id, "111");
        assert_eq!(row.status, "active");
        assert_eq!(row.next_run_at, 5000);
        assert!(store.get("missing").unwrap().is_none());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn reconcile_keeps_oldest_and_suspends_overflow() {
        let (store, path) = temp_store_caps("reconcile", 100, 100);
        for (i, id) in ["s0", "s1", "s2", "s3", "s4"].iter().enumerate() {
            let mut s = sample(id, "111", 5000);
            s.created_at = 1000 + i as i64; // ascending age → s0 oldest
            store.create(&s).unwrap();
        }
        // Downgrade to cap 2 → oldest two stay, the rest are paused.
        assert_eq!(store.reconcile_guild("guild-9", 2).unwrap(), (2, 3));
        assert_eq!(store.get("s0").unwrap().unwrap().status, "active");
        assert_eq!(store.get("s1").unwrap().unwrap().status, "active");
        assert_eq!(store.get("s2").unwrap().unwrap().status, "suspended");
        assert_eq!(store.get("s4").unwrap().unwrap().status, "suspended");

        // Suspended rows don't count against the create quota, but the two live
        // ones do — so a cap-2 create is correctly refused (no over-cap growth).
        let mut extra = sample("s5", "111", 5000);
        extra.created_at = 2000;
        assert!(matches!(
            store.create_with_limit(&extra, Some(2)),
            Err(CreateError::PerGuildFull(2))
        ));

        // Re-upgrade to 4 → oldest four revive, one still paused.
        assert_eq!(store.reconcile_guild("guild-9", 4).unwrap(), (4, 1));
        assert_eq!(store.get("s3").unwrap().unwrap().status, "active");
        assert_eq!(store.get("s4").unwrap().unwrap().status, "suspended");

        // Unlimited → everything active again.
        assert_eq!(store.reconcile_guild("guild-9", i64::MAX).unwrap(), (5, 0));
        assert_eq!(store.get("s4").unwrap().unwrap().status, "active");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn claim_is_exclusive_and_due_filtered() {
        let (store, path) = temp_store("claim");
        store.create(&sample("due", "111", 100)).unwrap();
        store
            .create(&sample("future", "222", 9_000_000_000))
            .unwrap();
        // now=200 → only the due one is claimed, and flipped to 'sending'.
        let claimed = store.claim_due(200, 120, 10).unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(claimed[0].id, "due");
        assert_eq!(store.get("due").unwrap().unwrap().status, "sending");
        // A second claim sees nothing — the row is already owned (leased).
        assert_eq!(store.claim_due(200, 120, 10).unwrap().len(), 0);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn stale_lease_is_reclaimed() {
        let (store, path) = temp_store("lease");
        store.create(&sample("due", "111", 100)).unwrap();
        // Claim with a short lease, then advance well past it: the next claim
        // reclaims the abandoned row (a crashed worker) and re-fires it.
        let _ = store.claim_due(200, 10, 10).unwrap();
        let again = store.claim_due(1000, 10, 10).unwrap();
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].id, "due");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn success_advances_or_completes() {
        let (store, path) = temp_store("success");
        store.create(&sample("rec", "111", 100)).unwrap();
        let _ = store.claim_due(200, 120, 10).unwrap();
        // Recurring → rescheduled, runs_count++, back to active.
        store
            .record_success(
                "rec",
                250,
                Some("msg1"),
                Some("chan1"),
                204,
                Some(86_500),
                None,
            )
            .unwrap();
        let row = store.get("rec").unwrap().unwrap();
        assert_eq!(row.status, "active");
        assert_eq!(row.next_run_at, 86_500);
        assert_eq!(row.runs_count, 1);
        assert_eq!(row.last_message_id.as_deref(), Some("msg1"));
        assert_eq!(row.last_channel_id.as_deref(), Some("chan1"));
        // No next → done.
        let _ = store.claim_due(86_600, 120, 10).unwrap();
        store
            .record_success("rec", 86_700, Some("msg2"), Some("chan2"), 204, None, None)
            .unwrap();
        assert_eq!(store.get("rec").unwrap().unwrap().status, "done");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn transient_then_permanent() {
        let (store, path) = temp_store("fail");
        store.create(&sample("j", "111", 100)).unwrap();
        let _ = store.claim_due(200, 120, 10).unwrap();
        store
            .record_transient("j", 500, 1, Some(503), "5xx", 250)
            .unwrap();
        let row = store.get("j").unwrap().unwrap();
        assert_eq!(row.status, "active");
        assert_eq!(row.next_run_at, 500);
        assert_eq!(row.attempts, 1);
        store
            .record_permanent_fail("j", 600, Some(404), "webhook gone")
            .unwrap();
        let row = store.get("j").unwrap().unwrap();
        assert_eq!(row.status, "failed");
        assert_eq!(row.last_error.as_deref(), Some("webhook gone"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn per_webhook_cap() {
        let (store, path) = temp_store("cap");
        for i in 0..3 {
            store.create(&sample(&format!("a{i}"), "111", 100)).unwrap();
        }
        assert!(matches!(
            store.create(&sample("a3", "111", 100)),
            Err(CreateError::PerWebhookFull)
        ));
        // A different webhook is unaffected.
        assert!(store.create(&sample("b0", "222", 100)).is_ok());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn per_guild_quota() {
        // per-webhook generous, per-guild = 2 — so the quota is what bites.
        let (store, path) = temp_store_caps("perguild", 100, 2);
        store.create(&sample("a", "111", 100)).unwrap();
        store.create(&sample("b", "222", 100)).unwrap();
        assert!(matches!(
            store.create(&sample("c", "333", 100)),
            Err(CreateError::PerGuildFull(2))
        ));
        // A different server is unaffected by guild-9's quota.
        let mut other = sample("d", "444", 100);
        other.guild_id = Some("guild-other".into());
        assert!(store.create(&other).is_ok());
        // A schedule with no guild bypasses the per-guild quota (still bounded by
        // the per-webhook + global caps).
        let mut nog = sample("e", "555", 100);
        nog.guild_id = None;
        assert!(store.create(&nog).is_ok());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn per_guild_limit_override_beats_store_default() {
        // Store default per-guild is generous (100), but the acting user's tier
        // caps at 2 — the override is what bites.
        let (store, path) = temp_store_caps("override", 100, 100);
        store
            .create_with_limit(&sample("a", "111", 100), Some(2))
            .unwrap();
        store
            .create_with_limit(&sample("b", "222", 100), Some(2))
            .unwrap();
        assert!(matches!(
            store.create_with_limit(&sample("c", "333", 100), Some(2)),
            Err(CreateError::PerGuildFull(2))
        ));
        // An unlimited tier (i64::MAX) lets more through in the same guild.
        assert!(store
            .create_with_limit(&sample("c", "333", 100), Some(i64::MAX))
            .is_ok());
        // None falls back to the store default (100 here) — a standalone deploy.
        assert!(store.create(&sample("d", "444", 100)).is_ok());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn owner_listing_and_delete() {
        let (store, path) = temp_store("owner");
        store.create(&sample("a", "111", 100)).unwrap();
        store.create(&sample("b", "222", 100)).unwrap();
        assert_eq!(store.list_for_owner("user-1", 100).unwrap().len(), 2);
        assert_eq!(store.list_for_owner("nobody", 100).unwrap().len(), 0);
        assert!(store.delete("a").unwrap());
        assert_eq!(store.list_for_owner("user-1", 100).unwrap().len(), 1);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn guild_listing() {
        let (store, path) = temp_store("guild");
        // Two in guild-9, one in another guild.
        store.create(&sample("a", "111", 100)).unwrap();
        store.create(&sample("b", "222", 200)).unwrap();
        let mut other = sample("c", "333", 100);
        other.guild_id = Some("guild-other".into());
        store.create(&other).unwrap();
        let rows = store.list_for_guild("guild-9", 100).unwrap();
        assert_eq!(rows.len(), 2);
        // Ordered by next_run_at ASC.
        assert_eq!(rows[0].id, "a");
        assert!(rows
            .iter()
            .all(|r| r.guild_id.as_deref() == Some("guild-9")));
        assert_eq!(store.list_for_guild("guild-other", 100).unwrap().len(), 1);
        assert_eq!(store.list_for_guild("nope", 100).unwrap().len(), 0);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn migrates_db_without_guild_id_column() {
        // Simulate a DB created before `guild_id` existed (the prod case), then
        // open it through the store — the migration must add the column so the
        // server-scoped list works, without losing existing rows.
        let path = std::env::temp_dir().join(format!(
            "dweeb-sched-test-{}-migrate.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE scheduled_posts (
                     id TEXT PRIMARY KEY, manage_token_hash TEXT NOT NULL, owner_user_id TEXT,
                     webhook_id TEXT NOT NULL, webhook_sealed TEXT NOT NULL, thread_id TEXT,
                     payload_sealed TEXT NOT NULL, title TEXT, dest_label TEXT, tz TEXT NOT NULL,
                     recurrence_json TEXT NOT NULL, next_run_at INTEGER NOT NULL, status TEXT NOT NULL,
                     lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0, last_status INTEGER,
                     last_error TEXT, last_run_at INTEGER, last_message_id TEXT,
                     runs_count INTEGER NOT NULL DEFAULT 0, end_at INTEGER, max_runs INTEGER,
                     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
                 );
                 INSERT INTO scheduled_posts
                   (id, manage_token_hash, webhook_id, webhook_sealed, payload_sealed, tz,
                    recurrence_json, next_run_at, status, created_at, updated_at)
                 VALUES ('old','h','111','w','p','UTC','{\"kind\":\"once\"}',100,'active',1,1);",
            )
            .unwrap();
        }
        // Opening migrates (adds guild_id); the legacy row survives with NULL guild.
        let store = ScheduleStore::open(path.to_str().unwrap(), 1000, 3, 100).unwrap();
        assert_eq!(store.get("old").unwrap().unwrap().guild_id, None);
        // New rows can set + be listed by guild.
        store.create(&sample("new", "222", 100)).unwrap();
        assert_eq!(store.list_for_guild("guild-9", 100).unwrap().len(), 1);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn manage_token_hash_matches() {
        // Sanity: the stored hash matches a hash of the same token, not the token.
        let h = hash_token("secret-token");
        assert_eq!(h, hash_token("secret-token"));
        assert_ne!(h, "secret-token");
        assert_ne!(h, hash_token("other"));
    }
}
