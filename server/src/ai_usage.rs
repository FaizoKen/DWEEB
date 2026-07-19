//! Usage ledger for the built-in AI assistant (see `ai.rs`).
//!
//! One tiny SQLite table of daily/monthly rollups keyed by scope:
//!   - `u:<uid>` + `YYYY-MM-DD` — a user's daily consumption (the Free
//!     allowance, and the per-member ceiling inside a paid server's pool);
//!   - `g:<guild>` + `YYYY-MM-DD` — a server's pooled daily consumption
//!     (the Plus/Pro allowance);
//!   - `global` + `YYYY-MM`     — the whole deployment's monthly consumption,
//!     checked against `AI_MONTHLY_TOKEN_BUDGET` so the feature can never cost
//!     more than the number written in the env file.
//!
//! Quota checks read *before* the provider call and the completed request is
//! recorded *after* (one transaction across all three scopes), so a pair of
//! concurrent requests can overshoot a limit by at most the concurrency cap —
//! acceptable slack for a spend guard, and it keeps the hot path to two tiny
//! SQLite touches. Rows are pruned on a timer once they can no longer bind any
//! check (day rows after ~35 days, month rows after ~3 months).

use std::path::Path;

use rusqlite::Connection;

use crate::sqlite_pool::SqlitePool;

/// How many days a daily row is kept before the sweeper reclaims it. Nothing
/// reads past "today", so this is purely observability headroom.
const DAY_RETENTION_DAYS: i64 = 35;
/// How many months a monthly (`global`) row is kept.
const MONTH_RETENTION_MONTHS: i64 = 3;

/// A scope's consumption within one period. Zero when no row exists yet.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UsageRow {
    pub requests: i64,
    pub tokens: i64,
}

pub struct AiUsageStore {
    pool: SqlitePool,
}

