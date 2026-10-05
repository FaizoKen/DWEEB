//! Persistence for the MCP server's OAuth: registered clients, authorization
//! codes, and access tokens.
//!
//! Three rules shape this file, and each is the reason a particular column
//! looks the way it does.
//!
//! **Nothing bearer-shaped is stored in the clear.** An authorization code, an
//! access token, and a client secret are all credentials a holder can act with,
//! so only their SHA-256 digests are written — the same choice the schedule
//! store makes for its manage tokens. A leak of this file lets nobody call
//! anything; it can only be used to *recognise* a token someone already has.
//!
//! **The Discord access token is sealed, not hashed.** That one has to be
//! *readable* — every MCP call replays it against Discord to resolve who is
//! asking and which servers they belong to — so it is AES-GCM sealed under the
//! proxy's own key with its own AAD domain (`seal::seal_mcp`), exactly as the
//! custom-bot secrets are. The database alone yields nothing usable.
//!
//! **An MCP token can never outlive the Discord token inside it.** Its expiry
//! is capped at the Discord token's, because once that dies the MCP token can
//! do nothing anyway, and a bearer that looks alive but resolves to nothing is
//! the worst of both. That is also why there are no refresh tokens: refreshing
//! ours could not refresh Discord's, so the honest answer to expiry is another
//! authorization round-trip, which is silent when the user's Discord session is
//! still good.

use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};

use axum_extra::extract::cookie::Key;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::seal;
use crate::sqlite_pool::SqlitePool;

/// How long an authorization code is good for. Short by design: it is handed
/// through a browser redirect and exchanged immediately.
pub const CODE_TTL_SECS: i64 = 600;

/// Ceiling on an access token's life, before the Discord-token cap applies.
pub const TOKEN_TTL_SECS: i64 = 7 * 24 * 3600;

/// How long a user has to answer the consent page that follows Discord's.
pub const CONSENT_TTL_SECS: i64 = 600;

/// Registered clients are created by anonymous dynamic registration, so the
/// table needs a bound. Well past any real number of MCP clients — and since a
/// scanner (or organic churn) would otherwise fill it for good, the sweep
/// retires registrations nobody uses: see [`McpStore::sweep`].
const MAX_CLIENTS: i64 = 5_000;

/// A registration that never completed an authorization within a day is
/// abandoned — a connector that is really being added authorizes within
/// minutes of registering.
const UNUSED_CLIENT_TTL_SECS: i64 = 24 * 3600;

/// A registration idle this long has no live token (tokens live at most
/// [`TOKEN_TTL_SECS`]); a connector that comes back simply registers again.
const IDLE_CLIENT_TTL_SECS: i64 = 30 * 24 * 3600;

/// At the cap, a never-used registration at least this old may be evicted to
/// make room. Older than an authorization round trip can take, so a connector
/// whose user is still on a consent screen is never the one evicted.
const EVICTABLE_UNUSED_SECS: i64 = 600;

/// A client registered through RFC 7591 dynamic registration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Client {
    pub client_id: String,
    /// Redirect URIs this client may be sent back to. Matched exactly.
    pub redirect_uris: Vec<String>,
    /// Human name from the registration request, shown in logs.
    pub client_name: Option<String>,
    /// True when the client registered with a secret (confidential client).
    pub has_secret: bool,
}

/// What an access token resolves to.
#[derive(Debug, Clone)]
pub struct TokenIdentity {
    /// The Discord user access token this MCP token acts on behalf of.
    pub discord_token: String,
    /// Discord user id, for logging and rate-limit keying.
    pub discord_user: String,
    /// Which client presented it.
    pub client_id: String,
    pub expires_at: i64,
}

pub struct McpStore {
    pool: SqlitePool,
    key: Key,
    clients: AtomicI64,
}

