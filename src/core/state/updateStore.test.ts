import { afterEach, describe, expect, it, vi } from "vitest";

import { useUpdateStore } from "./updateStore";

afterEach(() => {
  useUpdateStore.setState({ available: false, applying: false, update: null });
});

describe("updateStore", () => {
  it("returns a failed service-worker update to a retryable state", async () => {
    const update = vi.fn().mockRejectedValue(new Error("offline"));
    useUpdateStore.getState().markReady(update);

    useUpdateStore.getState().apply();
    expect(useUpdateStore.getState().applying).toBe(true);

    await vi.waitFor(() => expect(useUpdateStore.getState().applying).toBe(false));
    expect(useUpdateStore.getState().available).toBe(true);
    expect(update).toHaveBeenCalledWith(true);
  });
});
