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
    /// or `boundary` (the React error boundary), plus the three chunk-load
    /// refinements the client resolves for itself — `stale-chunk`,
    /// `chunk-unreachable`, `stale-chunk-fatal`. A short enum-like tag.
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
    /// The app release version (`__APP_VERSION__`), so a crash can be pinned to
    /// a release.
    #[serde(default)]
    version: String,
    /// Identity of the *bundle* reporting (`__BUILD_ID__` — the commit it was
    /// built from, or a build timestamp). `version` cannot answer this: it is
    /// the package.json semver and has read `1.0.0` since launch. The app ships
    /// from a service-worker cache, so clients keep running — and beaconing
    /// from — a bundle for weeks after it is replaced; this is what tells a log
    /// reader whether a report comes from a build that already carries the fix
    /// for what it describes. Empty from any client predating the field, which
    /// is itself the signal that it is an old one.
    #[serde(default)]
    build: String,
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
/// A short commit sha plus a `-dirty` marker, with room to spare.
const BUILD_MAX: usize = 32;
const SURFACE_MAX: usize = 12;
const PATH_MAX: usize = 120;

/// Browser signals that reach `window.onerror` but are not crashes: nothing
/// threw and the page carries on. The frontend already declines to send these
/// (`core/telemetry/crashReport.ts`), but this endpoint is public and the
/// frontend is served from a service-worker cache — an old client keeps beaconing
/// them long after the fix ships, and every `web_crash` line pages the maintainer
/// through the log alerter. So the proxy, which owns what lands in the log, drops
/// them too.
///
/// `ResizeObserver loop …` is fired when a resize callback resizes an element it
/// observes; the browser defers the notification a frame and moves on. Both
/// spellings are the same condition (Chrome's legacy wording, then the spec's).
/// Keep this list short and exact — anything vague here silently eats real crashes.
const NON_CRASH_MESSAGES: [&str; 2] = [
    "ResizeObserver loop completed with undelivered notifications",
    "ResizeObserver loop limit exceeded",
];

/// Whether this beacon is one of the known browser non-errors. Substring, not
/// equality: browsers prefix the message ("Uncaught …") on some paths.
fn is_non_crash(message: &str) -> bool {
    NON_CRASH_MESSAGES
        .iter()
        .any(|known| message.contains(known))
}

/// How each engine words a dynamic `import()` whose chunk failed to load.
/// Mirrors the frontend's list in `core/telemetry/crashReport.ts`; matched
/// case-insensitively on containment.
///
/// Note these words describe a *symptom*: a chunk didn't load. Deploy skew (a
/// tab from an older build requesting a hashed chunk the next deploy purged)
/// produces them, and so does a visitor whose connection dropped mid-load. The
/// client tells the two apart by re-requesting the chunk before it reports (see
/// `chunkFailureKind` there); the proxy only reads the kind it settled on.
const STALE_CHUNK_MESSAGES: [&str; 4] = [
    "failed to fetch dynamically imported module", // Chromium
    "error loading dynamically imported module",   // Firefox
    "importing a module script failed",            // Safari
    "unable to preload css",                       // Vite preload helper
];

/// Chunks that *only* optional post-boot background work loads — nothing on
/// screen waits for them, so their failure cannot be fatal no matter what kind
/// the client reported.
///
/// Just one today: `virtual:pwa-register`, the service-worker registration
/// module that `main.tsx` imports well after first paint. A tab that outlives a
/// deploy 404s it with the editor running perfectly, yet the pre-fix client
/// escalated that to `stale-chunk-fatal` (the rejection was unhandled, and the
/// escalation rule can't see that nothing depended on it) and paged the
/// maintainer on 2026-07-27. The client now reports it as handled, but the app
/// ships from a service-worker cache — clients without that fix keep sending the
/// fatal shape for weeks — so the demotion lives here too, where it is the
/// authority. Match on the bundler's chunk name, which Vite derives from the
/// module id and is present in every engine's message (which carries the URL).
///
/// Keep this list to modules genuinely reachable *only* from fire-and-forget
/// work: an entry here permanently exempts a chunk from paging.
const BACKGROUND_ONLY_CHUNKS: [&str; 1] = ["virtual_pwa-register"];

