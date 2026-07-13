//! SQLite-backed instance store.
//!
//! Two tables. `instances` holds one JSON config blob per instance, keyed by the
//! opaque public id in the component's `custom_id`. A separate random edit token
//! authorizes replacement and only its SHA-256 digest is stored. `grants` is the
//! ledger for **temporary roles**: one row per
//! (instance, member, role) records when a self-granted role is due to be taken
//! back, which the background reaper drains. Role assignment always uses the
//! deployment-wide shared bot (`BOT_TOKEN`), so the only per-instance secret is
//! the optional audit-log webhook — masked on read; see [`MaskedInstance`].

use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// One role this menu manages. `name`/`color` are cached at save time purely so
/// the config UI and the confirmation messages can render nicely without a live
/// Discord fetch — the `id` is the only field that matters for assignment. The
/// optional `emoji`/`description` decorate the role's option on a string select
/// (DWEEB wires them onto the menu); they are ignored for a button.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagedRole {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Discord role colour as a 24-bit integer (0 = no colour). Cosmetic.
    #[serde(default)]
    pub color: u32,
    /// Select-option emoji: the unicode glyph (e.g. "🎨") or a custom emoji's
    /// name, paired with [`emoji_id`](Self::emoji_id) when custom. None = none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    /// Snowflake id of a custom guild emoji; None for a unicode emoji.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji_id: Option<String>,
    /// True only for an animated custom emoji.
    #[serde(default, skip_serializing_if = "is_false")]
    pub emoji_animated: bool,
    /// Optional subtitle shown under the option in the dropdown. ≤ 100 chars.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// A role referenced only by id (a requirement-gate role). `name`/`color` are
/// cached for the config UI; the `id` is what's intersected with the clicker's
/// roles at click time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleRef {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub color: u32,
}

/// Who may use this menu. Empty/zero fields mean "no restriction" — the menu is
/// open to everyone by default. Mirrors the giveaway plugin's `Requirements`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Requirement {
    /// Roles gating use. Empty = no role requirement.
    #[serde(default)]
    pub roles: Vec<RoleRef>,
    /// When true a member must hold **all** of `roles`; otherwise **any one**.
    #[serde(default)]
    pub require_all: bool,
    /// Minimum Discord account age in days (0 = no minimum). Derived from the
    /// member's user-id snowflake at click time — no Discord call needed.
    #[serde(default)]
    pub min_account_age_days: u32,
}

impl Requirement {
    /// True when nothing is gated — the common case, so the gate is skipped.
    pub fn is_open(&self) -> bool {
        self.roles.is_empty() && self.min_account_age_days == 0
    }
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
///
/// New fields are additive with serde defaults so configs written by an older
/// build keep deserializing. [`normalize`](Self::normalize) folds the legacy
/// `mode: "unique"` into the modern two-axis model.
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
    /// What a click *attempts*: `"toggle"` | `"add"` | `"remove"`. The legacy
    /// `"unique"` is migrated to `toggle` + `max = 1` by [`normalize`](Self::normalize).
    pub mode: String,
    /// The most managed roles a member may hold from this menu at once.
    /// `None` = unlimited. `Some(1)` = **swap / pick-one** (gaining one evicts
    /// the others). `Some(n≥2)` = a **cap** (an add beyond it is refused).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<u32>,
    /// Who may use this menu (role / account-age gate). Default = everyone.
    #[serde(default, skip_serializing_if = "Requirement::is_open")]
    pub requirement: Requirement,
    /// When set, a role granted through this menu is automatically taken back
    /// this many seconds later (the temporary-role reaper does the removal).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_after_secs: Option<u64>,
    /// Optional Discord incoming-webhook URL to post an audit line to on every
    /// change ("@user gained Red"). **Secret** — masked out of [`MaskedInstance`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_webhook: Option<String>,
    #[serde(default)]
    pub response: ResponseDef,
}

impl InstanceConfig {
    /// Fold legacy/loose values into the canonical model so the rest of the
    /// code only ever sees `toggle`/`add`/`remove` plus `max`. Idempotent.
    ///
    /// * `mode: "unique"` → `toggle` + `max = 1` (the old swap behaviour).
    /// * `max = Some(0)` → `None` (0 is meaningless; treat as no limit).
    pub fn normalize(&mut self) {
        if self.mode == "unique" {
            self.mode = "toggle".to_string();
            if self.max.is_none() {
                self.max = Some(1);
            }
        }
        if self.max == Some(0) {
            self.max = None;
        }
    }
}

/// A read view for the config UI. Carries the instance `id` (which
/// [`InstanceConfig`] itself doesn't) and replaces the audit-log webhook (a
/// secret) with a boolean so it never leaves the server.
#[derive(Debug, Serialize)]
pub struct MaskedInstance {
    pub id: String,
    pub target: String,
    pub guild_id: String,
    pub guild_name: String,
    pub roles: Vec<ManagedRole>,
    pub mode: String,
    pub max: Option<u32>,
    pub requirement: Requirement,
    pub expires_after_secs: Option<u64>,
    /// True when an audit-log webhook is configured (the URL itself is never
    /// returned to the browser).
    pub log_webhook_set: bool,
    pub response: ResponseDef,
}

