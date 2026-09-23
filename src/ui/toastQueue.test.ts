import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPausableTimer } from "./pausableTimer";
import {
  MAX_TOAST_MS,
  MAX_VISIBLE_TOASTS,
  __resetToasts,
  currentToasts,
  dismissToast,
  pushToast,
  setToastsPaused,
  toastDurationMs,
} from "./toastQueue";

beforeEach(() => {
  vi.useFakeTimers();
  __resetToasts();
});

afterEach(() => {
  __resetToasts();
  vi.useRealTimers();
});

const messages = () => currentToasts().map((t) => t.message);

describe("startPausableTimer", () => {
  it("keeps the time that was left across a pause", () => {
    const expire = vi.fn();
    const timer = startPausableTimer(1000, expire);
    vi.advanceTimersByTime(600);
    timer.pause();
    vi.advanceTimersByTime(60_000);
    expect(expire).not.toHaveBeenCalled();
    timer.resume();
    vi.advanceTimersByTime(399);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it("gives at least the floor when resumed nearly spent", () => {
    const expire = vi.fn();
    const timer = startPausableTimer(1000, expire);
    vi.advanceTimersByTime(950);
    timer.pause();
    timer.resume(500);
    vi.advanceTimersByTime(499);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it("can start paused, and never fires once cancelled", () => {
    const expire = vi.fn();
    const timer = startPausableTimer(100, expire, true);
    vi.advanceTimersByTime(1000);
    expect(expire).not.toHaveBeenCalled();
    timer.resume();
    timer.cancel();
    vi.advanceTimersByTime(1000);
    timer.resume();
    vi.advanceTimersByTime(1000);
    expect(expire).not.toHaveBeenCalled();
  });

  it("does not fire at once for a delay setTimeout can't hold", () => {
    const expire = vi.fn();
    startPausableTimer(Number.MAX_SAFE_INTEGER, expire);
    vi.advanceTimersByTime(60_000);
    expect(expire).not.toHaveBeenCalled();
  });
});

describe("toastDurationMs", () => {
  it("keeps each tone's minimum for short copy", () => {
    expect(toastDurationMs("Copied", "info", false)).toBe(3000);
    expect(toastDurationMs("Copied", "success", false)).toBe(3000);
    expect(toastDurationMs("Failed", "error", false)).toBe(5000);
    expect(toastDurationMs("Deleted", "info", true)).toBe(7000);
  });

  it("stretches longer copy by reading time", () => {
    const short = toastDurationMs("x".repeat(60), "info", false);
    const long = toastDurationMs("x".repeat(90), "info", false);
    expect(short).toBeGreaterThan(3000);
    expect(long).toBeGreaterThan(short);
  });

  it("caps very long copy", () => {
    expect(toastDurationMs("x".repeat(2000), "error", false)).toBe(MAX_TOAST_MS);
    expect(toastDurationMs("x".repeat(2000), "info", true)).toBe(MAX_TOAST_MS);
  });
});

describe("the toast stack", () => {
  it("expires a plain toast after its duration", () => {
    pushToast("Saved");
    vi.advanceTimersByTime(2999);
    expect(messages()).toEqual(["Saved"]);
    vi.advanceTimersByTime(1);
    expect(messages()).toEqual([]);
  });

  it(`shows at most ${MAX_VISIBLE_TOASTS}, the oldest leaving first`, () => {
    for (const m of ["one", "two", "three", "four"]) pushToast(m);
    expect(messages()).toEqual(["two", "three", "four"]);
    // The evicted toast's timer is gone too — nothing fires for it later.
    vi.advanceTimersByTime(3000);
    expect(messages()).toEqual([]);
  });

  it("keeps a toast with an action up longer than plain feedback", () => {
    pushToast("Deleted", "info", { action: { label: "Undo", onClick: () => {} } });
    pushToast("Saved");
    vi.advanceTimersByTime(3000);
    expect(messages()).toEqual(["Deleted"]);
    vi.advanceTimersByTime(4000);
    expect(messages()).toEqual([]);
  });

  it("uses an explicit duration as given", () => {
    pushToast("x".repeat(500), "info", { durationMs: 1200 });
    vi.advanceTimersByTime(1200);
    expect(messages()).toEqual([]);
  });

  it("can be dismissed early", () => {
    pushToast("Saved");
    dismissToast(currentToasts()[0]!.id);
    expect(messages()).toEqual([]);
  });

  it("holds every countdown while paused and releases with a floor", () => {
    pushToast("Saved");
    vi.advanceTimersByTime(2900);
    setToastsPaused("hover", true);
    pushToast("Also saved");
    vi.advanceTimersByTime(60_000);
    expect(messages()).toEqual(["Saved", "Also saved"]);
    setToastsPaused("hover", false);
    // "Saved" had 100 ms left; it gets the one-second floor instead.
    vi.advanceTimersByTime(999);
    expect(messages()).toContain("Saved");
    vi.advanceTimersByTime(1);
    expect(messages()).toEqual(["Also saved"]);
    vi.advanceTimersByTime(2000);
    expect(messages()).toEqual([]);
  });

  it("stays paused until every reason has cleared", () => {
    pushToast("Saved");
    setToastsPaused("hover", true);
    setToastsPaused("hidden", true);
    setToastsPaused("hover", false);
    vi.advanceTimersByTime(60_000);
    expect(messages()).toEqual(["Saved"]);
    setToastsPaused("hidden", false);
    vi.advanceTimersByTime(3000);
    expect(messages()).toEqual([]);
  });
});
