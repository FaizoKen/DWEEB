//! A small, dependency-free per-IP rate limiter (token bucket).
//!
//! It protects two things at once on a public deployment: the shared bot token's
//! Discord rate budget, and the OAuth endpoints against brute-force/abuse. Each
//! client IP gets a bucket that refills at `rate_per_sec` up to `burst`; a
//! request costs one token, and an empty bucket yields `429` with a
//! `Retry-After` hint.
//!
//! The limiter is applied as Tower middleware via `from_fn_with_state`, so it
//! depends only on `Arc<RateLimiter>` — not on the app state — which keeps the
//! module self-contained.
//!
//! Behind Cloudflare/Tunnel the socket peer is localhost, so the real client is
//! taken from `CF-Connecting-IP` / `X-Forwarded-For` / `X-Real-IP`, falling back
//! to the peer address. Only deploy this behind a trusted proxy that sets those
//! headers; a directly-exposed instance could be spoofed.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use std::sync::Arc;

/// How often to sweep idle buckets, and how long a bucket must be untouched to
/// be evicted — together these bound memory under churny public traffic.
const SWEEP_INTERVAL: Duration = Duration::from_secs(120);
const IDLE_EVICT: Duration = Duration::from_secs(300);
/// A broken Redis connection must not sit outside the app's request timeout and
/// stall every route. The limiter deliberately fails open after this deadline.
const CHECK_TIMEOUT: Duration = Duration::from_secs(2);
/// Bound memory under high-cardinality source churn. Once full, unseen clients
/// share one overflow bucket until the regular idle sweep frees space.
const MAX_BUCKETS: usize = 50_000;
const OVERFLOW_BUCKET: IpAddr = IpAddr::V4(Ipv4Addr::UNSPECIFIED);

struct Bucket {
    tokens: f64,
    last: Instant,
}

struct Inner {
    buckets: HashMap<IpAddr, Bucket>,
    last_sweep: Instant,
}

pub struct RateLimiter {
    rate_per_sec: f64,
    burst: f64,
    /// Keep a bucket at least until it could have refilled from empty. A fixed
    /// five-minute eviction let a 15-minute feedback bucket reset early.
    idle_evict: Duration,
    inner: Mutex<Inner>,
}

impl RateLimiter {
    pub fn new(per_min: u32, burst: u32) -> Self {
        Self::with_rate((per_min.max(1) as f64) / 60.0, burst)
    }

    /// A bucket that permits `capacity` immediate requests, then refills that
    /// whole budget over `window`. Useful for low-volume public actions (such
    /// as feedback) where an integer requests-per-minute rate is too generous.
    pub fn for_window(capacity: u32, window: Duration) -> Self {
        let capacity = capacity.max(1);
        Self::with_rate((capacity as f64) / window.as_secs_f64().max(1.0), capacity)
    }

    fn with_rate(rate_per_sec: f64, burst: u32) -> Self {
        let burst = burst.max(1) as f64;
        let full_refill = Duration::from_secs_f64((burst / rate_per_sec).max(1.0));
        Self {
            rate_per_sec,
            burst,
            idle_evict: IDLE_EVICT.max(full_refill),
            inner: Mutex::new(Inner {
                buckets: HashMap::new(),
                last_sweep: Instant::now(),
            }),
        }
    }

