//! A single error type that every handler can return. It knows how to turn
//! itself into a JSON HTTP response so handlers stay terse (`?` everywhere)
//! and clients always get a consistent `{ error, status }` shape.

use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{Map, Value};

/// Whose fault a 5xx is — which is to say, whether it pages.
///
/// `tower_http`'s trace layer reports every 5xx through `on_failure`, and
/// `dweeb-alerts` forwards backend ERRORs to Discord, so the *level* that one
/// line is logged at is the alerting decision. `crate::trace` picks the level
/// from this marker, which [`AppError::into_response`] attaches to every 5xx
/// response as an extension. Statuses stay honest — a 502 is still a 502 to the
/// caller — only the paging changes.
///
/// `Ours` (the default) is our configuration, our code, our infrastructure: a
/// rejected bot token, an unreachable dispatcher, one of our own plugin hosts
/// down, a store that won't open. It pages at ERROR. `Upstream` is a dependency
/// we don't operate taking the request and failing us — Discord timing out,
/// answering 5xx, or dropping the connection mid-flight. Nothing on this box
/// fixes that and it self-heals, so it is logged at WARN: still greppable
/// (`upstream failed`, inside the request span that names the route), never
/// paged. Between 2026-08-23 and 2026-09-05 nine such 502s paged the maintainer
/// — the flat `latency=10002 ms` ones are Discord not answering a JSON read
/// inside the ten-second client deadline — and not one was actionable. This is
/// the split the dispatcher already draws for its forward to a plugin (dial =
/// ours, timeout = theirs), applied to the proxy's own calls out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    Ours,
    Upstream,
}

pub enum AppError {
    /// Caller failed the API-key check.
    Unauthorized(String),
    /// Caller asked for a guild outside the allowlist.
    Forbidden(String),
    /// A 502 that is **our** fault ([`Fault::Ours`]): our credential rejected,
    /// our dispatcher or one of our own plugin hosts unreachable, a reply of a
    /// shape our code doesn't understand. Pages. For a dependency's own
    /// transient failure use [`AppError::Upstream`] (or [`AppError::gateway`]
    /// when the fault is decided at runtime).
    BadGateway(String),
    /// A 502 that is a dependency's fault ([`Fault::Upstream`]): Discord timed
    /// out, answered 5xx, or dropped the connection. Same status to the caller,
    /// logged at WARN instead of paged.
    Upstream(String),
    /// Unexpected internal failure (e.g. serialising our own response).
    Internal(String),
    /// Pass a specific status straight through to the caller — used for the
    /// cases where Discord's status is genuinely meaningful to the client
    /// (404 unknown guild, 429 rate limit).
    Status {
        status: StatusCode,
        message: String,
        retry_after: Option<f64>,
    },
}

impl AppError {
    /// A transient upstream failure — see [`Fault::Upstream`].
    pub fn upstream(message: impl Into<String>) -> AppError {
        AppError::Upstream(message.into())
    }

    /// A 502 whose fault class — and so whether it pages — is decided by the
    /// caller, typically from what kind of failure a transport error was.
    pub fn gateway(fault: Fault, message: impl Into<String>) -> AppError {
        match fault {
            Fault::Ours => AppError::BadGateway(message.into()),
            Fault::Upstream => AppError::upstream(message),
        }
    }

    /// The fault class this error reports under. Meaningful for 5xx only; every
    /// variant but [`AppError::Upstream`] is ours.
    pub fn fault(&self) -> Fault {
        match self {
            AppError::Upstream(_) => Fault::Upstream,
            _ => Fault::Ours,
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::Unauthorized(m)
            | AppError::Forbidden(m)
            | AppError::BadGateway(m)
            | AppError::Upstream(m)
            | AppError::Internal(m) => write!(f, "{m}"),
            AppError::Status {
                status, message, ..
            } => write!(f, "{status}: {message}"),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let fault = self.fault();
        let (status, message, retry_after) = match self {
            AppError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m, None),
            AppError::Forbidden(m) => (StatusCode::FORBIDDEN, m, None),
            AppError::BadGateway(m) => (StatusCode::BAD_GATEWAY, m, None),
            AppError::Upstream(m) => (StatusCode::BAD_GATEWAY, m, None),
            AppError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m, None),
            AppError::Status {
                status,
                message,
                retry_after,
            } => (status, message, retry_after),
        };

        // Attach the reason to the request span so `tower_http`'s failure line —
        // the one that pages — carries it. Without this the alert states only the
        // status and the latency, and the message explaining *why* exists solely
        // in the response body, which no operator ever sees. 5xx only: a 4xx is
        // the caller's problem, is not logged, and is often high-volume.
        if status.is_server_error() {
            tracing::Span::current().record("error", tracing::field::display(&message));
        }

        let mut obj = Map::new();
        obj.insert("error".to_string(), Value::String(message));
        obj.insert("status".to_string(), Value::from(status.as_u16()));
        if let Some(ra) = retry_after {
            obj.insert("retry_after".to_string(), Value::from(ra));
        }

        let mut resp = (status, Json(Value::Object(obj))).into_response();

        // The paging decision rides on the response as an extension, where
        // `crate::trace`'s classifier reads it back. 5xx only — nothing else is
        // ever a failure to the trace layer.
        if status.is_server_error() {
            resp.extensions_mut().insert(fault);
        }

        // Mirror the rate-limit hint as a real header too, so well-behaved
        // clients can back off without parsing the body.
        if let Some(ra) = retry_after {
            if let Ok(hv) = HeaderValue::from_str(&ra.to_string()) {
                resp.headers_mut().insert(header::RETRY_AFTER, hv);
            }
        }
        resp
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The marker is what `crate::trace` pages on, so it must be present on
    /// every 5xx and absent from everything else.
    #[test]
    fn every_5xx_carries_its_fault_and_nothing_else_does() {
        let ours = AppError::BadGateway("couldn't reach the dispatcher".into()).into_response();
        assert_eq!(ours.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(ours.extensions().get::<Fault>(), Some(&Fault::Ours));

        let theirs = AppError::upstream("could not reach Discord: timed out").into_response();
        assert_eq!(
            theirs.status(),
            StatusCode::BAD_GATEWAY,
            "same status to the caller"
        );
        assert_eq!(theirs.extensions().get::<Fault>(), Some(&Fault::Upstream));

        let internal = AppError::Internal("x".into()).into_response();
        assert_eq!(internal.extensions().get::<Fault>(), Some(&Fault::Ours));

        for not_a_failure in [
            AppError::Unauthorized("x".into()),
            AppError::Forbidden("x".into()),
            AppError::Status {
                status: StatusCode::TOO_MANY_REQUESTS,
                message: "x".into(),
                retry_after: Some(1.0),
            },
        ] {
            let resp = not_a_failure.into_response();
            assert!(
                resp.extensions().get::<Fault>().is_none(),
                "{}",
                resp.status()
            );
        }
    }

    /// `gateway` is the runtime switch the Discord client uses once it knows
    /// what kind of failure it saw; the two arms must land on the two variants.
    #[test]
    fn gateway_picks_the_variant_from_the_fault() {
        assert_eq!(AppError::gateway(Fault::Ours, "x").fault(), Fault::Ours);
        assert_eq!(
            AppError::gateway(Fault::Upstream, "x").fault(),
            Fault::Upstream
        );
        assert!(matches!(
            AppError::gateway(Fault::Upstream, "x"),
            AppError::Upstream(_)
        ));
    }
}
