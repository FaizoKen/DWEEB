//! Validation for scheduled-post requests submitted by the (untrusted) browser.
//!
//! The worker only ever POSTs to one host family — Discord — so the single SSRF
//! surface is the webhook URL the caller stores. [`validate_webhook`] pins it to
//! genuine Discord incoming-webhook URLs (mirrors the Modal Form / Self Role
//! plugins), and the worker re-checks the host before every send so a tampered
//! row can never make the proxy POST elsewhere. The rest keeps a stored schedule
//! *coherent*: a real timezone, a sane recurrence, a bounded payload that at
//! least looks like a Components V2 body.

use chrono_tz::Tz;
use serde_json::Value;

use crate::schedule_rule::Recurrence;

/// Discord hosts that serve incoming webhooks.
const ALLOWED_WEBHOOK_HOSTS: &[&str] = &[
    "discord.com",
    "discordapp.com",
    "canary.discord.com",
    "ptb.discord.com",
];

/// Largest stored payload (the serialized wire body). A maxed-out Components V2
/// message is well under this; bigger isn't a message we'd accept anyway.
pub const MAX_PAYLOAD_BYTES: usize = 60 * 1024;

const MAX_TITLE_CHARS: usize = 100;
const MAX_DEST_LABEL_CHARS: usize = 200;
const MAX_WEEKDAYS: usize = 7;

/// SSRF guard: only accept genuine Discord incoming-webhook URLs. Without this a
/// stored schedule could make the worker POST to an arbitrary host.
pub fn validate_webhook(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|_| "The webhook must be a valid URL.".to_string())?;
    if parsed.scheme() != "https" {
        return Err("The webhook must use https.".into());
    }
    let host = parsed.host_str().unwrap_or_default();
    if !ALLOWED_WEBHOOK_HOSTS.contains(&host) || !parsed.path().starts_with("/api/webhooks/") {
        return Err("That must be a Discord webhook URL.".into());
    }
    Ok(())
}

/// Pull the webhook's numeric id out of a `…/api/webhooks/{id}/{token}` URL. Used
/// for the per-webhook schedule cap and as a non-secret display handle (the token
/// segment is never returned to the browser). Returns `None` for a malformed URL.
pub fn webhook_id(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url.trim()).ok()?;
    let mut segs = parsed.path_segments()?;
    // path is /api/webhooks/{id}/{token}
    if segs.next()? != "api" || segs.next()? != "webhooks" {
        return None;
    }
    let id = segs.next()?;
    if is_snowflake(id) {
        Some(id.to_string())
    } else {
        None
    }
}

/// Discord snowflakes are 17–20 digits today; accept a little slack.
pub fn is_snowflake(s: &str) -> bool {
    (15..=25).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

/// Parse + validate an IANA timezone name (e.g. `America/New_York`).
pub fn parse_tz(name: &str) -> Result<Tz, String> {
    name.trim()
        .parse::<Tz>()
        .map_err(|_| format!("Unknown timezone “{name}”."))
}

/// Validate a recurrence rule's fields (times in range, weekdays sane, day 1–31).
pub fn validate_recurrence(rec: &Recurrence) -> Result<(), String> {
    match rec {
        Recurrence::Once => Ok(()),
        Recurrence::Daily { time } => check_time(time),
        Recurrence::Weekly { time, weekdays } => {
            check_time(time)?;
            if weekdays.is_empty() {
                return Err("Pick at least one weekday.".into());
            }
            if weekdays.len() > MAX_WEEKDAYS {
                return Err("Too many weekdays.".into());
            }
            if weekdays.iter().any(|d| *d > 6) {
                return Err("A weekday must be 0 (Sunday) to 6 (Saturday).".into());
            }
            Ok(())
        }
        Recurrence::Monthly { time, day } => {
            check_time(time)?;
            if !(1..=31).contains(day) {
                return Err("Day of month must be between 1 and 31.".into());
            }
            Ok(())
        }
    }
}

fn check_time(t: &crate::schedule_rule::TimeOfDay) -> Result<(), String> {
    if t.is_valid() {
        Ok(())
    } else {
        Err("That isn't a valid time of day.".into())
    }
}

/// Validate the message payload: it must be a JSON object that looks like a
/// Components V2 body (carries `components` and/or `content`) and isn't oversized.
/// The authoritative, full validation runs client-side before this is ever sent;
/// here we only guard shape, size, and safety.
pub fn validate_payload(payload: &Value) -> Result<(), String> {
    let obj = payload
        .as_object()
        .ok_or("The message payload must be a JSON object.")?;
    let has_components = obj.get("components").map(|c| c.is_array()).unwrap_or(false);
    let has_content = obj
        .get("content")
        .map(|c| c.is_string() && !c.as_str().unwrap_or("").trim().is_empty())
        .unwrap_or(false);
    if !has_components && !has_content {
        return Err("The message is empty — add content or components before scheduling.".into());
    }
    // Files can't be carried server-side (the bytes live in the browser), so a
    // payload that references local attachments would post broken. The frontend
    // blocks this, but guard here too.
    if obj
        .get("attachments")
        .map(|a| a.is_array())
        .unwrap_or(false)
        && !obj
            .get("attachments")
            .and_then(|a| a.as_array())
            .map(|a| a.is_empty())
            .unwrap_or(true)
    {
        return Err(
            "Scheduled posts can't include uploaded files — use media URLs instead.".into(),
        );
    }
    let size = serde_json::to_string(payload).map(|s| s.len()).unwrap_or(0);
    if size > MAX_PAYLOAD_BYTES {
        return Err("That message is too large to schedule.".into());
    }
    Ok(())
}

/// Optional title bound (a label shown only in the management list).
pub fn validate_title(title: &str) -> Result<(), String> {
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err("Title is too long.".into());
    }
    Ok(())
}

