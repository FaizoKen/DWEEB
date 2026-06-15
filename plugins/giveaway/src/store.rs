//! SQLite-backed store.
//!
//! Two tables. `instances` holds one JSON config blob per giveaway plus its
//! small mutable runtime state (status + drawn winners), keyed by a 128-bit
//! random token that lives inside the component's `custom_id` — that id is the
//! *capability* to read/replace this giveaway's config, so it must stay
//! unguessable. `entries` is the per-user ledger: one row per (giveaway, member)
//! enforces **one entry per person** structurally (a PRIMARY KEY), and is what
//! the draw reads and the live count counts.

use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// One role referenced by a giveaway — an entry-requirement role or a host role.
/// `name`/`color` are cached at save time purely so the config UI can render
/// nicely without a live Discord fetch; the `id` is the only field that matters
/// at click time (it's intersected with the member's roles from the payload).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleRef {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Discord role colour as a 24-bit integer (0 = no colour). Cosmetic.
    #[serde(default)]
    pub color: u32,
}

/// Who may enter. Empty/zero fields mean "no restriction"; the giveaway is open
/// to everyone by default.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Requirements {
    /// Roles gating entry. Empty = no role requirement.
    #[serde(default)]
    pub roles: Vec<RoleRef>,
    /// When true, a member must hold **all** of `roles`; otherwise **any one**.
    #[serde(default)]
    pub require_all: bool,
    /// Minimum Discord account age in days (0 = no minimum). Derived from the
    /// member's user-id snowflake at click time — no Discord call needed.
    #[serde(default)]
    pub min_account_age_days: u32,
}

/// The full, stored configuration for one giveaway.
///
/// New fields are additive with serde defaults so configs written by an older
/// build keep deserializing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceConfig {
    /// Always `"button"` — a giveaway's one action is "enter".
    #[serde(default = "default_target")]
    pub target: String,
    /// The guild this giveaway belongs to. Cross-checked against the
    /// interaction's guild at click time so role requirements resolve and a
    /// giveaway can't be silently reused in another server.
    pub guild_id: String,
    /// Cached guild name for the config UI. Cosmetic.
    #[serde(default)]
    pub guild_name: String,
    /// The prize, shown everywhere ("Win **a Nitro month**").
    pub prize: String,
    /// How many winners to draw. 1..=`MAX_WINNERS`.
    #[serde(default = "default_one")]
    pub winner_count: u32,
    /// Optional extra blurb shown under the prize.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Who's hosting, for a "Hosted by <@id>" line. Cosmetic.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_user_id: Option<String>,
    /// Optional entry deadline (unix **seconds**). Display-only as a live
    /// countdown, but it has teeth: once it passes, entries close (enforced at
    /// click time). There is no auto-draw — a host draws when ready.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<i64>,
    /// Who may enter.
    #[serde(default)]
    pub requirements: Requirements,
    /// Extra roles (besides Manage Server / Administrator holders) whose members
    /// get the host control panel. Empty = only server managers can draw.
    #[serde(default)]
    pub host_roles: Vec<RoleRef>,
    /// DM each winner when drawn. Best-effort, and only works when the shared
    /// bot token is configured; the UI disables the toggle otherwise.
    #[serde(default)]
    pub dm_winners: bool,
    /// Optional custom winner announcement. `{winners}` and `{prize}` are
    /// substituted; unknown placeholders are left as-is. None = a friendly
    /// default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub announcement: Option<String>,
}

fn default_target() -> String {
    "button".to_string()
}
fn default_one() -> u32 {
    1
}

/// A giveaway's lifecycle. `open` accepts entries; `ended` has had winners
/// drawn (it can still be rerolled); `cancelled` was called off with no winners.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Open,
    Ended,
    Cancelled,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Open => "open",
            Status::Ended => "ended",
            Status::Cancelled => "cancelled",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "ended" => Status::Ended,
            "cancelled" => Status::Cancelled,
            _ => Status::Open,
        }
    }
}

/// A giveaway as the store hands it back: its config plus mutable runtime state.
#[derive(Debug, Clone)]
pub struct Giveaway {
    pub config: InstanceConfig,
    pub status: Status,
    /// User ids of the currently-drawn winners (empty until a draw).
    pub winners: Vec<String>,
}

