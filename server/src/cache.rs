//! Short-TTL caching for guild data and per-user guild lists.
//!
//! Two backends sit behind one async [`DataCache`] interface:
//!   - [`TtlCache`] — a process-local map. Zero dependencies, perfect for a
//!     single instance. Expired entries are reclaimed lazily and a hard entry
//!     ceiling bounds memory under high-cardinality user/guild churn.
//!   - **Redis** — shared across instances, so a horizontally-scaled deployment
//!     keeps one cache (and one Discord rate budget) behind a load balancer.
//!
//! Redis is best-effort: any error degrades to a cache miss / no-op rather than
//! failing the request, so a Redis blip never takes the proxy down.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use serde_json::Value;

/// The cache holds whole Discord guild/user JSON trees, so one entry can be
/// sizeable. Ten thousand entries leaves ample room for thousands of active
/// users while preventing a high-cardinality scan from retaining values for the
/// entire process lifetime. Once full, existing hot keys still refresh; unseen
/// keys simply run uncached until the next expiry sweep frees capacity.
const DEFAULT_MAX_ENTRIES: usize = 10_000;
/// An entry count alone is not enough: a guild with hundreds of channels/roles
/// is far larger than a tiny identity record. Bound the estimated retained JSON
/// tree size as well, so ten thousand pathological values cannot consume GiBs.
const DEFAULT_MAX_WEIGHT: usize = 32 * 1024 * 1024;
/// Avoid an O(n) expiry scan on every write. Cache TTLs are normally one minute;
/// longer TTLs still get a periodic sweep so dead values don't linger forever.
const MAX_SWEEP_INTERVAL: Duration = Duration::from_secs(60);
/// Redis is an optional acceleration layer, not a request dependency. Bound
/// every command so a degraded cache cannot occupy request tasks (and their
/// response buffers) until the global HTTP timeout fires.
const REDIS_COMMAND_TIMEOUT: Duration = Duration::from_secs(2);

struct Entry {
    expires: Instant,
    value: Arc<Value>,
    weight: usize,
}

struct Inner {
    map: HashMap<String, Entry>,
    weight: usize,
    next_sweep: Instant,
}

pub struct TtlCache {
    ttl: Duration,
    sweep_interval: Duration,
    max_entries: usize,
    max_weight: usize,
    inner: RwLock<Inner>,
}

impl TtlCache {
    pub fn new(ttl: Duration) -> Self {
        Self::with_limits(ttl, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_WEIGHT)
    }

    #[cfg(test)]
    fn with_capacity(ttl: Duration, max_entries: usize) -> Self {
        Self::with_limits(ttl, max_entries, DEFAULT_MAX_WEIGHT)
    }

    fn with_limits(ttl: Duration, max_entries: usize, max_weight: usize) -> Self {
        let sweep_interval = ttl.min(MAX_SWEEP_INTERVAL);
        let now = Instant::now();
        TtlCache {
            ttl,
            sweep_interval,
            max_entries: max_entries.max(1),
            max_weight: max_weight.max(1),
            inner: RwLock::new(Inner {
                map: HashMap::new(),
                weight: 0,
                next_sweep: now + sweep_interval,
            }),
        }
    }

    /// Return the cached value for `key` if present and not yet expired.
    pub fn get(&self, key: &str) -> Option<Arc<Value>> {
        let now = Instant::now();
        {
            let inner = self.inner.read().ok()?;
            let entry = inner.map.get(key)?;
            if entry.expires > now {
                return Some(Arc::clone(&entry.value));
            }
        }

        // Reclaim an expired hit immediately. Re-check after upgrading the lock:
        // another writer may have refreshed this key in between.
        if let Ok(mut inner) = self.inner.write() {
            if inner
                .map
                .get(key)
                .is_some_and(|entry| entry.expires <= Instant::now())
            {
                if let Some(expired) = inner.map.remove(key) {
                    inner.weight = inner.weight.saturating_sub(expired.weight);
                }
            }
        }
        None
    }

    /// Store `value` under `key`, expiring `ttl` from now.
    pub fn put(&self, key: String, value: Arc<Value>) {
        // Walk the newly-fetched tree before taking the write lock. This is
        // allocation-free and happens once per cache fill, while keeping other
        // readers unblocked during the (potentially large) traversal.
        let weight = key
            .len()
            .saturating_add(std::mem::size_of::<Entry>())
            .saturating_add(value_weight(value.as_ref()));
        if weight > self.max_weight {
            return;
        }
        if let Ok(mut inner) = self.inner.write() {
            let now = Instant::now();
            if now >= inner.next_sweep {
                inner.map.retain(|_, entry| entry.expires > now);
                inner.weight = inner
                    .map
                    .values()
                    .fold(0usize, |sum, entry| sum.saturating_add(entry.weight));
                inner.next_sweep = now + self.sweep_interval;
            }

            // At capacity, keep serving and refreshing the established hot set
            // without allowing a stream of one-off keys to grow memory. We don't
            // scan for an eviction candidate here: doing O(n) work on every new
            // key at capacity would turn the safety bound into a CPU DoS vector.
            let previous = inner.map.get(&key).map_or(0, |entry| entry.weight);
            let next_weight = inner.weight.saturating_sub(previous).saturating_add(weight);
            let has_entry_capacity =
                inner.map.len() < self.max_entries || inner.map.contains_key(&key);
            if has_entry_capacity && next_weight <= self.max_weight {
                inner.map.insert(
                    key,
                    Entry {
                        expires: now + self.ttl,
                        value,
                        weight,
                    },
                );
                inner.weight = next_weight;
            }
        }
    }
}

