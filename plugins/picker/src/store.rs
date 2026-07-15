//! SQLite-backed instance store.
//!
//! One table, one JSON blob per instance. The instance `id` in the component's
//! `custom_id` is a **public binding** — every guild member who can see the
//! message can read it — so it must never be edit authority. A separate random
//! edit token (protocol v2) authorizes replacement; only its SHA-256 digest is
//! stored. A Picker instance holds no secret (no bot token, no webhook), so
//! reads need no masking; [`MaskedInstance`] exists only to attach the `id` to
//! the round-tripped config.

use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Which auto-populated select this instance is attached to. Mirrors the plugin
/// target DWEEB sends on `init`; it tells the interaction path how to turn a
/// picked snowflake into the right kind of mention (`<@id>`, `<@&id>`, `<#id>`).
pub const TARGET_USER: &str = "user_select";
pub const TARGET_ROLE: &str = "role_select";
pub const TARGET_MENTIONABLE: &str = "mentionable_select";
pub const TARGET_CHANNEL: &str = "channel_select";

/// The full, stored configuration for one menu.
///
/// New fields are additive with serde defaults so configs written by an older
/// build keep deserializing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceConfig {
    /// One of the `TARGET_*` strings — the select kind this binds to.
    pub target: String,
    /// The guild this menu was built for, when known. Optional and cosmetic:
    /// stored only so `{server}` in the reply renders the server name. The picks
    /// themselves are auto-populated by Discord from whatever guild the message
    /// lives in, so this binding is NOT server-specific.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guild_id: Option<String>,
    /// Cached guild name, for `{server}`. Cosmetic.
    #[serde(default)]
    pub guild_name: String,
    /// Optional heading rendered above the body (as a Markdown `### heading`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The reply text — Markdown plus `{picks}`/`{count}`/`{user}`/`{username}`/
    /// `{server}` tokens, substituted at pick time from the interaction payload.
    pub body: String,
}

/// A read view for the config UI. Carries the instance `id` (which
/// [`InstanceConfig`] itself doesn't) and holds no secrets.
#[derive(Debug, Serialize)]
pub struct MaskedInstance {
    pub id: String,
    #[serde(flatten)]
    pub config: InstanceConfig,
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
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
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
}

fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS instances (
             id              TEXT PRIMARY KEY,
             created_at      INTEGER NOT NULL,
             config          TEXT NOT NULL,
             edit_token_hash TEXT
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

fn unix_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    fn config(body: &str) -> InstanceConfig {
        InstanceConfig {
            target: TARGET_USER.into(),
            guild_id: None,
            guild_name: String::new(),
            title: None,
            body: body.into(),
        }
    }

    #[test]
    fn migrates_legacy_rows_without_granting_edit_access() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE instances (
                id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, config TEXT NOT NULL
             );
             INSERT INTO instances VALUES ('legacy', 1, '{}');",
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
        assert!(!store.update("legacy", TOKEN, &config("x")).unwrap());
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
        assert!(!store.update("one", "wrong", &config("Wrong")).unwrap());
        assert!(store.update("one", TOKEN, &config("After")).unwrap());
        assert_eq!(store.get("one").unwrap().unwrap().body, "After");
    }
}
