//! DWEEB's own Stripe billing — decoupled from RoleLogic.
//!
//! DWEEB reads Stripe **directly**: its own embedded Checkout, its own webhook,
//! and its own local subscription mirror. It shares the same Stripe account and
//! the same price IDs (SKUs) as the sibling RoleLogic app, so one subscription
//! grants benefits in both — but there is **no runtime dependency** on RoleLogic:
//! it being down never affects DWEEB. Stripe is the single source of truth.
//!
//! Entitlement flows: the webhook keeps the local `stripe_subscriptions` mirror
//! current; [`StripeState::active_slots_for`] reads that mirror (network-free) and
//! sums `price_slots[price_id]`. For subscribers who predate DWEEB's webhook (e.g.
//! someone who subscribed via RoleLogic), a throttled **lazy backfill** asks
//! Stripe once for that user's customer + subscriptions and seeds the mirror.
//!
//! Customers are keyed by the `discord_user_id` metadata RoleLogic already stamps,
//! so DWEEB reuses the same customer per user — no duplicate customers, no double
//! charges. All state here is non-secret (subscription/price ids), so unlike the
//! schedule store it is not sealed.

use std::collections::HashMap;
use std::path::Path as FsPath;
use std::sync::{Mutex, MutexGuard};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::PrivateCookieJar;
use hmac::{Hmac, Mac};
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;

use crate::config::Config;
use crate::error::AppError;
use crate::routes::{current_session, AppState};
use crate::schedule::unix_now;

type HmacSha256 = Hmac<Sha256>;

/// Stripe API base. All calls are form-encoded POSTs / query GETs under the
/// secret key.
const STRIPE_API: &str = "https://api.stripe.com";
/// Reject a webhook whose timestamp is this far from now (replay protection).
const WEBHOOK_TOLERANCE_SECS: i64 = 300;

// ── Local mirror ─────────────────────────────────────────────────────────────

/// One mirrored subscription row.
pub struct SubRow {
    pub id: String,
    pub user_id: String,
    pub customer_id: String,
    pub price_id: String,
    pub status: String,
    pub current_period_end: i64,
    pub cancel_at_period_end: bool,
}

/// SQLite mirror of the user's Stripe subscriptions + the discord→customer map.
pub struct StripeStore {
    conn: Mutex<Connection>,
}

