import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createLibraryEntryMock,
  deleteLibraryEntryMock,
  fetchLibraryEntriesMock,
  listLibraryMock,
  updateLibraryEntryMock,
  verifyLibraryPostedMock,
} = vi.hoisted(() => ({
  createLibraryEntryMock: vi.fn(),
  deleteLibraryEntryMock: vi.fn(),
  fetchLibraryEntriesMock: vi.fn(),
  listLibraryMock: vi.fn(),
  updateLibraryEntryMock: vi.fn(),
  verifyLibraryPostedMock: vi.fn(),
}));

vi.mock("./api", () => ({
  createLibraryEntry: createLibraryEntryMock,
  deleteLibraryEntry: deleteLibraryEntryMock,
  fetchLibraryEntries: fetchLibraryEntriesMock,
  isLibraryConfigured: () => true,
  LIBRARY_DETAIL_BATCH_SIZE: 64,
  listLibrary: listLibraryMock,
  updateLibraryEntry: updateLibraryEntryMock,
  verifyLibraryPosted: verifyLibraryPostedMock,
}));

import {
  deletedDaysLeft,
  isDeletedOnDiscord,
  libraryEntryHasDetails,
  libraryEntryOrigin,
  pendingLibraryDetailIds,
  useLibraryStore,
} from "./libraryStore";
import { deletedPostsMessage } from "./usePostedVerify";
import type { LibraryEntryResult, LibraryEntryView } from "./api";
import { ComponentType, type WebhookMessage } from "@/core/schema/types";
import { stripEditorFields } from "@/core/serialization/normalize";
import { simpleTextMessage } from "@/test/fixtures";

const GUILD_A = "111111111111111111";
const GUILD_B = "222222222222222222";

function draftEntry(
  guildId: string,
  message: WebhookMessage,
  title = "Weekly announcement",
): LibraryEntryView {
  return {
    id: "draft-1",
    guild_id: guildId,
    label: "draft",
    title,
    payload: stripEditorFields(message),
    created_by: "333333333333333333",
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
  };
}

