//! Opt-in short links for the builder's share feature.
//!
//! The default share link keeps the whole message in the URL hash (`#s=…`), so
//! it never reaches a server. A *short* link is the explicit exception: the
//! browser POSTs the compressed share token here, we store it in SQLite under
//! a random base62 id, and the builder shares `https://<frontend>/s/<id>`.
//! Opening that URL resolves the token back via `GET /api/shortlink/:id`.
//!
//! Expiry is enforced twice over so a link is dead the second its TTL (default
//! 7 days) passes, not merely whenever cleanup happens to run:
//!   - reads filter on `expires_at > now`, so an expired row 404s immediately;
//!   - an hourly sweep (spawned in `main`) physically deletes expired rows.
//!
//! SQLite is the right store here for the same reason the dispatcher uses it:
//! one file on a volume, survives restarts (a 7-day promise must outlive a
//! redeploy), and a primary-key point lookup is microseconds — the request is
//! all network. WAL mode keeps reads from blocking behind writes.
//!
//! Abuse guards, since creation is anonymous by design (sharing must not
//! require a Discord login): the per-IP rate limiter covers both endpoints, the
//! value must *look* like a DWEEB share token (`<version>.<lz body>`) under a
//! size cap so this can't serve as a general blob store, and a total-row cap
//! bounds worst-case disk usage.

use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};

use crate::sqlite_pool::SqlitePool;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Path as UrlPath, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::json;

use crate::error::AppError;
use crate::routes::AppState;

/// Hard cap on a stored token. Even a maxed-out message compresses well under
/// this; anything bigger isn't a share token.
const MAX_TOKEN_LEN: usize = 30_000;

/// base62 — URL-clean, no escaping needed in `/s/<id>`. 62^8 ids make a
/// collision (and guessing) astronomically unlikely.
const ID_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ID_LEN: usize = 8;

pub struct ShortLinkStore {
    pool: SqlitePool,
    ttl_secs: i64,
    max_entries: i64,
    /// Approximate row count, kept in step with inserts/sweeps so the storage
    /// cap doesn't cost a `COUNT(*)` table scan on every create.
    count: AtomicI64,
}

impl ShortLinkStore {
    /// Open (creating if needed) the SQLite file and prepare the schema.
    /// Errors are fatal to the caller — a deployment that promises short links
    /// must fail loudly if it can't store them.
    pub fn open(path: &str, ttl_days: u64, max_entries: u64) -> Result<Self, String> {
        if let Some(parent) = Path::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
            }
        }
        // WAL: readers never block behind the (rare) writer. NORMAL sync is
        // durable enough for cache-like data and skips an fsync per insert. Set
        // per connection in the pool's init.
        let pool = SqlitePool::open_default(path, |c: &Connection| {
            c.pragma_update(None, "journal_mode", "WAL")
                .map_err(|e| format!("journal_mode: {e}"))?;
            c.pragma_update(None, "synchronous", "NORMAL")
                .map_err(|e| format!("synchronous: {e}"))?;
            c.pragma_update(None, "busy_timeout", 5_000)
                .map_err(|e| format!("busy_timeout: {e}"))?;
            Ok(())
        })?;
        // Schema + initial count: one-time, so run once on a checked-out
        // connection rather than in the per-connection init above.
        {
            let conn = pool.get();
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS short_links (
                     id         TEXT PRIMARY KEY,
                     token      TEXT NOT NULL,
                     created_at INTEGER NOT NULL,
                     expires_at INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS short_links_expires ON short_links(expires_at);",
            )
            .map_err(|e| format!("schema: {e}"))?;
        }
        let count: i64 = pool
            .get()
            .query_row("SELECT COUNT(*) FROM short_links", [], |r| r.get(0))
            .map_err(|e| format!("count: {e}"))?;
        Ok(ShortLinkStore {
            pool,
            ttl_secs: (ttl_days as i64) * 86_400,
            max_entries: max_entries as i64,
            count: AtomicI64::new(count),
        })
    }

    /// Cheap connectivity probe for the readiness endpoint (see
    /// `LibraryStore::ping`): a `SELECT 1` on the shared connection.
    pub fn ping(&self) -> Result<(), String> {
        self.pool.ping()
    }

    /// Store `token` under a fresh id; returns `(id, expires_at)`.
    pub fn create(&self, token: &str) -> Result<(String, i64), CreateError> {
        if self.count.load(Ordering::Relaxed) >= self.max_entries {
            return Err(CreateError::Full);
        }
        let now = unix_now();
        let expires = now + self.ttl_secs;
        let conn = self.pool.get();
        // Collisions are ~impossible at 62^8; the PRIMARY KEY catches the
        // freak case and we simply roll a new id.
        for _ in 0..4 {
            let id = new_short_id().map_err(CreateError::Storage)?;
            match conn.execute(
                "INSERT INTO short_links (id, token, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![id, token, now, expires],
            ) {
                Ok(_) => {
                    self.count.fetch_add(1, Ordering::Relaxed);
                    return Ok((id, expires));
                }
                Err(rusqlite::Error::SqliteFailure(e, _))
                    if e.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    continue;
                }
                Err(e) => return Err(CreateError::Storage(e.to_string())),
            }
        }
        Err(CreateError::Storage("could not allocate an id".into()))
    }

    /// The token behind `id`, or `None` when it never existed *or has expired*
    /// — expiry is checked on every read, so links die on time even between
    /// sweeps.
    pub fn resolve(&self, id: &str) -> Result<Option<String>, String> {
        let conn = self.pool.get();
        conn.query_row(
            "SELECT token FROM short_links WHERE id = ?1 AND expires_at > ?2",
            rusqlite::params![id, unix_now()],
            |r| r.get::<_, String>(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other.to_string()),
        })
    }

    /// Physically delete expired rows; returns how many went. Run periodically
    /// from `main` — reads already ignore expired rows, this just reclaims the
    /// space and keeps the table tiny.
    pub fn sweep(&self) -> Result<usize, String> {
        let conn = self.pool.get();
        let deleted = conn
            .execute(
                "DELETE FROM short_links WHERE expires_at <= ?1",
                rusqlite::params![unix_now()],
            )
            .map_err(|e| e.to_string())?;
        self.count.fetch_sub(deleted as i64, Ordering::Relaxed);
        Ok(deleted)
    }

    pub fn ttl_days(&self) -> i64 {
        self.ttl_secs / 86_400
    }
}

