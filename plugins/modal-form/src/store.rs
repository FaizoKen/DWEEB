//! SQLite-backed instance store.
//!
//! One table, one JSON blob per instance. The instance `id` is a 128-bit random
//! token that lives inside the component's `custom_id` — it is the *capability*
//! to read/replace this instance's config, so it must stay unguessable. Reads
//! intended for the config UI mask the forward webhook (a secret); see
//! `MaskedInstance`.

use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// One configurable modal text field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModalField {
    /// Stable id; becomes the text input's `custom_id` and keys the submitted value.
    pub id: String,
    pub label: String,
    /// `"short"` (single line) or `"paragraph"` (multi-line).
    pub style: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub min_length: Option<u32>,
    #[serde(default)]
    pub max_length: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModalDef {
    pub title: String,
    pub fields: Vec<ModalField>,
}

/// How to reply to the submitter (ephemeral). Either a plain-text "flat"
/// message typed in the config UI, or a DWEEB saved message (Components V2).
/// A saved-message `payload`, when present, takes priority over `text`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReplyDef {
    /// A DWEEB Components V2 wire payload (the saved message) used to reply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
    /// A plain-text reply typed directly in the config UI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// The full, stored configuration for one instance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceConfig {
    pub modal: ModalDef,
    /// Discord incoming-webhook URL the submission is forwarded to. Secret.
    pub forward_webhook: String,
    pub reply: ReplyDef,
}

/// A read view safe to hand back to the browser: the webhook is replaced by a
/// boolean so the secret never leaves the server.
#[derive(Debug, Serialize)]
pub struct MaskedInstance {
    pub id: String,
    pub modal: ModalDef,
    pub reply: ReplyDef,
    pub forward_webhook_set: bool,
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
             );",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Insert a new instance under a fresh id, returning the id.
    pub fn create(&self, id: &str, config: &InstanceConfig) -> rusqlite::Result<()> {
        let json = serde_json::to_string(config).expect("serialize config");
        let now = unix_millis();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO instances (id, created_at, config) VALUES (?1, ?2, ?3)",
            (id, now, json),
        )?;
        Ok(())
    }

    /// Replace an existing instance's config. Returns false if the id is unknown.
    pub fn update(&self, id: &str, config: &InstanceConfig) -> rusqlite::Result<bool> {
        let json = serde_json::to_string(config).expect("serialize config");
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE instances SET config = ?2 WHERE id = ?1",
            (id, json),
        )?;
        Ok(n > 0)
    }

    pub fn get(&self, id: &str) -> rusqlite::Result<Option<InstanceConfig>> {
        let conn = self.conn.lock().unwrap();
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

fn unix_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
