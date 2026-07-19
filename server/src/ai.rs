//! Built-in AI assistant relay (Groq-backed).
//!
//! The browser's AI panel can run with no user-supplied key: the proxy holds a
//! single server-side `GROQ_API_KEY` and relays chat completions, streaming the
//! provider's OpenAI-shaped SSE back to the client unchanged (the FE reuses its
//! existing decoder). Everything that makes this safe to expose publicly lives
//! here:
//!
//!  - **The server owns the prompt.** The client sends only *data* — the live
//!    message JSON (`context`) and the transcript (`turns`); the instruction
//!    template ships in the binary (`ai_prompt.txt`, the same text the FE uses
//!    for bring-your-own-key providers) and the model/max_tokens/temperature
//!    are pinned server-side. Without this, the route is a free general-purpose
//!    LLM API wearing our key.
//!  - **Sign-in required.** Free usage is a per-user daily allowance; a Plus or
//!    Pro *server* gets a bigger pooled allowance (with a per-member ceiling)
//!    resolved through the existing entitlement gates.
//!  - **Layered abuse controls**: a route-local per-IP limiter (mounted in
//!    `main`), a per-user token bucket + one-in-flight rule here, a global
//!    concurrency semaphore (with reserved permits so paid servers keep working
//!    under load), daily request/token quotas, and a monthly global token
//!    budget that hard-caps what the feature can ever cost.
//!
//! Usage is recorded in `ai_usage.rs` after each request from the token counts
//! Groq reports in its final stream chunk (estimated from character counts when
//! absent), and logged content-free under the `ai_usage` tracing target.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::PrivateCookieJar;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Semaphore;

use crate::ai_usage::{next_utc_midnight, utc_day, utc_month, AiUsageStore, UsageRow};
use crate::config::{Config, TierLimits};
use crate::entitlement::{unlimited_to_max, Tier};
use crate::error::AppError;
use crate::routes::{authorize_member_session, current_session, AppState};
use crate::schedule::unix_now;

/// The instruction template — the single source of truth, also imported (raw)
/// by the FE for its bring-your-own-key providers. Keep changes additive so a
/// FE/server deploy skew is harmless.
const PROMPT_TEMPLATE: &str = include_str!("ai_prompt.txt");

/// Bounds on what a client may submit. The context is the current message's
/// JSON — an oversized one is rejected (truncating JSON would corrupt it);
/// transcript turns are clamped instead (oldest dropped, long ones truncated).
const MAX_CONTEXT_CHARS: usize = 24_000;
const MAX_TURNS: usize = 12;
const MAX_TURN_CHARS: usize = 8_000;

/// Hard wall-clock cap on one relayed stream. Groq completes in seconds; this
/// exists so a wedged upstream can't pin a relay task (the global request
/// timeout only bounds time-to-headers, not body streaming).
const STREAM_DEADLINE: Duration = Duration::from_secs(180);

/// Per-user send pacing: a small token bucket (burst, then sustained refill).
/// The FE only ever has one request in flight, so this only binds scripted use.
const USER_BURST: f64 = 3.0;
const USER_RATE_PER_SEC: f64 = 6.0 / 60.0;
/// Bound the per-user bucket map under uid churn.
const MAX_USER_BUCKETS: usize = 10_000;

/// Everything the AI relay needs at runtime. Present on `AppState` only when
/// `GROQ_API_KEY` is configured; absent ⇒ the endpoints answer 501 and the FE
/// hides the built-in provider.
pub struct AiRuntime {
    pub store: Arc<AiUsageStore>,
    http: reqwest::Client,
    base_url: String,
    api_key: String,
    model: String,
    fallback_model: Option<String>,
    max_tokens: u32,
    monthly_token_budget: u64,
    /// Free-tier lane. Paid servers may spill into `reserved` when this is
    /// exhausted, so they keep working while a burst of free traffic queues.
    shared: Arc<Semaphore>,
    reserved: Arc<Semaphore>,
    buckets: Mutex<HashMap<String, (f64, Instant)>>,
    inflight: Arc<Mutex<HashSet<String>>>,
}