impl StripeStore {
    pub fn open(path: &str) -> Result<Self, String> {
        if let Some(parent) = FsPath::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
            }
        }
        let conn = Connection::open(path).map_err(|e| format!("could not open {path}: {e}"))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| format!("journal_mode: {e}"))?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| format!("synchronous: {e}"))?;
        conn.pragma_update(None, "busy_timeout", 5_000)
            .map_err(|e| format!("busy_timeout: {e}"))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS stripe_subscriptions (
                 id                   TEXT PRIMARY KEY,
                 user_id              TEXT NOT NULL,
                 customer_id          TEXT NOT NULL,
                 price_id             TEXT NOT NULL,
                 status               TEXT NOT NULL,
                 current_period_end   INTEGER NOT NULL,
                 cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
                 updated_at           INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_stripe_sub_user
                 ON stripe_subscriptions(user_id, status);
             -- discord user -> Stripe customer, plus when we last asked Stripe
             -- (bounds backfill). An empty customer_id means 'checked, none found'.
             CREATE TABLE IF NOT EXISTS stripe_customers (
                 user_id     TEXT PRIMARY KEY,
                 customer_id TEXT NOT NULL,
                 checked_at  INTEGER NOT NULL
             );",
        )
        .map_err(|e| format!("schema: {e}"))?;
        Ok(StripeStore {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Sum of `price_slots[price_id]` over the user's active/trialing subs.
    pub fn active_slots(&self, user_id: &str, price_slots: &HashMap<String, i64>) -> i64 {
        let conn = self.lock();
        let mut stmt = match conn.prepare(
            "SELECT price_id FROM stripe_subscriptions \
             WHERE user_id = ?1 AND status IN ('active','trialing')",
        ) {
            Ok(s) => s,
            Err(_) => return 0,
        };
        let rows = match stmt.query_map([user_id], |r| r.get::<_, String>(0)) {
            Ok(r) => r,
            Err(_) => return 0,
        };
        rows.flatten()
            .map(|price| price_slots.get(&price).copied().unwrap_or(0))
            .sum()
    }

    pub fn upsert_subscription(&self, s: &SubRow) -> Result<(), String> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO stripe_subscriptions \
             (id, user_id, customer_id, price_id, status, current_period_end, \
              cancel_at_period_end, updated_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8) \
             ON CONFLICT(id) DO UPDATE SET \
               user_id=?2, customer_id=?3, price_id=?4, status=?5, \
               current_period_end=?6, cancel_at_period_end=?7, updated_at=?8",
            params![
                s.id,
                s.user_id,
                s.customer_id,
                s.price_id,
                s.status,
                s.current_period_end,
                s.cancel_at_period_end as i64,
                unix_now(),
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// The user's cached Stripe customer id (may be empty = "checked, none") and
    /// when it was last confirmed against Stripe.
    pub fn get_customer(&self, user_id: &str) -> Option<(String, i64)> {
        let conn = self.lock();
        conn.query_row(
            "SELECT customer_id, checked_at FROM stripe_customers WHERE user_id = ?1",
            [user_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        )
        .ok()
    }

    pub fn put_customer(&self, user_id: &str, customer_id: &str, checked_at: i64) {
        let conn = self.lock();
        let _ = conn.execute(
            "INSERT INTO stripe_customers (user_id, customer_id, checked_at) \
             VALUES (?1,?2,?3) \
             ON CONFLICT(user_id) DO UPDATE SET customer_id=?2, checked_at=?3",
            params![user_id, customer_id, checked_at],
        );
    }
}

// ── Stripe REST client ───────────────────────────────────────────────────────

/// Thin Stripe REST client (form-encoded POSTs, query GETs under the secret key)
/// — only the handful of operations DWEEB needs, so no heavyweight SDK.
pub struct StripeClient {
    secret: String,
    http: reqwest::Client,
    /// DWEEB tier ("plus"/"pro") → the price id its checkout buys.
    checkout_price: HashMap<String, String>,
    tax_rate_id: Option<String>,
    webhook_secret: Option<String>,
    /// Where the billing portal returns the user (the builder URL).
    return_url: String,
}

impl StripeClient {
    async fn post_form(&self, path: &str, form: &[(String, String)]) -> Result<Value, String> {
        let resp = self
            .http
            .post(format!("{STRIPE_API}{path}"))
            .bearer_auth(&self.secret)
            .form(form)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        let body: Value = resp.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            let msg = body
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Stripe request failed");
            return Err(format!("stripe {status}: {msg}"));
        }
        Ok(body)
    }

    async fn get(&self, path: &str, query: &[(&str, &str)]) -> Result<Value, String> {
        let resp = self
            .http
            .get(format!("{STRIPE_API}{path}"))
            .bearer_auth(&self.secret)
            .query(query)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        let body: Value = resp.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("stripe {status}"));
        }
        Ok(body)
    }

    /// Find the user's existing Stripe customer by the shared `discord_user_id`
    /// metadata (what RoleLogic stamps too). None when they have none yet.
    async fn find_customer(&self, uid: &str) -> Option<String> {
        let query = format!("metadata['discord_user_id']:'{uid}'");
        let body = self
            .get("/v1/customers/search", &[("query", &query), ("limit", "1")])
            .await
            .ok()?;
        body.get("data")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(|c| c.get("id"))
            .and_then(Value::as_str)
            .map(String::from)
    }

    async fn create_customer(&self, uid: &str, name: &str) -> Result<String, String> {
        let mut form = vec![("metadata[discord_user_id]".to_string(), uid.to_string())];
        if !name.is_empty() {
            form.push(("name".to_string(), name.to_string()));
        }
        let body = self.post_form("/v1/customers", &form).await?;
        id_of(&body["id"]).ok_or_else(|| "customer create: no id".into())
    }

    /// The user's customer id, reusing the cached / shared one when possible and
    /// creating one only as a last resort. Caches the result in the store.
    async fn get_or_create_customer(
        &self,
        store: &StripeStore,
        uid: &str,
        name: &str,
    ) -> Result<String, String> {
        if let Some((cid, _)) = store.get_customer(uid) {
            if !cid.is_empty() {
                return Ok(cid);
            }
        }
        if let Some(cid) = self.find_customer(uid).await {
            store.put_customer(uid, &cid, unix_now());
            return Ok(cid);
        }
        let cid = self.create_customer(uid, name).await?;
        store.put_customer(uid, &cid, unix_now());
        Ok(cid)
    }

    /// Create an **embedded** Checkout session for `tier` and return its client
    /// secret (the FE renders the payment form inline). The Discord id rides as
    /// `client_reference_id` AND subscription metadata so the webhook can attribute
    /// the sub even before the customer link is cached.
    pub async fn create_embedded_checkout(
        &self,
        store: &StripeStore,
        uid: &str,
        name: &str,
        tier: &str,
    ) -> Result<String, String> {
        let price = self
            .checkout_price
            .get(tier)
            .ok_or_else(|| format!("no checkout price configured for tier '{tier}'"))?;
        let customer = self.get_or_create_customer(store, uid, name).await?;
        let mut form = vec![
            ("mode".into(), "subscription".into()),
            ("ui_mode".into(), "embedded".into()),
            ("customer".into(), customer),
            ("line_items[0][price]".into(), price.clone()),
            ("line_items[0][quantity]".into(), "1".into()),
            ("client_reference_id".into(), uid.to_string()),
            (
                "subscription_data[metadata][discord_user_id]".into(),
                uid.to_string(),
            ),
            ("allow_promotion_codes".into(), "true".into()),
            // Stay in our modal; the FE refreshes the plan on completion.
            ("redirect_on_completion".into(), "never".into()),
        ];
        if let Some(txr) = &self.tax_rate_id {
            form.push(("line_items[0][tax_rates][0]".into(), txr.clone()));
        }
        let body = self.post_form("/v1/checkout/sessions", &form).await?;
        body.get("client_secret")
            .and_then(Value::as_str)
            .map(String::from)
            .ok_or_else(|| "checkout: no client_secret".into())
    }

    /// A Stripe billing-portal URL so the user can manage/cancel/upgrade. Errors
    /// when they have no customer (nothing to manage) — never creates one.
    pub async fn create_portal(&self, store: &StripeStore, uid: &str) -> Result<String, String> {
        let customer = match store.get_customer(uid) {
            Some((cid, _)) if !cid.is_empty() => cid,
            _ => self
                .find_customer(uid)
                .await
                .ok_or_else(|| "no billing account to manage yet".to_string())?,
        };
        store.put_customer(uid, &customer, unix_now());
        let form = vec![
            ("customer".into(), customer),
            ("return_url".into(), self.return_url.clone()),
        ];
        let body = self.post_form("/v1/billing_portal/sessions", &form).await?;
        body.get("url")
            .and_then(Value::as_str)
            .map(String::from)
            .ok_or_else(|| "portal: no url".into())
    }

    async fn retrieve_subscription(&self, id: &str) -> Result<Value, String> {
        self.get(&format!("/v1/subscriptions/{id}"), &[]).await
    }

    async fn list_customer_subscriptions(&self, customer: &str) -> Vec<Value> {
        self.get(
            "/v1/subscriptions",
            &[("customer", customer), ("status", "all"), ("limit", "100")],
        )
        .await
        .ok()
        .and_then(|b| b.get("data").and_then(Value::as_array).cloned())
        .unwrap_or_default()
    }

    /// The `discord_user_id` recorded on a customer (fallback attribution when a
    /// subscription itself carries no metadata).
    async fn customer_uid(&self, customer: &str) -> Option<String> {
        let body = self
            .get(&format!("/v1/customers/{customer}"), &[])
            .await
            .ok()?;
        body.pointer("/metadata/discord_user_id")
            .and_then(Value::as_str)
            .map(String::from)
    }

    /// Verify a Stripe webhook signature and return the parsed event. Recomputes
    /// `HMAC-SHA256("{t}.{payload}")` and compares (constant-time) to the header's
    /// `v1`, then checks the timestamp is within tolerance.
    pub fn verify_webhook(&self, payload: &[u8], sig_header: &str) -> Result<Value, String> {
        let secret = self
            .webhook_secret
            .as_deref()
            .ok_or("webhook secret not configured")?;
        let (mut ts, mut v1) = (None, None);
        for part in sig_header.split(',') {
            match part.split_once('=') {
                Some(("t", v)) => ts = Some(v.trim()),
                Some(("v1", v)) => v1 = Some(v.trim()),
                _ => {}
            }
        }
        let ts = ts.ok_or("missing t")?;
        let v1 = v1.ok_or("missing v1")?;

        let mut mac =
            HmacSha256::new_from_slice(secret.as_bytes()).map_err(|_| "bad webhook secret")?;
        mac.update(ts.as_bytes());
        mac.update(b".");
        mac.update(payload);
        let expected = hex::decode(v1).map_err(|_| "malformed v1")?;
        mac.verify_slice(&expected)
            .map_err(|_| "signature mismatch".to_string())?;

        let ts_num: i64 = ts.parse().map_err(|_| "bad timestamp")?;
        if (unix_now() - ts_num).abs() > WEBHOOK_TOLERANCE_SECS {
            return Err("timestamp outside tolerance".into());
        }
        serde_json::from_slice(payload).map_err(|e| e.to_string())
    }

    /// Apply a verified event to the mirror. Idempotent (keyed upserts).
    pub async fn handle_event(&self, store: &StripeStore, event: &Value) {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        let obj = event
            .pointer("/data/object")
            .cloned()
            .unwrap_or(Value::Null);
        match kind {
            "checkout.session.completed" => {
                if obj.get("mode").and_then(Value::as_str) != Some("subscription") {
                    return;
                }
                let uid = obj
                    .get("client_reference_id")
                    .and_then(Value::as_str)
                    .or_else(|| {
                        obj.pointer("/metadata/discord_user_id")
                            .and_then(Value::as_str)
                    })
                    .map(String::from);
                if let (Some(uid), Some(cust)) = (uid.as_deref(), id_of(&obj["customer"])) {
                    store.put_customer(uid, &cust, unix_now());
                }
                if let Some(sub_id) = id_of(&obj["subscription"]) {
                    if let Ok(sub) = self.retrieve_subscription(&sub_id).await {
                        self.upsert_from_sub(store, &sub, uid.as_deref()).await;
                    }
                }
            }
            "customer.subscription.created"
            | "customer.subscription.updated"
            | "customer.subscription.deleted" => {
                self.upsert_from_sub(store, &obj, None).await;
            }
            "invoice.payment_failed" => {
                if let Some(sub_id) = id_of(&obj["subscription"]) {
                    if let Ok(sub) = self.retrieve_subscription(&sub_id).await {
                        self.upsert_from_sub(store, &sub, None).await;
                    }
                }
            }
            _ => {}
        }
    }

    /// Ask Stripe for a user's customer + subscriptions and seed the mirror.
    /// Records a customer row (possibly empty) so the caller can throttle repeats.
    pub async fn backfill(&self, store: &StripeStore, uid: &str) {
        let customer = match store.get_customer(uid) {
            Some((cid, _)) if !cid.is_empty() => cid,
            _ => match self.find_customer(uid).await {
                Some(cid) => cid,
                None => {
                    // No customer — remember we checked so we don't re-hit Stripe.
                    store.put_customer(uid, "", unix_now());
                    return;
                }
            },
        };
        store.put_customer(uid, &customer, unix_now());
        for sub in self.list_customer_subscriptions(&customer).await {
            self.upsert_from_sub(store, &sub, Some(uid)).await;
        }
    }

    async fn upsert_from_sub(&self, store: &StripeStore, sub: &Value, fallback_uid: Option<&str>) {
        let Some((id, customer_id, price_id, status, period_end, cancel)) = extract_sub_fields(sub)
        else {
            return;
        };
        if price_id.is_empty() {
            return;
        }
        let uid = match self.resolve_user_id(sub, fallback_uid, &customer_id).await {
            Some(u) => u,
            None => {
                tracing::warn!(%id, "stripe sub has no attributable discord user; skipping");
                return;
            }
        };
        if !customer_id.is_empty() {
            store.put_customer(&uid, &customer_id, unix_now());
        }
        if let Err(e) = store.upsert_subscription(&SubRow {
            id,
            user_id: uid,
            customer_id,
            price_id,
            status,
            current_period_end: period_end,
            cancel_at_period_end: cancel,
        }) {
            tracing::warn!("stripe mirror upsert failed: {e}");
        }
    }

    async fn resolve_user_id(
        &self,
        sub: &Value,
        fallback_uid: Option<&str>,
        customer_id: &str,
    ) -> Option<String> {
        if let Some(u) = sub
            .pointer("/metadata/discord_user_id")
            .and_then(Value::as_str)
        {
            return Some(u.to_string());
        }
        if let Some(u) = fallback_uid {
            return Some(u.to_string());
        }
        if !customer_id.is_empty() {
            return self.customer_uid(customer_id).await;
        }
        None
    }
}

