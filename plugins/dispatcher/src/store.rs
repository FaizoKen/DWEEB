//! SQLite-backed registry of "permanent" messages — messages whose components
//! are exempt from the COMPONENT_TTL_DAYS expiry — and of "custom apps":
//! guild-registered Discord applications whose interactions this dispatcher
//! also serves (verified with each app's own public key).
//!
//! Both are managed from the DWEEB dashboard: the proxy (which holds the
//! Discord login and checks the user manages the guild) calls this service's
//! token-gated /permanent and /custom-apps APIs. Each guild gets
//! PERMANENT_SLOTS_PER_GUILD slots and CUSTOM_APPS_PER_GUILD registrations.
//! A handful of rows per guild, never read on the interaction hot path (the
//! custom-app keys live in an in-memory map, see main.rs) — a single mutexed
//! connection (the same pattern as modal-form's store) serialises writers,
//! which is also what makes the per-guild caps race-free.

use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension};

/// One permanent message, as listed back to the dashboard.
pub struct PermanentRow {
    pub message_id: String,
    pub channel_id: String,
    pub added_at: i64,
}

pub enum Add {
    Added,
    /// Already permanent — adding again is a no-op, not an error.
    Already,
    /// Every slot is taken.
    Full,
}

/// One guild-registered custom application, as listed back to the dashboard.
pub struct CustomAppRow {
    pub application_id: String,
    pub name: String,
    pub added_at: i64,
    /// Whether a (proxy-sealed) client secret is on file — what makes the
    /// one-click "create webhook from this bot" flow available. The secret
    /// itself is never listed.
    pub has_secret: bool,
}

