//! Calendar arithmetic for transcripts and log lines — pure, dependency-free.
//!
//! Only UTC is ever needed: Discord sends every timestamp as UTC ISO 8601, and
//! a transcript is a record read by people in many timezones, so it states UTC
//! explicitly rather than guessing a reader's zone. Discord messages themselves
//! use `<t:unix:R>` markup instead, which each reader's client localises.

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The inverse: (year, month, day) for days since 1970-01-01.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `2026-06-15 12:31 UTC` for a unix-milliseconds instant.
pub fn format_utc_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (y, mo, d) = civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    format!(
        "{y:04}-{mo:02}-{d:02} {:02}:{:02} UTC",
        rem / 3600,
        (rem % 3600) / 60
    )
}

/// Parse the leading `YYYY-MM-DDTHH:MM:SS` of a Discord ISO 8601 timestamp to
/// unix seconds. Discord always sends UTC (`+00:00`), so the offset and
/// fraction are ignored. `None` for anything that isn't shaped like one.
pub fn parse_iso_secs(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b' ') {
        return None;
    }
    if b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> {
        let part = s.get(from..to)?;
        if !part.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, se) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    Some(days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + se)
}

/// `2026-06-15 12:31 UTC` from a Discord ISO timestamp; the raw string when it
/// isn't one (a transcript should still show *something*).
pub fn format_iso(s: &str) -> String {
    match parse_iso_secs(s) {
        Some(secs) => format_utc_ms(secs * 1000),
        None => s.to_string(),
    }
}

/// A short human duration: `45s`, `12m`, `2h 13m`, `3d 4h`.
pub fn humanize_ms(ms: i64) -> String {
    let secs = ms.max(0) / 1000;
    let (d, h, m) = (secs / 86_400, (secs % 86_400) / 3600, (secs % 3600) / 60);
    if d > 0 {
        if h > 0 {
            format!("{d}d {h}h")
        } else {
            format!("{d}d")
        }
    } else if h > 0 {
        if m > 0 {
            format!("{h}h {m}m")
        } else {
            format!("{h}h")
        }
    } else if m > 0 {
        format!("{m}m")
    } else {
        format!("{secs}s")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_round_trips_across_eras_and_leap_days() {
        for (y, m, d) in [
            (1970, 1, 1),
            (2000, 2, 29),
            (2024, 2, 29),
            (2026, 9, 27),
            (1969, 12, 31),
            (2100, 3, 1),
        ] {
            assert_eq!(civil_from_days(days_from_civil(y, m, d)), (y, m, d));
        }
        assert_eq!(days_from_civil(1970, 1, 1), 0);
    }

    #[test]
    fn formats_unix_millis_as_utc() {
        assert_eq!(format_utc_ms(0), "1970-01-01 00:00 UTC");
        // 2026-06-15T12:31:40Z
        assert_eq!(format_utc_ms(1_781_526_700_000), "2026-06-15 12:31 UTC");
    }

    #[test]
    fn parses_discord_iso_timestamps() {
        let secs = parse_iso_secs("2026-06-15T12:31:40.123000+00:00").unwrap();
        assert_eq!(format_utc_ms(secs * 1000), "2026-06-15 12:31 UTC");
        assert_eq!(
            format_iso("2026-06-15T12:31:40+00:00"),
            "2026-06-15 12:31 UTC"
        );
        // Garbage stays visible rather than becoming a wrong date.
        assert_eq!(parse_iso_secs("yesterday"), None);
        assert_eq!(parse_iso_secs("2026-13-01T00:00:00"), None);
        assert_eq!(format_iso("soon"), "soon");
    }

    #[test]
    fn humanizes_durations() {
        assert_eq!(humanize_ms(45_000), "45s");
        assert_eq!(humanize_ms(12 * 60_000), "12m");
        assert_eq!(humanize_ms((2 * 3600 + 13 * 60) * 1000), "2h 13m");
        assert_eq!(humanize_ms(3 * 3600 * 1000), "3h");
        assert_eq!(humanize_ms((3 * 86_400 + 4 * 3600) * 1000), "3d 4h");
        assert_eq!(humanize_ms(-5), "0s");
    }
}
