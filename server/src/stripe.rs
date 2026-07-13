//! DWEEB's own Stripe billing — per-server premium, decoupled from RoleLogic.
//!
//! Premium is sold **per Discord server** (MEE6/Dyno-style): a subscription is
//! bound to one `guild_id` (stamped as subscription metadata at checkout) and
//! grants that server its tier. DWEEB reads Stripe **directly** — its own
//! embedded Checkout, its own webhook, its own local subscription mirror. It
//! shares the **same** Stripe account + price IDs as the sibling RoleLogic app on
//! purpose: one subscription is recognised by both, so a single payment grants
//! RoleLogic (per user) *and* DWEEB (per bound server) — a combined bundle. There
//! is still **no runtime dependency** on RoleLogic (it being down never affects
//! DWEEB). Stripe is the single source of truth.
//!
//! Entitlement flows per server: the webhook keeps the local `stripe_subscriptions`
//! mirror current; [`StripeState::active_slots_for`] reads that mirror for a guild
//! (network-free) and sums `price_slots[price_id]` over the subscriptions bound to
//! it. For a server whose sub predates (or missed) the webhook, a throttled **lazy
//! backfill** searches Stripe once by `guild_id` metadata and seeds the mirror.
//!
//! Ownership vs entitlement: a subscription's `discord_user_id` metadata is the
//! paying customer (drives the billing portal + the move-premium UI), while its
//! `guild_id` is the server that receives the tier — the two are independent, and
//! one person can hold premium on several servers. Customers are keyed by
//! `discord_user_id` so a user reuses one Stripe customer across their servers.
//! All state here is non-secret (subscription/price/guild ids), so unlike the
//! schedule store it is not sealed.
//!
//! Carry-over for existing subscribers: a subscription DWEEB recognises (its
//! price is in `price_slots`) but that carries no `guild_id` — e.g. a sibling
//! RoleLogic subscription — is "floating" premium. [`StripeState::claim_legacy_for_guild`]
//! auto-applies one such sub to the first server the owner uses (binding it by
//! stamping the `guild_id`, so it thereafter behaves exactly like a native sub —
//! one server, movable). This preserves the pre-per-server behaviour where a
//! RoleLogic sub granted DWEEB premium, now scoped to a single server.

use std::collections::HashMap;
use std::path::Path as FsPath;
use std::sync::MutexGuard;

use crate::sqlite_pool::SqlitePool;

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

/// How long after moving a subscription before it can be moved again. Premium is
/// per-server and movable, so without this one paid sub could be cycled across
/// many servers to seed each with creation-gated benefits (scheduled posts,
/// never-expire panels…). A week barely touches the legit "wrong server / we
/// migrated communities" case while killing rapid hopping. Enforced server-side —
/// the client only mirrors it as a disabled button.
const MOVE_COOLDOWN_SECS: i64 = 7 * 24 * 60 * 60;

// ── Local mirror ─────────────────────────────────────────────────────────────

/// One mirrored subscription row.
pub struct SubRow {
    pub id: String,
    /// The Discord user who owns (pays for) the subscription — the billing
    /// customer. Distinct from `guild_id`: ownership drives the portal and the
    /// "move" UI, while the guild is what actually receives the tier.
    pub user_id: String,
    pub customer_id: String,
    pub price_id: String,
    pub status: String,
    pub current_period_end: i64,
    pub cancel_at_period_end: bool,
    /// The Discord server this subscription grants its tier to (MEE6/Dyno-style
    /// per-server premium). `None` for a legacy/foreign sub with no `guild_id`
    /// metadata — it grants no server (so it's simply ignored).
    pub guild_id: Option<String>,
    /// Unix seconds of the owner's last user-initiated *move* of this sub to a
    /// different server. `None` until the first move. Drives the move cooldown
    /// (see [`MOVE_COOLDOWN_SECS`]); deliberately not touched by webhook re-mirrors.
    pub reassigned_at: Option<i64>,
}

/// SQLite mirror of the user's Stripe subscriptions + the discord→customer map.
pub struct StripeStore {
    pool: SqlitePool,
}