pub enum AddApp {
    /// Registered — or re-registered by the same guild, which refreshes the
    /// public key and name in place (the fix path for a mistyped key).
    Added,
    /// Every registration the guild's quota allows is taken.
    Full,
    /// The application is already registered by a *different* guild — an
    /// application id maps to exactly one verifying key, so it can only ever
    /// belong to one guild at a time.
    Taken,
}

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &str) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS permanent_messages (
                 message_id  TEXT PRIMARY KEY,
                 guild_id    TEXT NOT NULL,
                 channel_id  TEXT NOT NULL,
                 added_by    TEXT NOT NULL,
                 added_at    INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_permanent_guild
                 ON permanent_messages (guild_id);
             CREATE TABLE IF NOT EXISTS custom_apps (
                 application_id    TEXT PRIMARY KEY,
                 guild_id          TEXT NOT NULL,
                 public_key        TEXT NOT NULL,
                 name              TEXT NOT NULL DEFAULT '',
                 client_secret_enc TEXT NOT NULL DEFAULT '',
                 added_by          TEXT NOT NULL,
                 added_at          INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_custom_apps_guild
                 ON custom_apps (guild_id);",
        )?;
        // Migration for databases created before the client-secret column.
        // The duplicate-column error on an already-migrated file is expected.
        let _ = conn.execute(
            "ALTER TABLE custom_apps ADD COLUMN client_secret_enc TEXT NOT NULL DEFAULT ''",
            [],
        );
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Is this message exempt from component expiry? A read error counts as
    /// "no" — the gate fails toward expiry, never toward unlimited validity.
    pub fn is_permanent(&self, message_id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT 1 FROM permanent_messages WHERE message_id = ?1",
            [message_id],
            |_| Ok(()),
        )
        .optional()
        .unwrap_or_else(|err| {
            tracing::error!(%err, "permanent lookup failed");
            None
        })
        .is_some()
    }

    /// A guild's permanent messages, oldest grant first.
    pub fn list(&self, guild_id: &str) -> rusqlite::Result<Vec<PermanentRow>> {
        let conn = self.conn.lock().unwrap();
        Self::list_locked(&conn, guild_id)
    }

    /// Spend one of the guild's `cap` slots on a message. The whole
    /// check-then-insert runs under the connection lock, so two concurrent
    /// adds can't oversubscribe the cap.
    pub fn add(
        &self,
        guild_id: &str,
        channel_id: &str,
        message_id: &str,
        added_by: &str,
        cap: u32,
    ) -> rusqlite::Result<Add> {
        let conn = self.conn.lock().unwrap();
        let already: Option<()> = conn
            .query_row(
                "SELECT 1 FROM permanent_messages WHERE message_id = ?1 AND guild_id = ?2",
                (message_id, guild_id),
                |_| Ok(()),
            )
            .optional()?;
        if already.is_some() {
            return Ok(Add::Already);
        }
        let used: u32 = conn.query_row(
            "SELECT COUNT(*) FROM permanent_messages WHERE guild_id = ?1",
            [guild_id],
            |r| r.get(0),
        )?;
        if used >= cap {
            return Ok(Add::Full);
        }
        conn.execute(
            "INSERT INTO permanent_messages (message_id, guild_id, channel_id, added_by, added_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            (message_id, guild_id, channel_id, added_by, unix_millis()),
        )?;
        Ok(Add::Added)
    }

    /// Give a slot back. Scoped to the guild so a forged id can never touch
    /// another guild's slots. False when nothing matched.
    pub fn remove(&self, guild_id: &str, message_id: &str) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "DELETE FROM permanent_messages WHERE message_id = ?1 AND guild_id = ?2",
            (message_id, guild_id),
        )?;
        Ok(n > 0)
    }

    // ── Custom apps ─────────────────────────────────────────────────────────

    /// Every registered custom app's `(application_id, public_key)` — loaded
    /// once at boot to seed the in-memory key map the hot path verifies with.
    pub fn custom_apps_all(&self) -> rusqlite::Result<Vec<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT application_id, public_key FROM custom_apps")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// A guild's registered custom apps, oldest registration first.
    pub fn custom_apps_list(&self, guild_id: &str) -> rusqlite::Result<Vec<CustomAppRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT application_id, name, added_at, client_secret_enc <> '' FROM custom_apps
             WHERE guild_id = ?1 ORDER BY added_at",
        )?;
        let rows = stmt
            .query_map([guild_id], |r| {
                Ok(CustomAppRow {
                    application_id: r.get(0)?,
                    name: r.get(1)?,
                    added_at: r.get(2)?,
                    has_secret: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// The sealed client secret for one of the guild's apps. Scoped to the
    /// guild so the proxy's per-guild authorization maps one-to-one. `None`
    /// when the app isn't registered to that guild; an empty string when it
    /// is but no secret was stored.
    pub fn custom_app_secret(
        &self,
        guild_id: &str,
        application_id: &str,
    ) -> rusqlite::Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT client_secret_enc FROM custom_apps
             WHERE application_id = ?1 AND guild_id = ?2",
            (application_id, guild_id),
            |r| r.get(0),
        )
        .optional()
    }

    /// Register a custom app under one of the guild's `cap` quota slots. The
    /// whole check-then-insert runs under the connection lock, so two
    /// concurrent adds can't oversubscribe the cap. Re-adding an app the same
    /// guild already registered updates its key + name in place without
    /// spending a new slot.
    #[allow(clippy::too_many_arguments)]
    pub fn custom_app_add(
        &self,
        guild_id: &str,
        application_id: &str,
        public_key: &str,
        name: &str,
        client_secret_enc: &str,
        added_by: &str,
        cap: u32,
    ) -> rusqlite::Result<AddApp> {
        let conn = self.conn.lock().unwrap();
        let owner: Option<String> = conn
            .query_row(
                "SELECT guild_id FROM custom_apps WHERE application_id = ?1",
                [application_id],
                |r| r.get(0),
            )
            .optional()?;
        match owner.as_deref() {
            Some(g) if g == guild_id => {
                conn.execute(
                    "UPDATE custom_apps SET public_key = ?1, name = ?2, client_secret_enc = ?3
                     WHERE application_id = ?4",
                    (public_key, name, client_secret_enc, application_id),
                )?;
                return Ok(AddApp::Added);
            }
            Some(_) => return Ok(AddApp::Taken),
            None => {}
        }
        let used: u32 = conn.query_row(
            "SELECT COUNT(*) FROM custom_apps WHERE guild_id = ?1",
            [guild_id],
            |r| r.get(0),
        )?;
        if used >= cap {
            return Ok(AddApp::Full);
        }
        conn.execute(
            "INSERT INTO custom_apps
                 (application_id, guild_id, public_key, name, client_secret_enc, added_by, added_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            (
                application_id,
                guild_id,
                public_key,
                name,
                client_secret_enc,
                added_by,
                unix_millis(),
            ),
        )?;
        Ok(AddApp::Added)
    }

    /// Unregister a custom app. Scoped to the guild so a forged id can never
    /// touch another guild's registration. False when nothing matched.
    pub fn custom_app_remove(
        &self,
        guild_id: &str,
        application_id: &str,
    ) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "DELETE FROM custom_apps WHERE application_id = ?1 AND guild_id = ?2",
            (application_id, guild_id),
        )?;
        Ok(n > 0)
    }

    fn list_locked(conn: &Connection, guild_id: &str) -> rusqlite::Result<Vec<PermanentRow>> {
        let mut stmt = conn.prepare(
            "SELECT message_id, channel_id, added_at FROM permanent_messages
             WHERE guild_id = ?1 ORDER BY added_at",
        )?;
        let rows = stmt
            .query_map([guild_id], |r| {
                Ok(PermanentRow {
                    message_id: r.get(0)?,
                    channel_id: r.get(1)?,
                    added_at: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
}

fn unix_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
