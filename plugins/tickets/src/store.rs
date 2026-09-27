//! SQLite-backed store.
//!
//! Three tables, one file:
//!   • `instances` — one JSON config blob per panel, keyed by the opaque id in
//!     the component's `custom_id`. That id is a **public binding** — every
//!     guild member who can see the message can read it — so it must never be
//!     edit authority: a separate random edit token (protocol v2) authorizes
//!     reconfiguration, and only its SHA-256 digest is stored. The shared bot
//!     does all the Discord work, so no secret is stored per instance and reads
//!     need no masking (see [`MaskedInstance`]).
//!   • `tickets` — one row per ticket, keyed by its channel id. This is also the
//!     anti-spam ledger: the open cap and the cooldown are read from it.
//!   • `counters` — a monotonic per-instance ticket number, so channels read
//!     `ticket-0001`, `ticket-0002`, … even after restarts.
//!
//! ## The ticket lifecycle is a state machine, and every move is a CAS
//!
//! ```text
//!  pending ──▶ open ──▶ closing ──▶ closed          (close mode "delete")
//!                ▲         │
//!                │         └─────▶ locked ──▶ deleting ──▶ closed
//!                └── reopening ◀─────┘            (close mode "lock")
//! ```
//!
//! Clicks race: two staff press Close together, a stale Reopen button fires on
//! a ticket that was already reopened, a double-click opens two tickets. So no
//! flow reads a status and then acts on it — each claims its transition with a
//! single guarded write ([`Store::transition`], [`Store::reserve_open`]) and
//! only the winner proceeds. `closing`, `reopening` and `deleting` are held
//! only while the Discord work runs; a failure moves the ticket back, and
//! [`Store::recover_interrupted`] puts back anything a restart cut short — to
//! the state whose controls are still on screen (a flow retires the old
//! controls only after its new ones are posted), so the next click can simply
//! run the action again.

use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// One role that can see and work every ticket from this panel. `name`/`color`
/// are cached at save time so the config UI renders nicely without a live fetch;
/// the `id` is the only field that matters for the channel permission overwrite.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StaffRole {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Discord role colour as a 24-bit integer (0 = no colour). Cosmetic.
    #[serde(default)]
    pub color: u32,
}

/// One configurable intake question shown in a modal before the ticket opens.
/// Kept lean on purpose — a long form belongs inside the ticket, not in the
/// pop-up that gates it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntakeField {
    /// Stable id; becomes the text input's `custom_id` and keys the answer.
    /// Generated once in the config UI and preserved across reorders.
    pub id: String,
    pub label: String,
    /// `"short"` (single line) or `"paragraph"` (multi-line).
    pub style: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
}

/// One topic on a `string_select` panel. The select option's `value` is this
/// `id` (DWEEB wires + locks the options on save), so a click maps straight back
/// to the topic without trusting a client-supplied label.
///
/// A topic can also **route** its tickets: a category of its own, and staff
/// roles that see its tickets *in addition to* the panel's (a Billing team that
/// sees billing tickets and nothing else).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Topic {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Extra staff for this topic's tickets.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub staff_roles: Vec<StaffRole>,
    /// Category for this topic's tickets. None ⇒ the panel's category.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_id: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub category_name: String,
}

/// How the opener is acknowledged (ephemerally) the moment their ticket opens.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseDef {
    /// `"summary"` — auto "Opened your ticket: #channel". `"custom"` — the
    /// admin's own `text`.
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

impl Default for ResponseDef {
    fn default() -> Self {
        Self {
            mode: "summary".to_string(),
            text: None,
        }
    }
}

fn default_true() -> bool {
    true
}
fn default_welcome() -> String {
    "Hi {user}, thanks for reaching out — {staff} will be with you shortly.\n\nPlease describe your issue in as much detail as you can. Use the **Close** button below when you're done.".to_string()
}
fn default_naming() -> String {
    "number".to_string()
}
fn default_close_mode() -> String {
    "delete".to_string()
}
fn default_max_open() -> u32 {
    1
}
fn default_cooldown() -> u32 {
    30
}

/// The full, stored configuration for one panel.
///
/// New fields are additive with serde defaults so configs written by an older
/// build keep deserializing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceConfig {
    /// `"button"` or `"string_select"` — the component kind this binds to.
    pub target: String,
    /// The guild this panel belongs to. Cross-checked against the interaction's
    /// guild at click time so a panel can't be reused elsewhere.
    pub guild_id: String,
    #[serde(default)]
    pub guild_name: String,

    /// Roles that can see/answer every ticket (channel permission overwrite).
    #[serde(default)]
    pub staff_roles: Vec<StaffRole>,
    /// Category the ticket channels are created under. None ⇒ guild root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_id: Option<String>,
    #[serde(default)]
    pub category_name: String,
    /// Channel transcripts + open/close logs are posted to. None ⇒ no logging.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_channel_id: Option<String>,
    #[serde(default)]
    pub log_channel_name: String,

    /// `"number"` (ticket-0001) or `"username"` (ticket-ada).
    #[serde(default = "default_naming")]
    pub naming: String,
    /// Welcome message posted in the ticket. Supports {user} {username} {ticket}
    /// {topic} {staff} placeholders.
    #[serde(default = "default_welcome")]
    pub welcome: String,
    #[serde(default = "default_true")]
    pub ping_opener: bool,
    #[serde(default)]
    pub ping_staff: bool,

    /// 0–5 intake questions asked in a modal before the ticket opens. Empty ⇒
    /// the ticket opens straight away.
    #[serde(default)]
    pub intake: Vec<IntakeField>,
    /// `string_select` topics. Empty for a button panel.
    #[serde(default)]
    pub topics: Vec<Topic>,

    /// `"delete"` (remove the channel on close) or `"lock"` (rename, revoke the
    /// opener's access, keep it for the record with Reopen/Delete controls).
    #[serde(default = "default_close_mode")]
    pub close_mode: String,
    /// When true, closing first asks for an optional reason in a modal — doubles
    /// as a guard against an accidental one-click close.
    #[serde(default = "default_true")]
    pub close_confirmation: bool,
    /// Whether the ticket's opener may close it themselves (staff always can).
    #[serde(default = "default_true")]
    pub allow_opener_close: bool,
    /// Whether staff get a Claim button to take ownership of a ticket.
    #[serde(default = "default_true")]
    pub claim_enabled: bool,
    /// Best-effort HTML transcript filed on close.
    #[serde(default = "default_true")]
    pub transcripts: bool,
    /// Also DM the transcript to the ticket's opener (best-effort — members can
    /// have DMs from server members turned off).
    #[serde(default)]
    pub transcript_dm: bool,

    /// Most open tickets one member may hold from this panel at once. 0 ⇒ no cap.
    #[serde(default = "default_max_open")]
    pub max_open_per_user: u32,
    /// Seconds a member must wait between opening tickets. 0 ⇒ no cooldown.
    #[serde(default = "default_cooldown")]
    pub cooldown_secs: u32,

    #[serde(default)]
    pub response: ResponseDef,
}

