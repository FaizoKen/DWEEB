import { afterEach, describe, expect, it, vi } from "vitest";

import { hollowChunkMessage } from "@/core/telemetry/crashReport";

import {
  damagedChunkUrl,
  MAX_AUTOMATIC_NAVIGATIONS,
  NAVIGATION_WINDOW_MS,
  hasRefreshParam,
  parseRecoveryRecord,
  planStaleChunkRecovery,
  recentNavigations,
  REFRESH_PARAM,
  stripRefreshParam,
  withRefreshParam,
  type RecoveryPlanInput,
  type RecoveryRecord,
} from "./staleChunkRecovery";

/** Build ids stand in for two deploys — the shape `buildKey()` returns. */
const BUILD_A = "e699a38eec";
const BUILD_B = "25373c3a08";
const NOW = 1_800_000_000_000;

function input(overrides: Partial<RecoveryPlanInput> = {}): RecoveryPlanInput {
  return {
    bootFinished: false,
    chunkFailure: true,
    buildKey: BUILD_A,
    record: null,
    arrivedViaRefresh: false,
    online: true,
    controlled: false,
    now: NOW,
    ...overrides,
  };
}

function record(
  build: string,
  step: RecoveryRecord["step"],
  navigations: number[] = [],
): RecoveryRecord {
  return { build, step, navigations };
}

describe("planStaleChunkRecovery", () => {
  it("reloads on a boot-time chunk failure with no prior attempt", () => {
    expect(planStaleChunkRecovery(input())).toBe("reload");
  });

  it("climbs to the bypass when the reload landed on the same shell again", () => {
    // The 2026-09-11 shape: one reload spent on this build, and the boot failed
    // on the same purged chunk anyway. A plain reload can never escape a shell
    // a service worker keeps serving; the bypass can.
    expect(
      planStaleChunkRecovery(input({ record: record(BUILD_A, "reload", [NOW - 5_000]) })),
    ).toBe("bypass");
  });

  it("stops after the bypass — a third failure on the same shell is the caller's", () => {
    expect(
      planStaleChunkRecovery(
        input({ record: record(BUILD_A, "bypass", [NOW - 9_000, NOW - 4_000]) }),
      ),
    ).toBe("none");
  });

  it("never navigates once the surface has committed — the user may have unsaved work", () => {
    expect(planStaleChunkRecovery(input({ bootFinished: true }))).toBe("none");
    expect(
      planStaleChunkRecovery(input({ bootFinished: true, record: record(BUILD_A, "reload") })),
    ).toBe("none");
  });

  it("never navigates for a failure that is not a chunk load — a bug boots identically every time", () => {
    expect(planStaleChunkRecovery(input({ chunkFailure: false }))).toBe("none");
    expect(
      planStaleChunkRecovery(input({ chunkFailure: false, record: record(BUILD_A, "reload") })),
    ).toBe("none");
  });

  it("allows a fresh ladder when the shell has moved on since the last attempt", () => {
    // Same tab, a later deploy: the recorded attempt was for an older shell,
    // so the new skew deserves its own reload. Keying this on the build id
    // rather than `__APP_VERSION__` is what makes the case reachable — the
    // package version sat at one value across many deploys, so a version key
    // collapsed this into the loop guard.
    expect(
      planStaleChunkRecovery(
        input({ buildKey: BUILD_B, record: record(BUILD_A, "bypass", [NOW - 60_000]) }),
      ),
    ).toBe("reload");
  });

  it("refuses to bypass again from a boot the bypass already brought here, whatever storage says", () => {
    // The storage-independent guard: the URL carried the refresh nonce, so a
    // bypass has demonstrably run for this shell even if the record was lost.
    expect(
      planStaleChunkRecovery(input({ arrivedViaRefresh: true, record: record(BUILD_A, "reload") })),
    ).toBe("none");
  });

  it("never navigates into the void while offline — the notice is the better place", () => {
    // The bypass is an uncontrolled navigation by construction: never offline.
    expect(
      planStaleChunkRecovery(
        input({ online: false, controlled: true, record: record(BUILD_A, "reload") }),
      ),
    ).toBe("none");
    // A reload offline can only be answered by a controlling worker, which may
    // serve it from its precache; without one it lands on the browser's error
    // page, so the offline notice (with its own Reload button) wins instead.
    expect(planStaleChunkRecovery(input({ online: false, controlled: true }))).toBe("reload");
    expect(planStaleChunkRecovery(input({ online: false, controlled: false }))).toBe("none");
  });

  it("caps automatic navigations per tab regardless of how the build key alternates", () => {
    // Two builds both failing at boot behind a CDN still handing out the old
    // shell: X → reload → Y → reload → X … would otherwise earn a fresh ladder
    // on every alternation. The rolling cap ends it.
    const spent = Array.from(
      { length: MAX_AUTOMATIC_NAVIGATIONS },
      (_, i) => NOW - 1_000 * (i + 1),
    );
    expect(
      planStaleChunkRecovery(
        input({ buildKey: BUILD_B, record: record(BUILD_A, "reload", spent) }),
      ),
    ).toBe("none");
    // One short of the cap still gets its step.
    expect(
      planStaleChunkRecovery(
        input({ buildKey: BUILD_B, record: record(BUILD_A, "reload", spent.slice(1)) }),
      ),
    ).toBe("reload");
  });

  it("forgets navigations older than the window", () => {
    const old = Array.from(
      { length: MAX_AUTOMATIC_NAVIGATIONS },
      (_, i) => NOW - NAVIGATION_WINDOW_MS - 1_000 * (i + 1),
    );
    expect(recentNavigations(record(BUILD_A, "bypass", old), NOW)).toEqual([]);
    expect(
      planStaleChunkRecovery(input({ buildKey: BUILD_B, record: record(BUILD_A, "bypass", old) })),
    ).toBe("reload");
    // A clock that went backwards doesn't count future stamps either way.
    expect(recentNavigations(record(BUILD_A, "reload", [NOW + 60_000, NOW - 1]), NOW)).toEqual([
      NOW - 1,
    ]);
  });
});

