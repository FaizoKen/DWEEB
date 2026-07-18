//! Plan entitlement: DWEEB tiers derived from its own Stripe subscriptions.
//!
//! DWEEB reads Stripe directly (see `stripe.rs`): a local mirror kept current by
//! its own webhook, with a throttled lazy backfill for pre-existing subscribers.
//! This module turns a user's entitlement **slots** into a [`Tier`], caps each
//! gate per tier, and caches the result briefly. It has **no dependency on
//! RoleLogic** — a shared Stripe account + SKUs, but independent at runtime.
//!
//! When Stripe isn't configured the whole thing is inert: [`Entitlement::enabled`]
//! is false, every user is Free, and each gate falls back to its store default —
//! DWEEB runs fully standalone.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::PrivateCookieJar;
use serde_json::{json, Value};

use crate::config::{Config, TierLimits};
use crate::error::AppError;
use crate::routes::{authorize_member, AppState};
use crate::schedule::unix_now;
use crate::stripe::StripeState;

/// A DWEEB plan tier, derived from a user's entitlement slots.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tier {
    Free,
    Plus,
    Pro,
}

impl Tier {
    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Free => "free",
            Tier::Plus => "plus",
            Tier::Pro => "pro",
        }
    }

    /// Map entitlement slots to a DWEEB tier. The thresholds encode the dollar
    /// split the product decided on: Expanded/Maximized (130/208 slots) → Pro,
    /// Medium/Large (36/74) → Plus, Small (10) or no subscription → Free.
    pub fn from_slots(slots: i64) -> Tier {
        if slots >= 130 {
            Tier::Pro
        } else if slots >= 36 {
            Tier::Plus
        } else {
            Tier::Free
        }
    }
}

/// A cached slots read (fronts the mirror read + any lazy backfill).
struct Cached {
    slots: i64,
    fetched_at: i64,
}

/// Entitlement entries are tiny, but the guild id key-space is unbounded over a
/// long-lived process. Keep enough for a large active fleet while refusing to
/// retain one entry for every guild ever observed.
const MAX_CACHE_ENTRIES: usize = 10_000;
const MAX_SWEEP_INTERVAL_SECS: i64 = 60;

struct EntitlementCache {
    entries: HashMap<String, Cached>,
    max_entries: usize,
    sweep_interval: i64,
    next_sweep: i64,
}

impl EntitlementCache {
    fn new(max_entries: usize, cache_secs: i64, now: i64) -> Self {
        let sweep_interval = cache_secs.clamp(1, MAX_SWEEP_INTERVAL_SECS);
        Self {
            entries: HashMap::new(),
            max_entries: max_entries.max(1),
            sweep_interval,
            next_sweep: now.saturating_add(sweep_interval),
        }
    }

    fn get(&mut self, guild: &str, now: i64, cache_secs: i64) -> Option<i64> {
        let fresh = self
            .entries
            .get(guild)
            .filter(|cached| now.saturating_sub(cached.fetched_at) < cache_secs)
            .map(|cached| cached.slots);
        if fresh.is_none() {
            self.entries.remove(guild);
        }
        fresh
    }

    fn insert(&mut self, guild: &str, slots: i64, now: i64, cache_secs: i64) {
        if now >= self.next_sweep {
            self.entries
                .retain(|_, cached| now.saturating_sub(cached.fetched_at) < cache_secs);
            self.next_sweep = now.saturating_add(self.sweep_interval);
        }
        // Existing hot entries may always refresh. At capacity, new guilds run
        // uncached until the next lazy sweep instead of growing memory forever.
        if self.entries.len() < self.max_entries || self.entries.contains_key(guild) {
            self.entries.insert(
                guild.to_string(),
                Cached {
                    slots,
                    fetched_at: now,
                },
            );
        }
    }

    fn invalidate(&mut self, guild: &str) {
        self.entries.remove(guild);
    }
}

/// Resolves + caches per-user entitlement and answers tier/limit questions.
pub struct Entitlement {
    /// The Stripe integration (mirror + client). None ⇒ plan system inert.
    stripe: Option<Arc<StripeState>>,
    cache_secs: i64,
    free: TierLimits,
    plus: TierLimits,
    pro: TierLimits,
    cache: Mutex<EntitlementCache>,
    /// Collapse concurrent cold reads for one guild, then cap distinct misses at
    /// the Stripe mirror's SQLite pool width. This avoids both duplicate lazy
    /// backfills and a cold-start burst blocking Tokio workers on store locks.
    flight: crate::singleflight::SingleFlight,
    miss_sem: tokio::sync::Semaphore,
}

