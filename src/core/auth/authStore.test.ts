import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  accountResetMock,
  disconnectMock,
  fetchMeMock,
  fetchUserGuildsMock,
  planResetMock,
  postLogoutMock,
  pushToastMock,
} = vi.hoisted(() => ({
  accountResetMock: vi.fn(),
  disconnectMock: vi.fn(),
  fetchMeMock: vi.fn(),
  fetchUserGuildsMock: vi.fn(),
  planResetMock: vi.fn(),
  postLogoutMock: vi.fn(),
  pushToastMock: vi.fn(),
}));

vi.mock("@/core/auth/accountScopedState", () => ({
  resetAccountScopedState: accountResetMock,
}));
vi.mock("@/core/guild/api", () => ({
  fetchMe: fetchMeMock,
  fetchUserGuilds: fetchUserGuildsMock,
  isAuthError: (error: unknown) =>
    Boolean(error && typeof error === "object" && "status" in error && error.status === 401),
  postLogout: postLogoutMock,
}));
vi.mock("@/core/guild/config", () => ({ isProxyConfigured: () => true }));
vi.mock("@/core/oauth/flows", () => ({ startLoginPopup: vi.fn() }));
vi.mock("@/core/guild/guildStore", () => ({
  useGuildStore: { getState: () => ({ disconnect: disconnectMock }) },
}));
vi.mock("@/core/plan/planStore", () => ({
  usePlanStore: { getState: () => ({ reset: planResetMock }) },
}));
vi.mock("@/ui/Toast", () => ({ pushToast: pushToastMock }));

import { useAuthStore } from "./authStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const USER = { id: "1", name: "Ada", avatar_url: null };

describe("authStore account cleanup", () => {
  beforeEach(() => {
    accountResetMock.mockReset();
    disconnectMock.mockReset();
    fetchMeMock.mockReset();
    fetchUserGuildsMock.mockReset();
    planResetMock.mockReset();
    postLogoutMock.mockReset();
    pushToastMock.mockReset();
    useAuthStore.setState({
      status: "authed",
      user: USER,
      guilds: [],
      guildsStatus: "idle",
      guildsError: null,
    });
  });

  it("releases local account data before the logout request settles", async () => {
    const request = deferred<void>();
    postLogoutMock.mockReturnValue(request.promise);

    const logout = useAuthStore.getState().logout();

    expect(useAuthStore.getState().status).toBe("anon");
    expect(disconnectMock).toHaveBeenCalledOnce();
    expect(planResetMock).toHaveBeenCalledOnce();
    expect(accountResetMock).toHaveBeenCalledOnce();

    request.resolve();
    await logout;
  });

  it("discards a server-list response that arrives after sign-out", async () => {
    const request = deferred<Array<{ id: string; name: string }>>();
    fetchUserGuildsMock.mockReturnValue(request.promise);
    postLogoutMock.mockResolvedValue(undefined);

    const load = useAuthStore.getState().loadGuilds();
    await useAuthStore.getState().logout();
    request.resolve([{ id: "guild-1", name: "Previous account" }]);
    await load;

    expect(useAuthStore.getState().guilds).toEqual([]);
    expect(useAuthStore.getState().guildsStatus).toBe("idle");
  });

  it("coalesces simultaneous expired-session notifications", () => {
    useAuthStore.getState().markSignedOut();
    useAuthStore.getState().markSignedOut();

    expect(accountResetMock).toHaveBeenCalledOnce();
    expect(pushToastMock).toHaveBeenCalledOnce();
  });
});
