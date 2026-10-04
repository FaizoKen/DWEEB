import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WebhookMessage } from "@/core/schema";
import {
  syncSavedMessagesFromStorage,
  useSavedMessagesStore,
  type SavedMessageRecord,
} from "./savedMessagesStore";

const KEY = "dweeb.saved.v1";
const values = new Map<string, string>();
let writesFail = false;
let readsFail = false;

const storage = {
  getItem: (key: string) => {
    if (readsFail) throw new DOMException("Access denied", "SecurityError");
    return values.get(key) ?? null;
  },
  setItem: (key: string, value: string) => {
    if (writesFail) throw new DOMException("Storage is full", "QuotaExceededError");
    values.set(key, String(value));
  },
  removeItem: (key: string) => void values.delete(key),
  clear: () => values.clear(),
} as unknown as Storage;

const message: WebhookMessage = { components: [] };

function record(id: string, name = id): SavedMessageRecord {
  return { id, name, savedAt: 1, payload: { components: [] } };
}

/** What another tab's save/delete leaves in the shared record. */
function otherTabWrites(entries: SavedMessageRecord[]): void {
  values.set(KEY, JSON.stringify(entries));
}

function storedNames(): string[] {
  return (JSON.parse(values.get(KEY) ?? "[]") as SavedMessageRecord[]).map((e) => e.name);
}

function reset(): void {
  useSavedMessagesStore.setState({ entries: [], deletedElsewhere: [] });
}

beforeEach(() => {
  values.clear();
  writesFail = false;
  readsFail = false;
  (globalThis as { localStorage?: Storage }).localStorage = storage;
  reset();
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
  reset();
});

describe("saved message durability", () => {
  it("reports success only after localStorage accepts the record", () => {
    const result = useSavedMessagesStore.getState().save("Release note", message);

    expect(result.ok).toBe(true);
    expect(useSavedMessagesStore.getState().entries).toHaveLength(1);
    expect(Array.from(values.values()).join("")).toContain("Release note");
  });

  it("reports a failed save and leaves no ephemeral in-memory entry", () => {
    writesFail = true;

    const result = useSavedMessagesStore.getState().save("Not durable", message);

    expect(result).toMatchObject({ ok: false });
    expect(useSavedMessagesStore.getState().entries).toEqual([]);
  });

  it("does not make a failed delete reappear only after reload", () => {
    expect(useSavedMessagesStore.getState().save("Keep me", message).ok).toBe(true);
    const [entry] = useSavedMessagesStore.getState().entries;
    writesFail = true;

    expect(useSavedMessagesStore.getState().remove(entry!.id)).toBe(false);
    expect(useSavedMessagesStore.getState().entries).toEqual([entry]);
  });

  it("refuses to save over a list it could not read", () => {
    otherTabWrites([record("a", "Older draft")]);
    readsFail = true;

    expect(useSavedMessagesStore.getState().save("Mine", message)).toMatchObject({ ok: false });
    readsFail = false;
    expect(storedNames()).toEqual(["Older draft"]);
  });
});

