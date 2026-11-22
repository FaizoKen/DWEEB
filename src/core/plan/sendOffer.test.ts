import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ ads: false, checkout: true, activity: false }));
const fetchGuildPlan = vi.fn();

vi.mock("@/core/ads/config", () => ({ adsConfigured: () => env.ads }));
vi.mock("./stripeConfig", () => ({ isCheckoutConfigured: () => env.checkout }));
vi.mock("@/core/activity/runtime", () => ({ isActivityMode: () => env.activity }));
vi.mock("@/core/guild/api", () => ({
  fetchGuildPlan: (id: string) => fetchGuildPlan(id),
  isAuthError: () => false,
}));
vi.mock("@/core/guild/config", () => ({ isProxyConfigured: () => true }));

const offer = await import("./sendOffer");
const { usePlanStore } = await import("./planStore");

const NOW = 1_800_000_000_000;
const GUILD = "111111111111111111";
const KEY = "dweeb.offer.receipt.v1";
const LIMITS = { schedules: 3, permanent: 5, custom_bots: 1, coeditors: 2, library: 10 };

let data: Map<string, string>;

beforeEach(() => {
  Object.assign(env, { ads: false, checkout: true, activity: false });
  fetchGuildPlan.mockReset();
  usePlanStore.setState({ guildId: null, plan: null, status: "idle" });
  data = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  });
  vi.stubGlobal("window", { innerHeight: 900 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendOfferAvailable", () => {
  it("needs checkout, and gives way to a configured ad", () => {
    expect(offer.sendOfferAvailable()).toBe(true);
    env.ads = true;
    expect(offer.sendOfferAvailable()).toBe(false);
    Object.assign(env, { ads: false, checkout: false });
    expect(offer.sendOfferAvailable()).toBe(false);
  });
});

describe("takeSendOfferTicket", () => {
  it("keeps the first send clean, then allows the second", () => {
    expect(offer.takeSendOfferTicket(true, NOW)).toBe(false);
    expect(offer.takeSendOfferTicket(true, NOW)).toBe(true);
    expect(offer.readOfferRecord()?.sends).toBe(2);
  });

  it("shows at most once a day", () => {
    data.set(KEY, JSON.stringify({ sends: 4 }));
    offer.recordOfferShown(NOW);
    expect(offer.takeSendOfferTicket(true, NOW + offer.OFFER_COOLDOWN_MS - 1)).toBe(false);
    expect(offer.takeSendOfferTicket(true, NOW + offer.OFFER_COOLDOWN_MS)).toBe(true);
  });

  it("stays away for a month after a dismissal", () => {
    data.set(KEY, JSON.stringify({ sends: 4 }));
    offer.recordOfferDismissed(NOW);
    expect(offer.takeSendOfferTicket(true, NOW + offer.OFFER_SNOOZE_MS - 1)).toBe(false);
    expect(offer.takeSendOfferTicket(true, NOW + offer.OFFER_SNOOZE_MS)).toBe(true);
  });

  it("isn't silenced by a clock that moved backwards", () => {
    data.set(KEY, JSON.stringify({ sends: 4, lastShownAt: NOW + 60_000 }));
    expect(offer.takeSendOfferTicket(true, NOW)).toBe(true);
  });

  it("is never offered signed out, in the Activity, or on a short screen", () => {
    data.set(KEY, JSON.stringify({ sends: 4 }));
    expect(offer.takeSendOfferTicket(false, NOW)).toBe(false);
    env.activity = true;
    expect(offer.takeSendOfferTicket(true, NOW)).toBe(false);
    env.activity = false;
    vi.stubGlobal("window", { innerHeight: offer.OFFER_MIN_VIEWPORT_HEIGHT - 1 });
    expect(offer.takeSendOfferTicket(true, NOW)).toBe(false);
  });

  it("yields the slot to an ad without keeping a record", () => {
    env.ads = true;
    expect(offer.takeSendOfferTicket(true, NOW)).toBe(false);
    expect(data.size).toBe(0);
  });

  it("offers nothing when storage can't be read", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(offer.takeSendOfferTicket(true, NOW)).toBe(false);
  });

  it("offers nothing when a dismissal couldn't be saved", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify({ sends: 4 }),
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(offer.takeSendOfferTicket(true, NOW)).toBe(false);
  });

  it("reads anything malformed as a fresh browser", () => {
    for (const raw of ["not json", "null", "[]", '{"sends":"9","dismissedAt":"x"}']) {
      data.set(KEY, raw);
      expect(offer.readOfferRecord()).toEqual({ sends: 0, lastShownAt: null, dismissedAt: null });
    }
  });
});

describe("canOfferPlus", () => {
  it("reads the connected server's plan without a request", async () => {
    usePlanStore.setState({
      guildId: GUILD,
      plan: { tier: "free", limits: LIMITS, billing: true },
      status: "ready",
    });
    expect(await offer.canOfferPlus(GUILD)).toBe(true);
    expect(fetchGuildPlan).not.toHaveBeenCalled();
  });

  it("asks about any other server", async () => {
    fetchGuildPlan.mockResolvedValue({ tier: "free", limits: LIMITS, billing: true });
    expect(await offer.canOfferPlus(GUILD)).toBe(true);
    expect(fetchGuildPlan).toHaveBeenCalledWith(GUILD);
  });

  it("never sells to a paid server, or where it can't be bought", async () => {
    for (const plan of [
      { tier: "plus", billing: true },
      { tier: "pro", billing: true },
      { tier: "free", billing: false },
    ]) {
      fetchGuildPlan.mockResolvedValue({ ...plan, limits: LIMITS });
      expect(await offer.canOfferPlus(GUILD)).toBe(false);
    }
  });

  it("treats every doubt as no", async () => {
    expect(await offer.canOfferPlus(undefined)).toBe(false);
    fetchGuildPlan.mockResolvedValue(null);
    expect(await offer.canOfferPlus(GUILD)).toBe(false);
    fetchGuildPlan.mockRejectedValue(new Error("Couldn't reach the server"));
    expect(await offer.canOfferPlus(GUILD)).toBe(false);
  });
});

describe("plusPriceLine", () => {
  const campaign = {
    code: "X",
    percentOff: 50,
    tiers: ["plus" as const],
    duration: "first-payment" as const,
  };

  it("names the renewal beside a first-payment price, and the tax", () => {
    expect(offer.plusPriceLine(campaign)).toBe("$2.50 for the first month, then $5/mo, before tax");
  });

  it("prints a lasting discount and the list price plainly", () => {
    expect(offer.plusPriceLine({ ...campaign, duration: "forever" })).toBe("$2.50/mo before tax");
    expect(offer.plusPriceLine(null)).toBe("$5/mo before tax");
  });
});