/// A read view for the config UI. Carries the instance `id`, the live entry
/// count, and the status — no secrets to mask (the giveaway holds no per-instance
/// token).
#[derive(Debug, Serialize)]
pub struct MaskedInstance {
    pub id: String,
    #[serde(flatten)]
    pub config: InstanceConfig,
    pub status: String,
    pub entries: i64,
    pub winners: Vec<String>,
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
                 config      TEXT NOT NULL,
                 status      TEXT NOT NULL DEFAULT 'open',
                 winners     TEXT NOT NULL DEFAULT '[]'
             );
             CREATE TABLE IF NOT EXISTS entries (
                 instance_id TEXT NOT NULL,
                 user_id     TEXT NOT NULL,
                 created_at  INTEGER NOT NULL,
                 PRIMARY KEY (instance_id, user_id)
             );",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Take the connection lock, shrugging off poisoning.
    ///
    /// The only thing that runs under this lock is a single `rusqlite` call,
    /// which returns errors rather than panicking — so the lock can't actually
    /// be poisoned today. Recovering anyway (instead of `unwrap()`) keeps one
    /// unlucky panic in a future caller from bricking every later DB op for the
    /// life of the process.
    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|poison| poison.into_inner())
    }

    /// Insert a new giveaway (status `open`, no winners) under a fresh id.
    pub fn create(&self, id: &str, config: &InstanceConfig) -> rusqlite::Result<()> {
        let json = serde_json::to_string(config).expect("serialize config");
        let now = unix_millis();
        let conn = self.lock();
        conn.execute(
            "INSERT INTO instances (id, created_at, config, status, winners) VALUES (?1, ?2, ?3, 'open', '[]')",
            (id, now, json),
        )?;
        Ok(())
    }

    /// Replace a giveaway's config (reconfigure). Leaves entries, status, and
    /// winners untouched. Returns false if the id is unknown.
    pub fn update_config(&self, id: &str, config: &InstanceConfig) -> rusqlite::Result<bool> {
        let json = serde_json::to_string(config).expect("serialize config");
        let conn = self.lock();
        let n = conn.execute("UPDATE instances SET config = ?2 WHERE id = ?1", (id, json))?;
        Ok(n > 0)
    }

    /// Load a giveaway (config + runtime state).
    pub fn get(&self, id: &str) -> rusqlite::Result<Option<Giveaway>> {
        let conn = self.lock();
        let row: Option<(String, String, String)> = conn
            .query_row(
                "SELECT config, status, winners FROM instances WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        Ok(row.and_then(|(config, status, winners)| {
            let config: InstanceConfig = serde_json::from_str(&config).ok()?;
            let winners: Vec<String> = serde_json::from_str(&winners).unwrap_or_default();
            Some(Giveaway {
                config,
                status: Status::parse(&status),
                winners,
            })
        }))
    }

    /// Record a member's entry. Returns true if this was a *new* entry (false if
    /// they were already in — `INSERT OR IGNORE` on the composite key makes a
    /// rapid double-click a harmless no-op).
    pub fn enter(&self, instance_id: &str, user_id: &str) -> rusqlite::Result<bool> {
        let now = unix_millis();
        let conn = self.lock();
        let n = conn.execute(
            "INSERT OR IGNORE INTO entries (instance_id, user_id, created_at) VALUES (?1, ?2, ?3)",
            (instance_id, user_id, now),
        )?;
        Ok(n > 0)
    }

    /// Withdraw a member's entry. Returns true if a row was actually removed.
    pub fn leave(&self, instance_id: &str, user_id: &str) -> rusqlite::Result<bool> {
        let conn = self.lock();
        let n = conn.execute(
            "DELETE FROM entries WHERE instance_id = ?1 AND user_id = ?2",
            (instance_id, user_id),
        )?;
        Ok(n > 0)
    }

    pub fn is_entered(&self, instance_id: &str, user_id: &str) -> rusqlite::Result<bool> {
        let conn = self.lock();
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM entries WHERE instance_id = ?1 AND user_id = ?2",
                (instance_id, user_id),
                |r| r.get(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        Ok(exists.is_some())
    }

    pub fn count_entries(&self, instance_id: &str) -> rusqlite::Result<i64> {
        let conn = self.lock();
        conn.query_row(
            "SELECT COUNT(*) FROM entries WHERE instance_id = ?1",
            [instance_id],
            |r| r.get(0),
        )
    }

    /// Every entrant's user id (the draw pool).
    pub fn list_entrants(&self, instance_id: &str) -> rusqlite::Result<Vec<String>> {
        let conn = self.lock();
        let mut stmt = conn.prepare("SELECT user_id FROM entries WHERE instance_id = ?1")?;
        let rows = stmt.query_map([instance_id], |r| r.get::<_, String>(0))?;
        rows.collect()
    }

    /// Mark a giveaway ended (or rerolled) with this winner set.
    pub fn set_winners(&self, instance_id: &str, winners: &[String]) -> rusqlite::Result<bool> {
        let json = serde_json::to_string(winners).expect("serialize winners");
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE instances SET status = 'ended', winners = ?2 WHERE id = ?1",
            (instance_id, json),
        )?;
        Ok(n > 0)
    }

    /// Mark a giveaway cancelled (called off, no winners).
    pub fn set_cancelled(&self, instance_id: &str) -> rusqlite::Result<bool> {
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE instances SET status = 'cancelled', winners = '[]' WHERE id = ?1",
            [instance_id],
        )?;
        Ok(n > 0)
    }
}

pub fn unix_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
