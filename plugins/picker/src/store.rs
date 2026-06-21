//! SQLite-backed instance store.
//!
//! One table, one JSON blob per instance. The instance `id` is a 128-bit random
//! token that lives inside the component's `custom_id` — it is the *capability*
//! to read/replace this instance's config, so it must stay unguessable. A Picker
//! instance holds no secret (no bot token, no webhook), so reads need no masking;
//! [`MaskedInstance`] exists only to attach the `id` to the round-tripped config.

use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

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
    /// Whether the reply is ephemeral (only the picker sees it). Defaults true —
    /// a private "here's what you picked" confirmation, the safe, low-noise
    /// choice. Set false to announce the picks publicly in the channel.
    #[serde(default = "default_true")]
    pub ephemeral: bool,
    /// Whether a **public** reply should actually ping the picked users/roles
    /// (added to `allowed_mentions`). Ignored when [`ephemeral`](Self::ephemeral)
    /// (ephemeral messages never notify) and for a channel select (channels can't
    /// be pinged). Defaults false: picks render as names without pinging anyone.
    #[serde(default)]
    pub ping: bool,
    /// Optional heading rendered above the body (as a Markdown `### heading`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The reply text — Markdown plus `{picks}`/`{count}`/`{user}`/`{username}`/
    /// `{server}` tokens, substituted at pick time from the interaction payload.
    pub body: String,
}

fn default_true() -> bool {
    true
}

impl InstanceConfig {
    /// True when this instance is attached to the Channel select — the one kind
    /// whose picks (channels) can't be pinged.
    pub fn is_channel(&self) -> bool {
        self.target == TARGET_CHANNEL
    }
}

/// A read view for the config UI. Carries the instance `id` (which
/// [`InstanceConfig`] itself doesn't) and holds no secrets.
#[derive(Debug, Serialize)]
pub struct MaskedInstance {
    pub id: String,
    #[serde(flatten)]
    pub config: InstanceConfig,
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

    /// Insert a new instance under a fresh id.
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
}

fn unix_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