impl Entitlement {
    pub fn new(config: &Config, stripe: Option<Arc<StripeState>>) -> Self {
        Entitlement {
            stripe,
            cache_secs: config.entitlement_cache_secs.max(1),
            free: config.plan_limits.free,
            plus: config.plan_limits.plus,
            pro: config.plan_limits.pro,
            cache: Mutex::new(EntitlementCache::new(
                MAX_CACHE_ENTRIES,
                config.entitlement_cache_secs.max(1),
                unix_now(),
            )),
            flight: crate::singleflight::SingleFlight::new(),
            miss_sem: tokio::sync::Semaphore::new(crate::sqlite_pool::configured_size()),
        }
    }

    /// Whether plan enforcement runs. False ⇒ every user is Free and the gates
    /// use their store defaults (standalone DWEEB).
    pub fn enabled(&self) -> bool {
        self.stripe.is_some()
    }

    /// The quota table for a tier.
    pub fn limits_for(&self, tier: Tier) -> TierLimits {
        match tier {
            Tier::Free => self.free,
            Tier::Plus => self.plus,
            Tier::Pro => self.pro,
        }
    }

    /// The JSON body describing a tier (its per-tier limits + whether in-app
    /// billing is available) — the `PlanInfo` shape the FE reads. Shared by
    /// `GET /api/guilds/:id/plan` and the post-checkout sync so both return an
    /// identical body. Unlimited limits are sent as JSON `null`.
    pub fn plan_json(&self, tier: Tier) -> Value {
        let limits = self.limits_for(tier);
        json!({
            "tier": tier.as_str(),
            "limits": {
                "schedules": lim(limits.schedules),
                "permanent": lim(limits.permanent),
                "custom_bots": lim(limits.custom_bots),
                "coeditors": lim(limits.coeditors),
                "library": lim(limits.library),
                "library_posted": lim(limits.library_posted),
            },
            "billing": self.enabled(),
        })
    }

    /// A **server's** tier — derived from the subscriptions bound to it, MEE6/
    /// Dyno-style. Always answers (Free when unconfigured / no premium).
    pub async fn tier_for(&self, guild: &str) -> Tier {
        Tier::from_slots(self.slots_for(guild).await)
    }

    /// A server's scheduled-post quota, honouring its tier. `None` when disabled
    /// (caller uses its store default). Unlimited → `i64::MAX`.
    pub async fn schedule_limit(&self, guild: &str) -> Option<i64> {
        if !self.enabled() {
            return None;
        }
        let tier = self.tier_for(guild).await;
        Some(unlimited_to_max(self.limits_for(tier).schedules))
    }

    /// A server's saved-draft library quota, honouring its tier. `None` when
    /// disabled (caller uses its store default). Unlimited → `i64::MAX`.
    pub async fn library_limit(&self, guild: &str) -> Option<i64> {
        if !self.enabled() {
            return None;
        }
        let tier = self.tier_for(guild).await;
        Some(unlimited_to_max(self.limits_for(tier).library))
    }

    /// A server's posted-history window (how many auto-recorded posted
    /// messages the library keeps before evicting the oldest), honouring its
    /// tier. `None` when disabled. Unlimited → `i64::MAX`.
    pub async fn library_posted_limit(&self, guild: &str) -> Option<i64> {
        if !self.enabled() {
            return None;
        }
        let tier = self.tier_for(guild).await;
        Some(unlimited_to_max(self.limits_for(tier).library_posted))
    }

    /// A server's never-expire slot cap for the dispatcher, or `None` when
    /// disabled. Unlimited tiers map to [`UNLIMITED_SLOTS`].
    pub async fn permanent_cap(&self, guild: &str) -> Option<u32> {
        if !self.enabled() {
            return None;
        }
        let tier = self.tier_for(guild).await;
        Some(cap_u32(self.limits_for(tier).permanent))
    }

    /// A server's custom-bot registration cap for the dispatcher, or `None` when
    /// disabled.
    pub async fn custom_bots_cap(&self, guild: &str) -> Option<u32> {
        if !self.enabled() {
            return None;
        }
        let tier = self.tier_for(guild).await;
        Some(cap_u32(self.limits_for(tier).custom_bots))
    }

    /// A server's concurrent live co-editor cap for an Activity room hosted in
    /// it, or `None` when disabled (caller treats it as unlimited).
    pub async fn coeditor_cap(&self, guild: &str) -> Option<u32> {
        if !self.enabled() {
            return None;
        }
        let tier = self.tier_for(guild).await;
        Some(cap_u32(self.limits_for(tier).coeditors))
    }

