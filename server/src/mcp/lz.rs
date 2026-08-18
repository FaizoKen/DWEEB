//! LZ-String's `compressToEncodedURIComponent`, in Rust.
//!
//! A DWEEB share link carries the whole message compressed into its URL
//! fragment, and the format is not ours to choose: a link this server mints is
//! opened by the web app, whose decoder knows exactly one encoding —
//! `lz-string`'s, as used by `core/serialization/encode.ts`. Producing anything
//! else yields a link that loads DWEEB and then fails, which is worse than not
//! offering the link at all.
//!
//! Nothing can generate this algorithm, so it is pinned the way the validator
//! is: `scripts/gen-mcp-catalog.ts` runs the real `lz-string` over a set of
//! inputs and records its answers in `lz-vectors.json`, and the test at the
//! bottom asserts this port reproduces every one byte for byte.
//!
//! **It operates on UTF-16 code units, not Rust `char`s.** LZ-String is a
//! JavaScript library and its dictionary is keyed by JavaScript string
//! characters, so an astral character (an emoji) is *two* dictionary entries,
//! not one. Iterating `chars()` produces a different — and undecodable —
//! output for any message containing an emoji, which is most of them. The
//! `astral` and `mixed` vectors exist to catch exactly that.
//!
//! Only compression is implemented: this server mints links, and reading one
//! back is the browser's job.

/// The URI-safe alphabet, six bits per character. `+`, `-` and `$` are the
/// three non-alphanumerics, all safe in a URL fragment without escaping.
const KEY_URI_SAFE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$";

/// Bits packed into each output character.
const BITS_PER_CHAR: u32 = 6;

/// Compress `input` the way `compressToEncodedURIComponent` does.
pub fn compress_to_encoded_uri_component(input: &str) -> String {
    // The whole algorithm is defined over UTF-16 code units — see the module
    // comment. Materializing them once keeps every index consistent.
    let units: Vec<u16> = input.encode_utf16().collect();
    compress(&units)
}

/// A dictionary key: one UTF-16 unit, or a sequence of them.
type Key = Vec<u16>;

struct BitWriter {
    out: String,
    value: u32,
    position: u32,
}

impl BitWriter {
    fn new() -> Self {
        BitWriter {
            out: String::new(),
            value: 0,
            position: 0,
        }
    }

    /// Append `count` bits of `data`, least significant first — the only bit
    /// order `lz-string` uses, for both codes and character payloads.
    fn write_bits_reversed(&mut self, count: u32, mut data: u32) {
        for _ in 0..count {
            self.write_bit(data & 1);
            data >>= 1;
        }
    }

    fn write_bit(&mut self, bit: u32) {
        self.value = (self.value << 1) | bit;
        if self.position == BITS_PER_CHAR - 1 {
            self.position = 0;
            self.out.push(KEY_URI_SAFE[self.value as usize] as char);
            self.value = 0;
        } else {
            self.position += 1;
        }
    }

    /// Pad the final partial character with zero bits, as the format requires.
    fn finish(mut self) -> String {
        loop {
            self.value <<= 1;
            if self.position == BITS_PER_CHAR - 1 {
                self.out.push(KEY_URI_SAFE[self.value as usize] as char);
                break;
            }
            self.position += 1;
        }
        self.out
    }
}

/// The LZW core, transcribed from `lz-string`'s `_compress`.
///
/// Kept deliberately close to the original's shape — the same three-way `match`
/// on the dictionary state, the same "enlarge the code width when the next code
/// would not fit" bookkeeping — because the only thing that matters here is
/// producing identical bytes, and a tidier structure that diverges by one bit
/// is worthless.
fn compress(units: &[u16]) -> String {
    use std::collections::{HashMap, HashSet};

    if units.is_empty() {
        // Not a special case in the original either: it falls straight through
        // to writing the end marker.
        let mut writer = BitWriter::new();
        writer.write_bits_reversed(2, 2);
        return writer.finish();
    }

    let mut dictionary: HashMap<Key, u32> = HashMap::new();
    let mut dictionary_to_create: HashSet<Key> = HashSet::new();
    let mut w: Key = Vec::new();
    let mut enlarge_in: u32 = 2;
    let mut dict_size: u32 = 3;
    let mut num_bits: u32 = 2;
    let mut writer = BitWriter::new();

    for &unit in units {
        let c: Key = vec![unit];
        if !dictionary.contains_key(&c) {
            dictionary.insert(c.clone(), dict_size);
            dict_size += 1;
            dictionary_to_create.insert(c.clone());
        }

        let mut wc = w.clone();
        wc.push(unit);
        if dictionary.contains_key(&wc) {
            w = wc;
            continue;
        }

        emit(
            &w,
            &mut writer,
            &mut dictionary,
            &mut dictionary_to_create,
            &mut num_bits,
            &mut enlarge_in,
            &mut dict_size,
        );

        // Add wc to the dictionary.
        dictionary.insert(wc, dict_size);
        dict_size += 1;
        w = c;
    }

    if !w.is_empty() {
        emit(
            &w,
            &mut writer,
            &mut dictionary,
            &mut dictionary_to_create,
            &mut num_bits,
            &mut enlarge_in,
            &mut dict_size,
        );
    }

    // End marker.
    writer.write_bits_reversed(num_bits, 2);
    writer.finish()
}

