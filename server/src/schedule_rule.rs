//! Recurrence rules and next-occurrence maths for scheduled posts.
//!
//! A schedule fires either **once** (an absolute instant chosen at creation) or
//! **repeatedly** on a wall-clock cadence — daily, on chosen weekdays, or on a
//! day of the month — at a fixed local time in a chosen IANA timezone. Computing
//! the next instant in a *timezone* (not a fixed interval) is what keeps "every
//! day at 9am" at 9am across DST: the offset shifts, the wall-clock time doesn't.
//!
//! [`next_after`] is a pure function of `(rule, tz, after)`: it never reads the
//! clock, so the worker decides "after what" (always `now`, never the missed
//! slot — see the catch-up note in `schedule_worker.rs`). Series-end conditions
//! (`end_at` / `max_runs`) live on the row and are applied by the caller, not
//! here, so this module stays a clean calendar primitive.

use chrono::{Datelike, Duration, LocalResult, NaiveDate, TimeZone};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};

/// A wall-clock time of day in the schedule's timezone. Integer fields (rather
/// than an "HH:MM" string) so a malformed value is impossible to deserialize and
/// validation is a pair of range checks.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct TimeOfDay {
    pub hour: u8,
    pub minute: u8,
}

impl TimeOfDay {
    pub fn is_valid(&self) -> bool {
        self.hour < 24 && self.minute < 60
    }
}

/// How a schedule repeats. Tagged by `kind` so the wire form is
/// `{"kind":"daily","time":{"hour":9,"minute":0}}`. Weekdays are 0=Sunday..6=
/// Saturday, matching JavaScript's `Date.getDay()` so the frontend and backend
/// agree without a conversion table.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Recurrence {
    /// Fires a single time at the absolute `start_at` stored on the row; there is
    /// no "next", so [`next_after`] returns `None`.
    Once,
    Daily {
        time: TimeOfDay,
    },
    Weekly {
        time: TimeOfDay,
        /// 0=Sun..6=Sat, non-empty, deduplicated by validation.
        weekdays: Vec<u8>,
    },
    Monthly {
        time: TimeOfDay,
        /// 1..=31; clamped down to the month's real last day (so 31 → Feb 28/29).
        day: u8,
    },
}

impl Recurrence {
    /// True for a repeating rule (everything but `Once`). A one-shot schedule is
    /// driven by its stored `start_at`, never by `next_after`.
    pub fn is_repeating(&self) -> bool {
        !matches!(self, Recurrence::Once)
    }
}

/// The first occurrence strictly **after** `after` (unix seconds, UTC), or `None`
/// when there isn't one within a sane horizon (or the rule is `Once`). Pure: no
/// clock, no row state.
pub fn next_after(rec: &Recurrence, tz: Tz, after: i64) -> Option<i64> {
    match rec {
        // One-shot schedules have no recurrence to advance.
        Recurrence::Once => None,
        Recurrence::Daily { time } => {
            let mut date = local_date_of(tz, after)?;
            // Two years of days is a generous bound: a valid daily rule always
            // resolves on day 0 or 1, so this only ever loops past a DST gap.
            for _ in 0..=750 {
                if let Some(ts) = local_to_utc(tz, date, *time) {
                    if ts > after {
                        return Some(ts);
                    }
                }
                date = date.succ_opt()?;
            }
            None
        }
        Recurrence::Weekly { time, weekdays } => {
            let mut date = local_date_of(tz, after)?;
            for _ in 0..=750 {
                let wd = date.weekday().num_days_from_sunday() as u8;
                if weekdays.contains(&wd) {
                    if let Some(ts) = local_to_utc(tz, date, *time) {
                        if ts > after {
                            return Some(ts);
                        }
                    }
                }
                date = date.succ_opt()?;
            }
            None
        }
        Recurrence::Monthly { time, day } => {
            let start = local_date_of(tz, after)?;
            let (mut year, mut month) = (start.year(), start.month());
            // Four years of months: covers any clamp/DST oddity with margin.
            for _ in 0..=48 {
                let dom = clamp_day(year, month, *day);
                if let Some(date) = NaiveDate::from_ymd_opt(year, month, dom) {
                    if let Some(ts) = local_to_utc(tz, date, *time) {
                        if ts > after {
                            return Some(ts);
                        }
                    }
                }
                (year, month) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
            }
            None
        }
    }
}