    /// Drop a server's cached tier so a purchase / move / cancel shows at once
    /// instead of waiting out the cache window.
    pub fn invalidate(&self, guild: &str) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.invalidate(guild);
        }
    }

    async fn slots_for(&self, guild: &str) -> i64 {
        let Some(stripe) = &self.stripe else {
            return 0;
        };
        if let Ok(mut cache) = self.cache.lock() {
            if let Some(slots) = cache.get(guild, unix_now(), self.cache_secs) {
                return slots;
            }
        }

        // Only one caller per guild performs the miss work. Re-check once the
        // gate is held because the previous leader normally filled the cache.
        let _flight = self.flight.acquire(guild).await;
        if let Ok(mut cache) = self.cache.lock() {
            if let Some(slots) = cache.get(guild, unix_now(), self.cache_secs) {
                return slots;
            }
        }

        // Bound simultaneous mirror/backfill work to the store's connection
        // width. The semaphore is never closed, but fail open to Free if that
        // invariant is ever broken rather than panicking a request task.
        let Ok(_permit) = self.miss_sem.acquire().await else {
            return 0;
        };
        // Reads the local mirror (network-free); a stale/missing entry may trigger
        // one throttled Stripe backfill inside `active_slots_for`.
        let slots = stripe.active_slots_for(guild).await;
        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(guild, slots, unix_now(), self.cache_secs);
        }
        slots
    }
}

/// `0` (unlimited) → `i64::MAX`; any positive limit passes through. Negative is
/// clamped to unlimited too (a nonsensical config shouldn't block everyone).
pub fn unlimited_to_max(n: i64) -> i64 {
    if n <= 0 {
        i64::MAX
    } else {
        n
    }
}

/// A cap the proxy hands the dispatcher to mean "unlimited": large enough that
/// no real server reaches it, small enough to display sanely. The FE renders any
/// cap at or above this as "Unlimited" (see `core/guild/api.ts` `isUnlimitedCap`).
pub const UNLIMITED_SLOTS: u32 = 1_000_000;

/// Convert a per-tier limit (`0`/negative = unlimited) to the `u32` cap the
/// dispatcher enforces, clamped to [`UNLIMITED_SLOTS`].
fn cap_u32(n: i64) -> u32 {
    if n <= 0 || n > UNLIMITED_SLOTS as i64 {
        UNLIMITED_SLOTS
    } else {
        n as u32
    }
}

/// `GET /api/guilds/:guild_id/plan` — a **server's** tier, per-tier limits, and
/// whether in-app billing is available (so the FE shows/hides checkout). Gated on
/// the caller managing the server, like the other per-server features. Unlimited
/// limits are sent as JSON `null`.
pub async fn guild_plan(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Path(guild): Path<String>,
) -> Result<Response, AppError> {
    let session = authorize_member(&st, &jar, &guild).await?;
    // Auto-apply an existing subscriber's floating premium (e.g. a RoleLogic sub
    // with no server binding yet) to this server — one-server premium, granted
    // automatically on first use. Safe: the user manages this server (gated
    // above), and it's a no-op once the server has premium or the user has no
    // unbound sub. Only meaningful when billing is configured.
    if let Some(stripe) = &st.stripe {
        if stripe.claim_legacy_for_guild(&session.uid, &guild).await {
            // The server just gained floating premium — reconcile now to revive
            // any items suspended under a lower tier (also invalidates the cache).
            crate::reconcile::reconcile_guild(&st, &guild).await;
        } else {
            // Otherwise a throttled safety-net pass, self-healing a missed webhook
            // (e.g. a downgrade that never reached us) without blocking this read.
            crate::reconcile::reconcile_guild_lazy(&st, &guild);
        }
    }
    let tier = st.entitlements.tier_for(&guild).await;
    Ok(Json(st.entitlements.plan_json(tier)).into_response())
}

