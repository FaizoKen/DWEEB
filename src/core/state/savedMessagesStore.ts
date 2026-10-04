/**
 * Saved messages store.
 *
 * Lets users name and stash an arbitrary number of messages in `localStorage`
 * so they can load them back later. Distinct from `draftStorage`, which is
 * the single auto-saved in-progress message.
 *
 * Storage shape mirrors `draftStorage`: we persist the wire-format payload
 * (no editor `_id`s) so the on-disk record matches what a share URL or JSON
 * export would carry. Editor ids are re-stamped when loading.
 *
 * Webhook URLs are **not** persisted here — those are credentials and live in
 * the dedicated webhook history. Saved messages are pure content.
 *
 * **The stored record is the list; `entries` is only this tab's view of it.**
 * Every open tab shares the one `localStorage` record, so a mutation re-reads
 * it, applies its single change and writes the result back — never
 * `[change, ...entries]`. Writing from memory shipped as a data-loss bug
 * (2026-09-30): a tab opened before another tab saved four drafts still held
 * the older list, and its next save wrote that list back over all four. The
 * view follows other tabs' writes through the `storage` event, re-checked on a
 * back/forward-cache restore, which can miss them.
 */

import { create } from "zustand";
import { newId } from "@/lib/id";
import type { WebhookMessage } from "@/core/schema/types";
import { attachEditorFields, stripEditorFields } from "@/core/serialization/normalize";

const STORAGE_KEY = "dweeb.saved.v1";
const MAX_NAME_LENGTH = 60;

export interface SavedMessageRecord {
  /** Stable id; used as the React key and to address rename/remove. */
  id: string;
  /** User-supplied label. Trimmed; max 60 chars. */
  name: string;
  /** Unix millis when this entry was created or last overwritten. */
  savedAt: number;
  /** Wire-format payload (no `_id` fields). Never changes for a given id. */
  payload: unknown;
}

interface SavedMessagesState {
  entries: SavedMessageRecord[];
  /**
   * Entries that disappeared from storage while this tab was showing them —
   * deleted in another tab. Never listed, but they stay attachment-GC roots
   * (`useAttachmentGc`) for the rest of this page's life: the tab that deleted
   * one may have loaded it into its editor first, and evicting its uploads from
   * the shared IndexedDB here would break that tab's files on its next reload.
   * A fresh boot's prune decides again from what is stored then.
   */
  deletedElsewhere: readonly SavedMessageRecord[];
  /** Persist `message` under `name`. Memory changes only after storage commits. */
  save(name: string, message: WebhookMessage): SavedMessageSaveResult;
  /** Re-hydrate a saved entry into an editable message. Returns null if the
   *  stored payload is malformed or the id is unknown. */
  load(id: string): WebhookMessage | null;
  remove(id: string): boolean;
  rename(id: string, name: string): boolean;
}

export type SavedMessageSaveResult =
  | { ok: true; record: SavedMessageRecord }
  | { ok: false; error: string };

const STORAGE_ERROR =
  "This browser couldn't store the message. Check its storage permissions or free some space, then try again.";

/**
 * The stored list. `null` when storage itself refused the read: a caller about
 * to write must stop there, because writing over a list it couldn't read is
 * exactly how saved messages get erased. A missing or unparseable record reads
 * as empty, and malformed entries are skipped.
 */
function readStored(): SavedMessageRecord[] | null {
  if (typeof localStorage === "undefined") return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is SavedMessageRecord =>
        !!e &&
        typeof e === "object" &&
        typeof e.id === "string" &&
        typeof e.name === "string" &&
        typeof e.savedAt === "number" &&
        e.payload !== undefined,
    );
  } catch {
    return [];
  }
}

function writeStored(entries: SavedMessageRecord[]): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    return true;
  } catch {
    // Quota exceeded or storage disabled. The caller must leave the stored
    // list as the truth so the UI never presents an ephemeral entry as saved.
    return false;
  }
}

