//! A tiny connection pool for the SQLite-backed stores.
//!
//! Every store used to hold a single `Mutex<Connection>`, which serialized
//! *all* of its reads and writes behind one lock — so a slow write (or the
//! background worker's writes) blocked unrelated reads, wasting the concurrency
//! WAL mode is meant to provide. This pool opens a handful of connections to the
//! same database file instead: WAL lets them **read concurrently**, and writes
//! still serialize correctly at the SQLite layer (a second writer simply waits
//! out `busy_timeout`, which is ample at this proxy's write volume). Each
//! connection carries its own prepared-statement cache.
//!
//! Why this is a safe drop-in: every store method already checks out one
//! connection for the whole of its logical operation (it holds a `lock()` guard
//! across its statements / transaction), so handing that method *one* pooled
//! connection preserves its transactional semantics exactly — `BEGIN…COMMIT`,
//! `last_insert_rowid()`, and multi-statement read-modify-writes all stay on a
//! single connection. The pool only spreads *independent* operations across
//! different connections. Because WAL readers observe the latest committed
//! snapshot at the moment their statement runs, a read issued after a write
//! commits still sees that write, so read-after-write stays consistent across
//! connections in-process.
//!
//! Size is `SQLITE_POOL_SIZE` (default [`DEFAULT_POOL_SIZE`], floor 1). Setting
//! it to `1` reproduces the old single-connection behaviour exactly — the escape
//! hatch if a deployment is memory-constrained (each extra connection carries
//! its own page + statement cache).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

use rusqlite::Connection;

/// Connections per store when `SQLITE_POOL_SIZE` is unset. Small on purpose:
/// enough to decouple the writer from readers and give a little read
/// parallelism, without multiplying per-connection memory on a modest host.
pub const DEFAULT_POOL_SIZE: usize = 3;

/// The configured pool size, read once from `SQLITE_POOL_SIZE` (floor 1). All
/// stores share this so a single knob tunes the whole proxy.
pub fn configured_size() -> usize {
    static SIZE: OnceLock<usize> = OnceLock::new();
    *SIZE.get_or_init(|| {
        std::env::var("SQLITE_POOL_SIZE")
            .ok()
            .and_then(|v| v.trim().parse::<usize>().ok())
            .unwrap_or(DEFAULT_POOL_SIZE)
            .max(1)
    })
}

/// A fixed set of connections to one database file, checked out round-robin.
pub struct SqlitePool {
    conns: Vec<Mutex<Connection>>,
    next: AtomicUsize,
}

impl SqlitePool {
    /// Open `size` connections to `path` (clamped to ≥1), running `init` on each
    /// — that's where a store sets its per-connection pragmas (WAL / synchronous
    /// / busy_timeout). Schema creation, migrations, and any one-time work belong
    /// in the caller *after* this returns (run once via [`SqlitePool::get`]), not
    /// in `init`, which fires on every connection.
    pub fn open(
        path: &str,
        size: usize,
        init: impl Fn(&Connection) -> Result<(), String>,
    ) -> Result<Self, String> {
        let size = size.max(1);
        let mut conns = Vec::with_capacity(size);
        for _ in 0..size {
            let conn = Connection::open(path).map_err(|e| format!("could not open {path}: {e}"))?;
            init(&conn)?;
            conns.push(Mutex::new(conn));
        }
        Ok(Self {
            conns,
            next: AtomicUsize::new(0),
        })
    }

    /// Open a pool of [`configured_size`] connections — the usual entry point.
    pub fn open_default(
        path: &str,
        init: impl Fn(&Connection) -> Result<(), String>,
    ) -> Result<Self, String> {
        Self::open(path, configured_size(), init)
    }

    /// Check out a connection for one operation. Prefers an immediately-free
    /// connection (so a caller isn't queued behind a busy one while another sits
    /// idle) and otherwise blocks on the round-robin pick. A poisoned lock — a
    /// panic left a guard behind mid-operation — is recovered via `into_inner`
    /// rather than propagated, so one bad row can't wedge the whole store (the
    /// same poison-tolerance the single-`Mutex` stores had).
    pub fn get(&self) -> MutexGuard<'_, Connection> {
        let start = self.next.fetch_add(1, Ordering::Relaxed);
        let n = self.conns.len();
        // First pass: grab any connection that's free right now.
        for k in 0..n {
            let idx = (start.wrapping_add(k)) % n;
            if let Ok(guard) = self.conns[idx].try_lock() {
                return guard;
            }
        }
        // Everything's busy (or poisoned): block on our round-robin pick,
        // recovering it if poisoned.
        let idx = start % n;
        self.conns[idx].lock().unwrap_or_else(|p| p.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn temp_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("dweeb-pool-test-{}-{tag}.db", std::process::id()))
    }

    fn init_wal(c: &Connection) -> Result<(), String> {
        c.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        c.pragma_update(None, "busy_timeout", 5_000)
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[test]
    fn size_is_clamped_to_at_least_one() {
        let path = temp_path("clamp");
        let _ = std::fs::remove_file(&path);
        let pool = SqlitePool::open(path.to_str().unwrap(), 0, init_wal).unwrap();
        assert_eq!(pool.conns.len(), 1);
        // A size-1 pool still round-trips a write then read sequentially (each
        // op takes and drops its own guard — the pattern every store follows).
        pool.get()
            .execute_batch("CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (42);")
            .unwrap();
        let v: i64 = pool
            .get()
            .query_row("SELECT v FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 42);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn concurrent_reads_all_see_committed_write() {
        let path = temp_path("concurrent");
        let _ = std::fs::remove_file(&path);
        let pool = Arc::new(SqlitePool::open(path.to_str().unwrap(), 4, init_wal).unwrap());
        pool.get()
            .execute_batch("CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (7);")
            .unwrap();

        // Many threads read at once: with a single shared connection this would
        // serialize; across the pool they run concurrently. All must see the
        // committed row (read-after-write across connections) and none deadlock.
        let handles: Vec<_> = (0..16)
            .map(|_| {
                let pool = Arc::clone(&pool);
                std::thread::spawn(move || {
                    let v: i64 = pool
                        .get()
                        .query_row("SELECT v FROM t", [], |r| r.get(0))
                        .unwrap();
                    assert_eq!(v, 7);
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn get_round_robins_across_connections() {
        let path = temp_path("rr");
        let _ = std::fs::remove_file(&path);
        let pool = SqlitePool::open(path.to_str().unwrap(), 3, init_wal).unwrap();
        // Hold two guards at once: they must be distinct connections (the first
        // pass hands out a free one rather than blocking on the busy pick).
        let a = pool.get();
        let b = pool.get();
        // Distinct underlying connections => distinct guard addresses.
        assert!(!std::ptr::eq(&*a as *const _, &*b as *const _));
        drop((a, b));
        let _ = std::fs::remove_file(&path);
    }
}
