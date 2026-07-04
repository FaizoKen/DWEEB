//! SQLite-backed instance store.
//!
//! Two tables. `instances` holds one JSON config blob per form, keyed by a
//! 128-bit random token that lives inside the component's `custom_id` — that id
//! is the *capability* to read/replace this instance's config, so it must stay
//! unguessable. Reads intended for the config UI mask the forward webhook (a
//! secret); see [`MaskedInstance`]. `submissions` records who has submitted each
//! form, but only when the form opts into "one response per person"
//! (`limit_one`) — it is the single bit of per-user state this plugin keeps.

use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// One configurable modal text field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModalField {
    /// Stable id; becomes the text input's `custom_id` and keys the submitted
    /// value. Generated once in the config UI and preserved across reorders, so
    /// reordering fields never reshuffles which answer is which.
    pub id: String,
    pub label: String,
    /// `"short"` (single line) or `"paragraph"` (multi-line).
    pub style: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    /// Text pre-filled into the input when the modal opens (Discord's `value`).
    /// Handy for templates ("Steps to reproduce:\n1. ") the member edits.
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
///
/// New fields are additive with serde defaults so configs written by an older
/// build keep deserializing: `include_submitter` defaults to the historical
/// behaviour (named submissions), the rest to "off / not set".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceConfig {
    pub modal: ModalDef,
    /// Discord incoming-webhook URL the submission is forwarded to. Secret.
    pub forward_webhook: String,
    /// Optional display name the forwarded message posts under (the webhook
    /// `username` override). None ⇒ the default "Modal Form".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forward_username: Option<String>,
    /// Whether the forwarded message names who submitted. False makes the form
    /// an anonymous suggestion/report box. Defaults true (legacy behaviour).
    #[serde(default = "default_true")]
    pub include_submitter: bool,
    /// When true, each member may submit only once: a second button click is
    /// turned away before the modal opens. Backed by the `submissions` table.
    #[serde(default)]
    pub limit_one: bool,
    pub reply: ReplyDef,
}

fn default_true() -> bool {
    true
}

/// A read view safe to hand back to the browser: the webhook is replaced by a
/// boolean so the secret never leaves the server. Everything else round-trips
/// so the config UI can repopulate exactly what was saved.
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
             CREATE TABLE IF NOT EXISTS submissions (
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
        self.conn
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// Insert a new instance under a fresh id, returning the id.
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

    /// Has this member already submitted this form? Only meaningful for forms
    /// with `limit_one`; callers gate on the config flag before asking.
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

    /// Record that a member submitted this form. Idempotent: a repeat is a
    /// no-op (`INSERT OR IGNORE` on the composite key), so a rapid double click
    /// can't error here.
    pub fn record_submission(&self, instance_id: &str, user_id: &str) -> rusqlite::Result<()> {
        let now = unix_millis();
        let conn = self.lock();
        conn.execute(
            "INSERT OR IGNORE INTO submissions (instance_id, user_id, created_at) VALUES (?1, ?2, ?3)",
            (instance_id, user_id, now),
        )?;
        Ok(())
    }
}

fn unix_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