impl McpStore {
    pub fn open(path: &str, key: Key) -> Result<Self, String> {
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
                "CREATE TABLE IF NOT EXISTS mcp_clients (
                     client_id     TEXT PRIMARY KEY,
                     secret_hash   TEXT,
                     redirect_uris TEXT NOT NULL,
                     client_name   TEXT,
                     created_at    INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS mcp_codes (
                     code_hash      TEXT PRIMARY KEY,
                     client_id      TEXT NOT NULL,
                     redirect_uri   TEXT NOT NULL,
                     code_challenge TEXT NOT NULL,
                     discord_token  TEXT NOT NULL,
                     discord_user   TEXT NOT NULL,
                     discord_exp    INTEGER NOT NULL,
                     expires_at     INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS mcp_codes_expires ON mcp_codes(expires_at);
                 CREATE TABLE IF NOT EXISTS mcp_tokens (
                     token_hash    TEXT PRIMARY KEY,
                     client_id     TEXT NOT NULL,
                     discord_token TEXT NOT NULL,
                     discord_user  TEXT NOT NULL,
                     expires_at    INTEGER NOT NULL,
                     created_at    INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS mcp_tokens_expires ON mcp_tokens(expires_at);
                 CREATE TABLE IF NOT EXISTS mcp_consents (
                     ticket_hash    TEXT PRIMARY KEY,
                     client_id      TEXT NOT NULL,
                     redirect_uri   TEXT NOT NULL,
                     code_challenge TEXT NOT NULL,
                     client_state   TEXT,
                     discord_token  TEXT NOT NULL,
                     discord_user   TEXT NOT NULL,
                     discord_exp    INTEGER NOT NULL,
                     expires_at     INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS mcp_consents_expires ON mcp_consents(expires_at);",
            )
            .map_err(|e| format!("schema: {e}"))?;
            // Migrate stores created before registrations recorded their last
            // use (SQLite has no ADD COLUMN IF NOT EXISTS). Existing rows start
            // as never-used, so the first sweep retires the abandoned ones
            // among them a day after they registered — and an in-use client
            // re-stamps itself on its next authorization.
            let has_last_used: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('mcp_clients') WHERE name = 'last_used_at'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if has_last_used == 0 {
                conn.execute_batch("ALTER TABLE mcp_clients ADD COLUMN last_used_at INTEGER;")
                    .map_err(|e| format!("migrate last_used_at: {e}"))?;
            }
        }
        let clients: i64 = pool
            .get()
            .query_row("SELECT COUNT(*) FROM mcp_clients", [], |r| r.get(0))
            .map_err(|e| format!("count: {e}"))?;
        Ok(McpStore {
            pool,
            key,
            clients: AtomicI64::new(clients),
        })
    }

    /// Non-blocking connectivity probe for `/ready`.
    pub fn ping(&self) -> Result<(), String> {
        self.pool.ping()
    }

    /* ── Clients ─────────────────────────────────────────────────────── */

    /// Register a client. `secret` is `None` for a public (PKCE-only) client,
    /// which is what every MCP client using dynamic registration should be.
    ///
    /// At the cap, the oldest registration that never completed an
    /// authorization makes room; only when there is none is the caller turned
    /// away with [`RegisterError::Full`] — a capacity answer, never a failure.
    pub fn register_client(
        &self,
        redirect_uris: &[String],
        client_name: Option<&str>,
        secret: Option<&str>,
    ) -> Result<Client, RegisterError> {
        let client_id = format!("dweeb-mcp-{}", random_hex(16));
        let uris = serde_json::to_string(redirect_uris)
            .map_err(|e| RegisterError::Storage(e.to_string()))?;
        let conn = self.pool.get();
        if self.clients.load(Ordering::Relaxed) >= MAX_CLIENTS {
            let evicted = conn
                .execute(
                    "DELETE FROM mcp_clients WHERE client_id = (
                         SELECT client_id FROM mcp_clients
                         WHERE last_used_at IS NULL AND created_at <= ?1
                         ORDER BY created_at LIMIT 1
                     )",
                    [now() - EVICTABLE_UNUSED_SECS],
                )
                .map_err(|e| RegisterError::Storage(format!("evict: {e}")))?;
            if evicted == 0 {
                return Err(RegisterError::Full);
            }
            self.clients.fetch_sub(evicted as i64, Ordering::Relaxed);
        }
        conn.execute(
            "INSERT INTO mcp_clients (client_id, secret_hash, redirect_uris, client_name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                client_id,
                secret.map(hash),
                uris,
                client_name,
                now(),
            ],
        )
        .map_err(|e| RegisterError::Storage(format!("register: {e}")))?;
        self.clients.fetch_add(1, Ordering::Relaxed);
        Ok(Client {
            client_id,
            redirect_uris: redirect_uris.to_vec(),
            client_name: client_name.map(str::to_string),
            has_secret: secret.is_some(),
        })
    }

    pub fn client(&self, client_id: &str) -> Option<Client> {
        let conn = self.pool.get();
        conn.query_row(
            "SELECT client_id, secret_hash, redirect_uris, client_name FROM mcp_clients WHERE client_id = ?1",
            [client_id],
            |row| {
                let uris: String = row.get(2)?;
                let secret_hash: Option<String> = row.get(1)?;
                Ok(Client {
                    client_id: row.get(0)?,
                    redirect_uris: serde_json::from_str(&uris).unwrap_or_default(),
                    client_name: row.get(3)?,
                    has_secret: secret_hash.is_some(),
                })
            },
        )
        .ok()
    }

    /// Verify a confidential client's secret. A public client (no stored secret)
    /// authenticates by PKCE alone, which is what OAuth 2.1 expects.
    pub fn client_secret_matches(&self, client_id: &str, secret: Option<&str>) -> bool {
        let conn = self.pool.get();
        let stored: Option<String> = match conn.query_row(
            "SELECT secret_hash FROM mcp_clients WHERE client_id = ?1",
            [client_id],
            |row| row.get(0),
        ) {
            Ok(v) => v,
            Err(_) => return false,
        };
        match (stored, secret) {
            (None, _) => true,
            (Some(expected), Some(given)) => constant_time_eq(&expected, &hash(given)),
            (Some(_), None) => false,
        }
    }

    /* ── Authorization codes ─────────────────────────────────────────── */

    /// Mint a single-use authorization code bound to the client, the redirect
    /// URI it will be returned to, and the PKCE challenge that must be answered
    /// at the token endpoint. Returns the code to put in the redirect.
    #[allow(clippy::too_many_arguments)]
    pub fn create_code(
        &self,
        client_id: &str,
        redirect_uri: &str,
        code_challenge: &str,
        discord_token: &str,
        discord_user: &str,
        discord_exp: i64,
    ) -> Result<String, String> {
        let code = random_hex(32);
        let sealed = seal::seal_mcp(&self.key, discord_token)
            .ok_or_else(|| "could not seal the Discord token".to_string())?;
        let conn = self.pool.get();
        conn.execute(
            "INSERT INTO mcp_codes
                 (code_hash, client_id, redirect_uri, code_challenge, discord_token, discord_user, discord_exp, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                hash(&code),
                client_id,
                redirect_uri,
                code_challenge,
                sealed,
                discord_user,
                discord_exp,
                now() + CODE_TTL_SECS,
            ],
        )
        .map_err(|e| format!("create code: {e}"))?;
        // A completed authorization is what "in use" means for a registration;
        // the sweep retires the ones that never get here.
        let _ = conn.execute(
            "UPDATE mcp_clients SET last_used_at = ?2 WHERE client_id = ?1",
            rusqlite::params![client_id, now()],
        );
        Ok(code)
    }

    /// Redeem a code. Single-use: the row is deleted whether or not the checks
    /// pass, so a leaked code cannot be retried against a different verifier —
    /// and the read *is* the delete (`DELETE … RETURNING`), so two concurrent
    /// redemptions of one code cannot both see the row (RFC 6749 §4.1.2).
    pub fn redeem_code(
        &self,
        code: &str,
        client_id: &str,
        redirect_uri: &str,
    ) -> Result<RedeemedCode, CodeError> {
        let conn = self.pool.get();
        let hashed = hash(code);
        let row = conn
            .query_row(
                "DELETE FROM mcp_codes WHERE code_hash = ?1
                 RETURNING client_id, redirect_uri, code_challenge, discord_token, discord_user, discord_exp, expires_at",
                [&hashed],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                    ))
                },
            )
            .ok();

        let Some((stored_client, stored_uri, challenge, sealed, user, discord_exp, expires_at)) =
            row
        else {
            return Err(CodeError::Unknown);
        };
        if now() >= expires_at {
            return Err(CodeError::Expired);
        }
        if stored_client != client_id {
            return Err(CodeError::WrongClient);
        }
        if stored_uri != redirect_uri {
            return Err(CodeError::WrongRedirect);
        }
        let discord_token = seal::open_mcp(&self.key, &sealed).ok_or(CodeError::Storage)?;
        Ok(RedeemedCode {
            code_challenge: challenge,
            discord_token,
            discord_user: user,
            discord_exp,
        })
    }

    /* ── Consent tickets ─────────────────────────────────────────────── */

    /// Park an authorization Discord has completed until the user answers
    /// DWEEB's own consent page. Returns the single-use ticket that page's
    /// form carries; nothing else about the grant — least of all the Discord
    /// token — is ever put in the page.
    pub fn create_consent(&self, pending: &PendingConsent) -> Result<String, String> {
        let ticket = random_hex(32);
        let sealed = seal::seal_mcp(&self.key, &pending.discord_token)
            .ok_or_else(|| "could not seal the Discord token".to_string())?;
        let conn = self.pool.get();
        conn.execute(
            "INSERT INTO mcp_consents
                 (ticket_hash, client_id, redirect_uri, code_challenge, client_state, discord_token, discord_user, discord_exp, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                hash(&ticket),
                pending.client_id,
                pending.redirect_uri,
                pending.code_challenge,
                pending.client_state,
                sealed,
                pending.discord_user,
                pending.discord_exp,
                now() + CONSENT_TTL_SECS,
            ],
        )
        .map_err(|e| format!("create consent: {e}"))?;
        Ok(ticket)
    }

    /// Take a consent ticket — at most once, whatever the answer: the read is
    /// the delete. `Ok(None)` for an unknown, used, or expired ticket.
    pub fn take_consent(&self, ticket: &str) -> Result<Option<PendingConsent>, String> {
        let conn = self.pool.get();
        let row = conn
            .query_row(
                "DELETE FROM mcp_consents WHERE ticket_hash = ?1
                 RETURNING client_id, redirect_uri, code_challenge, client_state, discord_token, discord_user, discord_exp, expires_at",
                [hash(ticket)],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                    ))
                },
            )
            .ok();
        let Some((
            client_id,
            redirect_uri,
            code_challenge,
            client_state,
            sealed,
            user,
            exp,
            expires_at,
        )) = row
        else {
            return Ok(None);
        };
        if now() >= expires_at {
            return Ok(None);
        }
        let discord_token = seal::open_mcp(&self.key, &sealed)
            .ok_or_else(|| "could not open a stored consent".to_string())?;
        Ok(Some(PendingConsent {
            client_id,
            redirect_uri,
            code_challenge,
            client_state,
            discord_token,
            discord_user: user,
            discord_exp: exp,
        }))
    }

    /* ── Access tokens ───────────────────────────────────────────────── */

    /// Issue an access token. Its life is capped at the Discord token's own
    /// remaining life — see the module comment.
    pub fn create_token(
        &self,
        client_id: &str,
        discord_token: &str,
        discord_user: &str,
        discord_exp: i64,
    ) -> Result<(String, i64), String> {
        let token = random_hex(32);
        let sealed = seal::seal_mcp(&self.key, discord_token)
            .ok_or_else(|| "could not seal the Discord token".to_string())?;
        let expires_at = (now() + TOKEN_TTL_SECS).min(discord_exp);
        let conn = self.pool.get();
        conn.execute(
            "INSERT INTO mcp_tokens (token_hash, client_id, discord_token, discord_user, expires_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![hash(&token), client_id, sealed, discord_user, expires_at, now()],
        )
        .map_err(|e| format!("create token: {e}"))?;
        Ok((token, expires_at))
    }

    /// Resolve a bearer token. `None` for unknown or expired — the caller must
    /// not distinguish the two to a client.
    pub fn resolve_token(&self, token: &str) -> Option<TokenIdentity> {
        let conn = self.pool.get();
        let (client_id, sealed, user, expires_at) = conn
            .query_row(
                "SELECT client_id, discord_token, discord_user, expires_at
                 FROM mcp_tokens WHERE token_hash = ?1",
                [hash(token)],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .ok()?;
        if now() >= expires_at {
            return None;
        }
        let discord_token = seal::open_mcp(&self.key, &sealed)?;
        Some(TokenIdentity {
            discord_token,
            discord_user: user,
            client_id,
            expires_at,
        })
    }

    /// Delete expired codes, tokens and consent tickets, and retire the
    /// registrations nobody uses — never-used ones after a day, idle ones
    /// after a month, and never one that still has a live token or code
    /// behind it. Without that last part the table only ever grew, and once it
    /// reached the cap every registration failed for good. Called on a timer
    /// from `main`.
    pub fn sweep(&self) -> Result<usize, String> {
        let conn = self.pool.get();
        let now = now();
        let codes = conn
            .execute("DELETE FROM mcp_codes WHERE expires_at <= ?1", [now])
            .map_err(|e| format!("sweep codes: {e}"))?;
        let tokens = conn
            .execute("DELETE FROM mcp_tokens WHERE expires_at <= ?1", [now])
            .map_err(|e| format!("sweep tokens: {e}"))?;
        let consents = conn
            .execute("DELETE FROM mcp_consents WHERE expires_at <= ?1", [now])
            .map_err(|e| format!("sweep consents: {e}"))?;
        let clients = conn
            .execute(
                "DELETE FROM mcp_clients
                 WHERE ((last_used_at IS NULL AND created_at <= ?1) OR last_used_at <= ?2)
                   AND NOT EXISTS (SELECT 1 FROM mcp_tokens t
                                   WHERE t.client_id = mcp_clients.client_id AND t.expires_at > ?3)
                   AND NOT EXISTS (SELECT 1 FROM mcp_codes c
                                   WHERE c.client_id = mcp_clients.client_id AND c.expires_at > ?3)
                   AND NOT EXISTS (SELECT 1 FROM mcp_consents k
                                   WHERE k.client_id = mcp_clients.client_id AND k.expires_at > ?3)",
                rusqlite::params![
                    now - UNUSED_CLIENT_TTL_SECS,
                    now - IDLE_CLIENT_TTL_SECS,
                    now
                ],
            )
            .map_err(|e| format!("sweep clients: {e}"))?;
        // Re-count rather than subtract: the cap must reflect the table, even
        // after a registration raced the sweep.
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM mcp_clients", [], |r| r.get(0))
            .map_err(|e| format!("count clients: {e}"))?;
        self.clients.store(count, Ordering::Relaxed);
        Ok(codes + tokens + consents + clients)
    }
}

