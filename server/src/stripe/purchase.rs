//! What an Upgrade click may do, given what the buyer already pays for.
//!
//! Checkout only ever *adds* a subscription, so it may open only when nothing
//! of the buyer's could end up paying for the same thing. Everything here is
//! additive toward existing subscribers: no subscription is changed, cancelled
//! or re-bound by this code. A plan change is a link into Stripe's portal,
//! where the customer sees the prorated charge and confirms it themselves.
//! Several subscriptions on one person are normal (RoleLogic stacks them by
//! design), so holding many is never treated as a fault to clean up.

use std::collections::{HashMap, HashSet};
use std::hash::{DefaultHasher, Hash, Hasher};

use serde_json::Value;

use super::{
    checkout_key, id_of, CheckoutError, CheckoutRequest, CheckoutStart, StripeClient, StripeErr,
    StripeState, StripeStore, SubRow, APP_SOURCE,
};
use crate::entitlement::Tier;
use crate::schedule::unix_now;

/// Statuses that still bill, or will again once a payment succeeds.
pub(super) const UNFINISHED: [&str; 5] = ["active", "trialing", "past_due", "unpaid", "paused"];

/// How many purchases may be prepared at once (one per buyer within a stripe).
pub(super) const PURCHASE_GATES: usize = 16;

pub(super) const ALREADY: &str =
    "This server already has that plan or a higher one, so there's nothing to buy.";
pub(super) const MOVE_EXISTING: &str =
    "You already pay for a plan that isn't on a server yet, so don't buy again. It applies to a \
     Free server by itself, or use Move under Your premium servers.";
/// What a client from before plan changes prints in place of following the link.
pub(super) const CHANGE_PLAN: &str =
    "You already pay for this server. Reload DWEEB to change that plan, or use Manage billing.";
pub(super) const OVERDUE: &str =
    "A payment for your existing plan is overdue. Pay or cancel it in Manage billing: buying \
     again would charge you twice.";
pub(super) const RENEW_FIRST: &str =
    "Your current plan is set to end. Renew it in Manage billing, then upgrade, so the time \
     you've paid for counts toward the new plan.";
pub(super) const SCHEDULED: &str =
    "A change to your current plan is already scheduled. Cancel that change in Manage billing, \
     then upgrade.";
pub(super) const CANT_SWITCH: &str =
    "Stripe couldn't change your current plan. Open Manage billing to change it there.";
pub(super) const FINISHING: &str =
    "A payment for this server may still be finishing. Wait a moment, then reopen Plans.";

/// What a click on Upgrade turns into.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Purchase {
    /// Nothing of the buyer's is in the way: a new subscription.
    Checkout,
    /// Change this subscription instead of adding one.
    Switch(String),
    Refuse(&'static str),
}

/// What [`StripeState::start_purchase`] hands the route.
pub enum PurchaseStart {
    Checkout(CheckoutStart),
    /// Stripe's confirmation page for changing the existing subscription.
    Switch {
        portal_url: String,
    },
}

fn is_live(s: &SubRow) -> bool {
    matches!(s.status.as_str(), "active" | "trialing")
}

fn is_overdue(s: &SubRow) -> bool {
    matches!(s.status.as_str(), "past_due" | "unpaid" | "paused")
}

/// The rule, pure. `subs` are the buyer's own, fresh from Stripe. `current` is
/// the server's tier, whoever pays for it.
pub(super) fn decide(
    subs: &[SubRow],
    guild: &str,
    target: Tier,
    current: Tier,
    price_slots: &HashMap<String, i64>,
) -> Purchase {
    if current >= target {
        return Purchase::Refuse(ALREADY);
    }
    let slots = |s: &SubRow| price_slots.get(&s.price_id).copied().unwrap_or(0);
    let tier = |s: &SubRow| Tier::from_slots(slots(s));
    // Below Plus (RoleLogic's Small) a subscription buys nothing here, so it
    // neither blocks a purchase nor gets changed by one.
    let paid: Vec<&SubRow> = subs.iter().filter(|s| tier(s) != Tier::Free).collect();
    let here = |s: &SubRow| s.guild_id.as_deref() == Some(guild);
    // An unassigned subscription covers a Free server by itself, and replaces
    // any purchase of its own tier or lower.
    let covers = |s: &SubRow| s.guild_id.is_none() && (current == Tier::Free || tier(s) >= target);

    if paid.iter().any(|s| covers(s) && is_live(s)) {
        return Purchase::Refuse(MOVE_EXISTING);
    }
    // Changing one never adds a charge stream, so it comes before the blocks.
    // Of several, the biggest: the smallest step, and the rest of a stack stays.
    if let Some(sub) = paid
        .iter()
        .filter(|s| here(s) && is_live(s) && !s.cancel_at_period_end)
        .max_by_key(|s| slots(s))
    {
        return Purchase::Switch(sub.id.clone());
    }
    if paid.iter().any(|s| is_overdue(s) && (here(s) || covers(s))) {
        return Purchase::Refuse(OVERDUE);
    }
    if paid.iter().any(|s| here(s) && is_live(s)) {
        return Purchase::Refuse(RENEW_FIRST);
    }
    Purchase::Checkout
}

