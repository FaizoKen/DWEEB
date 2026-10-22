//! Keeping posted history honest: entries whose Discord message was deleted.
//!
//! A posted library entry is the record of a live Discord message, but nothing
//! tells DWEEB when someone deletes that message in Discord — the proxy holds
//! no gateway connection, and most servers post through a webhook whose server
//! the bot may not even be in. So the directory went on showing deleted posts,
//! with Load and Update aimed at a message that no longer exists.
//!
//! The fix is a read-time check, driven by what people actually look at:
//! `POST /api/guilds/:guild_id/library/verify` takes the ids of the posted
//! cards a directory is showing, asks Discord about each message, marks the
//! rows whose message is confirmed gone (`deleted_at`), and answers with their
//! ids so the open directory relabels them at once. Four properties hold it
//! together:
//!
//!  - **A deleted message's content is kept, not dropped.** Deleting a Discord
//!    message can't be undone, so after a mistaken delete this copy is the
//!    only way back. A marked row leaves the history window, can't be checked
//!    or updated again, shows as "Deleted on Discord" and loads as a new post,
//!    and is purged [`DELETED_RETENTION_SECS`] later
//!    (`LibraryStore::purge_deleted`, hourly from `main`).
//!  - **A row is marked only on an answer that can't mean anything else.**
//!    Marking a live message deleted is far worse than showing a dead one a
//!    while longer, so every "couldn't tell" (rate limit, 5xx, refused
//!    permission, a webhook that moved channels, a bare 404 without Discord's
//!    error code) keeps the row, and [`verdict`] spells out which answers are
//!    proof. The webhook that posted the message is asked first (it needs no
//!    bot); the bot is asked only when the webhook can't say and the bot is in
//!    the server.
//!  - **Each row is asked about at most once per [`CHECK_INTERVAL_SECS`]**,
//!    however many tabs or re-renders ask: `LibraryStore::claim_check` stamps
//!    `checked_at` with one conditional UPDATE before any request goes out,
//!    and recording a post/edit stamps it too (the send just proved the
//!    message exists). The batch is capped like detail hydration, requests are
//!    paced on Discord's own bucket headers per webhook/channel, and the whole
//!    pass has a time budget — a row not reached is simply asked next time.
//!  - **A never-expire slot follows its message out.** A deleted message's
//!    slot can protect nothing (message ids are never reused), so the slot is
//!    released when the row is marked instead of being left as an orphan the
//!    manager has to find and free by hand.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap};
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::PrivateCookieJar;
use serde::Deserialize;
use serde_json::json;
use tokio::time::Instant;

use crate::discord::{MessageProbe, Probe};
use crate::error::AppError;
use crate::library::{CheckRow, LibraryStore, DELETED_RETENTION_SECS};
use crate::routes::{authorize_activity_webhooks, dispatcher_url_with_cap, AppState};
use crate::schedule::unix_now;
use crate::schedule_validate::{webhook_id, webhook_token};
use crate::seal;

/// How long a confirmed (or attempted) check stands before a row is asked
/// about again. Short enough that a message deleted a minute ago is gone the
/// next time the directory is opened; long enough that browsing the shelf
/// costs Discord at most one request per visible post per minute.
pub const CHECK_INTERVAL_SECS: i64 = 60;
/// Ids per request — the detail-hydration bound, which already covers a few
/// pages of cards.
const MAX_IDS: usize = 64;
/// Webhooks (or, hookless, channels) asked about in parallel. Rows behind one
/// webhook share its rate limit, so they go one at a time.
const GROUPS_IN_FLIGHT: usize = 4;
/// The whole pass. The directory never waits on it to render; this bounds how
/// long a request (and its claims) can hold proxy resources.
const BUDGET: Duration = Duration::from_secs(8);
/// A bucket that wants a longer rest than this ends that group's pass rather
/// than holding the request open; its rows are asked on a later open.
const MAX_PAUSE: Duration = Duration::from_secs(4);
/// Passes running at once, process-wide. Shed rather than queued: a skipped
/// pass leaves rows unclaimed, so the next open simply asks again.
const PASSES_IN_FLIGHT: usize = 4;

