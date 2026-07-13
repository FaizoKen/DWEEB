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
  /** Wire-format payload (no `_id` fields). */
  payload: unknown;
}

interface SavedMessagesState {
  entries: SavedMessageRecord[];
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

function readRaw(): SavedMessageRecord[] {
  if (typeof localStorage === "undefined") return [];
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return [];
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

function writeRaw(entries: SavedMessageRecord[]): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    return true;
  } catch {
    // Quota exceeded or storage disabled. The caller must leave its in-memory
    // state unchanged so the UI never presents an ephemeral entry as saved.
    return false;
  }
}

/** Normalise a user-typed name. Returns null when the result is empty. */
export function normalizeSavedMessageName(input: string): string | null {
  const trimmed = input.trim().slice(0, MAX_NAME_LENGTH);
  return trimmed.length > 0 ? trimmed : null;
}

export const useSavedMessagesStore = create<SavedMessagesState>((set, get) => ({
  entries: readRaw(),

  save(name, message) {
    const record: SavedMessageRecord = {
      id: newId(),
      name,
      savedAt: Date.now(),
      payload: stripEditorFields(message),
    };
    // Newest first so the menu list reads chronologically.
    const next = [record, ...get().entries];
    if (!writeRaw(next)) return { ok: false, error: STORAGE_ERROR };
    set({ entries: next });
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
    const next = get().entries.filter((e) => e.id !== id);
    if (!writeRaw(next)) return false;
    set({ entries: next });
    return true;
  },

  rename(id, name) {
    const next = get().entries.map((e) => (e.id === id ? { ...e, name, savedAt: Date.now() } : e));
    if (!writeRaw(next)) return false;
    set({ entries: next });
    return true;
  },
}));
