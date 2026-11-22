//! Tests for `purchase.rs`: the rule over every combination of subscriptions,
//! then the real client against an in-process fake Stripe.
//!
//! Two promises are pinned throughout: an Upgrade click never opens a second
//! charge for the same thing, and it never writes to an existing subscription.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde_json::{json, Value};

use super::purchase::{self, decide, Purchase};
use super::*;
use crate::entitlement::Tier;
use crate::error::Fault;

const UID: &str = "100000000000000001";
const OTHER_UID: &str = "100000000000000002";
const HERE: &str = "200000000000000001";
const ELSEWHERE: &str = "200000000000000002";
const PERIOD_END: i64 = 4_000_000_000;

fn slots() -> HashMap<String, i64> {
    [
        ("small", 10),
        ("medium", 36),
        ("large", 74),
        ("expanded", 130),
        ("maximized", 208),
    ]
    .into_iter()
    .map(|(price, n)| (price.to_string(), n))
    .collect()
}

fn row(id: &str, price: &str, status: &str, guild: Option<&str>, ending: bool) -> SubRow {
    SubRow {
        id: id.into(),
        user_id: UID.into(),
        customer_id: "cus_1".into(),
        price_id: price.into(),
        status: status.into(),
        current_period_end: PERIOD_END,
        cancel_at_period_end: ending,
        guild_id: guild.map(String::from),
        reassigned_at: None,
    }
}

// ── The rule ─────────────────────────────────────────────────────────────────

/// Every pair of subscriptions, against every target and every plan someone
/// else could be paying for on the server (some 350,000 cases).
#[test]
fn no_combination_opens_a_second_charge_and_none_is_blocked_needlessly() {
    let slots = slots();
    let mut options = vec![None];
    for price in ["small", "medium", "large", "expanded", "maximized"] {
        for status in [
            "active",
            "trialing",
            "past_due",
            "unpaid",
            "paused",
            "canceled",
            "incomplete",
        ] {
            for guild in [Some(HERE), None, Some(ELSEWHERE)] {
                for ending in [false, true] {
                    options.push(Some((price, status, guild, ending)));
                }
            }
        }
    }
    for a in &options {
        for b in &options {
            let subs: Vec<SubRow> = [("sub_a", a), ("sub_b", b)]
                .into_iter()
                .filter_map(|(id, o)| o.map(|(p, st, g, e)| row(id, p, st, g, e)))
                .collect();
            for others in [0, 10, 36, 130] {
                let here_live: i64 = subs
                    .iter()
                    .filter(|s| s.guild_id.as_deref() == Some(HERE))
                    .filter(|s| ["active", "trialing"].contains(&s.status.as_str()))
                    .map(|s| slots[&s.price_id])
                    .sum();
                let current = Tier::from_slots(others + here_live);
                for target in [Tier::Plus, Tier::Pro] {
                    let got = decide(&subs, HERE, target, current, &slots);
                    let case = || format!("{a:?} + {b:?}, others {others}, to {target:?}");
                    if current >= target {
                        assert_eq!(got, Purchase::Refuse(purchase::ALREADY), "{}", case());
                        continue;
                    }
                    let would_pay_twice = subs.iter().any(|s| {
                        let tier = Tier::from_slots(slots[&s.price_id]);
                        tier != Tier::Free
                            && !["canceled", "incomplete"].contains(&s.status.as_str())
                            && match s.guild_id.as_deref() {
                                Some(guild) => guild == HERE,
                                None => current == Tier::Free || tier >= target,
                            }
                    });
                    assert_eq!(got != Purchase::Checkout, would_pay_twice, "{}", case());

                    if let Purchase::Switch(id) = &got {
                        let chosen = subs.iter().find(|s| &s.id == id).unwrap();
                        assert_eq!(chosen.guild_id.as_deref(), Some(HERE), "{}", case());
                        assert!(
                            ["active", "trialing"].contains(&chosen.status.as_str()),
                            "{}",
                            case()
                        );
                        assert!(!chosen.cancel_at_period_end, "{}", case());
                        // Only ever upward: a change can't cost anyone slots.
                        let tier = Tier::from_slots(slots[&chosen.price_id]);
                        assert!(tier != Tier::Free && tier < target, "{}", case());
                    }
                }
            }
        }
    }
}

