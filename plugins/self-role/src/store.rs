//! SQLite-backed instance store.
//!
//! Two tables. `instances` holds one JSON config blob per instance, keyed by a
//! 128-bit random token that lives inside the component's `custom_id` — that id
//! is the *capability* to read/replace this instance's config, so it must stay
//! unguessable. `grants` is the ledger for **temporary roles**: one row per
//! (instance, member, role) records when a self-granted role is due to be taken
//! back, which the background reaper drains. Role assignment always uses the
//! deployment-wide shared bot (`BOT_TOKEN`), so the only per-instance secret is
//! the optional audit-log webhook — masked on read; see [`MaskedInstance`].

use std::sync::Mutex;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

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

fn unix_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