/// What one check concluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Verdict {
    Exists,
    Deleted,
    /// Nobody could say — keep the row, ask again after the interval.
    Unknown,
}

/// Where a webhook lives right now, by its own token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HookHome {
    Channel(String),
    /// Deleted, or its token was reset.
    Gone,
    Unknown,
}

/// The message to ask about, with what its row says about where it lives.
#[derive(Debug, Clone)]
pub(crate) struct Target {
    pub guild_id: String,
    pub message_id: String,
    /// The thread the message is in, when known: the row's `thread_id`, or the
    /// message id itself when the row's channel *is* the message id — a forum
    /// post a scheduled send opened records the echo's channel, which is the
    /// new thread, and a forum thread's id is its starter message's id.
    pub thread_id: Option<String>,
    /// The channel the webhook posted into — never a thread — when the row
    /// says so. The webhook check can only prove a deletion while the webhook
    /// still lives there.
    pub parent_id: Option<String>,
    /// `(webhook id, token)` of the webhook that posted it.
    pub hook: Option<(String, String)>,
    /// The custom bot it was posted as. That bot's webhook roams between
    /// channels, so its confirmation runs under the same lock as every move.
    pub application_id: Option<String>,
}

impl Target {
    pub(crate) fn from_row(guild: &str, row: &CheckRow, webhook_url: Option<&str>) -> Self {
        let message_id = row.message_id.clone();
        let (thread_id, parent_id) = match (&row.thread_id, &row.channel_id) {
            (Some(thread), channel) => (
                Some(thread.clone()),
                channel.clone().filter(|c| c != thread),
            ),
            (None, Some(channel)) if *channel == message_id => (Some(message_id.clone()), None),
            (None, channel) => (None, channel.clone()),
        };
        let hook = webhook_url.and_then(|url| Some((webhook_id(url)?, webhook_token(url)?)));
        Target {
            guild_id: guild.to_string(),
            message_id,
            thread_id,
            parent_id,
            hook,
            application_id: row.application_id.clone(),
        }
    }

    /// Where the bot looks: the thread when there is one, else the channel.
    fn container(&self) -> Option<&str> {
        self.thread_id.as_deref().or(self.parent_id.as_deref())
    }
}

/// The three questions a check can ask Discord. A trait so [`verdict`] — the
/// part that decides what counts as proof — is tested against scripted
/// answers instead of a live Discord.
pub(crate) trait Prober {
    async fn webhook_message(
        &self,
        hook: &(String, String),
        message_id: &str,
        thread_id: Option<&str>,
    ) -> MessageProbe;
    async fn webhook_home(&self, hook: &(String, String)) -> HookHome;
    async fn channel_message(&self, channel_id: &str, message_id: &str) -> MessageProbe;
}

/// Whether the message still exists. `bot_in_guild` gates the bot fallback:
/// outside the server, the bot's answers mean nothing.
pub(crate) async fn verdict<P: Prober>(p: &P, t: &Target, bot_in_guild: bool) -> Verdict {
    if let Some(hook) = &t.hook {
        if let Some(v) = webhook_verdict(p, t, hook).await {
            return v;
        }
    }
    if bot_in_guild {
        bot_verdict(p, t).await
    } else {
        Verdict::Unknown
    }
}

