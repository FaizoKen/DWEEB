import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The reporter is the client's half of the paging gate: whatever it declines to
 * send, nobody hears about. These drive its real window handlers — network,
 * proxy config, surface and boot recovery mocked — to pin the one decision the
 * pure tests in `crashReport.test.ts` cannot: *which* kind and *which* stack it
 * judges foreign code on (the resolved kind, and the full stack rather than
 * the six-line wire).
 */

const { proxyFetch } = vi.hoisted(() => ({
  proxyFetch: vi.fn((_path: string, _init: RequestInit) =>
    Promise.resolve(new Response(null, { status: 204 })),
  ),
}));

vi.mock("@/core/net/proxyFetch", () => ({ proxyFetch }));
vi.mock("@/core/guild/config", () => ({ isProxyConfigured: () => true }));
vi.mock("@/core/activity/runtime", () => ({ isActivityMode: () => false }));
vi.mock("@/core/pwa/staleChunkRecovery", () => ({ isStaleChunkReloadInProgress: () => false }));

type Handler = (event: unknown) => void;
let handlers: Record<string, Handler> = {};

const METAMASK_FRAME =
  "at Object.connect (chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js:7:84292)";
const OUR_FRAME = "at Ks (https://dweeb.faizo.net/assets/index-DcBtb6aN.js:41:9528)";

/** An Error whose stack is exactly `lines`, V8-style (4-space frame indent). */
function errorWithStack(message: string, lines: string[]): Error {
  const error = new Error(message);
  error.stack = lines.map((line, i) => (i === 0 ? line : `    ${line}`)).join("\n");
  return error;
}

/** The bodies of every beacon sent so far. */
function sent(): { kind: string; message: string; stack: string }[] {
  return proxyFetch.mock.calls.map(([, init]) => JSON.parse(String(init.body)));
}

/** Fire a window trap — loudly absent if the reporter never installed it, so
 *  no "never sends" test can pass just because nothing was listening. */
function fire(type: "error" | "unhandledrejection", event: unknown): void {
  const handler = handlers[type];
  if (!handler) throw new Error(`the reporter installed no ${type} handler`);
  handler(event);
}

beforeEach(async () => {
  // A fresh module per test: the reporter's `installed` latch and its
  // per-page throttle are module state.
  vi.resetModules();
  proxyFetch.mockClear();
  handlers = {};
  vi.stubEnv("PROD", true);
  // Node before 21 has no global `navigator`, and the reporter's `enabled()`
  // needs one (it reads the page's privacy signals off it).
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", {
    addEventListener: (type: string, handler: Handler) => {
      handlers[type] = handler;
    },
  });
  const { installCrashReporter } = await import("./reporter");
  installCrashReporter();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the crash reporter's foreign-code gate", () => {
  it("installs both window traps", () => {
    expect(Object.keys(handlers).sort()).toEqual(["error", "unhandledrejection"]);
  });

  it("never sends the 2026-09-14 MetaMask rejection", () => {
    const reason = errorWithStack("Failed to connect to MetaMask", [
      "i: Failed to connect to MetaMask",
      METAMASK_FRAME,
    ]);
    fire("unhandledrejection", { reason });
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it("judges the full stack, not the six-line wire", () => {
    // A 900-unit message fills the whole wire window, so the wire names no
    // location at all — but the full stack shows the only code is MetaMask's.
    const message = `RPC Error: ${"x".repeat(900)}`;
    const reason = errorWithStack(message, [`Error: ${message}`, METAMASK_FRAME]);
    fire("unhandledrejection", { reason });
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it("drops foreign code before the throttle, so it never spends a slot a real crash needs", () => {
    // The throttle sends at most five distinct beacons per page. Five kinds of
    // extension noise, then a crash of ours: ours must still go out.
    for (let i = 0; i < 5; i++) {
      const reason = errorWithStack(`noise ${i}`, [`Error: noise ${i}`, METAMASK_FRAME]);
      fire("unhandledrejection", { reason });
    }
    const reason = errorWithStack("boom", ["Error: boom", OUR_FRAME]);
    fire("unhandledrejection", { reason });
    expect(sent().map((beacon) => beacon.message)).toEqual(["boom"]);
  });

  it("still sends a crash of ours that ran through an extension's code", () => {
    const reason = errorWithStack("boom", ["Error: boom", METAMASK_FRAME, OUR_FRAME]);
    fire("unhandledrejection", { reason });
    expect(sent()).toHaveLength(1);
    expect(sent()[0]?.kind).toBe("unhandledrejection");
    expect(sent()[0]?.stack).toContain("https://dweeb.faizo.net/assets/");
  });

  it("sends a promoted frame when a long message filled the window", () => {
    // Without promotion the proxy would read a location-less window-error
    // stack as unattributed and demote our own crash.
    const message = `Failed to execute 'postMessage': ${"s".repeat(900)} could not be cloned.`;
    const error = errorWithStack(message, [`DataCloneError: ${message}`, OUR_FRAME]);
    fire("error", { error, message });
    expect(sent()).toHaveLength(1);
    expect(sent()[0]?.stack.split("\n").at(-1)).toBe(OUR_FRAME);
  });

  it("judges the resolved kind, so a sparse chunk failure is never taken for foreign code", async () => {
    // Safari words a failed chunk load without a URL, and its stack can name
    // nothing. As a raw window error that reads as "unattributed"; resolved, it
    // is a fatal chunk load, which the probes settle (here, no URL to probe).
    const error = errorWithStack("Importing a module script failed.", ["@", "[native code]"]);
    fire("error", { error, message: error.message });
    await vi.waitFor(() => expect(proxyFetch).toHaveBeenCalledTimes(1));
    expect(sent()[0]?.kind).toBe("chunk-unreachable");
  });
});
