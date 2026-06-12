//! At-rest sealing for custom-bot client secrets.
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
//! Format: hex(nonce[12] || ciphertext+tag). Hex over base64 to avoid another
//! dependency; the payload is ~100 bytes, size is irrelevant.
//!
//! Caveat: rotating SESSION_SECRET makes stored secrets unopenable. That
//! fails safe — the webhook flow reports it and the fix is re-registering the
//! app — and matches the secret's lifecycle (a rotation that logs everyone
//! out may as well re-prompt for third-party credentials too).

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use axum_extra::extract::cookie::Key;

/// Domain separation so this ciphertext can never be confused with (or
/// replayed as) anything else sealed under the same key.
const AAD: &[u8] = b"dweeb-custom-app-client-secret-v1";

const NONCE_LEN: usize = 12;

/// Seal `plaintext`, returning hex(nonce || ciphertext). Fails only if the
/// OS RNG does (in which case refusing to store the secret is the right
/// outcome).
pub fn seal(key: &Key, plaintext: &str) -> Option<String> {
    let cipher = Aes256Gcm::new_from_slice(key.encryption()).ok()?;
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut nonce).ok()?;
    let sealed = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext.as_bytes(),
                aad: AAD,
            },
        )
        .ok()?;
    let mut out = Vec::with_capacity(NONCE_LEN + sealed.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Some(hex::encode(out))
}

/// Open a value produced by [`seal`]. `None` on any tamper, truncation, or a
/// key that no longer matches (e.g. SESSION_SECRET was rotated).
pub fn open(key: &Key, sealed_hex: &str) -> Option<String> {
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
                aad: AAD,
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
}
