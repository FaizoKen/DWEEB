//! The scheduled-post delivery loop — the background task that fires due
//! schedules. Modelled on the self-role temporary-role reaper
//! (`plugins/self-role/src/reaper.rs`): all state is in SQLite, so a restart
//! resumes draining; each tick does a bounded batch so a backlog (after an
//! outage) can't hammer Discord; and a per-job failure never aborts the tick.
//!
//! **Duplicate-send guard.** [`ScheduleStore::claim_due`] flips a row
//! `active → sending` under a lease in one transaction, so an occurrence is
//! owned by exactly one tick. The only residual window is "POSTed to Discord,
//! crashed before recording success": the stale-lease reclaim then re-fires it.
//! That makes delivery **at-least-once** — a missed post is worse than a rare
//! duplicate, and Discord webhooks offer no server-side idempotency key to make
//! it exactly-once. A single worker + a short tick keep the window to one HTTP
//! call.
//!
//! **Catch-up policy.** The next occurrence of a recurring schedule is computed
//! as `next_after(rule, now)` — strictly after the *actual* fire time, never the
//! missed slot — so a long downtime yields at most one catch-up post, not a
//! burst of every occurrence that elapsed.

use std::sync::Arc;
use std::time::Duration;

use axum_extra::extract::cookie::Key;
use serde_json::Value;

use crate::schedule::{unix_now, ClaimedJob, ScheduleStore};
use crate::schedule_rule::{next_after, Recurrence};
use crate::schedule_validate::validate_webhook;
use crate::seal;

/// Never tick faster than this, however small the configured interval.
const MIN_TICK_SECS: u64 = 5;
/// Give up a job after this many consecutive transient failures, so a
/// permanently-unreachable target can't retry forever.
const MAX_TRANSIENT_ATTEMPTS: i64 = 10;
/// Exponential-backoff base for transient retries (doubles per attempt).
const BACKOFF_BASE_SECS: i64 = 30;
/// Backoff ceiling — also the 429 retry ceiling.
const BACKOFF_CAP_SECS: i64 = 3600;
/// How often to sweep terminal rows (done/failed past retention).
const SWEEP_INTERVAL_SECS: i64 = 3600;

/// Spawn the worker loop. `http` should carry a modest timeout (the worker is
/// off the 3s interaction budget, but a hung POST shouldn't hold a lease).
#[allow(clippy::too_many_arguments)]
pub fn spawn(
    store: Arc<ScheduleStore>,
    key: Key,
    http: reqwest::Client,
    tick_secs: u64,
    lease_secs: i64,
    batch: usize,
    retention_days: i64,
) {
    let period = Duration::from_secs(tick_secs.max(MIN_TICK_SECS));
    let retention_secs = retention_days.max(0) * 86_400;
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(period);
        // First sweep fires on the first tick (last_sweep far in the past), so
        // leftovers from before a restart are reclaimed promptly.
        let mut last_sweep: i64 = 0;
        loop {
            ticker.tick().await;
            if let Err(e) = drain_once(&store, &key, &http, lease_secs, batch).await {
                tracing::warn!(error = %e, "scheduler tick failed");
            }
            let now = unix_now();
            if retention_secs > 0 && now - last_sweep >= SWEEP_INTERVAL_SECS {
                last_sweep = now;
                let s = Arc::clone(&store);
                match tokio::task::spawn_blocking(move || s.sweep(now, retention_secs)).await {
                    Ok(Ok(0)) => {}
                    Ok(Ok(n)) => tracing::info!(deleted = n, "swept completed schedules"),
                    Ok(Err(e)) => tracing::warn!(error = %e, "schedule sweep failed"),
                    Err(e) => tracing::warn!(error = %e, "schedule sweep panicked"),
                }
            }
        }
    });
}

/// Claim and process one batch of due schedules.
async fn drain_once(
    store: &Arc<ScheduleStore>,
    key: &Key,
    http: &reqwest::Client,
    lease_secs: i64,
    batch: usize,
) -> Result<(), String> {
    let now = unix_now();
    let s = Arc::clone(store);
    let jobs = tokio::task::spawn_blocking(move || s.claim_due(now, lease_secs, batch))
        .await
        .map_err(|e| e.to_string())??;
    for job in jobs {
        process(store, key, http, job, now).await;
    }
    Ok(())
}