#[derive(Debug)]
pub enum CreateError {
    /// The row cap is reached — answer 503, existing links keep working.
    Full,
    Storage(String),
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Unbiased random base62 id via rejection sampling (256 % 62 != 0, so the
/// tail values are rejected rather than folded in).
fn new_short_id() -> Result<String, String> {
    let max = 256 - (256 % ID_ALPHABET.len()); // 248
    let mut id = String::with_capacity(ID_LEN);
    while id.len() < ID_LEN {
        let mut buf = [0u8; ID_LEN];
        getrandom::getrandom(&mut buf).map_err(|e| format!("rng: {e}"))?;
        for b in buf {
            if (b as usize) < max && id.len() < ID_LEN {
                id.push(ID_ALPHABET[b as usize % ID_ALPHABET.len()] as char);
            }
        }
    }
    Ok(id)
}

// ── Validation ──────────────────────────────────────────────────────────────

/// `<digits>.<lz-string url-safe body>` — lz-string's URL-safe alphabet is
/// `[A-Za-z0-9]` plus `+ - $`; the prefix is the numeric schema version.
fn is_share_token(s: &str) -> bool {
    let Some((version, body)) = s.split_once('.') else {
        return false;
    };
    !version.is_empty()
        && version.bytes().all(|b| b.is_ascii_digit())
        && !body.is_empty()
        && body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'$'))
}

/// Ids minted above are 8 chars; accept a small range so the format can grow.
fn is_short_id(s: &str) -> bool {
    (4..=16).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

// ── Handlers ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ShortenBody {
    pub token: String,
}

/// The store, or a clear "not enabled here" for deployments that turned the
/// feature off (`SHORTLINK_TTL_DAYS=0`).
fn store(st: &AppState) -> Result<&std::sync::Arc<ShortLinkStore>, AppError> {
    st.shortlinks.as_ref().ok_or_else(|| AppError::Status {
        status: StatusCode::NOT_IMPLEMENTED,
        message: "Short links aren't enabled on this deployment.".into(),
        retry_after: None,
    })
}

fn bad_request(message: &str) -> AppError {
    AppError::Status {
        status: StatusCode::BAD_REQUEST,
        message: message.into(),
        retry_after: None,
    }
}