describe("parseRecoveryRecord", () => {
  it("reads the ladder record", () => {
    expect(
      parseRecoveryRecord(JSON.stringify({ build: BUILD_A, step: "bypass", navigations: [1, 2] })),
    ).toEqual({ build: BUILD_A, step: "bypass", navigations: [1, 2] });
  });

  it("reads a pre-ladder client's bare build key as a spent reload", () => {
    expect(parseRecoveryRecord(BUILD_A)).toEqual({
      build: BUILD_A,
      step: "reload",
      navigations: [],
    });
  });

  it("treats anything unparseable as no record — the claim is what actually gates a navigation", () => {
    expect(parseRecoveryRecord(null)).toBe(null);
    expect(parseRecoveryRecord("")).toBe(null);
    expect(parseRecoveryRecord(JSON.stringify({ build: BUILD_A, step: "sideways" }))).toBe(null);
    expect(parseRecoveryRecord(JSON.stringify([1, 2]))).toBe(null);
    expect(parseRecoveryRecord(JSON.stringify(null))).toBe(null);
  });

  it("drops non-numeric navigation stamps instead of failing the record", () => {
    expect(
      parseRecoveryRecord(
        JSON.stringify({
          build: BUILD_A,
          step: "reload",
          navigations: [1, "x", null, Infinity, 2],
        }),
      ),
    ).toEqual({ build: BUILD_A, step: "reload", navigations: [1, 2] });
  });
});

