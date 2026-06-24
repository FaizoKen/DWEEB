/**
 * Posted-messages store.
 *
 * Every successful Send (POST a new message, or PATCH an existing one) leaves a
 * record here so the message reappears as a card on the "Start a message"
 * gallery — one click reloads it into the editor *with its send origin*, so the
 * next send updates the live message in place. It's the automatic version of
 * the Restore tab: instead of pasting a webhook URL + message ID by hand, the
 * user just picks the card.
 *
 * Why this is allowed to persist, given DWEEB's "nothing stored" stance: the
 * stance is about never uploading content to a server — posts go straight from
 * the browser to Discord. Persisting *locally* is exactly what the auto-saved
 * draft and the Saved-messages library already do. Unlike the old send-history
 * experiment (which quietly accumulated and was never surfaced), these records
 * are visible cards the user can delete individually, so nothing is hidden.
 *
 * Credential note: to update a posted message Discord needs the webhook token,
 * so — like {@link RestoredOrigin} and the webhook history — the record holds
 * the canonical execute URL. That token already lives in `webhook/history.ts`;
 * keeping it alongside the message it posted is what makes "update without
 * re-pasting the URL" possible. Records are addressed by the Discord message id
 * so re-posting / updating the same message refreshes its single record instead
 * of piling up duplicates.
 *
 * Storage shape mirrors `savedMessagesStore` / `draftStorage`: the wire-format
 * payload (no editor `_id`s) plus the metadata needed to re-target a send. The
 * key carries a version suffix so a future shape change can drop old data.
 */

import { create } from "zustand";
import { newId } from "@/lib/id";
import type { WebhookMessage } from "@/core/schema/types";
import type { RestoredOrigin } from "@/core/state/messageStore";
import { attachEditorFields, stripEditorFields } from "@/core/serialization/normalize";

const STORAGE_KEY = "dweeb.posted.v1";
/** Cap the list so an active sender's localStorage can't grow without bound. */
const MAX_ENTRIES = 24;

export interface PostedMessageRecord {
  /** Stable id; React key + address for rename/remove. Distinct from the
   *  Discord message id, which can be absent on older records. */
  id: string;
  /** Discord message snowflake — the dedup key. A re-post / update of the same
   *  message overwrites its record rather than adding a new one. */
  messageId: string;
  /** Canonical webhook execute URL (no query/fragment) — the credential needed
   *  to PATCH the message back into place. */
  webhookUrl: string;
  /** Webhook snowflake (parsed from the URL) — display + avatar lookup. */
  webhookId: string;
  /** Thread the message lives in, when it was posted to one. */
  threadId?: string;
  /** Destination guild/channel snowflakes, for the deep link + display. */
  guildId?: string;
  channelId?: string;
  /** Resolved names, captured at send time so cards read "#general · Server"
   *  without a live lookup. */
  guildName?: string;
  channelName?: string;
  /** The webhook's own name + avatar hash at send time, for the card. */
  webhookName?: string;
  webhookAvatar?: string | null;
  /** Unix millis the message was last posted or updated. */
  postedAt: number;
  /** Wire-format payload (no `_id` fields), with raw `{placeholder}` tokens
   *  preserved so the reloaded message stays editable. */
  payload: unknown;
}

/** Fields the Send panel hands over after a successful POST/PATCH. */
export interface RecordPostedInput {
  messageId: string;
  webhookUrl: string;
  webhookId: string;
  threadId?: string;
  guildId?: string;
  channelId?: string;
  guildName?: string;
  channelName?: string;
  webhookName?: string;
  webhookAvatar?: string | null;
  message: WebhookMessage;
}

interface PostedMessagesState {
  entries: PostedMessageRecord[];
  /** Upsert a posted message keyed by its Discord id. Returns the record. */
  record(input: RecordPostedInput): PostedMessageRecord;
  /** Re-hydrate a record into an editable message plus the origin that lets the
   *  Send panel default to "Update existing". Null if the id is unknown or the
   *  stored payload won't parse. */
  load(id: string): { message: WebhookMessage; origin: RestoredOrigin } | null;
  remove(id: string): void;
  clear(): void;
}

function readRaw(): PostedMessageRecord[] {
  if (typeof localStorage === "undefined") return [];
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is PostedMessageRecord =>
        !!e &&
        typeof e === "object" &&
        typeof e.id === "string" &&
        typeof e.messageId === "string" &&
        typeof e.webhookUrl === "string" &&
        typeof e.webhookId === "string" &&
        typeof e.postedAt === "number" &&
        e.payload !== undefined,
    );
  } catch {
    return [];
  }
}

function writeRaw(entries: PostedMessageRecord[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Quota exceeded or storage disabled — swallow; the in-memory list still
    // reflects the change for the current session.
  }
}

/** Build the editor-side origin (PATCH target) from a stored record. */
export function recordOrigin(entry: PostedMessageRecord): RestoredOrigin {
  return {
    webhookUrl: entry.webhookUrl,
    messageId: entry.messageId,
    threadId: entry.threadId,
    // Carry the home server so reloading re-aligns the editor's connected guild
    // (or explains the mismatch when it can't).
    guildId: entry.guildId,
    guildName: entry.guildName,
  };
}

export const usePostedMessagesStore = create<PostedMessagesState>((set, get) => ({
  entries: readRaw(),

  record(input) {
    const existing = get().entries.find((e) => e.messageId === input.messageId);
    const record: PostedMessageRecord = {
      // Keep the same record id on an update so it stays put in any open list.
      id: existing?.id ?? newId(),
      messageId: input.messageId,
      webhookUrl: input.webhookUrl,
      webhookId: input.webhookId,
      threadId: input.threadId,
      guildId: input.guildId,
      channelId: input.channelId,
      // Don't let a later send that resolved fewer names blank out good ones.
      guildName: input.guildName ?? existing?.guildName,
      channelName: input.channelName ?? existing?.channelName,
      webhookName: input.webhookName ?? existing?.webhookName,
      webhookAvatar:
        input.webhookAvatar !== undefined ? input.webhookAvatar : existing?.webhookAvatar,
      postedAt: Date.now(),
      payload: stripEditorFields(input.message),
    };
    // Newest first; drop any prior record for this message, then cap.
    const next = [record, ...get().entries.filter((e) => e.messageId !== input.messageId)].slice(
      0,
      MAX_ENTRIES,
    );
    writeRaw(next);
    set({ entries: next });
    return record;
  },

  load(id) {
    const entry = get().entries.find((e) => e.id === id);
    if (!entry) return null;
    try {
      return { message: attachEditorFields(entry.payload), origin: recordOrigin(entry) };
    } catch {
      return null;
    }
  },

  remove(id) {
    const next = get().entries.filter((e) => e.id !== id);
    writeRaw(next);
    set({ entries: next });
  },

  clear() {
    writeRaw([]);
    set({ entries: [] });
  },
}));