impl InstanceConfig {
    /// The topic a ticket was opened under, if it still exists in the config.
    pub fn topic(&self, id: &str) -> Option<&Topic> {
        if id.is_empty() {
            return None;
        }
        self.topics.iter().find(|t| t.id == id)
    }
}

/// A read view for the config UI. Carries the instance `id` (which
/// [`InstanceConfig`] itself doesn't) and holds no secrets — the bot token is
/// the deployment-wide shared one, so nothing here needs masking.
#[derive(Debug, Serialize)]
pub struct MaskedInstance {
    pub id: String,
    #[serde(flatten)]
    pub config: InstanceConfig,
}

/// Where a ticket is in its life — see the module docs for the diagram.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// A reserved slot: the member's open passed the anti-spam gate and the
    /// channel is being created. Counts as in flight, never as a ticket.
    Pending,
    Open,
    /// A close is running (transcript, delete or lock).
    Closing,
    /// Closed in "lock" mode: the channel is kept, read-only for the opener.
    Locked,
    /// A locked ticket is being reopened (access restored, controls posted).
    Reopening,
    /// A locked ticket's channel is being deleted.
    Deleting,
    /// Gone. The row stays: it is the cooldown's memory.
    Closed,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Pending => "pending",
            Status::Open => "open",
            Status::Closing => "closing",
            Status::Locked => "locked",
            Status::Reopening => "reopening",
            Status::Deleting => "deleting",
            Status::Closed => "closed",
        }
    }

    /// Unknown text reads as `Closed` — a row nothing can act on, which is the
    /// safe direction for a value this build doesn't understand.
    pub fn parse(s: &str) -> Status {
        match s {
            "pending" => Status::Pending,
            "open" => Status::Open,
            "closing" => Status::Closing,
            "locked" => Status::Locked,
            "reopening" => Status::Reopening,
            "deleting" => Status::Deleting,
            _ => Status::Closed,
        }
    }
}

/// One ticket row.
#[derive(Debug, Clone)]
pub struct Ticket {
    pub channel_id: String,
    pub instance_id: String,
    pub guild_id: String,
    pub number: i64,
    pub opener_id: String,
    /// The opener's display name when they opened it (records only).
    pub opener_name: String,
    /// The topic's label when it was opened (empty on a button panel).
    pub topic: String,
    /// The topic's id — how in-ticket actions find the topic's extra staff.
    pub topic_id: String,
    /// The channel's name as created, restored on reopen.
    pub channel_name: String,
    pub claimed_by: Option<String>,
    pub status: Status,
    pub created_at: i64,
    pub closed_at: Option<i64>,
    pub closed_by: Option<String>,
}

const TICKET_COLS: &str = "channel_id, instance_id, guild_id, number, opener_id, opener_name, \
     topic, topic_id, channel_name, claimed_by, status, created_at, closed_at, closed_by";

fn ticket_from_row(r: &Row) -> rusqlite::Result<Ticket> {
    Ok(Ticket {
        channel_id: r.get(0)?,
        instance_id: r.get(1)?,
        guild_id: r.get(2)?,
        number: r.get(3)?,
        opener_id: r.get(4)?,
        opener_name: r.get(5)?,
        topic: r.get(6)?,
        topic_id: r.get(7)?,
        channel_name: r.get(8)?,
        claimed_by: r.get(9)?,
        status: Status::parse(&r.get::<_, String>(10)?),
        created_at: r.get(11)?,
        closed_at: r.get(12)?,
        closed_by: r.get(13)?,
    })
}

/// A reservation older than this is stale — its open task is long dead (a
/// panic, a cancelled future) — and neither blocks the member nor counts.
/// Generous next to a real open, which takes a second or two even when Discord
/// makes it retry.
pub const PENDING_TTL_MS: i64 = 5 * 60 * 1000;

/// The anti-spam inputs for one member of one panel, read in the same
/// transaction that reserves their slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct OpenStats {
    /// Tickets they hold open (a closing one still counts — the close may fail).
    pub open: i64,
    /// Opens of theirs in flight right now.
    pub pending: i64,
    /// Their most recent open, including closed ones — the cooldown's anchor.
    pub last_open_ms: Option<i64>,
}

/// Everything a reservation records.
pub struct OpenRequest<'a> {
    pub instance_id: &'a str,
    pub guild_id: &'a str,
    pub opener_id: &'a str,
    pub opener_name: &'a str,
    pub topic: &'a str,
    pub topic_id: &'a str,
    pub now_ms: i64,
}