impl AiUsageStore {
    /// Open (creating if needed) the ledger. Errors are fatal to the caller —
    /// a deployment that promises AI quotas must be able to count them.
    pub fn open(path: &str) -> Result<Self, String> {
        if let Some(parent) = Path::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
            }
        }
        let pool = SqlitePool::open_default(path, |c: &Connection| {
            c.pragma_update(None, "journal_mode", "WAL")
                .map_err(|e| format!("journal_mode: {e}"))?;
            c.pragma_update(None, "synchronous", "NORMAL")
                .map_err(|e| format!("synchronous: {e}"))?;
            c.pragma_update(None, "busy_timeout", 5_000)
                .map_err(|e| format!("busy_timeout: {e}"))?;
            Ok(())
        })?;
        {
            let conn = pool.get();
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS ai_usage (
                     scope      TEXT NOT NULL,
                     period     TEXT NOT NULL,
                     requests   INTEGER NOT NULL DEFAULT 0,
                     tokens_in  INTEGER NOT NULL DEFAULT 0,
                     tokens_out INTEGER NOT NULL DEFAULT 0,
                     PRIMARY KEY (scope, period)
                 );",
            )
            .map_err(|e| format!("schema: {e}"))?;
        }
        Ok(AiUsageStore { pool })
    }

    /// Cheap connectivity probe for the readiness endpoint.
    pub fn ping(&self) -> Result<(), String> {
        self.pool.ping()
    }

    /// One scope's consumption in `period` (zeros when it has none yet).
    pub fn read(&self, scope: &str, period: &str) -> Result<UsageRow, String> {
        let conn = self.pool.get();
        let mut stmt = conn
            .prepare_cached(
                "SELECT requests, tokens_in + tokens_out FROM ai_usage
                 WHERE scope = ?1 AND period = ?2",
            )
            .map_err(|e| e.to_string())?;
        stmt.query_row(rusqlite::params![scope, period], |r| {
            Ok(UsageRow {
                requests: r.get(0)?,
                tokens: r.get(1)?,
            })
        })
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(UsageRow::default()),
            other => Err(other.to_string()),
        })
    }

    /// Record one completed request against every scope it consumes, in a
    /// single transaction so a crash can't count it against one scope but not
    /// another.
    pub fn record(
        &self,
        entries: &[(String, String)],
        tokens_in: i64,
        tokens_out: i64,
    ) -> Result<(), String> {
        let mut conn = self.pool.get();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut stmt = tx
                .prepare_cached(
                    "INSERT INTO ai_usage (scope, period, requests, tokens_in, tokens_out)
                     VALUES (?1, ?2, 1, ?3, ?4)
                     ON CONFLICT(scope, period) DO UPDATE SET
                         requests   = requests + 1,
                         tokens_in  = tokens_in + excluded.tokens_in,
                         tokens_out = tokens_out + excluded.tokens_out",
                )
                .map_err(|e| e.to_string())?;
            for (scope, period) in entries {
                stmt.execute(rusqlite::params![
                    scope,
                    period,
                    tokens_in.max(0),
                    tokens_out.max(0)
                ])
                .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// Reclaim rows too old to bind any quota check; returns how many went.
    /// Daily periods are `YYYY-MM-DD` (length 10), monthly are `YYYY-MM`
    /// (length 7) — the length filter keeps a lexicographic day-cutoff compare
    /// from eating the current month row.
    pub fn sweep(&self, day_cutoff: &str, month_cutoff: &str) -> Result<usize, String> {
        let conn = self.pool.get();
        let days = conn
            .execute(
                "DELETE FROM ai_usage WHERE length(period) = 10 AND period < ?1",
                rusqlite::params![day_cutoff],
            )
            .map_err(|e| e.to_string())?;
        let months = conn
            .execute(
                "DELETE FROM ai_usage WHERE length(period) = 7 AND period < ?1",
                rusqlite::params![month_cutoff],
            )
            .map_err(|e| e.to_string())?;
        Ok(days + months)
    }
}

/// Today's UTC day key (`YYYY-MM-DD`). Quota windows reset at midnight UTC —
/// cheap to compute and easy to communicate ("resets at midnight UTC").
pub fn utc_day(now: i64) -> String {
    chrono::DateTime::from_timestamp(now, 0)
        .unwrap_or_default()
        .format("%Y-%m-%d")
        .to_string()
}

/// This UTC month's key (`YYYY-MM`), used by the global budget row.
pub fn utc_month(now: i64) -> String {
    chrono::DateTime::from_timestamp(now, 0)
        .unwrap_or_default()
        .format("%Y-%m")
        .to_string()
}

/// The Unix time the daily window rolls over (next midnight UTC) — surfaced to
/// the FE so an exhausted meter can show a real countdown.
pub fn next_utc_midnight(now: i64) -> i64 {
    (now.div_euclid(86_400) + 1) * 86_400
}

/// The sweeper's cutoff keys for `now`.
pub fn sweep_cutoffs(now: i64) -> (String, String) {
    (
        utc_day(now - DAY_RETENTION_DAYS * 86_400),
        utc_month(now - MONTH_RETENTION_MONTHS * 31 * 86_400),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(tag: &str) -> (AiUsageStore, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "dweeb-ai-usage-test-{}-{tag}.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let store = AiUsageStore::open(path.to_str().unwrap()).unwrap();
        (store, path)
    }

    #[test]
    fn record_accumulates_across_scopes_in_one_call() {
        let (store, path) = temp_store("record");
        let entries = vec![
            ("u:1".to_string(), "2026-07-19".to_string()),
            ("g:2".to_string(), "2026-07-19".to_string()),
            ("global".to_string(), "2026-07".to_string()),
        ];
        store.record(&entries, 8_000, 1_500).unwrap();
        store.record(&entries, 2_000, 500).unwrap();

        for scope in ["u:1", "g:2"] {
            let row = store.read(scope, "2026-07-19").unwrap();
            assert_eq!(row.requests, 2, "{scope}");
            assert_eq!(row.tokens, 12_000, "{scope}");
        }
        let global = store.read("global", "2026-07").unwrap();
        assert_eq!(global.requests, 2);
        assert_eq!(global.tokens, 12_000);
        // An unseen scope/period reads as zero, not an error.
        assert_eq!(
            store.read("u:1", "2026-07-20").unwrap(),
            UsageRow::default()
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sweep_reclaims_old_rows_but_keeps_the_current_month() {
        let (store, path) = temp_store("sweep");
        let entries = vec![
            ("u:1".to_string(), "2026-06-01".to_string()),
            ("u:1".to_string(), "2026-07-19".to_string()),
            ("global".to_string(), "2026-05".to_string()),
            ("global".to_string(), "2026-07".to_string()),
        ];
        for (scope, period) in &entries {
            store
                .record(&[(scope.clone(), period.clone())], 10, 10)
                .unwrap();
        }

        // Day cutoff between the two day rows; month cutoff between the months.
        // The lexicographically-smaller "2026-07" month row must survive a
        // "2026-07-14" day cutoff (the length filter's whole point).
        let swept = store.sweep("2026-07-14", "2026-06").unwrap();
        assert_eq!(swept, 2);
        assert_eq!(store.read("u:1", "2026-07-19").unwrap().requests, 1);
        assert_eq!(store.read("global", "2026-07").unwrap().requests, 1);
        assert_eq!(store.read("u:1", "2026-06-01").unwrap().requests, 0);
        assert_eq!(store.read("global", "2026-05").unwrap().requests, 0);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn period_helpers_are_utc_and_stable() {
        // 2026-07-19 12:00:00 UTC
        let now = 1_784_462_400;
        assert_eq!(utc_day(now), "2026-07-19");
        assert_eq!(utc_month(now), "2026-07");
        assert_eq!(next_utc_midnight(now) % 86_400, 0);
        assert!(next_utc_midnight(now) > now);
        assert!(next_utc_midnight(now) - now <= 86_400);
    }
}
