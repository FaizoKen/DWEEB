import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchChannelThreadsMock } = vi.hoisted(() => ({ fetchChannelThreadsMock: vi.fn() }));

vi.mock("@/core/guild/api", () => ({
  fetchChannelThreads: fetchChannelThreadsMock,
  isAuthError: (e: unknown) => e instanceof Error && (e as { status?: number }).status === 401,
}));

import { threadsKey, useChannelThreadsStore } from "./channelThreads";
import { resetAccountScopedState } from "@/core/auth/accountScopedState";
import type { ChannelThreads } from "@/core/guild/api";

const G = "111111111111111111";
const C = "222222222222222222";
const KEY = threadsKey(G, C);

const LIST: ChannelThreads = {
  threads: [
    {
      id: "333333333333333333",
      name: "Ideas",
      type: 11,
      archived: false,
      locked: false,
      pinned: false,
    },
  ],
  more_archived: false,
  archived_listed: true,
  channel_type: 15,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function apiError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe("channelThreads store", () => {
  beforeEach(() => {
    useChannelThreadsStore.getState().reset();
    fetchChannelThreadsMock.mockReset();
  });

  it("loads a channel's threads and its type", async () => {
    fetchChannelThreadsMock.mockResolvedValue(LIST);
    await useChannelThreadsStore.getState().load(G, C);
    const entry = useChannelThreadsStore.getState().entries[KEY];
    expect(entry?.status).toBe("ready");
    expect(entry?.threads.map((t) => t.name)).toEqual(["Ideas"]);
    expect(entry?.channelType).toBe(15);
  });

  it("shares one request between concurrent loads and serves the cache after", async () => {
    const pending = deferred<ChannelThreads>();
    fetchChannelThreadsMock.mockReturnValue(pending.promise);
    const a = useChannelThreadsStore.getState().load(G, C);
    const b = useChannelThreadsStore.getState().load(G, C);
    pending.resolve(LIST);
    await Promise.all([a, b]);
    await useChannelThreadsStore.getState().load(G, C);
    expect(fetchChannelThreadsMock).toHaveBeenCalledTimes(1);
  });

  it("a forced refresh asks the proxy to skip its cache", async () => {
    fetchChannelThreadsMock.mockResolvedValue(LIST);
    await useChannelThreadsStore.getState().load(G, C);
    await useChannelThreadsStore.getState().load(G, C, { force: true });
    expect(fetchChannelThreadsMock).toHaveBeenCalledTimes(2);
    expect(fetchChannelThreadsMock.mock.calls[1]?.[2]).toMatchObject({ force: true });
  });

  it("parks a 403 at denied, anything else at error", async () => {
    fetchChannelThreadsMock.mockRejectedValueOnce(apiError(403, "Needs Manage Webhooks"));
    await useChannelThreadsStore.getState().load(G, C);
    expect(useChannelThreadsStore.getState().entries[KEY]?.status).toBe("denied");

    fetchChannelThreadsMock.mockRejectedValueOnce(apiError(502, "Discord busy"));
    await useChannelThreadsStore.getState().load(G, C, { force: true });
    const entry = useChannelThreadsStore.getState().entries[KEY];
    expect(entry?.status).toBe("error");
    expect(entry?.error).toBe("Discord busy");
  });

  it("drops an answer that lands after sign-out", async () => {
    const pending = deferred<ChannelThreads>();
    fetchChannelThreadsMock.mockReturnValue(pending.promise);
    const load = useChannelThreadsStore.getState().load(G, C);
    resetAccountScopedState();
    pending.resolve(LIST);
    await load;
    expect(useChannelThreadsStore.getState().entries).toEqual({});
  });
});
