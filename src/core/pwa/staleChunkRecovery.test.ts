import { describe, expect, it } from "vitest";

import { shouldAttemptStaleChunkReload } from "./staleChunkRecovery";

describe("shouldAttemptStaleChunkReload", () => {
  it("reloads on a boot-time failure with no prior attempt", () => {
    expect(
      shouldAttemptStaleChunkReload({
        bootFinished: false,
        version: "0.12.0",
        attemptedVersion: null,
      }),
    ).toBe(true);
  });

  it("never reloads once the surface has committed — the user may have unsaved work", () => {
    expect(
      shouldAttemptStaleChunkReload({
        bootFinished: true,
        version: "0.12.0",
        attemptedVersion: null,
      }),
    ).toBe(false);
  });

  it("refuses a second reload for the same version — that's a loop, not recovery", () => {
    expect(
      shouldAttemptStaleChunkReload({
        bootFinished: false,
        version: "0.12.0",
        attemptedVersion: "0.12.0",
      }),
    ).toBe(false);
  });

  it("allows a fresh attempt when the shell version has moved on since the last one", () => {
    // Same tab, a later deploy: the recorded attempt was for an older shell,
    // so the new skew deserves its own (single) reload.
    expect(
      shouldAttemptStaleChunkReload({
        bootFinished: false,
        version: "0.13.0",
        attemptedVersion: "0.12.0",
      }),
    ).toBe(true);
  });
});
