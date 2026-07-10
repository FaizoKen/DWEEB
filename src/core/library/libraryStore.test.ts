import { beforeEach, describe, expect, it, vi } from "vitest";

const { createLibraryEntryMock, deleteLibraryEntryMock, listLibraryMock, updateLibraryEntryMock } =
  vi.hoisted(() => ({
    createLibraryEntryMock: vi.fn(),
    deleteLibraryEntryMock: vi.fn(),
    listLibraryMock: vi.fn(),
    updateLibraryEntryMock: vi.fn(),
  }));

vi.mock("./api", () => ({
  createLibraryEntry: createLibraryEntryMock,
  deleteLibraryEntry: deleteLibraryEntryMock,
  isLibraryConfigured: () => true,
  listLibrary: listLibraryMock,
  updateLibraryEntry: updateLibraryEntryMock,
}));

import { useLibraryStore } from "./libraryStore";
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
    listLibraryMock.mockReset();
    updateLibraryEntryMock.mockReset();
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