impl MaskedInstance {
    pub fn from_config(id: String, cfg: InstanceConfig) -> Self {
        Self {
            id,
            target: cfg.target,
            guild_id: cfg.guild_id,
            guild_name: cfg.guild_name,
            roles: cfg.roles,
            mode: cfg.mode,
            max: cfg.max,
            requirement: cfg.requirement,
            expires_after_secs: cfg.expires_after_secs,
            log_webhook_set: cfg.log_webhook.is_some(),
            response: cfg.response,
        }
    }
}

/// One due temporary-role grant the reaper acts on.
#[derive(Debug, Clone)]
pub struct DueGrant {
    pub instance_id: String,
    pub guild_id: String,
    pub user_id: String,
    pub role_id: String,
}

pub struct Store {
    conn: Mutex<Connection>,
}

pub enum EditLookup {
    Authorized(Box<InstanceConfig>),
    Unknown,
    Forbidden,
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

    /// Load only when the separate edit credential matches. Migrated legacy
    /// rows carry a null digest and deliberately cannot be updated in place.
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
        match serde_json::from_str::<InstanceConfig>(&json) {
            Ok(mut config) => {
                config.normalize();
                Ok(EditLookup::Authorized(Box::new(config)))
            }
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

    /// Read an instance, normalized so callers only see the canonical model.
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
            Some(json) => serde_json::from_str::<InstanceConfig>(&json)
                .ok()
                .map(|mut c| {
                    c.normalize();
                    c
                }),
            None => None,
        })
    }

    // ── Temporary-role grant ledger ──────────────────────────────────────────

    /// Schedule (or reschedule) the automatic removal of one self-granted role.
    /// Upserting on the primary key means re-clicking a role simply restamps its
    /// expiry rather than piling up rows.
    pub fn upsert_grant(
        &self,
        instance_id: &str,
        guild_id: &str,
        user_id: &str,
        role_id: &str,
        expires_at_ms: i64,
    ) -> rusqlite::Result<()> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO grants (instance_id, guild_id, user_id, role_id, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(instance_id, user_id, role_id)
             DO UPDATE SET expires_at = excluded.expires_at, guild_id = excluded.guild_id",
            (instance_id, guild_id, user_id, role_id, expires_at_ms),
        )?;
        Ok(())
    }

    /// Forget a scheduled removal — the member gave the role back themselves (or
    /// a swap evicted it), so the reaper must not "remove" it again later.
    pub fn delete_grant(
        &self,
        instance_id: &str,
        user_id: &str,
        role_id: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.lock();
        conn.execute(
            "DELETE FROM grants WHERE instance_id = ?1 AND user_id = ?2 AND role_id = ?3",
            (instance_id, user_id, role_id),
        )?;
        Ok(())
    }

    /// The grants now due for removal, oldest first, capped at `limit`.
    pub fn due_grants(&self, now_ms: i64, limit: usize) -> rusqlite::Result<Vec<DueGrant>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT instance_id, guild_id, user_id, role_id
             FROM grants WHERE expires_at <= ?1
             ORDER BY expires_at ASC LIMIT ?2",
        )?;
        let rows = stmt.query_map((now_ms, limit as i64), |r| {
            Ok(DueGrant {
                instance_id: r.get(0)?,
                guild_id: r.get(1)?,
                user_id: r.get(2)?,
                role_id: r.get(3)?,
            })
        })?;
        rows.collect()
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
         CREATE TABLE IF NOT EXISTS grants (
             instance_id TEXT NOT NULL,
             guild_id    TEXT NOT NULL,
             user_id     TEXT NOT NULL,
             role_id     TEXT NOT NULL,
             expires_at  INTEGER NOT NULL,
             PRIMARY KEY (instance_id, user_id, role_id)
         );
         CREATE INDEX IF NOT EXISTS idx_grants_due ON grants(expires_at);",
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

    const TOKEN: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn config(name: &str) -> InstanceConfig {
        InstanceConfig {
            target: "button".into(),
            guild_id: "123456789012345678".into(),
            guild_name: "Guild".into(),
            roles: vec![ManagedRole {
                id: "123456789012345679".into(),
                name: name.into(),
                color: 0,
                emoji: None,
                emoji_id: None,
                emoji_animated: false,
                description: None,
            }],
            mode: "toggle".into(),
            max: None,
            requirement: Requirement::default(),
            expires_after_secs: None,
            log_webhook: Some("https://discord.com/api/webhooks/1/secret".into()),
            response: ResponseDef::default(),
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
        assert_eq!(store.get("one").unwrap().unwrap().roles[0].name, "After");
    }

    #[test]
    fn masked_view_never_serializes_the_webhook() {
        let json =
            serde_json::to_string(&MaskedInstance::from_config("one".into(), config("Safe")))
                .unwrap();
        assert!(!json.contains("secret"));
        assert!(!json.contains("discord.com/api/webhooks"));
        assert!(json.contains("log_webhook_set"));
    }
}