impl AiRuntime {
    /// Build the runtime when the deployment configures a Groq key; `None`
    /// (feature off) otherwise. Store-open failures are fatal to the caller —
    /// a deployment that promises quotas must be able to count them.
    pub fn from_config(config: &Config) -> Result<Option<Arc<AiRuntime>>, String> {
        let Some(key) = &config.groq_api_key else {
            return Ok(None);
        };
        let store = AiUsageStore::open(&config.ai_db_path)?;
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .pool_max_idle_per_host(2)
            .user_agent(concat!(
                "dweeb-proxy-ai/",
                env!("CARGO_PKG_VERSION"),
                " (+https://github.com/FaizoKen/DWEEB)"
            ))
            .build()
            .map_err(|e| format!("ai http client: {e}"))?;
        Ok(Some(Arc::new(AiRuntime {
            store: Arc::new(store),
            http,
            base_url: config.ai_base_url.trim_end_matches('/').to_string(),
            api_key: key.clone(),
            model: config.ai_model.clone(),
            fallback_model: config.ai_fallback_model.clone(),
            max_tokens: config.ai_max_tokens,
            monthly_token_budget: config.ai_monthly_token_budget,
            shared: Arc::new(Semaphore::new(config.ai_concurrency)),
            reserved: Arc::new(Semaphore::new(config.ai_reserved_concurrency)),
            buckets: Mutex::new(HashMap::new()),
            inflight: Arc::new(Mutex::new(HashSet::new())),
        })))
    }

    /// Spend one token from a user's pacing bucket, or return the seconds until
    /// one is available.
    fn check_user_rate(&self, uid: &str) -> Result<(), u64> {
        let now = Instant::now();
        let mut map = match self.buckets.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if map.len() >= MAX_USER_BUCKETS {
            map.retain(|_, (_, last)| now.duration_since(*last) < Duration::from_secs(600));
        }
        let entry = map.entry(uid.to_string()).or_insert((USER_BURST, now));
        let elapsed = now.duration_since(entry.1).as_secs_f64();
        entry.0 = (entry.0 + elapsed * USER_RATE_PER_SEC).min(USER_BURST);
        entry.1 = now;
        if entry.0 >= 1.0 {
            entry.0 -= 1.0;
            Ok(())
        } else {
            Err(((1.0 - entry.0) / USER_RATE_PER_SEC).ceil() as u64)
        }
    }

    /// Claim the user's single in-flight slot, or `None` when a request is
    /// already running. The guard releases the slot on drop — including when
    /// the relay task ends because the client vanished.
    fn begin_inflight(&self, uid: &str) -> Option<InflightGuard> {
        let mut set = match self.inflight.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if !set.insert(uid.to_string()) {
            return None;
        }
        Some(InflightGuard {
            set: Arc::clone(&self.inflight),
            uid: uid.to_string(),
        })
    }
}

struct InflightGuard {
    set: Arc<Mutex<HashSet<String>>>,
    uid: String,
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        let mut set = match self.set.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        set.remove(&self.uid);
    }
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

/// Closed contract: data only, no prompt/model/sampling fields — those are
/// server-owned (see module docs).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiChatBody {
    #[serde(default)]
    guild_id: Option<String>,
    /// The current message as JSON — embedded under the server-held template.
    context: String,
    /// The running transcript, oldest first, ending with the latest user turn.
    turns: Vec<WireTurn>,
}

#[derive(Deserialize)]
pub struct WireTurn {
    role: String,
    content: String,
}