/// The subscription whose customer "Manage billing" should open when the user
/// didn't name one: something to fix, then something renewing, then the rest.
pub(super) fn primary<'a>(
    subs: &'a [SubRow],
    price_slots: &HashMap<String, i64>,
) -> Option<&'a SubRow> {
    subs.iter()
        .filter(|s| UNFINISHED.contains(&s.status.as_str()) && !s.customer_id.is_empty())
        .max_by_key(|s| {
            (
                is_overdue(s),
                !s.cancel_at_period_end,
                price_slots.get(&s.price_id).copied().unwrap_or(0),
                s.current_period_end,
            )
        })
}

fn list_of(body: &Value) -> Vec<Value> {
    body.get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

impl StripeClient {
    /// Every customer that may hold this user's subscriptions: those Stripe has
    /// under their Discord id (each app can have created one), the cached one,
    /// and those in the mirror. Searched first, since those are known to exist
    /// and a new checkout goes on the first.
    async fn billing_customers(
        &self,
        store: &StripeStore,
        uid: &str,
    ) -> Result<Vec<String>, StripeErr> {
        let query = format!("metadata['discord_user_id']:'{uid}'");
        let found = self
            .get(
                "/v1/customers/search",
                &[("query", &query), ("limit", "100")],
            )
            .await?;
        let cached = store.get_customer(uid).map(|(id, _)| id);
        let mirrored = store
            .list_subscriptions_for_user(uid)
            .into_iter()
            .map(|s| s.customer_id);
        let searched = list_of(&found).into_iter().filter_map(|c| id_of(&c["id"]));

        let mut seen = HashSet::new();
        Ok(searched
            .chain(cached)
            .chain(mirrored)
            .filter(|id| !id.is_empty() && seen.insert(id.clone()))
            .collect())
    }

    /// Close DWEEB's still-open payment forms for this server, so two tabs
    /// can't both be paid. `Ok(false)`: the customer no longer exists.
    async fn expire_open_checkouts(
        &self,
        customer: &str,
        guild: &str,
    ) -> Result<bool, CheckoutError> {
        let query = [("customer", customer), ("status", "open"), ("limit", "100")];
        let open = match self.get("/v1/checkout/sessions", &query).await {
            Ok(body) => list_of(&body),
            Err(e) if e.is_missing() => return Ok(false),
            Err(e) => return Err(CheckoutError::Stripe(e)),
        };
        for session in open {
            let stamped = |key: &str| session.pointer(key).and_then(Value::as_str);
            if stamped("/metadata/source") != Some(APP_SOURCE)
                || stamped("/metadata/guild_id") != Some(guild)
            {
                continue;
            }
            let Some(id) = id_of(&session["id"]) else {
                continue;
            };
            self.post_form(&format!("/v1/checkout/sessions/{id}/expire"), &[])
                .await
                .map_err(|e| {
                    // A 4xx here means it stopped being open, most likely paid.
                    if e.is_client_error() && !e.is_rate_limited() {
                        CheckoutError::Refused(FINISHING)
                    } else {
                        CheckoutError::Stripe(e)
                    }
                })?;
        }
        Ok(true)
    }

    /// Mirror a customer's subscriptions as Stripe holds them now and return
    /// the buyer's. Any doubt is an error: "couldn't read" must never look like
    /// "owns nothing", which would open a checkout.
    async fn fresh_subscriptions(
        &self,
        store: &StripeStore,
        customer: &str,
        uid: &str,
    ) -> Result<Vec<SubRow>, CheckoutError> {
        let query = [("customer", customer), ("status", "all"), ("limit", "100")];
        let body = match self.get("/v1/subscriptions", &query).await {
            Ok(body) => body,
            Err(e) if e.is_missing() => return Ok(Vec::new()),
            Err(e) => return Err(CheckoutError::Stripe(e)),
        };
        let mut mine = Vec::new();
        for sub in list_of(&body) {
            self.upsert_from_sub(store, &sub, Some(uid))
                .await
                .map_err(CheckoutError::Other)?;
            let row = id_of(&sub["id"]).and_then(|id| store.get_subscription(&id));
            mine.extend(row.filter(|r| r.user_id == uid));
        }
        Ok(mine)
    }

    /// A link to Stripe's "confirm this change" page. Nothing changes until the
    /// customer confirms there.
    async fn switch_link(
        &self,
        sub: &SubRow,
        price: &str,
        req: &CheckoutRequest<'_>,
    ) -> Result<String, CheckoutError> {
        let live = self
            .retrieve_subscription(&sub.id)
            .await
            .map_err(CheckoutError::Stripe)?;
        // The portal can't update these; say which rather than show its error.
        if !live["schedule"].is_null() {
            return Err(CheckoutError::Refused(SCHEDULED));
        }
        let items = list_of(&live["items"]);
        let [item] = items.as_slice() else {
            return Err(CheckoutError::Refused(CANT_SWITCH));
        };
        let item_id = id_of(&item["id"]).ok_or(CheckoutError::Refused(CANT_SWITCH))?;
        let quantity = item.get("quantity").and_then(Value::as_i64).unwrap_or(1);

        let flow = "flow_data[subscription_update_confirm]";
        let mut form = vec![
            ("customer".to_string(), sub.customer_id.clone()),
            ("return_url".to_string(), self.return_url.clone()),
            (
                "flow_data[type]".to_string(),
                "subscription_update_confirm".to_string(),
            ),
            (format!("{flow}[subscription]"), sub.id.clone()),
            (format!("{flow}[items][0][id]"), item_id),
            (format!("{flow}[items][0][price]"), price.to_string()),
            (format!("{flow}[items][0][quantity]"), quantity.to_string()),
            (
                "flow_data[after_completion][type]".to_string(),
                "redirect".to_string(),
            ),
            (
                "flow_data[after_completion][redirect][return_url]".to_string(),
                self.return_url.clone(),
            ),
        ];
        if let Some(promo) = req.promo {
            form.push((
                format!("{flow}[discounts][0][promotion_code]"),
                promo.id.clone(),
            ));
        }
        let body = self
            .post_form("/v1/billing_portal/sessions", &form)
            .await
            .map_err(|e| {
                if !e.is_client_error() || e.is_rate_limited() {
                    CheckoutError::Stripe(e)
                } else if req.promo.is_some() {
                    CheckoutError::PromoRejected(e.message)
                } else {
                    tracing::warn!(sub = %sub.id, "stripe refused a plan change link: {e}");
                    CheckoutError::Refused(CANT_SWITCH)
                }
            })?;
        body.get("url")
            .and_then(Value::as_str)
            .map(String::from)
            .ok_or_else(|| CheckoutError::Other("portal: no url".into()))
    }
}

impl StripeState {
    /// Turn an Upgrade click into a checkout, a plan-change link, or a refusal.
    pub async fn start_purchase(
        &self,
        req: CheckoutRequest<'_>,
    ) -> Result<PurchaseStart, CheckoutError> {
        let key = checkout_key(req.tier, req.interval);
        let price = self.client.checkout_price.get(&key).ok_or_else(|| {
            CheckoutError::Other(format!("no checkout price configured for '{key}'"))
        })?;
        let target = if req.tier == "pro" {
            Tier::Pro
        } else {
            Tier::Plus
        };

        // One at a time per buyer, or two clicks would each see no open form.
        let mut hash = DefaultHasher::new();
        req.uid.hash(&mut hash);
        let gate = &self.purchase_gates[(hash.finish() % PURCHASE_GATES as u64) as usize];
        let _turn = gate.lock().await;

        let known = self
            .client
            .billing_customers(&self.store, req.uid)
            .await
            .map_err(CheckoutError::Stripe)?;
        // Close open forms *before* reading subscriptions: one paid in between
        // then shows up as the subscription it became.
        let mut customers = Vec::new();
        for customer in known {
            if self
                .client
                .expire_open_checkouts(&customer, req.guild_id)
                .await?
            {
                customers.push(customer);
            }
        }
        let mut subs = Vec::new();
        for customer in &customers {
            subs.extend(
                self.client
                    .fresh_subscriptions(&self.store, customer, req.uid)
                    .await?,
            );
        }

        let current = Tier::from_slots(self.active_slots_for(req.guild_id).await);
        match decide(&subs, req.guild_id, target, current, &self.price_slots) {
            Purchase::Refuse(why) => Err(CheckoutError::Refused(why)),
            Purchase::Switch(id) => {
                let sub = subs
                    .iter()
                    .find(|s| s.id == id)
                    .ok_or(CheckoutError::Refused(CANT_SWITCH))?;
                let portal_url = self.client.switch_link(sub, price, &req).await?;
                Ok(PurchaseStart::Switch { portal_url })
            }
            Purchase::Checkout => {
                let existing = primary(&subs, &self.price_slots)
                    .map(|s| s.customer_id.clone())
                    .or_else(|| customers.first().cloned());
                let customer = match existing {
                    Some(id) => id,
                    None => self
                        .client
                        .create_customer(req.uid, req.name)
                        .await
                        .map_err(CheckoutError::Other)?,
                };
                // What the post-payment sync lists.
                self.store.put_customer(req.uid, &customer, unix_now());
                self.client
                    .create_embedded_checkout(price, &customer, req)
                    .await
                    .map(PurchaseStart::Checkout)
            }
        }
    }

    /// The customer "Manage billing" opens. With `sub`, that subscription's
    /// (`Err` when it isn't this user's). Without, their most relevant one's;
    /// `Ok(None)` leaves it to the cached or searched customer, for someone with
    /// only past invoices.
    pub(super) fn portal_customer(
        &self,
        uid: &str,
        sub: Option<&str>,
    ) -> Result<Option<String>, ()> {
        match sub {
            Some(id) => self
                .store
                .get_subscription(id)
                .filter(|s| s.user_id == uid && !s.customer_id.is_empty())
                .map(|s| Some(s.customer_id))
                .ok_or(()),
            None => Ok(primary(
                &self.store.list_subscriptions_for_user(uid),
                &self.price_slots,
            )
            .map(|s| s.customer_id.clone())),
        }
    }
}
