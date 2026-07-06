//! At-rest sealing for credentials the proxy stores or round-trips.
//!
//! A registered custom bot's client secret has to survive between the
//! registration and every later "create webhook under this app" click, so it
//! can't live in a one-shot cookie like the rest of the OAuth flow. It is
//! stored in the dispatcher's registry — but sealed HERE first, with
//! AES-256-GCM under the encryption half of the proxy's cookie key (derived
//! from SESSION_SECRET). The dispatcher only ever sees opaque ciphertext, so
//! neither its API nor a leak of its SQLite file yields a usable secret;
//! opening requires this proxy's key.
//!
//! Two more payloads ride the same primitive, each under its own AAD domain
//! so one kind of ciphertext can never be replayed as another:
//!   - the **Activity webhook token** a custom bot's connect flow captured
//!     (stored in the dispatcher registry next to the client secret), and
//!   - the **Activity connect flow's OAuth `state`** — the embedded Activity
//!     hands its connect flow to the user's external browser, which carries
//!     none of our cookies, so the flow's credentials + destination travel
//!     sealed inside the `state` parameter itself and are verified by
//!     opening it at the callback.
//!
//! Format: hex(nonce[12] || ciphertext+tag). Hex over base64 to avoid another
//! dependency; the payloads are small, size is irrelevant.
//!
//! Caveat: rotating SESSION_SECRET makes stored values unopenable. That
//! fails safe — the flows report it and the fix is re-registering the app /
//! reconnecting the webhook — and matches the credentials' lifecycle (a
//! rotation that logs everyone out may as well re-prompt for third-party
//! credentials too).

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use axum_extra::extract::cookie::Key;

/// Domain separation so one kind of ciphertext can never be confused with (or
/// replayed as) another sealed under the same key.
const AAD_CLIENT_SECRET: &[u8] = b"dweeb-custom-app-client-secret-v1";
const AAD_ACTIVITY_HOOK: &[u8] = b"dweeb-activity-hook-token-v1";
const AAD_ACTIVITY_STATE: &[u8] = b"dweeb-activity-oauth-state-v1";

const NONCE_LEN: usize = 12;

/// Seal a custom bot's client secret. See [`seal_in`].
pub fn seal(key: &Key, plaintext: &str) -> Option<String> {
    seal_in(key, AAD_CLIENT_SECRET, plaintext)
}

/// Open a value produced by [`seal`]. See [`open_in`].
pub fn open(key: &Key, sealed_hex: &str) -> Option<String> {
    open_in(key, AAD_CLIENT_SECRET, sealed_hex)
}

/// Seal an Activity webhook token (stored in the dispatcher registry).
pub fn seal_hook(key: &Key, plaintext: &str) -> Option<String> {
    seal_in(key, AAD_ACTIVITY_HOOK, plaintext)
}

/// Open a value produced by [`seal_hook`].
pub fn open_hook(key: &Key, sealed_hex: &str) -> Option<String> {
    open_in(key, AAD_ACTIVITY_HOOK, sealed_hex)
}

/// Seal the Activity connect flow's OAuth `state` payload.
pub fn seal_state(key: &Key, plaintext: &str) -> Option<String> {
    seal_in(key, AAD_ACTIVITY_STATE, plaintext)
}

/// Open a value produced by [`seal_state`].
pub fn open_state(key: &Key, sealed_hex: &str) -> Option<String> {
    open_in(key, AAD_ACTIVITY_STATE, sealed_hex)
}

/// Seal `plaintext` under `aad`, returning hex(nonce || ciphertext). Fails
/// only if the OS RNG does (in which case refusing to store the secret is the
/// right outcome).
fn seal_in(key: &Key, aad: &[u8], plaintext: &str) -> Option<String> {
    let cipher = Aes256Gcm::new_from_slice(key.encryption()).ok()?;
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut nonce).ok()?;
    let sealed = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext.as_bytes(),
                aad,
            },
        )
        .ok()?;
    let mut out = Vec::with_capacity(NONCE_LEN + sealed.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Some(hex::encode(out))
}

/// Open a value produced by [`seal_in`] under the same `aad`. `None` on any
/// tamper, truncation, a different AAD domain, or a key that no longer
/// matches (e.g. SESSION_SECRET was rotated).
fn open_in(key: &Key, aad: &[u8], sealed_hex: &str) -> Option<String> {
    let bytes = hex::decode(sealed_hex).ok()?;
    if bytes.len() <= NONCE_LEN {
        return None;
    }
    let (nonce, ciphertext) = bytes.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(key.encryption()).ok()?;
    let plain = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .ok()?;
    String::from_utf8(plain).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> Key {
        Key::from(&[7u8; 64])
    }

    #[test]
    fn roundtrip() {
        let key = test_key();
        let sealed = seal(&key, "super-secret-client-secret").unwrap();
        assert_ne!(sealed, "super-secret-client-secret");
        assert_eq!(
            open(&key, &sealed).as_deref(),
            Some("super-secret-client-secret")
        );
    }

    #[test]
    fn tamper_and_wrong_key_fail() {
        let key = test_key();
        let sealed = seal(&key, "s3cret-s3cret-s3cret").unwrap();
        // Flip one hex digit of the ciphertext.
        let mut tampered = sealed.clone().into_bytes();
        let last = tampered.last_mut().unwrap();
        *last = if *last == b'0' { b'1' } else { b'0' };
        assert!(open(&key, std::str::from_utf8(&tampered).unwrap()).is_none());
        // A different key can't open it either.
        assert!(open(&Key::from(&[9u8; 64]), &sealed).is_none());
        // Garbage input is rejected, not panicked on.
        assert!(open(&key, "zz").is_none());
        assert!(open(&key, "").is_none());
    }

    #[test]
    fn nonces_differ_per_seal() {
        let key = test_key();
        let a = seal(&key, "same-plaintext-here").unwrap();
        let b = seal(&key, "same-plaintext-here").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn aad_domains_do_not_cross_open() {
        let key = test_key();
        // A sealed client secret can't be opened as a hook token or a state
        // blob (and vice versa) — the AAD binds each ciphertext to its domain.
        let secret = seal(&key, "client-secret-value").unwrap();
        assert!(open_hook(&key, &secret).is_none());
        assert!(open_state(&key, &secret).is_none());
        let hook = seal_hook(&key, "webhook-token-value").unwrap();
        assert!(open(&key, &hook).is_none());
        assert_eq!(
            open_hook(&key, &hook).as_deref(),
            Some("webhook-token-value")
        );
        let state = seal_state(&key, "{\"g\":\"1\"}").unwrap();
        assert!(open(&key, &state).is_none());
        assert_eq!(open_state(&key, &state).as_deref(), Some("{\"g\":\"1\"}"));
    }
}
