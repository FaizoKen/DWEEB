//! Plan reconciliation — the anti-abuse counterpart to the create-time gates.
//!
//! The per-feature caps ([`entitlement`](crate::entitlement)) are enforced when
//! something is *created*, but a subscription can also shrink underneath already
//! created resources: a downgrade, a cancellation lapsing at period end, or the
//! (movable) subscription being reassigned to another server. Without a second
//! pass, a server could buy a month of Pro, create the full quota of never-expire
//! messages / custom bots / scheduled posts, then drop to Free and keep them all
//! forever — the benefit outliving the payment.
//!
//! [`reconcile_guild`] closes that: it recomputes the server's caps and asks each
//! store to keep the **oldest `cap`** items active and **suspend** the rest (data
//! retained, benefit paused), reviving them if the cap later rises again. Every
//! store's reconcile is idempotent, so this one function serves both directions
//! and is safe to call on any entitlement change. It's a no-op when billing is
//! unconfigured (the gates then run on their store defaults).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use crate::routes::{dispatcher_url_with_cap, AppState};
use crate::schedule::unix_now;

/// Bring a server's suspended-slot state in line with its current plan. Reads
/// fresh entitlement (invalidating the short cache first, so a just-applied
/// change is honoured immediately), then reconciles the dispatcher's
/// never-expire + custom-app slots and the proxy's scheduled posts. Best-effort:
/// each leg is independent and a failure in one is logged, never fatal.
pub async fn reconcile_guild(st: &AppState, guild: &str) {
    if !st.entitlements.enabled() {
        return; // Standalone deployment — no caps to enforce.
    }
    // The caps below read a 5-minute cache; drop this guild's entry so we act on
    // the entitlement as it stands *now*, not as it was before the change.
    st.entitlements.invalidate(guild);

    if let Some(api) = &st.dispatcher {
        if let Some(cap) = st.entitlements.permanent_cap(guild).await {
            reconcile_dispatcher(api, "permanent", guild, cap).await;
        }
        if let Some(cap) = st.entitlements.custom_bots_cap(guild).await {
            reconcile_dispatcher(api, "custom-apps", guild, cap).await;
        }
    }

    if let Some(store) = &st.schedules {
        if let Some(cap) = st.entitlements.schedule_limit(guild).await {
            let store = Arc::clone(store);
            let g = guild.to_string();
            match tokio::task::spawn_blocking(move || store.reconcile_guild(&g, cap)).await {
                Ok(Ok((active, suspended))) => {
                    if suspended > 0 {
                        tracing::info!(guild, cap, active, suspended, "reconciled schedules");
                    }
                }
                Ok(Err(e)) => tracing::warn!(guild, error = %e, "schedule reconcile failed"),
                Err(e) => tracing::warn!(guild, error = %e, "schedule reconcile panicked"),
            }
        }
    }
}

/// Fire one dispatcher reconcile endpoint (`/permanent` or `/custom-apps`).
async fn reconcile_dispatcher(
    api: &crate::routes::DispatcherApi,
    kind: &str,
    guild: &str,
    cap: u32,
) {
    let url = dispatcher_url_with_cap(format!("{}/{kind}/{guild}/reconcile", api.base), Some(cap));
    match api.http.post(url).bearer_auth(&api.token).send().await {
        Ok(resp) if resp.status().is_success() => {}
        Ok(resp) => tracing::warn!(
            guild,
            kind,
            status = resp.status().as_u16(),
            "reconcile rejected"
        ),
        Err(e) => tracing::warn!(guild, kind, error = %e, "reconcile call failed"),
    }
}

/// Minimum gap between two reconciles of the same guild via the lazy safety-net
/// path, so opening the dashboard doesn't re-run the whole pass on every load.
const THROTTLE_SECS: i64 = 60;
/// Retain only the guilds that are still inside the throttle window, and never
/// let a high-cardinality scan turn this best-effort safety net into permanent
/// process memory.
const MAX_THROTTLE_ENTRIES: usize = 10_000;

struct ReconcileThrottle {
    last: HashMap<String, i64>,
    max_entries: usize,
    next_sweep: i64,
}

impl ReconcileThrottle {
    fn new(max_entries: usize, now: i64) -> Self {
        Self {
            last: HashMap::new(),
            max_entries: max_entries.max(1),
            next_sweep: now.saturating_add(THROTTLE_SECS),
        }
    }

    fn should_run(&mut self, guild: &str, now: i64) -> bool {
        if now >= self.next_sweep {
            self.last
                .retain(|_, last| now.saturating_sub(*last) < THROTTLE_SECS);
            self.next_sweep = now.saturating_add(THROTTLE_SECS);
        }
        if self
            .last
            .get(guild)
            .is_some_and(|last| now.saturating_sub(*last) < THROTTLE_SECS)
        {
            return false;
        }
        // This path is only a background safety net. At the bound, skipping a
        // new guild is safer than retaining it forever or spawning unbounded
        // reconciliation work; authoritative change triggers remain unaffected.
        if self.last.len() >= self.max_entries && !self.last.contains_key(guild) {
            return false;
        }
        self.last.insert(guild.to_string(), now);
        true
    }
}

/// Per-guild timestamp of the last throttled reconcile.
fn throttle() -> &'static Mutex<ReconcileThrottle> {
    static LAST: OnceLock<Mutex<ReconcileThrottle>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(ReconcileThrottle::new(MAX_THROTTLE_ENTRIES, unix_now())))
}

/// Bound detached lazy reconciles to the SQLite pool width. `try_acquire` is
/// intentional: this is a later self-heal, so shedding it during a burst is
/// preferable to queueing thousands of background tasks behind slow upstreams.
fn lazy_slots() -> &'static Arc<tokio::sync::Semaphore> {
    static SLOTS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    SLOTS.get_or_init(|| {
        Arc::new(tokio::sync::Semaphore::new(
            crate::sqlite_pool::configured_size(),
        ))
    })
}

/// A throttled [`reconcile_guild`] for the lazy safety net (a plan read), which
/// self-heals a missed webhook without paying the full pass on every dashboard
/// load. The authoritative triggers (webhook, reassignment) call the un-throttled
/// form so a real change always reconciles at once. Spawned detached — the plan
/// response never waits on it.
pub fn reconcile_guild_lazy(st: &AppState, guild: &str) {
    let now = unix_now();
    let Ok(permit) = Arc::clone(lazy_slots()).try_acquire_owned() else {
        return;
    };
    {
        let mut throttle = throttle().lock().unwrap_or_else(|p| p.into_inner());
        if !throttle.should_run(guild, now) {
            return;
        }
    }
    let st = st.clone();
    let guild = guild.to_string();
    tokio::spawn(async move {
        let _permit = permit;
        reconcile_guild(&st, &guild).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lazy_throttle_expires_and_reclaims_guilds() {
        let mut throttle = ReconcileThrottle::new(2, 100);
        assert!(throttle.should_run("a", 100));
        assert!(!throttle.should_run("a", 159));
        assert!(throttle.should_run("b", 160));
        assert!(!throttle.last.contains_key("a"));
        assert!(throttle.last.contains_key("b"));
    }

    #[test]
    fn lazy_throttle_is_bounded() {
        let mut throttle = ReconcileThrottle::new(2, 100);
        assert!(throttle.should_run("a", 100));
        assert!(throttle.should_run("b", 100));
        assert!(!throttle.should_run("uncached", 100));
        assert_eq!(throttle.last.len(), 2);
    }
}