#[test]
fn each_refusal_names_the_thing_to_do() {
    let slots = slots();
    let on = |subs: &[SubRow], target, current| decide(subs, HERE, target, current, &slots);

    let floating = [row("s", "medium", "active", None, false)];
    assert_eq!(
        on(&floating, Tier::Plus, Tier::Free),
        Purchase::Refuse(purchase::MOVE_EXISTING)
    );
    let due = [row("s", "medium", "past_due", Some(HERE), false)];
    assert_eq!(
        on(&due, Tier::Plus, Tier::Free),
        Purchase::Refuse(purchase::OVERDUE)
    );
    let ending = [row("s", "medium", "active", Some(HERE), true)];
    assert_eq!(
        on(&ending, Tier::Pro, Tier::Plus),
        Purchase::Refuse(purchase::RENEW_FIRST)
    );
    // Changing a good subscription adds no charge, so an overdue one beside it
    // in a stack doesn't stop it.
    let stack = [
        row("due", "medium", "past_due", Some(HERE), false),
        row("good", "medium", "active", Some(HERE), false),
    ];
    assert_eq!(
        on(&stack, Tier::Pro, Tier::Plus),
        Purchase::Switch("good".into())
    );
    // The biggest of a stack: the smallest step.
    let mixed = [
        row("medium", "medium", "active", Some(HERE), false),
        row("large", "large", "active", Some(HERE), false),
    ];
    assert_eq!(
        on(&mixed, Tier::Pro, Tier::Plus),
        Purchase::Switch("large".into())
    );
}

// ── A fake Stripe ────────────────────────────────────────────────────────────

struct Call {
    method: Method,
    path: String,
    form: HashMap<String, String>,
}