/// Pull the fields we mirror out of a Stripe subscription object. `None` only
/// when it's shaped nothing like a subscription.
fn extract_sub_fields(sub: &Value) -> Option<(String, String, String, String, i64, bool)> {
    let id = sub.get("id").and_then(Value::as_str)?.to_string();
    let item = sub.pointer("/items/data/0");
    let price_id = item
        .and_then(|i| i.pointer("/price/id"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let status = sub
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    // `current_period_end` moved to the item level on newer API versions; read both.
    let period_end = sub
        .get("current_period_end")
        .and_then(Value::as_i64)
        .or_else(|| {
            item.and_then(|i| i.get("current_period_end"))
                .and_then(Value::as_i64)
        })
        .unwrap_or(0);
    let cancel = sub
        .get("cancel_at_period_end")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let customer_id = id_of(&sub["customer"]).unwrap_or_default();
    Some((id, customer_id, price_id, status, period_end, cancel))
}

/// Normalize a Stripe expandable field (string id | object with `id` | null).
fn id_of(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Object(_) => v.get("id").and_then(Value::as_str).map(String::from),
        _ => None,
    }
}

// ── Combined state (mirror + client) held in AppState ────────────────────────

pub struct StripeState {
    pub client: StripeClient,
    pub store: StripeStore,
    price_slots: HashMap<String, i64>,
    backfill_ttl: i64,
}

impl StripeState {
    /// Build from config, or `None` when Stripe isn't configured (plan system
    /// inert → standalone DWEEB).
    pub fn from_config(config: &Config) -> Result<Option<Self>, String> {
        let Some(secret) = config.stripe_secret_key.clone() else {
            return Ok(None);
        };
        let store = StripeStore::open(&config.stripe_db_path)?;
        let client = StripeClient {
            secret,
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .map_err(|e| e.to_string())?,
            checkout_price: config.stripe_checkout_price.clone(),
            tax_rate_id: config.stripe_tax_rate_id.clone(),
            webhook_secret: config.stripe_webhook_secret.clone(),
            return_url: config.frontend_url.clone(),
        };
        Ok(Some(StripeState {
            client,
            store,
            price_slots: config.stripe_price_slots.clone(),
            backfill_ttl: config.stripe_backfill_ttl_secs,
        }))
    }

    /// The user's entitlement slots: the mirror first, then a throttled lazy
    /// backfill for a subscriber who predates DWEEB's webhook.
    pub async fn active_slots_for(&self, uid: &str) -> i64 {
        let slots = self.store.active_slots(uid, &self.price_slots);
        if slots > 0 {
            return slots;
        }
        if self.backfill_due(uid) {
            self.client.backfill(&self.store, uid).await;
        }
        self.store.active_slots(uid, &self.price_slots)
    }

    fn backfill_due(&self, uid: &str) -> bool {
        match self.store.get_customer(uid) {
            Some((_, checked_at)) => unix_now() - checked_at > self.backfill_ttl,
            None => true,
        }
    }
}

// ── HTTP handlers ────────────────────────────────────────────────────────────

fn require_stripe(st: &AppState) -> Result<&std::sync::Arc<StripeState>, AppError> {
    st.stripe.as_ref().ok_or_else(|| AppError::Status {
        status: StatusCode::NOT_IMPLEMENTED,
        message: "Billing isn't enabled on this deployment.".into(),
        retry_after: None,
    })
}

#[derive(Deserialize)]
pub struct CheckoutBody {
    /// The DWEEB tier to buy: "plus" or "pro".
    pub tier: String,
}

/// `POST /api/stripe/checkout` `{ tier }` → `{ client_secret }` for the FE's
/// embedded Checkout. Cookie-gated (a real Discord identity to attribute the sub).
pub async fn checkout(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Json(body): Json<CheckoutBody>,
) -> Result<Response, AppError> {
    let stripe = require_stripe(&st)?;
    let session = current_session(&jar)
        .ok_or_else(|| AppError::Unauthorized("Sign in with Discord to upgrade.".into()))?;
    let tier = body.tier.trim().to_lowercase();
    if tier != "plus" && tier != "pro" {
        return Err(AppError::Status {
            status: StatusCode::BAD_REQUEST,
            message: "Unknown plan.".into(),
            retry_after: None,
        });
    }
    let client_secret = stripe
        .client
        .create_embedded_checkout(&stripe.store, &session.uid, &session.name, &tier)
        .await
        .map_err(|e| AppError::BadGateway(format!("Couldn't start checkout: {e}")))?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "client_secret": client_secret })),
    )
        .into_response())
}

