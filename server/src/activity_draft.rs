//! Persisted collaboration drafts for the embedded Activity.
//!
//! A collaboration room (`activity.rs`) is normally ephemeral: the shared draft
//! lives only in the peers' browsers, relayed through an in-memory broadcast
//! channel. That's fine while at least one person is connected, but the moment
//! the last editor closes the Activity — or the proxy restarts — the in-progress
//! message is gone, and reopening the Activity starts from a blank default.
//!
//! This tiny SQLite store closes that gap. Editors send periodic full-message
//! `snapshot` frames; the room socket seals the latest one and writes it here,
//! keyed by the Activity instance id. When someone later opens the Activity and
//! is the *first* one back in the room, the socket replays the stored draft so
//! they resume exactly where the group left off.
//!
//! Sealed at rest (`seal.rs`, AES-256-GCM under the proxy's cookie key), matching
//! the scheduled-posts precedent: a leak of this database alone yields no message
//! content. Rows are swept after a retention window — a collaborative session that
//! nobody has touched for a week isn't getting resumed.

use std::collections::HashMap;
use std::path::Path as FsPath;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::sqlite_pool::SqlitePool;

use axum_extra::extract::cookie::Key;
use rusqlite::{params, Connection};
use tokio::sync::Notify;

/// Fold bursts from every editor/room into at most four SQLite transactions per
/// second. The browser already durability-throttles snapshots to four seconds;
/// this small extra delay is invisible to users while preventing N co-editors
/// from producing N encryption jobs, blocking tasks, and WAL commits.
const WRITE_COALESCE: Duration = Duration::from_millis(250);
/// Pending plaintext is strictly best-effort and each accepted relay frame may
/// be as large as 256 KiB. Bound distinct rooms in one writer generation so a
/// synchronized reconnect/snapshot burst cannot retain an unbounded second
/// copy of collaboration state while SQLite is busy. Existing pending rooms
/// still replace their older value at the bound.
const MAX_PENDING_DRAFTS: usize = 64;

struct PendingDraft {
    json: String,
    updated_at: i64,
}

struct SealedDraft {
    instance: String,
    sealed: String,
    updated_at: i64,
}

/// SQLite-backed map of `instance_id → sealed latest draft`.
pub struct ActivityDraftStore {
    pool: SqlitePool,
    max_entries: i64,
    /// Approximate row count, kept in step with inserts/deletes so the cap check
    /// is a load rather than a `COUNT(*)` on the persist hot path.
    count: AtomicI64,
    /// Latest not-yet-flushed message per collaboration context. Replacing an
    /// entry drops superseded snapshots before they consume encryption/DB work.
    pending: Mutex<HashMap<String, PendingDraft>>,
    pending_cap: usize,
    pending_notify: Notify,
}

