import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/core/guild/config", () => ({
  PROXY_BASE_URL: "https://proxy.example",
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("short-link resolution deadline", () => {
  it("abandons a stale early request, aborts the retry, and returns an error", async () => {
    vi.useFakeTimers();
    const neverSettles = new Promise<Response | null>(() => {});
    vi.stubGlobal("window", { __dweebShortLink: neverSettles });
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { resolveShortLink } = await import("./shortlink");

    const result = resolveShortLink("AbC12345");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(result).resolves.toEqual({
      ok: false,
      error: "Couldn't reach the short-link service.",
    });
    expect(window.__dweebShortLink).toBeUndefined();
  });
});