/// The local calendar date in `tz` at unix instant `ts`.
fn local_date_of(tz: Tz, ts: i64) -> Option<NaiveDate> {
    tz.timestamp_opt(ts, 0).single().map(|dt| dt.date_naive())
}

/// Resolve a local date + time-of-day in `tz` to a UTC unix timestamp, coping
/// with the two DST anomalies:
///   • **fall-back** (the wall-clock time happens twice) → take the *earliest*;
///   • **spring-forward gap** (the wall-clock time doesn't exist) → advance to
///     the first valid instant after it (so "02:30" on a gap day fires at 03:00).
fn local_to_utc(tz: Tz, date: NaiveDate, t: TimeOfDay) -> Option<i64> {
    let naive = date.and_hms_opt(t.hour as u32, t.minute as u32, 0)?;
    match tz.from_local_datetime(&naive) {
        LocalResult::Single(dt) => Some(dt.timestamp()),
        LocalResult::Ambiguous(earliest, _latest) => Some(earliest.timestamp()),
        LocalResult::None => {
            // Walk forward a bounded number of minutes (a DST gap is ≤ a few
            // hours) until the timezone accepts a wall-clock time again.
            for add in 1..=180 {
                let bumped = naive + Duration::minutes(add);
                match tz.from_local_datetime(&bumped) {
                    LocalResult::Single(dt) => return Some(dt.timestamp()),
                    LocalResult::Ambiguous(e, _) => return Some(e.timestamp()),
                    LocalResult::None => continue,
                }
            }
            None
        }
    }
}

/// Clamp a requested day-of-month down to the month's real last day, so a
/// "31st" rule lands on Feb 28 (or 29 in a leap year), Apr 30, etc.
fn clamp_day(year: i32, month: u32, day: u8) -> u32 {
    (day as u32).clamp(1, last_day_of_month(year, month))
}

