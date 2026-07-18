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
    /// Paused because the guild is over its current plan cap. The row (and its
    /// slot) is kept; its components simply revert to normal TTL expiry until
    /// the guild re-upgrades and the proxy reconciles it back to active.
    pub suspended: bool,
}

/// The grant behind one permanent message — which guild spent the slot, who
/// clicked, and when. What "Message Info" reports.
pub struct PermanentDetails {
    pub guild_id: String,
    pub added_by: String,
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
    /// Unix millis when this dispatcher first received a validly-signed
    /// interaction for the app, or `None` if it never has. A non-null value
    /// proves end-to-end that the owner set the Interactions Endpoint URL to
    /// this dispatcher *and* registered the correct public key — Discord only
    /// delivers (and we only record) interactions whose signature verifies.
    pub verified_at: Option<i64>,
    /// Paused because the guild is over its current plan cap. The registration
    /// is kept but pulled from the interaction verify map, so its bot stops
    /// being served until the guild re-upgrades.
    pub suspended: bool,
    /// Whether an Activity webhook is on file for this app — the app-owned
    /// incoming webhook (token proxy-sealed, see [`CustomAppHook`]) that lets
    /// the embedded Activity post/update under this bot's identity. The
    /// credential itself is never listed.
    pub has_hook: bool,
}

/// The Activity webhook stored on a custom-app registration: an incoming
/// webhook owned by *that* app, captured by the proxy during the one-time
/// `webhook.incoming` connect flow. `token_enc` is sealed under the proxy's
/// key — opaque ciphertext here, exactly like the client secret — and
/// `channel_id` is only the channel it was last seen in (the proxy re-reads
/// the live channel from Discord before every use).
pub struct CustomAppHook {
    pub hook_id: String,
    pub channel_id: String,
    pub token_enc: String,
    /// Mirrors the registration's plan-suspension state so the proxy can
    /// refuse posting under an over-cap bot without a second lookup.
    pub suspended: bool,
}

