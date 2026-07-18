//! SQLite-backed store.
//!
//! Three tables. `instances` holds one JSON config blob per poll plus its small
//! mutable runtime state (open/closed), keyed by the opaque id in the
//! component's `custom_id`. That id is a **public binding** — every guild
//! member who can see the message can read it — so it must never be edit
//! authority: a separate random edit token (protocol v2) authorizes
//! reconfiguration, and only its SHA-256 digest is stored. `ballots` is the
//! per-member ledger: one row per (poll, member) enforces **one ballot per
//! person** structurally (a PRIMARY KEY), holding the picked option keys.
//! `counts` is the per-option tally, maintained transactionally with every
//! ballot change — so rendering the live results reads O(options) rows, never
//! the whole ballot ledger.

use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// The reserved `counts` key that tracks the total number of ballots. Option
/// keys are validated to never start with `_`, so it can't collide.
pub const TOTAL_KEY: &str = "_total";

/// One role referenced by a poll — a vote-gate role or a host role. `name` /
/// `color` are cached at save time purely so the config UI can render nicely
/// without a live Discord fetch; the `id` is the only field that matters at
/// click time (it's intersected with the member's roles from the payload).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleRef {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Discord role colour as a 24-bit integer (0 = no colour). Cosmetic.
    #[serde(default)]
    pub color: u32,
}

/// Who may vote. Empty/zero fields mean "no restriction"; the poll is open to
/// everyone by default.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Requirements {
    /// Roles gating the vote. Empty = no role requirement.
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

/// A partial emoji riding a poll option: custom (`id` + optional `name`) or
/// unicode (`name` only). Mirrors the shape DWEEB's select-option sanitizer
/// accepts, so it round-trips through the config UI unchanged.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EmojiRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub animated: bool,
}

impl EmojiRef {
    pub fn is_empty(&self) -> bool {
        self.id.is_none() && self.name.is_none()
    }
}

/// One poll choice. The `key` is what a select interaction delivers back
/// (`values`), so it is the stable contract between the wired component and the
/// tallies; the label/description/emoji are display.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PollOption {
    pub key: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<EmojiRef>,
}

/// The full, stored configuration for one poll.
///
/// New fields are additive with serde defaults so configs written by an older
/// build keep deserializing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceConfig {
    /// `"button"` or `"string_select"` — the component kind this binds to. A
    /// button opens an ephemeral voting panel; a select votes directly.
    #[serde(default = "default_target")]
    pub target: String,
    /// The guild this poll belongs to. Cross-checked against the interaction's
    /// guild at click time so role gates resolve and a poll can't be silently
    /// reused in another server.
    pub guild_id: String,
    /// Cached guild name for the config UI. Cosmetic.
    #[serde(default)]
    pub guild_name: String,
    /// The question, shown in results announcements and `{question}`.
    pub question: String,
    /// The choices, in display order. 2..=`MAX_OPTIONS` (see `validate.rs`).
    pub options: Vec<PollOption>,
    /// How many options one ballot may pick. 1 = single choice.
    #[serde(default = "default_one")]
    pub max_choices: u32,
    /// Whether a member may change (or retract) their ballot after casting it.
    #[serde(default = "default_true")]
    pub allow_change: bool,
    /// When true, per-option results stay hidden while the poll is open and
    /// reveal on close; only the total ballot count shows live.
    #[serde(default)]
    pub hide_results: bool,
    /// Optional voting deadline (unix **seconds**). Enforced lazily at click
    /// time: the first interaction past it closes the poll (no scheduler).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<i64>,
    /// Who may vote.
    #[serde(default)]
    pub requirements: Requirements,
    /// Extra roles (besides Manage Server / Administrator holders) whose
    /// members get the host control panel. Empty = only server managers.
    #[serde(default)]
    pub host_roles: Vec<RoleRef>,
    /// Optional custom close announcement. Runs through the same placeholder
    /// substitution as the message (`{question}`, `{results}`, `{votes}`, …).
    /// None = a friendly default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close_announcement: Option<String>,
    /// The host's own message, captured as a Components V2 tree (a JSON array)
    /// with its raw `{token}` placeholders intact — the *template* this plugin
    /// re-renders on each click to keep the live tallies and status current.
    /// None = no placeholders in play; the live refresh then falls back to
    /// restyling the bound component alone. Captured by the config iframe on
    /// save via the `message` editor resource.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_template: Option<Value>,
}

