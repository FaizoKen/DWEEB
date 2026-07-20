//! Hosting for webhook avatar images uploaded in the builder.
//!
//! ## Why this store has to exist at all
//!
//! Discord's execute-webhook `avatar_url` is **hot-linked, not re-hosted**: the
//! URL string is stored on the message and fetched by Discord's client every
//! time that message is rendered, forever. Two consequences drive this whole
//! module:
//!
//!  1. **The URL must outlive the send.** Every "cheap" design that hosts the
//!     bytes only briefly (an in-memory TTL map, a short-lived signed link) puts
//!     a broken image in a permanent message. There is no ephemeral option.
//!  2. **Discord's own attachment CDN is not a shortcut.** Uploading the image
//!     as a throwaway webhook message and reusing its `cdn.discordapp.com/
//!     attachments/…` link does not work: Discord rejects its own attachment
//!     URLs in `avatar_url`, with *and* without the `?ex=&is=&hm=` signature
//!     params (discord/discord-api-docs#6657). Don't reintroduce that trick.
//!
//! So an uploaded avatar needs durable, publicly-reachable hosting, and this is
//! the smallest thing that provides it.
//!
//! ## Why the rows are never swept
//!
//! Unlike [`crate::shortlink`] — whose rows carry a 7-day promise and are
//! deliberately reaped — an avatar row is referenced by a Discord message we do
//! not own and cannot rewrite. Deleting it does not expire a link; it silently
//! replaces someone's avatar with a broken image in a message that may be years
//! old and pinned. **There is therefore no TTL and no sweep here on purpose.**
//! If you are tempted to add one, re-read this paragraph.
//!
//! Storage is bounded instead by the three things that *can* be bounded without
//! breaking a live message:
//!
//!  - **Content addressing.** The row key is the SHA-256 of the bytes, so the
//!    same avatar reused across messages, servers, and users is stored once. In
//!    practice a user cycles a handful of images, so re-uploads are free.
//!  - **Size.** The client center-crops and downscales to 256×256 before
//!    uploading (see `src/core/avatar/image.ts`), so a row is ~10–60 KiB. The
//!    server re-checks the byte cap and the pixel bounds from the image header
//!    rather than trusting the client.
//!  - **Cardinality.** `AVATAR_MAX_ENTRIES` caps the row count. On reaching it
//!    uploads answer 503 and log a loud warning: an operator raises the cap or
//!    prunes deliberately. We never evict to make room, because eviction is
//!    exactly the silent breakage described above. `last_used_at` (touched at
//!    most daily, off the hot path) is what makes such a prune informed.
//!
//! ## Why the pixel bounds are strict
//!
//! Discord silently falls back to the default webhook avatar — no error, just a
//! wrong-looking message — when the image is over ~1 MiB or its smaller side
//! exceeds ~1024 px, and animated GIFs never render as avatars at all
//! (discord/discord-api-docs#830). Rejecting those here with a real message is
//! far kinder than shipping a send that "works" and looks broken in Discord.
//! We accept only PNG and JPEG, sniffed from the magic bytes rather than taken
//! from the `Content-Type` header.
//!
//! ## Why upload is sign-in gated but reads are open
//!
//! `GET` must be anonymous — Discord's image fetcher carries no credential, and
//! neither does an `<img>` tag. `POST` is session-gated so this cannot be used
//! as a general-purpose image host by anyone who finds the endpoint. Combined
//! with the global per-IP rate limiter and the row cap, that keeps the abuse
//! ceiling low without a per-user ledger.

use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::{Path as UrlPath, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::PrivateCookieJar;
use rusqlite::Connection;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::routes::AppState;
use crate::sqlite_pool::SqlitePool;

/// Discord starts ignoring avatars whose smaller side is much past this, so a
/// larger image would render as the default avatar with no error. The client
/// targets 256; this is the outer bound we still accept.
const MAX_DIMENSION: u32 = 1024;
/// Below this an "avatar" is almost certainly a mis-picked file, and it will
/// look terrible scaled up to Discord's display size.
const MIN_DIMENSION: u32 = 16;

/// A 64-char lowercase hex SHA-256.
const HASH_LEN: usize = 64;

/// How stale `last_used_at` may get before a read refreshes it. Reads are the
/// hot path (Discord re-fetches on cache miss), so this keeps the touch to at
/// most one write per avatar per day — the same write-throttling shape the
/// dispatcher's `ActivityMarks` uses.
const TOUCH_INTERVAL_SECS: i64 = 86_400;

/// The image formats Discord reliably renders as a webhook avatar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageFormat {
    Png,
    Jpeg,
}

