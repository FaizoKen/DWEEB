//! Best-effort crash telemetry for the web app.
//!
//! The builder runs entirely in the browser, so when a runtime error blanks the
//! editor (or the top-level [`ErrorBoundary`] catches one) we otherwise learn of
//! it only if a user happens to file feedback. This endpoint receives a tiny,
//! fire-and-forget beacon from the frontend's global error handlers and logs it
//! under a dedicated target (`web_crash`) so crashes in the wild become
//! greppable and aggregatable straight from the proxy logs.
//!
//! It mirrors the Activity handshake beacon (`activity::activity_telemetry`) in
//! spirit and in its safety posture:
//!
//!  - **Unauthenticated by necessity.** A crash can happen before login, or on a
//!    build with no proxy session at all; gating it behind auth would drop the
//!    very reports we most want. It's *not* gated on `activities_enabled` either
//!    — these come from the plain web surface, which has nothing to do with the
//!    embedded Activity.
//!  - **Content-free.** The frontend sends the error message, a few stack
//!    frames, the app version and the URL *path* (never the `#hash`, which
//!    carries the user's message payload). We clamp every field again here — the
//!    proxy is the authority on what actually lands in a log line.
//!  - **Best-effort.** Always answers `204`; a hostile or malformed beacon can't
//!    turn it into a log-spam or log-injection vector any more than the image
//!    proxy or the Activity beacon can.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use crate::error::AppError;
use crate::routes::AppState;

/// One crash beacon from the browser. Every field is optional on the wire (a
/// beacon assembled under a half-broken app must still parse), so each defaults
/// to empty and is clamped in the handler.
#[derive(Deserialize)]
pub struct CrashBody {
    /// Where the error surfaced: `error` (window.onerror), `unhandledrejection`,
    /// or `boundary` (the React error boundary). A short enum-like tag.
    #[serde(default)]
    kind: String,
    /// The error message. Not user content — an exception string like
    /// "Cannot read properties of undefined". Clamped hard anyway.
    #[serde(default)]
    message: String,
    /// The top few stack frames (code paths, minified symbol names). Clamped so
    /// a deep stack can't blow up one log line.
    #[serde(default)]
    stack: String,
    /// The app build version (`__APP_VERSION__`), so a crash can be pinned to a
    /// deploy.
    #[serde(default)]
    version: String,
    /// Which shell was running: `web` or `activity`.
    #[serde(default)]
    surface: String,
    /// `location.pathname` only — deliberately never the query or `#hash`, which
    /// would carry the share payload (i.e. the user's message).
    #[serde(default)]
    path: String,
}

/// Field caps. A crash message and a handful of stack frames are the only fields
/// with any length to speak of; the rest are short tags.
const KIND_MAX: usize = 20;
const MESSAGE_MAX: usize = 300;
const STACK_MAX: usize = 800;
const VERSION_MAX: usize = 24;
const SURFACE_MAX: usize = 12;
const PATH_MAX: usize = 120;

/// `POST /api/telemetry/crash` — record one frontend crash.
///
/// See the module docs for why this is unauthenticated and content-free. The
/// handler's whole job is to clamp and log: it never touches Discord, never
/// reads state, and always answers `204` so the beacon can't perturb the app
/// that emitted it.
pub async fn crash_report(
    State(_st): State<AppState>,
    Json(body): Json<CrashBody>,
) -> Result<Response, AppError> {
    let kind = clamp_field(&body.kind, KIND_MAX);
    let message = clamp_field(&body.message, MESSAGE_MAX);
    let stack = clamp_field(&body.stack, STACK_MAX);
    let version = clamp_field(&body.version, VERSION_MAX);
    let surface = clamp_field(&body.surface, SURFACE_MAX);
    let path = clamp_field(&body.path, PATH_MAX);

    tracing::warn!(
        target: "web_crash",
        %kind,
        %surface,
        %version,
        %path,
        %message,
        %stack,
        "web app crash",
    );
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Trim an untrusted telemetry string to a bounded, single-line snippet: drop
/// control characters (incl. newlines, so it can't forge extra log lines) and
/// cap the length. Same guarantee as the Activity beacon's clamp — a hostile
/// beacon can neither spam nor corrupt the log.
fn clamp_field(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_strips_control_chars_including_newlines() {
        // A forged log line (embedded newline + fake fields) collapses to one line.
        let hostile = "boom\n2026-01-01 INFO forged=line\ttab";
        let out = clamp_field(hostile, 100);
        assert!(!out.contains('\n'));
        assert!(!out.contains('\t'));
        assert_eq!(out, "boom2026-01-01 INFO forged=linetab");
    }

    #[test]
    fn clamp_caps_length_by_chars_not_bytes() {
        // Cap counts characters, so multibyte input can't smuggle past the limit.
        let s = "é".repeat(50);
        let out = clamp_field(&s, 10);
        assert_eq!(out.chars().count(), 10);
    }

    #[test]
    fn clamp_empty_stays_empty() {
        assert_eq!(clamp_field("", 10), "");
    }
}