/// Present a limit for the FE: a positive number, or `null` for unlimited (`0`).
fn lim(n: i64) -> Value {
    if n <= 0 {
        Value::Null
    } else {
        json!(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slots_map_to_the_decided_tiers() {
        // No subscription / Small ($2, 10 slots) → Free.
        assert_eq!(Tier::from_slots(0), Tier::Free);
        assert_eq!(Tier::from_slots(10), Tier::Free);
        assert_eq!(Tier::from_slots(35), Tier::Free);
        // Medium ($5, 36) / Large ($7, 74) → Plus.
        assert_eq!(Tier::from_slots(36), Tier::Plus);
        assert_eq!(Tier::from_slots(74), Tier::Plus);
        assert_eq!(Tier::from_slots(129), Tier::Plus);
        // Expanded ($10, 130) / Maximized ($14, 208) → Pro.
        assert_eq!(Tier::from_slots(130), Tier::Pro);
        assert_eq!(Tier::from_slots(208), Tier::Pro);
        // Stacked subs (summed slots) stay Pro.
        assert_eq!(Tier::from_slots(500), Tier::Pro);
    }

    #[test]
    fn unlimited_zero_becomes_max() {
        assert_eq!(unlimited_to_max(0), i64::MAX);
        assert_eq!(unlimited_to_max(-5), i64::MAX);
        assert_eq!(unlimited_to_max(3), 3);
        assert_eq!(unlimited_to_max(30), 30);
    }

    #[test]
    fn cap_u32_maps_unlimited_to_the_sentinel() {
        assert_eq!(cap_u32(0), UNLIMITED_SLOTS);
        assert_eq!(cap_u32(-1), UNLIMITED_SLOTS);
        assert_eq!(cap_u32(5), 5);
        assert_eq!(cap_u32(25), 25);
        assert_eq!(cap_u32(UNLIMITED_SLOTS as i64 + 1), UNLIMITED_SLOTS);
    }

    #[test]
    fn tier_as_str_is_stable() {
        assert_eq!(Tier::Free.as_str(), "free");
        assert_eq!(Tier::Plus.as_str(), "plus");
        assert_eq!(Tier::Pro.as_str(), "pro");
    }

    #[test]
    fn plan_json_carries_every_limit_the_fe_renders() {
        // Both plan endpoints (web `/api/guilds/:id/plan` and the Activity's
        // `/api/activity/plan`) serve this one body. The Activity handler once
        // hand-built its own copy without the library keys, so its plan card
        // showed "Unlimited" saved messages / posted history on Free while the
        // web showed the caps. Every key PlanBadge renders must be present.
        let limits = TierLimits {
            schedules: 3,
            permanent: 5,
            custom_bots: 1,
            coeditors: 2,
            library: 10,
            library_posted: 10,
        };
        let unlimited = TierLimits {
            schedules: 0,
            permanent: 0,
            custom_bots: 0,
            coeditors: 0,
            library: 0,
            library_posted: 0,
        };
        let ent = Entitlement {
            stripe: None,
            cache_secs: 60,
            free: limits,
            plus: limits,
            pro: unlimited,
            cache: Mutex::new(EntitlementCache::new(1, 60, 0)),
            flight: crate::singleflight::SingleFlight::new(),
            miss_sem: tokio::sync::Semaphore::new(1),
        };

        let body = ent.plan_json(Tier::Free);
        assert_eq!(body["tier"], "free");
        for (key, cap) in [
            ("schedules", 3),
            ("permanent", 5),
            ("custom_bots", 1),
            ("coeditors", 2),
            ("library", 10),
            ("library_posted", 10),
        ] {
            assert_eq!(body["limits"][key], json!(cap), "limits.{key}");
        }

        // Unlimited (0) renders as JSON null — the FE's "Unlimited" case. The
        // key must still be present, not absent.
        let body = ent.plan_json(Tier::Pro);
        let pro_limits = body["limits"].as_object().expect("limits object");
        for key in [
            "schedules",
            "permanent",
            "custom_bots",
            "coeditors",
            "library",
            "library_posted",
        ] {
            assert!(pro_limits.contains_key(key), "limits.{key} missing");
            assert_eq!(pro_limits[key], Value::Null, "limits.{key}");
        }
    }

    #[test]
    fn entitlement_cache_expires_and_reclaims_entries() {
        let mut cache = EntitlementCache::new(2, 10, 100);
        cache.insert("old", 36, 100, 10);

        assert_eq!(cache.get("old", 109, 10), Some(36));
        assert_eq!(cache.get("old", 110, 10), None);
        assert!(cache.entries.is_empty());
    }

    #[test]
    fn entitlement_cache_is_bounded_and_refreshes_hot_keys() {
        let mut cache = EntitlementCache::new(2, 300, 100);
        cache.insert("a", 10, 100, 300);
        cache.insert("b", 36, 100, 300);
        cache.insert("uncached", 130, 100, 300);

        assert_eq!(cache.entries.len(), 2);
        assert_eq!(cache.get("uncached", 100, 300), None);
        cache.insert("a", 130, 101, 300);
        assert_eq!(cache.get("a", 101, 300), Some(130));
        assert_eq!(cache.entries.len(), 2);
    }

    #[test]
    fn entitlement_cache_sweeps_expired_entries_on_write() {
        let mut cache = EntitlementCache::new(2, 10, 100);
        cache.insert("old", 36, 100, 10);
        cache.insert("new", 130, 110, 10);

        assert!(!cache.entries.contains_key("old"));
        assert_eq!(cache.get("new", 110, 10), Some(130));
    }
}
