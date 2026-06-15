//! SQLite-backed instance store.
//!
//! One table, one JSON blob per instance. The instance `id` is a 128-bit random
//! token that lives inside the component's `custom_id` — it is the *capability*
//! to read/replace this instance's config, so it must stay unguessable. A quick
//! reply holds no secret (no bot token, no webhook), so reads need no masking;
//! [`MaskedInstance`] exists only to attach the `id` to the round-tripped config.

use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

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
