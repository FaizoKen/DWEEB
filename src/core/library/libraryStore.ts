/**
 * Server message library — client-side state.
 *
 * Holds one server's library at a time (the connected / target guild): the
 * gallery and the Activity's "Start a message" dialog both show the library of
 * wherever the user is currently working, so there's no need to cache every
 * server. Switching guilds just refreshes.
 *
 * Writes are optimistic only in the sense that a successful API response is
 * merged straight into the loaded list; failures surface to the caller (except
 * `recordPosted`, which is fire-and-forget by design — a send must never look
 * failed because the library was full).
 */

import { create } from "zustand";
import type { WebhookMessage } from "@/core/schema/types";
import type { RestoredOrigin } from "@/core/state/messageStore";
import { attachEditorFields, stripEditorFields } from "@/core/serialization/normalize";
import {
  createLibraryEntry,
  deleteLibraryEntry,
  isLibraryConfigured,
  listLibrary,
  updateLibraryEntry,
  type LibraryEntryResult,
  type LibraryEntryView,
} from "./api";

/** Fields a successful send hands over to record the post server-side. */
export interface RecordLibraryPostInput {
  messageId: string;
  webhookUrl: string;
  channelId?: string;
  threadId?: string;
  destLabel?: string;
  message: WebhookMessage;
}

interface LibraryState {
  /** The server whose library is loaded (null = nothing loaded yet). */
  guildId: string | null;
  entries: LibraryEntryView[];
  used: number;
  /** Per-server entry cap; null = unlimited (or not loaded yet). */
  quota: number | null;
  loading: boolean;
  /** Last load error, for the gallery's quiet failure note. 403 (no Manage
   *  Webhooks) is normal for a non-manager and stored as null. */
  error: string | null;
  /** True after the first load attempt for `guildId` settled (ok or not). */
  loaded: boolean;
  /** Load (or reload) a server's library. No-op when unconfigured. */
  refresh(guildId: string): Promise<void>;
  /** Record a just-posted message (label `posted`, upserted by message id).
   *  Fire-and-forget: any failure is swallowed — the send already succeeded. */
  recordPosted(guildId: string, input: RecordLibraryPostInput): Promise<void>;
  /** Save the current editor message as a named server draft. Resolves with
   *  the API result so quota errors can be surfaced. */
  saveDraft(guildId: string, title: string, message: WebhookMessage): Promise<LibraryEntryResult>;
  rename(guildId: string, id: string, title: string): Promise<LibraryEntryResult>;
  remove(guildId: string, id: string): Promise<boolean>;
}

/** Merge an upserted entry into the loaded list (newest first), if the list
 *  currently shows that guild. */
function mergeEntry(
  state: Pick<LibraryState, "guildId" | "entries" | "used">,
  entry: LibraryEntryView,
): Partial<LibraryState> | null {
  if (state.guildId !== entry.guild_id) return null;
  const existed = state.entries.some((e) => e.id === entry.id);
  return {
    entries: [entry, ...state.entries.filter((e) => e.id !== entry.id)],
    used: existed ? state.used : state.used + 1,
  };
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  guildId: null,
  entries: [],
  used: 0,
  quota: null,
  loading: false,
  error: null,
  loaded: false,

  async refresh(guildId) {
    if (!isLibraryConfigured() || !guildId) return;
    // Reset when switching servers so stale entries never flash under the new
    // server's header; a same-server refresh keeps the list up while loading.
    if (get().guildId !== guildId) {
      set({ guildId, entries: [], used: 0, quota: null, loaded: false, error: null });
    }
    set({ loading: true });
    const res = await listLibrary(guildId);
    // A slow response for a server the user has already navigated away from
    // must not clobber the current one.
    if (get().guildId !== guildId) return;
    if (res.ok) {
      set({
        entries: res.items,
        used: res.used,
        quota: res.quota,
        loading: false,
        loaded: true,
        error: null,
      });
    } else {
      set({
        loading: false,
        loaded: true,
        // 401 (signed out) and 403 (member without Manage Webhooks) are normal
        // states, not failures worth a banner — the library simply isn't theirs
        // to see.
        error: res.status === 401 || res.status === 403 ? null : res.error,
      });
    }
  },

  async recordPosted(guildId, input) {
    if (!isLibraryConfigured() || !guildId) return;
    const res = await createLibraryEntry(guildId, {
      label: "posted",
      payload: stripEditorFields(input.message),
      webhook_url: input.webhookUrl,
      message_id: input.messageId,
      channel_id: input.channelId,
      thread_id: input.threadId,
      dest_label: input.destLabel,
    });
    if (res.ok) {
      const merged = mergeEntry(get(), res.entry);
      if (merged) set(merged);
    }
    // Quota-full / signed-out / network trouble: silently keep the local
    // record only. The send already landed; the library is best-effort.
  },

  async saveDraft(guildId, title, message) {
    const res = await createLibraryEntry(guildId, {
      label: "draft",
      title,
      payload: stripEditorFields(message),
    });
    if (res.ok) {
      const merged = mergeEntry(get(), res.entry);
      if (merged) set(merged);
    }
    return res;
  },

  async rename(guildId, id, title) {
    const res = await updateLibraryEntry(guildId, id, { title });
    if (res.ok && get().guildId === guildId) {
      set({ entries: get().entries.map((e) => (e.id === id ? res.entry : e)) });
    }
    return res;
  },

  async remove(guildId, id) {
    const res = await deleteLibraryEntry(guildId, id);
    if (res.ok && get().guildId === guildId) {
      const had = get().entries.some((e) => e.id === id);
      set({
        entries: get().entries.filter((e) => e.id !== id),
        used: had ? Math.max(0, get().used - 1) : get().used,
      });
    }
    return res.ok;
  },
}));

/** Re-hydrate a library entry into an editable message. Null when the payload
 *  is missing (unopenable seal) or malformed. */
export function libraryEntryMessage(entry: LibraryEntryView): WebhookMessage | null {
  if (entry.payload == null) return null;
  try {
    return attachEditorFields(entry.payload);
  } catch {
    return null;
  }
}

/** The update-in-place origin for a posted entry, when it has everything a
 *  re-send needs (the webhook URL + message id). Null for drafts / entries the
 *  seal couldn't be opened for. */
export function libraryEntryOrigin(entry: LibraryEntryView): RestoredOrigin | null {
  if (entry.label !== "posted" || !entry.webhook_url || !entry.message_id) return null;
  return {
    webhookUrl: entry.webhook_url,
    messageId: entry.message_id,
    threadId: entry.thread_id ?? undefined,
    guildId: entry.guild_id,
  };
}