fn is_snowflake(s: &str) -> bool {
    (15..=25).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

/// Truncate to at most `max` characters on a char boundary.
fn clamp_chars(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

fn bad_request(message: &str) -> AppError {
    AppError::Status {
        status: StatusCode::BAD_REQUEST,
        message: message.into(),
        retry_after: None,
    }
}

/// A structured refusal the FE can render precisely: `kind` is one of
/// `quota` (a daily allowance is spent — carries `resets_at`), `budget` (the
/// deployment's monthly budget is spent), or `busy` (retryable concurrency
/// backpressure).
fn kinded_error(status: StatusCode, kind: &str, message: &str, extra: Value) -> Response {
    let mut body = json!({
        "error": message,
        "status": status.as_u16(),
        "kind": kind,
    });
    if let (Some(obj), Some(more)) = (body.as_object_mut(), extra.as_object()) {
        for (k, v) in more {
            obj.insert(k.clone(), v.clone());
        }
    }
    (status, Json(body)).into_response()
}

// ── Quota evaluation ────────────────────────────────────────────────────────

/// Why a request was refused before reaching the provider.
#[derive(Debug, PartialEq, Eq)]
enum QuotaDenied {
    /// The deployment's monthly token budget is exhausted.
    Budget,
    /// The binding daily allowance (user on Free, server pool on paid) is
    /// spent — either its request count or its token budget.
    Daily { used: i64, limit: i64 },
    /// A paid server's pool has room, but this member hit their ceiling.
    Member { used: i64, limit: i64 },
}

/// Pure quota decision, so it's unit-testable without SQLite:
///  - Free (or no guild): the *user's* daily requests/tokens bind.
///  - Plus/Pro with a guild: the *server pool* binds, plus a per-member
///    request ceiling so one member can't drain a community's pool.
///  - The global monthly token budget binds everyone (0 = uncapped).
fn evaluate_quota(
    tier: Tier,
    limits: &TierLimits,
    user: UsageRow,
    guild: Option<UsageRow>,
    global: UsageRow,
    monthly_token_budget: u64,
) -> Result<(), QuotaDenied> {
    if monthly_token_budget > 0 && global.tokens >= monthly_token_budget as i64 {
        return Err(QuotaDenied::Budget);
    }
    let req_limit = unlimited_to_max(limits.ai_requests);
    let tok_limit = unlimited_to_max(limits.ai_tokens);
    match (tier, guild) {
        (Tier::Free, _) | (_, None) => {
            if user.requests >= req_limit || user.tokens >= tok_limit {
                return Err(QuotaDenied::Daily {
                    used: user.requests,
                    limit: req_limit,
                });
            }
        }
        (_, Some(pool)) => {
            if pool.requests >= req_limit || pool.tokens >= tok_limit {
                return Err(QuotaDenied::Daily {
                    used: pool.requests,
                    limit: req_limit,
                });
            }
            if limits.ai_member_requests > 0 && user.requests >= limits.ai_member_requests {
                return Err(QuotaDenied::Member {
                    used: user.requests,
                    limit: limits.ai_member_requests,
                });
            }
        }
    }
    Ok(())
}

// ── SSE usage scanning ──────────────────────────────────────────────────────

/// Incrementally scans the relayed SSE bytes for the provider's token counts
/// (Groq puts them under `x_groq.usage` in the final chunk; the OpenAI shape
/// is a top-level `usage`) and counts delta characters as an estimation
/// fallback. Never blocks the relay: unparseable lines are simply skipped.
#[derive(Default)]
struct SseScan {
    buf: String,
    out_chars: usize,
    usage: Option<(i64, i64)>,
}

impl SseScan {
    fn push(&mut self, chunk: &[u8]) {
        self.buf.push_str(&String::from_utf8_lossy(chunk));
        while let Some(nl) = self.buf.find('\n') {
            let line: String = self.buf.drain(..=nl).collect();
            self.line(line.trim());
        }
        // A pathological chunk stream without newlines must not grow forever.
        if self.buf.len() > 128 * 1024 {
            self.buf.clear();
        }
    }

    fn line(&mut self, line: &str) {
        let Some(data) = line.strip_prefix("data:") else {
            return;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(data) else {
            return;
        };
        if let Some(delta) = v
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("delta"))
            .and_then(|d| d.get("content"))
            .and_then(|c| c.as_str())
        {
            self.out_chars += delta.chars().count();
        }
        let usage = v
            .get("x_groq")
            .and_then(|x| x.get("usage"))
            .or_else(|| v.get("usage"));
        if let Some(u) = usage {
            let prompt = u.get("prompt_tokens").and_then(Value::as_i64);
            let completion = u.get("completion_tokens").and_then(Value::as_i64);
            if let (Some(p), Some(c)) = (prompt, completion) {
                self.usage = Some((p, c));
            }
        }
    }
}

/// Rough token estimate for when the provider omits usage: ~4 chars per token
/// is the standard planning heuristic and errs slightly high on English prose.
fn estimate_tokens(chars: usize) -> i64 {
    (chars / 4).max(1) as i64
}

// ── The chat relay ──────────────────────────────────────────────────────────

fn runtime(st: &AppState) -> Result<&Arc<AiRuntime>, AppError> {
    st.ai.as_ref().ok_or_else(|| AppError::Status {
        status: StatusCode::NOT_IMPLEMENTED,
        message: "Built-in AI isn't enabled on this deployment.".into(),
        retry_after: None,
    })
}

/// `POST /api/ai/chat` — one streamed completion. Cookie-gated (web app). If
/// the assistant ever ships inside the Discord Activity, add a bearer twin that
/// resolves the session via `activity::resolve_identity` and calls the same
/// core — the cookie-only route silently 401s in that iframe.
pub async fn ai_chat(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Json(body): Json<AiChatBody>,
) -> Result<Response, AppError> {
    let ai = Arc::clone(runtime(&st)?);
    let session = current_session(&jar).ok_or_else(|| {
        AppError::Unauthorized("Sign in with Discord to use the built-in AI assistant.".into())
    })?;

    // ── Validate + clamp the payload ────────────────────────────────────
    if body.context.trim().is_empty() {
        return Err(bad_request("context is required"));
    }
    if body.context.chars().count() > MAX_CONTEXT_CHARS {
        return Err(bad_request(
            "The current message is too large for the assistant — trim it down and try again.",
        ));
    }
    if body.turns.is_empty() {
        return Err(bad_request("turns is required"));
    }
    let mut turns: Vec<(String, String)> = Vec::with_capacity(MAX_TURNS);
    for turn in body.turns.iter().rev().take(MAX_TURNS) {
        match turn.role.as_str() {
            "user" | "assistant" => {}
            _ => return Err(bad_request("turn roles must be user or assistant")),
        }
        turns.push((
            turn.role.clone(),
            clamp_chars(&turn.content, MAX_TURN_CHARS).to_string(),
        ));
    }
    turns.reverse();

    // ── Pace + single-flight per user ───────────────────────────────────
    let uid = session.uid.clone();
    if let Err(retry) = ai.check_user_rate(&uid) {
        return Err(AppError::Status {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: "You're sending requests too quickly — give it a few seconds.".into(),
            retry_after: Some(retry as f64),
        });
    }
    let Some(inflight_guard) = ai.begin_inflight(&uid) else {
        return Err(AppError::Status {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: "One AI request at a time — wait for the current reply to finish.".into(),
            retry_after: Some(2.0),
        });
    };

    // ── Resolve the tier the request runs under ─────────────────────────
    let guild = match body.guild_id.as_deref().map(str::trim) {
        Some(g) if !g.is_empty() => {
            if !is_snowflake(g) {
                return Err(bad_request("guild_id doesn't look like a server id"));
            }
            // The same membership gate every per-server feature uses; a guild
            // the user can't use is a 403, not a quota bypass.
            authorize_member_session(&st, session, g).await?;
            Some(g.to_string())
        }
        _ => None,
    };
    let tier = match &guild {
        Some(g) => st.entitlements.tier_for(g).await,
        None => Tier::Free,
    };
    let limits = st.entitlements.limits_for(tier);

    // ── Daily quotas + monthly budget ───────────────────────────────────
    let now = unix_now();
    let day = utc_day(now);
    let month = utc_month(now);
    let resets_at = next_utc_midnight(now);
    let (user_row, guild_row, global_row) = {
        let store = Arc::clone(&ai.store);
        let uid = uid.clone();
        let guild = guild.clone();
        let day_key = day.clone();
        let month_key = month.clone();
        tokio::task::spawn_blocking(move || -> Result<_, String> {
            let user = store.read(&format!("u:{uid}"), &day_key)?;
            let guild = match &guild {
                Some(g) => Some(store.read(&format!("g:{g}"), &day_key)?),
                None => None,
            };
            let global = store.read("global", &month_key)?;
            Ok((user, guild, global))
        })
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(|e| AppError::Internal(format!("ai usage store: {e}")))?
    };
    let paid_guild = tier != Tier::Free && guild.is_some();
    if let Err(denied) = evaluate_quota(
        tier,
        &limits,
        user_row,
        if paid_guild { guild_row } else { None },
        global_row,
        ai.monthly_token_budget,
    ) {
        return Ok(match denied {
            QuotaDenied::Budget => kinded_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "budget",
                "Built-in AI is at capacity this month. You can keep going with your own API key.",
                json!({}),
            ),
            QuotaDenied::Daily { used, limit } => kinded_error(
                StatusCode::TOO_MANY_REQUESTS,
                "quota",
                if paid_guild {
                    "This server's daily AI allowance is used up. It resets at midnight UTC."
                } else {
                    "Your free daily AI allowance is used up. It resets at midnight UTC — or upgrade the server for a bigger shared pool."
                },
                json!({ "resets_at": resets_at, "used": used, "limit": limit, "tier": tier.as_str() }),
            ),
            QuotaDenied::Member { used, limit } => kinded_error(
                StatusCode::TOO_MANY_REQUESTS,
                "quota",
                "You've hit your personal daily share of this server's AI pool. It resets at midnight UTC.",
                json!({ "resets_at": resets_at, "used": used, "limit": limit, "tier": tier.as_str() }),
            ),
        });
    }

    // ── Concurrency: paid servers may spill into the reserved lane ─────
    let permit = match Arc::clone(&ai.shared).try_acquire_owned() {
        Ok(p) => p,
        Err(_) if paid_guild => match Arc::clone(&ai.reserved).try_acquire_owned() {
            Ok(p) => p,
            Err(_) => {
                return Ok(kinded_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "busy",
                    "The assistant is busy right now — try again in a few seconds.",
                    json!({ "retry_after": 3 }),
                ))
            }
        },
        Err(_) => {
            return Ok(kinded_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "busy",
                "The assistant is busy right now — try again in a few seconds.",
                json!({ "retry_after": 3 }),
            ))
        }
    };

    // ── Build the provider request (server-owned prompt) ────────────────
    let system = build_system(&body.context);
    let mut messages = Vec::with_capacity(turns.len() + 1);
    messages.push(json!({ "role": "system", "content": system }));
    let mut input_chars = system.chars().count();
    for (role, content) in &turns {
        input_chars += content.chars().count();
        messages.push(json!({ "role": role, "content": content }));
    }
    let estimated_in = estimate_tokens(input_chars);

    let started = Instant::now();
    let response = start_stream(&ai, &messages).await?;
    let used_model = response.1;
    let upstream = response.0;

    // Remaining-today hint for the FE meter (binding scope, counting this
    // request). Best-effort — the authoritative number is `/api/ai/usage`.
    let binding = if paid_guild {
        guild_row.unwrap_or_default()
    } else {
        user_row
    };
    let remaining = (unlimited_to_max(limits.ai_requests) - binding.requests - 1).max(0);

    // ── Relay the stream; account for it when it ends ───────────────────
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(32);
    let store = Arc::clone(&ai.store);
    tokio::spawn(async move {
        let mut upstream = upstream;
        let mut scan = SseScan::default();
        let deadline = tokio::time::Instant::now() + STREAM_DEADLINE;
        let mut clean = true;
        loop {
            match tokio::time::timeout_at(deadline, upstream.chunk()).await {
                Ok(Ok(Some(chunk))) => {
                    scan.push(&chunk);
                    if tx.send(Ok(chunk.to_vec())).await.is_err() {
                        // Client went away; stop reading (and paying for) the
                        // rest of the stream.
                        clean = false;
                        break;
                    }
                }
                Ok(Ok(None)) => break,
                Ok(Err(_)) | Err(_) => {
                    clean = false;
                    break;
                }
            }
        }
        drop(tx);

        let (tokens_in, tokens_out) = scan
            .usage
            .unwrap_or((estimated_in, estimate_tokens(scan.out_chars)));
        let mut entries = vec![
            (format!("u:{uid}"), day.clone()),
            ("global".to_string(), month.clone()),
        ];
        if let Some(g) = &guild {
            entries.push((format!("g:{g}"), day.clone()));
        }
        let record =
            tokio::task::spawn_blocking(move || store.record(&entries, tokens_in, tokens_out))
                .await;
        match record {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::warn!("ai usage record failed: {e}"),
            Err(e) => tracing::warn!("ai usage record panicked: {e}"),
        }
        tracing::info!(
            target: "ai_usage",
            uid = %uid,
            guild = %guild.as_deref().unwrap_or(""),
            tier = tier.as_str(),
            model = %used_model,
            tokens_in,
            tokens_out,
            estimated = scan.usage.is_none(),
            clean,
            ms = started.elapsed().as_millis() as u64,
            "ai chat"
        );
        // Held for the stream's whole lifetime; released here in order.
        drop(permit);
        drop(inflight_guard);
    });

    let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
    let mut resp = Response::new(Body::from_stream(stream));
    let headers = resp.headers_mut();
    headers.insert(header::CONTENT_TYPE, "text/event-stream".parse().unwrap());
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    if let Ok(hv) = header::HeaderValue::from_str(&remaining.to_string()) {
        headers.insert("x-ai-requests-remaining", hv);
    }
    Ok(resp)
}