/// Whether this beacon is a *routine* chunk-load failure — logged at `info`
/// (greppable, aggregatable) instead of `warn` so it never pages through the
/// log alerter.
///
/// Routine covers the frontend's non-fatal shapes — `stale-chunk` (a
/// `ChunkErrorBoundary` showed a refresh prompt while the app kept running) and
/// `chunk-unreachable` (the app went down, but re-requesting the chunk proved
/// our host is still serving it, so the visitor's connection failed, not our
/// deploy) — *and* every legacy kind (`boundary`/`error`/`unhandledrejection`):
/// pre-fix clients ship from service-worker caches for weeks and keep sending
/// the old crash shape for what is the same self-healing skew event.
///
/// The one shape that stays `warn` (and pages) is `stale-chunk-fatal`: a
/// current client whose app went down on a chunk the server confirmed is
/// **gone** — a broken deploy or an SW precache gap. Its single exception is a
/// chunk from [`BACKGROUND_ONLY_CHUNKS`], which no user-visible path can be
/// waiting on.
fn is_routine_stale_chunk(kind: &str, message: &str) -> bool {
    let lower = message.to_lowercase();
    if !STALE_CHUNK_MESSAGES
        .iter()
        .any(|known| lower.contains(known))
    {
        return false;
    }
    if kind == "stale-chunk-fatal" {
        return BACKGROUND_ONLY_CHUNKS
            .iter()
            .any(|chunk| lower.contains(&chunk.to_lowercase()));
    }
    true
}

/// Whether a `window.onerror` beacon reports someone else's code, not ours.
///
/// The global `error` trap hears every uncaught exception in the page context —
/// including code we never shipped: browser-extension scripts injected into the
/// page, userscripts, bookmarklets, and anything eval'd in a devtools console.
/// One of those paged the maintainer on 2026-07-24: a Safari user's foreign
/// script blew its own stack (`Maximum call stack size exceeded.`, frames
/// `@`/`Pk@`/`Nk@` with **no source URL** — JSC's rendering of code that has no
/// script URL), and rebuilding every deployed 1.0.0 bundle proved no DWEEB build
/// ever contained those symbols. Unactionable, but it logged at `warn` and the
/// log alerter pages on `web_crash` warns.
///
/// Two shapes are demoted to `info` (still greppable under `web_crash`, never
/// a page), both only for `kind == "error"` — the one trap foreign page-context
/// code lands in without involving the app:
///
///  - **Unattributed stack**: frames exist but none carries a script URL (no
///    `://` anywhere). Every engine prints absolute URLs for frames from real
///    scripts — ours are `https://…/assets/…` (any deploy origin, and the
///    Activity's discordsays.com proxy) — so a stack with no URL at all cannot
///    be code we served. (V8 words eval frames `<anonymous>`; JSC leaves them
///    bare; Firefox keeps the host URL even for eval, so on Firefox this stays
///    conservative and keeps paging.)
///  - **Muted cross-origin error**: the literal `Script error.` shape with an
///    empty stack — the browser deliberately withheld everything about a
///    non-CORS cross-origin script's failure, so the beacon carries nothing to
///    act on.
///
/// Deliberately narrow, mirroring [`is_routine_stale_chunk`]'s posture:
/// `boundary`/`unhandledrejection` beacons keep paging even with a foreign-
/// looking stack (the app actually went down / a real rejection was dropped,
/// and the client's 6-frame cut can hide our deeper frames), an empty stack
/// with an ordinary message keeps paging (our own code can `throw "string"`),
/// and extension frames that *do* carry a URL (`safari-web-extension://…`)
/// keep paging until real noise proves otherwise.
fn is_foreign_code_error(kind: &str, message: &str, stack: &str) -> bool {
    if kind != "error" {
        return false;
    }
    if !stack.is_empty() && !stack.contains("://") {
        return true;
    }
    stack.is_empty() && message.trim_start().starts_with("Script error")
}

