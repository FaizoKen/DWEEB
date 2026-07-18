//! SQLite-backed instance store.
//!
//! One table, one JSON blob per instance. The instance `id` in the component's
//! `custom_id` is a **public binding** — every guild member who can see the
//! message can read it — so it must never be edit authority. A separate random
//! edit token (protocol v2) authorizes replacement; only its SHA-256 digest is
//! stored. A quick reply holds no secret (no bot token, no webhook), so reads
//! need no masking; [`MaskedInstance`] exists only to attach the `id` to the
//! round-tripped config.

use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// One role a reply may be gated to. `name`/`color` are cached at save time
/// purely so the config UI can render the picker nicely without a live Discord
/// fetch — the `id` is the only field that matters at click time (it's
/// intersected with the member's roles from the interaction payload).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleRef {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Discord role colour as a 24-bit integer (0 = no colour). Cosmetic.
    #[serde(default)]
    pub color: u32,
}

/// One canned reply. A **button** instance has exactly one; a **string select**
/// has 1..=25, and each reply's [`key`](Self::key) is the select option's
/// `value` (wired + locked by DWEEB), so a picked option routes straight to its
/// reply.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickReply {
    /// Stable, opaque id. For a select it is the option's `value`; DWEEB locks
    /// the option list, so this never drifts. Generated once in the config UI
    /// and preserved across reorders, so reordering topics never reshuffles
    /// which option maps to which reply.
    pub key: String,
    /// The select option's label (the dropdown row). Unused for a button, whose
    /// own label is part of the DWEEB message the admin designs.
    #[serde(default)]
    pub label: String,
    /// Optional emoji for the select option. For a unicode emoji this is the
    /// glyph itself (e.g. "📜"); for a custom guild emoji it is the emoji's
    /// name/alias, paired with [`emoji_id`](Self::emoji_id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    /// Set only for a **custom** guild emoji: its snowflake id. Stored purely so
    /// the config UI can re-show the chosen emoji on reconfigure; the click path
    /// never reads it (DWEEB owns the wired select option).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji_id: Option<String>,
    /// Whether a custom [`emoji_id`](Self::emoji_id) is animated (GIF).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji_animated: Option<bool>,
    /// Optional select-option subtitle shown under the label in the dropdown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Optional heading rendered above the body (as a Markdown `### heading`).
    /// Only used for a *typed* reply; a saved-message reply carries its own
    /// layout, so this is ignored when [`payload`](Self::payload) is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// An optional DWEEB **saved message** to send instead of the typed
    /// title/body — a Components V2 wire payload the admin built and saved in
    /// DWEEB, handed to us over the plugin protocol's `savedMessages` resource.
    /// When it carries a non-empty `components` array it takes priority over
    /// `body`; `{user}`/`{username}`/`{server}` inside its text are still
    /// substituted per click, and mentions are pinned to the clicker exactly
    /// like a typed reply, so a public saved message can never `@everyone`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
    /// The reply text — Markdown, links, and `{user}`/`{username}`/`{server}`
    /// variables, substituted at click time from the interaction payload. May be
    /// empty when [`payload`](Self::payload) supplies the message instead.
    #[serde(default)]
    pub body: String,
    /// Whether the reply is ephemeral (only the clicker sees it). Defaults true
    /// — the safe, low-noise choice for an FAQ/support macro.
    #[serde(default = "default_true")]
    pub ephemeral: bool,
    /// Roles allowed to use this reply. Empty = everyone. Otherwise a member
    /// must hold **any one** of these (intersected with their payload roles at
    /// click time) or they get a plain "this reply is for … only" notice.
    #[serde(default)]
    pub allowed_roles: Vec<RoleRef>,
}

fn default_true() -> bool {
    true
}

/// The full, stored configuration for one instance.
///
/// New fields are additive with serde defaults so configs written by an older
/// build keep deserializing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceConfig {
    /// `"button"` or `"string_select"` — the component kind this binds to.
    pub target: String,
    /// The guild this menu was built for, when known. Optional: a plain text
    /// reply is portable and needs no server. Stored so `{server}` can render
    /// the name and (with role-gating) so DWEEB can warn before the message is
    /// posted to a different server, where gate role ids wouldn't match.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guild_id: Option<String>,
    /// Cached guild name, for `{server}` and the config UI. Cosmetic.
    #[serde(default)]
    pub guild_name: String,
    /// The replies. Exactly one for a button; 1..=25 for a select.
    pub replies: Vec<QuickReply>,
}

impl InstanceConfig {
    /// Find the reply with this key (a select option value).
    pub fn reply_for(&self, key: &str) -> Option<&QuickReply> {
        self.replies.iter().find(|r| r.key == key)
    }
}

/// A read view for the config UI. Carries the instance `id` (which
/// [`InstanceConfig`] itself doesn't) and holds no secrets — a quick reply has
/// no per-instance token to mask.
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
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        drop(conn);
        Ok(match row {
            Some(json) => serde_json::from_str(&json).ok(),
            None => None,
        })
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

    const TOKEN: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    fn config(body: &str) -> InstanceConfig {
        InstanceConfig {
            target: "button".into(),
            guild_id: None,
            guild_name: String::new(),
            replies: vec![QuickReply {
                key: "k1".into(),
                label: String::new(),
                emoji: None,
                emoji_id: None,
                emoji_animated: None,
                description: None,
                title: None,
                payload: None,
                body: body.into(),
                ephemeral: true,
                allowed_roles: vec![],
            }],
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
        assert_eq!(store.get("one").unwrap().unwrap().replies[0].body, "After");
    }
}
