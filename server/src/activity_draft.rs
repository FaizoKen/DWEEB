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

use std::path::Path as FsPath;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;

use rusqlite::{params, Connection};

/// SQLite-backed map of `instance_id → sealed latest draft`.
pub struct ActivityDraftStore {
    conn: Mutex<Connection>,
    max_entries: i64,
    /// Approximate row count, kept in step with inserts/deletes so the cap check
    /// is a load rather than a `COUNT(*)` on the persist hot path.
    count: AtomicI64,
}

impl ActivityDraftStore {
    pub fn open(path: &str, max_entries: u64) -> Result<Self, String> {
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
            "CREATE TABLE IF NOT EXISTS activity_drafts (
                 instance_id  TEXT PRIMARY KEY,
                 draft_sealed TEXT NOT NULL,
                 updated_at   INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_activity_drafts_updated
                 ON activity_drafts(updated_at);",
        )
        .map_err(|e| format!("schema: {e}"))?;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM activity_drafts", [], |r| r.get(0))
            .map_err(|e| format!("count: {e}"))?;
        Ok(ActivityDraftStore {
            conn: Mutex::new(conn),
            max_entries: max_entries as i64,
            count: AtomicI64::new(count),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Upsert the sealed draft for `instance`. Updating an existing instance is
    /// always allowed (it doesn't grow the table); a brand-new instance is
    /// dropped silently once the global cap is hit — persistence is best-effort,
    /// so a full table just degrades to the old ephemeral behaviour rather than
    /// failing the edit.
    pub fn put(&self, instance: &str, draft_sealed: &str, now: i64) -> Result<(), String> {
        let conn = self.lock();
        let updated = conn
            .execute(
                "UPDATE activity_drafts SET draft_sealed = ?2, updated_at = ?3 \
                 WHERE instance_id = ?1",
                params![instance, draft_sealed, now],
            )
            .map_err(e2s)?;
        if updated > 0 {
            return Ok(());
        }
        if self.count.load(Ordering::Relaxed) >= self.max_entries {
            return Ok(());
        }
        conn.execute(
            "INSERT INTO activity_drafts (instance_id, draft_sealed, updated_at) \
             VALUES (?1, ?2, ?3)",
            params![instance, draft_sealed, now],
        )
        .map_err(e2s)?;
        self.count.fetch_add(1, Ordering::Relaxed);
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
}