/// Fire one claimed occurrence and record the outcome.
async fn process(
    store: &Arc<ScheduleStore>,
    key: &Key,
    http: &reqwest::Client,
    job: ClaimedJob,
    now: i64,
) {
    // Open the sealed webhook + payload. A failure here means the key changed
    // (SESSION_SECRET rotated) or the row was tampered — neither will ever
    // succeed, so it's permanent.
    let Some(url) = seal::open(key, &job.webhook_sealed) else {
        fail(store, &job.id, now, None, "Couldn't decrypt the stored webhook (was SESSION_SECRET rotated?).").await;
        return;
    };
    if validate_webhook(&url).is_err() {
        fail(store, &job.id, now, None, "The stored webhook is not a Discord webhook URL.").await;
        return;
    }
    let Some(payload_str) = seal::open(key, &job.payload_sealed) else {
        fail(store, &job.id, now, None, "Couldn't decrypt the stored message.").await;
        return;
    };
    let Ok(payload) = serde_json::from_str::<Value>(&payload_str) else {
        fail(store, &job.id, now, None, "The stored message is corrupt.").await;
        return;
    };

    // `with_components=true` is mandatory for Components V2; `wait=true` makes
    // Discord echo the created message so we can record its id.
    let mut send_url = format!("{}?with_components=true&wait=true", url.trim());
    if let Some(thread) = &job.thread_id {
        send_url.push_str("&thread_id=");
        send_url.push_str(thread);
    }

    match http.post(&send_url).json(&payload).send().await {
        Ok(resp) => {
            let code = resp.status().as_u16();
            if resp.status().is_success() {
                let msg_id = resp
                    .json::<Value>()
                    .await
                    .ok()
                    .and_then(|v| v.get("id").and_then(|i| i.as_str().map(str::to_string)));
                let next = compute_next(&job, now);
                success(store, &job.id, now, msg_id.as_deref(), code as i64, next).await;
            } else if code == 429 {
                // Rate limited — honour Retry-After, treat as transient.
                let retry_at = now + retry_after_secs(&resp);
                transient(store, &job, now, retry_at, Some(code as i64), "Rate limited by Discord (429).").await;
            } else {
                let body = resp.text().await.unwrap_or_default();
                let reason = summarize(code, &body);
                if (500..=599).contains(&code) {
                    let retry_at = now + backoff_secs(job.attempts);
                    transient(store, &job, now, retry_at, Some(code as i64), &reason).await;
                } else {
                    // 4xx (not 429): the webhook is gone or the body is invalid —
                    // retrying won't help, so stop the series.
                    fail(store, &job.id, now, Some(code as i64), &reason).await;
                }
            }
        }
        Err(e) => {
            // Network/timeout — transient.
            let retry_at = now + backoff_secs(job.attempts);
            let reason = format!("Couldn't reach Discord: {e}");
            transient(store, &job, now, retry_at, None, &reason).await;
        }
    }
}

/// The next fire time for a recurring schedule, or `None` to complete it.
/// Applies the series-end caps (`max_runs`, `end_at`) the pure rule doesn't know.
fn compute_next(job: &ClaimedJob, now: i64) -> Option<i64> {
    let rec: Recurrence = serde_json::from_str(&job.recurrence_json).ok()?;
    if !rec.is_repeating() {
        return None;
    }
    if let Some(max) = job.max_runs {
        // runs_count AFTER this success.
        if job.runs_count + 1 >= max {
            return None;
        }
    }
    let tz = job.tz.parse().ok()?;
    let next = next_after(&rec, tz, now)?;
    if let Some(end) = job.end_at {
        if next > end {
            return None;
        }
    }
    Some(next)
}

async fn success(
    store: &Arc<ScheduleStore>,
    id: &str,
    now: i64,
    msg_id: Option<&str>,
    code: i64,
    next: Option<i64>,
) {
    let s = Arc::clone(store);
    let (id, msg) = (id.to_string(), msg_id.map(str::to_string));
    let res = tokio::task::spawn_blocking(move || {
        s.record_success(&id, now, msg.as_deref(), code, next)
    })
    .await;
    log_db("record_success", res);
}