/// The webhook's answer, or `None` when only the bot could settle it.
async fn webhook_verdict<P: Prober>(p: &P, t: &Target, hook: &(String, String)) -> Option<Verdict> {
    let m = t.message_id.as_str();
    match p.webhook_message(hook, m, t.thread_id.as_deref()).await {
        MessageProbe::Exists => Some(Verdict::Exists),
        // The thread is gone — or no longer in the webhook's channel. Only the
        // bot can tell those apart.
        MessageProbe::UnknownChannel => None,
        // The webhook was deleted; its messages outlive it.
        MessageProbe::UnknownWebhook => None,
        // Discord didn't answer usefully. Asking the bot now would mostly
        // double the load of an outage; the next interval asks again.
        MessageProbe::Inconclusive => Some(Verdict::Unknown),
        MessageProbe::UnknownMessage => {
            // Discord reads a webhook's messages in the webhook's *current*
            // channel, so this proves nothing if the webhook has moved since
            // posting — and a custom bot's moves on every post. Confirm it
            // still lives where the message was posted, under the lock every
            // move of a roaming webhook takes, then ask again inside that
            // window.
            let _hook_guard = match &t.application_id {
                Some(app) => Some(crate::activity::lock_custom_hook(&t.guild_id, app).await),
                None => None,
            };
            match (t.parent_id.as_deref(), &t.thread_id, &t.application_id) {
                (Some(parent), _, _) => match p.webhook_home(hook).await {
                    HookHome::Channel(c) if c == parent => {}
                    HookHome::Channel(_) | HookHome::Gone => return None,
                    HookHome::Unknown => return Some(Verdict::Unknown),
                },
                // The parent isn't on record, but the named thread resolved
                // for a webhook DWEEB never moves.
                (None, Some(_), None) => {}
                _ => return None,
            }
            match p.webhook_message(hook, m, t.thread_id.as_deref()).await {
                MessageProbe::UnknownMessage => {}
                MessageProbe::Exists => return Some(Verdict::Exists),
                MessageProbe::Inconclusive => return Some(Verdict::Unknown),
                _ => return None,
            }
            if t.thread_id.is_some() {
                return Some(Verdict::Deleted);
            }
            // Not directly in the channel. A forum post recorded without its
            // thread lives in thread `m` (a forum thread's id is its starter
            // message's), so ask there before concluding.
            match p.webhook_message(hook, m, Some(m)).await {
                MessageProbe::Exists => Some(Verdict::Exists),
                MessageProbe::UnknownMessage | MessageProbe::UnknownChannel => {
                    Some(Verdict::Deleted)
                }
                MessageProbe::UnknownWebhook | MessageProbe::Inconclusive => None,
            }
        }
    }
}

async fn bot_verdict<P: Prober>(p: &P, t: &Target) -> Verdict {
    let Some(container) = t.container() else {
        return Verdict::Unknown;
    };
    let m = t.message_id.as_str();
    match p.channel_message(container, m).await {
        MessageProbe::Exists => Verdict::Exists,
        MessageProbe::UnknownMessage if t.thread_id.is_some() => Verdict::Deleted,
        MessageProbe::UnknownMessage => match p.channel_message(m, m).await {
            // A forum post recorded without its thread, as above.
            MessageProbe::Exists => Verdict::Exists,
            MessageProbe::UnknownMessage | MessageProbe::UnknownChannel => Verdict::Deleted,
            _ => Verdict::Unknown,
        },
        // The bot is in this server, where a channel it merely can't see
        // answers 403 Missing Access: Unknown Channel means the channel (or
        // thread) the message lived in was deleted, and its messages with it.
        MessageProbe::UnknownChannel => Verdict::Deleted,
        MessageProbe::UnknownWebhook | MessageProbe::Inconclusive => Verdict::Unknown,
    }
}

// ── Live prober: Discord, paced on its bucket headers ────────────────────────

struct LiveProber {
    discord: Arc<crate::discord::Discord>,
    /// When each bucket (`w:<webhook>` / `c:<channel>`) may be asked again.
    ready_at: Mutex<HashMap<String, Instant>>,
}

impl LiveProber {
    /// Wait for `bucket` to be ready, or `false` when that would take longer
    /// than [`MAX_PAUSE`] — the caller then reports `Inconclusive`.
    async fn wait(&self, bucket: &str) -> bool {
        let at = self
            .ready_at
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(bucket)
            .copied();
        let Some(at) = at else { return true };
        let now = Instant::now();
        if at <= now {
            return true;
        }
        if at - now > MAX_PAUSE {
            return false;
        }
        tokio::time::sleep_until(at).await;
        true
    }

    fn settle(&self, bucket: &str, probe: Probe) -> MessageProbe {
        if let Some(pause) = probe.pause {
            self.ready_at
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(bucket.to_string(), Instant::now() + pause);
        }
        probe.outcome
    }
}

