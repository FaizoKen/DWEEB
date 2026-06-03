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
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
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
    inner: Mutex<Inner>,
}

impl RateLimiter {
    pub fn new(per_min: u32, burst: u32) -> Self {
        RateLimiter {
            rate_per_sec: (per_min.max(1) as f64) / 60.0,
            burst: burst.max(1) as f64,
            inner: Mutex::new(Inner {
                buckets: HashMap::new(),
                last_sweep: Instant::now(),
            }),
        }
    }

    /// Try to spend one token for `ip`. `Ok(())` allows the request; `Err(secs)`
    /// rejects it with the number of seconds until a token is available.
    pub fn check(&self, ip: IpAddr) -> Result<(), f64> {
        let now = Instant::now();
        let mut inner = match self.inner.lock() {
            Ok(g) => g,
            // A poisoned lock shouldn't take the service down — fail open.
            Err(p) => p.into_inner(),
        };

        if now.duration_since(inner.last_sweep) >= SWEEP_INTERVAL {
            inner.buckets.retain(|_, b| now.duration_since(b.last) < IDLE_EVICT);
            inner.last_sweep = now;
        }

        let burst = self.burst;
        let rate = self.rate_per_sec;
        let bucket = inner.buckets.entry(ip).or_insert(Bucket {
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
/// horizontally-scaled fleet). The Redis variant is a fixed 60-second window
/// counter — coarser than the token bucket, but correct and atomic across
/// instances, and it fails *open* so a Redis blip never blocks traffic.
pub enum Limiter {
    Memory(RateLimiter),
    Redis {
        conn: redis::aio::ConnectionManager,
        per_min: u32,
        burst: u32,
    },
}

impl Limiter {
    pub async fn check(&self, ip: IpAddr) -> Result<(), f64> {
        match self {
            Limiter::Memory(l) => l.check(ip),
            Limiter::Redis {
                conn,
                per_min,
                burst,
            } => {
                let mut conn = conn.clone();
                let key = format!("dweeb:rl:{ip}");
                let count: i64 = match redis::cmd("INCR").arg(&key).query_async(&mut conn).await {
                    Ok(c) => c,
                    Err(e) => {
                        // Fail open: a Redis hiccup must not block legitimate traffic.
                        tracing::warn!("redis INCR failed: {e}");
                        return Ok(());
                    }
                };
                // First hit in this window starts the 60s expiry.
                if count == 1 {
                    let _: i64 = redis::cmd("EXPIRE")
                        .arg(&key)
                        .arg(60)
                        .query_async(&mut conn)
                        .await
                        .unwrap_or(0);
                }
                let cap = (*per_min as i64) + (*burst as i64);
                if count <= cap {
                    Ok(())
                } else {
                    let ttl: i64 = redis::cmd("TTL")
                        .arg(&key)
                        .query_async(&mut conn)
                        .await
                        .unwrap_or(60);
                    Err(ttl.max(1) as f64)
                }
            }
        }
    }
}

/// Tower middleware: rate-limit by client IP, short-circuiting with 429.
pub async fn rate_limit(State(limiter): State<Arc<Limiter>>, req: Request, next: Next) -> Response {
    let ip = client_ip(&req);
    match limiter.check(ip).await {
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