/// A transient failure: bump `attempts`, retry at `retry_at` — unless the retry
/// cap is hit, in which case give up (permanent).
async fn transient(
    store: &Arc<ScheduleStore>,
    job: &ClaimedJob,
    now: i64,
    retry_at: i64,
    code: Option<i64>,
    reason: &str,
) {
    let attempts = job.attempts + 1;
    if attempts >= MAX_TRANSIENT_ATTEMPTS {
        let msg = format!("Gave up after {attempts} attempts. Last error: {reason}");
        fail(store, &job.id, now, code, &msg).await;
        return;
    }
    let s = Arc::clone(store);
    let (id, reason) = (job.id.clone(), reason.to_string());
    let res = tokio::task::spawn_blocking(move || {
        s.record_transient(&id, retry_at, attempts, code, &reason, now)
    })
    .await;
    log_db("record_transient", res);
}

async fn fail(
    store: &Arc<ScheduleStore>,
    id: &str,
    now: i64,
    code: Option<i64>,
    reason: &str,
) {
    let s = Arc::clone(store);
    let (id, reason) = (id.to_string(), reason.to_string());
    let res =
        tokio::task::spawn_blocking(move || s.record_permanent_fail(&id, now, code, &reason)).await;
    log_db("record_permanent_fail", res);
}

fn log_db(op: &str, res: Result<Result<(), String>, tokio::task::JoinError>) {
    match res {
        Ok(Ok(())) => {}
        Ok(Err(e)) => tracing::warn!(op, error = %e, "scheduler db write failed"),
        Err(e) => tracing::warn!(op, error = %e, "scheduler db task panicked"),
    }
}

/// Exponential backoff: `base · 2^attempts`, capped. `attempts` is the count
/// *before* this failure (0 on the first).
fn backoff_secs(attempts: i64) -> i64 {
    let shift = attempts.clamp(0, 16) as u32;
    BACKOFF_BASE_SECS
        .saturating_mul(1i64.checked_shl(shift).unwrap_or(i64::MAX))
        .min(BACKOFF_CAP_SECS)
        .max(1)
}

/// Seconds to wait after a 429, from the `Retry-After` header (Discord sends
/// seconds), clamped to a sane range.
fn retry_after_secs(resp: &reqwest::Response) -> i64 {
    resp.headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<f64>().ok())
        .map(|f| f.ceil() as i64)
        .unwrap_or(5)
        .clamp(1, BACKOFF_CAP_SECS)
}

/// A short, human-readable failure reason from a Discord error response.
fn summarize(code: u16, body: &str) -> String {
    let trimmed: String = body.trim().chars().take(300).collect();
    if trimmed.is_empty() {
        format!("Discord returned status {code}.")
    } else {
        format!("Discord returned {code}: {trimmed}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_then_caps() {
        assert_eq!(backoff_secs(0), 30);
        assert_eq!(backoff_secs(1), 60);
        assert_eq!(backoff_secs(2), 120);
        assert_eq!(backoff_secs(3), 240);
        // Eventually pinned to the ceiling, never overflowing.
        assert_eq!(backoff_secs(7), 3600);
        assert_eq!(backoff_secs(100), 3600);
    }

    #[test]
    fn compute_next_respects_max_runs_and_once() {
        let once = ClaimedJob {
            id: "x".into(),
            webhook_id: "1".into(),
            webhook_sealed: String::new(),
            thread_id: None,
            payload_sealed: String::new(),
            tz: "UTC".into(),
            recurrence_json: r#"{"kind":"once"}"#.into(),
            end_at: None,
            max_runs: None,
            runs_count: 0,
            attempts: 0,
        };
        assert_eq!(compute_next(&once, 1000), None);

        let mut daily = once;
        daily.recurrence_json = r#"{"kind":"daily","time":{"hour":9,"minute":0}}"#.into();
        daily.max_runs = Some(1);
        daily.runs_count = 0; // this success makes it 1 == max → done
        assert_eq!(compute_next(&daily, 1000), None);

        daily.max_runs = Some(5);
        assert!(compute_next(&daily, 1000).is_some());
    }
}