/// The full system prompt: the shipped template plus the live message, in
/// exactly the shape the FE builds for bring-your-own-key providers.
fn build_system(context: &str) -> String {
    format!(
        "{}\n\n## CURRENT MESSAGE (the editor's live state)\nThis is the live editor state right now — any json block you emitted earlier has already been applied to it. Base your next edit on THIS, not on memory.\n```json\n{}\n```",
        PROMPT_TEMPLATE.trim_end(),
        context
    )
}

/// Start the provider stream: primary model, one retry, then the fallback
/// model (when configured). Transient/capacity failures (network, 429, 413,
/// 5xx) are retried and fall through to the fallback model; any other 4xx is
/// our bug or our key and retrying can't fix it.
///
/// A 413 is a *capacity* condition, not a malformed request: Groq returns it
/// (with `code: rate_limit_exceeded`, `type: tokens`) when a single request's
/// prompt **plus its reserved `max_tokens`** exceeds the model's per-minute
/// token budget — the free tier's is small enough that the reserved
/// completion budget alone can breach it. So it must NOT be logged at error or
/// surfaced as a "we rejected your request" 502; it flows to the fallback
/// model (which may have a bigger budget) and otherwise returns a clear,
/// retryable, size-aware message.
async fn start_stream(
    ai: &AiRuntime,
    messages: &[Value],
) -> Result<(reqwest::Response, String), AppError> {
    let mut attempts: Vec<&str> = vec![&ai.model, &ai.model];
    if let Some(fb) = &ai.fallback_model {
        attempts.push(fb);
    }
    let url = format!("{}/chat/completions", ai.base_url);
    let mut last_transient = String::new();
    // True when the last failure was a token-budget/size limit, so the final
    // message can steer toward a shorter message / higher tier rather than a
    // generic "provider is having trouble".
    let mut last_was_capacity = false;
    for (i, model) in attempts.iter().enumerate() {
        if i > 0 {
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        let request = ai
            .http
            .post(&url)
            .bearer_auth(&ai.api_key)
            .json(&json!({
                "model": model,
                "messages": messages,
                "temperature": 0.2,
                "max_tokens": ai.max_tokens,
                "stream": true,
            }))
            .send();
        // Bound the time to response *headers*; the body stream has its own
        // deadline in the relay task.
        let sent = match tokio::time::timeout(Duration::from_secs(20), request).await {
            Ok(Ok(res)) => res,
            Ok(Err(e)) => {
                last_transient = format!("network: {e}");
                continue;
            }
            Err(_) => {
                last_transient = "timed out waiting for the provider".into();
                continue;
            }
        };
        let status = sent.status();
        if status.is_success() {
            return Ok((sent, model.to_string()));
        }
        let body = sent.text().await.unwrap_or_default();
        let is_capacity = status == StatusCode::PAYLOAD_TOO_LARGE;
        if status == StatusCode::TOO_MANY_REQUESTS || is_capacity || status.is_server_error() {
            // Capacity/rate conditions are expected on constrained tiers — warn,
            // don't error (an error here reads like a broken deploy and pages).
            tracing::warn!(
                model = %model,
                status = %status,
                detail = %clamp_chars(&body, 300),
                "ai upstream transient/capacity error"
            );
            last_transient = format!("upstream {status}");
            last_was_capacity = is_capacity;
            continue;
        }
        // Non-retryable: our key or a genuinely malformed request. Log detail
        // server-side, keep the client-facing message generic (never echo
        // provider internals).
        tracing::error!(
            model = %model,
            status = %status,
            body = %clamp_chars(&body, 500),
            "ai upstream rejected the request"
        );
        return Err(AppError::BadGateway(
            "The AI provider rejected the request. This has been logged — try again later.".into(),
        ));
    }
    tracing::warn!(
        error = %last_transient,
        capacity = last_was_capacity,
        "ai upstream unavailable after retries"
    );
    if last_was_capacity {
        // A token-budget/rate condition IS a rate limit, so answer 429 (not a
        // 5xx): it's the honest status, it carries a Retry-After the client
        // already understands, and it keeps tower_http's on_failure layer from
        // logging routine tier throttling at ERROR. The request's prompt +
        // reserved max_tokens exceeded the model's per-minute budget; the
        // durable fix is a smaller AI_MAX_TOKENS or a higher Groq tier, so
        // point the user at the lever they have.
        return Err(AppError::Status {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: "This request is too large for the AI service's current rate limit. Try a \
                      shorter message, wait a minute, or use your own API key in AI settings."
                .into(),
            retry_after: Some(30.0),
        });
    }
    Err(AppError::Status {
        status: StatusCode::BAD_GATEWAY,
        message:
            "The AI provider is having trouble — try again in a moment, or use your own API key."
                .into(),
        retry_after: Some(5.0),
    })
}

// ── Usage summary (GET /api/ai/usage) ───────────────────────────────────────

#[derive(Deserialize)]
pub struct UsageQuery {
    #[serde(default)]
    guild_id: Option<String>,
}

/// `GET /api/ai/usage?guild_id=…` — the signed-in user's remaining built-in AI
/// allowance, for the panel meter. With a paid `guild_id` the binding scope is
/// the server pool (plus the member ceiling); otherwise the user's free
/// allowance. `null` limits mean unlimited.
pub async fn ai_usage_summary(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    Query(query): Query<UsageQuery>,
) -> Result<Response, AppError> {
    let ai = Arc::clone(runtime(&st)?);
    let session = current_session(&jar).ok_or_else(|| {
        AppError::Unauthorized("Sign in with Discord to use the built-in AI assistant.".into())
    })?;
    let uid = session.uid.clone();

    let guild = match query.guild_id.as_deref().map(str::trim) {
        Some(g) if !g.is_empty() => {
            if !is_snowflake(g) {
                return Err(bad_request("guild_id doesn't look like a server id"));
            }
            authorize_member_session(&st, session, g).await?;
            Some(g.to_string())
        }
        _ => None,
    };
    let tier = match &guild {
        Some(g) => st.entitlements.tier_for(g).await,
        None => Tier::Free,
    };
    let limits = st.entitlements.limits_for(tier);
    let paid_guild = tier != Tier::Free && guild.is_some();

    let now = unix_now();
    let day = utc_day(now);
    let (user_row, guild_row) = {
        let store = Arc::clone(&ai.store);
        let uid = uid.clone();
        let guild = guild.clone();
        let day_key = day.clone();
        tokio::task::spawn_blocking(move || -> Result<_, String> {
            let user = store.read(&format!("u:{uid}"), &day_key)?;
            let guild = match &guild {
                Some(g) => Some(store.read(&format!("g:{g}"), &day_key)?),
                None => None,
            };
            Ok((user, guild))
        })
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(|e| AppError::Internal(format!("ai usage store: {e}")))?
    };

    let binding = if paid_guild {
        guild_row.unwrap_or_default()
    } else {
        user_row
    };
    let body = json!({
        "tier": tier.as_str(),
        "scope": if paid_guild { "guild" } else { "user" },
        "requests_used": binding.requests,
        "requests_limit": lim_json(limits.ai_requests),
        "tokens_used": binding.tokens,
        "tokens_limit": lim_json(limits.ai_tokens),
        "member_requests_used": if paid_guild { json!(user_row.requests) } else { Value::Null },
        "member_requests_limit": if paid_guild { lim_json(limits.ai_member_requests) } else { Value::Null },
        "resets_at": next_utc_midnight(now),
    });
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(body)).into_response())
}

