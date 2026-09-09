//! Which 5xx pages.
//!
//! `TraceLayer`'s stock `on_failure` logs every 5xx at ERROR, and `dweeb-alerts`
//! forwards backend ERRORs to Discord — so the level of that one line is the
//! alerting decision. This plugin's only upstream is Discord, and Discord being
//! slow or briefly broken is nothing this box can fix: it self-heals, and it
//! isn't ours. The rule is by status, because a plugin's statuses are few and
//! `rest::ConnectError::status` is the only place that mints them:
//!
//! - **504** (Discord took the request and didn't answer in time) and **503**
//!   (Discord answered 5xx or dropped the connection) are logged at WARN and
//!   never page;
//! - **500** (our credential rejected, our store failed) and **502** (we could
//!   not even connect to Discord, or couldn't read its reply) keep paging.
//!
//! Same split the dispatcher draws for its forward hop (dial = ours, timeout =
//! theirs) and the proxy draws for its own Discord calls. The ERROR line is
//! byte-for-byte the one tower-http emitted, under its target, so nothing
//! downstream (the alerter, greps, runbooks) can tell the difference.

use std::time::Duration;

use axum::http::StatusCode;
use tower_http::classify::ServerErrorsFailureClass;
use tracing::Span;

/// Whether a failing status is logged at ERROR — the level the alerter pages on.
pub fn status_pages(status: StatusCode) -> bool {
    !matches!(
        status,
        StatusCode::SERVICE_UNAVAILABLE | StatusCode::GATEWAY_TIMEOUT
    )
}

/// The `on_failure` for this service's `TraceLayer`.
pub fn on_failure(failure: ServerErrorsFailureClass, latency: Duration, _span: &Span) {
    let latency = format!("{} ms", latency.as_millis());
    match &failure {
        ServerErrorsFailureClass::StatusCode(status) if !status_pages(*status) => {
            tracing::warn!(
                target: "upstream",
                classification = %failure,
                %latency,
                "upstream failed"
            );
        }
        _ => {
            tracing::error!(
                target: "tower_http::trace::on_failure",
                classification = %failure,
                %latency,
                "response failed"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exemption is exactly the two statuses that mean "Discord, not us".
    #[test]
    fn only_discords_own_trouble_is_exempt_from_paging() {
        assert!(!status_pages(StatusCode::SERVICE_UNAVAILABLE));
        assert!(!status_pages(StatusCode::GATEWAY_TIMEOUT));
        assert!(status_pages(StatusCode::INTERNAL_SERVER_ERROR));
        assert!(status_pages(StatusCode::BAD_GATEWAY));
        assert!(status_pages(StatusCode::NOT_IMPLEMENTED));
    }
}
