import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { preserveCreatedScheduleAccess } from "./accessPersistence";
import { loadLocalSchedules, rememberSchedule, type LocalSchedule } from "./localStore";

const entry: LocalSchedule = {
  id: "schedule-1",
  manageToken: "one-time-secret",
  createdAt: 1_700_000_000_000,
};

beforeEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("schedule access persistence", () => {
  it("reports blocked browser storage instead of throwing", () => {
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("Storage blocked", "SecurityError");
      },
    } as unknown as Storage;

    expect(rememberSchedule(entry)).toBe(false);
    expect(loadLocalSchedules()).toEqual([]);
  });

  it("keeps a signed-in schedule account-owned when local storage fails", async () => {
    const cancel = vi.fn();

    await expect(
      preserveCreatedScheduleAccess(entry, true, { remember: () => false, cancel }),
    ).resolves.toEqual({ kind: "account-owned" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("rolls an anonymous schedule back when its one-time token cannot be stored", async () => {
    const cancel = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      preserveCreatedScheduleAccess(entry, false, { remember: () => false, cancel }),
    ).resolves.toEqual({ kind: "rolled-back" });
    expect(cancel).toHaveBeenCalledWith(entry.id, entry.manageToken);
  });

  it("returns the credential-recovery state when anonymous rollback also fails", async () => {
    const cancel = vi.fn().mockResolvedValue({
      ok: false,
      error: "Service unavailable",
      status: 503,
    });

    await expect(
      preserveCreatedScheduleAccess(entry, false, { remember: () => false, cancel }),
    ).resolves.toEqual({
      kind: "recovery-required",
      rollbackError: "Service unavailable",
    });
  });
});
