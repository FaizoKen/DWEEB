//! Process-local single-flight for the cached guild reads.
//!
//! A cold cache — right after sign-in, or once the short TTL lapses — lets a
//! burst of requests each fire its own Discord round-trip for the *same* data:
//! several browser tabs, a quick double reload, or simply the proxy serving many
//! users whose `botguilds`/`uguilds` entries expired at once. That burst is what
//! trips Discord's per-route rate limit (the shared bot token's
//! `/users/@me/guilds` route is especially tight). Single-flight collapses it:
//! the first caller for a key does the fetch while everyone else waits on the
//! same key, then reads the value the first one just cached — so Discord sees
//! one call instead of N.
//!
//! It's a keyed async mutex. A caller acquires the gate for a key, *re-checks the
//! cache* (the leader may have filled it while they queued), and only hits Discord
//! on a still-cold cache. The map holds `Weak` handles, so it never keeps a gate
//! alive on its own; once every caller for a key has dropped its guard the gate is
//! freed, and a cheap prune reclaims the dead map entry. The key space is tiny
//! (a few per guild + per user), so this stays small.

use std::collections::HashMap;
use std::sync::{Mutex, Weak};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

/// Prune dead (dropped-gate) entries once the map grows past this. Keeps a
/// long-lived server from accumulating one entry per guild/user ever seen,
/// without paying a scan on every acquire.
const PRUNE_THRESHOLD: usize = 256;

/// A set of per-key async gates that serialise callers sharing a key.
#[derive(Default)]
pub struct SingleFlight {
    gates: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
}

impl SingleFlight {
    pub fn new() -> Self {
        SingleFlight {
            gates: Mutex::new(HashMap::new()),
        }
    }

    /// Acquire the gate for `key`. Hold the returned guard across the cache
    /// re-check + fetch; dropping it (end of scope) releases the next waiter.
    /// Concurrent callers for the same key run one at a time; callers for
    /// different keys never block each other.
    pub async fn acquire(&self, key: &str) -> OwnedMutexGuard<()> {
        let gate = {
            // Fail open on a poisoned lock — a single bad scope must never wedge
            // every future read.
            let mut map = self.gates.lock().unwrap_or_else(|p| p.into_inner());
            if map.len() > PRUNE_THRESHOLD {
                map.retain(|_, w| w.strong_count() > 0);
            }
            match map.get(key).and_then(Weak::upgrade) {
                Some(g) => g,
                None => {
                    let g = std::sync::Arc::new(AsyncMutex::new(()));
                    map.insert(key.to_string(), std::sync::Arc::downgrade(&g));
                    g
                }
            }
        };
        // The owned guard keeps the gate's Arc alive while held; when the last
        // caller drops it the gate frees and its map entry becomes prunable.
        gate.lock_owned().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    /// Concurrent acquirers of one key run strictly one at a time; different
    /// keys don't block each other.
    #[tokio::test]
    async fn coalesces_same_key_serially() {
        let sf = Arc::new(SingleFlight::new());
        let running = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));

        let mut handles = Vec::new();
        for _ in 0..8 {
            let sf = Arc::clone(&sf);
            let running = Arc::clone(&running);
            let max_seen = Arc::clone(&max_seen);
            handles.push(tokio::spawn(async move {
                let _g = sf.acquire("same").await;
                let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                max_seen.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(5)).await;
                running.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        // Never two holders of the same key at once.
        assert_eq!(max_seen.load(Ordering::SeqCst), 1);
    }

    /// The map doesn't keep gates alive after all guards drop.
    #[tokio::test]
    async fn frees_gate_after_release() {
        let sf = SingleFlight::new();
        {
            let _g = sf.acquire("k").await;
        }
        let map = sf.gates.lock().unwrap();
        // Entry may still be present as a key, but its Weak no longer upgrades.
        assert!(map.get("k").and_then(Weak::upgrade).is_none());
    }
}