/// Last calendar day of `(year, month)` — the day before the 1st of next month.
fn last_day_of_month(year: i32, month: u32) -> u32 {
    let (ny, nm) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    NaiveDate::from_ymd_opt(ny, nm, 1)
        .map(|d| (d - Duration::days(1)).day())
        .unwrap_or(28)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, TimeZone, Timelike};
    use chrono_tz::America::New_York;
    use chrono_tz::UTC;

    fn at(tz: Tz, y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        tz.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap().timestamp()
    }

    fn tod(hour: u8, minute: u8) -> TimeOfDay {
        TimeOfDay { hour, minute }
    }

    #[test]
    fn once_has_no_next() {
        assert_eq!(next_after(&Recurrence::Once, UTC, 0), None);
    }

    #[test]
    fn daily_picks_the_next_strictly_future_occurrence() {
        let rec = Recurrence::Daily { time: tod(9, 0) };
        // 08:00 on the day → today's 09:00.
        let after = at(UTC, 2026, 6, 25, 8, 0);
        assert_eq!(next_after(&rec, UTC, after), Some(at(UTC, 2026, 6, 25, 9, 0)));
        // 09:00 exactly → strictly-after means tomorrow's 09:00.
        let at9 = at(UTC, 2026, 6, 25, 9, 0);
        assert_eq!(next_after(&rec, UTC, at9), Some(at(UTC, 2026, 6, 26, 9, 0)));
    }

    #[test]
    fn daily_is_a_single_step_not_a_burst() {
        // Calling repeatedly advances exactly one day at a time — the property
        // the worker relies on so a long outage yields one catch-up, not many.
        let rec = Recurrence::Daily { time: tod(9, 0) };
        let mut t = at(UTC, 2026, 1, 1, 0, 0);
        let first = next_after(&rec, UTC, t).unwrap();
        assert_eq!(first, at(UTC, 2026, 1, 1, 9, 0));
        t = first;
        assert_eq!(next_after(&rec, UTC, t), Some(at(UTC, 2026, 1, 2, 9, 0)));
    }

    #[test]
    fn weekly_finds_the_next_matching_weekday() {
        // 2026-06-25 is a Thursday (weekday 4). Ask for Mondays (1).
        let rec = Recurrence::Weekly {
            time: tod(12, 0),
            weekdays: vec![1],
        };
        let after = at(UTC, 2026, 6, 25, 0, 0);
        // Next Monday is 2026-06-29.
        assert_eq!(next_after(&rec, UTC, after), Some(at(UTC, 2026, 6, 29, 12, 0)));
    }

    #[test]
    fn monthly_clamps_day_31_to_february() {
        let rec = Recurrence::Monthly {
            time: tod(8, 0),
            day: 31,
        };
        // From mid-Feb 2026 (not a leap year) → Feb 28.
        let after = at(UTC, 2026, 2, 10, 0, 0);
        assert_eq!(next_after(&rec, UTC, after), Some(at(UTC, 2026, 2, 28, 8, 0)));
        // 2024 is a leap year → Feb 29.
        let after_leap = at(UTC, 2024, 2, 10, 0, 0);
        assert_eq!(
            next_after(&rec, UTC, after_leap),
            Some(at(UTC, 2024, 2, 29, 8, 0))
        );
    }

    #[test]
    fn monthly_rolls_to_next_month_when_past() {
        let rec = Recurrence::Monthly {
            time: tod(8, 0),
            day: 15,
        };
        // Already past the 15th at 08:00 → next month's 15th.
        let after = at(UTC, 2026, 6, 20, 0, 0);
        assert_eq!(next_after(&rec, UTC, after), Some(at(UTC, 2026, 7, 15, 8, 0)));
    }

    #[test]
    fn daily_stays_at_wall_clock_across_spring_forward() {
        // US DST 2026 begins Sun 2026-03-08: 02:00 EST jumps to 03:00 EDT.
        // A 09:00 daily rule must still fire at 09:00 local both sides of it.
        let rec = Recurrence::Daily { time: tod(9, 0) };
        let before = at(New_York, 2026, 3, 7, 9, 0); // Sat 09:00 EST
        let next = next_after(&rec, New_York, before).unwrap();
        let local = New_York.timestamp_opt(next, 0).unwrap();
        assert_eq!((local.year(), local.month(), local.day()), (2026, 3, 8));
        assert_eq!(local.hour(), 9); // still 09:00 wall-clock, now EDT
    }

    #[test]
    fn nonexistent_local_time_in_gap_advances_to_first_valid_instant() {
        // 02:30 doesn't exist on the spring-forward day; it must resolve to the
        // first valid instant (03:00 EDT), not error out.
        let rec = Recurrence::Daily { time: tod(2, 30) };
        let before = at(New_York, 2026, 3, 7, 12, 0);
        let next = next_after(&rec, New_York, before).unwrap();
        let local = New_York.timestamp_opt(next, 0).unwrap();
        assert_eq!((local.year(), local.month(), local.day()), (2026, 3, 8));
        assert_eq!(local.hour(), 3); // bumped out of the gap
        assert_eq!(local.minute(), 0);
    }

    #[test]
    fn ambiguous_local_time_on_fall_back_takes_the_earlier() {
        // US DST 2026 ends Sun 2026-11-01: 02:00 EDT falls back to 01:00 EST, so
        // 01:30 happens twice. We take the earlier (EDT) instant.
        let rec = Recurrence::Daily { time: tod(1, 30) };
        let before = at(New_York, 2026, 10, 31, 12, 0);
        let next = next_after(&rec, New_York, before).unwrap();
        // EDT is UTC-4, so the earlier 01:30 is 05:30 UTC (the later would be 06:30).
        let utc = chrono::Utc.timestamp_opt(next, 0).unwrap();
        assert_eq!(utc.hour(), 5);
        assert_eq!(utc.minute(), 30);
    }

    #[test]
    fn clamp_helpers() {
        assert_eq!(last_day_of_month(2026, 2), 28);
        assert_eq!(last_day_of_month(2024, 2), 29);
        assert_eq!(last_day_of_month(2026, 4), 30);
        assert_eq!(last_day_of_month(2026, 12), 31);
        assert_eq!(clamp_day(2026, 2, 31), 28);
        assert_eq!(clamp_day(2026, 1, 15), 15);
        assert_eq!(clamp_day(2026, 1, 0), 1);
    }
}
