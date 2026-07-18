/**
 * Server message library — client-side state.
 *
 * Holds one server's library at a time (the connected / target guild): the
 * gallery and the Activity's "Message directory" dialog both show the library of
 * wherever the user is currently working, so there's no need to cache every
 * server. Switching guilds just refreshes.
 *
 * Writes are optimistic only in the sense that a successful API response is
 * merged straight into the loaded list; failures surface to the caller (except
 * `recordPosted`, which is fire-and-forget by design — a send must never look
 * failed because the library was full).
 */

import { create } from "zustand";
import { registerAccountStateReset } from "@/core/auth/accountScopedState";
import type { WebhookMessage } from "@/core/schema/types";
import { collectSearchText } from "@/core/schema/traversal";
import type { RestoredOrigin } from "@/core/state/messageStore";
import {
  attachEditorFields,
  hasSessionAttachments,
  stripEditorFields,
} from "@/core/serialization/normalize";
import {
  createLibraryEntry,
  deleteLibraryEntry,
  fetchLibraryEntries,
  isLibraryConfigured,
  LIBRARY_DETAIL_BATCH_SIZE,
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
  /** Last detail-batch failure. List metadata remains usable; body search falls
   * back to metadata until an explicit card load retries successfully. */
  detailError: string | null;
  /** Load (or reload) a server's library. No-op when unconfigured. */
  refresh(guildId: string): Promise<void>;
  /** Drop every account-scoped row and invalidate outstanding async work. */
  reset(): void;
  /** Hydrate metadata rows in bounded, sequential batches. Concurrent callers
   * for the same ids share one task instead of duplicating decrypt requests. */
  hydrate(guildId: string, ids: string[]): Promise<void>;
  /** Ensure one row has details (used when a user clicks before its preview
   * batch settles), returning null if it can no longer be read. */
  hydrateOne(guildId: string, id: string): Promise<LibraryEntryView | null>;
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

/** A summary has no own `payload` property. Full rows always do, including an
 * explicit `null` when a rotated key made the seal unreadable. */
export function libraryEntryHasDetails(entry: LibraryEntryView): boolean {
  return Object.prototype.hasOwnProperty.call(entry, "payload");
}

/** Detail ids for the active shelf. `limit` bounds normal card paging; `null`
 * is reserved for body search, whose exact semantics require every row. */
export function pendingLibraryDetailIds(
  entries: LibraryEntryView[],
  limit: number | null,
): string[] {
  const candidates = limit == null ? entries : entries.slice(0, Math.max(0, limit));
  return candidates.filter((entry) => !libraryEntryHasDetails(entry)).map((entry) => entry.id);
}

const detailTasks = new Map<string, Promise<void>>();
const detailTaskKey = (guildId: string, id: string) => `${guildId}:${id}`;
let accountGeneration = 0;

export const useLibraryStore = create<LibraryState>((set, get) => ({
  guildId: null,
  entries: [],
  posted: EMPTY_BUCKET,
  drafts: EMPTY_BUCKET,
  loading: false,
  error: null,
  loaded: false,
  detailError: null,

  reset() {
    accountGeneration += 1;
    detailTasks.clear();
    set({
      guildId: null,
      entries: [],
      posted: EMPTY_BUCKET,
      drafts: EMPTY_BUCKET,
      loading: false,
      error: null,
      loaded: false,
      detailError: null,
    });
  },

  async refresh(guildId) {
    if (!isLibraryConfigured() || !guildId) return;
    const generation = accountGeneration;
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
        detailError: null,
      });
    }
    set({ loading: true });
    const res = await listLibrary(guildId, { metadataOnly: true });
    // A slow response for a server the user has already navigated away from
    // must not clobber the current one.
    if (accountGeneration !== generation || get().guildId !== guildId) return;
    if (res.ok) {
      set({
        entries: res.items,
        posted: res.posted,
        drafts: res.drafts,
        loading: false,
        loaded: true,
        error: null,
        detailError: null,
      });
    } else if (res.status === 401 || res.status === 403) {
      // A same-guild refresh can race sign-out/account replacement. Never keep
      // another account's decrypted shelf resident merely because the guild id
      // happens to match; also invalidate detail/mutation responses in flight.
      accountGeneration += 1;
      detailTasks.clear();
      set({
        guildId,
        entries: [],
        posted: EMPTY_BUCKET,
        drafts: EMPTY_BUCKET,
        loading: false,
        loaded: true,
        error: null,
        detailError: null,
      });
    } else {
      set({
        loading: false,
        loaded: true,
        error: res.error,
      });
    }
  },

  async hydrate(guildId, ids) {
    if (get().guildId !== guildId || ids.length === 0) return;
    const generation = accountGeneration;
    const entriesById = new Map(get().entries.map((entry) => [entry.id, entry]));
    const wanted = [...new Set(ids)].filter((id) => {
      const entry = entriesById.get(id);
      return entry != null && !libraryEntryHasDetails(entry);
    });
    if (wanted.length === 0) return;

    const existing = new Set<Promise<void>>();
    const fresh: string[] = [];
    for (const id of wanted) {
      const task = detailTasks.get(detailTaskKey(guildId, id));
      if (task) existing.add(task);
      else fresh.push(id);
    }

    let freshTask: Promise<void> | undefined;
    if (fresh.length > 0) {
      freshTask = (async () => {
        // Sequential batches bound both browser response memory and proxy
        // decrypt/SQLite work even when a body search needs the whole shelf.
        for (let offset = 0; offset < fresh.length; offset += LIBRARY_DETAIL_BATCH_SIZE) {
          const batch = fresh.slice(offset, offset + LIBRARY_DETAIL_BATCH_SIZE);
          const res = await fetchLibraryEntries(guildId, batch);
          if (!res.ok) {
            if (accountGeneration === generation && get().guildId === guildId) {
              if (res.status === 401 || res.status === 403) {
                // Detail hydration carries the same decrypted payload/webhook
                // data as a full list. Losing authorization must end this
                // account lifetime just as decisively as the metadata refresh:
                // clear resident secrets and reject every sibling response.
                accountGeneration += 1;
                detailTasks.clear();
                set({
                  guildId,
                  entries: [],
                  posted: EMPTY_BUCKET,
                  drafts: EMPTY_BUCKET,
                  loading: false,
                  loaded: true,
                  error: null,
                  detailError: null,
                });
              } else {
                set({ detailError: res.error });
              }
            }
            return;
          }
          if (accountGeneration !== generation || get().guildId !== guildId) return;
          const details = new Map(res.items.map((entry) => [entry.id, entry]));
          const requested = new Set(batch);
          set((state) => ({
            detailError: null,
            entries: state.entries.map((entry) => {
              const full = details.get(entry.id);
              if (full) return full;
              // The row may have been removed after the metadata list. Mark it
              // settled/unreadable rather than retrying it forever.
              return requested.has(entry.id) ? { ...entry, payload: null } : entry;
            }),
          }));
        }
      })().catch(() => {
        if (accountGeneration === generation && get().guildId === guildId) {
          set({ detailError: "Couldn't load message details." });
        }
      });
      for (const id of fresh) detailTasks.set(detailTaskKey(guildId, id), freshTask);
      const cleanup = () => {
        for (const id of fresh) {
          const key = detailTaskKey(guildId, id);
          if (detailTasks.get(key) === freshTask) detailTasks.delete(key);
        }
      };
      // A rejection handler on the detached cleanup chain prevents an
      // unexpected exception from becoming a global unhandled-rejection crash.
      void freshTask.then(cleanup, cleanup);
    }

    await Promise.all([...existing, ...(freshTask ? [freshTask] : [])]);
  },

  async hydrateOne(guildId, id) {
    const generation = accountGeneration;
    const current = get().entries.find((entry) => entry.id === id);
    if (current && libraryEntryHasDetails(current)) return current;
    await get().hydrate(guildId, [id]);
    if (accountGeneration !== generation) return null;
    const hydrated = get().entries.find((entry) => entry.id === id);
    return hydrated && libraryEntryHasDetails(hydrated) ? hydrated : null;
  },

  async recordPosted(guildId, input) {
    if (!isLibraryConfigured() || !guildId) return;
    const generation = accountGeneration;
    const res = await createLibraryEntry(guildId, {
      label: "posted",
      payload: stripEditorFields(input.message),
      webhook_url: input.webhookUrl,
      message_id: input.messageId,
      channel_id: input.channelId,
      thread_id: input.threadId,
      dest_label: input.destLabel,
    });
    if (res.ok && accountGeneration === generation) {
      const merged = mergeEntry(get(), res.entry);
      if (merged) set(merged);
    }
    // Quota-full / signed-out / network trouble: silently drop the record.
    // The send already landed; the library is best-effort.
  },

  async saveDraft(guildId, title, message) {
    // In-session uploads are backed by bytes in this browser's attachment
    // registry. Persisting only their `session://` URL would make the shared
    // draft look saved while leaving it broken for teammates and other devices.
    // Guard at the shared server-draft boundary so both the web app and the
    // Discord Activity get the same honest failure.
    if (hasSessionAttachments(message)) {
      return {
        ok: false,
        error: "Uploaded files can't be saved in a server draft — use image or media URLs instead.",
        status: 400,
      };
    }
    const generation = accountGeneration;
    const res = await createLibraryEntry(guildId, {
      label: "draft",
      title,
      payload: stripEditorFields(message),
    });
    if (res.ok && accountGeneration === generation) {
      const merged = mergeEntry(get(), res.entry);
      if (merged) set(merged);
    }
    return res;
  },

  async rename(guildId, id, title) {
    const generation = accountGeneration;
    const res = await updateLibraryEntry(guildId, id, { title });
    if (res.ok && accountGeneration === generation && get().guildId === guildId) {
      set({ entries: get().entries.map((e) => (e.id === id ? res.entry : e)) });
    }
    return res;
  },

  async remove(guildId, id) {
    const generation = accountGeneration;
    const res = await deleteLibraryEntry(guildId, id);
    if (res.ok && accountGeneration === generation && get().guildId === guildId) {
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

registerAccountStateReset(() => useLibraryStore.getState().reset());

/** Hydration is cached per entry object: entries are immutable API snapshots
 *  (every store mutation swaps in fresh objects), so a WeakMap key can never go
 *  stale — and a Plus/Pro shelf with hundreds of entries would otherwise re-run
 *  `attachEditorFields` over the whole list every time any dependent state
 *  (a slot toggle, a search keystroke's rebuild) recomputes its cards. Sharing
 *  the hydrated object is safe: the editor clones on load (`reassignIds`) and
 *  never mutates a message in place. */
const hydrationCache = new WeakMap<LibraryEntryView, WebhookMessage | null>();
const searchTextCache = new WeakMap<LibraryEntryView, string>();

/** Re-hydrate a library entry into an editable message. Null when the payload
 *  is missing (unopenable seal) or malformed. Cached per entry. */
export function libraryEntryMessage(entry: LibraryEntryView): WebhookMessage | null {
  let cached = hydrationCache.get(entry);
  if (cached === undefined) {
    cached = null;
    if (entry.payload != null) {
      try {
        cached = attachEditorFields(entry.payload);
      } catch {
        cached = null;
      }
    }
    hydrationCache.set(entry, cached);
  }
  return cached;
}

/** Lowercased text pulled from the entry's message body (content, labels, …)
 *  for search. Cached per entry — computing this walks the whole message tree,
 *  which adds up fast across a large shelf. Empty when the payload is
 *  missing or malformed. */
export function libraryEntrySearchText(entry: LibraryEntryView): string {
  let cached = searchTextCache.get(entry);
  if (cached === undefined) {
    const message = libraryEntryMessage(entry);
    cached = message ? collectSearchText(message) : "";
    searchTextCache.set(entry, cached);
  }
  return cached;
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
