import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the mock factories below can reference them.
const { loadStripeMock } = vi.hoisted(() => ({ loadStripeMock: vi.fn() }));

vi.mock("@stripe/stripe-js/pure", () => ({ loadStripe: loadStripeMock }));
vi.mock("./stripeConfig", () => ({ STRIPE_PUBLISHABLE_KEY: "pk_test_dweeb" }));
vi.mock("@/core/guild/config", () => ({ PROXY_BASE_URL: "https://proxy.test" }));

/** A fresh module per test: `getStripe` caches its promise at module level. */
async function freshApi() {
  vi.resetModules();
  return import("./stripeApi");
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const RAW = {
  id: "sub_1",
  guild_id: "111111111111111111",
  tier: "plus",
  status: "active",
  current_period_end: 1_900_000_000,
  cancel_at_period_end: false,
  movable_at: null,
};

describe("fetchMySubscriptions", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps the proxy's rows exactly as before on success", async () => {
    const { fetchMySubscriptions } = await freshApi();
    fetchMock.mockResolvedValue(
      jsonResponse(200, { items: [RAW, { ...RAW, id: "sub_2", movable_at: undefined }] }),
    );
    await expect(fetchMySubscriptions()).resolves.toEqual({
      ok: true,
      subscriptions: [
        {
          id: "sub_1",
          guildId: "111111111111111111",
          tier: "plus",
          status: "active",
          currentPeriodEnd: 1_900_000_000,
          cancelAtPeriodEnd: false,
          movableAt: null,
        },
        expect.objectContaining({ id: "sub_2", movableAt: null }),
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith("https://proxy.test/api/stripe/subscriptions", {
      method: "GET",
      credentials: "include",
    });
  });

  it("tells 'you have none' apart from 'couldn't load'", async () => {
    const { fetchMySubscriptions } = await freshApi();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [] }));
    await expect(fetchMySubscriptions()).resolves.toEqual({ ok: true, subscriptions: [] });

    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const failed = await fetchMySubscriptions();
    expect(failed.ok).toBe(false);
  });

  it("reports an unreachable billing service as a failure that names what failed", async () => {
    const { fetchMySubscriptions } = await freshApi();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(fetchMySubscriptions()).resolves.toEqual({
      ok: false,
      error: "Couldn't reach the billing service to load your subscriptions.",
    });
  });

  it("passes the proxy's own message through on an error status", async () => {
    const { fetchMySubscriptions } = await freshApi();
    fetchMock.mockResolvedValue(
      jsonResponse(401, { error: "Sign in with Discord to view your subscriptions." }),
    );
    await expect(fetchMySubscriptions()).resolves.toEqual({
      ok: false,
      error: "Sign in with Discord to view your subscriptions.",
    });
  });

  it("falls back to the status when an error carries no message", async () => {
    const { fetchMySubscriptions } = await freshApi();
    fetchMock.mockResolvedValue(new Response("<html>Bad gateway</html>", { status: 502 }));
    await expect(fetchMySubscriptions()).resolves.toEqual({
      ok: false,
      error: "Couldn't load your subscriptions (502).",
    });
  });

  it("treats a 200 that isn't the list as a failed load, not as no subscriptions", async () => {
    const { fetchMySubscriptions } = await freshApi();
    fetchMock.mockResolvedValueOnce(new Response("<html>Sign in to Wi-Fi</html>", { status: 200 }));
    const portal = await fetchMySubscriptions();
    expect(portal.ok).toBe(false);

    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    const empty = await fetchMySubscriptions();
    expect(empty.ok).toBe(false);
  });
});

describe("getStripe", () => {
  beforeEach(() => {
    loadStripeMock.mockReset();
  });

  it("resolves null instead of rejecting when Stripe.js can't load, and retries next time", async () => {
    const { getStripe } = await freshApi();
    const stripe = { id: "stripe-instance" };
    loadStripeMock
      .mockRejectedValueOnce(new Error("Failed to load Stripe.js"))
      .mockResolvedValueOnce(stripe);

    // Never a rejection: the embedded-checkout provider chains `.then` on this
    // promise with no `catch`, so one would surface as an unhandled rejection.
    await expect(getStripe()).resolves.toBeNull();
    // The failure isn't cached — the next Upgrade click tries the script again.
    await expect(getStripe()).resolves.toBe(stripe);
    expect(loadStripeMock).toHaveBeenCalledTimes(2);
  });

  it("loads Stripe.js once and hands every caller the same promise", async () => {
    const { getStripe } = await freshApi();
    loadStripeMock.mockResolvedValue({ id: "stripe-instance" });
    const first = getStripe();
    expect(getStripe()).toBe(first);
    await first;
    expect(getStripe()).toBe(first);
    expect(loadStripeMock).toHaveBeenCalledTimes(1);
    expect(loadStripeMock).toHaveBeenCalledWith("pk_test_dweeb");
  });
});