/// What [`Store::reserve_open`] decided.
#[derive(Debug, PartialEq, Eq)]
pub enum Reserve<G> {
    /// The member may open: `key` names the placeholder row until the channel
    /// exists ([`Store::activate`]) or the attempt is abandoned
    /// ([`Store::release`]); `number` is the ticket's number.
    Reserved { key: String, number: i64 },
    /// The gate said no; nothing was written.
    Denied(G),
}

/// A claim attempt's outcome.
#[derive(Debug, PartialEq, Eq)]
pub enum ClaimOutcome {
    Claimed,
    AlreadyClaimed(String),
    NotOpen(Status),
    Missing,
}

/// An unclaim attempt's outcome.
#[derive(Debug, PartialEq, Eq)]
pub enum UnclaimOutcome {
    Released,
    NotClaimed,
    /// Someone else holds the claim, and the actor may not override it.
    HeldBy(String),
    NotOpen(Status),
    Missing,
}

/// What [`Store::recover_interrupted`] put back at startup.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Recovery {
    pub dropped_reservations: usize,
    pub reopened: usize,
    pub relocked: usize,
}

/// Outcome of an edit-authorization check.
pub enum EditLookup {
    Authorized,
    Unknown,
    /// Wrong credential — or a migrated legacy row (null digest), which
    /// deliberately cannot be updated in place; the config UI then creates a
    /// replacement instance and rebinds the component.
    Forbidden,
}

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &str) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        init_schema(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Take the connection lock, shrugging off poisoning.
    ///
    /// The only thing that runs under this lock is `rusqlite` calls, which return
    /// errors rather than panicking — so the lock can't actually be poisoned
    /// today. Recovering anyway (instead of `unwrap()`) keeps one unlucky panic
    /// in a future caller from bricking every later DB op for the process's life.
    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    // ── instances ────────────────────────────────────────────────────────────

    /// Insert a new instance and store only the edit-token digest.
    pub fn create(
        &self,
        id: &str,
        edit_token: &str,
        config: &InstanceConfig,
    ) -> rusqlite::Result<()> {
        let json = serde_json::to_string(config).expect("serialize config");
        let token_hash = hash_edit_token(edit_token);
        let now = unix_millis();
        let conn = self.lock();
        conn.execute(
            "INSERT INTO instances (id, created_at, config, edit_token_hash)
             VALUES (?1, ?2, ?3, ?4)",
            (id, now, json, token_hash),
        )?;
        Ok(())
    }

    /// Check the separate edit credential for an id, without touching the config.
    pub fn authorize_edit(&self, id: &str, edit_token: &str) -> rusqlite::Result<EditLookup> {
        let conn = self.lock();
        let row: Option<Option<String>> = conn
            .query_row(
                "SELECT edit_token_hash FROM instances WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        drop(conn);
        Ok(match row {
            None => EditLookup::Unknown,
            Some(None) => EditLookup::Forbidden,
            Some(Some(hash)) if edit_token_matches(edit_token, &hash) => EditLookup::Authorized,
            Some(Some(_)) => EditLookup::Forbidden,
        })
    }

    /// Atomically replace only when the edit-token digest matches.
    pub fn update(
        &self,
        id: &str,
        edit_token: &str,
        config: &InstanceConfig,
    ) -> rusqlite::Result<bool> {
        let json = serde_json::to_string(config).expect("serialize config");
        let token_hash = hash_edit_token(edit_token);
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE instances SET config = ?2 WHERE id = ?1 AND edit_token_hash = ?3",
            (id, json, token_hash),
        )?;
        Ok(n > 0)
    }

    pub fn get(&self, id: &str) -> rusqlite::Result<Option<InstanceConfig>> {
        let conn = self.lock();
        let row: Option<String> = conn
            .query_row("SELECT config FROM instances WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .optional()?;
        drop(conn);
        Ok(match row {
            Some(json) => serde_json::from_str(&json).ok(),
            None => None,
        })
    }

    // ── opening: the anti-spam gate and the reservation, as one step ─────────

    /// Decide whether a member may open a ticket and, if so, hold their slot —
    /// in one transaction, so two clicks can never both pass the gate.
    ///
    /// `decide` is the pure gate (`discord::open_gate`), handed the member's
    /// stats as they stand inside the transaction. On `Allowed` a `pending`
    /// row is written (it counts as in flight, so a double-click's second open
    /// is refused) and the ticket number is allocated; anything else writes
    /// nothing. Stale reservations of this member's are swept first.
    pub fn reserve_open<G>(
        &self,
        req: &OpenRequest,
        decide: impl FnOnce(&OpenStats) -> Option<G>,
    ) -> rusqlite::Result<Reserve<G>> {
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "DELETE FROM tickets
             WHERE instance_id = ?1 AND opener_id = ?2 AND status = 'pending' AND created_at < ?3",
            (
                req.instance_id,
                req.opener_id,
                req.now_ms.saturating_sub(PENDING_TTL_MS),
            ),
        )?;
        let stats = open_stats(&tx, req.instance_id, req.opener_id)?;
        if let Some(denied) = decide(&stats) {
            return Ok(Reserve::Denied(denied));
        }
        let number = next_number(&tx, req.instance_id)?;
        let key = pending_key();
        tx.execute(
            "INSERT INTO tickets (channel_id, instance_id, guild_id, number, opener_id, opener_name,
                                  topic, topic_id, channel_name, claimed_by, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '', NULL, 'pending', ?9)",
            (
                &key,
                req.instance_id,
                req.guild_id,
                number,
                req.opener_id,
                req.opener_name,
                req.topic,
                req.topic_id,
                req.now_ms,
            ),
        )?;
        tx.commit()?;
        Ok(Reserve::Reserved { key, number })
    }

    /// The same stats, read without reserving — for the check that runs before
    /// an intake form is shown (a member who then abandons the form must not be
    /// left holding a slot).
    pub fn peek_open_stats(
        &self,
        instance_id: &str,
        opener_id: &str,
    ) -> rusqlite::Result<OpenStats> {
        let conn = self.lock();
        open_stats(&conn, instance_id, opener_id)
    }

    /// The channel exists: turn the reservation into the ticket. Written as
    /// "drop the placeholder, insert the ticket" in one transaction, so it
    /// records the ticket even if the placeholder was swept as stale meanwhile —
    /// the channel is real either way.
    pub fn activate(&self, key: &str, ticket: &Ticket) -> rusqlite::Result<()> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM tickets WHERE channel_id = ?1", [key])?;
        tx.execute(
            &format!(
                "INSERT OR REPLACE INTO tickets ({TICKET_COLS})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"
            ),
            rusqlite::params![
                ticket.channel_id,
                ticket.instance_id,
                ticket.guild_id,
                ticket.number,
                ticket.opener_id,
                ticket.opener_name,
                ticket.topic,
                ticket.topic_id,
                ticket.channel_name,
                ticket.claimed_by,
                ticket.status.as_str(),
                ticket.created_at,
                ticket.closed_at,
                ticket.closed_by,
            ],
        )?;
        tx.commit()
    }

    /// Give up a reservation (the channel couldn't be created). Deleting it —
    /// rather than marking it closed — also lifts the cooldown it would have
    /// started: a failed open shouldn't make the member wait.
    pub fn release(&self, key: &str) -> rusqlite::Result<()> {
        let conn = self.lock();
        conn.execute(
            "DELETE FROM tickets WHERE channel_id = ?1 AND status = 'pending'",
            [key],
        )?;
        Ok(())
    }

    /// Forget a ticket entirely — the open was rolled back after its channel
    /// was created (the welcome couldn't be posted, so the channel was deleted).
    pub fn discard(&self, channel_id: &str) -> rusqlite::Result<()> {
        let conn = self.lock();
        conn.execute("DELETE FROM tickets WHERE channel_id = ?1", [channel_id])?;
        Ok(())
    }

    /// A member's tickets that still count as open, oldest first.
    pub fn open_tickets_of(
        &self,
        instance_id: &str,
        opener_id: &str,
    ) -> rusqlite::Result<Vec<Ticket>> {
        let conn = self.lock();
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT {TICKET_COLS} FROM tickets
             WHERE instance_id = ?1 AND opener_id = ?2 AND status IN ('open', 'closing', 'reopening')
             ORDER BY created_at"
        ))?;
        let rows = stmt.query_map((instance_id, opener_id), ticket_from_row)?;
        rows.collect()
    }

    /// The ticket's channel is gone — deleted by hand, or with the server —
    /// so the ledger stops counting it. Only a live row moves; the open cap
    /// would otherwise hold its member at the limit forever.
    pub fn mark_vanished(&self, channel_id: &str, now_ms: i64) -> rusqlite::Result<bool> {
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE tickets SET status = 'closed', closed_at = ?2
             WHERE channel_id = ?1 AND status IN ('open', 'closing', 'locked', 'reopening', 'deleting')",
            (channel_id, now_ms),
        )?;
        Ok(n > 0)
    }

    // ── the lifecycle ─────────────────────────────────────────────────────────

    pub fn get_ticket(&self, channel_id: &str) -> rusqlite::Result<Option<Ticket>> {
        let conn = self.lock();
        conn.query_row(
            &format!("SELECT {TICKET_COLS} FROM tickets WHERE channel_id = ?1"),
            [channel_id],
            ticket_from_row,
        )
        .optional()
    }

    /// Move a ticket to `to` if — and only if — it is currently in one of
    /// `from`. Returns the ticket as it was *before* the move when this call
    /// won, and `None` when it didn't (another click got there first, or the
    /// ticket is gone). The `WHERE status = …` guard is what makes it a CAS.
    pub fn transition(
        &self,
        channel_id: &str,
        from: &[Status],
        to: Status,
    ) -> rusqlite::Result<Option<Ticket>> {
        let conn = self.lock();
        let Some(ticket) = conn
            .query_row(
                &format!("SELECT {TICKET_COLS} FROM tickets WHERE channel_id = ?1"),
                [channel_id],
                ticket_from_row,
            )
            .optional()?
        else {
            return Ok(None);
        };
        if !from.contains(&ticket.status) {
            return Ok(None);
        }
        let n = conn.execute(
            "UPDATE tickets SET status = ?3 WHERE channel_id = ?1 AND status = ?2",
            (channel_id, ticket.status.as_str(), to.as_str()),
        )?;
        Ok((n > 0).then_some(ticket))
    }

    /// Finish a close that won its transition: `closing` → `to` (locked or
    /// closed), recording who closed it and when.
    pub fn finish_close(
        &self,
        channel_id: &str,
        from: Status,
        to: Status,
        closed_by: &str,
        now_ms: i64,
    ) -> rusqlite::Result<bool> {
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE tickets SET status = ?3, closed_by = ?4, closed_at = ?5
             WHERE channel_id = ?1 AND status = ?2",
            (channel_id, from.as_str(), to.as_str(), closed_by, now_ms),
        )?;
        Ok(n > 0)
    }

    /// Record a claim — only on an open, unclaimed ticket, so two staff pressing
    /// Claim together can't both think they own it.
    pub fn claim(&self, channel_id: &str, claimer: &str) -> rusqlite::Result<ClaimOutcome> {
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE tickets SET claimed_by = ?2
             WHERE channel_id = ?1 AND status = 'open' AND claimed_by IS NULL",
            (channel_id, claimer),
        )?;
        if n > 0 {
            return Ok(ClaimOutcome::Claimed);
        }
        let row: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT status, claimed_by FROM tickets WHERE channel_id = ?1",
                [channel_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(match row {
            None => ClaimOutcome::Missing,
            Some((status, _)) if Status::parse(&status) != Status::Open => {
                ClaimOutcome::NotOpen(Status::parse(&status))
            }
            Some((_, Some(by))) => ClaimOutcome::AlreadyClaimed(by),
            // Open and unclaimed, yet the guarded write matched nothing. The
            // write and this read share one lock, so nothing can change the row
            // between them — this arm is unreachable; it answers "gone" rather
            // than claiming a success that didn't happen.
            Some((_, None)) => ClaimOutcome::Missing,
        })
    }

    /// Release a claim. The claimer can always let go; `override_any` (a
    /// server manager) may release anyone's.
    pub fn unclaim(
        &self,
        channel_id: &str,
        actor: &str,
        override_any: bool,
    ) -> rusqlite::Result<UnclaimOutcome> {
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE tickets SET claimed_by = NULL
             WHERE channel_id = ?1 AND status = 'open' AND claimed_by IS NOT NULL
               AND (claimed_by = ?2 OR ?3)",
            (channel_id, actor, override_any),
        )?;
        if n > 0 {
            return Ok(UnclaimOutcome::Released);
        }
        let row: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT status, claimed_by FROM tickets WHERE channel_id = ?1",
                [channel_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        Ok(match row {
            None => UnclaimOutcome::Missing,
            Some((status, _)) if Status::parse(&status) != Status::Open => {
                UnclaimOutcome::NotOpen(Status::parse(&status))
            }
            Some((_, None)) => UnclaimOutcome::NotClaimed,
            Some((_, Some(by))) => UnclaimOutcome::HeldBy(by),
        })
    }

    /// A panel's tickets that are still around (open, closing or locked),
    /// oldest first — the staff overview.
    pub fn active_tickets(&self, instance_id: &str, limit: usize) -> rusqlite::Result<Vec<Ticket>> {
        let conn = self.lock();
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT {TICKET_COLS} FROM tickets
             WHERE instance_id = ?1 AND status IN ('open', 'closing', 'locked', 'reopening', 'deleting')
             ORDER BY created_at LIMIT ?2"
        ))?;
        let rows = stmt.query_map((instance_id, limit as i64), ticket_from_row)?;
        rows.collect()
    }

    /// Put back whatever a restart interrupted. A `pending` reservation's open
    /// task died with the process (its channel may or may not exist; if it
    /// does, the reconcile pass or staff will find it). A `closing` ticket
    /// returns to `open`, and a `reopening` or `deleting` one to `locked` —
    /// the states whose buttons are still on the channel — so the next click
    /// simply runs the action again.
    pub fn recover_interrupted(&self) -> rusqlite::Result<Recovery> {
        let conn = self.lock();
        Ok(Recovery {
            dropped_reservations: conn
                .execute("DELETE FROM tickets WHERE status = 'pending'", [])?,
            reopened: conn.execute(
                "UPDATE tickets SET status = 'open' WHERE status = 'closing'",
                [],
            )?,
            relocked: conn.execute(
                "UPDATE tickets SET status = 'locked' WHERE status IN ('deleting', 'reopening')",
                [],
            )?,
        })
    }
}

