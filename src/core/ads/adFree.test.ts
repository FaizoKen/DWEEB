import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchGuildPlan = vi.fn();
class GuildApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
vi.mock("@/core/guild/api", () => ({
  fetchGuildPlan: (id: string) => fetchGuildPlan(id),
  isAuthError: () => false,
  GuildApiError,
}));
vi.mock("@/core/guild/config", () => ({ isProxyConfigured: () => true }));

const { isAdFreeDestination, forgetAdFreeDestinations } = await import("./adFree");
const { usePlanStore } = await import("@/core/plan/planStore");

const LIMITS = { schedules: 3, permanent: 5, custom_bots: 1, coeditors: 2, library: 10 };

beforeEach(() => {
  fetchGuildPlan.mockReset();
  forgetAdFreeDestinations();
  usePlanStore.setState({ guildId: null, plan: null, status: "idle" });
});

afterEach(() => {
  forgetAdFreeDestinations();
});

describe("isAdFreeDestination", () => {
  it("shows ads when the send's server is unknown", async () => {
    expect(await isAdFreeDestination(undefined)).toBe(false);
    expect(await isAdFreeDestination("  ")).toBe(false);
    expect(fetchGuildPlan).not.toHaveBeenCalled();
  });

  it("reads the connected server's tier without a request", async () => {
    usePlanStore.setState({
      guildId: "111111111111111111",
      plan: { tier: "plus", limits: LIMITS, billing: true },
      status: "ready",
    });
    expect(await isAdFreeDestination("111111111111111111")).toBe(true);
    usePlanStore.setState({ plan: { tier: "free", limits: LIMITS, billing: true } });
    expect(await isAdFreeDestination("111111111111111111")).toBe(false);
    expect(fetchGuildPlan).not.toHaveBeenCalled();
  });

  it("asks once about any other server and remembers the answer", async () => {
    fetchGuildPlan.mockResolvedValue({ tier: "pro", limits: LIMITS, billing: true });
    expect(await isAdFreeDestination("222222222222222222")).toBe(true);
    expect(await isAdFreeDestination("222222222222222222")).toBe(true);
    expect(fetchGuildPlan).toHaveBeenCalledTimes(1);
  });

  it("shows ads when signed out, without remembering that", async () => {
    fetchGuildPlan.mockResolvedValue(null);
    expect(await isAdFreeDestination("333333333333333333")).toBe(false);
    expect(await isAdFreeDestination("333333333333333333")).toBe(false);
    expect(fetchGuildPlan).toHaveBeenCalledTimes(2);
  });

  it("fails toward no ad: a paying server must never see one over a failed lookup", async () => {
    fetchGuildPlan.mockRejectedValue(new Error("Couldn't reach the server"));
    expect(await isAdFreeDestination("444444444444444444")).toBe(true);
    fetchGuildPlan.mockRejectedValue(new GuildApiError("Busy", 503));
    expect(await isAdFreeDestination("444444444444444444")).toBe(true);
    fetchGuildPlan.mockRejectedValue(new GuildApiError("Slow down", 429));
    expect(await isAdFreeDestination("444444444444444444")).toBe(true);
  });

  it("treats a server whose plan this person can't read like signed out", async () => {
    fetchGuildPlan.mockRejectedValue(
      new GuildApiError("You can only load servers you manage", 403),
    );
    expect(await isAdFreeDestination("555555555555555555")).toBe(false);
    fetchGuildPlan.mockRejectedValue(new GuildApiError("Unknown server", 404));
    expect(await isAdFreeDestination("555555555555555555")).toBe(false);
  });
});
