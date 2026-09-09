//! Which 5xx pages.
//!
//! `TraceLayer`'s stock classifier calls every 5xx a failure and its stock
//! `on_failure` logs each one at ERROR; `dweeb-alerts` forwards backend ERRORs
//! to Discord. So that one log line *is* the paging decision, and it used to be
//! made by status alone — wrong for exactly one class: a dependency we don't
//! operate failing us transiently. Nine proxy 502s paged between 2026-08-23 and
//! 2026-09-05 (the flat `latency=10002 ms` ones are Discord not answering a JSON
//! read inside the ten-second client deadline); not one was actionable.
//!
//! [`AppError::into_response`](crate::error::AppError) marks every 5xx with a
//! [`Fault`]; the classifier here reads it back, and [`on_failure`] logs `Ours`
//! at ERROR — byte-for-byte the line tower-http emitted, under its target, so
//! `dweeb-alerts` and every grep still match — and `Upstream` at WARN, which
//! never pages. The response is untouched: the caller still gets its 502, its
//! message, and its `Retry-After`.
//!
//! Only a 5xx is ever a failure. A 4xx is the caller's problem and is not logged.

use std::fmt;
use std::time::Duration;

use axum::http::{Response, StatusCode};
use tower_http::classify::{
    ClassifiedResponse, ClassifyResponse, NeverClassifyEos, SharedClassifier,
};
use tracing::Span;

use crate::error::Fault;

/// How a request failed, as far as paging is concerned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RequestFailure {
    /// A 5xx that is ours — or unmarked, which is treated as ours. Pages.
    Ours(StatusCode),
    /// A 5xx marked [`Fault::Upstream`]. Logged at WARN, never paged.
    Upstream(StatusCode),
    /// The inner service itself failed. Axum services are infallible, so this
    /// never fires; kept so the classifier is total.
    Error(String),
}

impl RequestFailure {
    /// Whether this failure is logged at ERROR — the level `dweeb-alerts` pages on.
    pub fn pages(&self) -> bool {
        !matches!(self, RequestFailure::Upstream(_))
    }
}

/// Same wording as tower-http's `ServerErrorsFailureClass`, so the ERROR line
/// `dweeb-alerts` forwards — and every runbook written against it — reads
/// exactly as it did.
impl fmt::Display for RequestFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RequestFailure::Ours(code) | RequestFailure::Upstream(code) => {
                write!(f, "Status code: {code}")
            }
            RequestFailure::Error(e) => write!(f, "Error: {e}"),
        }
    }
}

/// Classifies a response by status and, for a 5xx, by the [`Fault`] marker the
/// error type left on it.
#[derive(Clone, Copy, Debug, Default)]
pub struct FaultClassifier;

impl FaultClassifier {
    /// The `MakeClassifier` that `TraceLayer::new` takes.
    pub fn make() -> SharedClassifier<Self> {
        SharedClassifier::new(Self)
    }
}

impl ClassifyResponse for FaultClassifier {
    type FailureClass = RequestFailure;
    type ClassifyEos = NeverClassifyEos<RequestFailure>;

    fn classify_response<B>(
        self,
        res: &Response<B>,
    ) -> ClassifiedResponse<RequestFailure, Self::ClassifyEos> {
        let status = res.status();
        if !status.is_server_error() {
            return ClassifiedResponse::Ready(Ok(()));
        }
        let failure = match res.extensions().get::<Fault>() {
            Some(Fault::Upstream) => RequestFailure::Upstream(status),
            _ => RequestFailure::Ours(status),
        };
        ClassifiedResponse::Ready(Err(failure))
    }

    fn classify_error<E>(self, error: &E) -> RequestFailure
    where
        E: fmt::Display + 'static,
    {
        RequestFailure::Error(error.to_string())
    }
}

/// The `on_failure` for `TraceLayer`. Runs inside the request span, so both
/// lines carry `method`, `path`, and the `error` the handler recorded.
pub fn on_failure(failure: RequestFailure, latency: Duration, _span: &Span) {
    let latency = format!("{} ms", latency.as_millis());
    if failure.pages() {
        tracing::error!(
            target: "tower_http::trace::on_failure",
            classification = %failure,
            %latency,
            "response failed"
        );
    } else {
        tracing::warn!(
            target: "upstream",
            classification = %failure,
            %latency,
            "upstream failed"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::io::Write;
    use std::sync::{Arc, Mutex};

    use axum::body::Body;
    use axum::response::IntoResponse;
    use tracing_subscriber::fmt::MakeWriter;

    use crate::error::AppError;

    fn classify(resp: &Response<Body>) -> Result<(), RequestFailure> {
        match FaultClassifier.classify_response(resp) {
            ClassifiedResponse::Ready(r) => r,
            ClassifiedResponse::RequiresEos(_) => panic!("never classifies on end-of-stream"),
        }
    }

    /// The whole point: a dependency's transient failure is a failure that does
    /// not page, ours still does, and an unmarked 5xx is treated as ours.
    #[test]
    fn a_dependencys_failure_warns_and_ours_pages() {
        let theirs = AppError::upstream("could not reach Discord: timed out").into_response();
        let f = classify(&theirs).unwrap_err();
        assert_eq!(f, RequestFailure::Upstream(StatusCode::BAD_GATEWAY));
        assert!(!f.pages());

        let ours = AppError::BadGateway("couldn't reach the dispatcher".into()).into_response();
        let f = classify(&ours).unwrap_err();
        assert_eq!(f, RequestFailure::Ours(StatusCode::BAD_GATEWAY));
        assert!(f.pages());

        // A handler answering a bare status carries no marker: ours.
        let bare = StatusCode::INTERNAL_SERVER_ERROR.into_response();
        assert!(classify(&bare).unwrap_err().pages());

        // Nothing below 500 is a failure at all.
        for status in [
            StatusCode::OK,
            StatusCode::NOT_FOUND,
            StatusCode::TOO_MANY_REQUESTS,
        ] {
            assert!(classify(&status.into_response()).is_ok(), "{status}");
        }
    }

    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Vec<u8>>>);
    impl Write for Capture {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl<'a> MakeWriter<'a> for Capture {
        type Writer = Capture;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    /// The paging line must be byte-compatible with what tower-http emitted
    /// (target included), and the non-paging one must be WARN under another
    /// target — `dweeb-alerts` keys on `ERROR`, and its runbooks on the wording.
    #[test]
    fn the_paging_line_is_unchanged_and_the_other_is_a_warn() {
        let capture = Capture::default();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(capture.clone())
            .with_ansi(false)
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            on_failure(
                RequestFailure::Ours(StatusCode::BAD_GATEWAY),
                Duration::from_millis(10002),
                &Span::none(),
            );
            on_failure(
                RequestFailure::Upstream(StatusCode::BAD_GATEWAY),
                Duration::from_millis(10002),
                &Span::none(),
            );
        });
        let out = String::from_utf8(capture.0.lock().unwrap().clone()).unwrap();
        let mut lines = out.lines();
        let paged = lines.next().expect("error line");
        let warned = lines.next().expect("warn line");
        assert!(paged.contains(" ERROR "), "{paged}");
        assert!(
            paged.contains(
                "tower_http::trace::on_failure: response failed \
                 classification=Status code: 502 Bad Gateway latency=10002 ms"
            ),
            "{paged}"
        );
        assert!(warned.contains(" WARN "), "{warned}");
        assert!(
            warned
                .contains("upstream: upstream failed classification=Status code: 502 Bad Gateway"),
            "{warned}"
        );
        assert!(!warned.contains("ERROR"), "{warned}");
    }
}