/**
 * `stored`, keeping this tab's record objects wherever an entry is unchanged,
 * so another tab's write re-renders nothing here and per-record caches (the
 * gallery's thumbnails, the attachment GC's URL lists) stay warm. Returns
 * `current` itself when nothing changed.
 */
function adoptStored(
  stored: readonly SavedMessageRecord[],
  current: readonly SavedMessageRecord[],
): SavedMessageRecord[] {
  const mine = new Map(current.map((e) => [e.id, e]));
  let unchanged = stored.length === current.length;
  const next = stored.map((e, i) => {
    const own = mine.get(e.id);
    const kept = own && own.name === e.name && own.savedAt === e.savedAt ? own : e;
    if (kept !== current[i]) unchanged = false;
    return kept;
  });
  return unchanged ? (current as SavedMessageRecord[]) : next;
}

/** Normalise a user-typed name. Returns null when the result is empty. */
export function normalizeSavedMessageName(input: string): string | null {
  const trimmed = input.trim().slice(0, MAX_NAME_LENGTH);
  return trimmed.length > 0 ? trimmed : null;
}

export const useSavedMessagesStore = create<SavedMessagesState>((_set, get) => ({
  entries: readStored() ?? [],
  deletedElsewhere: [],

  save(name, message) {
    const stored = readStored();
    if (stored === null) return { ok: false, error: STORAGE_ERROR };
    const record: SavedMessageRecord = {
      id: newId(),
      name,
      savedAt: Date.now(),
      payload: stripEditorFields(message),
    };
    // Newest first so the menu list reads chronologically.
    const next = [record, ...stored];
    if (!writeStored(next)) {
      settle(stored);
      return { ok: false, error: STORAGE_ERROR };
    }
    settle(next);
    return { ok: true, record };
  },

  load(id) {
    const entry = get().entries.find((e) => e.id === id);
    if (!entry) return null;
    try {
      return attachEditorFields(entry.payload);
    } catch {
      return null;
    }
  },

  remove(id) {
    const stored = readStored();
    if (stored === null) return false;
    const next = stored.filter((e) => e.id !== id);
    // Already gone from storage (another tab deleted it): nothing to write,
    // and the outcome the user asked for already holds.
    if (next.length !== stored.length && !writeStored(next)) {
      settle(stored);
      return false;
    }
    settle(next, id);
    return true;
  },

  rename(id, name) {
    const stored = readStored();
    if (stored === null) return false;
    if (!stored.some((e) => e.id === id)) {
      settle(stored);
      return false;
    }
    const next = stored.map((e) => (e.id === id ? { ...e, name, savedAt: Date.now() } : e));
    if (!writeStored(next)) {
      settle(stored);
      return false;
    }
    settle(next);
    return true;
  },
}));

/**
 * Make `stored` this tab's view. `removedHere` is the one id this tab's own
 * action took out; any other entry that vanished was deleted elsewhere.
 */
function settle(stored: readonly SavedMessageRecord[], removedHere?: string): void {
  const { entries, deletedElsewhere } = useSavedMessagesStore.getState();
  const next = adoptStored(stored, entries);
  if (next === entries) return;
  const present = new Set(stored.map((e) => e.id));
  const gone = entries.filter((e) => !present.has(e.id) && e.id !== removedHere);
  useSavedMessagesStore.setState(
    gone.length > 0
      ? { entries: next, deletedElsewhere: [...deletedElsewhere, ...gone] }
      : { entries: next },
  );
}

/** Re-read the stored list into this tab's view (another tab wrote it). */
export function syncSavedMessagesFromStorage(): void {
  const stored = readStored();
  if (stored !== null) settle(stored);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    // `key === null` is a `clear()` in another tab.
    if (event.key === STORAGE_KEY || event.key === null) syncSavedMessagesFromStorage();
  });
  // A page restored from the back/forward cache missed the events fired
  // while it was stored.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) syncSavedMessagesFromStorage();
  });
}
