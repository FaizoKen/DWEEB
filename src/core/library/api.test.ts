import { beforeEach, describe, expect, it, vi } from "vitest";

const { proxyFetchMock } = vi.hoisted(() => ({ proxyFetchMock: vi.fn() }));

vi.mock("@/core/guild/config", () => ({ PROXY_BASE_URL: "https://api.example.test" }));
vi.mock("@/core/net/proxyFetch", () => ({ proxyFetch: proxyFetchMock }));

import { listLibrary } from "./api";

function answer(body: unknown) {
  proxyFetchMock.mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("listLibrary — posted history kept past a lower limit", () => {
  beforeEach(() => proxyFetchMock.mockReset());

  it("carries the hidden count the proxy reports", async () => {
    answer({ items: [], posted: { used: 10, quota: 10, hidden: 90 }, drafts: { used: 0 } });
    const res = await listLibrary("111111111111111111", { metadataOnly: true });
    expect(res.ok && res.posted).toEqual({ used: 10, quota: 10, hidden: 90 });
  });

  it("leaves it out when nothing is hidden, or the proxy predates it", async () => {
    answer({ items: [], posted: { used: 3, quota: 10, hidden: 0 } });
    const none = await listLibrary("111111111111111111");
    expect(none.ok && none.posted).toEqual({ used: 3, quota: 10 });

    answer({ items: [], posted: { used: 3, quota: 10 } });
    const older = await listLibrary("111111111111111111");
    expect(older.ok && older.posted).toEqual({ used: 3, quota: 10 });
  });
});