/// The verify-map deltas a [`Store::reconcile_custom_apps`] pass produced, so the
/// caller can keep the in-memory key map in lockstep with the suspend state.
pub struct AppReconcile {
    /// Apps to (re)insert into the verify map — `(application_id, public_key)`.
    pub activate: Vec<(String, String)>,
    /// Apps to drop from the verify map — `application_id`.
    pub suspend: Vec<String>,
    pub active_count: u32,
    pub suspended_count: u32,
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
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
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
                 ON custom_apps (guild_id);
             CREATE TABLE IF NOT EXISTS guild_caps (
                 guild_id   TEXT NOT NULL,
                 feature    TEXT NOT NULL,
                 cap        INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 PRIMARY KEY (guild_id, feature)
             );",
        )?;
        // Migration for databases created before the client-secret column.
        // The duplicate-column error on an already-migrated file is expected.
        let _ = conn.execute(
            "ALTER TABLE custom_apps ADD COLUMN client_secret_enc TEXT NOT NULL DEFAULT ''",
            [],
        );
        // Migration for the "first verified interaction" timestamp (nullable —
        // an unverified app simply has no value). Same expected duplicate-column
        // error on an already-migrated file.
        let _ = conn.execute("ALTER TABLE custom_apps ADD COLUMN verified_at INTEGER", []);
        // Migration for plan-suspension (nullable — NULL = active, a millis
        // timestamp = paused because the guild is over its current plan cap).
        // The proxy reconciles these on any entitlement change (see
        // `reconcile_permanent` / `reconcile_custom_apps`); a suspended row keeps
        // all its data but stops delivering its benefit until the guild re-upgrades.
        let _ = conn.execute(
            "ALTER TABLE permanent_messages ADD COLUMN suspended_at INTEGER",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE custom_apps ADD COLUMN suspended_at INTEGER",
            [],
        );
        // Migration for the Activity webhook (see [`CustomAppHook`]): the
        // app-owned incoming webhook the embedded Activity posts through.
        // Empty strings = none connected. Same expected duplicate-column error
        // on an already-migrated file.
        let _ = conn.execute(
            "ALTER TABLE custom_apps ADD COLUMN hook_id TEXT NOT NULL DEFAULT ''",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE custom_apps ADD COLUMN hook_channel_id TEXT NOT NULL DEFAULT ''",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE custom_apps ADD COLUMN hook_token_enc TEXT NOT NULL DEFAULT ''",
            [],
        );
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Is this message exempt from component expiry? A read error counts as
    /// "no" — the gate fails toward expiry, never toward unlimited validity.
    /// A **suspended** grant (guild over its plan cap) counts as "no" too, so a
    /// downgraded server's over-cap permanent messages expire normally until it
    /// re-upgrades.
    pub fn is_permanent(&self, message_id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT 1 FROM permanent_messages WHERE message_id = ?1 AND suspended_at IS NULL",
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

    /// The grant behind a permanent message, if any. `None` on a read error
    /// too — same fail-toward-expiry bias as [`Self::is_permanent`], and the
    /// caller (Message Info) then reports the message as a regular one.
    pub fn permanent_details(&self, message_id: &str) -> Option<PermanentDetails> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT guild_id, added_by, added_at FROM permanent_messages WHERE message_id = ?1",
            [message_id],
            |r| {
                Ok(PermanentDetails {
                    guild_id: r.get(0)?,
                    added_by: r.get(1)?,
                    added_at: r.get(2)?,
                })
            },
        )
        .optional()
        .unwrap_or_else(|err| {
            tracing::error!(%err, "permanent lookup failed");
            None
        })
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
        // Only *active* grants consume quota — suspended (over-cap) rows are
        // parked and don't count, so a server can always fill up to its cap in
        // live slots regardless of how many paused rows it carries.
        let used: u32 = conn.query_row(
            "SELECT COUNT(*) FROM permanent_messages WHERE guild_id = ?1 AND suspended_at IS NULL",
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

    // ── Per-guild plan caps ──────────────────────────────────────────────────
    //
    // The proxy owns entitlement (Stripe); it passes the guild's plan cap as
    // `?cap=N` on every capped management call and reconcile. We remember it here
    // so the ONE path that never reaches the proxy — the Message Info "never
    // expire" toggle, a Discord interaction that lands straight on this service —
    // can still honour the guild's plan instead of this deployment's env default.

    /// Remember the plan cap the proxy last asserted for `guild_id` + `feature`
    /// (`"permanent"` / `"custom_apps"`). Only rewrites when the value actually
    /// changed, so a run of identical caps (every dashboard load re-sends one)
    /// doesn't churn the WAL.
    pub fn set_guild_cap(&self, guild_id: &str, feature: &str, cap: u32) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO guild_caps (guild_id, feature, cap, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(guild_id, feature) DO UPDATE
                 SET cap = excluded.cap, updated_at = excluded.updated_at
                 WHERE guild_caps.cap <> excluded.cap",
            (guild_id, feature, cap, unix_millis()),
        )?;
        Ok(())
    }

    /// The plan cap last asserted by the proxy for `guild_id` + `feature`, or
    /// `None` when none has been recorded — a standalone (plan-disabled) proxy,
    /// or a guild the proxy hasn't reported on since it upgraded. The caller then
    /// falls back to the env default. A read error is treated as "unknown" too,
    /// so a storage hiccup can never grant more than the safe default.
    pub fn guild_cap(&self, guild_id: &str, feature: &str) -> Option<u32> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT cap FROM guild_caps WHERE guild_id = ?1 AND feature = ?2",
            (guild_id, feature),
            |r| r.get::<_, i64>(0),
        )
        .optional()
        .unwrap_or_else(|err| {
            tracing::error!(%err, "guild cap lookup failed");
            None
        })
        .map(|c| c.max(0) as u32)
    }

    // ── Custom apps ─────────────────────────────────────────────────────────

    /// Every *active* registered custom app's `(application_id, public_key)` —
    /// loaded once at boot to seed the in-memory key map the hot path verifies
    /// with. Suspended (over-cap) registrations are excluded, so a downgraded
    /// server's parked bots stay unserved across a restart until reconciled back.
    pub fn custom_apps_all(&self) -> rusqlite::Result<Vec<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT application_id, public_key FROM custom_apps WHERE suspended_at IS NULL",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// A guild's registered custom apps, oldest registration first.
    pub fn custom_apps_list(&self, guild_id: &str) -> rusqlite::Result<Vec<CustomAppRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT application_id, name, added_at, client_secret_enc <> '', verified_at, suspended_at,
                    hook_id <> ''
             FROM custom_apps WHERE guild_id = ?1 ORDER BY added_at",
        )?;
        let rows = stmt
            .query_map([guild_id], |r| {
                Ok(CustomAppRow {
                    application_id: r.get(0)?,
                    name: r.get(1)?,
                    added_at: r.get(2)?,
                    has_secret: r.get(3)?,
                    verified_at: r.get(4)?,
                    suspended: r.get::<_, Option<i64>>(5)?.is_some(),
                    has_hook: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    // ── Activity webhook (per registration) ────────────────────────────────

    /// The Activity webhook stored on one of the guild's apps. `None` when the
    /// app isn't registered to that guild; a hook with an empty `hook_id` when
    /// it is but nothing is connected yet (the caller distinguishes the two).
    pub fn custom_app_hook(
        &self,
        guild_id: &str,
        application_id: &str,
    ) -> rusqlite::Result<Option<CustomAppHook>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT hook_id, hook_channel_id, hook_token_enc, suspended_at
             FROM custom_apps WHERE application_id = ?1 AND guild_id = ?2",
            (application_id, guild_id),
            |r| {
                Ok(CustomAppHook {
                    hook_id: r.get(0)?,
                    channel_id: r.get(1)?,
                    token_enc: r.get(2)?,
                    suspended: r.get::<_, Option<i64>>(3)?.is_some(),
                })
            },
        )
        .optional()
    }

    /// Store (or replace) the Activity webhook on one of the guild's apps.
    /// False when the app isn't registered to that guild — the credential is
    /// only ever attached to an existing registration, never creates one.
    pub fn custom_app_hook_set(
        &self,
        guild_id: &str,
        application_id: &str,
        hook_id: &str,
        channel_id: &str,
        token_enc: &str,
    ) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE custom_apps SET hook_id = ?1, hook_channel_id = ?2, hook_token_enc = ?3
             WHERE application_id = ?4 AND guild_id = ?5",
            (hook_id, channel_id, token_enc, application_id, guild_id),
        )?;
        Ok(n > 0)
    }

    /// Drop the Activity webhook from one of the guild's apps (the proxy calls
    /// this when Discord reports the webhook gone, or its sealed token can no
    /// longer be opened). False when the app isn't registered to that guild.
    pub fn custom_app_hook_clear(
        &self,
        guild_id: &str,
        application_id: &str,
    ) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE custom_apps SET hook_id = '', hook_channel_id = '', hook_token_enc = ''
             WHERE application_id = ?1 AND guild_id = ?2",
            (application_id, guild_id),
        )?;
        Ok(n > 0)
    }

    /// Record the first validly-signed interaction seen for an app. Writes only
    /// when `verified_at` is still null, so it captures the *first* time and is
    /// a cheap no-op afterwards. Returns whether a row was actually stamped.
    pub fn mark_custom_verified(&self, application_id: &str) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE custom_apps SET verified_at = ?1
             WHERE application_id = ?2 AND verified_at IS NULL",
            (unix_millis(), application_id),
        )?;
        Ok(n > 0)
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
        // Only active registrations consume quota (see `add` for the rationale).
        let used: u32 = conn.query_row(
            "SELECT COUNT(*) FROM custom_apps WHERE guild_id = ?1 AND suspended_at IS NULL",
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

    /// Reconcile a guild's custom-app registrations against its current plan
    /// `cap`, keeping the **oldest `cap`** active and suspending the rest (and
    /// reviving any that now fit). Mirrors [`Self::reconcile_permanent`] but
    /// also reports the verify-map deltas, because a suspended app must be
    /// pulled from (and a revived one pushed back into) the interaction hot
    /// path's in-memory key map — see the handler in `main.rs`.
    pub fn reconcile_custom_apps(
        &self,
        guild_id: &str,
        cap: u32,
    ) -> rusqlite::Result<AppReconcile> {
        let conn = self.conn.lock().unwrap();
        let now = unix_millis();
        // Which apps *should* be active after this pass = the oldest `cap`.
        let mut should_active = std::collections::HashSet::new();
        {
            let mut stmt = conn.prepare(
                "SELECT application_id FROM custom_apps
                 WHERE guild_id = ?1 ORDER BY added_at, application_id LIMIT ?2",
            )?;
            let ids =
                stmt.query_map(rusqlite::params![guild_id, cap], |r| r.get::<_, String>(0))?;
            for id in ids {
                should_active.insert(id?);
            }
        }
        // Read current state, diff against the target, and collect the map deltas.
        let mut activate = Vec::new();
        let mut suspend = Vec::new();
        {
            let mut stmt = conn.prepare(
                "SELECT application_id, public_key, suspended_at IS NOT NULL
                 FROM custom_apps WHERE guild_id = ?1",
            )?;
            let rows = stmt.query_map([guild_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, bool>(2)?,
                ))
            })?;
            for row in rows {
                let (app_id, public_key, is_suspended) = row?;
                let want_active = should_active.contains(&app_id);
                if want_active && is_suspended {
                    activate.push((app_id, public_key));
                } else if !want_active && !is_suspended {
                    suspend.push(app_id);
                }
            }
        }
        for (app_id, _) in &activate {
            conn.execute(
                "UPDATE custom_apps SET suspended_at = NULL WHERE application_id = ?1",
                [app_id],
            )?;
        }
        for app_id in &suspend {
            conn.execute(
                "UPDATE custom_apps SET suspended_at = ?1 WHERE application_id = ?2",
                rusqlite::params![now, app_id],
            )?;
        }
        let active_count: u32 = conn.query_row(
            "SELECT COUNT(*) FROM custom_apps WHERE guild_id = ?1 AND suspended_at IS NULL",
            [guild_id],
            |r| r.get(0),
        )?;
        let suspended_count: u32 = conn.query_row(
            "SELECT COUNT(*) FROM custom_apps WHERE guild_id = ?1 AND suspended_at IS NOT NULL",
            [guild_id],
            |r| r.get(0),
        )?;
        Ok(AppReconcile {
            activate,
            suspend,
            active_count,
            suspended_count,
        })
    }

    fn list_locked(conn: &Connection, guild_id: &str) -> rusqlite::Result<Vec<PermanentRow>> {
        let mut stmt = conn.prepare(
            "SELECT message_id, channel_id, added_at, suspended_at FROM permanent_messages
             WHERE guild_id = ?1 ORDER BY added_at",
        )?;
        let rows = stmt
            .query_map([guild_id], |r| {
                Ok(PermanentRow {
                    message_id: r.get(0)?,
                    channel_id: r.get(1)?,
                    added_at: r.get(2)?,
                    suspended: r.get::<_, Option<i64>>(3)?.is_some(),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Reconcile a guild's permanent messages against its current plan `cap`:
    /// keep the **oldest `cap`** active and suspend the rest, restoring any
    /// previously-suspended row that now fits. Idempotent — the same input
    /// always yields the same state, so it doubles as both the downgrade
    /// (suspend the overflow) and the re-upgrade (revive up to the new cap)
    /// path. Returns `(active, suspended)` counts after the pass.
    pub fn reconcile_permanent(&self, guild_id: &str, cap: u32) -> rusqlite::Result<(u32, u32)> {
        let conn = self.conn.lock().unwrap();
        let now = unix_millis();
        // Suspend every grant ranked at or beyond the cap (oldest first), and
        // clear suspension on those that now fit. Two guarded UPDATEs keep the
        // pass a no-op when nothing changed.
        conn.execute(
            "UPDATE permanent_messages SET suspended_at = ?1
             WHERE guild_id = ?2 AND suspended_at IS NULL AND message_id IN (
                 SELECT message_id FROM permanent_messages
                 WHERE guild_id = ?2 ORDER BY added_at, message_id LIMIT -1 OFFSET ?3
             )",
            rusqlite::params![now, guild_id, cap],
        )?;
        conn.execute(
            "UPDATE permanent_messages SET suspended_at = NULL
             WHERE guild_id = ?1 AND suspended_at IS NOT NULL AND message_id IN (
                 SELECT message_id FROM permanent_messages
                 WHERE guild_id = ?1 ORDER BY added_at, message_id LIMIT ?2
             )",
            rusqlite::params![guild_id, cap],
        )?;
        let active: u32 = conn.query_row(
            "SELECT COUNT(*) FROM permanent_messages WHERE guild_id = ?1 AND suspended_at IS NULL",
            [guild_id],
            |r| r.get(0),
        )?;
        let suspended: u32 = conn.query_row(
            "SELECT COUNT(*) FROM permanent_messages WHERE guild_id = ?1 AND suspended_at IS NOT NULL",
            [guild_id],
            |r| r.get(0),
        )?;
        Ok((active, suspended))
    }
}

fn unix_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        // A fresh in-memory DB per test — the migrations run in `open`.
        Store::open(":memory:").unwrap()
    }

    // Snowflake-shaped ids, oldest first (add stamps added_at at insert time, so
    // insertion order is age order; the id also tiebreaks a shared millisecond).
    fn perm(s: &Store, guild: &str, msg: &str) {
        assert!(matches!(
            s.add(guild, "chan", msg, "someone", 1000).unwrap(),
            Add::Added
        ));
    }

    #[test]
    fn reconcile_permanent_keeps_oldest_and_suspends_overflow() {
        let s = store();
        for msg in ["100", "101", "102", "103", "104"] {
            perm(&s, "g1", msg);
        }
        // Downgrade to a cap of 2 → oldest two active, the rest paused.
        let (active, suspended) = s.reconcile_permanent("g1", 2).unwrap();
        assert_eq!((active, suspended), (2, 3));
        assert!(s.is_permanent("100"));
        assert!(s.is_permanent("101"));
        assert!(!s.is_permanent("102"));
        assert!(!s.is_permanent("104"));

        // Re-upgrade to 4 → oldest four active again (revived), one still paused.
        let (active, suspended) = s.reconcile_permanent("g1", 4).unwrap();
        assert_eq!((active, suspended), (4, 1));
        assert!(s.is_permanent("103"));
        assert!(!s.is_permanent("104"));

        // Unlimited → everything active.
        let (active, suspended) = s.reconcile_permanent("g1", u32::MAX).unwrap();
        assert_eq!((active, suspended), (5, 0));
        assert!(s.is_permanent("104"));
    }

    #[test]
    fn suspended_permanent_slots_free_up_quota_for_new_adds() {
        let s = store();
        for msg in ["100", "101", "102"] {
            perm(&s, "g1", msg);
        }
        s.reconcile_permanent("g1", 1).unwrap(); // 1 active, 2 paused
                                                 // A cap-1 add still can't go through — the one active grant fills it.
        assert!(matches!(
            s.add("g1", "c", "200", "u", 1).unwrap(),
            Add::Full
        ));
        // But removing the active one frees the single slot for a fresh grant;
        // the paused rows stay parked (they revive only on re-upgrade).
        assert!(s.remove("g1", "100").unwrap());
        assert!(matches!(
            s.add("g1", "c", "200", "u", 1).unwrap(),
            Add::Added
        ));
    }

    #[test]
    fn reconcile_custom_apps_reports_map_deltas() {
        let s = store();
        let key = "a".repeat(64); // shape-only; the store never parses it
        for id in ["100", "101", "102"] {
            assert!(matches!(
                s.custom_app_add("g1", id, &key, "bot", "", "u", 1000)
                    .unwrap(),
                AddApp::Added
            ));
        }
        // Cap 1 → suspend the two newest; the delta names them for the key map.
        let d = s.reconcile_custom_apps("g1", 1).unwrap();
        assert_eq!((d.active_count, d.suspended_count), (1, 2));
        assert!(d.activate.is_empty());
        let mut suspended = d.suspend.clone();
        suspended.sort();
        assert_eq!(suspended, vec!["101".to_string(), "102".to_string()]);
        // The boot map query now omits the suspended pair.
        assert_eq!(s.custom_apps_all().unwrap().len(), 1);

        // Re-upgrade → the two revive, and the delta hands their keys back.
        let d = s.reconcile_custom_apps("g1", 5).unwrap();
        assert_eq!((d.active_count, d.suspended_count), (3, 0));
        let mut revived: Vec<_> = d.activate.iter().map(|(id, _)| id.clone()).collect();
        revived.sort();
        assert_eq!(revived, vec!["101".to_string(), "102".to_string()]);
        assert!(d.suspend.is_empty());
        assert_eq!(s.custom_apps_all().unwrap().len(), 3);
    }

    #[test]
    fn guild_cap_roundtrips_and_is_scoped_by_feature_and_guild() {
        let s = store();
        // Nothing recorded yet → unknown, so the caller uses its env default.
        assert_eq!(s.guild_cap("g1", "permanent"), None);

        // The proxy pushes a plan cap; we remember it per guild + feature.
        s.set_guild_cap("g1", "permanent", 25).unwrap();
        assert_eq!(s.guild_cap("g1", "permanent"), Some(25));
        // A different feature and a different guild are independent.
        assert_eq!(s.guild_cap("g1", "custom_apps"), None);
        assert_eq!(s.guild_cap("g2", "permanent"), None);

        // A later push (e.g. an upgrade) overwrites in place.
        s.set_guild_cap("g1", "permanent", 1_000_000).unwrap();
        assert_eq!(s.guild_cap("g1", "permanent"), Some(1_000_000));
        // A downgrade lowers it again — the Discord-direct path then caps lower.
        s.set_guild_cap("g1", "permanent", 5).unwrap();
        assert_eq!(s.guild_cap("g1", "permanent"), Some(5));
    }

    #[test]
    fn custom_app_hook_roundtrip_and_scoping() {
        let s = store();
        let key = "a".repeat(64);
        assert!(matches!(
            s.custom_app_add("g1", "100", &key, "bot", "", "u", 1000)
                .unwrap(),
            AddApp::Added
        ));

        // Unregistered app / wrong guild → no row at all.
        assert!(s.custom_app_hook("g1", "999").unwrap().is_none());
        assert!(s.custom_app_hook("g2", "100").unwrap().is_none());
        // Setting a hook never creates a registration.
        assert!(!s
            .custom_app_hook_set("g2", "100", "555", "42", "enc")
            .unwrap());
        assert!(!s
            .custom_app_hook_set("g1", "999", "555", "42", "enc")
            .unwrap());

        // Registered but nothing connected yet → empty hook fields.
        let empty = s.custom_app_hook("g1", "100").unwrap().unwrap();
        assert_eq!(empty.hook_id, "");
        assert!(!s.custom_apps_list("g1").unwrap()[0].has_hook);

        // Connect, read back, and the list reflects it.
        assert!(s
            .custom_app_hook_set("g1", "100", "555", "42", "enc")
            .unwrap());
        let hook = s.custom_app_hook("g1", "100").unwrap().unwrap();
        assert_eq!(
            (
                hook.hook_id.as_str(),
                hook.channel_id.as_str(),
                hook.token_enc.as_str()
            ),
            ("555", "42", "enc")
        );
        assert!(!hook.suspended);
        assert!(s.custom_apps_list("g1").unwrap()[0].has_hook);

        // Suspension state rides along on the hook read.
        s.reconcile_custom_apps("g1", 0).unwrap();
        assert!(s.custom_app_hook("g1", "100").unwrap().unwrap().suspended);
        s.reconcile_custom_apps("g1", 1).unwrap();

        // Re-registering the same app keeps the connected hook.
        assert!(matches!(
            s.custom_app_add("g1", "100", &key, "bot2", "sec", "u", 1000)
                .unwrap(),
            AddApp::Added
        ));
        assert_eq!(
            s.custom_app_hook("g1", "100").unwrap().unwrap().hook_id,
            "555"
        );

        // Clear drops the credential but keeps the registration; unregistering
        // removes the row (and the hook with it).
        assert!(s.custom_app_hook_clear("g1", "100").unwrap());
        assert_eq!(s.custom_app_hook("g1", "100").unwrap().unwrap().hook_id, "");
        assert!(s.custom_app_remove("g1", "100").unwrap());
        assert!(s.custom_app_hook("g1", "100").unwrap().is_none());
    }
}
