/**
 * Regenerate the golden share-token fixtures.
 *
 *   bun run gen:golden      # or: bun scripts/gen-golden-fixtures.ts
 *
 * Share tokens are a PUBLIC, forever-openable data contract: every link a user
 * has ever copied lives entirely in its `#hash`, and DWEEB must keep decoding
 * it. `golden.test.ts` guards that by asserting these frozen tokens still decode
 * to their frozen wire form. Run this script ONLY when you have intentionally
 * changed the wire format (and bumped `CURRENT_VERSION` + added a migration) —
 * then review the JSON diff as carefully as you would a schema migration.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeShare, encodeShare } from "@/core/serialization/encode";
import { stripEditorFields } from "@/core/serialization/normalize";
import { FIXTURES } from "@/test/fixtures";

const entries = Object.entries(FIXTURES).map(([name, build]) => {
  const token = encodeShare(build());
  // A token that can't round-trip is never worth freezing — fail loudly.
  const decoded = decodeShare(token);
  if (!decoded.ok) {
    throw new Error(`Fixture "${name}" did not round-trip: ${decoded.error}`);
  }
  return { name, token, wire: stripEditorFields(decoded.message) };
});

const outDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/core/serialization/__fixtures__",
);
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, "share-tokens.json");
writeFileSync(outFile, `${JSON.stringify(entries, null, 2)}\n`);

console.log(`Wrote ${entries.length} golden share token(s) → ${outFile}`);
