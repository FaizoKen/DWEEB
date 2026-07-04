import { describe, expect, it } from "vitest";

import { decodeShare } from "./encode";
import { stripEditorFields } from "./normalize";
import { FIXTURES } from "@/test/fixtures";
import goldenTokens from "./__fixtures__/share-tokens.json";

/**
 * Forward-compatibility guard for the share-link format.
 *
 * Every entry here is a share token captured from a real encode and frozen. A
 * token that stops decoding — or decodes to a different tree — means a code
 * change silently broke links users have already copied. That must be a
 * deliberate act: bump `CURRENT_VERSION`, add a migration, and only then
 * regenerate with `bun run gen:golden`. If this test fails without that, revert
 * the wire-format change.
 */

interface GoldenEntry {
  name: string;
  token: string;
  wire: unknown;
}

const golden = goldenTokens as GoldenEntry[];

describe("golden share tokens (frozen wire-format contract)", () => {
  it("covers exactly the current fixture set (regenerate golden after adding one)", () => {
    expect(golden.map((g) => g.name).sort()).toEqual(Object.keys(FIXTURES).sort());
  });

  for (const entry of golden) {
    it(`still decodes the frozen "${entry.name}" token to its frozen wire form`, () => {
      expect(entry.token.startsWith("1.")).toBe(true);
      const decoded = decodeShare(entry.token);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(stripEditorFields(decoded.message)).toEqual(entry.wire);
    });
  }
});
