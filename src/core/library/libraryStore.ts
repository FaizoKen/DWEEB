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
  type LibraryBucketUsage,
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
  /** Posted-history usage: a rolling "last N posts" window that syncs itself
   *  (recording past it evicts the oldest), so `used` can't exceed `quota`
   *  for long. `quota` null = unlimited (or not loaded yet). */
  posted: LibraryBucketUsage;
  /** Saved-draft usage: a hard cap — at `quota`, saves are refused until an
   *  entry is removed or the plan is upgraded. */
  drafts: LibraryBucketUsage;
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
 *  currently shows that guild. Bumps the entry's own bucket on a fresh insert
 *  and — for posted entries — mirrors the server's rolling window by dropping
 *  the oldest posted entries past the quota, so the local list matches what a
 *  reload would show without refetching. */
function mergeEntry(
  state: Pick<LibraryState, "guildId" | "entries" | "posted" | "drafts">,
  entry: LibraryEntryView,
): Partial<LibraryState> | null {
  if (state.guildId !== entry.guild_id) return null;
  const existed = state.entries.some((e) => e.id === entry.id);
  let entries = [entry, ...state.entries.filter((e) => e.id !== entry.id)];
  let posted = state.posted;
  let drafts = state.drafts;
  if (entry.label === "posted") {
    if (!existed) posted = { ...posted, used: posted.used + 1 };
    if (posted.quota != null && posted.used > posted.quota) {
      // Evict oldest-first, exactly like the server (entries are newest-first).
      let surplus = posted.used - posted.quota;
      entries = [...entries]
        .reverse()
        .filter((e) => {
          if (e.label !== "posted" || surplus === 0) return true;
          surplus -= 1;
          return false;
        })
        .reverse();
      posted = { ...posted, used: posted.quota };
    }
  } else if (!existed) {
    drafts = { ...drafts, used: drafts.used + 1 };
  }
  return { entries, posted, drafts };
}

const EMPTY_BUCKET: LibraryBucketUsage = { used: 0, quota: null };

export const useLibraryStore = create<LibraryState>((set, get) => ({
  guildId: null,
  entries: [],
  posted: EMPTY_BUCKET,
  drafts: EMPTY_BUCKET,
  loading: false,
  error: null,
  loaded: false,

  async refresh(guildId) {
    if (!isLibraryConfigured() || !guildId) return;
    // Reset when switching servers so stale entries never flash under the new
    // server's header; a same-server refresh keeps the list up while loading.
    if (get().guildId !== guildId) {
      set({
        guildId,
        entries: [],
        posted: EMPTY_BUCKET,
        drafts: EMPTY_BUCKET,
        loaded: false,
        error: null,
      });
    }
    set({ loading: true });
    const res = await listLibrary(guildId);
    // A slow response for a server the user has already navigated away from
    // must not clobber the current one.
    if (get().guildId !== guildId) return;
    if (res.ok) {
      set({
        entries: res.items,
        posted: res.posted,
        drafts: res.drafts,
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
      const removed = get().entries.find((e) => e.id === id);
      const patch: Partial<LibraryState> = {
        entries: get().entries.filter((e) => e.id !== id),
      };
      if (removed?.label === "posted") {
        patch.posted = { ...get().posted, used: Math.max(0, get().posted.used - 1) };
      } else if (removed) {
        patch.drafts = { ...get().drafts, used: Math.max(0, get().drafts.used - 1) };
      }
      set(patch);
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