/// Optional destination label bound (cached "#channel · Server" for the list).
pub fn validate_dest_label(label: &str) -> Result<(), String> {
    if label.chars().count() > MAX_DEST_LABEL_CHARS {
        return Err("Destination label is too long.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schedule_rule::TimeOfDay;
    use serde_json::json;

    #[test]
    fn webhook_guard_rejects_non_discord_and_non_https() {
        assert!(validate_webhook("http://discord.com/api/webhooks/1/x").is_err());
        assert!(validate_webhook("https://evil.example.com/api/webhooks/1/x").is_err());
        assert!(validate_webhook("https://discord.com/users/@me").is_err());
        assert!(validate_webhook("not a url").is_err());
    }

    #[test]
    fn webhook_guard_accepts_canonical_urls() {
        assert!(validate_webhook("https://discord.com/api/webhooks/123/abcDEF").is_ok());
        assert!(validate_webhook("https://canary.discord.com/api/webhooks/1/tok").is_ok());
    }

    #[test]
    fn extracts_webhook_id() {
        assert_eq!(
            webhook_id("https://discord.com/api/webhooks/123456789012345678/tok"),
            Some("123456789012345678".to_string())
        );
        assert_eq!(
            webhook_id("https://discord.com/api/webhooks/notanid/tok"),
            None
        );
        assert_eq!(webhook_id("https://discord.com/users/@me"), None);
    }

    #[test]
    fn tz_parsing() {
        assert!(parse_tz("America/New_York").is_ok());
        assert!(parse_tz("UTC").is_ok());
        assert!(parse_tz("Mars/Olympus").is_err());
    }

    #[test]
    fn recurrence_rules() {
        let t = TimeOfDay { hour: 9, minute: 0 };
        assert!(validate_recurrence(&Recurrence::Daily { time: t }).is_ok());
        assert!(validate_recurrence(&Recurrence::Weekly {
            time: t,
            weekdays: vec![1, 3, 5]
        })
        .is_ok());
        assert!(validate_recurrence(&Recurrence::Weekly {
            time: t,
            weekdays: vec![]
        })
        .is_err());
        assert!(validate_recurrence(&Recurrence::Weekly {
            time: t,
            weekdays: vec![7]
        })
        .is_err());
        assert!(validate_recurrence(&Recurrence::Monthly { time: t, day: 0 }).is_err());
        assert!(validate_recurrence(&Recurrence::Monthly { time: t, day: 31 }).is_ok());
        assert!(validate_recurrence(&Recurrence::Daily {
            time: TimeOfDay {
                hour: 24,
                minute: 0
            }
        })
        .is_err());
    }

    #[test]
    fn payload_shape() {
        assert!(validate_payload(&json!({ "content": "hi" })).is_ok());
        assert!(validate_payload(&json!({ "components": [], "flags": 32768 })).is_ok());
        assert!(validate_payload(&json!({ "flags": 32768 })).is_err());
        assert!(validate_payload(&json!([1, 2, 3])).is_err());
        assert!(
            validate_payload(&json!({ "content": "x", "attachments": [{ "id": 0 }] })).is_err()
        );
    }
}