/// `POST /api/shortlink` `{ token }` → `201 { id, expires_at }`.
pub async fn shortlink_create(
    State(st): State<AppState>,
    Json(body): Json<ShortenBody>,
) -> Result<Response, AppError> {
    let store = std::sync::Arc::clone(store(&st)?);
    if body.token.is_empty() {
        return Err(bad_request("Missing share token."));
    }
    if body.token.len() > MAX_TOKEN_LEN {
        return Err(AppError::Status {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            message: "Message is too large to shorten.".into(),
            retry_after: None,
        });
    }
    if !is_share_token(&body.token) {
        return Err(bad_request("That doesn't look like a share token."));
    }

    // SQLite calls are blocking-but-microseconds; hop off the async runtime so
    // a slow disk can never stall unrelated requests.
    let result = tokio::task::spawn_blocking(move || store.create(&body.token))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    match result {
        Ok((id, expires_at)) => Ok((
            StatusCode::CREATED,
            [(header::CACHE_CONTROL, "no-store")],
            Json(json!({ "id": id, "expires_at": expires_at })),
        )
            .into_response()),
        Err(CreateError::Full) => Err(AppError::Status {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: "Short-link storage is full — use the regular share link.".into(),
            retry_after: None,
        }),
        Err(CreateError::Storage(e)) => Err(AppError::Internal(format!("shortlink store: {e}"))),
    }
}

/// `GET /api/shortlink/:id` → `200 { token }`, or 404 once expired/unknown.
pub async fn shortlink_resolve(
    State(st): State<AppState>,
    UrlPath(id): UrlPath<String>,
) -> Result<Response, AppError> {
    let store = std::sync::Arc::clone(store(&st)?);
    if !is_short_id(&id) {
        return Err(bad_request("Invalid short link."));
    }
    let token = tokio::task::spawn_blocking(move || store.resolve(&id))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(|e| AppError::Internal(format!("shortlink store: {e}")))?;
    match token {
        Some(token) => Ok((
            [(header::CACHE_CONTROL, "no-store")],
            Json(json!({ "token": token })),
        )
            .into_response()),
        None => Err(AppError::Status {
            status: StatusCode::NOT_FOUND,
            message: "This short link has expired or doesn't exist.".into(),
            retry_after: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `tag` keeps each test on its own file — tests run in parallel, so a
    /// shared name would mean a shared database.
    fn temp_store(tag: &str, max_entries: u64) -> (ShortLinkStore, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "dweeb-shortlink-test-{}-{tag}.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let store = ShortLinkStore::open(path.to_str().unwrap(), 7, max_entries).unwrap();
        (store, path)
    }

    #[test]
    fn ping_answers_on_open_store() {
        // The readiness probe's building block: an open store answers `SELECT 1`.
        let (store, path) = temp_store("ping", 100);
        assert!(store.ping().is_ok());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn create_resolve_roundtrip() {
        let (store, path) = temp_store("roundtrip", 100);
        let (id, expires) = store.create("12.AbC$+-xyz").expect("create");
        assert_eq!(id.len(), ID_LEN);
        assert!(expires > unix_now() + 6 * 86_400);
        assert_eq!(store.resolve(&id).unwrap().as_deref(), Some("12.AbC$+-xyz"));
        assert_eq!(store.resolve("zzzzzzzz").unwrap(), None);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn expired_links_404_and_sweep() {
        let (store, path) = temp_store("expiry", 100);
        let (id, _) = store.create("1.live").expect("create");
        // Backdate the row past its TTL: it must vanish from reads at once,
        // and the sweep must physically delete it.
        {
            let conn = store.pool.get();
            conn.execute(
                "UPDATE short_links SET expires_at = ?1 WHERE id = ?2",
                rusqlite::params![unix_now() - 1, id],
            )
            .unwrap();
        }
        assert_eq!(store.resolve(&id).unwrap(), None);
        assert_eq!(store.sweep().unwrap(), 1);
        assert_eq!(store.count.load(Ordering::Relaxed), 0);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn storage_cap_refuses_creates() {
        let (store, path) = temp_store("cap", 1);
        store.create("1.a").expect("first create fits");
        assert!(matches!(store.create("1.b"), Err(CreateError::Full)));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn token_and_id_validation() {
        assert!(is_share_token("3.N4IgdghgtgpiBcBtUBxA9gJ0$+-"));
        assert!(!is_share_token("no-dot"));
        assert!(!is_share_token(".body"));
        assert!(!is_share_token("v1.body")); // version must be digits
        assert!(!is_share_token("1.")); // empty body
        assert!(!is_share_token("1.sp ace"));
        assert!(!is_share_token("1.semi;colon"));

        assert!(is_short_id("AbCd1234"));
        assert!(!is_short_id("abc")); // too short
        assert!(!is_short_id("aaaaaaaaaaaaaaaaa")); // too long
        assert!(!is_short_id("ab/../cd"));
    }
}