impl Prober for LiveProber {
    async fn webhook_message(
        &self,
        hook: &(String, String),
        message_id: &str,
        thread_id: Option<&str>,
    ) -> MessageProbe {
        let bucket = format!("w:{}", hook.0);
        if !self.wait(&bucket).await {
            return MessageProbe::Inconclusive;
        }
        let probe = self
            .discord
            .probe_webhook_message(&hook.0, &hook.1, message_id, thread_id)
            .await;
        self.settle(&bucket, probe)
    }

    async fn webhook_home(&self, hook: &(String, String)) -> HookHome {
        if !self.wait(&format!("w:{}", hook.0)).await {
            return HookHome::Unknown;
        }
        match self.discord.webhook_by_token(&hook.0, &hook.1).await {
            Ok(Some(w)) => w.channel_id.map_or(HookHome::Unknown, HookHome::Channel),
            Ok(None) => HookHome::Gone,
            Err(_) => HookHome::Unknown,
        }
    }

    async fn channel_message(&self, channel_id: &str, message_id: &str) -> MessageProbe {
        let bucket = format!("c:{channel_id}");
        if !self.wait(&bucket).await {
            return MessageProbe::Inconclusive;
        }
        let probe = self
            .discord
            .probe_channel_message(channel_id, message_id)
            .await;
        self.settle(&bucket, probe)
    }
}

fn passes() -> &'static Arc<tokio::sync::Semaphore> {
    static PASSES: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    PASSES.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(PASSES_IN_FLIGHT)))
}

// ── HTTP handler ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct VerifyBody {
    pub ids: Vec<String>,
}

/// `POST /api/guilds/:guild_id/library/verify` — check the listed posted
/// entries against Discord and mark those whose message was deleted.
/// Answers `{ "gone": [ids], "deleted_at": <unix secs>,
/// "deleted_retention_secs": <secs> }`; `gone` keeps its name for the first
/// clients, which drop those cards. Same Manage-Webhooks gate (cookie or Activity
/// bearer) as the list; ids are guild-scoped in SQL, drafts and unknown ids
/// are ignored, and a row checked within [`CHECK_INTERVAL_SECS`] is skipped.
/// Never fails on Discord's account: anything it couldn't settle stays put.
pub async fn library_verify(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    headers: HeaderMap,
    Path(guild): Path<String>,
    Json(body): Json<VerifyBody>,
) -> Result<Response, AppError> {
    let store = crate::library::store(&st)?;
    let session = crate::activity::resolve_identity(&st, &jar, &headers).await?;
    authorize_activity_webhooks(&st, session, &guild).await?;

    if body.ids.len() > MAX_IDS {
        return Err(AppError::Status {
            status: axum::http::StatusCode::BAD_REQUEST,
            message: "Too many library entry ids.".into(),
            retry_after: None,
        });
    }
    let ids: Vec<String> = body
        .ids
        .into_iter()
        .filter(|id| crate::library::is_entry_id(id))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();

    let gone = Arc::new(Mutex::new(Vec::new()));
    // One timestamp for the whole pass, so the answer can state it once.
    let now = unix_now();
    if let Ok(_permit) = Arc::clone(passes()).try_acquire_owned() {
        // Out of time, the unfinished queues are dropped (aborted); rows they
        // claimed are asked about again after the interval, and every mark
        // that already happened is still reported below.
        let pass = run_pass(&st, &store, &guild, ids, now, &gone);
        let _ = tokio::time::timeout(BUDGET, pass).await;
    }
    let gone = std::mem::take(&mut *gone.lock().unwrap_or_else(|p| p.into_inner()));

    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({
            "gone": gone,
            "deleted_at": now,
            "deleted_retention_secs": DELETED_RETENTION_SECS,
        })),
    )
        .into_response())
}