    /// Try to spend one token for `ip`. `Ok(())` allows the request; `Err(secs)`
    /// rejects it with the number of seconds until a token is available.
    pub fn check(&self, ip: IpAddr) -> Result<(), f64> {
        let ip = canonical_ip(ip);
        let now = Instant::now();
        let mut inner = match self.inner.lock() {
            Ok(g) => g,
            // A poisoned lock shouldn't take the service down — fail open.
            Err(p) => p.into_inner(),
        };

        if now.duration_since(inner.last_sweep) >= SWEEP_INTERVAL {
            let idle_evict = self.idle_evict;
            inner
                .buckets
                .retain(|_, b| now.duration_since(b.last) < idle_evict);
            inner.last_sweep = now;
        }

        let bucket_ip = if inner.buckets.contains_key(&ip) || inner.buckets.len() < MAX_BUCKETS {
            ip
        } else {
            if !inner.buckets.contains_key(&OVERFLOW_BUCKET) {
                // Make one slot for the shared overflow bucket. This happens
                // only once per saturation cycle; subsequent unseen clients do
                // not grow the map or trigger an O(n) eviction scan.
                if let Some(existing) = inner.buckets.keys().next().copied() {
                    inner.buckets.remove(&existing);
                }
            }
            OVERFLOW_BUCKET
        };

        let burst = self.burst;
        let rate = self.rate_per_sec;
        let bucket = inner.buckets.entry(bucket_ip).or_insert(Bucket {
            tokens: burst,
            last: now,
        });
        let elapsed = now.duration_since(bucket.last).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * rate).min(burst);
        bucket.last = now;

        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            Err((1.0 - bucket.tokens) / rate)
        }
    }
}

/// Async limiter facade: in-memory (per instance) or Redis (shared across a
/// horizontally-scaled fleet). The Redis variant is a fixed-window counter —
/// coarser than the token bucket, but correct and atomic across instances, and
/// it fails *open* so a Redis blip never blocks traffic. `key_prefix` keeps a
/// strict route-local budget independent from the global API budget.
pub enum Limiter {
    Memory(RateLimiter),
    Redis {
        conn: redis::aio::ConnectionManager,
        key_prefix: &'static str,
        limit: u32,
        window_secs: u64,
    },
}

impl Limiter {
    pub async fn check(&self, ip: IpAddr) -> Result<(), f64> {
        match self {
            Limiter::Memory(l) => l.check(ip),
            Limiter::Redis {
                conn,
                key_prefix,
                limit,
                window_secs,
            } => {
                let ip = canonical_ip(ip);
                let mut conn = conn.clone();
                let key = if key_prefix.is_empty() {
                    format!("dweeb:rl:{ip}")
                } else {
                    format!("dweeb:rl:{key_prefix}:{ip}")
                };
                // Increment, install/repair the TTL, and read it in one atomic
                // script. Separate INCR + EXPIRE calls could strand a key with
                // no expiry if Redis failed between them, permanently blocking
                // that IP. `ttl < 0` also repairs any legacy stranded key.
                const WINDOW_SCRIPT: &str = r#"
                    local count = redis.call('INCR', KEYS[1])
                    local ttl = redis.call('TTL', KEYS[1])
                    if ttl < 0 then
                        redis.call('EXPIRE', KEYS[1], ARGV[1])
                        ttl = tonumber(ARGV[1])
                    end
                    return {count, ttl}
                "#;
                let (count, ttl): (i64, i64) = match redis::cmd("EVAL")
                    .arg(WINDOW_SCRIPT)
                    .arg(1)
                    .arg(&key)
                    .arg(*window_secs)
                    .query_async(&mut conn)
                    .await
                {
                    Ok(result) => result,
                    Err(e) => {
                        // Fail open: a Redis hiccup must not block legitimate traffic.
                        tracing::warn!("redis rate-limit script failed: {e}");
                        return Ok(());
                    }
                };
                if count <= i64::from((*limit).max(1)) {
                    Ok(())
                } else {
                    Err(ttl.max(1) as f64)
                }
            }
        }
    }
}

/// Tower middleware: rate-limit by client IP, short-circuiting with 429.
pub async fn rate_limit(State(limiter): State<Arc<Limiter>>, req: Request, next: Next) -> Response {
    let ip = client_ip(&req);
    let check = match tokio::time::timeout(CHECK_TIMEOUT, limiter.check(ip)).await {
        Ok(result) => result,
        Err(_) => {
            tracing::warn!("rate-limit check timed out; failing open");
            return next.run(req).await;
        }
    };
    match check {
        Ok(()) => next.run(req).await,
        Err(retry_after) => {
            let secs = retry_after.ceil().max(1.0);
            let body = Json(json!({
                "error": "Too many requests — slow down.",
                "status": 429,
                "retry_after": secs,
            }));
            let mut resp = (StatusCode::TOO_MANY_REQUESTS, body).into_response();
            if let Ok(hv) = header::HeaderValue::from_str(&secs.to_string()) {
                resp.headers_mut().insert(header::RETRY_AFTER, hv);
            }
            resp
        }
    }
}

