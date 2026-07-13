//! Feedback relay shared by the public web builder and the Discord Activity.
//!
//! The destination webhook is a server-held credential. Browsers submit a
//! small, allow-listed report shape; this module validates it and constructs
//! the Discord forum payload itself, so callers cannot choose a destination,
//! forge arbitrary forum tags, or enable mentions.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::cookie::PrivateCookieJar;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::activity::resolve_identity;
use crate::error::AppError;
use crate::routes::AppState;
use crate::session::Session;

const THREAD_NAME_MAX: usize = 100;
const DETAILS_MAX: usize = 1_600;
const CONTACT_MAX: usize = 100;
const CONTENT_MAX: usize = 2_000;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
enum FeedbackCategory {
    Suggestion,
    Bug,
    Question,
    Other,
}

impl FeedbackCategory {
    fn label(self) -> &'static str {
        match self {
            Self::Suggestion => "Suggestion",
            Self::Bug => "Bug",
            Self::Question => "Question",
            Self::Other => "Other",
        }
    }

    fn emoji(self) -> &'static str {
        match self {
            Self::Suggestion => "💡",
            Self::Bug => "🐛",
            Self::Question => "❓",
            Self::Other => "💬",
        }
    }

    /// The four tags configured on DWEEB's feedback forum. The browser sends
    /// only the enum above; it cannot inject a different forum tag snowflake.
    fn forum_tag(self) -> &'static str {
        match self {
            Self::Suggestion => "1518246042993430598",
            Self::Bug => "1518251471471382528",
            Self::Question => "1518251562978382025",
            Self::Other => "1518251625863577650",
        }
    }
}

/// Intentionally small, closed wire contract. `deny_unknown_fields` prevents a
/// client from smuggling Discord webhook fields such as `username`, `embeds`,
/// `allowed_mentions`, or an attacker-chosen `thread_name` through the relay.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FeedbackBody {
    category: FeedbackCategory,
    summary: String,
    details: String,
    #[serde(default)]
    contact: Option<String>,
}

enum Sender<'a> {
    Web,
    Activity(&'a Session),
}

/// Anonymous browser feedback. Abuse protection is applied as route-local
/// middleware in `main` in addition to the proxy's global per-IP limiter.
pub(crate) async fn web_feedback(
    State(st): State<AppState>,
    Json(body): Json<FeedbackBody>,
) -> Result<Response, AppError> {
    relay(&st, body, Sender::Web).await
}

/// Bearer-gated Activity feedback. Keep the verified Discord identity stamp
/// even though it shares the same validation and forwarding path as the web.
pub(crate) async fn activity_feedback(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    headers: HeaderMap,
    Json(body): Json<FeedbackBody>,
) -> Result<Response, AppError> {
    if !st.config.activities_enabled {
        return Err(AppError::Status {
            status: StatusCode::NOT_IMPLEMENTED,
            message: "Discord Activities aren't enabled on this deployment.".into(),
            retry_after: None,
        });
    }

    let session = resolve_identity(&st, &jar, &headers).await?;
    relay(&st, body, Sender::Activity(&session)).await
}

async fn relay(
    st: &AppState,
    body: FeedbackBody,
    sender: Sender<'_>,
) -> Result<Response, AppError> {
    let Some(webhook_url) = st.config.feedback_webhook_url.as_deref() else {
        return Err(AppError::Status {
            status: StatusCode::NOT_IMPLEMENTED,
            message: "Feedback isn't available on this deployment.".into(),
            retry_after: None,
        });
    };

    let payload = build_payload(body, sender)?;
    st.discord.post_webhook_url(webhook_url, &payload).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

fn build_payload(body: FeedbackBody, sender: Sender<'_>) -> Result<Value, AppError> {
    let summary = required_single_line("summary", body.summary, THREAD_NAME_MAX)?;
    let details = required_details(body.details)?;
    let contact = optional_single_line("contact", body.contact, CONTACT_MAX)?;

    let thread_name = truncate_utf16(
        &format!("{} {}", body.category.emoji(), summary),
        THREAD_NAME_MAX,
    );

    let mut footer = vec![format!(
        "-# {} {} · sent from DWEEB {}",
        body.category.emoji(),
        body.category.label(),
        match sender {
            Sender::Web => "web",
            Sender::Activity(_) => "in Discord",
        }
    )];
    if let Some(contact) = contact {
        footer.push(format!("-# 📧 Contact: {contact}"));
    }
    if let Sender::Activity(session) = sender {
        let name = clean_verified_name(&session.name);
        footer.push(format!(
            "-# ✅ {name} ({}) · verified Discord sender",
            session.uid
        ));
    }

    let footer = footer.join("\n");
    let separator = "\n\n";
    let reserved = utf16_len(separator) + utf16_len(&footer);
    let room = CONTENT_MAX.saturating_sub(reserved);
    let details = truncate_utf16(&details, room);
    let content = format!("{details}{separator}{footer}");

    Ok(json!({
        "thread_name": thread_name,
        "content": content,
        "applied_tags": [body.category.forum_tag()],
        // Feedback must never ping anyone, even when user text contains a
        // mention or a role id.
        "allowed_mentions": { "parse": [] },
    }))
}

fn required_single_line(field: &str, value: String, max: usize) -> Result<String, AppError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(bad_request(&format!("{field} is required")));
    }
    validate_single_line(field, value, max)?;
    Ok(value.to_string())
}

