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

/// Resolves + caches per-user entitlement and answers tier/limit questions.
pub struct Entitlement {
    /// The Stripe integration (mirror + client). None ⇒ plan system inert.
    stripe: Option<Arc<StripeState>>,
    cache_secs: i64,
    free: TierLimits,
    plus: TierLimits,
    pro: TierLimits,
    cache: Mutex<HashMap<String, Cached>>,
}

impl Entitlement {
    pub fn new(config: &Config, stripe: Option<Arc<StripeState>>) -> Self {
        Entitlement {
            stripe,
            cache_secs: config.entitlement_cache_secs.max(1),
            free: config.plan_limits.free,
            plus: config.plan_limits.plus,
            pro: config.plan_limits.pro,
            cache: Mutex::new(HashMap::new()),
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
            cache.remove(guild);
        }
    }

    async fn slots_for(&self, guild: &str) -> i64 {
        let Some(stripe) = &self.stripe else {
            return 0;
        };
        let now = unix_now();
        if let Ok(cache) = self.cache.lock() {
            if let Some(c) = cache.get(guild) {
                if now - c.fetched_at < self.cache_secs {
                    return c.slots;
                }
            }
        }
        // Reads the local mirror (network-free); a stale/missing entry may trigger
        // one throttled Stripe backfill inside `active_slots_for`.
        let slots = stripe.active_slots_for(guild).await;
        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(
                guild.to_string(),
                Cached {
                    slots,
                    fetched_at: now,
                },
            );
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
pub(crate) fn lim(n: i64) -> Value {
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
}