/// `POST /api/stripe/portal` → `{ url }` for Stripe's billing portal (manage /
/// cancel). Cookie-gated. 400 when the user has no billing account yet.
pub async fn portal(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
) -> Result<Response, AppError> {
    let stripe = require_stripe(&st)?;
    let session = current_session(&jar)
        .ok_or_else(|| AppError::Unauthorized("Sign in with Discord to manage billing.".into()))?;
    let url = stripe
        .client
        .create_portal(&stripe.store, &session.uid)
        .await
        .map_err(|e| AppError::Status {
            status: StatusCode::BAD_REQUEST,
            message: e,
            retry_after: None,
        })?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "url": url })),
    )
        .into_response())
}

/// `POST /api/stripe/webhook` — Stripe → us. No user auth; authenticity is the
/// signature (verified against `STRIPE_WEBHOOK_SECRET`). Errors surface as 4xx so
/// Stripe retries only on our genuine failures (handlers are idempotent).
pub async fn webhook(
    State(st): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, AppError> {
    let stripe = require_stripe(&st)?;
    if stripe.client.webhook_secret.is_none() {
        return Err(AppError::Status {
            status: StatusCode::NOT_IMPLEMENTED,
            message: "Webhook not configured.".into(),
            retry_after: None,
        });
    }
    let sig = headers
        .get("stripe-signature")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let event = stripe.client.verify_webhook(&body, sig).map_err(|e| {
        tracing::warn!("stripe webhook verify failed: {e}");
        AppError::Status {
            status: StatusCode::BAD_REQUEST,
            message: "Invalid webhook signature.".into(),
            retry_after: None,
        }
    })?;
    stripe.client.handle_event(&stripe.store, &event).await;
    Ok(Json(json!({ "received": true })).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(tag: &str) -> (StripeStore, std::path::PathBuf) {
        let path =
            std::env::temp_dir().join(format!("dweeb-stripe-test-{}-{tag}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        (StripeStore::open(path.to_str().unwrap()).unwrap(), path)
    }

    fn row(id: &str, uid: &str, price: &str, status: &str) -> SubRow {
        SubRow {
            id: id.into(),
            user_id: uid.into(),
            customer_id: "cus_1".into(),
            price_id: price.into(),
            status: status.into(),
            current_period_end: 0,
            cancel_at_period_end: false,
        }
    }

    #[test]
    fn active_slots_sums_only_active_and_known_prices() {
        let (store, path) = temp_store("slots");
        let slots: HashMap<String, i64> =
            [("p_medium".into(), 36), ("p_expanded".into(), 130)].into();
        // Active Medium + trialing Expanded → 36 + 130.
        store
            .upsert_subscription(&row("s1", "u1", "p_medium", "active"))
            .unwrap();
        store
            .upsert_subscription(&row("s2", "u1", "p_expanded", "trialing"))
            .unwrap();
        // Canceled sub and an unknown price contribute nothing.
        store
            .upsert_subscription(&row("s3", "u1", "p_medium", "canceled"))
            .unwrap();
        store
            .upsert_subscription(&row("s4", "u1", "p_unknown", "active"))
            .unwrap();
        assert_eq!(store.active_slots("u1", &slots), 166);
        assert_eq!(store.active_slots("nobody", &slots), 0);
        // Upsert is keyed by id: flipping s1 to canceled drops its slots.
        store
            .upsert_subscription(&row("s1", "u1", "p_medium", "canceled"))
            .unwrap();
        assert_eq!(store.active_slots("u1", &slots), 130);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn customer_cache_roundtrips() {
        let (store, path) = temp_store("cust");
        assert!(store.get_customer("u1").is_none());
        store.put_customer("u1", "cus_x", 1000);
        assert_eq!(store.get_customer("u1"), Some(("cus_x".into(), 1000)));
        // Empty marker (checked, none) is distinct from absent.
        store.put_customer("u2", "", 2000);
        assert_eq!(store.get_customer("u2"), Some((String::new(), 2000)));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn extract_sub_fields_reads_new_and_old_shapes() {
        // Newer API: price + period end at the item level.
        let new_shape = json!({
            "id": "sub_1",
            "status": "active",
            "cancel_at_period_end": true,
            "customer": "cus_1",
            "items": { "data": [ { "price": { "id": "p_x" }, "current_period_end": 111 } ] }
        });
        let f = extract_sub_fields(&new_shape).unwrap();
        assert_eq!(f.0, "sub_1");
        assert_eq!(f.1, "cus_1");
        assert_eq!(f.2, "p_x");
        assert_eq!(f.3, "active");
        assert_eq!(f.4, 111);
        assert!(f.5);
        // Older API: current_period_end at the top level, customer as an object.
        let old_shape = json!({
            "id": "sub_2",
            "status": "active",
            "current_period_end": 222,
            "customer": { "id": "cus_2" },
            "items": { "data": [ { "price": { "id": "p_y" } } ] }
        });
        let f = extract_sub_fields(&old_shape).unwrap();
        assert_eq!(f.1, "cus_2");
        assert_eq!(f.4, 222);
        assert!(!f.5);
        // Not a subscription → None.
        assert!(extract_sub_fields(&json!({ "foo": 1 })).is_none());
    }

    #[test]
    fn id_of_normalizes_expandable_fields() {
        assert_eq!(id_of(&json!("cus_1")), Some("cus_1".into()));
        assert_eq!(id_of(&json!({ "id": "cus_2" })), Some("cus_2".into()));
        assert_eq!(id_of(&json!(null)), None);
        assert_eq!(id_of(&json!("")), None);
    }

    #[test]
    fn webhook_signature_verifies_and_rejects() {
        let client = StripeClient {
            secret: "sk_test".into(),
            http: reqwest::Client::new(),
            checkout_price: HashMap::new(),
            tax_rate_id: None,
            webhook_secret: Some("whsec_test".into()),
            return_url: "https://x".into(),
        };
        let payload = br#"{"type":"customer.subscription.updated"}"#;
        let ts = unix_now();
        // Sign exactly as Stripe does: HMAC-SHA256("{t}.{payload}").
        let mut mac = HmacSha256::new_from_slice(b"whsec_test").unwrap();
        mac.update(ts.to_string().as_bytes());
        mac.update(b".");
        mac.update(payload);
        let v1 = hex::encode(mac.finalize().into_bytes());
        let good = format!("t={ts},v1={v1}");
        assert!(client.verify_webhook(payload, &good).is_ok());
        // Tampered signature.
        let bad = format!("t={ts},v1={}", "0".repeat(v1.len()));
        assert!(client.verify_webhook(payload, &bad).is_err());
        // Stale timestamp.
        let stale = format!("t={},v1={v1}", ts - 10_000);
        assert!(client.verify_webhook(payload, &stale).is_err());
    }
}
