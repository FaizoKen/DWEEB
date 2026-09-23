import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the mock factory below can reference it (vi.mock is hoisted above
// module-level consts).
const { fetchGuildPlanMock } = vi.hoisted(() => ({ fetchGuildPlanMock: vi.fn() }));

vi.mock("@/core/guild/api", () => ({
  fetchGuildPlan: fetchGuildPlanMock,
  isAuthError: (e: unknown) => e instanceof Error && (e as { status?: number }).status === 401,
}));
vi.mock("@/core/guild/config", () => ({
  isProxyConfigured: () => true,
}));

import { usePlanStore } from "./planStore";
import type { PlanInfo } from "@/core/guild/api";

const PLAN: PlanInfo = {
  tier: "plus",
  limits: { schedules: 30, permanent: 25, custom_bots: 2, coeditors: 6 },
  billing: true,
};

const G1 = "111111111111111111";
const G2 = "222222222222222222";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("planStore", () => {
  beforeEach(() => {
    usePlanStore.setState({ guildId: null, plan: null, status: "idle", error: null, open: false });
    fetchGuildPlanMock.mockReset();
  });

  it("load(guild) populates that server's plan and marks ready", async () => {
    fetchGuildPlanMock.mockResolvedValue(PLAN);
    await usePlanStore.getState().load(G1);
    expect(fetchGuildPlanMock).toHaveBeenCalledWith(G1);
    expect(usePlanStore.getState().plan).toEqual(PLAN);
    expect(usePlanStore.getState().guildId).toBe(G1);
    expect(usePlanStore.getState().status).toBe("ready");
  });

  it("load() is idempotent for the same server, and force re-reads", async () => {
    fetchGuildPlanMock.mockResolvedValue(PLAN);
    await usePlanStore.getState().load(G1);
    await usePlanStore.getState().load(G1); // warm, same server → skips the network
    expect(fetchGuildPlanMock).toHaveBeenCalledTimes(1);
    await usePlanStore.getState().load(G1, true); // force → re-reads
    expect(fetchGuildPlanMock).toHaveBeenCalledTimes(2);
  });

  it("load() reloads when the server changes", async () => {
    fetchGuildPlanMock.mockResolvedValue(PLAN);
    await usePlanStore.getState().load(G1);
    await usePlanStore.getState().load(G2); // different server → re-reads
    expect(fetchGuildPlanMock).toHaveBeenCalledTimes(2);
    expect(fetchGuildPlanMock).toHaveBeenLastCalledWith(G2);
    expect(usePlanStore.getState().guildId).toBe(G2);
  });

  it("an empty guild id is a no-op", async () => {
    await usePlanStore.getState().load("");
    expect(fetchGuildPlanMock).not.toHaveBeenCalled();
  });

  it("a null response (signed out / not a member) leaves plan null but ready", async () => {
    fetchGuildPlanMock.mockResolvedValue(null);
    await usePlanStore.getState().load(G1);
    expect(usePlanStore.getState().plan).toBeNull();
    expect(usePlanStore.getState().status).toBe("ready");
  });

  it("a soft error marks status error without wedging", async () => {
    fetchGuildPlanMock.mockRejectedValue(new Error("network"));
    await usePlanStore.getState().load(G1);
    expect(usePlanStore.getState().status).toBe("error");
  });

  it("a failed load keeps the API client's reason for the pricing modal to show", async () => {
    fetchGuildPlanMock.mockRejectedValue(
      new Error("Couldn't reach the server. Check your connection."),
    );
    await usePlanStore.getState().load(G1);
    expect(usePlanStore.getState()).toMatchObject({
      status: "error",
      plan: null,
      error: "Couldn't reach the server. Check your connection.",
    });
  });

  it("a rejection without words of its own gets a plain reason, never a blank", async () => {
    fetchGuildPlanMock.mockRejectedValue("boom");
    await usePlanStore.getState().load(G1);
    expect(usePlanStore.getState().error).toBe("Try again in a moment.");
  });

  it("a retry after a failure re-reads, clears the reason while loading, and recovers", async () => {
    fetchGuildPlanMock.mockRejectedValueOnce(new Error("Rate limited — try again in a moment."));
    await usePlanStore.getState().load(G1);
    expect(usePlanStore.getState().status).toBe("error");

    const retry = deferred<PlanInfo>();
    fetchGuildPlanMock.mockReturnValueOnce(retry.promise);
    // An errored load is not "warm": even an unforced load for the same server
    // goes back to the network.
    const pending = usePlanStore.getState().load(G1);
    expect(usePlanStore.getState()).toMatchObject({ status: "loading", error: null });
    retry.resolve(PLAN);
    await pending;
    expect(usePlanStore.getState()).toMatchObject({ status: "ready", error: null, plan: PLAN });
    expect(fetchGuildPlanMock).toHaveBeenCalledTimes(2);
  });

  it("a signed-out (401) read settles as ready with no plan and no error", async () => {
    const unauthorized = Object.assign(new Error("Sign in with Discord to load server data."), {
      status: 401,
    });
    fetchGuildPlanMock.mockRejectedValue(unauthorized);
    await usePlanStore.getState().load(G1);
    expect(usePlanStore.getState()).toMatchObject({ status: "ready", plan: null, error: null });
  });

  it("openPricing(guild) opens the modal and kicks off a load", async () => {
    fetchGuildPlanMock.mockResolvedValue(PLAN);
    usePlanStore.getState().openPricing(G1);
    expect(usePlanStore.getState().open).toBe(true);
    // fetchGuildPlan is invoked synchronously inside load(), before its first await.
    expect(fetchGuildPlanMock).toHaveBeenCalledWith(G1);
    await Promise.resolve();
  });

  it("reset() clears cached state", () => {
    usePlanStore.setState({ guildId: G1, plan: PLAN, status: "error", error: "x", open: true });
    usePlanStore.getState().reset();
    expect(usePlanStore.getState()).toMatchObject({
      guildId: null,
      plan: null,
      status: "idle",
      error: null,
      open: false,
    });
  });

  it("does not accept a previous account's delayed result for the same server", async () => {
    const previous = deferred<PlanInfo>();
    const current: PlanInfo = {
      ...PLAN,
      tier: "pro",
      limits: { ...PLAN.limits, schedules: 100 },
    };
    fetchGuildPlanMock.mockReturnValueOnce(previous.promise).mockResolvedValueOnce(current);

    const staleLoad = usePlanStore.getState().load(G1);
    usePlanStore.getState().reset();
    await usePlanStore.getState().load(G1);
    previous.resolve(PLAN);
    await staleLoad;

    expect(usePlanStore.getState().plan).toEqual(current);
  });
});