/// A limit for the FE: positive number, or `null` for unlimited (`0`).
fn lim_json(n: i64) -> Value {
    if n <= 0 {
        Value::Null
    } else {
        json!(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits(requests: i64, tokens: i64, member: i64) -> TierLimits {
        TierLimits {
            schedules: 0,
            permanent: 0,
            custom_bots: 0,
            coeditors: 0,
            library: 0,
            library_posted: 0,
            ai_requests: requests,
            ai_tokens: tokens,
            ai_member_requests: member,
        }
    }

    fn row(requests: i64, tokens: i64) -> UsageRow {
        UsageRow { requests, tokens }
    }

    #[test]
    fn free_tier_binds_on_the_user_row() {
        let l = limits(30, 150_000, 0);
        assert!(evaluate_quota(Tier::Free, &l, row(29, 0), None, row(0, 0), 0).is_ok());
        assert_eq!(
            evaluate_quota(Tier::Free, &l, row(30, 0), None, row(0, 0), 0),
            Err(QuotaDenied::Daily {
                used: 30,
                limit: 30
            })
        );
        // The token budget binds independently of the request count.
        assert!(matches!(
            evaluate_quota(Tier::Free, &l, row(3, 150_000), None, row(0, 0), 0),
            Err(QuotaDenied::Daily { .. })
        ));
    }

    #[test]
    fn paid_tier_binds_on_the_pool_and_the_member_ceiling() {
        let l = limits(400, 2_000_000, 150);
        // Pool has room, member under ceiling → allowed.
        assert!(
            evaluate_quota(Tier::Plus, &l, row(10, 0), Some(row(200, 0)), row(0, 0), 0).is_ok()
        );
        // Pool spent → denied regardless of the member's own count.
        assert!(matches!(
            evaluate_quota(Tier::Plus, &l, row(0, 0), Some(row(400, 0)), row(0, 0), 0),
            Err(QuotaDenied::Daily { .. })
        ));
        // Member ceiling inside a roomy pool.
        assert_eq!(
            evaluate_quota(Tier::Plus, &l, row(150, 0), Some(row(200, 0)), row(0, 0), 0),
            Err(QuotaDenied::Member {
                used: 150,
                limit: 150
            })
        );
        // A paid tier with no guild scope falls back to the user row.
        assert!(matches!(
            evaluate_quota(Tier::Pro, &l, row(400, 0), None, row(0, 0), 0),
            Err(QuotaDenied::Daily { .. })
        ));
    }

    #[test]
    fn zero_limits_mean_unlimited_and_budget_binds_everyone() {
        let l = limits(0, 0, 0);
        assert!(evaluate_quota(Tier::Free, &l, row(9_999, 9_999_999), None, row(0, 0), 0).is_ok());
        assert_eq!(
            evaluate_quota(
                Tier::Pro,
                &l,
                row(0, 0),
                Some(row(0, 0)),
                row(0, 20_000_000),
                20_000_000
            ),
            Err(QuotaDenied::Budget)
        );
        // Budget 0 = uncapped.
        assert!(evaluate_quota(
            Tier::Pro,
            &l,
            row(0, 0),
            Some(row(0, 0)),
            row(0, i64::MAX / 2),
            0
        )
        .is_ok());
    }

    #[test]
    fn sse_scan_finds_groq_usage_and_counts_delta_chars() {
        let mut scan = SseScan::default();
        scan.push(b"data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n");
        // A chunk boundary mid-line must not lose the line.
        scan.push(b"data: {\"choices\":[{\"delta\":{\"cont");
        scan.push(b"ent\":\"lo!\"}}]}\n");
        scan.push(
            b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"x_groq\":{\"usage\":{\"prompt_tokens\":812,\"completion_tokens\":44}}}\n",
        );
        scan.push(b"data: [DONE]\n");
        assert_eq!(scan.out_chars, 6);
        assert_eq!(scan.usage, Some((812, 44)));

        // OpenAI's `stream_options.include_usage` shape works too.
        let mut scan = SseScan::default();
        scan.push(b"data: {\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2}}\n");
        assert_eq!(scan.usage, Some((10, 2)));

        // Garbage and non-data lines are ignored, never fatal.
        let mut scan = SseScan::default();
        scan.push(b": keep-alive\nevent: ping\ndata: not-json\n");
        assert_eq!(scan.usage, None);
        assert_eq!(scan.out_chars, 0);
    }

    #[test]
    fn clamps_and_validators() {
        assert_eq!(clamp_chars("héllo", 3), "hél");
        assert_eq!(clamp_chars("hi", 10), "hi");
        assert!(is_snowflake("123456789012345678"));
        assert!(!is_snowflake("12345"));
        assert!(!is_snowflake("123456789012345678a"));
        assert_eq!(estimate_tokens(0), 1);
        assert_eq!(estimate_tokens(400), 100);
    }

    #[test]
    fn system_prompt_embeds_template_and_context() {
        let system = build_system("{\"components\":[]}");
        assert!(system.starts_with("You are an expert assistant embedded in DWEEB"));
        assert!(system.contains("## CURRENT MESSAGE (the editor's live state)"));
        assert!(system.ends_with("```json\n{\"components\":[]}\n```"));
    }
}