/// The anti-spam inputs for one member, inside whatever transaction the caller
/// holds. Stale reservations count toward neither the cap nor in-flight.
fn open_stats(
    conn: &Connection,
    instance_id: &str,
    opener_id: &str,
) -> rusqlite::Result<OpenStats> {
    let stale_before = unix_millis().saturating_sub(PENDING_TTL_MS);
    conn.query_row(
        "SELECT
             COALESCE(SUM(CASE WHEN status IN ('open', 'closing', 'reopening') THEN 1 ELSE 0 END), 0),
             COALESCE(SUM(CASE WHEN status = 'pending' AND created_at >= ?3 THEN 1 ELSE 0 END), 0),
             MAX(created_at)
         FROM tickets WHERE instance_id = ?1 AND opener_id = ?2",
        (instance_id, opener_id, stale_before),
        |r| {
            Ok(OpenStats {
                open: r.get(0)?,
                pending: r.get(1)?,
                last_open_ms: r.get(2)?,
            })
        },
    )
}

/// Allocate the next ticket number for an instance monotonically: one
/// UPSERT+RETURNING, indivisible even if the store is pooled later.
fn next_number(conn: &Connection, instance_id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "INSERT INTO counters (instance_id, next_number) VALUES (?1, 2)
         ON CONFLICT(instance_id) DO UPDATE
         SET next_number = counters.next_number + 1
         RETURNING next_number - 1",
        [instance_id],
        |r| r.get(0),
    )
}

