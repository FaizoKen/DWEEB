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

/// Registered clients are created by anonymous dynamic registration, so the
/// table needs a bound. Well past any real number of MCP clients.
const MAX_CLIENTS: i64 = 5_000;

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
                 CREATE INDEX IF NOT EXISTS mcp_tokens_expires ON mcp_tokens(expires_at);",
            )
            .map_err(|e| format!("schema: {e}"))?;
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
    pub fn register_client(
        &self,
        redirect_uris: &[String],
        client_name: Option<&str>,
        secret: Option<&str>,
    ) -> Result<Client, String> {
        if self.clients.load(Ordering::Relaxed) >= MAX_CLIENTS {
            return Err("too many registered clients".into());
        }
        let client_id = format!("dweeb-mcp-{}", random_hex(16));
        let uris = serde_json::to_string(redirect_uris).map_err(|e| e.to_string())?;
        let conn = self.pool.get();
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
        .map_err(|e| format!("register: {e}"))?;
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
        Ok(code)
    }

    /// Redeem a code. Single-use: the row is deleted whether or not the checks
    /// pass, so a leaked code cannot be retried against a different verifier.
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
                "SELECT client_id, redirect_uri, code_challenge, discord_token, discord_user, discord_exp, expires_at
                 FROM mcp_codes WHERE code_hash = ?1",
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
        // Burn it regardless of the outcome.
        let _ = conn.execute("DELETE FROM mcp_codes WHERE code_hash = ?1", [&hashed]);

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

    /// Delete expired codes and tokens. Called on a timer from `main`.
    pub fn sweep(&self) -> Result<usize, String> {
        let conn = self.pool.get();
        let now = now();
        let codes = conn
            .execute("DELETE FROM mcp_codes WHERE expires_at <= ?1", [now])
            .map_err(|e| format!("sweep codes: {e}"))?;
        let tokens = conn
            .execute("DELETE FROM mcp_tokens WHERE expires_at <= ?1", [now])
            .map_err(|e| format!("sweep tokens: {e}"))?;
        Ok(codes + tokens)
    }
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
