//! Temporary-role reaper: the background task that takes back roles whose
//! self-grant has expired.
//!
//! All state lives in SQLite (the `grants` ledger), so the reaper is crash-safe
//! — a restart simply resumes draining due rows. It runs entirely off the
//! interaction path, so it has no 3s budget; it only needs to bound how much it
//! does per wake so a backed-up ledger (after an outage) can't hammer Discord.

use std::sync::Arc;
use std::time::Duration;

use crate::rest::{self, RoleError};
use crate::store::{DueGrant, Store};

/// Due grants processed per tick — bounds the Discord call rate even when the
/// ledger has backed up.
const BATCH: usize = 50;
/// Never wake more often than this, however small the configured interval.
const MIN_INTERVAL_SECS: u64 = 5;

/// Spawn the reaper loop. The caller only spawns it when a bot token exists —
/// without one there's nothing the reaper could ever remove.
pub fn spawn(store: Arc<Store>, http: reqwest::Client, token: String, interval_secs: u64) {
    let period = Duration::from_secs(interval_secs.max(MIN_INTERVAL_SECS));
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(period);
        // A slow Discord batch can outlive several periods. The default Burst
        // policy would then run every missed tick back-to-back and defeat the
        // batch rate bound precisely while the dependency is struggling.
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            if let Err(e) = drain_once(&store, &http, &token).await {
                tracing::warn!(error = %e, "reaper tick failed");
            }
        }
    });
}

/// Process one batch of due grants. Returns a DB error only; per-grant Discord
/// failures are handled inline and never abort the tick.
async fn drain_once(store: &Store, http: &reqwest::Client, token: &str) -> rusqlite::Result<()> {
    let now = now_millis();
    let due = store.due_grants(now, BATCH)?;
    for g in due {
        let res = rest::remove_role(
            http,
            token,
            &g.guild_id,
            &g.user_id,
            &g.role_id,
            "Self-role expired (auto-removed by DWEEB)",
        )
        .await;
        match res {
            // Taken back — stop tracking it, and tell the audit log if one's set.
            Ok(()) => {
                let _ = store.delete_grant(&g.instance_id, &g.user_id, &g.role_id);
                log_expiry(store, http, &g).await;
            }
            // Discord will never let this succeed (role gone, or now above the
            // bot): give up so it can't wedge the queue forever.
            Err(RoleError::Denied) => {
                let _ = store.delete_grant(&g.instance_id, &g.user_id, &g.role_id);
            }
            // Transient — leave the row to retry on the next tick.
            Err(RoleError::Busy) => {}
        }
    }
    Ok(())
}

/// Post an "expired" line to the menu's audit-log webhook, if it has one.
/// Best-effort; mirrors the click-time audit line.
async fn log_expiry(store: &Store, http: &reqwest::Client, g: &DueGrant) {
    let Ok(Some(cfg)) = store.get(&g.instance_id) else {
        return;
    };
    let Some(url) = cfg.log_webhook else {
        return;
    };
    let name = cfg
        .roles
        .iter()
        .find(|r| r.id == g.role_id)
        .filter(|r| !r.name.trim().is_empty())
        .map(|r| format!("**{}**", r.name))
        .unwrap_or_else(|| format!("<@&{}>", g.role_id));
    let line = format!("\u{23F0} <@{}> — {name} expired (auto-removed).", g.user_id);
    rest::post_webhook_log(http, &url, &line).await;
}

fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