function resetStore(guildId: string | null = GUILD_A) {
  useLibraryStore.setState({
    guildId,
    entries: [],
    posted: { used: 0, quota: 10 },
    drafts: { used: 2, quota: 10 },
    loading: false,
    error: null,
    loaded: true,
    detailError: null,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("libraryStore.saveDraft", () => {
  beforeEach(() => {
    resetStore();
    createLibraryEntryMock.mockReset();
    deleteLibraryEntryMock.mockReset();
    fetchLibraryEntriesMock.mockReset();
    listLibraryMock.mockReset();
    updateLibraryEntryMock.mockReset();
  });

  it("hydrates summary rows in one detail batch and keeps their shelf order", async () => {
    const message = simpleTextMessage();
    const full = draftEntry(GUILD_A, message);
    const summary = { ...full };
    delete summary.payload;
    const second = { ...summary, id: "draft-2", title: "Second" };
    resetStore();
    useLibraryStore.setState({ entries: [summary, second] });
    fetchLibraryEntriesMock.mockResolvedValue({ ok: true, items: [full] });

    await useLibraryStore.getState().hydrate(GUILD_A, [full.id, full.id]);

    expect(fetchLibraryEntriesMock).toHaveBeenCalledOnce();
    expect(fetchLibraryEntriesMock).toHaveBeenCalledWith(GUILD_A, [full.id]);
    const entries = useLibraryStore.getState().entries;
    expect(entries.map((entry) => entry.id)).toEqual([full.id, second.id]);
    expect(entries[0]).toEqual(full);
    expect(libraryEntryHasDetails(entries[1]!)).toBe(false);
  });

  it("limits normal detail work to the visible page but hydrates all rows for body search", () => {
    const full = draftEntry(GUILD_A, simpleTextMessage());
    const summaries = Array.from({ length: 70 }, (_, index) => {
      const entry = { ...full, id: `draft-${index}` };
      delete entry.payload;
      return entry;
    });
    // One already-hydrated card is omitted from both request plans.
    summaries[3] = { ...summaries[3]!, payload: full.payload };

    expect(pendingLibraryDetailIds(summaries, 24)).toHaveLength(23);
    expect(pendingLibraryDetailIds(summaries, null)).toHaveLength(69);
    expect(pendingLibraryDetailIds(summaries, 24)).not.toContain("draft-3");
  });

  it("shares an in-flight detail request between concurrent card loads", async () => {
    const full = draftEntry(GUILD_A, simpleTextMessage());
    const summary = { ...full };
    delete summary.payload;
    resetStore();
    useLibraryStore.setState({ entries: [summary] });
    const request = deferred<{ ok: true; items: LibraryEntryView[] }>();
    fetchLibraryEntriesMock.mockReturnValue(request.promise);

    const first = useLibraryStore.getState().hydrateOne(GUILD_A, full.id);
    const second = useLibraryStore.getState().hydrateOne(GUILD_A, full.id);
    request.resolve({ ok: true, items: [full] });

    await expect(Promise.all([first, second])).resolves.toEqual([full, full]);
    expect(fetchLibraryEntriesMock).toHaveBeenCalledOnce();
  });

  it("surfaces a detail failure and clears it after a retry succeeds", async () => {
    const full = draftEntry(GUILD_A, simpleTextMessage());
    const summary = { ...full };
    delete summary.payload;
    resetStore();
    useLibraryStore.setState({ entries: [summary] });
    fetchLibraryEntriesMock.mockResolvedValueOnce({
      ok: false,
      error: "Detail service unavailable.",
      status: 503,
    });

    await useLibraryStore.getState().hydrate(GUILD_A, [full.id]);
    expect(useLibraryStore.getState().detailError).toBe("Detail service unavailable.");

    fetchLibraryEntriesMock.mockResolvedValueOnce({ ok: true, items: [full] });
    await useLibraryStore.getState().hydrate(GUILD_A, [full.id]);
    expect(useLibraryStore.getState().detailError).toBeNull();
    expect(useLibraryStore.getState().entries[0]).toEqual(full);
  });

  it("clears decrypted rows when detail hydration loses authorization", async () => {
    const full = draftEntry(GUILD_A, simpleTextMessage());
    const summary = { ...full, id: "draft-2" };
    delete summary.payload;
    resetStore();
    useLibraryStore.setState({ entries: [full, summary] });
    fetchLibraryEntriesMock.mockResolvedValueOnce({
      ok: false,
      error: "Sign in to continue.",
      status: 401,
    });

    await useLibraryStore.getState().hydrate(GUILD_A, [summary.id]);

    expect(useLibraryStore.getState()).toMatchObject({
      guildId: GUILD_A,
      entries: [],
      posted: { used: 0, quota: null },
      drafts: { used: 0, quota: null },
      loading: false,
      loaded: true,
      error: null,
      detailError: null,
    });
  });

  it("does not let an old detail response repopulate state after account reset", async () => {
    const full = draftEntry(GUILD_A, simpleTextMessage());
    const summary = { ...full };
    delete summary.payload;
    resetStore();
    useLibraryStore.setState({ entries: [summary] });
    const request = deferred<{ ok: true; items: LibraryEntryView[] }>();
    fetchLibraryEntriesMock.mockReturnValue(request.promise);

    const oldLoad = useLibraryStore.getState().hydrate(GUILD_A, [full.id]);
    useLibraryStore.getState().reset();
    resetStore(GUILD_A);
    request.resolve({ ok: true, items: [full] });
    await oldLoad;

    expect(useLibraryStore.getState().entries).toEqual([]);
  });

  it("clears decrypted same-guild rows when a refresh loses authorization", async () => {
    const full = draftEntry(GUILD_A, simpleTextMessage());
    resetStore();
    useLibraryStore.setState({ entries: [full], detailError: "old detail error" });
    listLibraryMock.mockResolvedValue({
      ok: false,
      error: "Sign in to continue.",
      status: 401,
    });

    await useLibraryStore.getState().refresh(GUILD_A);

    expect(listLibraryMock).toHaveBeenCalledWith(GUILD_A, { metadataOnly: true });
    expect(useLibraryStore.getState()).toMatchObject({
      guildId: GUILD_A,
      entries: [],
      posted: { used: 0, quota: null },
      drafts: { used: 0, quota: null },
      loading: false,
      loaded: true,
      error: null,
      detailError: null,
    });
  });

  it("sends a wire-format draft and merges it into the loaded server shelf", async () => {
    const message = simpleTextMessage();
    const entry = draftEntry(GUILD_A, message);
    createLibraryEntryMock.mockResolvedValue({ ok: true, entry });

    const result = await useLibraryStore
      .getState()
      .saveDraft(GUILD_A, "Weekly announcement", message);

    expect(result).toEqual({ ok: true, entry });
    expect(createLibraryEntryMock).toHaveBeenCalledWith(GUILD_A, {
      label: "draft",
      title: "Weekly announcement",
      payload: stripEditorFields(message),
    });
    expect(JSON.stringify(createLibraryEntryMock.mock.calls[0]?.[1])).not.toContain('"_id"');
    expect(useLibraryStore.getState().entries).toEqual([entry]);
    expect(useLibraryStore.getState().drafts).toEqual({ used: 3, quota: 10 });
  });

  it("keeps the loaded shelf unchanged when the API refuses the save", async () => {
    const failure: LibraryEntryResult = {
      ok: false,
      error: "This server has reached its saved-draft limit.",
      status: 409,
    };
    createLibraryEntryMock.mockResolvedValue(failure);

    const result = await useLibraryStore
      .getState()
      .saveDraft(GUILD_A, "At the limit", simpleTextMessage());

    expect(result).toEqual(failure);
    expect(useLibraryStore.getState().entries).toEqual([]);
    expect(useLibraryStore.getState().drafts).toEqual({ used: 2, quota: 10 });
  });

  it("does not merge a delayed save after the user switches servers", async () => {
    const message = simpleTextMessage();
    const entry = draftEntry(GUILD_A, message);
    const request = deferred<LibraryEntryResult>();
    createLibraryEntryMock.mockReturnValue(request.promise);

    const pending = useLibraryStore.getState().saveDraft(GUILD_A, "Weekly announcement", message);
    resetStore(GUILD_B);
    request.resolve({ ok: true, entry });

    await expect(pending).resolves.toEqual({ ok: true, entry });
    expect(useLibraryStore.getState().guildId).toBe(GUILD_B);
    expect(useLibraryStore.getState().entries).toEqual([]);
    expect(useLibraryStore.getState().drafts).toEqual({ used: 2, quota: 10 });
  });

  it("rejects session-only uploads before creating a broken shared draft", async () => {
    const message: WebhookMessage = {
      components: [
        {
          _id: "gallery",
          type: ComponentType.MediaGallery,
          items: [
            {
              _id: "item",
              media: { url: "session://local-blob/image.png" },
            },
          ],
        },
      ],
    };

    const result = await useLibraryStore.getState().saveDraft(GUILD_A, "Uploaded image", message);

    expect(result).toEqual({
      ok: false,
      error: "Uploaded files can't be saved in a server draft — use image or media URLs instead.",
      status: 400,
    });
    expect(createLibraryEntryMock).not.toHaveBeenCalled();
    expect(useLibraryStore.getState().entries).toEqual([]);
  });

  it("does not mistake plain text mentioning session:// for an uploaded file", async () => {
    const message = simpleTextMessage();
    message.components[0]!.content = "The internal scheme is session:// — document it.";
    const entry = draftEntry(GUILD_A, message, "Protocol notes");
    createLibraryEntryMock.mockResolvedValue({ ok: true, entry });

    await useLibraryStore.getState().saveDraft(GUILD_A, "Protocol notes", message);

    expect(createLibraryEntryMock).toHaveBeenCalledOnce();
  });
});

describe("libraryStore.verifyPosted", () => {
  const RETENTION = 30 * 86_400;

  function postedEntry(id: string, messageId: string, deletedAt?: number): LibraryEntryView {
    return {
      id,
      guild_id: GUILD_A,
      label: "posted",
      message_id: messageId,
      webhook_url: "https://discord.com/api/webhooks/1/tok",
      created_by: "333333333333333333",
      created_at: 1_700_000_000,
      updated_at: 1_700_000_000,
      ...(deletedAt == null ? {} : { deleted_at: deletedAt }),
    };
  }

  beforeEach(() => {
    useLibraryStore.getState().reset();
    resetStore();
    verifyLibraryPostedMock.mockReset();
    createLibraryEntryMock.mockReset();
    deleteLibraryEntryMock.mockReset();
    useLibraryStore.setState({
      entries: [
        postedEntry("posted-01", "901"),
        postedEntry("posted-02", "902"),
        draftEntry(GUILD_A, simpleTextMessage("Draft")),
      ],
      posted: { used: 2, quota: 10 },
      deletedRetentionSecs: RETENTION,
    });
  });

  it("keeps a post deleted on Discord, marked, outside the history count", async () => {
    verifyLibraryPostedMock.mockResolvedValue({
      ok: true,
      gone: ["posted-02"],
      deletedAt: 1_800_000_000,
    });
    const found = await useLibraryStore
      .getState()
      .verifyPosted(GUILD_A, ["posted-01", "posted-02", "draft-1"]);
    // Only live posted entries are asked about.
    expect(verifyLibraryPostedMock).toHaveBeenCalledWith(GUILD_A, ["posted-01", "posted-02"]);
    expect(found.map((entry) => entry.message_id)).toEqual(["902"]);
    const state = useLibraryStore.getState();
    expect(state.entries.map((entry) => entry.id)).toEqual(["posted-01", "posted-02", "draft-1"]);
    const marked = state.entries.find((entry) => entry.id === "posted-02")!;
    expect(marked.deleted_at).toBe(1_800_000_000);
    expect(isDeletedOnDiscord(marked)).toBe(true);
    // Loadable to post again, but never an update target.
    expect(libraryEntryOrigin(marked)).toBeNull();
    expect(libraryEntryOrigin(state.entries[0])).not.toBeNull();
    expect(state.posted).toEqual({ used: 1, quota: 10 });
  });

  it("drops the post when the proxy removed it (the first version did)", async () => {
    verifyLibraryPostedMock.mockResolvedValue({ ok: true, gone: ["posted-02"], deletedAt: null });
    await useLibraryStore.getState().verifyPosted(GUILD_A, ["posted-02"]);
    const state = useLibraryStore.getState();
    expect(state.entries.map((entry) => entry.id)).toEqual(["posted-01", "draft-1"]);
    expect(state.posted).toEqual({ used: 1, quota: 10 });
  });

  it("never asks about an entry already marked deleted", async () => {
    useLibraryStore.setState({ entries: [postedEntry("posted-03", "903", 1_800_000_000)] });
    verifyLibraryPostedMock.mockResolvedValue({ ok: true, gone: [], deletedAt: 1 });
    expect(await useLibraryStore.getState().verifyPosted(GUILD_A, ["posted-03"])).toEqual([]);
    expect(verifyLibraryPostedMock).not.toHaveBeenCalled();
  });

  it("asks about each entry at most once per interval", async () => {
    verifyLibraryPostedMock.mockResolvedValue({ ok: true, gone: [], deletedAt: 1 });
    await useLibraryStore.getState().verifyPosted(GUILD_A, ["posted-01"]);
    await useLibraryStore.getState().verifyPosted(GUILD_A, ["posted-01", "posted-02"]);
    expect(verifyLibraryPostedMock).toHaveBeenNthCalledWith(2, GUILD_A, ["posted-02"]);
    await useLibraryStore.getState().verifyPosted(GUILD_A, ["posted-01", "posted-02"]);
    expect(verifyLibraryPostedMock).toHaveBeenCalledTimes(2);
  });

  it("keeps everything when the check can't run", async () => {
    verifyLibraryPostedMock.mockResolvedValue({ ok: false, error: "Not found", status: 404 });
    const found = await useLibraryStore.getState().verifyPosted(GUILD_A, ["posted-01"]);
    expect(found).toEqual([]);
    expect(useLibraryStore.getState().entries).toHaveLength(3);
  });

  it("ignores an answer for a server the user has since left", async () => {
    const answer = deferred<{ ok: true; gone: string[]; deletedAt: number }>();
    verifyLibraryPostedMock.mockReturnValue(answer.promise);
    const pending = useLibraryStore.getState().verifyPosted(GUILD_A, ["posted-01"]);
    useLibraryStore.setState({ guildId: GUILD_B, entries: [postedEntry("posted-01", "901")] });
    answer.resolve({ ok: true, gone: ["posted-01"], deletedAt: 5 });
    expect(await pending).toEqual([]);
    expect(useLibraryStore.getState().entries[0].deleted_at).toBeUndefined();
  });

  it("removing a deleted post leaves the history count alone", async () => {
    useLibraryStore.setState({
      entries: [postedEntry("posted-01", "901"), postedEntry("posted-03", "903", 5)],
      posted: { used: 1, quota: 10 },
    });
    deleteLibraryEntryMock.mockResolvedValue({ ok: true });
    await useLibraryStore.getState().remove(GUILD_A, "posted-03");
    expect(useLibraryStore.getState().posted).toEqual({ used: 1, quota: 10 });
  });

  it("re-recording a deleted post brings it back into the window", async () => {
    useLibraryStore.setState({
      entries: [postedEntry("posted-03", "903", 5)],
      posted: { used: 0, quota: 10 },
    });
    createLibraryEntryMock.mockResolvedValue({ ok: true, entry: postedEntry("posted-03", "903") });
    await useLibraryStore.getState().recordPosted(GUILD_A, {
      messageId: "903",
      webhookUrl: "https://discord.com/api/webhooks/1/tok",
      message: simpleTextMessage("Again"),
    });
    const state = useLibraryStore.getState();
    expect(isDeletedOnDiscord(state.entries[0])).toBe(false);
    expect(state.posted).toEqual({ used: 1, quota: 10 });
  });

  it("the window never evicts a deleted post locally", async () => {
    useLibraryStore.setState({
      entries: [postedEntry("posted-01", "901"), postedEntry("posted-03", "903", 5)],
      posted: { used: 1, quota: 1 },
    });
    createLibraryEntryMock.mockResolvedValue({ ok: true, entry: postedEntry("posted-04", "904") });
    await useLibraryStore.getState().recordPosted(GUILD_A, {
      messageId: "904",
      webhookUrl: "https://discord.com/api/webhooks/1/tok",
      message: simpleTextMessage("New"),
    });
    expect(useLibraryStore.getState().entries.map((entry) => entry.id)).toEqual([
      "posted-04",
      "posted-03",
    ]);
  });
});

describe("deleted-on-Discord helpers", () => {
  it("counts whole days left, never below one while listed", () => {
    const entry = { label: "posted", deleted_at: 1_000 } as LibraryEntryView;
    const day = 86_400;
    expect(deletedDaysLeft(entry, 30 * day, 1_000 * 1000)).toBe(30);
    expect(deletedDaysLeft(entry, 30 * day, (1_000 + 29.5 * day) * 1000)).toBe(1);
    expect(deletedDaysLeft(entry, 30 * day, (1_000 + 31 * day) * 1000)).toBe(1);
    expect(deletedDaysLeft(entry, null)).toBeNull();
    expect(deletedDaysLeft({ ...entry, deleted_at: null }, 30 * day)).toBeNull();
  });

  it("says how long a deleted post is kept", () => {
    expect(deletedPostsMessage(1, 30 * 86_400)).toBe(
      "A post was deleted on Discord. It stays in Posted for 30 days so you can post it again.",
    );
    expect(deletedPostsMessage(2, 30 * 86_400)).toBe(
      "2 posts were deleted on Discord. They stay in Posted for 30 days so you can post them again.",
    );
    expect(deletedPostsMessage(1, null)).toBe("A post was deleted on Discord.");
  });
});