/// `POST /api/telemetry/crash` — record one frontend crash.
///
/// See the module docs for why this is unauthenticated and content-free. The
/// handler's whole job is to clamp and log: it never touches Discord, never
/// reads state, and always answers `204` so the beacon can't perturb the app
/// that emitted it. Known browser non-errors (see [`NON_CRASH_MESSAGES`]) are
/// accepted and dropped — same `204`, no log line.
pub async fn crash_report(
    State(_st): State<AppState>,
    Json(body): Json<CrashBody>,
) -> Result<Response, AppError> {
    if is_non_crash(&body.message) {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }

    let kind = clamp_field(&body.kind, KIND_MAX);
    let message = clamp_field(&body.message, MESSAGE_MAX);
    let stack = clamp_field(&body.stack, STACK_MAX);
    let version = clamp_field(&body.version, VERSION_MAX);
    // Older clients don't send this at all; say so explicitly rather than
    // logging an empty field, since "which bundle?" is the question it answers.
    let build = match clamp_field(&body.build, BUILD_MAX) {
        b if b.is_empty() => "pre-build-id".to_string(),
        b => b,
    };
    let surface = clamp_field(&body.surface, SURFACE_MAX);
    let path = clamp_field(&body.path, PATH_MAX);

    // Routine deploy skew stays greppable under the same target but at `info`,
    // below the log alerter's paging threshold (which fires on `web_crash`
    // WARNs). See [`is_routine_stale_chunk`] for what still pages.
    if is_routine_stale_chunk(&kind, &message) {
        // Same target and level either way; only the wording differs, so a log
        // reader isn't told "deploy skew" about someone's dropped connection.
        let summary = if kind == "chunk-unreachable" {
            "web app chunk unreachable (client network, chunk still served)"
        } else {
            "web app stale chunk (deploy skew)"
        };
        tracing::info!(
            target: "web_crash",
            %kind,
            %surface,
            %version,
            %build,
            %path,
            %message,
            %stack,
            "{summary}",
        );
    } else if is_foreign_code_error(&kind, &message, &stack) {
        // Someone else's code crashing in our visitors' pages — extensions,
        // userscripts, console experiments. Counted, never paged. The client
        // also declines to send these, but old clients ship from SW caches for
        // weeks; this branch is the authority (see [`is_foreign_code_error`]).
        tracing::info!(
            target: "web_crash",
            %kind,
            %surface,
            %version,
            %build,
            %path,
            %message,
            %stack,
            "web app foreign-code error",
        );
    } else {
        tracing::warn!(
            target: "web_crash",
            %kind,
            %surface,
            %version,
            %build,
            %path,
            %message,
            %stack,
            "web app crash",
        );
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Trim an untrusted telemetry string to a bounded, single-line snippet:
/// replace control characters with spaces (newlines included, so it can't
/// forge extra log lines) and cap the length. Same guarantee as the Activity
/// beacon's clamp — a hostile beacon can neither spam nor corrupt the log.
///
/// Replaced, not dropped: the 2026-07-24 page glued a six-line Safari stack
/// into the unreadable `@@@Pk@Nk@Pk@` — keeping a space where each newline was
/// (`@ @ @ Pk@ Nk@ Pk@`) keeps the frame boundaries legible in the one-line
/// log without weakening the injection guarantee.
fn clamp_field(s: &str, max: usize) -> String {
    s.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(max)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_replaces_control_chars_including_newlines() {
        // A forged log line (embedded newline + fake fields) collapses to one
        // line; the space keeps adjacent tokens (stack frames) readable.
        let hostile = "boom\n2026-01-01 INFO forged=line\ttab";
        let out = clamp_field(hostile, 100);
        assert!(!out.contains('\n'));
        assert!(!out.contains('\t'));
        assert_eq!(out, "boom 2026-01-01 INFO forged=line tab");
    }

    #[test]
    fn clamp_keeps_stack_frames_legible() {
        // The 2026-07-24 shape: a multi-line Safari stack must not fuse into
        // `@@@Pk@Nk@Pk@` — one space per frame boundary.
        assert_eq!(
            clamp_field("@\n@\n@\nPk@\nNk@\nPk@", 100),
            "@ @ @ Pk@ Nk@ Pk@"
        );
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

    #[test]
    fn resize_observer_notice_is_not_a_crash() {
        // The beacon that started this: a benign browser signal, not a crash.
        assert!(is_non_crash(
            "ResizeObserver loop completed with undelivered notifications"
        ));
        assert!(is_non_crash("ResizeObserver loop limit exceeded"));
        // Browsers prefix the message on some paths.
        assert!(is_non_crash("Uncaught ResizeObserver loop limit exceeded"));
    }

    #[test]
    fn real_crashes_still_log() {
        assert!(!is_non_crash(
            "Cannot read properties of undefined (reading 'id')"
        ));
        // Mentioning the API isn't the same as being the loop notice.
        assert!(!is_non_crash("ResizeObserver is not defined"));
        assert!(!is_non_crash(""));
    }

    #[test]
    fn stale_chunk_beacons_are_routine_for_every_non_fatal_kind() {
        // The exact shape the 2026-07-17 page carried: an old client's boundary
        // crash on a purged chunk. Info, not a page.
        let msg = "Failed to fetch dynamically imported module: \
                   https://dweeb.faizo.net/assets/TemplateGallery-eyaR9UxE.js";
        assert!(is_routine_stale_chunk("boundary", msg));
        // Legacy window traps and the new handled kind are routine too.
        assert!(is_routine_stale_chunk("unhandledrejection", msg));
        assert!(is_routine_stale_chunk("error", msg));
        assert!(is_routine_stale_chunk("stale-chunk", msg));
        // Other engines' wording.
        assert!(is_routine_stale_chunk(
            "boundary",
            "error loading dynamically imported module: https://x/a.js"
        ));
        assert!(is_routine_stale_chunk(
            "boundary",
            "Importing a module script failed."
        ));
        assert!(is_routine_stale_chunk(
            "boundary",
            "Unable to preload CSS for /assets/App-abc.css"
        ));
    }

    #[test]
    fn fatal_stale_chunk_still_pages() {
        // A current client whose app went down on a chunk the client re-requested
        // and found gone — broken deploy or SW precache gap. Stays warn.
        assert!(!is_routine_stale_chunk(
            "stale-chunk-fatal",
            "Failed to fetch dynamically imported module: https://x/a.js"
        ));
    }

    #[test]
    fn a_chunk_that_is_still_served_is_the_visitors_network_not_a_page() {
        // The 2026-07-28 page verbatim: the app went down on these two, but both
        // were being served by the current deploy — the fetches lost, nothing was
        // stale. The client now re-requests before reporting and sends this kind.
        assert!(is_routine_stale_chunk(
            "chunk-unreachable",
            "Failed to fetch dynamically imported module: \
             https://dweeb.faizo.net/assets/acquisition-rapBslg9.js"
        ));
        assert!(is_routine_stale_chunk(
            "chunk-unreachable",
            "Unable to preload CSS for /assets/useBarWidth-CLpGG8DF.css"
        ));
    }

    #[test]
    fn background_only_chunk_is_routine_even_when_reported_fatal() {
        // The 2026-07-27 page verbatim: the post-paint service-worker
        // registration chunk, purged by a deploy the tab outlived. Nothing on
        // screen waited for it, so it is skew — never a page — no matter that a
        // pre-fix client (which keeps shipping from its SW cache for weeks)
        // escalated the unhandled rejection to `stale-chunk-fatal`.
        let msg = "Failed to fetch dynamically imported module: \
                   https://dweeb.faizo.net/assets/virtual_pwa-register-BgZHO7yx.js";
        assert!(is_routine_stale_chunk("stale-chunk-fatal", msg));
        // And the kind the fixed client now sends for the same event.
        assert!(is_routine_stale_chunk("stale-chunk", msg));
    }

    #[test]
    fn only_background_chunks_are_exempt_from_the_fatal_rule() {
        // A real surface chunk going down keeps paging — the exemption is by
        // chunk name, not a blanket softening of `stale-chunk-fatal`.
        assert!(!is_routine_stale_chunk(
            "stale-chunk-fatal",
            "Failed to fetch dynamically imported module: \
             https://dweeb.faizo.net/assets/TemplateGallery-eyaR9UxE.js"
        ));
        // Naming the module without failing to load it isn't skew at all.
        assert!(!is_routine_stale_chunk(
            "stale-chunk-fatal",
            "Cannot read properties of undefined (reading 'virtual_pwa-register')"
        ));
    }

    #[test]
    fn non_chunk_crashes_are_never_routine() {
        assert!(!is_routine_stale_chunk("boundary", "Failed to fetch")); // plain network error
        assert!(!is_routine_stale_chunk(
            "boundary",
            "Cannot read properties of undefined (reading 'id')"
        ));
        assert!(!is_routine_stale_chunk("boundary", ""));
    }

    #[test]
    fn unattributed_stacks_are_foreign_not_a_page() {
        // The 2026-07-24 page verbatim: a Safari user's eval'd/injected script
        // overflowed its own stack. No frame carries a script URL, so it cannot
        // be code we served (checked post-clamp, newlines already spaces).
        assert!(is_foreign_code_error(
            "error",
            "Maximum call stack size exceeded.",
            "@ @ @ Pk@ Nk@ Pk@"
        ));
        // V8's eval wording is equally unattributed.
        assert!(is_foreign_code_error(
            "error",
            "Maximum call stack size exceeded",
            "at Pk (<anonymous>) at Nk (<anonymous>)"
        ));
    }

    #[test]
    fn muted_cross_origin_script_error_is_foreign() {
        assert!(is_foreign_code_error("error", "Script error.", ""));
        // But only with the empty stack the mute implies — and only verbatim-ish.
        assert!(!is_foreign_code_error(
            "error",
            "Script error.",
            "Pk@https://dweeb.faizo.net/assets/index-abc.js:1:2"
        ));
    }

    #[test]
    fn attributed_stacks_still_page() {
        // Any frame with a real script URL means it can be ours — warn.
        assert!(!is_foreign_code_error(
            "error",
            "Maximum call stack size exceeded.",
            "Pk@https://dweeb.faizo.net/assets/useBarWidth-Dcpvcuzg.js:41:9528 Nk@https://dweeb.faizo.net/assets/useBarWidth-Dcpvcuzg.js:41:9600"
        ));
        // Extension frames carry a URL too; deliberately still a page.
        assert!(!is_foreign_code_error(
            "error",
            "boom",
            "hook@safari-web-extension://abc/inject.js:1:2"
        ));
    }

    #[test]
    fn empty_stack_with_ordinary_message_still_pages() {
        // Our own code can `throw "string"` (no stack attached) — that must
        // keep paging.
        assert!(!is_foreign_code_error("error", "invalid share token", ""));
    }

    #[test]
    fn only_the_window_error_trap_is_ever_foreign() {
        // A boundary crash took the app down and a rejection dropped real work;
        // both keep paging even when the (6-frame-cut) stack looks foreign.
        assert!(!is_foreign_code_error("boundary", "boom", "@ @ Pk@"));
        assert!(!is_foreign_code_error(
            "unhandledrejection",
            "boom",
            "@ @ Pk@"
        ));
        assert!(!is_foreign_code_error("boundary", "Script error.", ""));
    }
}
