import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyConfigured: true,
  proxyBase: "https://api.example.test",
  proxyFetch: vi.fn(),
}));

vi.mock("@/core/guild/config", () => ({
  isProxyConfigured: () => mocks.proxyConfigured,
  get PROXY_BASE_URL() {
    return mocks.proxyBase;
  },
}));
vi.mock("@/core/net/proxyFetch", () => ({
  proxyFetch: mocks.proxyFetch,
}));

beforeEach(() => {
  vi.resetModules();
  mocks.proxyConfigured = true;
  mocks.proxyBase = "https://api.example.test";
  mocks.proxyFetch.mockReset();
});

function capabilities(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("MCP runtime availability", () => {
  it("stays hidden until the proxy confirms it serves the endpoint", async () => {
    mocks.proxyFetch.mockResolvedValue(capabilities({ mcp: true }));
    const availability = await import("./availability");

    expect(availability.isMcpConfigured()).toBe(false);
    await expect(availability.ensureMcpAvailability()).resolves.toBe(true);
    expect(availability.isMcpConfigured()).toBe(true);
    expect(mocks.proxyFetch).toHaveBeenCalledOnce();
    expect(mocks.proxyFetch).toHaveBeenCalledWith("/api/capabilities");
  });

  // The endpoint is off by default, so this is the common case — and the one
  // that matters: offering a connector URL that answers 501 sends someone
  // through a setup that cannot work and looks like their mistake.
  it("stays hidden on a deployment that has the endpoint switched off", async () => {
    mocks.proxyFetch.mockResolvedValue(capabilities({ mcp: false }));
    const availability = await import("./availability");

    await expect(availability.ensureMcpAvailability()).resolves.toBe(false);
    expect(availability.isMcpConfigured()).toBe(false);
  });

  it("stays hidden against a proxy too old to report the capability", async () => {
    mocks.proxyFetch.mockResolvedValue(capabilities({ feedback: true }));
    const availability = await import("./availability");

    await expect(availability.ensureMcpAvailability()).resolves.toBe(false);
  });

  it("does not probe when this build has no proxy", async () => {
    mocks.proxyConfigured = false;
    const availability = await import("./availability");

    await expect(availability.ensureMcpAvailability()).resolves.toBe(false);
    expect(mocks.proxyFetch).not.toHaveBeenCalled();
  });

  it("treats an unreachable proxy as unavailable rather than throwing", async () => {
    mocks.proxyFetch.mockRejectedValue(new Error("offline"));
    const availability = await import("./availability");

    await expect(availability.ensureMcpAvailability()).resolves.toBe(false);
    expect(availability.isMcpConfigured()).toBe(false);
  });

  it("shares one probe across every mounted entry point", async () => {
    mocks.proxyFetch.mockResolvedValue(capabilities({ mcp: true }));
    const availability = await import("./availability");

    const [a, b] = await Promise.all([
      availability.ensureMcpAvailability(),
      availability.ensureMcpAvailability(),
    ]);
    expect([a, b]).toEqual([true, true]);
    expect(mocks.proxyFetch).toHaveBeenCalledOnce();
  });
});

describe("mcpEndpointUrl", () => {
  // Derived, never hard-coded: a self-hosted build must hand out its own
  // address rather than this project's.
  it("is the configured proxy's own /mcp", async () => {
    mocks.proxyBase = "https://api.selfhosted.example";
    const availability = await import("./availability");
    expect(availability.mcpEndpointUrl()).toBe("https://api.selfhosted.example/mcp");
  });

  it("is empty when this build has no proxy at all", async () => {
    mocks.proxyBase = "";
    const availability = await import("./availability");
    expect(availability.mcpEndpointUrl()).toBe("");
  });
});