#[derive(Default)]
struct Fake {
    customers: Vec<(String, String)>,
    deleted: Vec<String>,
    subs: Vec<Value>,
    sessions: Vec<Value>,
    /// Requests whose path ends with this answer with this status instead.
    fail: Option<(&'static str, u16)>,
    calls: Vec<Call>,
}

fn pairs(raw: &[u8]) -> HashMap<String, String> {
    url::form_urlencoded::parse(raw).into_owned().collect()
}

async fn fake_stripe(
    State(fake): State<Arc<Mutex<Fake>>>,
    method: Method,
    uri: Uri,
    body: Bytes,
) -> Response {
    // A real round trip yields; without this two clicks could never interleave.
    tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    let mut f = fake.lock().unwrap();
    let path = uri.path().to_string();
    let query = pairs(uri.query().unwrap_or_default().as_bytes());
    let form = pairs(&body);
    f.calls.push(Call {
        method: method.clone(),
        path: path.clone(),
        form: form.clone(),
    });

    let error = |status: u16, code: &str| {
        (
            StatusCode::from_u16(status).unwrap(),
            Json(json!({ "error": { "code": code, "message": "fake says no" } })),
        )
            .into_response()
    };
    if let Some((suffix, status)) = f.fail {
        if path.ends_with(suffix) {
            return error(status, "fake_failure");
        }
    }
    let customer = query.get("customer").cloned().unwrap_or_default();
    if f.deleted.contains(&customer) {
        return error(400, "resource_missing");
    }
    let ok = |value: Value| Json(value).into_response();
    let search = query.get("query").cloned().unwrap_or_default();

    match (method.as_str(), path.as_str()) {
        ("GET", "/v1/customers/search") => ok(json!({ "data": f
            .customers
            .iter()
            .filter(|(_, uid)| search.contains(&format!("'{uid}'")))
            .map(|(id, _)| json!({ "id": id }))
            .collect::<Vec<_>>() })),
        ("GET", "/v1/subscriptions/search") => ok(json!({ "data": f
            .subs
            .iter()
            .filter(|s| s["metadata"]["guild_id"]
                .as_str()
                .is_some_and(|g| search.contains(&format!("'{g}'"))))
            .cloned()
            .collect::<Vec<_>>() })),
        ("GET", "/v1/subscriptions") => {
            // Stripe leaves canceled ones out unless asked for `status=all`.
            assert_eq!(query.get("status").map(String::as_str), Some("all"));
            ok(json!({ "data": f
                .subs
                .iter()
                .filter(|s| s["customer"] == customer.as_str())
                .cloned()
                .collect::<Vec<_>>() }))
        }
        ("GET", "/v1/checkout/sessions") => ok(json!({ "data": f
            .sessions
            .iter()
            .filter(|s| s["customer"] == customer.as_str() && s["status"] == "open")
            .cloned()
            .collect::<Vec<_>>() })),
        ("POST", "/v1/customers") => {
            let id = format!("cus_new{}", f.customers.len());
            let uid = form["metadata[discord_user_id]"].clone();
            f.customers.push((id.clone(), uid));
            ok(json!({ "id": id }))
        }
        ("POST", "/v1/checkout/sessions") => {
            let id = format!("cs_{}", f.sessions.len());
            f.sessions.push(json!({
                "id": id,
                "status": "open",
                "customer": form["customer"],
                "metadata": {
                    "source": form.get("metadata[source]"),
                    "guild_id": form.get("metadata[guild_id]"),
                },
            }));
            ok(json!({ "id": id, "client_secret": format!("{id}_secret") }))
        }
        ("POST", "/v1/billing_portal/sessions") => ok(json!({
            "url": format!("https://billing.example/{}", form["customer"]),
        })),
        ("POST", p) if p.ends_with("/expire") => {
            let id = p.split('/').nth(4).unwrap_or_default();
            match f
                .sessions
                .iter_mut()
                .find(|s| s["id"] == id && s["status"] == "open")
            {
                Some(session) => {
                    session["status"] = json!("expired");
                    ok(session.clone())
                }
                None => error(400, "not_open"),
            }
        }
        ("GET", p) if p.starts_with("/v1/subscriptions/") => {
            let id = p.trim_start_matches("/v1/subscriptions/");
            match f.subs.iter().find(|s| s["id"] == id) {
                Some(sub) => ok(sub.clone()),
                None => error(404, "resource_missing"),
            }
        }
        _ => error(501, "not_faked"),
    }
}

fn sub(id: &str, customer: &str, price: &str, status: &str, guild: Option<&str>) -> Value {
    let mut metadata = json!({ "discord_user_id": UID });
    if let Some(guild) = guild {
        metadata["guild_id"] = json!(guild);
    }
    json!({
        "id": id,
        "customer": customer,
        "status": status,
        "cancel_at_period_end": false,
        "cancel_at": null,
        "schedule": null,
        "metadata": metadata,
        "items": { "data": [{
            "id": format!("si_{id}"),
            "quantity": 1,
            "price": { "id": price },
            "current_period_end": PERIOD_END,
        }] },
    })
}

struct Harness {
    state: StripeState,
    fake: Arc<Mutex<Fake>>,
    path: std::path::PathBuf,
}

impl Harness {
    /// A world where Stripe holds `subs` and the mirror already agrees.
    async fn new(subs: Vec<Value>) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let mut customers: Vec<(String, String)> = Vec::new();
        for s in &subs {
            let pair = (
                s["customer"].as_str().unwrap().to_string(),
                s["metadata"]["discord_user_id"]
                    .as_str()
                    .unwrap()
                    .to_string(),
            );
            if !customers.contains(&pair) {
                customers.push(pair);
            }
        }
        let fake = Arc::new(Mutex::new(Fake {
            customers,
            subs: subs.clone(),
            ..Fake::default()
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().fallback(fake_stripe).with_state(fake.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let path = std::env::temp_dir().join(format!(
            "dweeb-purchase-test-{}-{}.db",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_file(&path);
        let checkout_price = [
            ("plus", "medium"),
            ("plus_year", "medium"),
            ("pro", "expanded"),
            ("pro_year", "expanded"),
        ]
        .into_iter()
        .map(|(key, price)| (key.to_string(), price.to_string()))
        .collect();
        let state = StripeState {
            client: StripeClient {
                secret: "sk_test".into(),
                http: reqwest::Client::new(),
                api,
                checkout_price,
                tax_rate_id: Some("txr_1".into()),
                webhook_secret: None,
                return_url: "https://dweeb.example".into(),
            },
            store: StripeStore::open(path.to_str().unwrap()).unwrap(),
            price_slots: slots(),
            backfill_ttl: 86_400,
            purchase_gates: Default::default(),
        };
        for s in &subs {
            state
                .client
                .upsert_from_sub(&state.store, s, None)
                .await
                .unwrap();
        }
        Harness { state, fake, path }
    }

    async fn buy(&self, tier: &str, guild: &str) -> Result<PurchaseStart, CheckoutError> {
        self.buy_with(tier, guild, None).await
    }

    async fn buy_with(
        &self,
        tier: &str,
        guild: &str,
        promo: Option<&PromoCode>,
    ) -> Result<PurchaseStart, CheckoutError> {
        self.state
            .start_purchase(CheckoutRequest {
                uid: UID,
                name: "Tester",
                tier,
                interval: "month",
                guild_id: guild,
                promo,
            })
            .await
    }

    fn posts(&self) -> Vec<(String, HashMap<String, String>)> {
        let fake = self.fake.lock().unwrap();
        fake.calls
            .iter()
            .filter(|c| c.method != Method::GET)
            .map(|c| (c.path.clone(), c.form.clone()))
            .collect()
    }

    /// The forms posted to create a checkout.
    fn checkouts(&self) -> Vec<HashMap<String, String>> {
        self.posts()
            .into_iter()
            .filter(|(path, _)| path == "/v1/checkout/sessions")
            .map(|(_, form)| form)
            .collect()
    }

    fn open_sessions(&self) -> Vec<String> {
        let fake = self.fake.lock().unwrap();
        fake.sessions
            .iter()
            .filter(|s| s["status"] == "open")
            .map(|s| s["id"].as_str().unwrap().to_string())
            .collect()
    }

    fn assert_subscriptions_untouched(&self) {
        for (path, _) in self.posts() {
            assert!(
                !path.starts_with("/v1/subscriptions"),
                "wrote to an existing subscription: {path}"
            );
        }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn refused(result: Result<PurchaseStart, CheckoutError>) -> &'static str {
    match result {
        Err(CheckoutError::Refused(why)) => why,
        Ok(PurchaseStart::Checkout(_)) => panic!("opened a checkout"),
        Ok(PurchaseStart::Switch { .. }) => panic!("offered a switch"),
        Err(_) => panic!("failed for another reason"),
    }
}

fn switched(result: Result<PurchaseStart, CheckoutError>) -> String {
    match result {
        Ok(PurchaseStart::Switch { portal_url }) => portal_url,
        Ok(PurchaseStart::Checkout(_)) => panic!("opened a second subscription"),
        Err(_) => panic!("refused"),
    }
}

// ── End to end ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_new_buyer_still_gets_the_same_checkout() {
    let h = Harness::new(vec![]).await;
    assert!(matches!(
        h.buy("plus", HERE).await,
        Ok(PurchaseStart::Checkout(_))
    ));
    let forms = h.checkouts();
    let form = &forms[0];
    assert_eq!(form["line_items[0][price]"], "medium");
    assert_eq!(form["line_items[0][tax_rates][0]"], "txr_1");
    assert_eq!(form["subscription_data[metadata][guild_id]"], HERE);
    assert_eq!(form["subscription_data[metadata][discord_user_id]"], UID);
    // What lets the next click close this form.
    assert_eq!(form["metadata[guild_id]"], HERE);
    assert_eq!(form["metadata[source]"], "dweeb");
    // The post-payment sync lists this customer.
    assert_eq!(h.state.store.get_customer(UID).unwrap().0, form["customer"]);
}

#[tokio::test]
async fn upgrading_changes_the_subscription_instead_of_adding_one() {
    let h = Harness::new(vec![sub("sub_1", "cus_1", "medium", "active", Some(HERE))]).await;
    let url = switched(h.buy("pro", HERE).await);
    assert_eq!(url, "https://billing.example/cus_1");
    assert!(h.checkouts().is_empty());

    let posts = h.posts();
    assert_eq!(posts.len(), 1, "a link is the only write");
    let form = &posts[0].1;
    let flow = "flow_data[subscription_update_confirm]";
    assert_eq!(form["flow_data[type]"], "subscription_update_confirm");
    assert_eq!(form[&format!("{flow}[subscription]")], "sub_1");
    assert_eq!(form[&format!("{flow}[items][0][id]")], "si_sub_1");
    assert_eq!(form[&format!("{flow}[items][0][price]")], "expanded");
    assert_eq!(form[&format!("{flow}[items][0][quantity]")], "1");
    h.assert_subscriptions_untouched();
    // Still Plus until the customer confirms at Stripe.
    assert_eq!(h.state.store.active_slots(HERE, &slots()), 36);
}

#[tokio::test]
async fn a_typed_code_rides_the_change() {
    let h = Harness::new(vec![sub("sub_1", "cus_1", "medium", "active", Some(HERE))]).await;
    let promo = PromoCode {
        id: "promo_1".into(),
        covers_everything: false,
    };
    switched(h.buy_with("pro", HERE, Some(&promo)).await);
    let form = &h.posts()[0].1;
    assert_eq!(
        form["flow_data[subscription_update_confirm][discounts][0][promotion_code]"],
        "promo_1"
    );

    h.fake.lock().unwrap().fail = Some(("/billing_portal/sessions", 400));
    assert!(matches!(
        h.buy_with("pro", HERE, Some(&promo)).await,
        Err(CheckoutError::PromoRejected(_))
    ));
}

#[tokio::test]
async fn a_flexible_billing_cancellation_asks_for_a_renewal() {
    let mut ending = sub("sub_1", "cus_1", "medium", "active", Some(HERE));
    ending["cancel_at"] = json!(PERIOD_END);
    let h = Harness::new(vec![ending]).await;
    assert_eq!(refused(h.buy("pro", HERE).await), purchase::RENEW_FIRST);
    let mirrored = h.state.store.get_subscription("sub_1").unwrap();
    assert!(mirrored.cancel_at_period_end);
    // Paid until the period ends, so still Plus.
    assert_eq!(h.state.store.active_slots(HERE, &slots()), 36);
    assert!(h.posts().is_empty());
}

#[test]
fn cancel_at_counts_only_when_the_period_wont_renew() {
    let read = |cancel_at: Value| {
        let mut s = sub("sub_1", "cus_1", "medium", "active", None);
        s["cancel_at"] = cancel_at;
        extract_sub_fields(&s).unwrap().5
    };
    assert!(!read(Value::Null));
    assert!(read(json!(PERIOD_END)));
    assert!(read(json!(PERIOD_END - 60)));
    assert!(
        !read(json!(PERIOD_END + 86_400)),
        "renews at least once more"
    );
}

#[tokio::test]
async fn an_overdue_plan_is_never_sold_again() {
    for guild in [Some(HERE), None] {
        let h = Harness::new(vec![sub("sub_1", "cus_1", "large", "past_due", guild)]).await;
        assert_eq!(refused(h.buy("plus", HERE).await), purchase::OVERDUE);
        assert!(h.posts().is_empty());
    }
}

/// The shapes of several-subscription people in the shared account (RoleLogic
/// stacks by design): none is rewritten, cancelled or sold a duplicate.
#[tokio::test]
async fn stacked_subscribers_are_left_exactly_as_they_are() {
    let stacks: [&[(&str, &str)]; 6] = [
        &[
            ("expanded", "active"),
            ("expanded", "active"),
            ("medium", "active"),
            ("small", "active"),
        ],
        &[
            ("medium", "active"),
            ("medium", "active"),
            ("medium", "active"),
            ("medium", "active"),
        ],
        &[("medium", "past_due"), ("medium", "past_due")],
        &[("medium", "active"), ("medium", "active")],
        &[("medium", "active"), ("small", "active")],
        &[
            ("expanded", "active"),
            ("expanded", "active"),
            ("maximized", "active"),
            ("maximized", "active"),
        ],
    ];
    for stack in stacks {
        // As RoleLogic sells them (no server), and with the first already
        // applied to this server by DWEEB.
        for first_bound in [false, true] {
            let subs: Vec<Value> = stack
                .iter()
                .enumerate()
                .map(|(i, (price, status))| {
                    let guild = (first_bound && i == 0).then_some(HERE);
                    sub(&format!("sub_{i}"), "cus_1", price, status, guild)
                })
                .collect();
            let h = Harness::new(subs.clone()).await;
            let before = h.state.store.active_slots(HERE, &slots());
            for tier in ["plus", "pro"] {
                assert!(
                    !matches!(h.buy(tier, HERE).await, Ok(PurchaseStart::Checkout(_))),
                    "{stack:?}, bound {first_bound}, {tier}"
                );
            }
            assert!(h.checkouts().is_empty());
            h.assert_subscriptions_untouched();
            assert_eq!(h.fake.lock().unwrap().subs, subs);
            assert_eq!(h.state.store.active_slots(HERE, &slots()), before);
            for s in &subs {
                let id = s["id"].as_str().unwrap();
                let kept = h.state.store.get_subscription(id).unwrap();
                assert_eq!(kept.status, s["status"].as_str().unwrap());
                assert_eq!(kept.price_id, s["items"]["data"][0]["price"]["id"]);
                assert_eq!(kept.guild_id.as_deref(), s["metadata"]["guild_id"].as_str());
            }
        }
    }
}

#[tokio::test]
async fn small_and_other_servers_plans_dont_block_a_purchase() {
    for existing in [
        sub("sub_1", "cus_1", "small", "active", None),
        sub("sub_1", "cus_1", "medium", "active", Some(ELSEWHERE)),
        sub("sub_1", "cus_1", "medium", "canceled", Some(HERE)),
    ] {
        let h = Harness::new(vec![existing]).await;
        assert!(matches!(
            h.buy("plus", HERE).await,
            Ok(PurchaseStart::Checkout(_))
        ));
        assert_eq!(h.checkouts()[0]["customer"], "cus_1", "one billing account");
        h.assert_subscriptions_untouched();
    }
}

#[tokio::test]
async fn someone_elses_plan_is_never_changed() {
    let mut theirs = sub("sub_theirs", "cus_theirs", "medium", "active", Some(HERE));
    theirs["metadata"]["discord_user_id"] = json!(OTHER_UID);
    let h = Harness::new(vec![theirs]).await;
    assert_eq!(refused(h.buy("plus", HERE).await), purchase::ALREADY);
    assert!(matches!(
        h.buy("pro", HERE).await,
        Ok(PurchaseStart::Checkout(_))
    ));
    assert_ne!(h.checkouts()[0]["customer"], "cus_theirs");
    h.assert_subscriptions_untouched();
}

#[tokio::test]
async fn someone_elses_plan_on_the_buyers_customer_is_left_alone() {
    let mut theirs = sub("sub_theirs", "cus_shared", "medium", "active", Some(HERE));
    theirs["metadata"]["discord_user_id"] = json!(OTHER_UID);
    let h = Harness::new(vec![theirs]).await;
    h.state.store.put_customer(UID, "cus_shared", 1);
    // Listed with the buyer's own, and still not theirs to change.
    assert!(matches!(
        h.buy("pro", HERE).await,
        Ok(PurchaseStart::Checkout(_))
    ));
    h.assert_subscriptions_untouched();
}

#[tokio::test]
async fn a_plan_on_the_other_apps_customer_is_found() {
    let h = Harness::new(vec![]).await;
    h.state.store.put_customer(UID, "cus_dweeb", 1);
    {
        // Stripe knows; the mirror and the cache don't.
        let mut fake = h.fake.lock().unwrap();
        fake.customers = vec![
            ("cus_dweeb".into(), UID.into()),
            ("cus_rl".into(), UID.into()),
        ];
        fake.subs = vec![sub("sub_rl", "cus_rl", "medium", "active", Some(HERE))];
    }
    assert_eq!(
        switched(h.buy("pro", HERE).await),
        "https://billing.example/cus_rl"
    );
    assert!(h.checkouts().is_empty());
}

#[tokio::test]
async fn a_payment_the_webhook_hasnt_reported_still_counts() {
    let h = Harness::new(vec![]).await;
    assert!(h.buy("plus", HERE).await.is_ok());
    {
        let mut fake = h.fake.lock().unwrap();
        let customer = fake.sessions[0]["customer"].as_str().unwrap().to_string();
        fake.sessions[0]["status"] = json!("complete");
        fake.subs = vec![sub("sub_paid", &customer, "medium", "active", Some(HERE))];
    }
    assert_eq!(refused(h.buy("plus", HERE).await), purchase::ALREADY);
    assert_eq!(h.checkouts().len(), 1);
}

#[tokio::test]
async fn only_one_payment_form_is_open_per_server() {
    let h = Harness::new(vec![]).await;
    assert!(h.buy("plus", HERE).await.is_ok());
    assert!(h.buy("plus", ELSEWHERE).await.is_ok());
    let customer = h.checkouts()[0]["customer"].clone();
    h.fake.lock().unwrap().sessions.push(json!({
        "id": "cs_rolelogic", "status": "open", "customer": customer, "metadata": {},
    }));
    assert!(h.buy("pro", HERE).await.is_ok());
    // The first form is closed; the other server's and RoleLogic's are left.
    assert_eq!(h.open_sessions(), ["cs_1", "cs_rolelogic", "cs_3"]);
}

#[tokio::test]
async fn two_clicks_at_once_leave_one_open_form() {
    let h = Harness::new(vec![]).await;
    let (a, b) = tokio::join!(h.buy("plus", HERE), h.buy("pro", HERE));
    assert!(a.is_ok() && b.is_ok());
    assert_eq!(h.open_sessions().len(), 1);
}

#[tokio::test]
async fn a_form_that_just_got_paid_stops_a_new_one() {
    let h = Harness::new(vec![]).await;
    assert!(h.buy("plus", HERE).await.is_ok());
    h.fake.lock().unwrap().fail = Some(("/expire", 400));
    assert_eq!(refused(h.buy("pro", HERE).await), purchase::FINISHING);
    assert_eq!(h.checkouts().len(), 1);
}

#[tokio::test]
async fn a_read_that_fails_never_becomes_a_purchase() {
    for path in [
        "/customers/search",
        "/checkout/sessions",
        "/v1/subscriptions",
    ] {
        for status in [401, 429, 500, 503] {
            let h = Harness::new(vec![sub("sub_1", "cus_1", "small", "active", None)]).await;
            h.fake.lock().unwrap().fail = Some((path, status));
            assert!(
                matches!(h.buy("plus", HERE).await, Err(CheckoutError::Stripe(_))),
                "{path} answering {status}"
            );
            assert!(h.posts().is_empty(), "{path} answering {status}");
        }
    }
}

#[tokio::test]
async fn a_deleted_customer_doesnt_strand_the_buyer() {
    let h = Harness::new(vec![]).await;
    h.state.store.put_customer(UID, "cus_gone", 1);
    h.fake.lock().unwrap().deleted = vec!["cus_gone".into()];
    assert!(matches!(
        h.buy("plus", HERE).await,
        Ok(PurchaseStart::Checkout(_))
    ));
    assert_ne!(h.checkouts()[0]["customer"], "cus_gone");

    // Stripe may also answer a deleted customer's lists as merely empty.
    let h = Harness::new(vec![]).await;
    h.state.store.put_customer(UID, "cus_gone_quietly", 1);
    h.fake.lock().unwrap().customers = vec![("cus_alive".into(), UID.into())];
    assert!(h.buy("plus", HERE).await.is_ok());
    assert_eq!(h.checkouts()[0]["customer"], "cus_alive");
}

#[tokio::test]
async fn what_the_portal_cant_change_is_said_plainly() {
    let mut scheduled = sub("sub_1", "cus_1", "medium", "active", Some(HERE));
    scheduled["schedule"] = json!("sub_sched_1");
    let h = Harness::new(vec![scheduled]).await;
    assert_eq!(refused(h.buy("pro", HERE).await), purchase::SCHEDULED);

    let mut two_items = sub("sub_1", "cus_1", "medium", "active", Some(HERE));
    let item = two_items["items"]["data"][0].clone();
    two_items["items"]["data"]
        .as_array_mut()
        .unwrap()
        .push(item);
    let h = Harness::new(vec![two_items]).await;
    assert_eq!(refused(h.buy("pro", HERE).await), purchase::CANT_SWITCH);

    let h = Harness::new(vec![sub("sub_1", "cus_1", "medium", "active", Some(HERE))]).await;
    h.fake.lock().unwrap().fail = Some(("/billing_portal/sessions", 400));
    assert_eq!(refused(h.buy("pro", HERE).await), purchase::CANT_SWITCH);
    assert!(h.checkouts().is_empty());
}

// ── Manage billing ───────────────────────────────────────────────────────────

#[tokio::test]
async fn manage_billing_opens_the_account_that_holds_the_plan() {
    let mut theirs = sub("sub_theirs", "cus_theirs", "medium", "active", None);
    theirs["metadata"]["discord_user_id"] = json!(OTHER_UID);
    let h = Harness::new(vec![
        sub("sub_live", "cus_live", "medium", "active", Some(HERE)),
        sub("sub_old", "cus_old", "small", "canceled", None),
        theirs,
    ])
    .await;
    // What used to decide it: the cache's last write.
    h.state.store.put_customer(UID, "cus_old", 1);

    let untargeted = h.state.portal_customer(UID, None).unwrap();
    assert_eq!(untargeted.as_deref(), Some("cus_live"));
    let named = h.state.portal_customer(UID, Some("sub_old")).unwrap();
    assert_eq!(named.as_deref(), Some("cus_old"));
    assert!(h.state.portal_customer(UID, Some("sub_theirs")).is_err());
    assert!(h.state.portal_customer(UID, Some("sub_none")).is_err());

    let url = h
        .state
        .client
        .create_portal(&h.state.store, UID, untargeted)
        .await
        .unwrap();
    assert_eq!(url, "https://billing.example/cus_live");
}

#[tokio::test]
async fn manage_billing_still_opens_for_past_invoices_only() {
    let h = Harness::new(vec![sub("sub_old", "cus_old", "medium", "canceled", None)]).await;
    let chosen = h.state.portal_customer(UID, None).unwrap();
    assert_eq!(chosen, None);
    let url = h
        .state
        .client
        .create_portal(&h.state.store, UID, chosen)
        .await
        .unwrap();
    assert_eq!(url, "https://billing.example/cus_old");
}

#[test]
fn with_two_accounts_an_overdue_plan_comes_first() {
    let mut due = row("due", "medium", "past_due", None, false);
    due.customer_id = "cus_due".into();
    let subs = [row("good", "expanded", "active", None, false), due];
    assert_eq!(purchase::primary(&subs, &slots()).unwrap().id, "due");
}

/// Clients from before the body existed post none.
#[tokio::test]
async fn the_portal_body_is_optional() {
    let app = Router::new().route(
        "/portal",
        axum::routing::post(|body: Option<Json<PortalBody>>| async move {
            body.and_then(|Json(b)| b.subscription_id)
                .unwrap_or_else(|| "none".into())
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/portal", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let http = reqwest::Client::new();
    let bare = http.post(&url).send().await.unwrap();
    assert_eq!(bare.status().as_u16(), 200);
    assert_eq!(bare.text().await.unwrap(), "none");
    let named = http
        .post(&url)
        .json(&json!({ "subscription_id": "sub_1" }))
        .send()
        .await
        .unwrap();
    assert_eq!(named.text().await.unwrap(), "sub_1");
}

// ── The route's answer ───────────────────────────────────────────────────────

#[tokio::test]
async fn a_refusal_is_never_our_failure() {
    let answer = |outcome| match purchase_response(outcome, HERE) {
        Ok(response) => response,
        Err(error) => error.into_response(),
    };

    let checkout = answer(Ok(PurchaseStart::Checkout(CheckoutStart {
        client_secret: "cs_secret".into(),
        no_card_needed: false,
    })));
    assert_eq!(checkout.status(), StatusCode::OK);

    let switch = answer(Ok(PurchaseStart::Switch {
        portal_url: "https://billing.example/x".into(),
    }));
    assert_eq!(switch.status(), StatusCode::CONFLICT);
    let body = axum::body::to_bytes(switch.into_body(), 4096)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["portal_url"], "https://billing.example/x");
    // An older client reads a missing secret as failure and prints `error`.
    assert!(body.get("client_secret").is_none() && body["error"].is_string());

    let refusal = answer(Err(CheckoutError::Refused(purchase::OVERDUE)));
    assert_eq!(refusal.status(), StatusCode::CONFLICT);
    assert!(refusal.extensions().get::<Fault>().is_none());

    for (status, fault) in [
        (None, Fault::Upstream),
        (Some(StatusCode::TOO_MANY_REQUESTS), Fault::Upstream),
        (Some(StatusCode::SERVICE_UNAVAILABLE), Fault::Upstream),
        (Some(StatusCode::UNAUTHORIZED), Fault::Ours),
    ] {
        let failed = answer(Err(CheckoutError::Stripe(StripeErr {
            status,
            code: None,
            message: "x".into(),
        })));
        assert_eq!(failed.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(failed.extensions().get::<Fault>(), Some(&fault));
    }

    let leaky = answer(Err(CheckoutError::Stripe(StripeErr {
        status: Some(StatusCode::UNAUTHORIZED),
        code: None,
        message: "Invalid API Key provided: sk_live_****abcd".into(),
    })));
    let body = axum::body::to_bytes(leaky.into_body(), 4096).await.unwrap();
    let shown = String::from_utf8_lossy(&body);
    assert!(!shown.contains("sk_live"), "{shown}");
}