/// Emit the code for `w` — either the literal character (first time it is seen)
/// or its dictionary index.
#[allow(clippy::too_many_arguments)]
fn emit(
    w: &Key,
    writer: &mut BitWriter,
    dictionary: &mut std::collections::HashMap<Key, u32>,
    dictionary_to_create: &mut std::collections::HashSet<Key>,
    num_bits: &mut u32,
    enlarge_in: &mut u32,
    dict_size: &mut u32,
) {
    if dictionary_to_create.contains(w) {
        let first = w[0];
        if first < 256 {
            // Type 0: an 8-bit character.
            writer.write_bits_reversed(*num_bits, 0);
            writer.write_bits_reversed(8, first as u32);
        } else {
            // Type 1: a 16-bit character. This is the branch a `chars()`-based
            // port never reaches correctly.
            writer.write_bits_reversed(*num_bits, 1);
            writer.write_bits_reversed(16, first as u32);
        }
        decrement_enlarge_in(num_bits, enlarge_in);
        dictionary_to_create.remove(w);
    } else {
        let code = dictionary[w];
        writer.write_bits_reversed(*num_bits, code);
    }
    decrement_enlarge_in(num_bits, enlarge_in);
    let _ = dict_size;
}

/// The code width grows once the dictionary outgrows it.
fn decrement_enlarge_in(num_bits: &mut u32, enlarge_in: &mut u32) {
    *enlarge_in -= 1;
    if *enlarge_in == 0 {
        *enlarge_in = 1 << *num_bits;
        *num_bits += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Vectors {
        vectors: Vec<Vector>,
    }

    #[derive(Deserialize)]
    struct Vector {
        name: String,
        input: String,
        output: String,
    }

    /// The point of this file: byte-identical output to the browser's encoder.
    #[test]
    fn matches_lz_string_on_every_vector() {
        let vectors: Vectors =
            serde_json::from_str(include_str!("lz-vectors.json")).expect("lz-vectors.json parses");
        assert!(vectors.vectors.len() >= 8);
        let mut failures = Vec::new();
        for v in &vectors.vectors {
            let got = compress_to_encoded_uri_component(&v.input);
            if got != v.output {
                failures.push(format!("{}:\n  rust: {got}\n  js:   {}", v.name, v.output));
            }
        }
        assert!(
            failures.is_empty(),
            "{} vector(s) differ from lz-string:\n{}",
            failures.len(),
            failures.join("\n")
        );
    }

    #[test]
    fn the_output_stays_inside_the_uri_safe_alphabet() {
        // The proxy's own short-link endpoint refuses a token carrying anything
        // else, and a fragment carrying it would need escaping.
        for input in ["", "hello", "😀 mixed ünïcode", &"x".repeat(5000)] {
            let out = compress_to_encoded_uri_component(input);
            assert!(
                out.bytes().all(|b| KEY_URI_SAFE.contains(&b)),
                "{input:?} produced characters outside the alphabet: {out}"
            );
        }
    }

    #[test]
    fn an_astral_character_is_compressed_as_two_units() {
        // The distinction this port turns on: one Rust `char`, two dictionary
        // entries. Emoji are everywhere in Discord messages, so a `chars()`-based
        // port produces links the browser cannot decode — for most real
        // messages, not an edge case. (The exact bytes are pinned by the
        // `astral` and `mixed` vectors above; this states the reason.)
        assert_eq!("😀".chars().count(), 1);
        assert_eq!("😀".encode_utf16().count(), 2);

        // Two units of the same value compress differently from one, which is
        // what makes the distinction observable in the output at all.
        let one_unit = compress_to_encoded_uri_component("é");
        let two_units = compress_to_encoded_uri_component("😀");
        assert_ne!(one_unit, two_units);
    }
}
