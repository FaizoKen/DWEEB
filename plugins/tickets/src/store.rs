//! SQLite-backed store.
//!
//! Three tables, one file:
//!   • `instances` — one JSON config blob per panel, keyed by a 128-bit random
//!     token that lives inside the component's `custom_id`. That id is the
//!     *capability* to read/replace this panel's config, so it must stay
//!     unguessable. The shared bot does all the Discord work, so no secret is
//!     stored per instance and reads need no masking (see [`MaskedInstance`]).
//!   • `tickets` — one row per opened ticket, keyed by its channel id. This is
//!     also the anti-spam ledger: the open-count and cooldown checks are pure
//!     queries over it (no separate table to keep in sync).
//!   • `counters` — a monotonic per-instance ticket number, so channels read
//!     `ticket-0001`, `ticket-0002`, … even after restarts.

use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Topic {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
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
    /// Best-effort HTML transcript posted to the log channel on close.
    #[serde(default = "default_true")]
    pub transcripts: bool,

    /// Most open tickets one member may hold from this panel at once. 0 ⇒ no cap.
    #[serde(default = "default_max_open")]
    pub max_open_per_user: u32,
    /// Seconds a member must wait between opening tickets. 0 ⇒ no cooldown.
    #[serde(default = "default_cooldown")]
    pub cooldown_secs: u32,

    #[serde(default)]
    pub response: ResponseDef,
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

/// Lifecycle state of a ticket. `"open"` and `"locked"` both count as "in use"
/// for the per-user open cap; a deleted channel's row is kept as `"closed"` —
/// it no longer counts against the cap, but it stays in the ledger so the open
/// cooldown can't be reset by closing a ticket.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ticket {
    pub channel_id: String,
    pub instance_id: String,
    pub guild_id: String,
    pub number: i64,
    pub opener_id: String,
    #[serde(default)]
    pub topic: String,
    #[serde(default)]
    pub claimed_by: Option<String>,
    pub status: String,
    pub created_at: i64,
}

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &str) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS instances (
                 id          TEXT PRIMARY KEY,
                 created_at  INTEGER NOT NULL,
                 config      TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS tickets (
                 channel_id  TEXT PRIMARY KEY,
                 instance_id TEXT NOT NULL,
                 guild_id    TEXT NOT NULL,
                 number      INTEGER NOT NULL,
                 opener_id   TEXT NOT NULL,
                 topic       TEXT NOT NULL DEFAULT '',
                 claimed_by  TEXT,
                 status      TEXT NOT NULL DEFAULT 'open',
                 created_at  INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS tickets_by_opener
                 ON tickets (instance_id, opener_id, status);
             CREATE TABLE IF NOT EXISTS counters (
                 instance_id TEXT PRIMARY KEY,
                 next_number INTEGER NOT NULL
             );",
        )?;
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

    pub fn create(&self, id: &str, config: &InstanceConfig) -> rusqlite::Result<()> {
        let json = serde_json::to_string(config).expect("serialize config");
        let now = unix_millis();
        let conn = self.lock();
        conn.execute(
            "INSERT INTO instances (id, created_at, config) VALUES (?1, ?2, ?3)",
            (id, now, json),
        )?;
        Ok(())
    }

    /// Replace an existing instance's config. Returns false if the id is unknown.
    pub fn update(&self, id: &str, config: &InstanceConfig) -> rusqlite::Result<bool> {
        let json = serde_json::to_string(config).expect("serialize config");
        let conn = self.lock();
        let n = conn.execute("UPDATE instances SET config = ?2 WHERE id = ?1", (id, json))?;
        Ok(n > 0)
    }

    pub fn get(&self, id: &str) -> rusqlite::Result<Option<InstanceConfig>> {
        let conn = self.lock();
        let row: Option<String> = conn
            .query_row("SELECT config FROM instances WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        Ok(match row {
            Some(json) => serde_json::from_str(&json).ok(),
            None => None,
        })
    }

    // ── ticket numbering ───────────────────────────────────────────────────────

    /// Allocate the next ticket number for an instance, monotonically. Runs under
    /// the single connection lock, so two concurrent opens can't collide on a
    /// number (the lock serializes the read-then-write).
    pub fn next_number(&self, instance_id: &str) -> rusqlite::Result<i64> {
        let conn = self.lock();
        let current: i64 = conn
            .query_row(
                "SELECT next_number FROM counters WHERE instance_id = ?1",
                [instance_id],
                |r| r.get(0),
            )
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(1),
                other => Err(other),
            })?;
        conn.execute(
            "INSERT INTO counters (instance_id, next_number) VALUES (?1, ?2)
             ON CONFLICT(instance_id) DO UPDATE SET next_number = ?2",
            (instance_id, current + 1),
        )?;
        Ok(current)
    }

    // ── tickets / anti-spam ledger ─────────────────────────────────────────────

    #[allow(clippy::too_many_arguments)]
    pub fn create_ticket(
        &self,
        channel_id: &str,
        instance_id: &str,
        guild_id: &str,
        number: i64,
        opener_id: &str,
        topic: &str,
    ) -> rusqlite::Result<()> {
        let now = unix_millis();
        let conn = self.lock();
        conn.execute(
            "INSERT INTO tickets
               (channel_id, instance_id, guild_id, number, opener_id, topic, claimed_by, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 'open', ?7)",
            (channel_id, instance_id, guild_id, number, opener_id, topic, now),
        )?;
        Ok(())
    }

    pub fn get_ticket(&self, channel_id: &str) -> rusqlite::Result<Option<Ticket>> {
        let conn = self.lock();
        conn.query_row(
            "SELECT channel_id, instance_id, guild_id, number, opener_id, topic, claimed_by, status, created_at
             FROM tickets WHERE channel_id = ?1",
            [channel_id],
            |r| {
                Ok(Ticket {
                    channel_id: r.get(0)?,
                    instance_id: r.get(1)?,
                    guild_id: r.get(2)?,
                    number: r.get(3)?,
                    opener_id: r.get(4)?,
                    topic: r.get(5)?,
                    claimed_by: r.get(6)?,
                    status: r.get(7)?,
                    created_at: r.get(8)?,
                })
            },
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
    }

    /// Record a claim. Returns false if the ticket row is gone.
    pub fn set_claim(&self, channel_id: &str, claimed_by: &str) -> rusqlite::Result<bool> {
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE tickets SET claimed_by = ?2 WHERE channel_id = ?1",
            (channel_id, claimed_by),
        )?;
        Ok(n > 0)
    }

    pub fn set_status(&self, channel_id: &str, status: &str) -> rusqlite::Result<bool> {
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE tickets SET status = ?2 WHERE channel_id = ?1",
            (channel_id, status),
        )?;
        Ok(n > 0)
    }

    /// How many tickets this member currently holds open (status open or locked)
    /// from this panel — the per-user cap is checked against this.
    pub fn count_open(&self, instance_id: &str, opener_id: &str) -> rusqlite::Result<i64> {
        let conn = self.lock();
        conn.query_row(
            "SELECT COUNT(*) FROM tickets
             WHERE instance_id = ?1 AND opener_id = ?2 AND status IN ('open','locked')",
            (instance_id, opener_id),
            |r| r.get(0),
        )
    }

    /// When this member last opened a ticket from this panel (millis), across all
    /// statuses — so opening then closing can't bypass the cooldown.
    pub fn last_open_at(
        &self,
        instance_id: &str,
        opener_id: &str,
    ) -> rusqlite::Result<Option<i64>> {
        let conn = self.lock();
        let v: Option<i64> = conn.query_row(
            "SELECT MAX(created_at) FROM tickets WHERE instance_id = ?1 AND opener_id = ?2",
            (instance_id, opener_id),
            |r| r.get(0),
        )?;
        Ok(v)
    }
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
        // An in-memory DB keeps the test hermetic (no temp file to clean up).
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE instances (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, config TEXT NOT NULL);
             CREATE TABLE tickets (channel_id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, guild_id TEXT NOT NULL,
                 number INTEGER NOT NULL, opener_id TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '',
                 claimed_by TEXT, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL);
             CREATE TABLE counters (instance_id TEXT PRIMARY KEY, next_number INTEGER NOT NULL);",
        )
        .unwrap();
        Store {
            conn: Mutex::new(conn),
        }
    }

    #[test]
    fn numbers_increment_per_instance() {
        let s = store();
        assert_eq!(s.next_number("a").unwrap(), 1);
        assert_eq!(s.next_number("a").unwrap(), 2);
        assert_eq!(s.next_number("a").unwrap(), 3);
        // A different panel has its own sequence.
        assert_eq!(s.next_number("b").unwrap(), 1);
    }

    #[test]
    fn open_count_tracks_status() {
        let s = store();
        s.create_ticket("c1", "i", "g", 1, "u", "").unwrap();
        s.create_ticket("c2", "i", "g", 2, "u", "").unwrap();
        assert_eq!(s.count_open("i", "u").unwrap(), 2);
        // Closing one drops the count; a locked one still counts.
        s.set_status("c1", "closed").unwrap();
        assert_eq!(s.count_open("i", "u").unwrap(), 1);
        s.set_status("c2", "locked").unwrap();
        assert_eq!(s.count_open("i", "u").unwrap(), 1);
        // A different opener is independent.
        assert_eq!(s.count_open("i", "other").unwrap(), 0);
    }

    #[test]
    fn claim_and_lookup_round_trip() {
        let s = store();
        s.create_ticket("c1", "i", "g", 7, "opener", "Billing")
            .unwrap();
        let t = s.get_ticket("c1").unwrap().unwrap();
        assert_eq!(t.number, 7);
        assert_eq!(t.opener_id, "opener");
        assert_eq!(t.topic, "Billing");
        assert!(t.claimed_by.is_none());
        assert!(s.set_claim("c1", "staff42").unwrap());
        assert_eq!(
            s.get_ticket("c1").unwrap().unwrap().claimed_by.as_deref(),
            Some("staff42")
        );
    }

    #[test]
    fn last_open_survives_close() {
        let s = store();
        s.create_ticket("c1", "i", "g", 1, "u", "").unwrap();
        s.set_status("c1", "closed").unwrap();
        // Cooldown must still see the most recent open even after it closed.
        assert!(s.last_open_at("i", "u").unwrap().is_some());
        assert!(s.last_open_at("i", "nobody").unwrap().is_none());
    }
}