/// Allocation-free approximation of the heap retained by a JSON value. It
/// counts each `Value`, string/key bytes, vector slots, and map-node overhead;
/// allocator bookkeeping may vary, so the byte ceiling is deliberately a
/// safety budget rather than a precise RSS meter.
fn value_weight(value: &Value) -> usize {
    let base = std::mem::size_of::<Value>();
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => base,
        Value::String(s) => base.saturating_add(s.capacity()),
        Value::Array(items) => items
            .iter()
            .fold(base, |sum, item| sum.saturating_add(value_weight(item))),
        Value::Object(map) => map.iter().fold(base, |sum, (key, value)| {
            sum.saturating_add(std::mem::size_of::<String>())
                .saturating_add(3 * std::mem::size_of::<usize>())
                .saturating_add(key.capacity())
                .saturating_add(value_weight(value))
        }),
    }
}

/// Async cache facade over either the in-memory map or Redis. Handlers only see
/// this type, so swapping backends is a one-line change in `main`.
pub enum DataCache {
    Memory(TtlCache),
    Redis {
        conn: redis::aio::ConnectionManager,
        ttl_secs: u64,
    },
}

impl DataCache {
    /// Fetch a cached value, or `None` on miss / backend error.
    pub async fn get(&self, key: &str) -> Option<Arc<Value>> {
        match self {
            DataCache::Memory(c) => c.get(key),
            DataCache::Redis { conn, .. } => {
                let mut conn = conn.clone();
                let rkey = format!("dweeb:cache:{key}");
                match tokio::time::timeout(
                    REDIS_COMMAND_TIMEOUT,
                    redis::cmd("GET")
                        .arg(&rkey)
                        .query_async::<Option<String>>(&mut conn),
                )
                .await
                {
                    Ok(Ok(Some(s))) => serde_json::from_str::<Value>(&s).ok().map(Arc::new),
                    Ok(Ok(None)) => None,
                    Ok(Err(e)) => {
                        tracing::warn!("redis GET failed: {e}");
                        None
                    }
                    Err(_) => {
                        tracing::warn!("redis GET timed out");
                        None
                    }
                }
            }
        }
    }

    /// Store `value` under `key` with the configured TTL. Errors are swallowed.
    pub async fn put(&self, key: String, value: Arc<Value>) {
        match self {
            DataCache::Memory(c) => c.put(key, value),
            DataCache::Redis { conn, ttl_secs } => {
                let mut conn = conn.clone();
                let rkey = format!("dweeb:cache:{key}");
                if let Ok(s) = serde_json::to_string(value.as_ref()) {
                    match tokio::time::timeout(
                        REDIS_COMMAND_TIMEOUT,
                        redis::cmd("SET")
                            .arg(&rkey)
                            .arg(s)
                            .arg("EX")
                            .arg(*ttl_secs)
                            .query_async::<()>(&mut conn),
                    )
                    .await
                    {
                        Ok(Ok(())) => {}
                        Ok(Err(e)) => tracing::warn!("redis SET failed: {e}"),
                        Err(_) => tracing::warn!("redis SET timed out"),
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn expired_hit_is_reclaimed() {
        let cache = TtlCache::with_capacity(Duration::ZERO, 2);
        cache.put("old".into(), Arc::new(json!({ "large": [1, 2, 3] })));

        assert!(cache.get("old").is_none());
        assert!(cache.inner.read().unwrap().map.is_empty());
    }

    #[test]
    fn writes_lazily_sweep_expired_entries() {
        let cache = TtlCache::with_capacity(Duration::ZERO, 2);
        cache.put("old".into(), Arc::new(json!(1)));
        // A zero TTL also makes the next sweep immediately due.
        cache.put("new".into(), Arc::new(json!(2)));

        let inner = cache.inner.read().unwrap();
        assert!(!inner.map.contains_key("old"));
        assert!(inner.map.contains_key("new"));
    }

    #[test]
    fn admission_is_bounded_but_existing_keys_can_refresh() {
        let cache = TtlCache::with_capacity(Duration::from_secs(60), 2);
        cache.put("a".into(), Arc::new(json!(1)));
        cache.put("b".into(), Arc::new(json!(2)));
        cache.put("uncached".into(), Arc::new(json!(3)));

        assert_eq!(cache.inner.read().unwrap().map.len(), 2);
        assert!(cache.get("uncached").is_none());

        cache.put("a".into(), Arc::new(json!(4)));
        assert_eq!(*cache.get("a").unwrap(), json!(4));
        assert_eq!(cache.inner.read().unwrap().map.len(), 2);
    }

    #[test]
    fn retained_json_weight_is_bounded() {
        let small = Arc::new(json!("ok"));
        let one_entry_budget = "a"
            .len()
            .saturating_add(std::mem::size_of::<Entry>())
            .saturating_add(value_weight(small.as_ref()));
        let cache = TtlCache::with_limits(Duration::from_secs(60), 10, one_entry_budget);
        cache.put("a".into(), Arc::clone(&small));
        cache.put("large".into(), Arc::new(json!("x".repeat(1024))));

        let inner = cache.inner.read().unwrap();
        assert_eq!(inner.map.len(), 1);
        assert!(inner.map.contains_key("a"));
        assert!(inner.weight <= one_entry_budget);
    }
}