fn default_target() -> String {
    "button".to_string()
}
fn default_one() -> u32 {
    1
}
fn default_true() -> bool {
    true
}

/// A poll's lifecycle. `open` accepts ballots; `closed` shows final results
/// (and can be reopened by a host).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Open,
    Closed,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Open => "open",
            Status::Closed => "closed",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "closed" => Status::Closed,
            _ => Status::Open,
        }
    }
}

/// A poll as the store hands it back: its config plus mutable runtime state.
#[derive(Debug, Clone)]
pub struct Poll {
    pub config: InstanceConfig,
    pub status: Status,
}

/// A read view for the config UI. Carries the instance `id`, the live ballot
/// count, and the status — no secrets to mask (the poll holds no per-instance
/// token beyond the digest, which is never read back).
#[derive(Debug, Serialize)]
pub struct MaskedInstance {
    pub id: String,
    #[serde(flatten)]
    pub config: InstanceConfig,
    pub status: String,
    pub votes: i64,
}

/// Outcome of an edit-authorization check.
pub enum EditLookup {
    Authorized,
    Unknown,
    /// Wrong credential — or a row with a null digest, which deliberately
    /// cannot be updated in place; the config UI then creates a replacement
    /// instance and rebinds the component.
    Forbidden,
}

/// What happened to a cast ballot.
#[derive(Debug, PartialEq, Eq)]
pub enum Cast {
    /// A brand-new ballot was recorded.
    First,
    /// An existing ballot was replaced with different picks.
    Changed,
    /// The same picks were submitted again — a harmless no-op.
    Unchanged,
    /// The poll locks ballots (`allow_change = false`) and this member already
    /// voted; the existing picks ride along for the reply.
    Locked { existing: Vec<String> },
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
    /// The only thing that runs under this lock is `rusqlite` work, which
    /// returns errors rather than panicking — so the lock can't actually be
    /// poisoned today. Recovering anyway (instead of `unwrap()`) keeps one
    /// unlucky panic in a future caller from bricking every later DB op for
    /// the life of the process.
    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// Insert a new poll (status `open`) under a fresh id, and store only the
    /// edit-token digest.
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
            "INSERT INTO instances (id, created_at, config, status, edit_token_hash)
             VALUES (?1, ?2, ?3, 'open', ?4)",
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

    /// Replace a poll's config (reconfigure), only when the edit-token digest
    /// matches. Leaves ballots, tallies, and status untouched.
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

    /// Load a poll (config + runtime state).
    pub fn get(&self, id: &str) -> rusqlite::Result<Option<Poll>> {
        let conn = self.lock();
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT config, status FROM instances WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        drop(conn);
        Ok(row.and_then(|(config, status)| {
            let config: InstanceConfig = serde_json::from_str(&config).ok()?;
            Some(Poll {
                config,
                status: Status::parse(&status),
            })
        }))
    }

    /// Record (or replace) a member's ballot. `picks` must already be validated
    /// against the poll's option keys — this only enforces the ledger rules.
    ///
    /// The ballot upsert and the per-option tally adjustments commit in ONE
    /// transaction, so `counts` can never drift from `ballots` — and a rapid
    /// double-click resolves to [`Cast::Unchanged`] instead of double-counting.
    pub fn cast_ballot(
        &self,
        instance_id: &str,
        user_id: &str,
        picks: &[String],
        allow_change: bool,
    ) -> rusqlite::Result<Cast> {
        let now = unix_millis();
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let existing: Option<String> = tx
            .query_row(
                "SELECT picks FROM ballots WHERE instance_id = ?1 AND user_id = ?2",
                (instance_id, user_id),
                |r| r.get(0),
            )
            .optional()?;
        let previous: Option<Vec<String>> =
            existing.map(|raw| serde_json::from_str(&raw).unwrap_or_default());

        if let Some(prev) = &previous {
            if !allow_change {
                return Ok(Cast::Locked {
                    existing: prev.clone(),
                });
            }
            if prev == picks {
                return Ok(Cast::Unchanged);
            }
            for key in prev {
                decrement(&tx, instance_id, key)?;
            }
        }

        let picks_json = serde_json::to_string(picks).expect("serialize picks");
        tx.execute(
            "INSERT INTO ballots (instance_id, user_id, picks, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(instance_id, user_id)
             DO UPDATE SET picks = excluded.picks, updated_at = excluded.updated_at",
            (instance_id, user_id, picks_json, now),
        )?;
        for key in picks {
            increment(&tx, instance_id, key)?;
        }
        let first = previous.is_none();
        if first {
            increment(&tx, instance_id, TOTAL_KEY)?;
        }
        tx.commit()?;
        Ok(if first { Cast::First } else { Cast::Changed })
    }

