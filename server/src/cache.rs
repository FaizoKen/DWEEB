//! Short-TTL caching for guild data and per-user guild lists.
//!
//! Two backends sit behind one async [`DataCache`] interface:
//!   - [`TtlCache`] — a process-local map. Zero dependencies, perfect for a
//!     single instance. Because the key space is tiny we don't evict expired
//!     entries; they're ignored on read and overwritten on the next miss.
//!   - **Redis** — shared across instances, so a horizontally-scaled deployment
//!     keeps one cache (and one Discord rate budget) behind a load balancer.
//!
//! Redis is best-effort: any error degrades to a cache miss / no-op rather than
//! failing the request, so a Redis blip never takes the proxy down.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use serde_json::Value;

pub struct TtlCache {
    ttl: Duration,
    map: RwLock<HashMap<String, (Instant, Arc<Value>)>>,
}

impl TtlCache {
    pub fn new(ttl: Duration) -> Self {
        TtlCache {
            ttl,
            map: RwLock::new(HashMap::new()),
        }
    }

    /// Return the cached value for `key` if present and not yet expired.
    pub fn get(&self, key: &str) -> Option<Arc<Value>> {
        let map = self.map.read().ok()?;
        let (expires, value) = map.get(key)?;
        if *expires > Instant::now() {
            Some(Arc::clone(value))
        } else {
            None
        }
    }

    /// Store `value` under `key`, expiring `ttl` from now.
    pub fn put(&self, key: String, value: Arc<Value>) {
        if let Ok(mut map) = self.map.write() {
            map.insert(key, (Instant::now() + self.ttl, value));
        }
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
                match redis::cmd("GET")
                    .arg(&rkey)
                    .query_async::<Option<String>>(&mut conn)
                    .await
                {
                    Ok(Some(s)) => serde_json::from_str::<Value>(&s).ok().map(Arc::new),
                    Ok(None) => None,
                    Err(e) => {
                        tracing::warn!("redis GET failed: {e}");
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
                    if let Err(e) = redis::cmd("SET")
                        .arg(&rkey)
                        .arg(s)
                        .arg("EX")
                        .arg(*ttl_secs)
                        .query_async::<()>(&mut conn)
                        .await
                    {
                        tracing::warn!("redis SET failed: {e}");
                    }
                }
            }
        }
    }
}