impl ImageFormat {
    pub fn mime(self) -> &'static str {
        match self {
            ImageFormat::Png => "image/png",
            ImageFormat::Jpeg => "image/jpeg",
        }
    }

    /// Extension used in the public URL. Cosmetic — the row is keyed by hash —
    /// but some fetchers still sniff the path, and it makes logs readable.
    pub fn ext(self) -> &'static str {
        match self {
            ImageFormat::Png => "png",
            ImageFormat::Jpeg => "jpg",
        }
    }
}

pub struct AvatarStore {
    pool: SqlitePool,
    max_entries: i64,
    max_bytes: usize,
    /// Absolute public origin + path prefix the returned URL is built from,
    /// e.g. `https://api.dweeb.example.com/api/avatar`.
    public_base: String,
    /// Approximate row count, kept in step with inserts so the cap doesn't cost
    /// a `COUNT(*)` scan per upload (same approach as the short-link store).
    count: AtomicI64,
}

/// A stored image on its way back out to a fetcher.
pub struct StoredAvatar {
    pub bytes: Vec<u8>,
    pub mime: String,
}

impl AvatarStore {
    /// Open (creating if needed) the SQLite file and prepare the schema. Errors
    /// are fatal to the caller: a deployment that hands out permanent avatar
    /// URLs must be able to keep them.
    pub fn open(
        path: &str,
        max_entries: u64,
        max_bytes: usize,
        public_base: String,
    ) -> Result<Self, String> {
        if let Some(parent) = Path::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
            }
        }
        let pool = SqlitePool::open_default(path, |c: &Connection| {
            c.pragma_update(None, "journal_mode", "WAL")
                .map_err(|e| format!("journal_mode: {e}"))?;
            c.pragma_update(None, "synchronous", "NORMAL")
                .map_err(|e| format!("synchronous: {e}"))?;
            c.pragma_update(None, "busy_timeout", 5_000)
                .map_err(|e| format!("busy_timeout: {e}"))?;
            Ok(())
        })?;
        {
            let conn = pool.get();
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS avatars (
                     hash         TEXT PRIMARY KEY,
                     bytes        BLOB NOT NULL,
                     mime         TEXT NOT NULL,
                     width        INTEGER NOT NULL,
                     height       INTEGER NOT NULL,
                     created_at   INTEGER NOT NULL,
                     last_used_at INTEGER NOT NULL
                 );",
            )
            .map_err(|e| format!("schema: {e}"))?;
        }
        let count: i64 = pool
            .get()
            .query_row("SELECT COUNT(*) FROM avatars", [], |r| r.get(0))
            .map_err(|e| format!("count: {e}"))?;
        Ok(AvatarStore {
            pool,
            max_entries: max_entries as i64,
            max_bytes,
            public_base: public_base.trim_end_matches('/').to_string(),
            count: AtomicI64::new(count),
        })
    }

    /// Cheap connectivity probe for `/ready` (see `ShortLinkStore::ping`).
    pub fn ping(&self) -> Result<(), String> {
        self.pool.ping()
    }

    pub fn max_bytes(&self) -> usize {
        self.max_bytes
    }

    /// The public URL a stored hash is served at — what goes into `avatar_url`.
    pub fn public_url(&self, hash: &str, format: ImageFormat) -> String {
        format!("{}/{hash}.{}", self.public_base, format.ext())
    }

    /// Store `bytes` under their content hash, returning `(hash, format)`.
    ///
    /// Idempotent by construction: re-uploading identical bytes yields the same
    /// row and the same URL, so it costs nothing but a touch.
    pub fn put(
        &self,
        bytes: &[u8],
        format: ImageFormat,
        dims: (u32, u32),
    ) -> Result<String, PutError> {
        let hash = hex::encode(Sha256::digest(bytes));
        let now = unix_now();
        let conn = self.pool.get();

        // Dedupe first, and *before* the cap check: an image we already hold
        // costs no new storage, so a full store must still accept it (the user
        // is simply reusing an avatar that already exists).
        let existing: Option<i64> = conn
            .query_row(
                "SELECT last_used_at FROM avatars WHERE hash = ?1",
                rusqlite::params![hash],
                |r| r.get(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(PutError::Storage(other.to_string())),
            })?;
        if let Some(last_used) = existing {
            if now - last_used >= TOUCH_INTERVAL_SECS {
                let _ = conn.execute(
                    "UPDATE avatars SET last_used_at = ?1 WHERE hash = ?2",
                    rusqlite::params![now, hash],
                );
            }
            return Ok(hash);
        }

        if self.count.load(Ordering::Relaxed) >= self.max_entries {
            return Err(PutError::Full);
        }

        let inserted = conn
            .execute(
                "INSERT OR IGNORE INTO avatars
                 (hash, bytes, mime, width, height, created_at, last_used_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                rusqlite::params![hash, bytes, format.mime(), dims.0, dims.1, now],
            )
            .map_err(|e| PutError::Storage(e.to_string()))?;
        // Count only a row we actually added: a concurrent upload of the same
        // image can land between the lookup above and this insert, and
        // `OR IGNORE` makes that a no-op. Incrementing unconditionally would
        // drift the counter upward and start refusing uploads early.
        if inserted > 0 {
            self.count.fetch_add(1, Ordering::Relaxed);
        }
        Ok(hash)
    }

    /// Fetch the bytes behind `hash`, refreshing `last_used_at` at most daily.
    pub fn get(&self, hash: &str) -> Result<Option<StoredAvatar>, String> {
        let conn = self.pool.get();
        let row = conn
            .query_row(
                "SELECT bytes, mime, last_used_at FROM avatars WHERE hash = ?1",
                rusqlite::params![hash],
                |r| {
                    Ok((
                        r.get::<_, Vec<u8>>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                },
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other.to_string()),
            })?;

        let Some((bytes, mime, last_used)) = row else {
            return Ok(None);
        };
        let now = unix_now();
        if now - last_used >= TOUCH_INTERVAL_SECS {
            // Best-effort: a failed touch must never fail the read.
            let _ = conn.execute(
                "UPDATE avatars SET last_used_at = ?1 WHERE hash = ?2",
                rusqlite::params![now, hash],
            );
        }
        Ok(Some(StoredAvatar { bytes, mime }))
    }
}