impl StripeStore {
    pub fn open(path: &str) -> Result<Self, String> {
        if let Some(parent) = FsPath::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
            }
        }
        let pool = SqlitePool::open_default(path, |c: &Connection| {
            c.pragma_update(None, "journal_mode", "WAL")
                .map_err(|e| format!("journal_mode: {e}"))?;
            c.pragma_update(None, "synchronous", "NORMAL")
                .map_err(|e| format!("synchronous: {e}"))?;
            c.pragma_update(None, "busy_timeout", 5_000)
                .map_err(|e| format!("busy_timeout: {e}"))?;
            Ok(())
        })?;
        // Schema + migrations are one-time; hold one checked-out connection
        // across them, then drop it before moving `pool` into the struct.
        let conn = pool.get();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS stripe_subscriptions (
                 id                   TEXT PRIMARY KEY,
                 user_id              TEXT NOT NULL,
                 customer_id          TEXT NOT NULL,
                 price_id             TEXT NOT NULL,
                 status               TEXT NOT NULL,
                 current_period_end   INTEGER NOT NULL,
                 cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
                 updated_at           INTEGER NOT NULL,
                 guild_id             TEXT,
                 -- When the owner last *moved* this sub to another server. Distinct
                 -- from updated_at (which every webhook re-mirror bumps); drives the
                 -- move cooldown. NULL = never moved.
                 reassigned_at        INTEGER
             );
             CREATE INDEX IF NOT EXISTS idx_stripe_sub_user
                 ON stripe_subscriptions(user_id, status);
             -- discord user -> Stripe customer, plus when we last asked Stripe
             -- (bounds backfill). An empty customer_id means 'checked, none found'.
             CREATE TABLE IF NOT EXISTS stripe_customers (
                 user_id     TEXT PRIMARY KEY,
                 customer_id TEXT NOT NULL,
                 checked_at  INTEGER NOT NULL
             );
             -- Per-guild backfill throttle: when we last searched Stripe for a
             -- server's subscriptions (so a server with none doesn't re-hit the
             -- API on every read).
             CREATE TABLE IF NOT EXISTS stripe_guild_checks (
                 guild_id   TEXT PRIMARY KEY,
                 checked_at INTEGER NOT NULL
             );",
        )
        .map_err(|e| format!("schema: {e}"))?;
        // Migrate mirrors created before subscriptions were bound to a guild
        // (SQLite has no ADD COLUMN IF NOT EXISTS), then index it for the
        // per-server tier lookup.
        let has_guild: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('stripe_subscriptions') \
                 WHERE name = 'guild_id'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if has_guild == 0 {
            conn.execute_batch("ALTER TABLE stripe_subscriptions ADD COLUMN guild_id TEXT;")
                .map_err(|e| format!("migrate guild_id: {e}"))?;
        }
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_stripe_sub_guild \
             ON stripe_subscriptions(guild_id, status);",
        )
        .map_err(|e| format!("index guild_id: {e}"))?;
        // Move-cooldown clock (added after guild_id) — same ADD-COLUMN dance.
        let has_reassigned: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('stripe_subscriptions') \
                 WHERE name = 'reassigned_at'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if has_reassigned == 0 {
            conn.execute_batch(
                "ALTER TABLE stripe_subscriptions ADD COLUMN reassigned_at INTEGER;",
            )
            .map_err(|e| format!("migrate reassigned_at: {e}"))?;
        }
        drop(conn);
        Ok(StripeStore { pool })
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.pool.get()
    }

    /// Cheap connectivity probe for the readiness endpoint (see
    /// `LibraryStore::ping`): a `SELECT 1` on the shared connection.
    pub fn ping(&self) -> Result<(), String> {
        self.pool.ping()
    }

    /// Sum of `price_slots[price_id]` over a **server's** active/trialing subs —
    /// the per-guild entitlement (a server's tier is derived from the slots of
    /// the subscriptions bound to it, whoever paid).
    pub fn active_slots(&self, guild_id: &str, price_slots: &HashMap<String, i64>) -> i64 {
        let conn = self.lock();
        let mut stmt = match conn.prepare_cached(
            "SELECT price_id FROM stripe_subscriptions \
             WHERE guild_id = ?1 AND status IN ('active','trialing')",
        ) {
            Ok(s) => s,
            Err(_) => return 0,
        };
        let rows = match stmt.query_map([guild_id], |r| r.get::<_, String>(0)) {
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
              cancel_at_period_end, updated_at, guild_id) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) \
             ON CONFLICT(id) DO UPDATE SET \
               user_id=?2, customer_id=?3, price_id=?4, status=?5, \
               current_period_end=?6, cancel_at_period_end=?7, updated_at=?8, guild_id=?9",
            params![
                s.id,
                s.user_id,
                s.customer_id,
                s.price_id,
                s.status,
                s.current_period_end,
                s.cancel_at_period_end as i64,
                unix_now(),
                s.guild_id,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// All columns, in the order [`sub_from_row`] reads them.
    const SUB_COLS: &'static str =
        "id, user_id, customer_id, price_id, status, current_period_end, \
         cancel_at_period_end, guild_id, reassigned_at";

    /// One subscription by id (for ownership checks before a reassignment).
    pub fn get_subscription(&self, id: &str) -> Option<SubRow> {
        let conn = self.lock();
        conn.query_row(
            &format!(
                "SELECT {} FROM stripe_subscriptions WHERE id = ?1",
                Self::SUB_COLS
            ),
            [id],
            sub_from_row,
        )
        .ok()
    }

    /// Every subscription a user owns (pays for) — the "your premium servers"
    /// list that powers the management + move UI. Most-recent period first.
    pub fn list_subscriptions_for_user(&self, user_id: &str) -> Vec<SubRow> {
        let conn = self.lock();
        let mut stmt = match conn.prepare_cached(&format!(
            "SELECT {} FROM stripe_subscriptions \
             WHERE user_id = ?1 ORDER BY current_period_end DESC",
            Self::SUB_COLS
        )) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let out: Vec<SubRow> = match stmt.query_map([user_id], sub_from_row) {
            Ok(rows) => rows.flatten().collect(),
            Err(_) => Vec::new(),
        };
        out
    }

    /// Re-point a mirrored subscription at a different server (the local half of
    /// a reassignment; the Stripe metadata update is the source of truth).
    pub fn set_subscription_guild(&self, id: &str, guild_id: &str) -> Result<(), String> {
        let conn = self.lock();
        conn.execute(
            "UPDATE stripe_subscriptions SET guild_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, guild_id, unix_now()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Stamp a subscription's last user-initiated move (the move-cooldown clock).
    /// Kept separate from [`set_subscription_guild`] so the *binding* half of a
    /// move (and the carry-over auto-apply, which reuses the reassign path) don't
    /// start the cooldown — only an explicit move from the "your premium servers"
    /// UI does, via the `reassign` handler.
    pub fn mark_reassigned(&self, id: &str) {
        let conn = self.lock();
        let _ = conn.execute(
            "UPDATE stripe_subscriptions SET reassigned_at = ?2 WHERE id = ?1",
            params![id, unix_now()],
        );
    }

    /// When we last searched Stripe for a server's subscriptions (backfill
    /// throttle). `None` = never.
    pub fn get_guild_checked(&self, guild_id: &str) -> Option<i64> {
        let conn = self.lock();
        conn.query_row(
            "SELECT checked_at FROM stripe_guild_checks WHERE guild_id = ?1",
            [guild_id],
            |r| r.get::<_, i64>(0),
        )
        .ok()
    }

    pub fn put_guild_checked(&self, guild_id: &str, checked_at: i64) {
        let conn = self.lock();
        let _ = conn.execute(
            "INSERT INTO stripe_guild_checks (guild_id, checked_at) VALUES (?1,?2) \
             ON CONFLICT(guild_id) DO UPDATE SET checked_at=?2",
            params![guild_id, checked_at],
        );
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
        interval: &str,
        guild_id: &str,
    ) -> Result<String, String> {
        let key = checkout_key(tier, interval);
        let price = self
            .checkout_price
            .get(&key)
            .ok_or_else(|| format!("no checkout price configured for '{key}'"))?;
        let customer = self.get_or_create_customer(store, uid, name).await?;
        let mut form = vec![
            ("mode".into(), "subscription".into()),
            // Stripe renamed the embedded Checkout ui_mode: the account's API
            // version rejects the old `embedded` with "use `embedded_page`". The
            // returned client_secret is the same `cs_…` the FE's EmbeddedCheckout
            // consumes, so only this value changes.
            ("ui_mode".into(), "embedded_page".into()),
            ("customer".into(), customer),
            ("line_items[0][price]".into(), price.clone()),
            ("line_items[0][quantity]".into(), "1".into()),
            ("client_reference_id".into(), uid.to_string()),
            (
                "subscription_data[metadata][discord_user_id]".into(),
                uid.to_string(),
            ),
            // The server this subscription grants premium to — read back off the
            // subscription by the webhook/backfill to bind it to the guild.
            (
                "subscription_data[metadata][guild_id]".into(),
                guild_id.to_string(),
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

    /// Every subscription bound to a server, via Stripe's search on the
    /// `guild_id` metadata — the per-guild counterpart to
    /// `list_customer_subscriptions`, used to backfill a mirror that predates
    /// (or missed) the webhook.
    async fn search_subscriptions_by_guild(&self, guild_id: &str) -> Vec<Value> {
        let query = format!("metadata['guild_id']:'{guild_id}'");
        self.get(
            "/v1/subscriptions/search",
            &[("query", &query), ("limit", "100")],
        )
        .await
        .ok()
        .and_then(|b| b.get("data").and_then(Value::as_array).cloned())
        .unwrap_or_default()
    }

    /// Every subscription on a customer — used to discover a user's *unbound*
    /// subscriptions (e.g. a sibling-app / RoleLogic sub with no `guild_id`) so
    /// DWEEB can auto-apply one to a server.
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

    /// Seed the mirror with a **user's** subscriptions (found via their Stripe
    /// customer), so an unbound legacy sub becomes visible to the auto-apply.
    /// Records the customer (possibly empty) to bound repeats.
    pub async fn refresh_user_subscriptions(&self, store: &StripeStore, uid: &str) {
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
        for sub in self.list_customer_subscriptions(&customer).await {
            self.upsert_from_sub(store, &sub, Some(uid)).await;
        }
        store.put_customer(uid, &customer, unix_now());
    }

    /// Re-point a subscription at a different server by rewriting its `guild_id`
    /// metadata (Stripe is the source of truth), then mirror the change locally.
    /// The caller has already verified ownership + that the user manages the new
    /// server. Returns the previous guild (if any) so the caller can refresh both.
    pub async fn reassign_subscription(
        &self,
        store: &StripeStore,
        sub_id: &str,
        new_guild: &str,
    ) -> Result<Option<String>, String> {
        let prev = store.get_subscription(sub_id).and_then(|s| s.guild_id);
        let form = vec![("metadata[guild_id]".to_string(), new_guild.to_string())];
        let sub = self
            .post_form(&format!("/v1/subscriptions/{sub_id}"), &form)
            .await?;
        // Re-mirror from Stripe's response so status/period/guild all stay in step.
        self.upsert_from_sub(store, &sub, None).await;
        // Defensive: guarantee the local guild matches even if the response was
        // missing the metadata echo for any reason.
        store.set_subscription_guild(sub_id, new_guild)?;
        Ok(prev)
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

    /// Apply a verified event to the mirror. Idempotent (keyed upserts). Returns
    /// the `guild_id` the touched subscription is bound to, if any — the caller
    /// uses it to reconcile that server's suspended slots against its new tier
    /// (see [`crate::reconcile`]). `None` for events that touch no guild-bound
    /// sub (a foreign/legacy sub, or an event type we don't mirror).
    pub async fn handle_event(&self, store: &StripeStore, event: &Value) -> Option<String> {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        let obj = event
            .pointer("/data/object")
            .cloned()
            .unwrap_or(Value::Null);
        match kind {
            "checkout.session.completed" => {
                if obj.get("mode").and_then(Value::as_str) != Some("subscription") {
                    return None;
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
                        return self.upsert_from_sub(store, &sub, uid.as_deref()).await;
                    }
                }
                None
            }
            "customer.subscription.created"
            | "customer.subscription.updated"
            | "customer.subscription.deleted" => self.upsert_from_sub(store, &obj, None).await,
            "invoice.payment_failed" => {
                if let Some(sub_id) = id_of(&obj["subscription"]) {
                    if let Ok(sub) = self.retrieve_subscription(&sub_id).await {
                        return self.upsert_from_sub(store, &sub, None).await;
                    }
                }
                None
            }
            _ => None,
        }
    }

    /// Ask Stripe for a server's subscriptions (matched on `guild_id` metadata)
    /// and seed the mirror — for a server whose subs predate (or missed) the
    /// webhook. Records that we checked so a server with none doesn't re-hit the
    /// API on every read.
    pub async fn backfill_guild(&self, store: &StripeStore, guild_id: &str) {
        for sub in self.search_subscriptions_by_guild(guild_id).await {
            self.upsert_from_sub(store, &sub, None).await;
        }
        store.put_guild_checked(guild_id, unix_now());
    }

    /// Mirror one subscription, returning the `guild_id` it binds (for the
    /// caller's reconcile). `None` when the sub isn't mirrorable or binds no
    /// guild.
    async fn upsert_from_sub(
        &self,
        store: &StripeStore,
        sub: &Value,
        fallback_uid: Option<&str>,
    ) -> Option<String> {
        let (id, customer_id, price_id, status, period_end, cancel, guild_id) =
            extract_sub_fields(sub)?;
        if price_id.is_empty() {
            return None;
        }
        let uid = match self.resolve_user_id(sub, fallback_uid, &customer_id).await {
            Some(u) => u,
            None => {
                tracing::warn!(%id, "stripe sub has no attributable discord user; skipping");
                return None;
            }
        };
        if !customer_id.is_empty() {
            store.put_customer(&uid, &customer_id, unix_now());
        }
        let bound_guild = guild_id.clone();
        if let Err(e) = store.upsert_subscription(&SubRow {
            id,
            user_id: uid,
            customer_id,
            price_id,
            status,
            current_period_end: period_end,
            cancel_at_period_end: cancel,
            guild_id,
            // upsert_subscription's SQL never writes reassigned_at, so this is
            // ignored — an existing move-stamp is preserved across re-mirrors.
            reassigned_at: None,
        }) {
            tracing::warn!("stripe mirror upsert failed: {e}");
        }
        bound_guild
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
#[allow(clippy::type_complexity)]
fn extract_sub_fields(
    sub: &Value,
) -> Option<(String, String, String, String, i64, bool, Option<String>)> {
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
    // The server this sub grants premium to (stamped at checkout / reassignment).
    // Absent on legacy or foreign (e.g. sibling-app) subs — they bind no guild.
    let guild_id = sub
        .pointer("/metadata/guild_id")
        .and_then(Value::as_str)
        .filter(|g| !g.is_empty())
        .map(String::from);
    Some((
        id,
        customer_id,
        price_id,
        status,
        period_end,
        cancel,
        guild_id,
    ))
}

/// The best (highest-slot) recognized, active/trialing subscription in `subs`
/// that isn't bound to any server yet — the "floating" premium the auto-apply
/// attaches to a guild. `None` when the user owns no such sub (so nothing is
/// carried over). Pure, so the selection rule is unit-testable without Stripe.
fn best_unbound_claimable(subs: Vec<SubRow>, price_slots: &HashMap<String, i64>) -> Option<SubRow> {
    subs.into_iter()
        .filter(|s| {
            s.guild_id.is_none()
                && matches!(s.status.as_str(), "active" | "trialing")
                && price_slots.get(&s.price_id).copied().unwrap_or(0) > 0
        })
        .max_by_key(|s| price_slots.get(&s.price_id).copied().unwrap_or(0))
}

/// Read a mirrored [`SubRow`] back out of a query (column order = `SUB_COLS`).
fn sub_from_row(r: &rusqlite::Row) -> rusqlite::Result<SubRow> {
    Ok(SubRow {
        id: r.get(0)?,
        user_id: r.get(1)?,
        customer_id: r.get(2)?,
        price_id: r.get(3)?,
        status: r.get(4)?,
        current_period_end: r.get(5)?,
        cancel_at_period_end: r.get::<_, i64>(6)? != 0,
        guild_id: r.get(7)?,
        reassigned_at: r.get(8)?,
    })
}

/// A coarse "in X days/hours/minutes" phrase for a remaining-cooldown message.
/// Rounds up to the larger unit so we never under-promise (the client shows the
/// exact unlock date; this is only the rare direct-call fallback).
fn humanize(secs: i64) -> String {
    let secs = secs.max(1);
    let (n, unit) = if secs >= 86_400 {
        ((secs + 86_399) / 86_400, "day")
    } else if secs >= 3_600 {
        ((secs + 3_599) / 3_600, "hour")
    } else {
        ((secs + 59) / 60, "minute")
    };
    format!("{n} {unit}{}", if n == 1 { "" } else { "s" })
}

/// Normalize a Stripe expandable field (string id | object with `id` | null).
fn id_of(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Object(_) => v.get("id").and_then(Value::as_str).map(String::from),
        _ => None,
    }
}

/// The `stripe_checkout_price` map key for a (tier, interval): monthly is the
/// bare tier, yearly appends `_year` (e.g. "pro" → monthly, "pro_year" → annual).
fn checkout_key(tier: &str, interval: &str) -> String {
    if interval == "year" {
        format!("{tier}_year")
    } else {
        tier.to_string()
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

    /// A **server's** entitlement slots: the mirror first, then a throttled lazy
    /// backfill for a server whose subscription predates (or missed) the webhook.
    pub async fn active_slots_for(&self, guild_id: &str) -> i64 {
        let slots = self.store.active_slots(guild_id, &self.price_slots);
        if slots > 0 {
            return slots;
        }
        if self.backfill_due(guild_id) {
            self.client.backfill_guild(&self.store, guild_id).await;
        }
        self.store.active_slots(guild_id, &self.price_slots)
    }

    fn backfill_due(&self, guild_id: &str) -> bool {
        match self.store.get_guild_checked(guild_id) {
            Some(checked_at) => unix_now() - checked_at > self.backfill_ttl,
            None => true,
        }
    }

    /// Entitlement slots a single price grants (0 for an unknown/foreign price)
    /// — used to label each of a user's subscriptions with its DWEEB tier.
    pub fn slots_of_price(&self, price_id: &str) -> i64 {
        self.price_slots.get(price_id).copied().unwrap_or(0)
    }

    /// Throttled per-user mirror refresh — seed the user's subscriptions so an
    /// unbound legacy sub (e.g. a RoleLogic subscription) becomes visible to the
    /// auto-apply. Reuses the customer's `checked_at` as the throttle.
    async fn ensure_user_subs(&self, uid: &str) {
        let due = match self.store.get_customer(uid) {
            Some((_, checked_at)) => unix_now() - checked_at > self.backfill_ttl,
            None => true,
        };
        if due {
            self.client
                .refresh_user_subscriptions(&self.store, uid)
                .await;
        }
    }

    /// Auto-apply a user's **floating** premium to a server: MEE6/Dyno-style
    /// "one server", but automatic — an existing subscriber (e.g. from the
    /// sibling RoleLogic app) whose sub isn't yet bound to any DWEEB server has it
    /// attached to `guild` on first use. No-op when the server already has
    /// premium, or the user owns no recognized, active, *unbound* subscription.
    /// Binding stamps the sub's `guild_id` metadata (the same path as a native
    /// sub), so it thereafter behaves identically — countable here, movable, and
    /// visible in "your premium servers". Returns true when it bound one.
    pub async fn claim_legacy_for_guild(&self, uid: &str, guild: &str) -> bool {
        // Already premium here — nothing to auto-apply.
        if self.store.active_slots(guild, &self.price_slots) > 0 {
            return false;
        }
        self.ensure_user_subs(uid).await;
        // The best (highest-slot) recognized, active/trialing sub the user owns
        // that isn't bound to any server yet.
        let candidate = best_unbound_claimable(
            self.store.list_subscriptions_for_user(uid),
            &self.price_slots,
        );
        let Some(sub) = candidate else {
            return false;
        };
        match self
            .client
            .reassign_subscription(&self.store, &sub.id, guild)
            .await
        {
            Ok(_) => {
                tracing::info!(%uid, %guild, sub = %sub.id, "auto-applied existing subscription to server");
                true
            }
            Err(e) => {
                tracing::warn!(%uid, %guild, "couldn't auto-apply subscription: {e}");
                false
            }
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
    /// Billing interval: "month" (default) or "year".
    #[serde(default)]
    pub interval: Option<String>,
    /// The server this subscription buys premium for (MEE6/Dyno-style per-server
    /// pricing). Required — a subscription always belongs to one server.
    pub guild_id: String,
}

/// `POST /api/stripe/checkout` `{ tier, interval, guild_id }` → `{ client_secret }`
/// for the FE's embedded Checkout. The subscription is bound to `guild_id`, so
/// the caller must manage that server (same gate as the other per-server
/// features); the signed-in Discord user owns/pays for it.
pub async fn checkout(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Json(body): Json<CheckoutBody>,
) -> Result<Response, AppError> {
    let stripe = require_stripe(&st)?;
    let guild = body.guild_id.trim().to_string();
    if !crate::routes::is_snowflake(&guild) {
        return Err(AppError::Status {
            status: StatusCode::BAD_REQUEST,
            message: "Pick a server to upgrade.".into(),
            retry_after: None,
        });
    }
    // Only a manager of the server may buy premium for it (and it proves the
    // signed-in identity we attribute the sub to).
    let session = crate::routes::authorize_member(&st, &jar, &guild).await?;
    let tier = body.tier.trim().to_lowercase();
    if tier != "plus" && tier != "pro" {
        return Err(AppError::Status {
            status: StatusCode::BAD_REQUEST,
            message: "Unknown plan.".into(),
            retry_after: None,
        });
    }
    let interval = body
        .interval
        .as_deref()
        .unwrap_or("month")
        .trim()
        .to_lowercase();
    if interval != "month" && interval != "year" {
        return Err(AppError::Status {
            status: StatusCode::BAD_REQUEST,
            message: "Unknown billing interval.".into(),
            retry_after: None,
        });
    }
    let client_secret = stripe
        .client
        .create_embedded_checkout(
            &stripe.store,
            &session.uid,
            &session.name,
            &tier,
            &interval,
            &guild,
        )
        .await
        .map_err(|e| AppError::BadGateway(format!("Couldn't start checkout: {e}")))?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "client_secret": client_secret })),
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct SyncBody {
    /// The server whose just-completed purchase to pick up.
    pub guild_id: String,
}

/// `POST /api/stripe/sync` `{ guild_id }` → the server's now-current plan.
///
/// The embedded Checkout's `onComplete` fires the moment payment succeeds —
/// before (or racing) the `checkout.session.completed` webhook — and the lazy
/// backfill is throttled, so a fresh purchase could otherwise take a long time
/// (worst case, until the next 24h backfill) to reflect. This forces the pickup:
/// it pulls the buyer's subscriptions **straight from Stripe** via the
/// customer-list endpoint (strongly consistent — the sub created seconds ago,
/// stamped with this `guild_id`, is already there, unlike the search-indexed
/// backfill), mirrors them, reconciles the server (which also drops the tier
/// cache), and returns its refreshed tier. Same gate as checkout: the caller must
/// manage the server.
pub async fn sync(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Json(body): Json<SyncBody>,
) -> Result<Response, AppError> {
    let stripe = require_stripe(&st)?;
    let guild = body.guild_id.trim().to_string();
    if !crate::routes::is_snowflake(&guild) {
        return Err(AppError::Status {
            status: StatusCode::BAD_REQUEST,
            message: "Pick a server.".into(),
            retry_after: None,
        });
    }
    let session = crate::routes::authorize_member(&st, &jar, &guild).await?;
    // Pull the buyer's subscriptions from Stripe and mirror them now — the sub
    // just created by checkout carries this guild in its metadata, so this binds
    // it to the server regardless of webhook timing.
    stripe
        .client
        .refresh_user_subscriptions(&stripe.store, &session.uid)
        .await;
    // Recompute the server's caps off the fresh mirror (this also invalidates the
    // short tier cache) and revive anything suspended under the previous tier.
    crate::reconcile::reconcile_guild(&st, &guild).await;
    let tier = st.entitlements.tier_for(&guild).await;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(st.entitlements.plan_json(tier)),
    )
        .into_response())
}

/// `GET /api/stripe/subscriptions` → the signed-in user's premium subscriptions,
/// each with the server it's bound to and its DWEEB tier — the data behind the
/// "your premium servers" list and the move-premium picker. Cookie-gated.
pub async fn subscriptions(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
) -> Result<Response, AppError> {
    let stripe = require_stripe(&st)?;
    let session = current_session(&jar).ok_or_else(|| {
        AppError::Unauthorized("Sign in with Discord to view your subscriptions.".into())
    })?;
    let rows = stripe.store.list_subscriptions_for_user(&session.uid);
    let items: Vec<Value> = rows
        .iter()
        // Only subs that still grant something — hide canceled/incomplete clutter.
        .filter(|s| matches!(s.status.as_str(), "active" | "trialing" | "past_due"))
        .map(|s| {
            let tier = crate::entitlement::Tier::from_slots(stripe.slots_of_price(&s.price_id));
            json!({
                "id": s.id,
                "guild_id": s.guild_id,
                "tier": tier.as_str(),
                "status": s.status,
                "current_period_end": s.current_period_end,
                "cancel_at_period_end": s.cancel_at_period_end,
                // Unix seconds this sub can next be moved; null once freely movable
                // (never moved, or the cooldown has elapsed). Keeps the cooldown
                // length server-owned — the client just compares it to now.
                "movable_at": s.reassigned_at
                    .map(|t| t + MOVE_COOLDOWN_SECS)
                    .filter(|m| *m > unix_now()),
            })
        })
        .collect();
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "items": items })),
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct ReassignBody {
    /// The subscription to move (must be one the signed-in user owns).
    pub subscription_id: String,
    /// The server to move it to (must be one the signed-in user manages).
    pub guild_id: String,
}

/// `POST /api/stripe/reassign` `{ subscription_id, guild_id }` — move a premium
/// subscription to a different server (MEE6/Dyno-style). Requires that the user
/// **owns** the subscription and **manages** the target server. Re-points the
/// Stripe metadata (source of truth) and the local mirror, and drops the cached
/// tier for both the old and new server so the change shows at once.
pub async fn reassign(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Json(body): Json<ReassignBody>,
) -> Result<Response, AppError> {
    let stripe = require_stripe(&st)?;
    let sub_id = body.subscription_id.trim().to_string();
    let new_guild = body.guild_id.trim().to_string();
    if sub_id.is_empty() || !sub_id.starts_with("sub_") {
        return Err(AppError::Status {
            status: StatusCode::BAD_REQUEST,
            message: "Unknown subscription.".into(),
            retry_after: None,
        });
    }
    if !crate::routes::is_snowflake(&new_guild) {
        return Err(AppError::Status {
            status: StatusCode::BAD_REQUEST,
            message: "Pick a server to move it to.".into(),
            retry_after: None,
        });
    }
    // Must manage the destination server (also resolves the signed-in identity).
    let session = crate::routes::authorize_member(&st, &jar, &new_guild).await?;
    // Must own the subscription being moved.
    let sub = match stripe.store.get_subscription(&sub_id) {
        Some(s) if s.user_id == session.uid => s,
        Some(_) => {
            return Err(AppError::Forbidden(
                "That subscription isn't yours to move.".into(),
            ))
        }
        None => {
            return Err(AppError::Status {
                status: StatusCode::NOT_FOUND,
                message: "No such subscription.".into(),
                retry_after: None,
            })
        }
    };
    // Already here → nothing to move; return success without burning the cooldown.
    if sub.guild_id.as_deref() == Some(new_guild.as_str()) {
        return Ok((
            [(header::CACHE_CONTROL, "no-store")],
            Json(json!({ "ok": true, "guild_id": new_guild })),
        )
            .into_response());
    }
    // Move cooldown — one sub can't be cycled across servers to seed each. The FE
    // disables the button using `movable_at`; this guards the race / direct call.
    if let Some(last) = sub.reassigned_at {
        let remaining = MOVE_COOLDOWN_SECS - (unix_now() - last);
        if remaining > 0 {
            return Err(AppError::Status {
                status: StatusCode::TOO_MANY_REQUESTS,
                message: format!(
                    "You can move this premium again in {}.",
                    humanize(remaining)
                ),
                retry_after: Some(remaining as f64),
            });
        }
    }
    let prev = stripe
        .client
        .reassign_subscription(&stripe.store, &sub_id, &new_guild)
        .await
        .map_err(|e| AppError::BadGateway(format!("Couldn't move the subscription: {e}")))?;
    // Start the cooldown from this explicit move (not the carry-over bind path).
    stripe.store.mark_reassigned(&sub_id);
    // Both servers' tiers just changed — reconcile each (invalidates the cache and
    // pauses/revives over-cap slots): the old server may drop below its usage, the
    // new one may gain headroom to revive previously-suspended items.
    if let Some(prev) = prev.as_deref() {
        crate::reconcile::reconcile_guild(&st, prev).await;
    }
    crate::reconcile::reconcile_guild(&st, &new_guild).await;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "ok": true, "guild_id": new_guild })),
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
    // Mirror the event, then reconcile the affected server's suspended slots so a
    // downgrade/cancel pauses over-cap items (and a renewal/upgrade revives them)
    // without waiting out the entitlement cache.
    if let Some(guild) = stripe.client.handle_event(&stripe.store, &event).await {
        crate::reconcile::reconcile_guild(&st, &guild).await;
    }
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

    fn row(id: &str, uid: &str, guild: &str, price: &str, status: &str) -> SubRow {
        SubRow {
            id: id.into(),
            user_id: uid.into(),
            customer_id: "cus_1".into(),
            price_id: price.into(),
            status: status.into(),
            current_period_end: 0,
            cancel_at_period_end: false,
            guild_id: Some(guild.into()),
            reassigned_at: None,
        }
    }

    #[test]
    fn active_slots_sums_only_active_and_known_prices_per_guild() {
        let (store, path) = temp_store("slots");
        let slots: HashMap<String, i64> =
            [("p_medium".into(), 36), ("p_expanded".into(), 130)].into();
        // Server g1: active Medium + trialing Expanded → 36 + 130.
        store
            .upsert_subscription(&row("s1", "u1", "g1", "p_medium", "active"))
            .unwrap();
        store
            .upsert_subscription(&row("s2", "u1", "g1", "p_expanded", "trialing"))
            .unwrap();
        // Canceled sub and an unknown price contribute nothing.
        store
            .upsert_subscription(&row("s3", "u1", "g1", "p_medium", "canceled"))
            .unwrap();
        store
            .upsert_subscription(&row("s4", "u1", "g1", "p_unknown", "active"))
            .unwrap();
        // A sub bound to a DIFFERENT server doesn't count toward g1 (even though
        // the same user owns it) — this is the whole point of per-server pricing.
        store
            .upsert_subscription(&row("s5", "u1", "g2", "p_expanded", "active"))
            .unwrap();
        assert_eq!(store.active_slots("g1", &slots), 166);
        assert_eq!(store.active_slots("g2", &slots), 130);
        assert_eq!(store.active_slots("nobody", &slots), 0);
        // Upsert is keyed by id: flipping s1 to canceled drops its slots.
        store
            .upsert_subscription(&row("s1", "u1", "g1", "p_medium", "canceled"))
            .unwrap();
        assert_eq!(store.active_slots("g1", &slots), 130);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn list_and_reassign_subscriptions_by_owner() {
        let (store, path) = temp_store("owner-subs");
        let slots: HashMap<String, i64> = [("p_pro".into(), 130)].into();
        store
            .upsert_subscription(&row("sub_a", "u1", "g1", "p_pro", "active"))
            .unwrap();
        store
            .upsert_subscription(&row("sub_b", "u2", "g2", "p_pro", "active"))
            .unwrap();
        // The owner listing is scoped to the paying user.
        let mine = store.list_subscriptions_for_user("u1");
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].id, "sub_a");
        assert_eq!(mine[0].guild_id.as_deref(), Some("g1"));
        // Move sub_a from g1 → g3: g1 loses the tier, g3 gains it.
        store.set_subscription_guild("sub_a", "g3").unwrap();
        assert_eq!(store.active_slots("g1", &slots), 0);
        assert_eq!(store.active_slots("g3", &slots), 130);
        assert_eq!(
            store.get_subscription("sub_a").unwrap().guild_id.as_deref(),
            Some("g3")
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn mark_reassigned_stamps_only_the_move_and_survives_remirror() {
        let (store, path) = temp_store("move-cooldown");
        store
            .upsert_subscription(&row("sub_a", "u1", "g1", "p_pro", "active"))
            .unwrap();
        // A fresh sub has never been moved → no cooldown clock.
        assert!(store
            .get_subscription("sub_a")
            .unwrap()
            .reassigned_at
            .is_none());
        // An explicit move stamps it…
        store.mark_reassigned("sub_a");
        let stamped = store.get_subscription("sub_a").unwrap().reassigned_at;
        assert!(stamped.is_some());
        // …and a later webhook re-mirror (upsert) must not clear it.
        store
            .upsert_subscription(&row("sub_a", "u1", "g2", "p_pro", "active"))
            .unwrap();
        assert_eq!(
            store.get_subscription("sub_a").unwrap().reassigned_at,
            stamped
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn humanize_rounds_up_to_the_coarser_unit() {
        assert_eq!(humanize(6 * 86_400 + 100), "7 days"); // 6d + a bit → 7 days
        assert_eq!(humanize(86_400), "1 day");
        assert_eq!(humanize(3_600), "1 hour");
        assert_eq!(humanize(90 * 60), "2 hours");
        assert_eq!(humanize(30), "1 minute");
    }

    #[test]
    fn guild_backfill_check_roundtrips() {
        let (store, path) = temp_store("gcheck");
        assert!(store.get_guild_checked("g1").is_none());
        store.put_guild_checked("g1", 1000);
        assert_eq!(store.get_guild_checked("g1"), Some(1000));
        store.put_guild_checked("g1", 2000);
        assert_eq!(store.get_guild_checked("g1"), Some(2000));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn best_unbound_claimable_picks_the_richest_floating_sub() {
        let slots: HashMap<String, i64> = [("p_plus".into(), 36), ("p_pro".into(), 130)].into();
        let unbound = |id: &str, price: &str, status: &str| SubRow {
            id: id.into(),
            user_id: "u1".into(),
            customer_id: "cus_1".into(),
            price_id: price.into(),
            status: status.into(),
            current_period_end: 0,
            cancel_at_period_end: false,
            guild_id: None,
            reassigned_at: None,
        };
        // Two floating recognized subs → the higher-slot one is auto-applied.
        let subs = vec![
            unbound("s1", "p_plus", "active"),
            unbound("s2", "p_pro", "active"),
        ];
        assert_eq!(best_unbound_claimable(subs, &slots).unwrap().id, "s2");
        // A sub already bound to a server isn't "floating".
        let bound = row("s3", "u1", "g1", "p_pro", "active");
        assert!(best_unbound_claimable(vec![bound], &slots).is_none());
        // Canceled or unrecognized (foreign price) subs don't qualify.
        assert!(best_unbound_claimable(vec![unbound("s4", "p_pro", "canceled")], &slots).is_none());
        assert!(best_unbound_claimable(vec![unbound("s5", "p_x", "active")], &slots).is_none());
        // Trialing counts.
        assert_eq!(
            best_unbound_claimable(vec![unbound("s6", "p_plus", "trialing")], &slots)
                .unwrap()
                .id,
            "s6"
        );
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
        // Newer API: price + period end at the item level, plus the guild binding.
        let new_shape = json!({
            "id": "sub_1",
            "status": "active",
            "cancel_at_period_end": true,
            "customer": "cus_1",
            "metadata": { "guild_id": "g1", "discord_user_id": "u1" },
            "items": { "data": [ { "price": { "id": "p_x" }, "current_period_end": 111 } ] }
        });
        let f = extract_sub_fields(&new_shape).unwrap();
        assert_eq!(f.0, "sub_1");
        assert_eq!(f.1, "cus_1");
        assert_eq!(f.2, "p_x");
        assert_eq!(f.3, "active");
        assert_eq!(f.4, 111);
        assert!(f.5);
        assert_eq!(f.6.as_deref(), Some("g1"));
        // Older API: current_period_end at the top level, customer as an object,
        // and no guild metadata (a legacy/foreign sub) → binds no server.
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
        assert_eq!(f.6, None);
        // Not a subscription → None.
        assert!(extract_sub_fields(&json!({ "foo": 1 })).is_none());
    }

    #[test]
    fn checkout_key_maps_tier_and_interval() {
        assert_eq!(checkout_key("plus", "month"), "plus");
        assert_eq!(checkout_key("pro", "month"), "pro");
        assert_eq!(checkout_key("plus", "year"), "plus_year");
        assert_eq!(checkout_key("pro", "year"), "pro_year");
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
