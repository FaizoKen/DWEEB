import { describe, expect, it } from "vitest";

import { shouldAttemptStaleChunkReload } from "./staleChunkRecovery";

/** Entry-chunk URLs stand in for two deploys — the shape `buildKey()` returns. */
const BUILD_A = "https://dweeb.faizo.net/assets/index-CT5DTc--.js";
const BUILD_B = "https://dweeb.faizo.net/assets/index-Zq1x8mPl.js";

describe("shouldAttemptStaleChunkReload", () => {
  it("reloads on a boot-time failure with no prior attempt", () => {
    expect(
      shouldAttemptStaleChunkReload({
        bootFinished: false,
        buildKey: BUILD_A,
        attemptedBuildKey: null,
      }),
    ).toBe(true);
  });

  it("never reloads once the surface has committed — the user may have unsaved work", () => {
    expect(
      shouldAttemptStaleChunkReload({
        bootFinished: true,
        buildKey: BUILD_A,
        attemptedBuildKey: null,
      }),
    ).toBe(false);
  });

  it("refuses a second reload on the same shell — that's a loop, not recovery", () => {
    expect(
      shouldAttemptStaleChunkReload({
        bootFinished: false,
        buildKey: BUILD_A,
        attemptedBuildKey: BUILD_A,
      }),
    ).toBe(false);
  });

  it("allows a fresh attempt when the shell has moved on since the last one", () => {
    // Same tab, a later deploy: the recorded attempt was for an older shell,
    // so the new skew deserves its own (single) reload. Keying this on the
    // entry chunk rather than `__APP_VERSION__` is what makes the case
    // reachable — the package version has been 1.0.0 across every deploy since
    // launch, so a version key collapsed this into the loop guard above.
    expect(
      shouldAttemptStaleChunkReload({
        bootFinished: false,
        buildKey: BUILD_B,
        attemptedBuildKey: BUILD_A,
      }),
    ).toBe(true);
  });
});