#[derive(Debug)]
pub enum PutError {
    /// The row cap is reached. Existing avatars keep serving; we refuse the new
    /// one rather than evicting one that a live message still points at.
    Full,
    Storage(String),
}

impl From<PutError> for AppError {
    fn from(e: PutError) -> AppError {
        match e {
            PutError::Full => AppError::Status {
                status: StatusCode::SERVICE_UNAVAILABLE,
                message: "Avatar storage is full — paste an image URL instead.".into(),
                retry_after: None,
            },
            PutError::Storage(e) => AppError::Internal(format!("avatar store: {e}")),
        }
    }
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ── Image sniffing ──────────────────────────────────────────────────────────

/// Identify the format and read the pixel dimensions straight out of the image
/// header.
///
/// This deliberately avoids an image-decoding dependency: we never re-encode
/// (the browser already did the resizing), so all the server needs is the
/// handful of header bytes that carry the dimensions. That keeps the decode
/// cost at a few bytes of parsing instead of megabytes of pixel work, and keeps
/// a large attack-surface crate out of the build.
///
/// Returns `None` for anything that isn't a PNG or a baseline/progressive JPEG
/// — including GIFs and WebP, which Discord will not render as an avatar.
pub fn sniff_image(bytes: &[u8]) -> Option<(ImageFormat, u32, u32)> {
    if let Some((w, h)) = png_dimensions(bytes) {
        return Some((ImageFormat::Png, w, h));
    }
    if let Some((w, h)) = jpeg_dimensions(bytes) {
        return Some((ImageFormat::Jpeg, w, h));
    }
    None
}

/// PNG: 8-byte signature, then the IHDR chunk whose first two fields are the
/// width and height as big-endian u32 at fixed offsets 16 and 20.
fn png_dimensions(b: &[u8]) -> Option<(u32, u32)> {
    const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    if b.len() < 24 || !b.starts_with(SIGNATURE) || &b[12..16] != b"IHDR" {
        return None;
    }
    Some((be_u32(&b[16..20])?, be_u32(&b[20..24])?))
}

/// JPEG: `FFD8`, then a chain of marker segments. The Start-Of-Frame segment
/// (any SOFn except the DHT/JPG/DAC markers that share the C0–CF block) carries
/// height then width as big-endian u16 after a one-byte sample precision.
fn jpeg_dimensions(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 4 || b[0] != 0xFF || b[1] != 0xD8 {
        return None;
    }
    let mut i = 2usize;
    while i + 3 < b.len() {
        // Segments are byte-aligned with 0xFF; padding fill bytes are allowed.
        if b[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = b[i + 1];
        // Standalone markers carry no length payload.
        if marker == 0xFF {
            i += 1;
            continue;
        }
        if matches!(marker, 0xD8 | 0x01) || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }
        if marker == 0xD9 || marker == 0xDA {
            // End of image / start of scan — dimensions would have come first.
            return None;
        }
        let len = be_u16(&b[i + 2..])? as usize;
        if len < 2 {
            return None;
        }
        let is_sof = matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
        if is_sof {
            // segment: length(2) precision(1) height(2) width(2)
            let seg = b.get(i + 4..i + 9)?;
            let height = be_u16(&seg[1..3])? as u32;
            let width = be_u16(&seg[3..5])? as u32;
            return Some((width, height));
        }
        i += 2 + len;
    }
    None
}

fn be_u32(b: &[u8]) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(..4)?.try_into().ok()?))
}