impl ActivityDraftStore {
    pub fn open(path: &str, max_entries: u64) -> Result<Self, String> {
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
        // Schema + initial count are one-time; run them once on a checked-out
        // connection rather than in the per-connection init.
        {
            let conn = pool.get();
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS activity_drafts (
                     instance_id  TEXT PRIMARY KEY,
                     draft_sealed TEXT NOT NULL,
                     updated_at   INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_activity_drafts_updated
                     ON activity_drafts(updated_at);",
            )
            .map_err(|e| format!("schema: {e}"))?;
        }
        let count: i64 = pool
            .get()
            .query_row("SELECT COUNT(*) FROM activity_drafts", [], |r| r.get(0))
            .map_err(|e| format!("count: {e}"))?;
        Ok(ActivityDraftStore {
            pool,
            max_entries: max_entries as i64,
            count: AtomicI64::new(count),
            pending: Mutex::new(HashMap::new()),
            pending_cap: max_entries.min(MAX_PENDING_DRAFTS as u64) as usize,
            pending_notify: Notify::new(),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.pool.get()
    }

    /// Cheap connectivity probe for the readiness endpoint (see
    /// `LibraryStore::ping`): a `SELECT 1` on the shared connection.
    pub fn ping(&self) -> Result<(), String> {
        self.pool.ping()
    }

    /// Queue the newest plaintext message for a collaboration context. One
    /// background writer (started from `main`) drains all contexts in a single
    /// blocking task/transaction, and seals only the newest value for each key.
    pub fn queue_put(&self, instance: String, json: String, updated_at: i64) {
        let mut pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
        if !pending.contains_key(&instance) && pending.len() >= self.pending_cap {
            return;
        }
        pending.insert(instance, PendingDraft { json, updated_at });
        drop(pending);
        self.pending_notify.notify_one();
    }

    /// Run the process-local coalescing writer. There is deliberately one task
    /// per store: SQLite still has one writer at a time, so spawning a task for
    /// every snapshot only grows the blocking queue and can let old writes land
    /// after newer ones. Batching also amortizes WAL commits across rooms.
    pub async fn run_writer(self: Arc<Self>, key: Key) {
        loop {
            self.pending_notify.notified().await;
            tokio::time::sleep(WRITE_COALESCE).await;

            let batch: Vec<(String, PendingDraft)> = {
                let mut pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
                pending.drain().collect()
            };
            if batch.is_empty() {
                continue;
            }

            let store = Arc::clone(&self);
            let key = key.clone();
            let result = tokio::task::spawn_blocking(move || {
                let mut sealed = Vec::with_capacity(batch.len());
                for (instance, draft) in batch {
                    let Some(ciphertext) = crate::seal::seal(&key, &draft.json) else {
                        continue;
                    };
                    sealed.push(SealedDraft {
                        instance,
                        sealed: ciphertext,
                        updated_at: draft.updated_at,
                    });
                }
                store.put_batch(&sealed)
            })
            .await;

            match result {
                Ok(Ok(())) => {}
                Ok(Err(e)) => tracing::warn!("activity draft batch persist failed: {e}"),
                Err(e) => tracing::warn!("activity draft batch task failed: {e}"),
            }
        }
    }

    /// Upsert the sealed draft for `instance`. Updating an existing instance is
    /// always allowed (it doesn't grow the table); a brand-new instance is
    /// dropped silently once the global cap is hit — persistence is best-effort,
    /// so a full table just degrades to the old ephemeral behaviour rather than
    /// failing the edit.
    pub fn put(&self, instance: &str, draft_sealed: &str, now: i64) -> Result<(), String> {
        self.put_batch(&[SealedDraft {
            instance: instance.to_string(),
            sealed: draft_sealed.to_string(),
            updated_at: now,
        }])
    }

    /// Persist a drained set in one transaction. The UPDATE-first shape keeps
    /// updates working at the global cap and lets the atomic count stay a cheap
    /// insert guard without a point read for every existing room.
    fn put_batch(&self, drafts: &[SealedDraft]) -> Result<(), String> {
        if drafts.is_empty() {
            return Ok(());
        }
        let mut conn = self.lock();
        let tx = conn.transaction().map_err(e2s)?;
        let mut inserted = 0_i64;
        {
            let mut update = tx
                .prepare_cached(
                    "UPDATE activity_drafts SET draft_sealed = ?2, updated_at = ?3 \
                     WHERE instance_id = ?1",
                )
                .map_err(e2s)?;
            let mut insert = tx
                .prepare_cached(
                    "INSERT INTO activity_drafts (instance_id, draft_sealed, updated_at) \
                     VALUES (?1, ?2, ?3)",
                )
                .map_err(e2s)?;
            for draft in drafts {
                let updated = update
                    .execute(params![draft.instance, draft.sealed, draft.updated_at])
                    .map_err(e2s)?;
                if updated > 0 || self.count.load(Ordering::Relaxed) + inserted >= self.max_entries
                {
                    continue;
                }
                insert
                    .execute(params![draft.instance, draft.sealed, draft.updated_at])
                    .map_err(e2s)?;
                inserted += 1;
            }
        }
        tx.commit().map_err(e2s)?;
        if inserted > 0 {
            self.count.fetch_add(inserted, Ordering::Relaxed);
        }
        Ok(())
    }

    /// The sealed draft for `instance`, or `None` when nothing is stored yet.
    pub fn get(&self, instance: &str) -> Result<Option<String>, String> {
        let conn = self.lock();
        conn.query_row(
            "SELECT draft_sealed FROM activity_drafts WHERE instance_id = ?1",
            [instance],
            |r| r.get::<_, String>(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })
    }

    /// Delete drafts untouched for longer than `retention_secs`, so an instance
    /// nobody resumed doesn't linger forever. Returns how many were removed.
    pub fn sweep(&self, now: i64, retention_secs: i64) -> Result<usize, String> {
        let conn = self.lock();
        let n = conn
            .execute(
                "DELETE FROM activity_drafts WHERE updated_at < ?1",
                [now - retention_secs],
            )
            .map_err(e2s)?;
        self.count.fetch_sub(n as i64, Ordering::Relaxed);
        Ok(n)
    }
}

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(tag: &str, max: u64) -> (ActivityDraftStore, std::path::PathBuf) {
        let path =
            std::env::temp_dir().join(format!("dweeb-draft-test-{}-{tag}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        (
            ActivityDraftStore::open(path.to_str().unwrap(), max).unwrap(),
            path,
        )
    }

    #[test]
    fn put_get_roundtrip_and_overwrite() {
        let (store, path) = temp_store("roundtrip", 100);
        assert_eq!(store.get("inst-1").unwrap(), None);
        store.put("inst-1", "sealed-a", 1000).unwrap();
        assert_eq!(store.get("inst-1").unwrap().as_deref(), Some("sealed-a"));
        // Overwriting the same instance keeps one row (no count growth).
        store.put("inst-1", "sealed-b", 1001).unwrap();
        assert_eq!(store.get("inst-1").unwrap().as_deref(), Some("sealed-b"));
        assert_eq!(store.count.load(Ordering::Relaxed), 1);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn new_instances_are_capped_but_updates_still_apply() {
        let (store, path) = temp_store("cap", 2);
        store.put("a", "x", 1).unwrap();
        store.put("b", "x", 1).unwrap();
        // Third distinct instance is silently dropped (best-effort).
        store.put("c", "x", 1).unwrap();
        assert_eq!(store.get("c").unwrap(), None);
        // But updating one of the existing instances still works.
        store.put("a", "y", 2).unwrap();
        assert_eq!(store.get("a").unwrap().as_deref(), Some("y"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sweep_removes_stale_rows() {
        let (store, path) = temp_store("sweep", 100);
        store.put("old", "x", 1_000).unwrap();
        store.put("fresh", "x", 10_000).unwrap();
        // Retention 100s at now=10_050 → "old" (updated_at 1000) is stale.
        let removed = store.sweep(10_050, 100).unwrap();
        assert_eq!(removed, 1);
        assert_eq!(store.get("old").unwrap(), None);
        assert!(store.get("fresh").unwrap().is_some());
        assert_eq!(store.count.load(Ordering::Relaxed), 1);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn queued_snapshots_persist_only_the_latest_value() {
        let (store, path) = temp_store("queued", 100);
        let store = Arc::new(store);
        let key = Key::from(&[7_u8; 64]);
        let worker = tokio::spawn(Arc::clone(&store).run_writer(key.clone()));

        store.queue_put("room".into(), r#"{"content":"old"}"#.into(), 1_000);
        store.queue_put("room".into(), r#"{"content":"latest"}"#.into(), 1_001);

        let plain = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Some(sealed) = store.get("room").unwrap() {
                    break crate::seal::open(&key, &sealed).unwrap();
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("coalesced writer should flush promptly");
        assert_eq!(plain, r#"{"content":"latest"}"#);
        assert_eq!(store.count.load(Ordering::Relaxed), 1);

        worker.abort();
        let _ = worker.await;
        drop(store);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn pending_plaintext_is_bounded() {
        let (store, path) = temp_store("pending-cap", (MAX_PENDING_DRAFTS + 100) as u64);
        for i in 0..(MAX_PENDING_DRAFTS + 25) {
            store.queue_put(format!("room-{i}"), "{}".into(), 1_000);
        }
        assert_eq!(store.pending.lock().unwrap().len(), MAX_PENDING_DRAFTS);
        // A hot room still replaces its queued value at the ceiling.
        store.queue_put("room-0".into(), r#"{"content":"new"}"#.into(), 1_001);
        assert_eq!(store.pending.lock().unwrap()["room-0"].updated_at, 1_001);
        drop(store);
        let _ = std::fs::remove_file(path);
    }
}
