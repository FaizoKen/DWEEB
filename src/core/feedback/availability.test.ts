import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyConfigured: true,
  proxyFetch: vi.fn(),
}));

vi.mock("@/core/guild/config", () => ({
  isProxyConfigured: () => mocks.proxyConfigured,
}));
vi.mock("@/core/net/proxyFetch", () => ({
  proxyFetch: mocks.proxyFetch,
}));

beforeEach(() => {
  vi.resetModules();
  mocks.proxyConfigured = true;
  mocks.proxyFetch.mockReset();
});

describe("feedback runtime availability", () => {
  it("stays hidden until the proxy confirms the relay is enabled", async () => {
    mocks.proxyFetch.mockResolvedValue(
      new Response(JSON.stringify({ feedback: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const availability = await import("./availability");

    expect(availability.isFeedbackConfigured()).toBe(false);
    await expect(availability.ensureFeedbackAvailability()).resolves.toBe(true);
    expect(availability.isFeedbackConfigured()).toBe(true);
    expect(mocks.proxyFetch).toHaveBeenCalledOnce();
    expect(mocks.proxyFetch).toHaveBeenCalledWith("/api/capabilities");
  });

  it("remains hidden when the deployment has no feedback destination", async () => {
    mocks.proxyFetch.mockResolvedValue(
      new Response(JSON.stringify({ feedback: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const availability = await import("./availability");

    await expect(availability.ensureFeedbackAvailability()).resolves.toBe(false);
    expect(availability.isFeedbackConfigured()).toBe(false);
  });

  it("does not probe when this build has no proxy", async () => {
    mocks.proxyConfigured = false;
    const availability = await import("./availability");

    await expect(availability.ensureFeedbackAvailability()).resolves.toBe(false);
    expect(mocks.proxyFetch).not.toHaveBeenCalled();
  });
});
