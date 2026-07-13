import { describe, expect, it } from "vitest";

import {
  buildCrashPayload,
  crashSignature,
  CrashThrottle,
  describeError,
  isNonCrashMessage,
  topFrames,
  type CrashInput,
} from "./crashReport";

describe("describeError", () => {
  it("pulls message and stack from an Error", () => {
    const err = new Error("boom");
    const out = describeError(err);
    expect(out.message).toBe("boom");
    expect(out.stack).toContain("boom"); // v8 stacks lead with the message
  });

  it("falls back to the error name when the message is empty", () => {
    const err = new TypeError("");
    expect(describeError(err).message).toBe("TypeError");
  });

  it("handles a bare string throw", () => {
    expect(describeError("just a string")).toEqual({ message: "just a string", stack: "" });
  });

  it("reads a message off an ErrorEvent-like object", () => {
    const evt = { message: "script error", stack: "at foo" };
    expect(describeError(evt)).toEqual({ message: "script error", stack: "at foo" });
  });

  it("never throws on exotic values", () => {
    expect(describeError(null).message).toBe("null");
    expect(describeError(undefined).message).toBe("undefined");
    expect(describeError(42).message).toBe("42");
    // A hostile toString must not blow up the reporter.
    const hostile = {
      get message() {
        return undefined;
      },
      toString() {
        throw new Error("nope");
      },
    };
    expect(() => describeError(hostile)).not.toThrow();
    expect(describeError(hostile).message).toContain("unstringifiable");
  });
});

describe("topFrames", () => {
  it("keeps only the top N non-empty, trimmed lines", () => {
    const stack = ["Error: x", "  at a (f.js:1)", "", "  at b (g.js:2)", "  at c (h.js:3)"].join(
      "\n",
    );
    expect(topFrames(stack, 2)).toBe("Error: x\nat a (f.js:1)");
  });

  it("returns empty for an empty stack", () => {
    expect(topFrames("")).toBe("");
  });
});

describe("crashSignature", () => {
  it("is stable for the same error thrown repeatedly (loop dedup)", () => {
    const a = crashSignature("error", "boom", "at render (App.js:10:5)\nat x");
    const b = crashSignature("error", "boom", "at render (App.js:10:5)\nat y");
    expect(a).toBe(b); // differing lower frames don't change the signature
  });

  it("distinguishes different errors", () => {
    const a = crashSignature("error", "boom", "at a");
    const b = crashSignature("error", "bang", "at a");
    const c = crashSignature("boundary", "boom", "at a");
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("buildCrashPayload", () => {
  const base: CrashInput = {
    kind: "error",
    error: new Error("boom"),
    path: "/",
    surface: "web",
    version: "0.10.0",
  };

  it("assembles a content-free payload", () => {
    const p = buildCrashPayload(base);
    expect(p).toMatchObject({
      kind: "error",
      message: "boom",
      surface: "web",
      version: "0.10.0",
      path: "/",
    });
    expect(typeof p.stack).toBe("string");
  });

  it("clamps an oversized message to 300 chars", () => {
    const p = buildCrashPayload({ ...base, error: new Error("x".repeat(1000)) });
    expect(p.message.length).toBe(300);
  });

  it("caps the stack to the top frames and 800 chars", () => {
    const deep = Array.from({ length: 50 }, (_, i) => `  at frame${i} (file.js:${i}:1)`).join("\n");
    const err = new Error("deep");
    err.stack = deep;
    const p = buildCrashPayload({ ...base, error: err });
    expect(p.stack.split("\n").length).toBeLessThanOrEqual(6);
    expect(p.stack.length).toBeLessThanOrEqual(800);
  });

  it("carries only the path it is handed (never a hash)", () => {
    // The builder is pure: it trusts the caller to pass pathname only. This
    // documents that contract — a hash would only appear if the glue leaked one.
    const p = buildCrashPayload({ ...base, path: "/templates" });
    expect(p.path).toBe("/templates");
    expect(p.path).not.toContain("#");
  });
});

describe("isNonCrashMessage", () => {
  it("drops the ResizeObserver loop notice in both spellings", () => {
    // Not a crash: the browser reports an undelivered resize notification, which
    // settles on the next frame. Reporting it pages us for a non-event.
    expect(isNonCrashMessage("ResizeObserver loop completed with undelivered notifications")).toBe(
      true,
    );
    expect(isNonCrashMessage("ResizeObserver loop limit exceeded")).toBe(true);
  });

  it("still drops it when the browser wraps the message", () => {
    expect(isNonCrashMessage("Uncaught ResizeObserver loop limit exceeded")).toBe(true);
  });

  it("keeps real errors, including ones that merely mention ResizeObserver", () => {
    expect(isNonCrashMessage("Cannot read properties of undefined (reading 'id')")).toBe(false);
    expect(isNonCrashMessage("ResizeObserver is not defined")).toBe(false);
    expect(isNonCrashMessage("")).toBe(false);
  });
});

describe("CrashThrottle", () => {
  it("sends a signature once, then suppresses repeats", () => {
    const t = new CrashThrottle(5);
    expect(t.shouldSend("sig-a")).toBe(true);
    expect(t.shouldSend("sig-a")).toBe(false);
    expect(t.shouldSend("sig-a")).toBe(false);
  });

  it("enforces a hard cap across distinct signatures", () => {
    const t = new CrashThrottle(2);
    expect(t.shouldSend("a")).toBe(true);
    expect(t.shouldSend("b")).toBe(true);
    expect(t.shouldSend("c")).toBe(false); // over the cap even though it's new
  });

  it("counts a suppressed duplicate against neither the cap nor twice", () => {
    const t = new CrashThrottle(2);
    expect(t.shouldSend("a")).toBe(true);
    expect(t.shouldSend("a")).toBe(false); // dup, not counted
    expect(t.shouldSend("b")).toBe(true); // still room for the second distinct one
  });
});
