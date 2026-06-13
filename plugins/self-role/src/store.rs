//! SQLite-backed instance store.
//!
//! One table, one JSON blob per instance. The instance `id` is a 128-bit random
//! token that lives inside the component's `custom_id` — it is the *capability*
//! to read/replace this instance's config, so it must stay unguessable. Role
//! assignment always uses the deployment-wide shared bot (`BOT_TOKEN`), so no
//! secret is stored per instance and reads need no masking; see
//! [`MaskedInstance`].

use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// One role this menu manages. `name`/`color` are cached at save time purely so
/// the config UI and the confirmation messages can render nicely without a live
/// Discord fetch — the `id` is the only field that matters for assignment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagedRole {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Discord role colour as a 24-bit integer (0 = no colour). Cosmetic.
    #[serde(default)]
    pub color: u32,
}

/// How the instance replies to the member after a change (always ephemeral).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseDef {
    /// `"summary"` — auto-build "Added X, removed Y" from what changed.
    /// `"custom"` — show the admin's own `text` instead.
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

/// The full, stored configuration for one instance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceConfig {
    /// `"button"` or `"string_select"` — the component kind this binds to.
    pub target: String,
    /// The guild whose roles these ids belong to. Cross-checked against the
    /// interaction's guild at click time so a menu can't be reused elsewhere.
    pub guild_id: String,
    /// Cached guild name for the config UI. Cosmetic.
    #[serde(default)]
    pub guild_name: String,
    /// The roles this menu manages. Exactly one for a button; 1..=25 for a select.
    pub roles: Vec<ManagedRole>,
    /// `"toggle"` | `"add"` | `"remove"` | `"unique"`. See `apply_mode`.
    pub mode: String,
    #[serde(default)]
    pub response: ResponseDef,
}

/// A read view for the config UI. Carries the instance `id` (which
/// [`InstanceConfig`] itself doesn't) and holds no secrets — role assignment
/// uses the shared bot, so nothing here needs masking.
#[derive(Debug, Serialize)]
pub struct MaskedInstance {
    pub id: String,
    pub target: String,
    pub guild_id: String,
    pub guild_name: String,
    pub roles: Vec<ManagedRole>,
    pub mode: String,
    pub response: ResponseDef,
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

    /// Insert a new instance under a fresh id.
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
        let n = conn.execute("UPDATE instances SET config = ?2 WHERE id = ?1", (id, json))?;
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
