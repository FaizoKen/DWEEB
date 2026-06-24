//! A single error type that every handler can return. It knows how to turn
//! itself into a JSON HTTP response so handlers stay terse (`?` everywhere)
//! and clients always get a consistent `{ error, status }` shape.

use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{Map, Value};

pub enum AppError {
    /// Caller failed the API-key check.
    Unauthorized(String),
    /// Caller asked for a guild outside the allowlist.
    Forbidden(String),
    /// We couldn't reach Discord, or it returned something unusable. These are
    /// our-side / upstream problems, surfaced as 502 so callers don't mistake
    /// them for their own bad request.
    BadGateway(String),
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

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::Unauthorized(m)
            | AppError::Forbidden(m)
            | AppError::BadGateway(m)
            | AppError::Internal(m) => write!(f, "{m}"),
            AppError::Status {
                status, message, ..
            } => write!(f, "{status}: {message}"),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message, retry_after) = match self {
            AppError::Unauthorized(m) => (StatusCode::UNAUTHORIZED, m, None),
            AppError::Forbidden(m) => (StatusCode::FORBIDDEN, m, None),
            AppError::BadGateway(m) => (StatusCode::BAD_GATEWAY, m, None),
            AppError::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m, None),
            AppError::Status {
                status,
                message,
                retry_after,
            } => (status, message, retry_after),
        };

        let mut obj = Map::new();
        obj.insert("error".to_string(), Value::String(message));
        obj.insert("status".to_string(), Value::from(status.as_u16()));
        if let Some(ra) = retry_after {
            obj.insert("retry_after".to_string(), Value::from(ra));
        }

        let mut resp = (status, Json(Value::Object(obj))).into_response();

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