fn be_u16(b: &[u8]) -> Option<u16> {
    Some(u16::from_be_bytes(b.get(..2)?.try_into().ok()?))
}

/// A 64-char lowercase hex string — the only shape `GET` will look up, so a
/// path segment can never reach SQLite as anything else.
fn is_hash(s: &str) -> bool {
    s.len() == HASH_LEN
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Split `<hash>.<ext>` and validate both halves.
fn parse_file_name(name: &str) -> Option<(String, ImageFormat)> {
    let (hash, ext) = name.rsplit_once('.')?;
    if !is_hash(hash) {
        return None;
    }
    let format = match ext {
        "png" => ImageFormat::Png,
        "jpg" | "jpeg" => ImageFormat::Jpeg,
        _ => return None,
    };
    Some((hash.to_string(), format))
}

// ── Handlers ────────────────────────────────────────────────────────────────

/// The store, or a clear "not enabled here" for deployments with the feature
/// switched off (`AVATAR_UPLOADS_ENABLED=false`).
fn store(st: &AppState) -> Result<&std::sync::Arc<AvatarStore>, AppError> {
    st.avatars.as_ref().ok_or_else(|| AppError::Status {
        status: StatusCode::NOT_IMPLEMENTED,
        message: "Avatar uploads aren't enabled on this deployment.".into(),
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

/// `POST /api/avatar` — raw image bytes in, `201 { hash, url, mime }` out.
///
/// Sign-in gated (see the module header). The body is raw bytes rather than
/// JSON/base64 so we neither pay a 33% base64 tax nor buffer a decoded copy;
/// the route's `DefaultBodyLimit` bounds it before we ever see it.
///
/// Authorization goes through [`crate::activity::resolve_identity`], which takes
/// *either* credential, rather than the session cookie alone. That is
/// load-bearing, not defensive: the embedded Activity renders the very same
/// `ComponentTree` — avatar field included — from a third-party iframe that
/// never receives the proxy's cookie, so a cookie-only gate here would make
/// every upload inside Discord fail with a silent 401.
pub async fn avatar_upload(
    State(st): State<AppState>,
    jar: PrivateCookieJar,
    headers: axum::http::HeaderMap,
    body: Bytes,
) -> Result<Response, AppError> {
    let store = std::sync::Arc::clone(store(&st)?);
    // Anonymous upload would make this a free image host for anyone who found
    // the endpoint. Reads stay open; writes do not.
    crate::activity::resolve_identity(&st, &jar, &headers).await?;

    if body.is_empty() {
        return Err(bad_request("No image data received."));
    }
    if body.len() > store.max_bytes() {
        return Err(AppError::Status {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            message: "That image is too large. Try a smaller one.".into(),
            retry_after: None,
        });
    }

    // Trust the bytes, not the Content-Type: the header is caller-controlled and
    // Discord will only render what the bytes actually are.
    let (format, width, height) = sniff_image(&body)
        .ok_or_else(|| bad_request("Only PNG and JPEG images work as Discord avatars."))?;
    if width > MAX_DIMENSION || height > MAX_DIMENSION {
        return Err(bad_request(
            "Image is too large in pixels — Discord ignores avatars over 1024px.",
        ));
    }
    if width < MIN_DIMENSION || height < MIN_DIMENSION {
        return Err(bad_request("Image is too small to use as an avatar."));
    }

    let bytes = body.to_vec();
    let hash = tokio::task::spawn_blocking({
        let store = std::sync::Arc::clone(&store);
        move || store.put(&bytes, format, (width, height))
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;

    let url = store.public_url(&hash, format);
    Ok((
        StatusCode::CREATED,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "hash": hash, "url": url, "mime": format.mime() })),
    )
        .into_response())
}

/// `GET /api/avatar/:file` — the bytes, for Discord's image fetcher.
///
/// Anonymous by necessity. Content-addressed, so the response is genuinely
/// immutable and can be cached for a year: that is what keeps our egress near
/// zero despite the URL living forever in every message that uses it.
pub async fn avatar_get(
    State(st): State<AppState>,
    UrlPath(file): UrlPath<String>,
) -> Result<Response, AppError> {
    let store = std::sync::Arc::clone(store(&st)?);
    let Some((hash, _)) = parse_file_name(&file) else {
        return Err(AppError::Status {
            status: StatusCode::NOT_FOUND,
            message: "Unknown avatar.".into(),
            retry_after: None,
        });
    };

    let found = tokio::task::spawn_blocking(move || store.get(&hash))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(|e| AppError::Internal(format!("avatar store: {e}")))?;

    match found {
        Some(avatar) => Ok((
            [
                (header::CONTENT_TYPE, avatar.mime),
                (
                    header::CACHE_CONTROL,
                    "public, max-age=31536000, immutable".to_string(),
                ),
            ],
            avatar.bytes,
        )
            .into_response()),
        None => Err(AppError::Status {
            status: StatusCode::NOT_FOUND,
            message: "Unknown avatar.".into(),
            retry_after: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `tag` keeps each test on its own file — tests run in parallel.
    fn temp_store(tag: &str, max_entries: u64) -> (AvatarStore, std::path::PathBuf) {
        let path =
            std::env::temp_dir().join(format!("dweeb-avatar-test-{}-{tag}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let store = AvatarStore::open(
            path.to_str().unwrap(),
            max_entries,
            128 * 1024,
            "https://api.example.com/api/avatar".into(),
        )
        .unwrap();
        (store, path)
    }

    /// Smallest structurally-valid PNG header the sniffer reads (it only ever
    /// looks at the signature + IHDR, never the pixel data).
    fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut b = Vec::from(&b"\x89PNG\r\n\x1a\n"[..]);
        b.extend_from_slice(&13u32.to_be_bytes()); // IHDR length
        b.extend_from_slice(b"IHDR");
        b.extend_from_slice(&width.to_be_bytes());
        b.extend_from_slice(&height.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0]); // depth, colour type, ...
        b
    }

    fn jpeg_header(width: u16, height: u16) -> Vec<u8> {
        let mut b = vec![0xFF, 0xD8];
        // An APP0/JFIF segment first, so the parser has to walk past a segment
        // rather than finding SOF0 immediately.
        b.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00]);
        b.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]); // SOF0, precision 8
        b.extend_from_slice(&height.to_be_bytes());
        b.extend_from_slice(&width.to_be_bytes());
        b
    }

    #[test]
    fn ping_answers_on_open_store() {
        let (store, path) = temp_store("ping", 100);
        assert!(store.ping().is_ok());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn put_get_roundtrip_and_public_url() {
        let (store, path) = temp_store("roundtrip", 100);
        let bytes = png_header(256, 256);
        let hash = store.put(&bytes, ImageFormat::Png, (256, 256)).unwrap();
        assert_eq!(hash.len(), HASH_LEN);

        let got = store.get(&hash).unwrap().expect("stored avatar");
        assert_eq!(got.bytes, bytes);
        assert_eq!(got.mime, "image/png");
        assert_eq!(
            store.public_url(&hash, ImageFormat::Png),
            format!("https://api.example.com/api/avatar/{hash}.png")
        );
        assert!(store.get(&"0".repeat(HASH_LEN)).unwrap().is_none());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn identical_bytes_dedupe_to_one_row() {
        // The property that keeps this store small: re-uploading the same image
        // (a user reusing an avatar across messages) must not add a row.
        let (store, path) = temp_store("dedupe", 100);
        let bytes = png_header(256, 256);
        let a = store.put(&bytes, ImageFormat::Png, (256, 256)).unwrap();
        let b = store.put(&bytes, ImageFormat::Png, (256, 256)).unwrap();
        assert_eq!(a, b);
        assert_eq!(store.count.load(Ordering::Relaxed), 1);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn cap_refuses_new_images_but_still_accepts_known_ones() {
        // A full store must not lock out an avatar it already holds — that
        // upload costs no storage, and refusing it would break a reuse.
        let (store, path) = temp_store("cap", 1);
        let first = png_header(256, 256);
        let hash = store.put(&first, ImageFormat::Png, (256, 256)).unwrap();

        let second = png_header(128, 128);
        assert!(matches!(
            store.put(&second, ImageFormat::Png, (128, 128)),
            Err(PutError::Full)
        ));
        assert_eq!(
            store.put(&first, ImageFormat::Png, (256, 256)).unwrap(),
            hash
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sniffs_png_and_jpeg_dimensions() {
        assert_eq!(
            sniff_image(&png_header(640, 480)),
            Some((ImageFormat::Png, 640, 480))
        );
        assert_eq!(
            sniff_image(&jpeg_header(300, 200)),
            Some((ImageFormat::Jpeg, 300, 200))
        );
    }

    #[test]
    fn rejects_formats_discord_will_not_render() {
        // GIF avatars silently fall back to the default avatar in Discord
        // (discord-api-docs#830), so they must never reach the store.
        assert!(sniff_image(b"GIF89a\x10\x00\x10\x00").is_none());
        assert!(sniff_image(b"RIFF\x00\x00\x00\x00WEBPVP8 ").is_none());
        assert!(sniff_image(b"not an image at all").is_none());
        assert!(sniff_image(&[]).is_none());
        // Truncated headers must fail cleanly rather than panic on slicing.
        assert!(sniff_image(&png_header(64, 64)[..12]).is_none());
        assert!(sniff_image(&[0xFF, 0xD8, 0xFF, 0xC0]).is_none());
    }

    #[test]
    fn file_name_parsing_is_strict() {
        let hash = "a".repeat(HASH_LEN);
        assert_eq!(
            parse_file_name(&format!("{hash}.png")),
            Some((hash.clone(), ImageFormat::Png))
        );
        assert_eq!(
            parse_file_name(&format!("{hash}.jpg")),
            Some((hash.clone(), ImageFormat::Jpeg))
        );
        // Anything that isn't exactly <64 lowercase hex>.<known ext> is a 404
        // before it can reach SQLite as a parameter.
        assert!(parse_file_name(&format!("{hash}.gif")).is_none());
        assert!(parse_file_name(&hash).is_none());
        assert!(parse_file_name("short.png").is_none());
        assert!(parse_file_name(&format!("{}.png", "A".repeat(HASH_LEN))).is_none());
        assert!(parse_file_name("../../etc/passwd.png").is_none());
    }
}
