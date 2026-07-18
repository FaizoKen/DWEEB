import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchGuildEmojisMock, markSignedOutMock } = vi.hoisted(() => ({
  fetchGuildEmojisMock: vi.fn(),
  markSignedOutMock: vi.fn(),
}));

vi.mock("./api", () => ({
  fetchGuildEmojis: fetchGuildEmojisMock,
  GuildApiError: class GuildApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  },
}));

vi.mock("@/core/auth/authStore", () => ({
  useAuthStore: { getState: () => ({ markSignedOut: markSignedOutMock }) },
}));

import { useEmojiStore } from "./emojiStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("emojiStore account lifetime", () => {
  beforeEach(() => {
    fetchGuildEmojisMock.mockReset();
    markSignedOutMock.mockReset();
    useEmojiStore.getState().reset();
  });

  it("globally bounds two concurrent cross-server loads to four requests", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    fetchGuildEmojisMock.mockImplementation(
      () =>
        new Promise<never[]>((resolve) => {
          active += 1;
          peak = Math.max(peak, active);
          releases.push(() => {
            active -= 1;
            resolve([]);
          });
        }),
    );

    const guilds = Array.from({ length: 9 }, (_, index) => String(index + 1));
    const loading = Promise.all([
      useEmojiStore.getState().loadFor(guilds.slice(0, 5)),
      useEmojiStore.getState().loadFor(guilds.slice(5)),
    ]);

    await vi.waitFor(() => expect(fetchGuildEmojisMock).toHaveBeenCalledTimes(4));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(fetchGuildEmojisMock).toHaveBeenCalledTimes(8));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(fetchGuildEmojisMock).toHaveBeenCalledTimes(9));
    releases.splice(0).forEach((release) => release());
    await loading;

    expect(peak).toBe(4);
    expect(Object.keys(useEmojiStore.getState().byGuild)).toHaveLength(9);
    expect(useEmojiStore.getState().status).toBe("ready");
  });

  it("does not restore a delayed previous-account response after reset", async () => {
    const request =
      deferred<Array<{ id: string; name: string; animated?: boolean; available?: boolean }>>();
    fetchGuildEmojisMock.mockReturnValue(request.promise);

    const loading = useEmojiStore.getState().loadFor(["123"]);
    await vi.waitFor(() => expect(fetchGuildEmojisMock).toHaveBeenCalledOnce());
    useEmojiStore.getState().reset();
    request.resolve([{ id: "emoji-1", name: "wave" }]);
    await loading;

    expect(useEmojiStore.getState().byGuild).toEqual({});
    expect(useEmojiStore.getState().status).toBe("idle");
  });
});