describe("refresh nonce URL surgery", () => {
  it("appends the nonce verbatim after an existing query, keeping the hash", () => {
    // An Activity launch query: the Embedded App SDK reads these from
    // `location.search` and throws if either is missing or re-encoded.
    const activity = {
      pathname: "/",
      search: "?frame_id=abc&instance_id=i-1&platform=desktop",
      hash: "",
    };
    expect(withRefreshParam(activity, "n1")).toBe(
      `/?frame_id=abc&instance_id=i-1&platform=desktop&${REFRESH_PARAM}=n1`,
    );
    const share = { pathname: "/", search: "", hash: "#v1.abc%20def&x=1" };
    expect(withRefreshParam(share, "n2")).toBe(`/?${REFRESH_PARAM}=n2#v1.abc%20def&x=1`);
    const shortLink = {
      pathname: "/s/Ab12cd",
      search: "?template=welcome",
      hash: "#entry=guide:x",
    };
    expect(withRefreshParam(shortLink, "n3")).toBe(
      `/s/Ab12cd?template=welcome&${REFRESH_PARAM}=n3#entry=guide:x`,
    );
  });

  it("strips only the nonce, leaving the rest of the query byte-for-byte", () => {
    expect(stripRefreshParam(`?${REFRESH_PARAM}=n1`)).toBe("");
    expect(stripRefreshParam(`?frame_id=abc&${REFRESH_PARAM}=n1`)).toBe("?frame_id=abc");
    expect(stripRefreshParam(`?${REFRESH_PARAM}=n1&frame_id=abc`)).toBe("?frame_id=abc");
    expect(stripRefreshParam(`?a=%20b&${REFRESH_PARAM}=n1&c=~!()`)).toBe("?a=%20b&c=~!()");
    expect(stripRefreshParam(`?x&${REFRESH_PARAM}`)).toBe("?x");
    // A trailing `&` (an empty part) survives the round trip untouched too.
    const trailing = { pathname: "/", search: "?a=1&", hash: "" };
    expect(stripRefreshParam(new URL(withRefreshParam(trailing, "n1"), "https://x").search)).toBe(
      "?a=1&",
    );
  });

  it("returns a query without the nonce untouched", () => {
    for (const search of [
      "",
      "?frame_id=abc",
      "?a=1&b=2",
      `?x=${REFRESH_PARAM}`,
      `?${REFRESH_PARAM}x=1`,
    ]) {
      expect(stripRefreshParam(search)).toBe(search);
      expect(hasRefreshParam(search)).toBe(false);
    }
  });

  it("recognises the nonce only as a key", () => {
    expect(hasRefreshParam(`?${REFRESH_PARAM}=n1`)).toBe(true);
    expect(hasRefreshParam(`?a=1&${REFRESH_PARAM}=n1`)).toBe(true);
    expect(hasRefreshParam(`?${REFRESH_PARAM}`)).toBe(true);
    expect(hasRefreshParam(`?entry=${REFRESH_PARAM}`)).toBe(false);
  });
});

describe("a boot that died on a hollow chunk", () => {
  const ORIGIN = "https://dweeb.faizo.net";
  const FLOWS = `${ORIGIN}/assets/flows-Cs_Dwe0Q.js`;
  const hollow = () => new Error(hollowChunkMessage("flows", "webhookFlow", FLOWS));

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("names the chunk to repair, and nothing for any other failure", () => {
    vi.stubGlobal("location", { origin: ORIGIN });
    expect(damagedChunkUrl(hollow())).toBe(FLOWS);
    expect(
      damagedChunkUrl(
        new Error(
          "The requested module './guildWebhooks-CY1UaqZE.js' does not provide an export named 'p'",
        ),
      ),
    ).toBe(`${ORIGIN}/assets/guildWebhooks-CY1UaqZE.js`);
    // A failed load has nothing damaged to delete; a bug has nothing at all.
    expect(
      damagedChunkUrl(new Error(`Failed to fetch dynamically imported module: ${FLOWS}`)),
    ).toBe(null);
    expect(damagedChunkUrl(new Error(`can't access property "parse", t is undefined`))).toBe(null);
  });

  it("deletes the damaged copy from every cache and refetches it before it reloads", async () => {
    // The 2026-11-03 tab: controlled by a worker whose precache held an empty
    // flows chunk, so a plain reload was answered with the same copy.
    vi.resetModules();
    vi.stubEnv("PROD", true);
    const steps: string[] = [];
    const caches = ["workbox-precache-v2-https://dweeb.faizo.net/", "dweeb-lazy-assets"];
    vi.stubGlobal("caches", {
      keys: async () => caches,
      open: async (name: string) => ({
        delete: async (url: string, options: CacheQueryOptions) => {
          steps.push(`delete ${name} ${url} ${options.ignoreSearch === true}`);
          return true;
        },
      }),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        steps.push(`fetch ${url} ${init.cache}`);
        return new Response("export{l as webhookFlow};");
      }),
    );
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
    vi.stubGlobal("navigator", { onLine: true, serviceWorker: { controller: {} } });
    vi.stubGlobal("location", { origin: ORIGIN });
    vi.stubGlobal("window", {
      location: { reload: () => steps.push("reload") },
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    const { recoverFromBootFailure } = await import("./staleChunkRecovery");

    expect(recoverFromBootFailure(hollow(), () => steps.push("stuck"))).toBe("navigating");
    await vi.waitFor(() => expect(steps).toContain("reload"));
    expect(steps).toEqual([
      `delete ${caches[0]} ${FLOWS} true`,
      `delete ${caches[1]} ${FLOWS} true`,
      `fetch ${FLOWS} reload`,
      "reload",
    ]);
  });
});
