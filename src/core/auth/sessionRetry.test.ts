import { describe, expect, it } from "vitest";
import {
  isTransientSessionError,
  MAX_TIMED_SESSION_RETRIES,
  sessionRetryDelayMs,
} from "./sessionRetry";

const withStatus = (status: number) => Object.assign(new Error("request failed"), { status });

describe("isTransientSessionError", () => {
  it("reads no answer, a timeout, a rate limit and a server failure as saying nothing", () => {
    for (const status of [0, 408, 429, 500, 502, 503, 504]) {
      expect(isTransientSessionError(withStatus(status))).toBe(true);
    }
  });

  it("reads 401, 403 and every other answer as an answer", () => {
    for (const status of [200, 400, 401, 403, 404, 418]) {
      expect(isTransientSessionError(withStatus(status))).toBe(false);
    }
  });

  it("never guesses about an error without a status", () => {
    expect(isTransientSessionError(new Error("boom"))).toBe(false);
    expect(isTransientSessionError(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(isTransientSessionError({ status: "0" })).toBe(false);
    expect(isTransientSessionError(null)).toBe(false);
    expect(isTransientSessionError("offline")).toBe(false);
  });
});

describe("sessionRetryDelayMs", () => {
  it("backs off from 2 s, doubling, capped at a minute, over about two minutes in all", () => {
    const delays = Array.from({ length: MAX_TIMED_SESSION_RETRIES }, (_, i) =>
      sessionRetryDelayMs(i),
    );
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000]);
    expect(sessionRetryDelayMs(20)).toBe(60_000);
  });
});