// The 2026-09-30 report: four drafts saved in one tab vanished when a second,
// older tab saved its own — that tab wrote its stale list back over them.
describe("saved messages shared between tabs", () => {
  it("a save keeps everything another tab saved since this tab loaded", () => {
    otherTabWrites([record("old-1", "Old 1"), record("old-2", "Old 2")]);
    syncSavedMessagesFromStorage(); // this tab boots with the two old drafts
    otherTabWrites([
      record("new-4", "New 4"),
      record("new-3", "New 3"),
      record("new-2", "New 2"),
      record("new-1", "New 1"),
      record("old-1", "Old 1"),
      record("old-2", "Old 2"),
    ]); // the other tab saves four more; no storage event reaches this one

    expect(useSavedMessagesStore.getState().save("Mine", message).ok).toBe(true);

    expect(storedNames()).toEqual(["Mine", "New 4", "New 3", "New 2", "New 1", "Old 1", "Old 2"]);
    expect(useSavedMessagesStore.getState().entries.map((e) => e.name)).toEqual(storedNames());
  });

  it("a delete removes only its own entry from the current list", () => {
    otherTabWrites([record("a"), record("b")]);
    syncSavedMessagesFromStorage();
    otherTabWrites([record("c"), record("a"), record("b")]);

    expect(useSavedMessagesStore.getState().remove("a")).toBe(true);

    expect(storedNames()).toEqual(["c", "b"]);
    expect(useSavedMessagesStore.getState().entries.map((e) => e.id)).toEqual(["c", "b"]);
  });

  it("deleting an entry another tab already deleted succeeds and resurrects nothing", () => {
    otherTabWrites([record("a"), record("b")]);
    syncSavedMessagesFromStorage();
    otherTabWrites([record("b")]);

    expect(useSavedMessagesStore.getState().remove("a")).toBe(true);

    expect(storedNames()).toEqual(["b"]);
    expect(useSavedMessagesStore.getState().entries.map((e) => e.id)).toEqual(["b"]);
  });

  it("a rename keeps another tab's entries and refuses one it deleted", () => {
    otherTabWrites([record("a"), record("b")]);
    syncSavedMessagesFromStorage();
    otherTabWrites([record("c"), record("a")]);

    expect(useSavedMessagesStore.getState().rename("a", "Renamed")).toBe(true);
    expect(storedNames()).toEqual(["c", "Renamed"]);
    expect(useSavedMessagesStore.getState().rename("b", "Gone")).toBe(false);
    expect(storedNames()).toEqual(["c", "Renamed"]);
  });

  it("follows another tab's writes, keeping unchanged records by identity", () => {
    otherTabWrites([record("a"), record("b")]);
    syncSavedMessagesFromStorage();
    const before = useSavedMessagesStore.getState().entries;

    syncSavedMessagesFromStorage();
    expect(useSavedMessagesStore.getState().entries).toBe(before);

    otherTabWrites([record("c"), record("a"), record("b")]);
    syncSavedMessagesFromStorage();
    const after = useSavedMessagesStore.getState().entries;
    expect(after.map((e) => e.id)).toEqual(["c", "a", "b"]);
    expect(after[1]).toBe(before[0]);
    expect(after[2]).toBe(before[1]);
  });

  it("remembers entries deleted elsewhere, but not ones this tab deleted", () => {
    otherTabWrites([record("a"), record("b"), record("c")]);
    syncSavedMessagesFromStorage();
    const [a, b] = useSavedMessagesStore.getState().entries;

    expect(useSavedMessagesStore.getState().remove("a")).toBe(true);
    otherTabWrites([record("c")]);
    syncSavedMessagesFromStorage();

    const state = useSavedMessagesStore.getState();
    expect(state.entries.map((e) => e.id)).toEqual(["c"]);
    expect(state.deletedElsewhere).toEqual([b]);
    expect(state.deletedElsewhere).not.toContain(a);
  });

  it("re-reads the list on a storage event for its key, and on a clear()", async () => {
    const target = new EventTarget();
    (globalThis as { window?: unknown }).window = target;
    vi.resetModules();
    try {
      const fresh = await import("./savedMessagesStore");
      const storageEvent = (key: string | null) =>
        Object.assign(new Event("storage"), { key }) as StorageEvent;

      otherTabWrites([record("a")]);
      target.dispatchEvent(storageEvent("dweeb.draft.v1"));
      expect(fresh.useSavedMessagesStore.getState().entries).toEqual([]);

      target.dispatchEvent(storageEvent(KEY));
      expect(fresh.useSavedMessagesStore.getState().entries.map((e) => e.id)).toEqual(["a"]);

      values.clear();
      target.dispatchEvent(storageEvent(null));
      expect(fresh.useSavedMessagesStore.getState().entries).toEqual([]);
    } finally {
      delete (globalThis as { window?: unknown }).window;
      vi.resetModules();
    }
  });
});
