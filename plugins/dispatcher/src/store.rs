//! SQLite-backed registry of "permanent" messages — messages whose components
//! are exempt from the COMPONENT_TTL_DAYS expiry.
//!
//! Slots are managed from the DWEEB dashboard: the proxy (which holds the
//! Discord login and checks the user manages the guild) calls this service's
//! token-gated /permanent API. Each guild gets PERMANENT_SLOTS_PER_GUILD
//! slots. A handful of rows per guild, read only on already-expired clicks —
//! a single mutexed connection (the same pattern as modal-form's store)
//! serialises writers, which is also what makes the per-guild cap race-free.

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
                 ON permanent_messages (guild_id);",
        )?;
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
