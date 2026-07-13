//! SQLite-backed instance store.
//!
//! `instances` holds one JSON config blob per form, keyed by the opaque id in
//! the component's `custom_id`. A separate random edit token authorizes
//! replacement; only its SHA-256 digest is stored. Public reads mask the
//! forwarding webhook through [`MaskedInstance`]. `submissions` records the
//! single bit of per-user state needed by one-response-per-person forms.

use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModalField {
    pub id: String,
    pub label: String,
    /// `"short"` (single line) or `"paragraph"` (multi-line).
    pub style: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_length: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_length: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModalDef {
    pub title: String,
    pub fields: Vec<ModalField>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReplyDef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// Full stored configuration. The forwarding webhook is a secret and must
/// never be returned by the public config GET route.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceConfig {
    pub modal: ModalDef,
    pub forward_webhook: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forward_username: Option<String>,
    #[serde(default = "default_true")]
    pub include_submitter: bool,
    #[serde(default)]
    pub limit_one: bool,
    pub reply: ReplyDef,
}

fn default_true() -> bool {
    true
}

/// Browser-safe read view: the webhook is represented only by a boolean.
#[derive(Debug, Serialize)]
pub struct MaskedInstance {
    pub id: String,
    pub modal: ModalDef,
    pub reply: ReplyDef,
    pub forward_webhook_set: bool,
    pub forward_username: Option<String>,
    pub include_submitter: bool,
    pub limit_one: bool,
}

pub enum EditLookup {
    Authorized(InstanceConfig),
    Unknown,
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

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// Create under a fresh id and store only the edit-token digest.
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

    /// Load a config only when the separate edit credential matches. Migrated
    /// legacy rows have a null digest and intentionally return `Forbidden`.
    pub fn get_for_edit(&self, id: &str, edit_token: &str) -> rusqlite::Result<EditLookup> {
        let conn = self.lock();
        let row: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT config, edit_token_hash FROM instances WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        let Some((json, stored_hash)) = row else {
            return Ok(EditLookup::Unknown);
        };
        let Some(stored_hash) = stored_hash else {
            return Ok(EditLookup::Forbidden);
        };
        if !edit_token_matches(edit_token, &stored_hash) {
            return Ok(EditLookup::Forbidden);
        }
        match serde_json::from_str(&json) {
            Ok(config) => Ok(EditLookup::Authorized(config)),
            Err(_) => Ok(EditLookup::Unknown),
        }
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
            "UPDATE instances SET config = ?2
             WHERE id = ?1 AND edit_token_hash = ?3",
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

    pub fn has_submitted(&self, instance_id: &str, user_id: &str) -> rusqlite::Result<bool> {
        let conn = self.lock();
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM submissions WHERE instance_id = ?1 AND user_id = ?2",
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

    pub fn record_submission(&self, instance_id: &str, user_id: &str) -> rusqlite::Result<()> {
        let now = unix_millis();
        let conn = self.lock();
        conn.execute(
            "INSERT OR IGNORE INTO submissions (instance_id, user_id, created_at)
             VALUES (?1, ?2, ?3)",
            (instance_id, user_id, now),
        )?;
        Ok(())
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
         );
         CREATE TABLE IF NOT EXISTS submissions (
             instance_id TEXT NOT NULL,
             user_id     TEXT NOT NULL,
             created_at  INTEGER NOT NULL,
             PRIMARY KEY (instance_id, user_id)
         );",
    )?;
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

    const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn config(title: &str) -> InstanceConfig {
        InstanceConfig {
            modal: ModalDef {
                title: title.into(),
                fields: vec![ModalField {
                    id: "field".into(),
                    label: "Question".into(),
                    style: "short".into(),
                    required: true,
                    placeholder: None,
                    value: None,
                    min_length: None,
                    max_length: None,
                }],
            },
            forward_webhook: "https://discord.com/api/webhooks/1/secret".into(),
            forward_username: None,
            include_submitter: true,
            limit_one: false,
            reply: ReplyDef {
                payload: None,
                text: Some("Thanks".into()),
            },
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
        let hash: Option<String> = conn
            .query_row(
                "SELECT edit_token_hash FROM instances WHERE id = 'legacy'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(hash.is_none());
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
            store.get_for_edit("one", "wrong").unwrap(),
            EditLookup::Forbidden
        ));
        assert!(!store.update("one", "wrong", &config("Wrong")).unwrap());
        assert!(store.update("one", TOKEN, &config("After")).unwrap());
        assert_eq!(store.get("one").unwrap().unwrap().modal.title, "After");
    }

    #[test]
    fn masked_view_never_serializes_the_webhook() {
        let cfg = config("Safe");
        let masked = MaskedInstance {
            id: "one".into(),
            modal: cfg.modal,
            reply: cfg.reply,
            forward_webhook_set: true,
            forward_username: cfg.forward_username,
            include_submitter: cfg.include_submitter,
            limit_one: cfg.limit_one,
        };
        let json = serde_json::to_string(&masked).unwrap();
        assert!(!json.contains("secret"));
        assert!(!json.contains("discord.com/api/webhooks"));
        assert!(json.contains("forward_webhook_set"));
    }
}
