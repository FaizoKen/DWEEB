import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  accountResetMock,
  disconnectMock,
  fetchMeMock,
  fetchUserGuildsMock,
  guildState,
  planResetMock,
  postLogoutMock,
  pushToastMock,
  startLoginPopupMock,
} = vi.hoisted(() => ({
  accountResetMock: vi.fn(),
  disconnectMock: vi.fn(),
  fetchMeMock: vi.fn(),
  fetchUserGuildsMock: vi.fn(),
  guildState: { guildId: "" },
  planResetMock: vi.fn(),
  postLogoutMock: vi.fn(),
  pushToastMock: vi.fn(),
  startLoginPopupMock: vi.fn(),
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
vi.mock("@/core/oauth/flows", () => ({ startLoginPopup: startLoginPopupMock }));
vi.mock("@/core/guild/guildStore", () => ({
  useGuildStore: {
    getState: () => ({ disconnect: disconnectMock, guildId: guildState.guildId }),
  },
}));
vi.mock("@/core/plan/planStore", () => ({
  usePlanStore: { getState: () => ({ reset: planResetMock }) },
}));
vi.mock("@/ui/Toast", () => ({ pushToast: pushToastMock }));

type AuthStore = typeof import("./authStore").useAuthStore;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The error shape the proxy client throws: a message plus the HTTP status (0 = no answer). */
function failure(status: number) {
  return Object.assign(new Error(`status ${status}`), { status });
}

const USER = { id: "1", name: "Ada", avatar_url: null };
const HINT_KEY = "dweeb.auth.hadSession.v1";
const UNREACHABLE_TOAST = "Couldn’t reach DWEEB to check your sign-in — retrying…";

// Node has no storage or DOM: a Map-backed localStorage for the session hint,
// and bare event targets for the online / visibility listeners.
const storage = new Map<string, string>();
const globals = globalThis as {
  localStorage?: Storage;
  window?: EventTarget;
  document?: EventTarget & { visibilityState: string };
};

let useAuthStore: AuthStore;

beforeEach(async () => {
  for (const mock of [
    accountResetMock,
    disconnectMock,
    fetchMeMock,
    fetchUserGuildsMock,
    planResetMock,
    postLogoutMock,
    pushToastMock,
    startLoginPopupMock,
  ]) {
    mock.mockReset();
  }
  fetchUserGuildsMock.mockResolvedValue([]);
  guildState.guildId = "";
  storage.clear();
  globals.localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
    removeItem: (k: string) => void storage.delete(k),
  } as unknown as Storage;
  globals.window = new EventTarget();
  globals.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  // A fresh module per test: `init` runs once per page, and the retry state is
  // module-level on purpose.
  vi.resetModules();
  ({ useAuthStore } = await import("./authStore"));
});

afterEach(() => {
  vi.useRealTimers();
  delete globals.localStorage;
  delete globals.window;
  delete globals.document;
});

describe("authStore account cleanup", () => {
  beforeEach(() => {
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

describe("authStore session checks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("clears everything on a 401, exactly as before, and forgets the session hint", async () => {
    storage.set(HINT_KEY, "1");
    guildState.guildId = "guild-1";
    fetchMeMock.mockResolvedValue(null);

    await useAuthStore.getState().init();

    expect(useAuthStore.getState().status).toBe("anon");
    expect(disconnectMock).toHaveBeenCalledOnce();
    expect(planResetMock).toHaveBeenCalledOnce();
    expect(accountResetMock).toHaveBeenCalledOnce();
    expect(storage.has(HINT_KEY)).toBe(false);
    expect(pushToastMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats a 403 as an answer too", async () => {
    storage.set(HINT_KEY, "1");
    fetchMeMock.mockRejectedValue(failure(403));

    await useAuthStore.getState().init();

    expect(useAuthStore.getState().status).toBe("anon");
    expect(accountResetMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles a first load it can't check on a usable signed-out state, clearing nothing", async () => {
    fetchMeMock.mockRejectedValue(failure(0));

    await useAuthStore.getState().init();

    expect(useAuthStore.getState().status).toBe("anon");
    expect(disconnectMock).not.toHaveBeenCalled();
    expect(accountResetMock).not.toHaveBeenCalled();
    // No sign of an earlier session, so nothing to recover and nothing to say.
    expect(pushToastMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers a returning user's session after a blip: one notice, retries on a backoff", async () => {
    storage.set(HINT_KEY, "1");
    guildState.guildId = "guild-1";
    fetchMeMock
      .mockRejectedValueOnce(failure(502))
      .mockRejectedValueOnce(failure(0))
      .mockResolvedValue(USER);

    await useAuthStore.getState().init();
    expect(useAuthStore.getState().status).toBe("anon");
    expect(disconnectMock).not.toHaveBeenCalled();
    expect(pushToastMock).toHaveBeenCalledOnce();
    expect(pushToastMock).toHaveBeenCalledWith(UNREACHABLE_TOAST, "info");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMeMock).toHaveBeenCalledTimes(2);
    expect(useAuthStore.getState().status).toBe("anon");
    expect(pushToastMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchMeMock).toHaveBeenCalledTimes(3);
    expect(useAuthStore.getState().status).toBe("authed");
    expect(useAuthStore.getState().user).toEqual(USER);
    expect(fetchUserGuildsMock).toHaveBeenCalledOnce();
    expect(storage.get(HINT_KEY)).toBe("1");
    expect(accountResetMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a signed-in user signed in when a check can't get through", async () => {
    useAuthStore.setState({ status: "authed", user: USER });
    fetchMeMock.mockRejectedValue(failure(503));

    await useAuthStore.getState().completeLogin(true);

    expect(useAuthStore.getState().status).toBe("authed");
    expect(useAuthStore.getState().user).toEqual(USER);
    expect(disconnectMock).not.toHaveBeenCalled();
    expect(accountResetMock).not.toHaveBeenCalled();
    expect(pushToastMock).toHaveBeenCalledWith(UNREACHABLE_TOAST, "info");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("re-checks at once when the browser comes back online", async () => {
    storage.set(HINT_KEY, "1");
    fetchMeMock.mockRejectedValueOnce(failure(0)).mockResolvedValue(USER);

    await useAuthStore.getState().init();
    expect(useAuthStore.getState().status).toBe("anon");

    globals.window?.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);

    expect(useAuthStore.getState().status).toBe("authed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops asking after the timed retries, but still re-checks when the tab comes back", async () => {
    storage.set(HINT_KEY, "1");
    fetchMeMock.mockRejectedValue(failure(0));

    await useAuthStore.getState().init();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const calls = fetchMeMock.mock.calls.length;
    expect(calls).toBe(1 + 6);
    expect(vi.getTimerCount()).toBe(0);
    expect(pushToastMock).toHaveBeenCalledOnce();

    fetchMeMock.mockResolvedValue(USER);
    globals.document?.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(useAuthStore.getState().status).toBe("authed");
  });

  it("takes a 401 from anywhere else as the answer a pending retry was waiting for", async () => {
    storage.set(HINT_KEY, "1");
    fetchMeMock.mockRejectedValue(failure(0));

    await useAuthStore.getState().init();
    useAuthStore.getState().markSignedOut();

    expect(accountResetMock).toHaveBeenCalledOnce();
    expect(pushToastMock).toHaveBeenLastCalledWith("Your session expired — sign in again.", "info");
    expect(storage.has(HINT_KEY)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still greets a sign-in whose first check hit a blip, once it gets through", async () => {
    useAuthStore.setState({ status: "anon" });
    fetchMeMock.mockRejectedValueOnce(failure(0)).mockResolvedValue(USER);

    await useAuthStore.getState().completeLogin(true);
    expect(useAuthStore.getState().status).toBe("anon");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(useAuthStore.getState().status).toBe("authed");
    expect(pushToastMock).toHaveBeenLastCalledWith("Signed in as Ada", "success");
  });

  it("works when storage is blocked: the hint reads as no earlier session", async () => {
    globals.localStorage = {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      removeItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    } as unknown as Storage;
    fetchMeMock.mockRejectedValueOnce(failure(0)).mockResolvedValue(USER);

    await useAuthStore.getState().init();
    expect(useAuthStore.getState().status).toBe("anon");
    expect(vi.getTimerCount()).toBe(0);

    await useAuthStore.getState().completeLogin(true);
    expect(useAuthStore.getState().status).toBe("authed");
  });
});

describe("authStore requestLogin", () => {
  it("asks with a button rather than opening the popup without a click", () => {
    useAuthStore.getState().requestLogin("Sign in with Discord to see this server’s plans.");

    expect(startLoginPopupMock).not.toHaveBeenCalled();
    expect(pushToastMock).toHaveBeenCalledOnce();
    const [message, tone, options] = pushToastMock.mock.calls[0] as [
      string,
      string,
      { action: { label: string; onClick: () => void }; durationMs: number },
    ];
    expect(message).toBe("Sign in with Discord to see this server’s plans.");
    expect(tone).toBe("info");
    expect(options.action.label).toBe("Sign in");

    options.action.onClick();
    expect(startLoginPopupMock).toHaveBeenCalledOnce();
  });
});
