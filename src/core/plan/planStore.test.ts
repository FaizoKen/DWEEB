import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the mock factory below can reference it (vi.mock is hoisted above
// module-level consts).
const { fetchPlanMock } = vi.hoisted(() => ({ fetchPlanMock: vi.fn() }));

vi.mock("@/core/guild/api", () => ({
  fetchPlan: fetchPlanMock,
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

describe("planStore", () => {
  beforeEach(() => {
    usePlanStore.setState({ plan: null, status: "idle", open: false });
    fetchPlanMock.mockReset();
  });

  it("load() populates the plan and marks ready", async () => {
    fetchPlanMock.mockResolvedValue(PLAN);
    await usePlanStore.getState().load();
    expect(fetchPlanMock).toHaveBeenCalledTimes(1);
    expect(usePlanStore.getState().plan).toEqual(PLAN);
    expect(usePlanStore.getState().status).toBe("ready");
  });

  it("load() is idempotent once ready, and force re-reads", async () => {
    fetchPlanMock.mockResolvedValue(PLAN);
    await usePlanStore.getState().load();
    await usePlanStore.getState().load(); // warm → skips the network
    expect(fetchPlanMock).toHaveBeenCalledTimes(1);
    await usePlanStore.getState().load(true); // force → re-reads
    expect(fetchPlanMock).toHaveBeenCalledTimes(2);
  });

  it("a null response (signed out) leaves plan null but ready (no spin)", async () => {
    fetchPlanMock.mockResolvedValue(null);
    await usePlanStore.getState().load();
    expect(usePlanStore.getState().plan).toBeNull();
    expect(usePlanStore.getState().status).toBe("ready");
  });

  it("a soft error marks status error without wedging", async () => {
    fetchPlanMock.mockRejectedValue(new Error("network"));
    await usePlanStore.getState().load();
    expect(usePlanStore.getState().status).toBe("error");
  });

  it("openPricing() opens the modal and kicks off a load", async () => {
    fetchPlanMock.mockResolvedValue(PLAN);
    usePlanStore.getState().openPricing();
    expect(usePlanStore.getState().open).toBe(true);
    // fetchPlan is invoked synchronously inside load(), before its first await.
    expect(fetchPlanMock).toHaveBeenCalled();
    await Promise.resolve();
  });

  it("reset() clears cached state", () => {
    usePlanStore.setState({ plan: PLAN, status: "ready", open: true });
    usePlanStore.getState().reset();
    expect(usePlanStore.getState()).toMatchObject({ plan: null, status: "idle", open: false });
  });
});