    /// Withdraw a member's ballot, adjusting the tallies in the same
    /// transaction. Returns true if a ballot was actually removed.
    pub fn retract(&self, instance_id: &str, user_id: &str) -> rusqlite::Result<bool> {
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT picks FROM ballots WHERE instance_id = ?1 AND user_id = ?2",
                (instance_id, user_id),
                |r| r.get(0),
            )
            .optional()?;
        let Some(raw) = existing else {
            return Ok(false);
        };
        let picks: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
        tx.execute(
            "DELETE FROM ballots WHERE instance_id = ?1 AND user_id = ?2",
            (instance_id, user_id),
        )?;
        for key in &picks {
            decrement(&tx, instance_id, key)?;
        }
        decrement(&tx, instance_id, TOTAL_KEY)?;
        tx.commit()?;
        Ok(true)
    }

    /// A member's current picks, if they have voted.
    pub fn ballot_of(
        &self,
        instance_id: &str,
        user_id: &str,
    ) -> rusqlite::Result<Option<Vec<String>>> {
        let conn = self.lock();
        let raw: Option<String> = conn
            .query_row(
                "SELECT picks FROM ballots WHERE instance_id = ?1 AND user_id = ?2",
                (instance_id, user_id),
                |r| r.get(0),
            )
            .optional()?;
        drop(conn);
        Ok(raw.map(|r| serde_json::from_str(&r).unwrap_or_default()))
    }

    /// The per-option tallies for a poll, `key → count`, plus the total ballot
    /// count. Reads O(options) rows — never the ballot ledger.
    pub fn tallies(&self, instance_id: &str) -> rusqlite::Result<Tallies> {
        let conn = self.lock();
        let mut stmt =
            conn.prepare_cached("SELECT key, n FROM counts WHERE instance_id = ?1 AND n > 0")?;
        let rows = stmt.query_map([instance_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        let mut total = 0i64;
        let mut by_key = Vec::new();
        for row in rows {
            let (key, n) = row?;
            if key == TOTAL_KEY {
                total = n;
            } else {
                by_key.push((key, n));
            }
        }
        Ok(Tallies { total, by_key })
    }

    /// Close voting. Compare-and-swap on `open` so two hosts clicking Close at
    /// once produce exactly one announcement.
    pub fn close(&self, instance_id: &str) -> rusqlite::Result<bool> {
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE instances SET status = 'closed' WHERE id = ?1 AND status = 'open'",
            [instance_id],
        )?;
        Ok(n > 0)
    }

    /// Reopen a closed poll. Compare-and-swap on `closed`; the caller handles
    /// clearing a stale deadline (via [`Store::update_config_unchecked`]) so
    /// the poll doesn't immediately lazy-close again.
    pub fn reopen(&self, instance_id: &str) -> rusqlite::Result<bool> {
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE instances SET status = 'open' WHERE id = ?1 AND status = 'closed'",
            [instance_id],
        )?;
        Ok(n > 0)
    }

    /// Rewrite a poll's config from the interaction path (no edit token —
    /// this is the service's own state maintenance, e.g. clearing a passed
    /// deadline on reopen; it is never reachable from a browser request).
    pub fn update_config_unchecked(
        &self,
        instance_id: &str,
        config: &InstanceConfig,
    ) -> rusqlite::Result<bool> {
        let json = serde_json::to_string(config).expect("serialize config");
        let conn = self.lock();
        let n = conn.execute(
            "UPDATE instances SET config = ?2 WHERE id = ?1",
            (instance_id, json),
        )?;
        Ok(n > 0)
    }
}