/// Check the rows behind `ids` and mark the deleted ones, pushing each marked
/// id onto `gone` as it happens.
async fn run_pass(
    st: &AppState,
    store: &Arc<LibraryStore>,
    guild: &str,
    ids: Vec<String>,
    now: i64,
    gone: &Arc<Mutex<Vec<String>>>,
) {
    let rows = {
        let store = Arc::clone(store);
        let g = guild.to_string();
        match tokio::task::spawn_blocking(move || store.check_rows(&g, &ids)).await {
            Ok(Ok(rows)) => rows,
            Ok(Err(e)) => {
                tracing::warn!(target: "library", error = %e, "existence check: couldn't read rows");
                return;
            }
            Err(_) => return,
        }
    };
    if rows.is_empty() {
        return;
    }
    let bot_in_guild = crate::routes::bot_guild_set(st, false)
        .await
        .contains(guild);

    // One queue per webhook (or, hookless, per channel): those rows share a
    // rate limit, so they're asked one after another.
    let mut groups: HashMap<String, Vec<(String, Target)>> = HashMap::new();
    for row in rows {
        let url = row
            .webhook_sealed
            .as_deref()
            .and_then(|sealed| seal::open(&st.key, sealed));
        let target = Target::from_row(guild, &row, url.as_deref());
        let key = match (&target.hook, target.container()) {
            (Some((id, _)), _) => format!("w:{id}"),
            (None, Some(channel)) => format!("c:{channel}"),
            (None, None) => continue,
        };
        groups.entry(key).or_default().push((row.id, target));
    }

    let prober = Arc::new(LiveProber {
        discord: Arc::clone(&st.discord),
        ready_at: Mutex::new(HashMap::new()),
    });
    let lanes = Arc::new(tokio::sync::Semaphore::new(GROUPS_IN_FLIGHT));
    let mut tasks = tokio::task::JoinSet::new();
    for (_, queue) in groups {
        let (st, store, guild) = (st.clone(), Arc::clone(store), guild.to_string());
        let (prober, gone, lanes) = (Arc::clone(&prober), Arc::clone(gone), Arc::clone(&lanes));
        tasks.spawn(async move {
            let Ok(_lane) = lanes.acquire_owned().await else {
                return;
            };
            for (id, target) in queue {
                if !claim(&store, &guild, &id).await {
                    continue;
                }
                if verdict(prober.as_ref(), &target, bot_in_guild).await == Verdict::Deleted
                    && mark_deleted(&st, &store, &guild, &id, &target.message_id, now).await
                {
                    gone.lock().unwrap_or_else(|p| p.into_inner()).push(id);
                }
            }
        });
    }
    // Dropping the set on a timeout aborts every unfinished queue.
    while tasks.join_next().await.is_some() {}
}

async fn claim(store: &Arc<LibraryStore>, guild: &str, id: &str) -> bool {
    let store = Arc::clone(store);
    let (g, i) = (guild.to_string(), id.to_string());
    let now = unix_now();
    let cutoff = now - CHECK_INTERVAL_SECS;
    matches!(
        tokio::task::spawn_blocking(move || store.claim_check(&g, &i, now, cutoff)).await,
        Ok(Ok(true))
    )
}

/// Mark the row deleted on Discord and release any never-expire slot its
/// message held.
async fn mark_deleted(
    st: &AppState,
    store: &Arc<LibraryStore>,
    guild: &str,
    id: &str,
    message_id: &str,
    now: i64,
) -> bool {
    let marked = {
        let store = Arc::clone(store);
        let (g, i, m) = (guild.to_string(), id.to_string(), message_id.to_string());
        match tokio::task::spawn_blocking(move || store.mark_deleted_on_discord(&g, &i, &m, now))
            .await
        {
            Ok(Ok(marked)) => marked,
            Ok(Err(e)) => {
                tracing::warn!(target: "library", error = %e, "existence check: couldn't mark a row");
                false
            }
            Err(_) => false,
        }
    };
    if !marked {
        return false;
    }
    tracing::info!(
        target: "library",
        guild,
        message_id,
        "posted message was deleted on Discord; kept as deleted in history"
    );
    release_slot(st, guild, message_id).await;
    true
}

