//! SQLite-backed store.
//!
//! Two tables. `instances` holds one JSON config blob per giveaway plus its
//! small mutable runtime state (status + drawn winners), keyed by the opaque id
//! in the component's `custom_id`. That id is a **public binding** — every
//! guild member who can see the message can read it — so it must never be edit
//! authority: a separate random edit token (protocol v2) authorizes
//! reconfiguration, and only its SHA-256 digest is stored. `entries` is the
//! per-user ledger: one row per (giveaway, member) enforces **one entry per
//! person** structurally (a PRIMARY KEY), and is what the draw reads and the
//! live count counts.

use std::{collections::HashSet, sync::Mutex};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

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
    /// The host's own message, captured as a Components V2 tree (a JSON array)
    /// with its raw `{token}` placeholders intact — the *template* this plugin
    /// re-renders on each click to keep the live count, winners and status
    /// current. None = no placeholders in play (older giveaway, or a message that
    /// uses none); the live count then falls back to restyling the button alone.
    /// Captured by the config iframe on save via the `message` editor resource.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_template: Option<Value>,
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
    /// The only thing that runs under this lock is a single `rusqlite` call,
    /// which returns errors rather than panicking — so the lock can't actually
    /// be poisoned today. Recovering anyway (instead of `unwrap()`) keeps one
    /// unlucky panic in a future caller from bricking every later DB op for the
    /// life of the process.
    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// Insert a new giveaway (status `open`, no winners) under a fresh id, and
    /// store only the edit-token digest.
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
            "INSERT INTO instances (id, created_at, config, status, winners, edit_token_hash)
             VALUES (?1, ?2, ?3, 'open', '[]', ?4)",
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
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        drop(conn);
        Ok(match row {
            None => EditLookup::Unknown,
            Some(None) => EditLookup::Forbidden,
            Some(Some(hash)) if edit_token_matches(edit_token, &hash) => EditLookup::Authorized,
            Some(Some(_)) => EditLookup::Forbidden,
        })
    }

    /// Replace a giveaway's config (reconfigure), only when the edit-token
    /// digest matches. Leaves entries, status, and winners untouched.
    pub fn update_config(
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
        drop(conn);
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

    /// Uniformly sample up to `limit` entrants without materialising the whole
    /// giveaway. Reservoir sampling keeps memory O(winner count), while the
    /// primary-key index lets SQLite stream the pool in one pass.
    pub fn sample_entrants(
        &self,
        instance_id: &str,
        excluded: &[String],
        limit: usize,
        mut pick: impl FnMut(usize) -> usize,
    ) -> rusqlite::Result<(Vec<String>, usize)> {
        let conn = self.lock();
        let mut stmt = conn.prepare_cached("SELECT user_id FROM entries WHERE instance_id = ?1")?;
        let rows = stmt.query_map([instance_id], |r| r.get::<_, String>(0))?;
        let excluded: HashSet<&str> = excluded.iter().map(String::as_str).collect();
        let mut sample = Vec::with_capacity(limit);
        let mut eligible = 0usize;
        for row in rows {
            let entrant = row?;
            if excluded.contains(entrant.as_str()) {
                continue;
            }
            eligible += 1;
            if sample.len() < limit {
                sample.push(entrant);
            } else if limit > 0 {
                let slot = pick(eligible) % eligible;
                if slot < limit {
                    sample[slot] = entrant;
                }
            }
        }
        Ok((sample, eligible))
    }

    /// Finish the first draw only while the giveaway is still open. The status
    /// predicate prevents concurrent host clicks announcing different winners.
    pub fn commit_draw(&self, instance_id: &str, winners: &[String]) -> rusqlite::Result<bool> {
        let json = serde_json::to_string(winners).expect("serialize winners");
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE instances SET status = 'ended', winners = ?2
             WHERE id = ?1 AND status = 'open'",
            (instance_id, json),
        )?;
        Ok(n > 0)
    }

    /// Replace winners only if nobody has rerolled the set this request loaded.
    pub fn commit_reroll(
        &self,
        instance_id: &str,
        previous: &[String],
        winners: &[String],
    ) -> rusqlite::Result<bool> {
        let previous_json = serde_json::to_string(previous).expect("serialize prior winners");
        let json = serde_json::to_string(winners).expect("serialize winners");
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE instances SET winners = ?2
             WHERE id = ?1 AND status = 'ended' AND winners = ?3",
            (instance_id, json, previous_json),
        )?;
        Ok(n > 0)
    }

    /// Mark a giveaway ended (or rerolled) with this winner set.
    #[cfg(test)]
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

fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 5000;
         CREATE TABLE IF NOT EXISTS instances (
             id              TEXT PRIMARY KEY,
             created_at      INTEGER NOT NULL,
             config          TEXT NOT NULL,
             status          TEXT NOT NULL DEFAULT 'open',
             winners         TEXT NOT NULL DEFAULT '[]',
             edit_token_hash TEXT
         );
         CREATE TABLE IF NOT EXISTS entries (
             instance_id TEXT NOT NULL,
             user_id     TEXT NOT NULL,
             created_at  INTEGER NOT NULL,
             PRIMARY KEY (instance_id, user_id)
         );",
    )?;
    // Migration for databases created before the edit-token column. Legacy rows
    // keep a null digest, which `authorize_edit` reports as Forbidden.
    if !has_column(conn, "instances", "edit_token_hash")? {
        conn.execute("ALTER TABLE instances ADD COLUMN edit_token_hash TEXT", [])?;
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

    const TOKEN: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    fn config(prize: &str) -> InstanceConfig {
        InstanceConfig {
            target: "button".into(),
            guild_id: "123456789012345678".into(),
            guild_name: String::new(),
            prize: prize.into(),
            winner_count: 1,
            description: None,
            host_user_id: None,
            ends_at: None,
            requirements: Requirements::default(),
            host_roles: vec![],
            dm_winners: false,
            announcement: None,
            message_template: None,
        }
    }

    #[test]
    fn migrates_legacy_rows_without_granting_edit_access() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE instances (
                id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, config TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'open', winners TEXT NOT NULL DEFAULT '[]'
             );
             CREATE TABLE entries (
                instance_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL,
                PRIMARY KEY (instance_id, user_id)
             );
             INSERT INTO instances (id, created_at, config) VALUES ('legacy', 1, '{}');",
        )
        .unwrap();
        init_schema(&conn).unwrap();
        assert!(has_column(&conn, "instances", "edit_token_hash").unwrap());
        let store = Store {
            conn: Mutex::new(conn),
        };
        assert!(matches!(
            store.authorize_edit("legacy", TOKEN).unwrap(),
            EditLookup::Forbidden
        ));
        assert!(!store.update_config("legacy", TOKEN, &config("x")).unwrap());
    }

    #[test]
    fn stores_only_hash_and_requires_token_for_updates() {
        let store = Store::open(":memory:").unwrap();
        store.create("one", TOKEN, &config("Before")).unwrap();
        let stored: String = store
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
            store.authorize_edit("one", "wrong").unwrap(),
            EditLookup::Forbidden
        ));
        assert!(matches!(
            store.authorize_edit("missing", TOKEN).unwrap(),
            EditLookup::Unknown
        ));
        assert!(!store
            .update_config("one", "wrong", &config("Wrong"))
            .unwrap());
        assert!(store.update_config("one", TOKEN, &config("After")).unwrap());
        assert_eq!(store.get("one").unwrap().unwrap().config.prize, "After");
        // Reconfiguring never disturbs the runtime state.
        assert!(matches!(
            store.get("one").unwrap().unwrap().status,
            Status::Open
        ));
    }

    #[test]
    fn entrant_sampling_is_bounded_and_honours_exclusions() {
        let store = Store::open(":memory:").unwrap();
        store.create("one", TOKEN, &config("Prize")).unwrap();
        for user in ["a", "b", "c", "d", "e"] {
            assert!(store.enter("one", user).unwrap());
        }

        // A deterministic picker is enough to assert the reservoir's resource
        // contract: it visits all eligible rows but retains only the limit.
        let (sample, eligible) = store
            .sample_entrants("one", &["b".into(), "d".into()], 2, |_| 0)
            .unwrap();
        assert_eq!(eligible, 3);
        assert_eq!(sample.len(), 2);
        assert!(sample.iter().all(|u| u != "b" && u != "d"));

        let (empty, eligible) = store.sample_entrants("one", &[], 0, |_| 0).unwrap();
        assert_eq!(eligible, 5);
        assert!(empty.is_empty());
    }

    #[test]
    fn winner_updates_are_compare_and_swap() {
        let store = Store::open(":memory:").unwrap();
        store.create("one", TOKEN, &config("Prize")).unwrap();

        assert!(store.commit_draw("one", &["a".into()]).unwrap());
        assert!(!store.commit_draw("one", &["b".into()]).unwrap());
        assert!(store
            .commit_reroll("one", &["a".into()], &["c".into()])
            .unwrap());
        assert!(!store
            .commit_reroll("one", &["a".into()], &["d".into()])
            .unwrap());
        assert_eq!(store.get("one").unwrap().unwrap().winners, vec!["c"]);
    }
}
