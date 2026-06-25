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
     max_runs, created_at, updated_at";

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
    pub runs_count: i64,
    pub end_at: Option<i64>,
    pub max_runs: Option<i64>,
    pub created_at: i64,
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
}

#[derive(Debug)]
pub enum CreateError {
    /// Global row cap reached — answer 503, existing schedules keep running.
    Full,
    /// Per-webhook cap reached — answer 409.
    PerWebhookFull,
    Storage(String),
}

// ── Store ────────────────────────────────────────────────────────────────────

pub struct ScheduleStore {
    conn: Mutex<Connection>,
    max_entries: i64,
    max_per_webhook: i64,
    /// Approximate total row count, kept in step with inserts/deletes so the cap
    /// check is a load, not a `COUNT(*)`.
    count: AtomicI64,
}

impl ScheduleStore {
    pub fn open(path: &str, max_entries: u64, max_per_webhook: u64) -> Result<Self, String> {
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
                 updated_at        INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_sched_due ON scheduled_posts(status, next_run_at);
             CREATE INDEX IF NOT EXISTS idx_sched_owner ON scheduled_posts(owner_user_id);
             CREATE INDEX IF NOT EXISTS idx_sched_webhook ON scheduled_posts(webhook_id);",
        )
        .map_err(|e| format!("schema: {e}"))?;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM scheduled_posts", [], |r| r.get(0))
            .map_err(|e| format!("count: {e}"))?;
        Ok(ScheduleStore {
            conn: Mutex::new(conn),
            max_entries: max_entries as i64,
            max_per_webhook: max_per_webhook as i64,
            count: AtomicI64::new(count),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn create(&self, n: &NewSchedule) -> Result<(), CreateError> {
        if self.count.load(Ordering::Relaxed) >= self.max_entries {
            return Err(CreateError::Full);
        }
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
        conn.execute(
            "INSERT INTO scheduled_posts \
             (id, manage_token_hash, owner_user_id, webhook_id, webhook_sealed, thread_id, \
              payload_sealed, title, dest_label, tz, recurrence_json, next_run_at, status, \
              attempts, runs_count, end_at, max_runs, created_at, updated_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'active',0,0,?13,?14,?15,?15)",
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
            ],
        )
        .map_err(|e| CreateError::Storage(e.to_string()))?;
        self.count.fetch_add(1, Ordering::Relaxed);
        Ok(())
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
        let rows = stmt
            .query_map((uid, limit as i64), row_from)
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
                     recurrence_json, end_at, max_runs, runs_count, attempts \
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
    /// series; `None` marks it `done`.
    pub fn record_success(
        &self,
        id: &str,
        now: i64,
        message_id: Option<&str>,
        http_status: i64,
        next_run_at: Option<i64>,
    ) -> Result<(), String> {
        let conn = self.lock();
        match next_run_at {
            Some(next) => conn.execute(
                "UPDATE scheduled_posts SET status='active', next_run_at=?2, lease_until=NULL, \
                 attempts=0, last_status=?3, last_error=NULL, last_run_at=?4, last_message_id=?5, \
                 runs_count=runs_count+1, updated_at=?4 WHERE id=?1",
                params![id, next, http_status, now, message_id],
            ),
            None => conn.execute(
                "UPDATE scheduled_posts SET status='done', lease_until=NULL, attempts=0, \
                 last_status=?2, last_error=NULL, last_run_at=?3, last_message_id=?4, \
                 runs_count=runs_count+1, updated_at=?3 WHERE id=?1",
                params![id, http_status, now, message_id],
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
    let owner = current_session(&jar).map(|s| s.uid);

    let new = NewSchedule {
        id: id.clone(),
        manage_token_hash: hash_token(&token),
        owner_user_id: owner,
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
    };

    let res = tokio::task::spawn_blocking(move || store.create(&new))
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
    if !is_authorized(&jar, token.as_deref(), &row) {
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
    if !is_authorized(&jar, token.as_deref(), &row) {
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
    if !is_authorized(&jar, token.as_deref(), &row) {
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
    st.schedules.as_ref().map(Arc::clone).ok_or_else(|| AppError::Status {
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
        "runs_count": row.runs_count,
        "end_at": row.end_at,
        "max_runs": row.max_runs,
        "created_at": row.created_at,
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
        let path = std::env::temp_dir()
            .join(format!("dweeb-sched-test-{}-{tag}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let store = ScheduleStore::open(path.to_str().unwrap(), 1000, 3).unwrap();
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
    fn claim_is_exclusive_and_due_filtered() {
        let (store, path) = temp_store("claim");
        store.create(&sample("due", "111", 100)).unwrap();
        store.create(&sample("future", "222", 9_000_000_000)).unwrap();
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
        store.record_success("rec", 250, Some("msg1"), 204, Some(86_500)).unwrap();
        let row = store.get("rec").unwrap().unwrap();
        assert_eq!(row.status, "active");
        assert_eq!(row.next_run_at, 86_500);
        assert_eq!(row.runs_count, 1);
        assert_eq!(row.last_message_id.as_deref(), Some("msg1"));
        // No next → done.
        let _ = store.claim_due(86_600, 120, 10).unwrap();
        store.record_success("rec", 86_700, Some("msg2"), 204, None).unwrap();
        assert_eq!(store.get("rec").unwrap().unwrap().status, "done");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn transient_then_permanent() {
        let (store, path) = temp_store("fail");
        store.create(&sample("j", "111", 100)).unwrap();
        let _ = store.claim_due(200, 120, 10).unwrap();
        store.record_transient("j", 500, 1, Some(503), "5xx", 250).unwrap();
        let row = store.get("j").unwrap().unwrap();
        assert_eq!(row.status, "active");
        assert_eq!(row.next_run_at, 500);
        assert_eq!(row.attempts, 1);
        store.record_permanent_fail("j", 600, Some(404), "webhook gone").unwrap();
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
    fn manage_token_hash_matches() {
        // Sanity: the stored hash matches a hash of the same token, not the token.
        let h = hash_token("secret-token");
        assert_eq!(h, hash_token("secret-token"));
        assert_ne!(h, "secret-token");
        assert_ne!(h, hash_token("other"));
    }
}