/// Free the never-expire slot a deleted message held, if any. Best-effort: a
/// failure leaves an orphaned slot the web directory lists with a Free button,
/// exactly as before this check existed.
async fn release_slot(st: &AppState, guild: &str, message_id: &str) {
    let Some(api) = &st.dispatcher else { return };
    let cap = st.entitlements.permanent_cap(guild).await;
    let url = dispatcher_url_with_cap(format!("{}/permanent/{guild}/{message_id}", api.base), cap);
    match api.http.delete(url).bearer_auth(&api.token).send().await {
        // 404 = it held no slot, the common case.
        Ok(resp) if resp.status().is_success() || resp.status().as_u16() == 404 => {
            if resp.status().is_success() {
                tracing::info!(target: "library", guild, message_id, "released the deleted message's never-expire slot");
            }
        }
        Ok(resp) => tracing::warn!(
            target: "library",
            status = resp.status().as_u16(),
            "couldn't release a deleted message's never-expire slot"
        ),
        Err(e) => tracing::warn!(
            target: "library",
            error = %crate::discord::describe(e),
            "couldn't reach the dispatcher to release a deleted message's never-expire slot"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use MessageProbe::*;

    /// Scripted answers, consumed in call order; records every call so a test
    /// can pin what was (and wasn't) asked.
    #[derive(Default)]
    struct Script {
        webhook: Mutex<VecDeque<MessageProbe>>,
        home: Mutex<VecDeque<HookHome>>,
        bot: Mutex<VecDeque<MessageProbe>>,
        calls: Mutex<Vec<String>>,
    }

    impl Script {
        fn new(webhook: &[MessageProbe], home: &[HookHome], bot: &[MessageProbe]) -> Self {
            Script {
                webhook: Mutex::new(webhook.iter().copied().collect()),
                home: Mutex::new(home.iter().cloned().collect()),
                bot: Mutex::new(bot.iter().copied().collect()),
                calls: Mutex::new(Vec::new()),
            }
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Prober for Script {
        async fn webhook_message(
            &self,
            _hook: &(String, String),
            message_id: &str,
            thread_id: Option<&str>,
        ) -> MessageProbe {
            self.calls
                .lock()
                .unwrap()
                .push(format!("hook {message_id} in {}", thread_id.unwrap_or("-")));
            self.webhook
                .lock()
                .unwrap()
                .pop_front()
                .expect("unscripted webhook read")
        }
        async fn webhook_home(&self, _hook: &(String, String)) -> HookHome {
            self.calls.lock().unwrap().push("home".into());
            self.home
                .lock()
                .unwrap()
                .pop_front()
                .expect("unscripted home read")
        }
        async fn channel_message(&self, channel_id: &str, message_id: &str) -> MessageProbe {
            self.calls
                .lock()
                .unwrap()
                .push(format!("bot {message_id} in {channel_id}"));
            self.bot
                .lock()
                .unwrap()
                .pop_front()
                .expect("unscripted bot read")
        }
    }

    fn row(channel: Option<&str>, thread: Option<&str>) -> CheckRow {
        CheckRow {
            id: "AAAAAAAAAA".into(),
            message_id: "900".into(),
            channel_id: channel.map(str::to_string),
            thread_id: thread.map(str::to_string),
            webhook_sealed: None,
            application_id: None,
        }
    }

    const URL: &str = "https://discord.com/api/webhooks/123456789012345678/tok";

    fn target(channel: Option<&str>, thread: Option<&str>) -> Target {
        Target::from_row("1", &row(channel, thread), Some(URL))
    }

    fn home(c: &str) -> HookHome {
        HookHome::Channel(c.into())
    }

    async fn run(t: &Target, s: &Script, bot: bool) -> Verdict {
        verdict(s, t, bot).await
    }

    #[test]
    fn a_target_knows_its_thread_and_the_channel_the_webhook_posted_into() {
        let t = target(Some("100"), None);
        assert_eq!(
            (t.thread_id.as_deref(), t.parent_id.as_deref()),
            (None, Some("100"))
        );
        assert_eq!(t.hook, Some(("123456789012345678".into(), "tok".into())));
        let t = target(Some("100"), Some("555"));
        assert_eq!(
            (t.thread_id.as_deref(), t.parent_id.as_deref()),
            (Some("555"), Some("100"))
        );
        // A row whose channel is the thread itself has no known parent.
        let t = target(Some("555"), Some("555"));
        assert_eq!((t.thread_id.as_deref(), t.parent_id), (Some("555"), None));
        // A scheduled forum post records the new thread as its channel, and
        // that thread's id is the message's.
        let t = target(Some("900"), None);
        assert_eq!((t.thread_id.as_deref(), t.parent_id), (Some("900"), None));
        assert_eq!(
            Target::from_row("1", &row(Some("100"), None), None).hook,
            None
        );
    }

    #[tokio::test]
    async fn a_live_message_costs_one_read() {
        let s = Script::new(&[Exists], &[], &[]);
        assert_eq!(
            run(&target(Some("100"), None), &s, true).await,
            Verdict::Exists
        );
        assert_eq!(s.calls(), ["hook 900 in -"]);
    }

    #[tokio::test]
    async fn a_message_deleted_from_its_channel_is_confirmed_before_removal() {
        let s = Script::new(
            &[UnknownMessage, UnknownMessage, UnknownChannel],
            &[home("100")],
            &[],
        );
        assert_eq!(
            run(&target(Some("100"), None), &s, false).await,
            Verdict::Deleted
        );
        assert_eq!(
            s.calls(),
            ["hook 900 in -", "home", "hook 900 in -", "hook 900 in 900"]
        );
    }

    #[tokio::test]
    async fn a_moved_webhook_proves_nothing_and_the_bot_settles_it() {
        // The webhook now lives in channel 200, so its "unknown message" is
        // about the wrong channel. The bot finds the message where it was.
        let s = Script::new(&[UnknownMessage], &[home("200")], &[Exists]);
        assert_eq!(
            run(&target(Some("100"), None), &s, true).await,
            Verdict::Exists
        );
        assert_eq!(s.calls(), ["hook 900 in -", "home", "bot 900 in 100"]);
        // Without the bot in the server, it stays.
        let s = Script::new(&[UnknownMessage], &[home("200")], &[]);
        assert_eq!(
            run(&target(Some("100"), None), &s, false).await,
            Verdict::Unknown
        );
    }

    #[tokio::test]
    async fn a_forum_post_recorded_without_its_thread_is_found_in_it() {
        let s = Script::new(
            &[UnknownMessage, UnknownMessage, Exists],
            &[home("100")],
            &[],
        );
        assert_eq!(
            run(&target(Some("100"), None), &s, false).await,
            Verdict::Exists
        );
    }

    #[tokio::test]
    async fn the_message_reappearing_on_the_second_read_keeps_it() {
        let s = Script::new(&[UnknownMessage, Exists], &[home("100")], &[]);
        assert_eq!(
            run(&target(Some("100"), None), &s, false).await,
            Verdict::Exists
        );
    }

    #[tokio::test]
    async fn a_thread_message_missing_from_its_thread_is_deleted() {
        let s = Script::new(&[UnknownMessage, UnknownMessage], &[home("100")], &[]);
        assert_eq!(
            run(&target(Some("100"), Some("555")), &s, false).await,
            Verdict::Deleted
        );
        assert_eq!(s.calls(), ["hook 900 in 555", "home", "hook 900 in 555"]);
        // Parent not on record: a webhook DWEEB never moves is believed…
        let s = Script::new(&[UnknownMessage, UnknownMessage], &[], &[]);
        assert_eq!(
            run(&target(Some("555"), Some("555")), &s, false).await,
            Verdict::Deleted
        );
        // …a custom bot's roaming one is not.
        let mut t = target(Some("555"), Some("555"));
        t.application_id = Some("777".into());
        let s = Script::new(&[UnknownMessage], &[], &[]);
        assert_eq!(run(&t, &s, false).await, Verdict::Unknown);
    }

    #[tokio::test]
    async fn a_custom_bots_roaming_webhook_is_confirmed_under_its_lock() {
        let mut t = target(Some("100"), None);
        t.application_id = Some("777".into());
        // It has moved on to another channel since: no verdict from it.
        let s = Script::new(&[UnknownMessage], &[home("200")], &[]);
        assert_eq!(run(&t, &s, false).await, Verdict::Unknown);
        // Still (or back) where the message was posted: confirmed.
        let s = Script::new(
            &[UnknownMessage, UnknownMessage, UnknownChannel],
            &[home("100")],
            &[],
        );
        assert_eq!(run(&t, &s, false).await, Verdict::Deleted);
    }

    #[tokio::test]
    async fn a_missing_thread_is_only_believed_from_the_bot() {
        // Unknown Channel for a named thread may just mean the webhook moved.
        let s = Script::new(&[UnknownChannel], &[], &[]);
        assert_eq!(
            run(&target(Some("100"), Some("555")), &s, false).await,
            Verdict::Unknown
        );
        let s = Script::new(&[UnknownChannel], &[], &[UnknownChannel]);
        assert_eq!(
            run(&target(Some("100"), Some("555")), &s, true).await,
            Verdict::Deleted
        );
        assert_eq!(s.calls(), ["hook 900 in 555", "bot 900 in 555"]);
    }

    #[tokio::test]
    async fn a_deleted_webhook_hands_over_to_the_bot() {
        // The channel was deleted, taking its webhooks with it.
        let s = Script::new(&[UnknownWebhook], &[], &[UnknownChannel]);
        assert_eq!(
            run(&target(Some("100"), None), &s, true).await,
            Verdict::Deleted
        );
        // The webhook was deleted on its own; the message is still there.
        let s = Script::new(&[UnknownWebhook], &[], &[Exists]);
        assert_eq!(
            run(&target(Some("100"), None), &s, true).await,
            Verdict::Exists
        );
    }

    #[tokio::test]
    async fn the_bot_checks_a_threadless_miss_for_a_forum_post_too() {
        let s = Script::new(&[UnknownWebhook], &[], &[UnknownMessage, Exists]);
        assert_eq!(
            run(&target(Some("100"), None), &s, true).await,
            Verdict::Exists
        );
        assert_eq!(
            s.calls(),
            ["hook 900 in -", "bot 900 in 100", "bot 900 in 900"]
        );
        let s = Script::new(&[UnknownWebhook], &[], &[UnknownMessage, UnknownChannel]);
        assert_eq!(
            run(&target(Some("100"), None), &s, true).await,
            Verdict::Deleted
        );
    }

    #[tokio::test]
    async fn nothing_short_of_discords_answer_removes_a_row() {
        // Rate limits, outages and refusals at every step keep the row.
        let s = Script::new(&[Inconclusive], &[], &[]);
        assert_eq!(
            run(&target(Some("100"), None), &s, true).await,
            Verdict::Unknown
        );
        let s = Script::new(&[UnknownMessage], &[HookHome::Unknown], &[]);
        assert_eq!(
            run(&target(Some("100"), None), &s, true).await,
            Verdict::Unknown
        );
        let s = Script::new(&[UnknownMessage, Inconclusive], &[home("100")], &[]);
        assert_eq!(
            run(&target(Some("100"), None), &s, true).await,
            Verdict::Unknown
        );
        let s = Script::new(
            &[UnknownMessage, UnknownMessage, Inconclusive],
            &[home("100")],
            &[Inconclusive],
        );
        assert_eq!(
            run(&target(Some("100"), None), &s, true).await,
            Verdict::Unknown
        );
        let s = Script::new(&[UnknownWebhook], &[], &[Inconclusive]);
        assert_eq!(
            run(&target(Some("100"), None), &s, true).await,
            Verdict::Unknown
        );
        // A row naming no channel at all gives the bot nowhere to look.
        let s = Script::new(&[UnknownWebhook], &[], &[]);
        assert_eq!(run(&target(None, None), &s, true).await, Verdict::Unknown);
        // No parent channel on record: the webhook's miss can't be pinned to
        // where the message was posted.
        let s = Script::new(&[UnknownMessage], &[], &[]);
        assert_eq!(run(&target(None, None), &s, false).await, Verdict::Unknown);
    }

    #[tokio::test]
    async fn without_a_webhook_only_the_bot_is_asked() {
        let t = Target::from_row("1", &row(Some("100"), Some("555")), None);
        let s = Script::new(&[], &[], &[UnknownMessage]);
        assert_eq!(verdict(&s, &t, true).await, Verdict::Deleted);
        let s = Script::new(&[], &[], &[]);
        assert_eq!(verdict(&s, &t, false).await, Verdict::Unknown);
        assert!(s.calls().is_empty());
    }
}