/// A placeholder primary key for a reservation. The `pending:` prefix can
/// never collide with a real channel id, which is all digits.
fn pending_key() -> String {
    let mut bytes = [0u8; 12];
    getrandom::getrandom(&mut bytes).expect("CSPRNG unavailable");
    format!("pending:{}", hex::encode(bytes))
}

fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 5000;
         CREATE TABLE IF NOT EXISTS instances (
             id              TEXT PRIMARY KEY,
             created_at      INTEGER NOT NULL,
             config          TEXT NOT NULL,
             edit_token_hash TEXT
         );
         CREATE TABLE IF NOT EXISTS tickets (
             channel_id   TEXT PRIMARY KEY,
             instance_id  TEXT NOT NULL,
             guild_id     TEXT NOT NULL,
             number       INTEGER NOT NULL,
             opener_id    TEXT NOT NULL,
             topic        TEXT NOT NULL DEFAULT '',
             claimed_by   TEXT,
             status       TEXT NOT NULL DEFAULT 'open',
             created_at   INTEGER NOT NULL,
             opener_name  TEXT NOT NULL DEFAULT '',
             topic_id     TEXT NOT NULL DEFAULT '',
             channel_name TEXT NOT NULL DEFAULT '',
             closed_at    INTEGER,
             closed_by    TEXT
         );
         CREATE INDEX IF NOT EXISTS tickets_by_opener
             ON tickets (instance_id, opener_id, status);
         CREATE TABLE IF NOT EXISTS counters (
             instance_id TEXT PRIMARY KEY,
             next_number INTEGER NOT NULL
         );",
    )?;
    // Migration for databases created before the edit-token column. Legacy rows
    // keep a null digest, which `authorize_edit` reports as Forbidden.
    ensure_column(conn, "instances", "edit_token_hash", "TEXT")?;
    // Columns added in 0.3. Existing tickets read as "no topic id, name
    // unknown" — they keep panel-level staff and fall back to numbered names.
    ensure_column(conn, "tickets", "opener_name", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "tickets", "topic_id", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "tickets", "channel_name", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(conn, "tickets", "closed_at", "INTEGER")?;
    ensure_column(conn, "tickets", "closed_by", "TEXT")?;
    Ok(())
}