/// Why a registration was not stored.
#[derive(Debug)]
pub enum RegisterError {
    /// The table is at its cap and nothing in it is abandoned yet — a
    /// capacity answer for the caller, not a failure of ours.
    Full,
    /// The database refused the write.
    Storage(String),
}

impl std::fmt::Display for RegisterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RegisterError::Full => f.write_str("too many registered clients"),
            RegisterError::Storage(e) => f.write_str(e),
        }
    }
}

/// An authorization Discord completed, waiting on the user's answer to the
/// consent page.
#[derive(Debug, Clone)]
pub struct PendingConsent {
    pub client_id: String,
    pub redirect_uri: String,
    pub code_challenge: String,
    pub client_state: Option<String>,
    pub discord_token: String,
    pub discord_user: String,
    pub discord_exp: i64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CodeError {
    Unknown,
    Expired,
    WrongClient,
    WrongRedirect,
    Storage,
}

pub struct RedeemedCode {
    pub code_challenge: String,
    pub discord_token: String,
    pub discord_user: String,
    pub discord_exp: i64,
}

/* ── Helpers ─────────────────────────────────────────────────────────── */

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Compare two hex digests without an early exit. They are digests rather than
/// secrets, so this is belt-and-braces — but a timing side channel on a secret
/// check is never worth saving four lines over.
fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// A random hex string of `bytes * 2` characters. An RNG failure yields a value
/// that simply will not match anything, which fails closed.
pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    let _ = getrandom::getrandom(&mut buf);
    let mut out = String::with_capacity(bytes * 2);
    for b in buf {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(tag: &str) -> (McpStore, std::path::PathBuf) {
        let path =
            std::env::temp_dir().join(format!("dweeb-mcp-store-{}-{tag}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let key = Key::from(&[7u8; 64]);
        let store = McpStore::open(path.to_str().unwrap(), key).unwrap();
        (store, path)
    }

    #[test]
    fn a_code_is_single_use_even_when_the_exchange_fails() {
        let (store, path) = temp_store("code-single-use");
        let client = store
            .register_client(&["https://claude.ai/cb".into()], Some("Claude"), None)
            .unwrap();
        let code = store
            .create_code(
                &client.client_id,
                "https://claude.ai/cb",
                "challenge",
                "discord-token",
                "42",
                now() + 3600,
            )
            .unwrap();

        // Wrong redirect: refused, and the code is burned anyway.
        assert_eq!(
            store
                .redeem_code(&code, &client.client_id, "https://evil.test/cb")
                .err(),
            Some(CodeError::WrongRedirect)
        );
        assert_eq!(
            store
                .redeem_code(&code, &client.client_id, "https://claude.ai/cb")
                .err(),
            Some(CodeError::Unknown)
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_code_round_trips_the_sealed_discord_token() {
        let (store, path) = temp_store("code-roundtrip");
        let client = store
            .register_client(&["https://claude.ai/cb".into()], None, None)
            .unwrap();
        let code = store
            .create_code(
                &client.client_id,
                "https://claude.ai/cb",
                "challenge",
                "discord-token",
                "42",
                now() + 3600,
            )
            .unwrap();
        let redeemed = store
            .redeem_code(&code, &client.client_id, "https://claude.ai/cb")
            .expect("redeems");
        assert_eq!(redeemed.discord_token, "discord-token");
        assert_eq!(redeemed.discord_user, "42");
        assert_eq!(redeemed.code_challenge, "challenge");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_token_never_outlives_the_discord_token_inside_it() {
        let (store, path) = temp_store("token-cap");
        // Discord's token dies in an hour; ours must not claim seven days.
        let discord_exp = now() + 3600;
        let (token, expires_at) = store
            .create_token("client", "discord-token", "42", discord_exp)
            .unwrap();
        assert_eq!(expires_at, discord_exp);
        let identity = store.resolve_token(&token).expect("resolves");
        assert_eq!(identity.discord_token, "discord-token");
        assert_eq!(identity.discord_user, "42");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn an_expired_token_resolves_to_nothing() {
        let (store, path) = temp_store("token-expired");
        let (token, _) = store
            .create_token("client", "discord-token", "42", now() - 1)
            .unwrap();
        assert!(store.resolve_token(&token).is_none());
        // …and an unknown one is indistinguishable from it.
        assert!(store.resolve_token("not-a-token").is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn the_database_holds_no_usable_credential() {
        let (store, path) = temp_store("no-plaintext");
        let (token, _) = store
            .create_token("client", "super-secret-discord-token", "42", now() + 3600)
            .unwrap();
        let raw = std::fs::read(&path).unwrap();
        let text = String::from_utf8_lossy(&raw);
        // Neither the bearer we handed out nor the Discord token it wraps.
        assert!(
            !text.contains(&token),
            "the access token is stored in clear"
        );
        assert!(
            !text.contains("super-secret-discord-token"),
            "the Discord token is stored in clear"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_public_client_needs_no_secret_and_a_confidential_one_does() {
        let (store, path) = temp_store("client-secret");
        let public = store
            .register_client(&["https://claude.ai/cb".into()], None, None)
            .unwrap();
        assert!(!public.has_secret);
        assert!(store.client_secret_matches(&public.client_id, None));

        let confidential = store
            .register_client(&["https://claude.ai/cb".into()], None, Some("s3cret"))
            .unwrap();
        assert!(confidential.has_secret);
        assert!(store.client_secret_matches(&confidential.client_id, Some("s3cret")));
        assert!(!store.client_secret_matches(&confidential.client_id, Some("wrong")));
        assert!(!store.client_secret_matches(&confidential.client_id, None));
        let _ = std::fs::remove_file(&path);
    }

    /// Backdate a registration, as if it had been made `secs` ago.
    fn age_client(store: &McpStore, client_id: &str, secs: i64) {
        store
            .pool
            .get()
            .execute(
                "UPDATE mcp_clients SET created_at = ?2 WHERE client_id = ?1",
                rusqlite::params![client_id, now() - secs],
            )
            .unwrap();
    }

    #[test]
    fn a_code_redeemed_concurrently_is_honoured_exactly_once() {
        let (store, path) = temp_store("code-race");
        let store = std::sync::Arc::new(store);
        for _ in 0..20 {
            let code = store
                .create_code(
                    "c",
                    "https://claude.ai/cb",
                    "challenge",
                    "t",
                    "42",
                    now() + 3600,
                )
                .unwrap();
            let handles: Vec<_> = (0..4)
                .map(|_| {
                    let store = std::sync::Arc::clone(&store);
                    let code = code.clone();
                    std::thread::spawn(move || {
                        store
                            .redeem_code(&code, "c", "https://claude.ai/cb")
                            .is_ok()
                    })
                })
                .collect();
            let honoured = handles
                .into_iter()
                .map(|h| h.join().unwrap())
                .filter(|ok| *ok)
                .count();
            assert_eq!(honoured, 1, "one code minted {honoured} tokens");
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_consent_ticket_is_single_use_and_carries_the_grant() {
        let (store, path) = temp_store("consent");
        let pending = PendingConsent {
            client_id: "c".into(),
            redirect_uri: "https://claude.ai/cb".into(),
            code_challenge: "challenge".into(),
            client_state: Some("st".into()),
            discord_token: "discord-token".into(),
            discord_user: "42".into(),
            discord_exp: now() + 3600,
        };
        let ticket = store.create_consent(&pending).unwrap();
        let taken = store.take_consent(&ticket).unwrap().expect("first answer");
        assert_eq!(taken.discord_token, "discord-token");
        assert_eq!(taken.client_state.as_deref(), Some("st"));
        // A replayed form — a double click, a back button — finds nothing.
        assert!(store.take_consent(&ticket).unwrap().is_none());
        assert!(store.take_consent("not-a-ticket").unwrap().is_none());
        // And the page never needed the Discord token: the database holds it
        // sealed, not in the clear.
        let raw = std::fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("discord-token"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn an_expired_consent_ticket_answers_nothing() {
        let (store, path) = temp_store("consent-expired");
        let pending = PendingConsent {
            client_id: "c".into(),
            redirect_uri: "https://claude.ai/cb".into(),
            code_challenge: "challenge".into(),
            client_state: None,
            discord_token: "t".into(),
            discord_user: "42".into(),
            discord_exp: now() + 3600,
        };
        let ticket = store.create_consent(&pending).unwrap();
        store
            .pool
            .get()
            .execute("UPDATE mcp_consents SET expires_at = ?1", [now() - 1])
            .unwrap();
        assert!(store.take_consent(&ticket).unwrap().is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn sweeping_retires_abandoned_registrations_and_keeps_live_ones() {
        let (store, path) = temp_store("sweep-clients");
        let uris = ["https://claude.ai/cb".to_string()];
        let abandoned = store.register_client(&uris, None, None).unwrap();
        age_client(&store, &abandoned.client_id, UNUSED_CLIENT_TTL_SECS + 1);
        let fresh = store.register_client(&uris, None, None).unwrap();
        let in_use = store.register_client(&uris, None, None).unwrap();
        age_client(&store, &in_use.client_id, UNUSED_CLIENT_TTL_SECS + 1);
        // An authorization stamps it as used and leaves a live token behind.
        store
            .create_code(
                &in_use.client_id,
                &uris[0],
                "challenge",
                "t",
                "42",
                now() + 3600,
            )
            .unwrap();
        store
            .create_token(&in_use.client_id, "t", "42", now() + 3600)
            .unwrap();

        store.sweep().unwrap();
        assert!(store.client(&abandoned.client_id).is_none());
        assert!(store.client(&fresh.client_id).is_some());
        assert!(store.client(&in_use.client_id).is_some());
        // The cap counts what is really there.
        assert_eq!(store.clients.load(Ordering::Relaxed), 2);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn at_the_cap_an_abandoned_registration_makes_room_and_otherwise_it_is_a_capacity_answer() {
        let (store, path) = temp_store("cap");
        let uris = ["https://claude.ai/cb".to_string()];
        let old = store.register_client(&uris, None, None).unwrap();
        age_client(&store, &old.client_id, EVICTABLE_UNUSED_SECS + 1);
        store.clients.store(MAX_CLIENTS, Ordering::Relaxed);
        // The oldest never-used registration goes; the new one gets in.
        let newcomer = store.register_client(&uris, None, None).expect("room made");
        assert!(store.client(&old.client_id).is_none());
        assert!(store.client(&newcomer.client_id).is_some());
        // Nothing evictable left (the newcomer is seconds old): turned away
        // with a capacity answer, not a storage failure.
        store.clients.store(MAX_CLIENTS, Ordering::Relaxed);
        assert!(matches!(
            store.register_client(&uris, None, None),
            Err(RegisterError::Full)
        ));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn sweeping_removes_only_what_has_expired() {
        let (store, path) = temp_store("sweep");
        let (live, _) = store
            .create_token("client", "t", "42", now() + 3600)
            .unwrap();
        let (dead, _) = store.create_token("client", "t", "42", now() - 1).unwrap();
        assert_eq!(store.sweep().unwrap(), 1);
        assert!(store.resolve_token(&live).is_some());
        assert!(store.resolve_token(&dead).is_none());
        let _ = std::fs::remove_file(&path);
    }
}