fn optional_single_line(
    field: &str,
    value: Option<String>,
    max: usize,
) -> Result<Option<String>, AppError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    validate_single_line(field, value, max)?;
    Ok(Some(value.to_string()))
}

fn validate_single_line(field: &str, value: &str, max: usize) -> Result<(), AppError> {
    if utf16_len(value) > max {
        return Err(bad_request(&format!("{field} is too long")));
    }
    if value.chars().any(char::is_control) {
        return Err(bad_request(&format!("{field} must be a single line")));
    }
    Ok(())
}

fn required_details(value: String) -> Result<String, AppError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(bad_request("details is required"));
    }
    if utf16_len(value) > DETAILS_MAX {
        return Err(bad_request("details is too long"));
    }
    if value
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(bad_request(
            "details contains unsupported control characters",
        ));
    }
    Ok(value.to_string())
}

fn clean_verified_name(value: &str) -> String {
    let cleaned: String = value.chars().filter(|c| !c.is_control()).collect();
    let cleaned = truncate_utf16(&cleaned, CONTACT_MAX);
    if cleaned.is_empty() {
        "Unknown user".into()
    } else {
        cleaned
    }
}

/// Discord's limits follow JavaScript string length (UTF-16 code units), which
/// is also what the browser's `maxLength` enforces. Counting Rust `char`s would
/// undercount astral emoji and let a malicious direct caller exceed the API cap.
fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn truncate_utf16(value: &str, max: usize) -> String {
    let mut used = 0;
    value
        .chars()
        .take_while(|c| {
            let width = c.len_utf16();
            if used + width > max {
                false
            } else {
                used += width;
                true
            }
        })
        .collect()
}

fn bad_request(message: &str) -> AppError {
    AppError::Status {
        status: StatusCode::BAD_REQUEST,
        message: message.into(),
        retry_after: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body() -> FeedbackBody {
        FeedbackBody {
            category: FeedbackCategory::Bug,
            summary: "Preview clips on mobile".into(),
            details: "Steps: open <@123>, then resize.".into(),
            contact: Some("helper".into()),
        }
    }

    #[test]
    fn web_payload_is_server_built_and_mentions_are_disabled() {
        let payload = match build_payload(body(), Sender::Web) {
            Ok(payload) => payload,
            Err(_) => panic!("valid web feedback should build"),
        };
        assert_eq!(payload["thread_name"], "🐛 Preview clips on mobile");
        assert_eq!(payload["applied_tags"], json!(["1518251471471382528"]));
        assert_eq!(payload["allowed_mentions"], json!({ "parse": [] }));
        let content = payload["content"].as_str().unwrap();
        assert!(content.contains("Steps: open <@123>, then resize."));
        assert!(content.contains("sent from DWEEB web"));
        assert!(content.contains("Contact: helper"));
        assert!(utf16_len(content) <= CONTENT_MAX);
    }

    #[test]
    fn activity_payload_stamps_verified_identity() {
        let session = Session {
            uid: "123456789".into(),
            name: "Verified user".into(),
            avatar: None,
            token: "token".into(),
            exp: 0,
        };
        let payload = match build_payload(body(), Sender::Activity(&session)) {
            Ok(payload) => payload,
            Err(_) => panic!("valid Activity feedback should build"),
        };
        let content = payload["content"].as_str().unwrap();
        assert!(content.contains("sent from DWEEB in Discord"));
        assert!(content.contains("Verified user (123456789) · verified Discord sender"));
    }

    #[test]
    fn wire_shape_rejects_unknown_discord_fields_and_categories() {
        let extra = json!({
            "category": "bug",
            "summary": "A bug",
            "details": "Details",
            "allowed_mentions": { "parse": ["everyone"] }
        });
        assert!(serde_json::from_value::<FeedbackBody>(extra).is_err());

        let category = json!({
            "category": "1518251471471382528",
            "summary": "A bug",
            "details": "Details"
        });
        assert!(serde_json::from_value::<FeedbackBody>(category).is_err());
    }

    #[test]
    fn validation_rejects_empty_multiline_and_oversized_fields() {
        let mut empty = body();
        empty.summary = "  ".into();
        assert!(matches!(
            build_payload(empty, Sender::Web),
            Err(AppError::Status {
                status: StatusCode::BAD_REQUEST,
                ..
            })
        ));

        let mut multiline = body();
        multiline.contact = Some("one\ntwo".into());
        assert!(build_payload(multiline, Sender::Web).is_err());

        let mut oversized = body();
        oversized.details = "x".repeat(DETAILS_MAX + 1);
        assert!(build_payload(oversized, Sender::Web).is_err());

        let mut emoji = body();
        emoji.summary = "🧪".repeat((THREAD_NAME_MAX / 2) + 1);
        assert!(build_payload(emoji, Sender::Web).is_err());
    }
}
