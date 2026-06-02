/**
 * Editor-only id generator. 10 characters from a URL-safe alphabet is enough
 * to make collisions astronomically unlikely within a single message (largest
 * legal message is 40 components). These ids are ephemeral — they identify
 * nodes inside the editor session only and are reassigned on import/share, so
 * they never need cryptographic uniqueness.
 *
 * Implemented directly on `crypto.getRandomValues` rather than pulling in a
 * dependency: the alphabet has 36 symbols, so a byte's slight modulo bias is
 * irrelevant across the ≤40 ids a message ever holds.
 */
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const SIZE = 10;

export const newId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(SIZE));
  let id = "";
  for (let i = 0; i < SIZE; i++) id += ALPHABET[bytes[i]! % ALPHABET.length];
  return id;
};