/// Resolve the client IP, trusting the front proxy's forwarding headers.
fn client_ip(req: &Request) -> IpAddr {
    let headers = req.headers();
    if let Some(ip) = header_ip(headers, "cf-connecting-ip") {
        return ip;
    }
    if let Some(ip) = forwarded_for(headers) {
        return ip;
    }
    if let Some(ip) = header_ip(headers, "x-real-ip") {
        return ip;
    }
    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip())
        // Last resort: a single shared bucket. Never silently un-limited.
        .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
}

/// Parse a single-IP header value (e.g. `CF-Connecting-IP`, `X-Real-IP`).
fn header_ip(headers: &HeaderMap, name: &str) -> Option<IpAddr> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<IpAddr>().ok())
}

/// Take the left-most address from `X-Forwarded-For` (the original client).
fn forwarded_for(headers: &HeaderMap) -> Option<IpAddr> {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .and_then(|s| s.trim().parse::<IpAddr>().ok())
}

/// Treat one IPv6 /64 as one client identity. A single subscriber commonly
/// controls many addresses inside that prefix; keying the full 128 bits makes
/// both rate-limit bypass and bucket-cardinality attacks unnecessarily cheap.
fn canonical_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(v4) => IpAddr::V4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return IpAddr::V4(v4);
            }
            let s = v6.segments();
            IpAddr::V6(Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_limiter_starts_with_exact_capacity() {
        let limiter = RateLimiter::for_window(3, Duration::from_secs(15 * 60));
        let ip = IpAddr::V4(Ipv4Addr::LOCALHOST);

        assert!(limiter.check(ip).is_ok());
        assert!(limiter.check(ip).is_ok());
        assert!(limiter.check(ip).is_ok());
        let retry_after = limiter.check(ip).unwrap_err();
        // Three tokens refill across fifteen minutes: one token every five.
        assert!(retry_after > 0.0 && retry_after <= 300.0);
    }

    #[test]
    fn buckets_are_independent_per_ip() {
        let limiter = RateLimiter::for_window(1, Duration::from_secs(60));
        let first = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1));
        let second = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 2));

        assert!(limiter.check(first).is_ok());
        assert!(limiter.check(first).is_err());
        assert!(limiter.check(second).is_ok());
    }

    #[test]
    fn ipv6_addresses_share_a_prefix_bucket() {
        let limiter = RateLimiter::for_window(1, Duration::from_secs(60));
        let first = "2001:db8:abcd:1234::1".parse().unwrap();
        let same_prefix = "2001:db8:abcd:1234:ffff::2".parse().unwrap();
        let other_prefix = "2001:db8:abcd:5678::1".parse().unwrap();

        assert!(limiter.check(first).is_ok());
        assert!(limiter.check(same_prefix).is_err());
        assert!(limiter.check(other_prefix).is_ok());
    }

    #[test]
    fn ipv4_mapped_addresses_use_the_ipv4_key() {
        assert_eq!(
            canonical_ip("::ffff:192.0.2.9".parse().unwrap()),
            IpAddr::V4(Ipv4Addr::new(192, 0, 2, 9))
        );
    }

    #[test]
    fn slow_window_bucket_is_not_evicted_before_full_refill() {
        let limiter = RateLimiter::for_window(3, Duration::from_secs(15 * 60));
        assert_eq!(limiter.idle_evict, Duration::from_secs(15 * 60));

        let ordinary = RateLimiter::new(60, 10);
        assert_eq!(ordinary.idle_evict, IDLE_EVICT);
    }
}