/// A poll's current tallies: total ballots plus per-option counts (only options
/// with at least one vote appear; the renderer fills the zeros from config).
#[derive(Debug, Default)]
pub struct Tallies {
    pub total: i64,
    pub by_key: Vec<(String, i64)>,
}

impl Tallies {
    pub fn count_for(&self, key: &str) -> i64 {
        self.by_key
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, n)| *n)
            .unwrap_or(0)
    }
}

fn increment(conn: &Connection, instance_id: &str, key: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO counts (instance_id, key, n) VALUES (?1, ?2, 1)
         ON CONFLICT(instance_id, key) DO UPDATE SET n = n + 1",
        (instance_id, key),
    )?;
    Ok(())
}

/// Decrement a tally, never below zero, and only when the row exists — a pick
/// for a key that was never counted (e.g. an option removed by a reconfigure)
/// must not create a negative row.
fn decrement(conn: &Connection, instance_id: &str, key: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE counts SET n = MAX(0, n - 1) WHERE instance_id = ?1 AND key = ?2",
        (instance_id, key),
    )?;
    Ok(())
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
             edit_token_hash TEXT
         );
         CREATE TABLE IF NOT EXISTS ballots (
             instance_id TEXT NOT NULL,
             user_id     TEXT NOT NULL,
             picks       TEXT NOT NULL,
             created_at  INTEGER NOT NULL,
             updated_at  INTEGER NOT NULL,
             PRIMARY KEY (instance_id, user_id)
         );
         CREATE TABLE IF NOT EXISTS counts (
             instance_id TEXT NOT NULL,
             key         TEXT NOT NULL,
             n           INTEGER NOT NULL DEFAULT 0,
             PRIMARY KEY (instance_id, key)
         );",
    )
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

    fn opt(key: &str, label: &str) -> PollOption {
        PollOption {
            key: key.into(),
            label: label.into(),
            description: None,
            emoji: None,
        }
    }

    fn config(question: &str) -> InstanceConfig {
        InstanceConfig {
            target: "string_select".into(),
            guild_id: "123456789012345678".into(),
            guild_name: String::new(),
            question: question.into(),
            options: vec![opt("a", "Alpha"), opt("b", "Beta"), opt("c", "Gamma")],
            max_choices: 1,
            allow_change: true,
            hide_results: false,
            ends_at: None,
            requirements: Requirements::default(),
            host_roles: vec![],
            close_announcement: None,
            message_template: None,
        }
    }

    fn picks(keys: &[&str]) -> Vec<String> {
        keys.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn stores_only_hash_and_requires_token_for_updates() {
        let store = Store::open(":memory:").unwrap();
        store.create("one", TOKEN, &config("Before?")).unwrap();
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
            .update_config("one", "wrong", &config("Wrong?"))
            .unwrap());
        assert!(store
            .update_config("one", TOKEN, &config("After?"))
            .unwrap());
        assert_eq!(store.get("one").unwrap().unwrap().config.question, "After?");
        // Reconfiguring never disturbs the runtime state.
        assert!(matches!(
            store.get("one").unwrap().unwrap().status,
            Status::Open
        ));
    }

    #[test]
    fn ballots_and_tallies_stay_in_lockstep() {
        let store = Store::open(":memory:").unwrap();
        store.create("p", TOKEN, &config("Q?")).unwrap();

        assert_eq!(
            store.cast_ballot("p", "u1", &picks(&["a"]), true).unwrap(),
            Cast::First
        );
        assert_eq!(
            store.cast_ballot("p", "u2", &picks(&["a"]), true).unwrap(),
            Cast::First
        );
        assert_eq!(
            store.cast_ballot("p", "u3", &picks(&["b"]), true).unwrap(),
            Cast::First
        );
        let t = store.tallies("p").unwrap();
        assert_eq!(t.total, 3);
        assert_eq!(t.count_for("a"), 2);
        assert_eq!(t.count_for("b"), 1);
        assert_eq!(t.count_for("c"), 0);

        // A double-submit of the same picks is a no-op.
        assert_eq!(
            store.cast_ballot("p", "u1", &picks(&["a"]), true).unwrap(),
            Cast::Unchanged
        );
        assert_eq!(store.tallies("p").unwrap().total, 3);

        // Changing a ballot moves the tally, never the total.
        assert_eq!(
            store.cast_ballot("p", "u1", &picks(&["c"]), true).unwrap(),
            Cast::Changed
        );
        let t = store.tallies("p").unwrap();
        assert_eq!(t.total, 3);
        assert_eq!(t.count_for("a"), 1);
        assert_eq!(t.count_for("c"), 1);

        // Retracting removes the ballot and its tallies.
        assert!(store.retract("p", "u1").unwrap());
        assert!(!store.retract("p", "u1").unwrap());
        let t = store.tallies("p").unwrap();
        assert_eq!(t.total, 2);
        assert_eq!(t.count_for("c"), 0);
        assert_eq!(store.ballot_of("p", "u1").unwrap(), None);
        assert_eq!(store.ballot_of("p", "u2").unwrap(), Some(picks(&["a"])));
    }

    #[test]
    fn multi_choice_ballots_count_each_pick() {
        let store = Store::open(":memory:").unwrap();
        store.create("p", TOKEN, &config("Q?")).unwrap();
        assert_eq!(
            store
                .cast_ballot("p", "u1", &picks(&["a", "b"]), true)
                .unwrap(),
            Cast::First
        );
        let t = store.tallies("p").unwrap();
        assert_eq!(t.total, 1); // one ballot…
        assert_eq!(t.count_for("a"), 1); // …two counted picks
        assert_eq!(t.count_for("b"), 1);
    }

    #[test]
    fn locked_polls_refuse_a_second_ballot() {
        let store = Store::open(":memory:").unwrap();
        store.create("p", TOKEN, &config("Q?")).unwrap();
        assert_eq!(
            store.cast_ballot("p", "u1", &picks(&["a"]), false).unwrap(),
            Cast::First
        );
        assert_eq!(
            store.cast_ballot("p", "u1", &picks(&["b"]), false).unwrap(),
            Cast::Locked {
                existing: picks(&["a"])
            }
        );
        // Nothing moved.
        let t = store.tallies("p").unwrap();
        assert_eq!(t.count_for("a"), 1);
        assert_eq!(t.count_for("b"), 0);
    }

    #[test]
    fn a_stale_pick_from_a_removed_option_never_goes_negative() {
        let store = Store::open(":memory:").unwrap();
        store.create("p", TOKEN, &config("Q?")).unwrap();
        // A ballot referencing a key that was never tallied (as after a
        // reconfigure removed the option): changing away from it must not
        // create a negative row.
        let raw = serde_json::to_string(&picks(&["ghost"])).unwrap();
        store
            .lock()
            .execute(
                "INSERT INTO ballots (instance_id, user_id, picks, created_at, updated_at)
                 VALUES ('p', 'u1', ?1, 0, 0)",
                [raw],
            )
            .unwrap();
        assert_eq!(
            store.cast_ballot("p", "u1", &picks(&["a"]), true).unwrap(),
            Cast::Changed
        );
        let t = store.tallies("p").unwrap();
        assert_eq!(t.count_for("ghost"), 0);
        assert_eq!(t.count_for("a"), 1);
    }

    #[test]
    fn close_and_reopen_are_compare_and_swap() {
        let store = Store::open(":memory:").unwrap();
        store.create("p", TOKEN, &config("Q?")).unwrap();
        assert!(store.close("p").unwrap());
        assert!(!store.close("p").unwrap()); // second host loses the race
        assert!(matches!(
            store.get("p").unwrap().unwrap().status,
            Status::Closed
        ));
        assert!(store.reopen("p").unwrap());
        assert!(!store.reopen("p").unwrap());
        assert!(matches!(
            store.get("p").unwrap().unwrap().status,
            Status::Open
        ));
    }
}
