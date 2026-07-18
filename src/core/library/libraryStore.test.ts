import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createLibraryEntryMock,
  deleteLibraryEntryMock,
  fetchLibraryEntriesMock,
  listLibraryMock,
  updateLibraryEntryMock,
} = vi.hoisted(() => ({
  createLibraryEntryMock: vi.fn(),
  deleteLibraryEntryMock: vi.fn(),
  fetchLibraryEntriesMock: vi.fn(),
  listLibraryMock: vi.fn(),
  updateLibraryEntryMock: vi.fn(),
}));

vi.mock("./api", () => ({
  createLibraryEntry: createLibraryEntryMock,
  deleteLibraryEntry: deleteLibraryEntryMock,
  fetchLibraryEntries: fetchLibraryEntriesMock,
  isLibraryConfigured: () => true,
  LIBRARY_DETAIL_BATCH_SIZE: 64,
  listLibrary: listLibraryMock,
  updateLibraryEntry: updateLibraryEntryMock,
}));

import { libraryEntryHasDetails, pendingLibraryDetailIds, useLibraryStore } from "./libraryStore";
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
