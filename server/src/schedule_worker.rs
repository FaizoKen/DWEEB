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

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum_extra::extract::cookie::Key;
use serde_json::Value;

use crate::error::AppError;
use crate::routes::{AppState, DispatcherApi};
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
/// Process independent due schedules concurrently, but keep the fan-out small:
/// default SQLite pool width (three) overlaps Discord latency without turning a
/// restart backlog into an outbound/DB burst. Even an unusually large configured
/// pool is capped here.
const MAX_DELIVERY_CONCURRENCY: usize = 8;

/// Spawn the worker loop. `http` should carry a modest timeout (the worker is
/// off the 3s interaction budget, but a hung POST shouldn't hold a lease). The
/// whole `AppState` is held because a custom-bot schedule re-resolves and
/// re-homes the bot's roaming Activity webhook at fire time (Discord + the
/// dispatcher registry); everything else the loop needs (schedule store, seal
/// key, permanent-slot relay, message library) is read from it. `state.schedules`
/// must be `Some` — the caller only spawns the worker when scheduling is enabled.
pub fn spawn(
    state: AppState,
    http: reqwest::Client,
    tick_secs: u64,
    lease_secs: i64,
    batch: usize,
    retention_days: i64,
) {
    let Some(store) = state.schedules.clone() else {
        tracing::warn!("schedule worker spawned without a store — not starting");
        return;
    };
    let key = state.key.clone();
    let period = Duration::from_secs(tick_secs.max(MIN_TICK_SECS));
    let retention_secs = retention_days.max(0) * 86_400;
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(period);
        // If a delivery batch runs longer than the period, don't replay every
        // missed tick back-to-back. The rows remain durable and the next normal
        // tick will claim them; bursting catch-up ticks would defeat the batch's
        // outbound/DB load bound during an upstream slowdown.
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // First sweep fires on the first tick (last_sweep far in the past), so
        // leftovers from before a restart are reclaimed promptly.
        let mut last_sweep: i64 = 0;
        loop {
            ticker.tick().await;
            if let Err(e) = drain_once(&state, &store, &key, &http, lease_secs, batch).await {
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
    state: &AppState,
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
    if jobs.is_empty() {
        return Ok(());
    }

    // A batch used to run strictly serially: one slow 15-second webhook could
    // hold every unrelated due post behind it and let later rows' leases age out.
    // Group by webhook first, then run groups concurrently: this preserves due
    // order and avoids self-inflicted Discord rate-limit races at one endpoint
    // while independent destinations overlap their network waits.
    let groups = group_deliveries(jobs);

    // Keep a bounded JoinSet full. Panics are isolated to one destination and
    // logged rather than silently killing the scheduler's only worker loop.
    let concurrency = crate::sqlite_pool::configured_size()
        .clamp(1, MAX_DELIVERY_CONCURRENCY)
        .min(groups.len());
    let mut pending = groups.into_iter();
    let mut running = tokio::task::JoinSet::new();
    for _ in 0..concurrency {
        if let Some(group) = pending.next() {
            spawn_delivery_group(&mut running, state, store, key, http, group, now);
        }
    }
    while let Some(result) = running.join_next().await {
        if let Err(e) = result {
            tracing::warn!(error = %e, "scheduled delivery task panicked");
        }
        if let Some(group) = pending.next() {
            spawn_delivery_group(&mut running, state, store, key, http, group, now);
        }
    }
    Ok(())
}

fn group_deliveries(jobs: Vec<ClaimedJob>) -> Vec<Vec<ClaimedJob>> {
    let mut group_indexes: HashMap<String, usize> = HashMap::new();
    let mut groups: Vec<Vec<ClaimedJob>> = Vec::new();
    for job in jobs {
        let index = match group_indexes.get(&job.webhook_id) {
            Some(index) => *index,
            None => {
                let index = groups.len();
                group_indexes.insert(job.webhook_id.clone(), index);
                groups.push(Vec::new());
                index
            }
        };
        groups[index].push(job);
    }
    groups
}

fn spawn_delivery_group(
    running: &mut tokio::task::JoinSet<()>,
    state: &AppState,
    store: &Arc<ScheduleStore>,
    key: &Key,
    http: &reqwest::Client,
    jobs: Vec<ClaimedJob>,
    now: i64,
) {
    let state = state.clone();
    let store = Arc::clone(store);
    let key = key.clone();
    let http = http.clone();
    running.spawn(async move {
        for job in jobs {
            process(&state, &store, &key, &http, job, now).await;
        }
    });
}

/// Fire one claimed occurrence and record the outcome.
async fn process(
    state: &AppState,
    store: &Arc<ScheduleStore>,
    key: &Key,
    http: &reqwest::Client,
    job: ClaimedJob,
    now: i64,
) {
    // Decrypt the message payload — needed on every path. A failure here means
    // the key changed (SESSION_SECRET rotated) or the row was tampered — neither
    // will ever succeed, so it's permanent.
    let Some(payload_str) = seal::open(key, &job.payload_sealed) else {
        fail(
            store,
            &job.id,
            now,
            None,
            "Couldn't decrypt the stored message.",
        )
        .await;
        return;
    };
    let Ok(payload) = serde_json::from_str::<Value>(&payload_str) else {
        fail(store, &job.id, now, None, "The stored message is corrupt.").await;
        return;
    };

    // Resolve the webhook this occurrence posts through.
    //
    //  - A custom-bot schedule (`application_id` + `channel_id` set) posts as one
    //    of the server's bots, whose single Activity webhook roams between
    //    channels — so the sealed URL is a stale snapshot. Re-resolve the live
    //    webhook from the registry and bring it to the destination channel *now*,
    //    exactly as a live post does, then post through that. A definitive
    //    problem (bot disconnected, suspended, deleted) stops the series; an
    //    upstream blip retries.
    //  - A DWEEB (or web) schedule rides its channel-bound sealed URL, which
    //    can't drift, so it's authoritative.
    let post_url = match (&job.application_id, &job.guild_id, &job.channel_id) {
        (Some(app), Some(guild), Some(channel)) => {
            match crate::activity::resolve_custom_hook_for_channel(state, guild, app, channel).await
            {
                Ok((wid, token)) => format!("https://discord.com/api/webhooks/{wid}/{token}"),
                Err(e) => {
                    let reason = format!("Couldn't post as the server's custom bot: {e}");
                    if hook_error_is_transient(&e) {
                        let retry_at = now + backoff_secs(job.attempts);
                        transient(store, &job, now, retry_at, None, &reason).await;
                    } else {
                        fail(store, &job.id, now, None, &reason).await;
                    }
                    return;
                }
            }
        }
        _ => {
            let Some(url) = seal::open(key, &job.webhook_sealed) else {
                fail(
                    store,
                    &job.id,
                    now,
                    None,
                    "Couldn't decrypt the stored webhook (was SESSION_SECRET rotated?).",
                )
                .await;
                return;
            };
            if validate_webhook(&url).is_err() {
                fail(
                    store,
                    &job.id,
                    now,
                    None,
                    "The stored webhook is not a Discord webhook URL.",
                )
                .await;
                return;
            }
            url.trim().to_string()
        }
    };

    // `with_components=true` is mandatory for Components V2; `wait=true` makes
    // Discord echo the created message so we can record its id.
    let mut send_url = format!("{post_url}?with_components=true&wait=true");
    if let Some(thread) = &job.thread_id {
        send_url.push_str("&thread_id=");
        send_url.push_str(thread);
    }

    match http.post(&send_url).json(&payload).send().await {
        Ok(resp) => {
            let code = resp.status().as_u16();
            if resp.status().is_success() {
                // Discord echoes the created message (wait=true): both its id and
                // channel_id come from this body — the channel is what a slot
                // claim needs, and for a forum/thread post it's the thread id.
                let body = resp.json::<Value>().await.ok();
                let msg_id = body
                    .as_ref()
                    .and_then(|v| v.get("id").and_then(|i| i.as_str().map(str::to_string)));
                let channel_id = body.as_ref().and_then(|v| {
                    v.get("channel_id")
                        .and_then(|i| i.as_str().map(str::to_string))
                });
                // Keep the components alive when asked — best-effort, never fails
                // the post. The outcome rides into the row's run detail as a note.
                let note = maybe_make_permanent(
                    state.dispatcher.as_ref(),
                    &state.entitlements,
                    &job,
                    msg_id.as_deref(),
                    channel_id.as_deref(),
                )
                .await;
                // Land the post in the server's message library too (best-effort),
                // so a fired schedule shows up on the shared shelf like any other
                // posted message. Reuses the row's sealed payload/webhook as-is;
                // `application_id` tags it so a later edit rides the same identity.
                if let (Some(guild), Some(mid)) = (&job.guild_id, msg_id.as_deref()) {
                    crate::library::record_fired_schedule(
                        state.library.as_ref(),
                        &state.entitlements,
                        state.dispatcher.as_ref(),
                        guild,
                        channel_id.as_deref(),
                        mid,
                        &job.payload_sealed,
                        &job.webhook_sealed,
                        &job.webhook_id,
                        job.thread_id.as_deref(),
                        job.title.as_deref(),
                        job.dest_label.as_deref(),
                        job.owner_user_id.as_deref(),
                        job.application_id.as_deref(),
                    )
                    .await;
                }
                let next = compute_next(&job, now);
                success(
                    store,
                    &job.id,
                    now,
                    msg_id.as_deref(),
                    channel_id.as_deref(),
                    code as i64,
                    next,
                    note.as_deref(),
                )
                .await;
            } else if code == 429 {
                // Rate limited — honour Retry-After, treat as transient.
                let retry_at = now + retry_after_secs(&resp);
                transient(
                    store,
                    &job,
                    now,
                    retry_at,
                    Some(code as i64),
                    "Rate limited by Discord (429).",
                )
                .await;
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

#[allow(clippy::too_many_arguments)]
async fn success(
    store: &Arc<ScheduleStore>,
    id: &str,
    now: i64,
    msg_id: Option<&str>,
    channel_id: Option<&str>,
    code: i64,
    next: Option<i64>,
    note: Option<&str>,
) {
    let s = Arc::clone(store);
    let (id, msg, chan, note) = (
        id.to_string(),
        msg_id.map(str::to_string),
        channel_id.map(str::to_string),
        note.map(str::to_string),
    );
    let res = tokio::task::spawn_blocking(move || {
        s.record_success(
            &id,
            now,
            msg.as_deref(),
            chan.as_deref(),
            code,
            next,
            note.as_deref(),
        )
    })
    .await;
    log_db("record_success", res);
}

/// Spend a never-expire slot on the freshly-posted message when the schedule
/// asked for it. Best-effort: the post already succeeded, so every outcome here
/// is informational. Returns `Some(note)` to record when the message will *not*
/// stay permanent (so the owner can see why), or `None` when there was nothing
/// to do or the slot was claimed cleanly.
async fn maybe_make_permanent(
    dispatcher: Option<&Arc<DispatcherApi>>,
    entitlements: &Arc<crate::entitlement::Entitlement>,
    job: &ClaimedJob,
    message_id: Option<&str>,
    channel_id: Option<&str>,
) -> Option<String> {
    if !job.make_permanent {
        return None;
    }
    let Some(guild) = job.guild_id.as_deref() else {
        // Shouldn't happen (the API drops the flag without a guild), but be safe.
        return Some(
            "Couldn't keep the buttons permanent: the destination server wasn't known.".into(),
        );
    };
    let Some(api) = dispatcher else {
        return Some(
            "Couldn't keep the buttons permanent: the never-expire service isn't configured."
                .into(),
        );
    };
    let (Some(message_id), Some(channel_id)) = (message_id, channel_id) else {
        return Some(
            "Posted, but couldn't keep the buttons permanent: Discord didn't echo the message id."
                .into(),
        );
    };
    // Honour the destination server's plan tier when spending a slot at fire
    // time, so a make-permanent schedule can't exceed that server's never-expire
    // cap. None (entitlement disabled) → the dispatcher's own env default.
    let cap = entitlements.permanent_cap(guild).await;
    let req = api
        .http
        .post(crate::routes::dispatcher_url_with_cap(
            format!("{}/permanent/{guild}", api.base),
            cap,
        ))
        .bearer_auth(&api.token)
        .json(&serde_json::json!({
            "message_id": message_id,
            "channel_id": channel_id,
            // The signed-in creator, recorded for the slot's audit row.
            "added_by": job.owner_user_id.as_deref().unwrap_or("scheduler"),
        }));
    match req.send().await {
        Ok(resp) if resp.status().is_success() => {
            tracing::info!(%message_id, %guild, "scheduled post claimed a never-expire slot");
            None
        }
        Ok(resp) if resp.status() == reqwest::StatusCode::CONFLICT => Some(
            "Posted, but the buttons will expire: all never-expire slots were in use when it fired."
                .into(),
        ),
        Ok(resp) => {
            tracing::warn!(status = resp.status().as_u16(), %message_id, "never-expire claim rejected");
            Some("Posted, but couldn't keep the buttons permanent (the never-expire service errored).".into())
        }
        Err(e) => {
            tracing::warn!(error = %e, %message_id, "never-expire claim failed to send");
            Some("Posted, but couldn't keep the buttons permanent (couldn't reach the never-expire service).".into())
        }
    }
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

async fn fail(store: &Arc<ScheduleStore>, id: &str, now: i64, code: Option<i64>, reason: &str) {
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
        .clamp(1, BACKOFF_CAP_SECS)
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

/// Whether a custom-bot hook-resolution failure is worth retrying. Upstream
/// blips (couldn't reach the dispatcher/Discord, or a 5xx from either) are
/// transient; a definitive answer — the bot isn't connected, is suspended, was
/// deleted, or any other 4xx — is permanent, so the series stops rather than
/// hammering forever.
fn hook_error_is_transient(e: &AppError) -> bool {
    match e {
        AppError::BadGateway(_) | AppError::Internal(_) => true,
        AppError::Status { status, .. } => status.is_server_error(),
        AppError::Unauthorized(_) | AppError::Forbidden(_) => false,
    }
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

    fn claimed(id: &str, webhook_id: &str) -> ClaimedJob {
        ClaimedJob {
            id: id.into(),
            webhook_id: webhook_id.into(),
            webhook_sealed: String::new(),
            thread_id: None,
            payload_sealed: String::new(),
            tz: "UTC".into(),
            recurrence_json: r#"{"kind":"once"}"#.into(),
            end_at: None,
            max_runs: None,
            runs_count: 0,
            attempts: 0,
            guild_id: None,
            make_permanent: false,
            owner_user_id: None,
            title: None,
            dest_label: None,
            application_id: None,
            channel_id: None,
        }
    }

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
    fn hook_error_classification_splits_transient_from_permanent() {
        use axum::http::StatusCode;
        // Upstream blips → retry.
        assert!(hook_error_is_transient(&AppError::BadGateway(
            "down".into()
        )));
        assert!(hook_error_is_transient(&AppError::Internal("oops".into())));
        assert!(hook_error_is_transient(&AppError::Status {
            status: StatusCode::BAD_GATEWAY,
            message: "upstream".into(),
            retry_after: None,
        }));
        // Definitive answers (bot not connected / suspended / any other 4xx) → stop.
        assert!(!hook_error_is_transient(&AppError::Forbidden(
            "suspended".into()
        )));
        assert!(!hook_error_is_transient(&AppError::Unauthorized(
            "nope".into()
        )));
        assert!(!hook_error_is_transient(&AppError::Status {
            status: StatusCode::CONFLICT,
            message: "not connected".into(),
            retry_after: None,
        }));
    }

    #[test]
    fn compute_next_respects_max_runs_and_once() {
        let once = claimed("x", "1");
        assert_eq!(compute_next(&once, 1000), None);

        let mut daily = once;
        daily.recurrence_json = r#"{"kind":"daily","time":{"hour":9,"minute":0}}"#.into();
        daily.max_runs = Some(1);
        daily.runs_count = 0; // this success makes it 1 == max → done
        assert_eq!(compute_next(&daily, 1000), None);

        daily.max_runs = Some(5);
        assert!(compute_next(&daily, 1000).is_some());
    }

    #[test]
    fn delivery_groups_preserve_order_per_webhook() {
        let groups = group_deliveries(vec![
            claimed("a1", "a"),
            claimed("b1", "b"),
            claimed("a2", "a"),
            claimed("c1", "c"),
            claimed("b2", "b"),
        ]);
        let ids: Vec<Vec<&str>> = groups
            .iter()
            .map(|group| group.iter().map(|job| job.id.as_str()).collect())
            .collect();
        assert_eq!(ids, vec![vec!["a1", "a2"], vec!["b1", "b2"], vec!["c1"]]);
    }
}