fn ensure_column(conn: &Connection, table: &str, column: &str, decl: &str) -> rusqlite::Result<()> {
    if !has_column(conn, table, column)? {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"),
            [],
        )?;
    }
    Ok(())
}

fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for name in names {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn hash_edit_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn edit_token_matches(token: &str, stored_hash: &str) -> bool {
    let candidate = Sha256::digest(token.as_bytes());
    let mut stored = [0u8; 32];
    if hex::decode_to_slice(stored_hash, &mut stored).is_err() {
        return false;
    }
    candidate
        .iter()
        .zip(stored.iter())
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

pub fn unix_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        // In-memory keeps the test hermetic; `open` runs the real schema.
        Store::open(":memory:").unwrap()
    }

    fn req<'a>(instance: &'a str, opener: &'a str, now_ms: i64) -> OpenRequest<'a> {
        OpenRequest {
            instance_id: instance,
            guild_id: "g",
            opener_id: opener,
            opener_name: "Ada",
            topic: "Billing",
            topic_id: "t1",
            now_ms,
        }
    }

    /// A gate that allows when the member has nothing open or in flight.
    fn one_at_a_time(s: &OpenStats) -> Option<&'static str> {
        if s.pending > 0 {
            Some("in flight")
        } else if s.open >= 1 {
            Some("at limit")
        } else {
            None
        }
    }

    /// Reserve and activate in one go — a ticket that opened.
    fn open_ticket(s: &Store, instance: &str, opener: &str, channel: &str) -> Ticket {
        let Reserve::Reserved { key, number } = s
            .reserve_open(&req(instance, opener, unix_millis()), |_| None::<()>)
            .unwrap()
        else {
            panic!("expected a reservation");
        };
        let t = Ticket {
            channel_id: channel.into(),
            instance_id: instance.into(),
            guild_id: "g".into(),
            number,
            opener_id: opener.into(),
            opener_name: "Ada".into(),
            topic: "Billing".into(),
            topic_id: "t1".into(),
            channel_name: format!("ticket-{number:04}"),
            claimed_by: None,
            status: Status::Open,
            created_at: unix_millis(),
            closed_at: None,
            closed_by: None,
        };
        s.activate(&key, &t).unwrap();
        t
    }

    #[test]
    fn numbers_increment_per_instance() {
        let s = store();
        assert_eq!(open_ticket(&s, "a", "u1", "1").number, 1);
        assert_eq!(open_ticket(&s, "a", "u2", "2").number, 2);
        assert_eq!(open_ticket(&s, "a", "u3", "3").number, 3);
        // A different panel has its own sequence.
        assert_eq!(open_ticket(&s, "b", "u1", "4").number, 1);
    }

    #[test]
    fn a_reservation_blocks_a_second_concurrent_open() {
        let s = store();
        let now = unix_millis();
        let first = s.reserve_open(&req("i", "u", now), one_at_a_time).unwrap();
        assert!(matches!(first, Reserve::Reserved { .. }));
        // The double-click: the first open's channel doesn't exist yet, and
        // it is still refused.
        assert_eq!(
            s.reserve_open(&req("i", "u", now), one_at_a_time).unwrap(),
            Reserve::Denied("in flight")
        );
        // Someone else is unaffected.
        assert!(matches!(
            s.reserve_open(&req("i", "other", now), one_at_a_time)
                .unwrap(),
            Reserve::Reserved { .. }
        ));
    }

    #[test]
    fn a_denied_reservation_writes_nothing() {
        let s = store();
        let denied = s
            .reserve_open(&req("i", "u", unix_millis()), |_| Some("no"))
            .unwrap();
        assert_eq!(denied, Reserve::Denied("no"));
        assert_eq!(s.peek_open_stats("i", "u").unwrap(), OpenStats::default());
    }

    #[test]
    fn released_reservations_leave_no_cooldown_behind() {
        let s = store();
        let Reserve::Reserved { key, .. } = s
            .reserve_open(&req("i", "u", unix_millis()), |_| None::<()>)
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(s.peek_open_stats("i", "u").unwrap().pending, 1);
        s.release(&key).unwrap();
        let stats = s.peek_open_stats("i", "u").unwrap();
        assert_eq!(stats.pending, 0);
        assert_eq!(stats.last_open_ms, None);
    }

    #[test]
    fn stale_reservations_neither_block_nor_linger() {
        let s = store();
        let long_ago = unix_millis() - PENDING_TTL_MS - 1_000;
        let stale = s
            .reserve_open(&req("i", "u", long_ago), |_| None::<()>)
            .unwrap();
        assert!(matches!(stale, Reserve::Reserved { .. }));
        // Not in flight any more…
        assert_eq!(s.peek_open_stats("i", "u").unwrap().pending, 0);
        // …and swept by the member's next reservation.
        assert!(matches!(
            s.reserve_open(&req("i", "u", unix_millis()), one_at_a_time)
                .unwrap(),
            Reserve::Reserved { .. }
        ));
    }

    #[test]
    fn open_count_ignores_locked_and_closed_tickets() {
        let s = store();
        open_ticket(&s, "i", "u", "c1");
        open_ticket(&s, "i", "u", "c2");
        assert_eq!(s.peek_open_stats("i", "u").unwrap().open, 2);
        // A closing ticket still counts — its close might fail.
        s.transition("c1", &[Status::Open], Status::Closing)
            .unwrap()
            .unwrap();
        assert_eq!(s.peek_open_stats("i", "u").unwrap().open, 2);
        // Locked is closed from the member's side: they may open a new one.
        assert!(s
            .finish_close("c1", Status::Closing, Status::Locked, "staff", 5)
            .unwrap());
        assert_eq!(s.peek_open_stats("i", "u").unwrap().open, 1);
        // Another opener is independent.
        assert_eq!(s.peek_open_stats("i", "other").unwrap().open, 0);
    }

    #[test]
    fn transitions_are_compare_and_swap() {
        let s = store();
        open_ticket(&s, "i", "u", "c1");
        // Two staff press Close together: exactly one wins.
        let first = s
            .transition("c1", &[Status::Open], Status::Closing)
            .unwrap();
        let second = s
            .transition("c1", &[Status::Open], Status::Closing)
            .unwrap();
        assert!(first.is_some());
        assert!(second.is_none());
        // A failed close goes back to open, and can be retried.
        assert!(s
            .transition("c1", &[Status::Closing], Status::Open)
            .unwrap()
            .is_some());
        assert!(s
            .transition("c1", &[Status::Open], Status::Closing)
            .unwrap()
            .is_some());
        // A stale Reopen on an open ticket does nothing.
        assert!(s
            .transition("c1", &[Status::Locked], Status::Open)
            .unwrap()
            .is_none());
        // Unknown channels never transition.
        assert!(s
            .transition("nope", &[Status::Open], Status::Closing)
            .unwrap()
            .is_none());
    }

    #[test]
    fn finish_close_records_who_and_when() {
        let s = store();
        open_ticket(&s, "i", "u", "c1");
        s.transition("c1", &[Status::Open], Status::Closing)
            .unwrap()
            .unwrap();
        assert!(s
            .finish_close("c1", Status::Closing, Status::Closed, "staff9", 1234)
            .unwrap());
        let t = s.get_ticket("c1").unwrap().unwrap();
        assert_eq!(t.status, Status::Closed);
        assert_eq!(t.closed_by.as_deref(), Some("staff9"));
        assert_eq!(t.closed_at, Some(1234));
        // The ledger keeps the row, so the cooldown survives the close.
        assert!(s.peek_open_stats("i", "u").unwrap().last_open_ms.is_some());
    }

    #[test]
    fn claims_are_exclusive_and_releasable() {
        let s = store();
        open_ticket(&s, "i", "u", "c1");
        assert_eq!(s.claim("c1", "a").unwrap(), ClaimOutcome::Claimed);
        assert_eq!(
            s.claim("c1", "b").unwrap(),
            ClaimOutcome::AlreadyClaimed("a".into())
        );
        // Only the claimer (or an override) may release it.
        assert_eq!(
            s.unclaim("c1", "b", false).unwrap(),
            UnclaimOutcome::HeldBy("a".into())
        );
        assert_eq!(
            s.unclaim("c1", "a", false).unwrap(),
            UnclaimOutcome::Released
        );
        assert_eq!(
            s.unclaim("c1", "a", false).unwrap(),
            UnclaimOutcome::NotClaimed
        );
        assert_eq!(s.claim("c1", "b").unwrap(), ClaimOutcome::Claimed);
        assert_eq!(
            s.unclaim("c1", "boss", true).unwrap(),
            UnclaimOutcome::Released
        );
        // Not while closing, and never on a ticket that doesn't exist.
        s.transition("c1", &[Status::Open], Status::Closing)
            .unwrap()
            .unwrap();
        assert_eq!(
            s.claim("c1", "a").unwrap(),
            ClaimOutcome::NotOpen(Status::Closing)
        );
        assert_eq!(s.claim("nope", "a").unwrap(), ClaimOutcome::Missing);
    }

    #[test]
    fn vanished_channels_stop_counting() {
        let s = store();
        open_ticket(&s, "i", "u", "c1");
        assert_eq!(s.open_tickets_of("i", "u").unwrap().len(), 1);
        assert!(s.mark_vanished("c1", 99).unwrap());
        assert!(s.open_tickets_of("i", "u").unwrap().is_empty());
        assert_eq!(s.peek_open_stats("i", "u").unwrap().open, 0);
        // Idempotent: a closed row stays closed.
        assert!(!s.mark_vanished("c1", 100).unwrap());
    }

    #[test]
    fn recovery_puts_interrupted_work_back() {
        let s = store();
        open_ticket(&s, "i", "u", "c1");
        open_ticket(&s, "i", "u2", "c2");
        s.transition("c1", &[Status::Open], Status::Closing)
            .unwrap()
            .unwrap();
        s.transition("c2", &[Status::Open], Status::Closing)
            .unwrap()
            .unwrap();
        s.finish_close("c2", Status::Closing, Status::Locked, "x", 1)
            .unwrap();
        s.transition("c2", &[Status::Locked], Status::Deleting)
            .unwrap()
            .unwrap();
        // An interrupted reopen: its new controls may not exist yet, but the
        // locked banner's Reopen does — so it goes back to locked.
        open_ticket(&s, "i", "u4", "c4");
        s.transition("c4", &[Status::Open], Status::Closing)
            .unwrap()
            .unwrap();
        s.finish_close("c4", Status::Closing, Status::Locked, "x", 1)
            .unwrap();
        s.transition("c4", &[Status::Locked], Status::Reopening)
            .unwrap()
            .unwrap();
        s.reserve_open(&req("i", "u3", unix_millis()), |_| None::<()>)
            .unwrap();

        let rec = s.recover_interrupted().unwrap();
        assert_eq!(
            rec,
            Recovery {
                dropped_reservations: 1,
                reopened: 1,
                relocked: 2
            }
        );
        assert_eq!(s.get_ticket("c1").unwrap().unwrap().status, Status::Open);
        assert_eq!(s.get_ticket("c2").unwrap().unwrap().status, Status::Locked);
        assert_eq!(s.get_ticket("c4").unwrap().unwrap().status, Status::Locked);
        assert_eq!(s.peek_open_stats("i", "u3").unwrap().pending, 0);
    }

    #[test]
    fn active_tickets_lists_open_and_locked_only() {
        let s = store();
        open_ticket(&s, "i", "u1", "c1");
        open_ticket(&s, "i", "u2", "c2");
        open_ticket(&s, "i", "u3", "c3");
        s.transition("c2", &[Status::Open], Status::Closing)
            .unwrap()
            .unwrap();
        s.finish_close("c2", Status::Closing, Status::Locked, "x", 1)
            .unwrap();
        s.mark_vanished("c3", 1).unwrap();
        let active = s.active_tickets("i", 10).unwrap();
        let ids: Vec<_> = active.iter().map(|t| t.channel_id.as_str()).collect();
        assert_eq!(ids, ["c1", "c2"]);
        assert_eq!(s.active_tickets("i", 1).unwrap().len(), 1);
    }

    #[test]
    fn unknown_status_text_reads_as_closed() {
        assert_eq!(Status::parse("archived"), Status::Closed);
        for s in [
            Status::Pending,
            Status::Open,
            Status::Closing,
            Status::Locked,
            Status::Reopening,
            Status::Deleting,
            Status::Closed,
        ] {
            assert_eq!(Status::parse(s.as_str()), s);
        }
    }

    const TOKEN: &str = "abababababababababababababababababababababababababababababababab";

    fn panel_config() -> InstanceConfig {
        serde_json::from_value(serde_json::json!({
            "target": "button",
            "guild_id": "123456789012345678",
            "welcome": "Hi {user}",
        }))
        .unwrap()
    }

    #[test]
    fn migrates_legacy_databases_in_place() {
        let conn = Connection::open_in_memory().unwrap();
        // The 0.2 schema, with a live ticket in it.
        conn.execute_batch(
            "CREATE TABLE instances (
                id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, config TEXT NOT NULL
             );
             INSERT INTO instances VALUES ('legacy', 1, '{}');
             CREATE TABLE tickets (channel_id TEXT PRIMARY KEY, instance_id TEXT NOT NULL,
                 guild_id TEXT NOT NULL, number INTEGER NOT NULL, opener_id TEXT NOT NULL,
                 topic TEXT NOT NULL DEFAULT '', claimed_by TEXT,
                 status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL);
             INSERT INTO tickets VALUES ('c1', 'i', 'g', 7, 'u', 'Billing', NULL, 'open', 1);",
        )
        .unwrap();
        init_schema(&conn).unwrap();
        assert!(has_column(&conn, "instances", "edit_token_hash").unwrap());
        let s = Store {
            conn: Mutex::new(conn),
        };
        // Legacy panels can't be edited in place…
        assert!(matches!(
            s.authorize_edit("legacy", TOKEN).unwrap(),
            EditLookup::Forbidden
        ));
        assert!(!s.update("legacy", TOKEN, &panel_config()).unwrap());
        // …and legacy tickets keep working, with the new columns defaulted.
        let t = s.get_ticket("c1").unwrap().unwrap();
        assert_eq!((t.number, t.status), (7, Status::Open));
        assert_eq!(t.channel_name, "");
        assert_eq!(t.topic_id, "");
        assert!(s
            .transition("c1", &[Status::Open], Status::Closing)
            .unwrap()
            .is_some());
    }

    #[test]
    fn stores_only_hash_and_requires_token_for_updates() {
        let s = store();
        s.create("one", TOKEN, &panel_config()).unwrap();
        let stored: String = s
            .lock()
            .query_row(
                "SELECT edit_token_hash FROM instances WHERE id = 'one'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, hash_edit_token(TOKEN));
        assert_ne!(stored, TOKEN);
        assert!(matches!(
            s.authorize_edit("one", "wrong").unwrap(),
            EditLookup::Forbidden
        ));
        assert!(matches!(
            s.authorize_edit("missing", TOKEN).unwrap(),
            EditLookup::Unknown
        ));
        assert!(!s.update("one", "wrong", &panel_config()).unwrap());
        assert!(s.update("one", TOKEN, &panel_config()).unwrap());
        assert!(s.get("one").unwrap().is_some());
    }

    #[test]
    fn old_configs_gain_the_new_fields_with_defaults() {
        let cfg: InstanceConfig = serde_json::from_value(serde_json::json!({
            "target": "string_select",
            "guild_id": "123456789012345678",
            "topics": [{ "id": "t1", "label": "Billing", "emoji": "🛒" }],
        }))
        .unwrap();
        assert!(!cfg.transcript_dm);
        let t = cfg.topic("t1").unwrap();
        assert!(t.staff_roles.is_empty());
        assert!(t.category_id.is_none());
        assert!(cfg.topic("").is_none());
        assert!(cfg.topic("zz").is_none());
    }
}
