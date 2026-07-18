/**
 * Template Gallery — the app's full-screen landing screen.
 *
 * Auto-opens on a useful first/fresh visit (see `App`) so a new user starts
 * from a deliberate choice instead of a cold editor. It blends four sources into one
 * app-store-style grid:
 *
 *  - **Posted** — the connected server's shared library history (messages sent
 *    through DWEEB, recorded server-side), ready to reload and update in
 *    place. Server-only by design: nothing posted is kept in this browser.
 *    This tab is also the never-expire manager: each card carries an
 *    assign/free slot control, the tab header shows slot usage, and slots
 *    whose message left the history are listed for recovery (freeing one is
 *    the only way to reclaim a slot held by a deleted message).
 *  - **Scheduled** — the connected server's upcoming one-time posts, each with a
 *    live preview: load one back into the editor, cancel it, or manage the
 *    posted/failed history — all inline (this replaced the old "Managed
 *    messages" dialog). Payloads are fetched lazily, only while the tab is open.
 *  - **Browser drafts** — the user's named, browser-local messages (a dedicated
 *    category), so reusable messages are reachable without digging through the
 *    Saved menu.
 *  - **Templates** — the curated starting points.
 *
 * Every card carries a **live, faithful thumbnail** — the real `Preview`
 * renderer scaled down and made `inert`, so what you see is exactly what you'll
 * get. Search spans name / description / tags. Interactive templates are tagged
 * "Interactive" and name the plugin they pair with.
 *
 * Built to stay fast on a large (Plus/Pro) shelf: entry hydration and search
 * text are cached per immutable entry, each card's haystack is precomputed (a
 * keystroke is one `includes` per card, against a deferred query), the grid
 * mounts in pages behind a load-more sentinel, thumbnails lazy-mount as their
 * card nears the viewport, and `content-visibility` lets off-screen cards skip
 * layout & paint.
 *
 * Picking a template or saved message replaces the editor wholesale (fresh ids,
 * undoable) and closes the gallery. Rendered into a portal so it overlays the
 * whole app.
 */

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMessageStore } from "@/core/state/messageStore";
import { useSavedMessagesStore, type SavedMessageRecord } from "@/core/state/savedMessagesStore";
import { useAuthStore } from "@/core/auth/authStore";
import { useGuildStore } from "@/core/guild/guildStore";
import {
  addPermanentMessage,
  fetchPermanentSlots,
  isUnlimitedCap,
  removePermanentMessage,
  type PermanentSlots,
} from "@/core/guild/api";
import { usePlanStore } from "@/core/plan/planStore";
import { handleDiscordLinkClick } from "@/lib/discordDeepLink";
import { isLibraryConfigured } from "@/core/library/api";
import {
  libraryEntryHasDetails,
  libraryEntryMessage,
  libraryEntryOrigin,
  libraryEntrySearchText,
  pendingLibraryDetailIds,
  useLibraryStore,
} from "@/core/library/libraryStore";
import { interactiveComponents } from "@/core/plugins/targets";
import { alignConnectedGuild } from "@/core/guild/originGuild";
import { attachEditorFields } from "@/core/serialization/normalize";
import { isScheduleConfigured, type ScheduleView } from "@/core/schedule/api";
import { useScheduledPosts } from "@/core/schedule/useScheduledPosts";
import { formatInstant } from "@/core/schedule/recurrence";
import { validateMessage } from "@/core/schema/validation";
import { TEMPLATES, type MessageTemplate } from "@/data/presets";
import type { WebhookMessage } from "@/core/schema/types";
import { isRegisteredPluginId } from "@/core/plugins/registry";
import { useSendNudgeStore } from "@/core/state/sendNudgeStore";
import { GuildIdentity } from "@/features/share/GuildIdentity";
import { Button } from "@/ui/Button";
import { Modal } from "@/ui/Modal";
import {
  ChevronRightIcon,
  CloseIcon,
  PlusIcon,
  SearchIcon,
  SparkleIcon,
  TrashIcon,
} from "@/ui/Icon";
import { pushToast } from "@/ui/Toast";
import {
  CARD_PAGE_SIZE,
  EAGER_THUMBNAILS,
  GalleryCard,
  GalleryChipsSkeleton,
  GalleryDetailError,
  GalleryGridSkeleton,
  LoadMoreSentinel,
  messageSearchText,
  searchHaystack,
  type CardData,
} from "./galleryCards";
import { ScheduleHistory } from "./GalleryScheduled";
import { useTemplateGalleryStore } from "./templateGalleryStore";
import { trackAnalytics } from "@/core/telemetry/analytics";
import { useTemplateSetupStore } from "./templateSetupStore";
import styles from "./TemplateGallery.module.css";

/** The chip row's buckets: the user's own posted messages, their two draft
 *  shelves (this browser's saves and the server library's shared drafts), then
 *  all curated templates collapsed into one. Templates keep their per-card
 *  category label, but the chips no longer split by category. */
const BROWSER_DRAFTS_FILTER = "Browser drafts" as const;
const SERVER_DRAFTS_FILTER = "Server drafts" as const;
const POSTED_FILTER = "Posted" as const;
const SCHEDULED_FILTER = "Scheduled" as const;
const TEMPLATE_FILTER = "Template" as const;
type Filter =
  | typeof POSTED_FILTER
  | typeof SCHEDULED_FILTER
  | typeof BROWSER_DRAFTS_FILTER
  | typeof SERVER_DRAFTS_FILTER
  | typeof TEMPLATE_FILTER;

const ACCENT_TEAL = 0x1abc9c;
const ACCENT_GREEN = 0x3ba55d;
const ACCENT_INDIGO = 0x5865f2;

/** Saved-entry hydration, cached per record object (records are immutable —
 *  save/rename swap in fresh objects). Null = malformed payload (an older or
 *  corrupt record): the entry is skipped rather than thrown on. */
const savedHydrationCache = new WeakMap<SavedMessageRecord, WebhookMessage | null>();
function savedEntryMessage(entry: SavedMessageRecord): WebhookMessage | null {
  let cached = savedHydrationCache.get(entry);
  if (cached === undefined) {
    try {
      cached = attachEditorFields(entry.payload);
    } catch {
      cached = null;
    }
    savedHydrationCache.set(entry, cached);
  }
  return cached;
}

export function TemplateGallery() {
  const replaceMessage = useMessageStore((s) => s.replaceMessage);
  const replaceMessageFromRestore = useMessageStore((s) => s.replaceMessageFromRestore);
  const clearAll = useMessageStore((s) => s.clearAll);
  const closeGallery = useTemplateGalleryStore((s) => s.closeGallery);
  const savedEntries = useSavedMessagesStore((s) => s.entries);
  const removeEntry = useSavedMessagesStore((s) => s.remove);
  // The signed-in user's servers, for the connected server's display name.
  const authGuilds = useAuthStore((s) => s.guilds);
  // The connected server — whose library the Posted tab shows.
  const connectedGuildId = useGuildStore((s) => s.guildId);
  const connectedGuildName = useMemo(
    () => authGuilds.find((g) => g.id === connectedGuildId)?.name,
    [authGuilds, connectedGuildId],
  );

  const [query, setQuery] = useState("");
  // Filtering runs against the deferred value so typing stays responsive even
  // when a keystroke re-filters (and re-renders) a large deck.
  const deferredQuery = useDeferredValue(query);
  // Seeded once from the store so callers can deep-link straight to a chip
  // (e.g. "Browser drafts"); the gallery is remounted on each open, so this
  // initialiser re-runs fresh.
  const [filter, setFilter] = useState<Filter>(
    () => useTemplateGalleryStore.getState().initialFilter,
  );
  // Card pages also bound server-library detail hydration: only the rows the
  // current deck can reveal need payloads until body search explicitly asks
  // for the rest.
  const [visibleCount, setVisibleCount] = useState(CARD_PAGE_SIZE);
  const [pendingDelete, setPendingDelete] = useState<{
    kind: "saved" | "library" | "scheduled";
    id: string;
    name: string;
    /** Library only — the server the entry belongs to. */
    guildId?: string;
    /** Library only — a `posted` history entry (vs a server draft): the confirm
     *  frames it as pruning the shared history now rather than waiting for it to
     *  roll off. Never-expire posted cards drop delete entirely, so a pinned
     *  message never reaches this dialog. */
    posted?: boolean;
    /** Scheduled only — the schedule the confirm cancels. */
    schedule?: ScheduleView;
  } | null>(null);
  // Freeing a never-expire slot goes through its own confirm — freeing is
  // meaningful (the message drops back onto the expiry clock) and, with no hover
  // to warn on touch, a bare tap on the chip must not silently remove it.
  const [pendingFreeSlot, setPendingFreeSlot] = useState<{
    messageId: string;
    name: string;
    paused: boolean;
  } | null>(null);

  // The connected server's scheduled (one-time) posts — the Scheduled tab. The
  // list loads whenever scheduling is configured (so the chip can appear);
  // per-schedule preview payloads only fetch once the user is on that tab.
  const scheduleOn = isScheduleConfigured();
  const sched = useScheduledPosts(
    connectedGuildId || undefined,
    scheduleOn,
    filter === SCHEDULED_FILTER,
  );

  // The connected server's shared library (posted messages + server drafts),
  // refreshed on open / when the connected server changes. Fails soft: a signed-
  // out user or a member without Manage Webhooks simply sees no server section.
  const libraryOn = isLibraryConfigured();
  const libEntries = useLibraryStore((s) => s.entries);
  const libGuild = useLibraryStore((s) => s.guildId);
  const libPosted = useLibraryStore((s) => s.posted);
  const libDrafts = useLibraryStore((s) => s.drafts);
  const libLoaded = useLibraryStore((s) => s.loaded);
  const libDetailError = useLibraryStore((s) => s.detailError);
  const hydrateLibrary = useLibraryStore((s) => s.hydrate);
  const removeLibrary = useLibraryStore((s) => s.remove);
  useEffect(() => {
    if (libraryOn && connectedGuildId) {
      void useLibraryStore.getState().refresh(connectedGuildId);
    }
  }, [libraryOn, connectedGuildId]);

  // Never-expire slot state for the connected server. This is the slots'
  // management surface: posted cards carry an "assign / free" control and the
  // Posted tab shows usage + any slots whose message isn't in this history.
  // Fail-soft: a 501 (feature off) or 403 (no Manage Server) just hides it
  // all, leaving the gallery a plain shelf.
  const [permanent, setPermanent] = useState<PermanentSlots | null>(null);
  const [slotBusy, setSlotBusy] = useState(false);
  useEffect(() => {
    if (!libraryOn || !connectedGuildId) {
      setPermanent(null);
      return;
    }
    const ac = new AbortController();
    fetchPermanentSlots(connectedGuildId, ac.signal)
      .then(setPermanent)
      .catch(() => setPermanent(null));
    return () => ac.abort();
  }, [libraryOn, connectedGuildId]);

  // Claim a never-expire slot for a posted message, straight from its card.
  // Always asks the server (idempotent, and the local `used/cap` may be stale);
  // a 409 "all slots taken" comes back with the fresh state instead of throwing.
  const assignNeverExpire = useCallback(
    async (messageId: string, channelId: string) => {
      if (!connectedGuildId) return;
      setSlotBusy(true);
      try {
        const res = await addPermanentMessage(connectedGuildId, messageId, channelId);
        setPermanent(res.slots);
        if (res.full) {
          pushToast(
            `All ${res.slots.cap} never-expire slots are in use — free one here, or upgrade the server's plan for more.`,
            "error",
          );
        } else {
          pushToast("Never expire is on — buttons & selects keep working.", "success");
        }
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error");
      } finally {
        setSlotBusy(false);
      }
    },
    [connectedGuildId],
  );

  // Give a slot back. The message returns to the sliding expiry clock, counted
  // from its last use — a long-idle message's buttons may expire right away.
  const freeNeverExpire = useCallback(
    async (messageId: string) => {
      if (!connectedGuildId) return;
      setSlotBusy(true);
      try {
        setPermanent(await removePermanentMessage(connectedGuildId, messageId));
        pushToast("Slot freed — the message is back on the expiry clock.", "info");
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error");
      } finally {
        setSlotBusy(false);
      }
    },
    [connectedGuildId],
  );
  const searchRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const [chipScroll, setChipScroll] = useState({ left: false, right: false });

  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("dweeb:surface-ready", { detail: { surface: "directory" } }),
    );
  }, []);

  const updateChipScroll = useCallback(() => {
    const row = chipsRef.current;
    if (!row) return;
    const maxScrollLeft = Math.max(0, row.scrollWidth - row.clientWidth);
    const next = {
      left: row.scrollLeft > 1,
      right: row.scrollLeft < maxScrollLeft - 1,
    };
    setChipScroll((current) =>
      current.left === next.left && current.right === next.right ? current : next,
    );
  }, []);

  const scrollChips = useCallback((direction: -1 | 1) => {
    const row = chipsRef.current;
    if (!row) return;
    row.scrollBy({
      left: direction * Math.max(140, row.clientWidth * 0.75),
      behavior: "smooth",
    });
  }, []);

  // Focus search for mouse/keyboard layouts, but not on coarse-pointer devices:
  // forcing focus there opens the on-screen keyboard over the directory before
  // the visitor has chosen to search.
  useEffect(() => {
    if (!window.matchMedia("(pointer: fine)").matches) return;
    const t = setTimeout(() => searchRef.current?.focus(), 40);
    return () => clearTimeout(t);
  }, []);

  // Lock body scroll behind the overlay; restore on unmount.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Keep keyboard focus inside the modal and restore the invoking control when
  // it closes. The editor shell is also inert while this is mounted (App.tsx).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeGallery();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((node) => !node.hidden && node.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (
        e.shiftKey &&
        (document.activeElement === first || !panelRef.current?.contains(document.activeElement))
      ) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Deliberately read the opener at *close* time (not effect-setup) so focus
      // returns to whatever last opened the gallery.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const opener = openerRef.current;
      // App removes `inert` from the background in the same close commit. Hop a
      // frame so browsers do not reject focus while the opener is still inside
      // an inert ancestor; also resolve the fallback after the editor remounts.
      requestAnimationFrame(() => {
        const restoreTarget = opener?.isConnected
          ? opener
          : document.querySelector<HTMLElement>('[aria-label="Component builder"] button');
        restoreTarget?.focus({ preventScroll: true });
      });
    };
  }, [closeGallery]);

  // Saved messages, re-hydrated to editable form for their thumbnails (cached
  // per record — see savedEntryMessage). Skips any entry whose payload won't
  // parse (an older/corrupt record) rather than throw.
  const savedMessages = useMemo(
    () =>
      savedEntries.flatMap((e) => {
        const message = savedEntryMessage(e);
        return message ? [{ entry: e, message }] : [];
      }),
    [savedEntries],
  );

  const localSavedCards: CardData[] = useMemo(
    () =>
      savedMessages.map(({ entry, message }) => ({
        kind: "saved",
        key: entry.id,
        emoji: "🔖",
        name: entry.name,
        description: "Browser draft — only visible on this device.",
        message,
        accent: ACCENT_TEAL,
        savedAt: entry.savedAt,
        badge: "Browser draft",
        search: searchHaystack(
          entry.name,
          "Browser draft — only visible on this device.",
          "Browser draft",
          messageSearchText(message),
        ),
        onPick: () => {
          replaceMessage(message);
          closeGallery();
          pushToast(`Loaded "${entry.name}"`, "success");
        },
        onDelete: () => setPendingDelete({ kind: "saved", id: entry.id, name: entry.name }),
      })),
    [savedMessages, replaceMessage, closeGallery],
  );

  // The connected server's library entries (only when the loaded library
  // actually matches the connected server — a switch mid-load must not show the
  // previous server's shelf), split by label and re-hydrated like the local
  // saved store. This is the only source of posted history: every send records
  // straight to the server library, nothing posted is kept in this browser.
  const serverEntries = useMemo(
    () => (libGuild && libGuild === connectedGuildId ? libEntries : []),
    [libGuild, connectedGuildId, libEntries],
  );
  // Never-expire grants: every held slot (freeing a paused one is valid), and
  // the active subset for the "Never expires" tag.
  const grantIds = useMemo(
    () => new Set((permanent?.items ?? []).map((i) => i.message_id)),
    [permanent],
  );
  const permanentIds = useMemo(
    () => new Set((permanent?.items ?? []).filter((i) => !i.suspended).map((i) => i.message_id)),
    [permanent],
  );
  // Whether the slot controls render at all: the feature is on (ttl set), the
  // slot state loaded (i.e. this user may manage it), and a server is connected.
  const canManageSlots = permanent != null && permanent.ttl_days != null && !!connectedGuildId;
  const { libraryPostedCards, libraryDraftCards } = useMemo(() => {
    const posted: CardData[] = [];
    const drafts: CardData[] = [];
    for (const entry of serverEntries) {
      const hasDetails = libraryEntryHasDetails(entry);
      const message = hasDetails ? libraryEntryMessage(entry) : null;
      // Preserve the old fail-safe for an unreadable full row. A summary stays
      // as a lightweight placeholder card until its visible page is hydrated.
      if (hasDetails && !message) continue;
      const isPosted = entry.label === "posted";
      const interactive = message ? interactiveComponents(message).length > 0 : false;
      const holdsSlot = isPosted && !!entry.message_id && grantIds.has(entry.message_id);
      // "Buttons may be expired" — an interactive message posted longer than
      // the component TTL ago without a slot. Display-only and best-effort:
      // the dispatcher's expiry window slides with use, which this client
      // can't see, so this is the no-use lower bound — hence "may". (Never-
      // expire state lives entirely in the pin chip below — no duplicate
      // meta-row pill.)
      const tags: CardData["tags"] = [];
      if (
        isPosted &&
        entry.message_id &&
        !holdsSlot &&
        permanent?.ttl_days != null &&
        interactive &&
        Date.now() - entry.updated_at * 1000 > permanent.ttl_days * 86_400_000
      ) {
        tags.push({ text: "Buttons may be expired", tone: "warn" });
      }
      const displayName =
        entry.title?.trim() || entry.dest_label || (isPosted ? "Posted message" : "Server draft");
      // The pin chip: ONE control that both shows never-expire state and
      // toggles it. A held slot (even a plan-paused one) opens a confirm before
      // freeing; an interactive message without a slot claims one on tap
      // (additive, no confirm). A message with no components has nothing to keep
      // alive, so it gets no chip.
      let pin: CardData["pin"];
      if (canManageSlots && isPosted && entry.message_id) {
        const messageId = entry.message_id;
        if (holdsSlot) {
          const paused = !permanentIds.has(messageId);
          pin = {
            state: paused ? "paused" : "on",
            busy: slotBusy,
            title: paused
              ? "Never expire is paused — the server holds more never-expire messages than its plan allows. Tap to free the slot."
              : "This message never expires and stays in this history. Tap to free the slot — it goes back on the expiry clock, counted from its last use.",
            run: () => setPendingFreeSlot({ messageId, name: displayName, paused }),
          };
        } else if (interactive && entry.channel_id) {
          const channelId = entry.channel_id;
          pin = {
            state: "off",
            busy: slotBusy,
            title:
              "Keep this message's buttons & selects working forever — uses one of the server's never-expire slots and keeps it in this history.",
            run: () => void assignNeverExpire(messageId, channelId),
          };
        }
      }
      const description = isPosted
        ? holdsSlot
          ? `${entry.dest_label ? `Posted to ${entry.dest_label}` : "Posted"} · never-expire keeps it out of the rolling history window, so it stays here until you free the slot.`
          : `${entry.dest_label ? `Posted to ${entry.dest_label}` : "Posted"} · synced automatically in the ${
              connectedGuildName ?? "server"
            } history — it rolls off as newer posts land. Load it and save it to keep it.`
        : `A saved message in the ${connectedGuildName ?? "server"} library, shared with this server's managers.`;
      const card: CardData = {
        kind: isPosted ? "posted" : "saved",
        key: `lib:${entry.id}`,
        emoji: isPosted ? "📤" : "🔖",
        name: displayName,
        description,
        message: message ?? undefined,
        previewPending: !hasDetails,
        accent: isPosted ? ACCENT_GREEN : ACCENT_TEAL,
        savedAt: entry.updated_at * 1000,
        badge: isPosted ? "Posted" : "Server draft",
        storedInServerLibrary: true,
        tags,
        pin,
        search: searchHaystack(
          displayName,
          description,
          isPosted ? "Posted" : "Server draft",
          message ? libraryEntrySearchText(entry) : undefined,
        ),
        // Never-expire posted messages sit above the rolling window and never
        // auto-evict; deleting one would strand its claimed slot. So a pinned
        // card drops delete entirely — free the slot from its pin chip first,
        // then the message becomes an ordinary history entry that can be
        // removed. Server drafts (never `holdsSlot`) always keep delete.
        onDelete: holdsSlot
          ? undefined
          : () =>
              setPendingDelete({
                kind: "library",
                id: entry.id,
                guildId: entry.guild_id,
                name: displayName,
                posted: isPosted,
              }),
        onPick: () => {
          void (async () => {
            const full = hasDetails
              ? entry
              : await useLibraryStore.getState().hydrateOne(entry.guild_id, entry.id);
            const loaded = full ? libraryEntryMessage(full) : null;
            if (!full || !loaded) {
              pushToast(
                "This entry couldn't be read — it may predate a server key change.",
                "error",
              );
              return;
            }
            const origin = libraryEntryOrigin(full);
            if (origin) {
              // Posted with its webhook intact: restore content *and* origin so
              // the Send panel flips to "Update existing".
              replaceMessageFromRestore(loaded, origin);
              alignConnectedGuild(full.guild_id);
              pushToast(
                "Loaded from the server library — edits will update the original.",
                "success",
              );
            } else {
              replaceMessage(loaded);
              pushToast(
                isPosted
                  ? "Loaded from the server library (content only — sending posts a new copy)."
                  : "Loaded from the server library.",
                "success",
              );
            }
            closeGallery();
          })();
        },
      };
      (isPosted ? posted : drafts).push(card);
    }
    return { libraryPostedCards: posted, libraryDraftCards: drafts };
  }, [
    serverEntries,
    grantIds,
    permanentIds,
    permanent,
    canManageSlots,
    slotBusy,
    assignNeverExpire,
    connectedGuildName,
    replaceMessage,
    replaceMessageFromRestore,
    closeGallery,
  ]);

  // The Posted deck IS the connected server's shared history — server-fed only,
  // so what you see is exactly what the library holds, on every device. Drafts
  // stay SEPARATE: "Browser drafts" is this browser's private stash, "Server drafts" is
  // the shared library shelf — mixing them hid which one a card actually lived
  // in.
  const postedCards = libraryPostedCards;
  const savedCards = localSavedCards;

  // Never-expire slots pointing at messages this history doesn't hold — posted
  // before the library existed, evicted before pinning kept them, or their
  // record was deleted (on the shelf or on Discord). Without a card there'd be
  // nowhere to free them, so the Posted tab lists them separately; otherwise a
  // slot held by a vanished message would leak forever.
  // Gated on the library having LOADED for this server — before that, every
  // slot would look orphaned for a moment.
  const orphanSlots = useMemo(() => {
    if (!permanent || !libLoaded || libGuild !== connectedGuildId) return [];
    const inHistory = new Set(
      serverEntries.filter((e) => e.label === "posted" && e.message_id).map((e) => e.message_id),
    );
    return permanent.items.filter((i) => !inHistory.has(i.message_id));
  }, [permanent, serverEntries, libLoaded, libGuild, connectedGuildId]);

  // Pinned posted entries sit above the rolling window server-side, so the
  // footer's "last N of M" figure counts only the rows the window governs.
  const pinnedPostedCount = useMemo(
    () =>
      serverEntries.filter(
        (e) => e.label === "posted" && e.message_id && grantIds.has(e.message_id),
      ).length,
    [serverEntries, grantIds],
  );

  const templateCards: CardData[] = useMemo(
    () =>
      TEMPLATES.map((t: MessageTemplate) => ({
        kind: "template",
        key: t.id,
        emoji: t.emoji,
        name: t.name,
        description: t.description,
        message: t.message,
        accent: t.accent,
        category: t.category,
        requiresBot: t.requiresBot,
        pairsWith: t.pairsWith,
        search: searchHaystack(
          t.name,
          t.description,
          t.category,
          t.pairsWith,
          messageSearchText(t.message),
        ),
        onPick: () => {
          replaceMessage(t.message);
          trackAnalytics("template_applied", { template_id: t.id, source: "gallery" });
          closeGallery();
          // A template with plugin slots still has setup to finish — wiring an
          // interactive component's plugin, or completing a link plugin's
          // external per-server setup. Hand straight to the guided checklist
          // instead of dropping the user in a cold editor — but only when at
          // least one declared slot resolves to a plugin this build ships
          // (service or link registry).
          const canSetup =
            !!t.pluginSlots?.length &&
            t.pluginSlots.some((slot) => isRegisteredPluginId(slot.pluginId));
          if (canSetup) {
            useTemplateSetupStore.getState().begin(t.id);
          } else {
            // Nothing to wire — skip straight to the editor and point the user at
            // Send with the same coach-mark (and raise the mobile preview), so a
            // static template lands the same place an interactive one finishes.
            useSendNudgeStore.getState().nudge();
          }
        },
      })),
    [replaceMessage, closeGallery],
  );

  // Upcoming scheduled posts, as gallery cards with a live preview. The message
  // (needed for the thumbnail and to load it back into the editor) is fetched
  // lazily by the hook; until it lands the card shows a placeholder. Cancel
  // routes through the shared confirm dialog; the trash icon reads "Cancel".
  const scheduledCards: CardData[] = useMemo(() => {
    if (!scheduleOn) return [];
    return sched.upcoming.map((s) => {
      const message = sched.messages.get(s.id) ?? undefined;
      const paused = s.status === "paused" || s.status === "suspended";
      const when = formatInstant(s.next_run_at, s.tz);
      const name = s.title?.trim() || s.dest_label || "Scheduled post";
      const tags: CardData["tags"] = [];
      if (s.status === "suspended") tags.push({ text: "Over plan limit", tone: "warn" });
      if (s.make_permanent) tags.push({ text: "Never expires", tone: "ok" });
      const description = s.dest_label
        ? `Scheduled for ${s.dest_label}. Load it back to edit or reschedule.`
        : "One-time scheduled post. Load it back to edit or reschedule.";
      return {
        kind: "scheduled",
        key: `sched:${s.id}`,
        emoji: "🕒",
        name,
        description,
        message,
        previewPending: !sched.messages.has(s.id),
        accent: ACCENT_INDIGO,
        badge: paused ? "Paused" : "Scheduled",
        metaText: paused ? `Paused · ${when}` : `Posts ${when}`,
        tags,
        search: searchHaystack(
          name,
          description,
          paused ? "Paused" : "Scheduled",
          message ? messageSearchText(message) : undefined,
        ),
        onPick: () => {
          const m = sched.messages.get(s.id);
          if (!m) {
            pushToast("That post's message isn't available to load.", "error");
            return;
          }
          replaceMessage(m);
          closeGallery();
          const validation = validateMessage(m);
          pushToast(
            validation.ok
              ? "Loaded the scheduled message into the editor."
              : `Loaded with ${validation.issues.length} validation issue${validation.issues.length === 1 ? "" : "s"}.`,
            validation.ok ? "success" : "info",
          );
        },
        onDelete: () => setPendingDelete({ kind: "scheduled", id: s.id, name, schedule: s }),
      };
    });
  }, [scheduleOn, sched.upcoming, sched.messages, replaceMessage, closeGallery]);

  // Chip row: Posted, the two draft shelves (this browser / server library —
  // each only when there are any), then a single Template chip for the whole
  // curated set (categories no longer split). Posted also shows when the only
  // thing to manage is orphaned never-expire slots — with no card holding
  // them, this tab's strip is the one place they can still be freed.
  // The Scheduled chip shows when the server has any scheduled posts (upcoming
  // or history), or when the gallery was opened straight onto it (so the
  // account-menu / Send-panel hand-off always lands on a real, if empty, tab).
  const hasScheduled =
    scheduleOn &&
    (sched.upcoming.length > 0 || sched.history.length > 0 || filter === SCHEDULED_FILTER);
  const filters: Filter[] = useMemo(
    () => [
      ...(postedCards.length || orphanSlots.length ? [POSTED_FILTER] : []),
      ...(hasScheduled ? [SCHEDULED_FILTER] : []),
      ...(libraryDraftCards.length ? [SERVER_DRAFTS_FILTER] : []),
      ...(savedCards.length ? [BROWSER_DRAFTS_FILTER] : []),
      ...(templateCards.length ? [TEMPLATE_FILTER] : []),
    ],
    [
      postedCards.length,
      orphanSlots.length,
      hasScheduled,
      savedCards.length,
      libraryDraftCards.length,
      templateCards.length,
    ],
  );
  const firstFilter = filters[0] ?? TEMPLATE_FILTER;
  const activeFilter = filters.includes(filter) ? filter : firstFilter;
  // The first render after a tab/search switch still carries the previous
  // page count. Clamp it synchronously so a deeply scrolled shelf cannot
  // over-hydrate the new shelf before the reset effect runs.
  const visibleScopeRef = useRef({ filter: activeFilter, query: deferredQuery });
  const visibleScopeChanged =
    visibleScopeRef.current.filter !== activeFilter ||
    visibleScopeRef.current.query !== deferredQuery;
  const effectiveVisibleCount = visibleScopeChanged ? CARD_PAGE_SIZE : visibleCount;

  const activeLibraryLabel =
    activeFilter === POSTED_FILTER
      ? "posted"
      : activeFilter === SERVER_DRAFTS_FILTER
        ? "draft"
        : null;
  const activeLibraryEntries = useMemo(
    () =>
      activeLibraryLabel ? serverEntries.filter((entry) => entry.label === activeLibraryLabel) : [],
    [serverEntries, activeLibraryLabel],
  );
  // Normal browsing decrypts only the currently revealable card pages. A body
  // search is the one operation that genuinely needs every message in the
  // active shelf, so it explicitly hydrates the remaining rows in sequential,
  // bounded batches before reporting final results.
  useEffect(() => {
    if (!connectedGuildId || !activeLibraryLabel || libDetailError) return;
    const needsBodySearch = deferredQuery.trim().length > 0;
    const ids = pendingLibraryDetailIds(
      activeLibraryEntries,
      needsBodySearch ? null : effectiveVisibleCount,
    );
    if (ids.length > 0) void hydrateLibrary(connectedGuildId, ids);
  }, [
    connectedGuildId,
    activeLibraryLabel,
    activeLibraryEntries,
    deferredQuery,
    effectiveVisibleCount,
    hydrateLibrary,
    libDetailError,
  ]);
  const librarySearchPending =
    deferredQuery.trim().length > 0 &&
    activeLibraryLabel !== null &&
    !libDetailError &&
    activeLibraryEntries.some((entry) => !libraryEntryHasDetails(entry));
  const retryLibraryDetails = useCallback(() => {
    if (!connectedGuildId || !activeLibraryLabel) return;
    const bodySearch = deferredQuery.trim().length > 0;
    const ids = pendingLibraryDetailIds(
      activeLibraryEntries,
      bodySearch ? null : effectiveVisibleCount,
    );
    useLibraryStore.setState({ detailError: null });
    if (ids.length > 0) void hydrateLibrary(connectedGuildId, ids);
  }, [
    connectedGuildId,
    activeLibraryLabel,
    activeLibraryEntries,
    deferredQuery,
    effectiveVisibleCount,
    hydrateLibrary,
  ]);

  // Keep the arrow affordances honest as categories load or the dialog resizes.
  // When opened directly to a category near the end, reveal that active chip
  // instead of leaving it clipped beyond the right edge.
  useEffect(() => {
    const row = chipsRef.current;
    if (!row) return;

    const frame = requestAnimationFrame(() => {
      const activeChip = row.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
      if (activeChip) {
        const chipLeft = activeChip.offsetLeft;
        const chipRight = chipLeft + activeChip.offsetWidth;
        if (chipLeft < row.scrollLeft) {
          row.scrollTo({ left: chipLeft });
        } else if (chipRight > row.scrollLeft + row.clientWidth) {
          row.scrollTo({ left: chipRight - row.clientWidth });
        }
      }
      updateChipScroll();
    });

    const resizeObserver = new ResizeObserver(updateChipScroll);
    resizeObserver.observe(row);
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
    };
  }, [activeFilter, filters, updateChipScroll]);

  // Posted history is server-fed, so on a cold open the library hasn't
  // answered yet and the Posted/Server-drafts chips don't exist *yet* — that's
  // not the same as the tab being empty. Hold a requested library-backed
  // filter until the load settles so the gallery can land on it once the
  // entries arrive, instead of falling through to Templates on every open.
  const libraryPending =
    libraryOn && !!connectedGuildId && !(libGuild === connectedGuildId && libLoaded);
  // Likewise for a requested Scheduled tab — the schedule list is fetched on
  // open, so hold on Scheduled until it settles instead of bouncing to Posted.
  const schedulePending = scheduleOn && !sched.loaded;

  // Which chips exist and which tab the gallery lands on are both server
  // answers, so painting real content before they arrive meant opening on
  // Templates and swapping to Posted a beat later. Instead the directory holds
  // one skeleton pass until the server-fed lists settle — and once revealed it
  // never goes back (later refreshes merge in place). Without a connected
  // server there's nothing to wait for and the reveal is immediate.
  const directoryPending = libraryPending || (scheduleOn && !!connectedGuildId && !sched.loaded);
  const [revealed, setRevealed] = useState(() => !directoryPending);
  useEffect(() => {
    if (!directoryPending) setRevealed(true);
  }, [directoryPending]);
  // Fail-open: a hung request must never hold the skeleton hostage — reveal
  // whatever has arrived and let the usual fail-soft states take over.
  useEffect(() => {
    if (revealed) return;
    const t = setTimeout(() => setRevealed(true), 4000);
    return () => clearTimeout(t);
  }, [revealed]);

  // If the requested filter disappears (e.g. last saved message removed), fall
  // through to the first real chip so the gallery never opens on a combined view.
  useEffect(() => {
    if (libraryPending && (filter === POSTED_FILTER || filter === SERVER_DRAFTS_FILTER)) return;
    if (schedulePending && filter === SCHEDULED_FILTER) return;
    if (filter !== activeFilter) setFilter(activeFilter);
  }, [activeFilter, filter, libraryPending, schedulePending]);

  const shown = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    let base: CardData[];
    if (activeFilter === POSTED_FILTER) {
      base = postedCards;
    } else if (activeFilter === SCHEDULED_FILTER) {
      base = scheduledCards;
    } else if (activeFilter === BROWSER_DRAFTS_FILTER) {
      base = savedCards;
    } else if (activeFilter === SERVER_DRAFTS_FILTER) {
      base = libraryDraftCards;
    } else {
      // TEMPLATE_FILTER — the whole curated set, no per-category split.
      base = templateCards;
    }
    return q ? base.filter((c) => c.search.includes(q)) : base;
  }, [
    activeFilter,
    deferredQuery,
    postedCards,
    scheduledCards,
    savedCards,
    libraryDraftCards,
    templateCards,
  ]);

  // The grid mounts in pages — a new tab or search starts back at one page,
  // and the sentinel at the grid's tail reveals the next as the user nears it.
  useEffect(() => {
    visibleScopeRef.current = { filter: activeFilter, query: deferredQuery };
    setVisibleCount(CARD_PAGE_SIZE);
  }, [activeFilter, deferredQuery]);
  const visibleCards =
    shown.length > effectiveVisibleCount ? shown.slice(0, effectiveVisibleCount) : shown;
  const revealMore = useCallback(() => setVisibleCount((n) => n + CARD_PAGE_SIZE), []);

  const startBlank = () => {
    clearAll();
    closeGallery();
    pushToast("Started a blank message", "info");
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    if (pendingDelete.kind === "scheduled" && pendingDelete.schedule) {
      void sched
        .cancel(pendingDelete.schedule)
        .then((ok) =>
          pushToast(
            ok ? "Scheduled post canceled." : "Couldn't cancel it — try again.",
            ok ? "success" : "error",
          ),
        );
    } else if (pendingDelete.kind === "library" && pendingDelete.guildId) {
      const { guildId, id } = pendingDelete;
      void removeLibrary(guildId, id).then((ok) => {
        pushToast(
          ok ? "Removed from the server library" : "Couldn't remove it — try again.",
          ok ? "info" : "error",
        );
      });
    } else {
      const removed = removeEntry(pendingDelete.id);
      pushToast(
        removed
          ? `Deleted "${pendingDelete.name}"`
          : `Couldn't delete "${pendingDelete.name}" — check browser storage and try again.`,
        removed ? "info" : "error",
      );
    }
    setPendingDelete(null);
  };

  return createPortal(
    <>
      <div
        className={styles.backdrop}
        role="dialog"
        aria-modal="true"
        aria-label="Message directory"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) closeGallery();
        }}
      >
        <div ref={panelRef} className={styles.panel}>
          <header className={styles.header}>
            <div className={styles.headingRow}>
              <div className={styles.heading}>
                <h2 className={styles.title}>
                  {connectedGuildName ? (
                    <GuildIdentity
                      guildId={connectedGuildId}
                      fallbackName={connectedGuildName}
                      label="Discord server"
                      compact
                    />
                  ) : (
                    <span className={styles.titleSpark} aria-hidden>
                      <SparkleIcon size={17} />
                    </span>
                  )}
                  Message directory
                </h2>
                <p className={styles.subtitle}>
                  Reload a posted message, reuse a saved one, or pick a template — everything is
                  fully editable.
                </p>
              </div>
              <button
                type="button"
                className={styles.close}
                onClick={closeGallery}
                aria-label="Close message directory"
              >
                <CloseIcon size={20} />
              </button>
            </div>

            <nav className={styles.discoveryLinks} aria-label="Explore DWEEB">
              <a href="/discord-webhook-builder/">Webhook builder</a>
              <a href="/templates/">Templates</a>
              <a href="/features/">Features</a>
              <a href="/guides/">Guides</a>
            </nav>

            <div className={styles.controls}>
              <div className={styles.search}>
                <SearchIcon size={16} className={styles.searchIcon} aria-hidden />
                <input
                  ref={searchRef}
                  type="text"
                  name="templateSearch"
                  className={styles.searchInput}
                  value={query}
                  onChange={(e) => setQuery(e.currentTarget.value)}
                  placeholder={
                    !revealed || postedCards.length || savedCards.length
                      ? "Search your messages & templates…"
                      : `Search ${TEMPLATES.length} templates…`
                  }
                  aria-label="Search messages and templates"
                />
                {query ? (
                  <button
                    type="button"
                    className={styles.searchClear}
                    onClick={() => {
                      setQuery("");
                      searchRef.current?.focus();
                    }}
                    aria-label="Clear search"
                  >
                    <CloseIcon size={14} />
                  </button>
                ) : null}
              </div>

              <div className={styles.chipScroller}>
                {chipScroll.left ? (
                  <button
                    type="button"
                    className={`${styles.chipScrollButton} ${styles.chipScrollLeft}`}
                    onClick={() => scrollChips(-1)}
                    aria-label="Show previous categories"
                    title="Previous categories"
                  >
                    <ChevronRightIcon size={17} aria-hidden />
                  </button>
                ) : null}

                <div
                  ref={chipsRef}
                  className={styles.chips}
                  role="group"
                  aria-label="Filter templates by category"
                  onScroll={updateChipScroll}
                >
                  {!revealed ? (
                    <GalleryChipsSkeleton />
                  ) : (
                    filters.map((f) => (
                      <button
                        key={f}
                        type="button"
                        aria-pressed={activeFilter === f}
                        className={[
                          styles.chip,
                          // The Saved/Posted pseudo-categories carry their own tints
                          // (teal / green) so a user's own messages stand out from the
                          // curated template categories.
                          f === BROWSER_DRAFTS_FILTER || f === SERVER_DRAFTS_FILTER
                            ? styles.chipSaved
                            : "",
                          f === POSTED_FILTER ? styles.chipPosted : "",
                          f === SCHEDULED_FILTER ? styles.chipScheduled : "",
                          activeFilter === f ? styles.chipActive : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        onClick={() => setFilter(f)}
                      >
                        {f}
                      </button>
                    ))
                  )}
                </div>

                {chipScroll.right ? (
                  <button
                    type="button"
                    className={`${styles.chipScrollButton} ${styles.chipScrollRight}`}
                    onClick={() => scrollChips(1)}
                    aria-label="Show more categories"
                    title="More categories"
                  >
                    <ChevronRightIcon size={17} aria-hidden />
                  </button>
                ) : null}
              </div>
            </div>
          </header>

          <div className={styles.body} aria-busy={!revealed || undefined}>
            {!revealed ? (
              <GalleryGridSkeleton />
            ) : (
              <>
                {/* Per-tab usage read-out, moved out of the shared footer so each
                tab shows only its own numbers. A quiet line above the list, not
                a box, so it doesn't compete with the never-expire / scheduled
                strips below. Shown once the shelf has loaded for the connected
                server (a non-manager never sees a meter for a list they can't
                read). */}
                {connectedGuildId && libGuild === connectedGuildId && libLoaded ? (
                  <>
                    {activeFilter === POSTED_FILTER ? (
                      <p
                        className={styles.tabMeter}
                        title="Posted messages sync automatically — the newest posts, oldest roll off. Never-expire messages stay put."
                      >
                        <strong>Posted history:</strong>{" "}
                        {Math.max(0, libPosted.used - pinnedPostedCount)}
                        {libPosted.quota != null ? ` / ${libPosted.quota}` : ""}
                      </p>
                    ) : null}
                    {activeFilter === SERVER_DRAFTS_FILTER ? (
                      <p
                        className={styles.tabMeter}
                        data-over={
                          libDrafts.quota != null && libDrafts.used > libDrafts.quota
                            ? ""
                            : undefined
                        }
                        title={
                          libDrafts.quota != null && libDrafts.used > libDrafts.quota
                            ? "More server drafts than the plan allows — they stay readable, but content can't be changed until you delete down to the limit or upgrade."
                            : "Server drafts are yours to add and remove."
                        }
                      >
                        <strong>Server drafts:</strong> {libDrafts.used}
                        {libDrafts.quota != null ? ` / ${libDrafts.quota}` : ""}
                        {libDrafts.quota != null && libDrafts.used > libDrafts.quota
                          ? " · over limit"
                          : ""}
                      </p>
                    ) : null}
                  </>
                ) : null}

                {/* The Posted tab doubles as the never-expire slot manager: usage,
                the upgrade path when full, and any slots whose message has no
                card here (nothing else could free those). Hidden when the
                feature is off or this user can't manage the server's slots. */}
                {activeFilter === POSTED_FILTER && canManageSlots && permanent ? (
                  <div className={styles.slotStrip}>
                    <div className={styles.slotStripHead}>
                      <span className={styles.slotStripText}>
                        <strong>Never expire:</strong>{" "}
                        {isUnlimitedCap(permanent.cap)
                          ? `${permanent.used} used`
                          : `${permanent.used}/${permanent.cap} slots used`}
                        {" · "}buttons &amp; selects stop working after {permanent.ttl_days} days
                        without use unless the message holds a slot — assign or free one right on
                        its card.
                      </span>
                      {!isUnlimitedCap(permanent.cap) && permanent.used >= permanent.cap ? (
                        <button
                          type="button"
                          className={styles.slotStripUpgrade}
                          onClick={() => {
                            closeGallery();
                            if (connectedGuildId)
                              usePlanStore.getState().openPricing(connectedGuildId);
                          }}
                        >
                          Upgrade for more
                        </button>
                      ) : null}
                    </div>
                    {permanent.suspended ? (
                      <p className={styles.slotStripNote}>
                        {permanent.suspended} never-expire{" "}
                        {permanent.suspended === 1 ? "message is" : "messages are"} paused — the
                        server holds more than its current plan allows. Nothing was deleted;
                        upgrading restores the oldest ones first.
                      </p>
                    ) : null}
                    {orphanSlots.length > 0 ? (
                      <div className={styles.orphanBlock}>
                        <p className={styles.slotStripNote}>
                          {orphanSlots.length === 1
                            ? "1 never-expire slot points at a message"
                            : `${orphanSlots.length} never-expire slots point at messages`}{" "}
                          that {orphanSlots.length === 1 ? "isn't" : "aren't"} in this history —
                          free
                          {orphanSlots.length === 1 ? " it" : " them"} here if the message is gone.
                        </p>
                        <ul className={styles.orphanList}>
                          {orphanSlots.map((item) => {
                            const url = `https://discord.com/channels/${connectedGuildId}/${item.channel_id}/${item.message_id}`;
                            return (
                              <li key={item.message_id} className={styles.orphanItem}>
                                <a
                                  className={styles.orphanLink}
                                  href={url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(ev) => handleDiscordLinkClick(ev, url)}
                                >
                                  Open on Discord ↗
                                </a>
                                {item.suspended ? (
                                  <span className={styles.orphanPaused}>Paused</span>
                                ) : null}
                                <span className={styles.orphanMeta}>
                                  added{" "}
                                  {new Date(item.added_at).toLocaleDateString([], {
                                    dateStyle: "medium",
                                  })}
                                </span>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={slotBusy}
                                  title="Puts the message back on the expiry clock, counted from its last use"
                                  onClick={() => void freeNeverExpire(item.message_id)}
                                >
                                  Free slot
                                </Button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/* The Scheduled tab's usage line — its own version of the Posted
                slot strip: how many timed posts are live against the plan cap,
                with the same upgrade hop when the server is at the limit. */}
                {activeFilter === SCHEDULED_FILTER &&
                (sched.upcoming.length > 0 || sched.history.length > 0) ? (
                  <div className={styles.slotStrip}>
                    <div className={styles.slotStripHead}>
                      <span className={styles.slotStripText}>
                        <strong>Scheduled posts:</strong>{" "}
                        {sched.quota != null
                          ? `${sched.activeCount}/${sched.quota} used`
                          : `${sched.activeCount} active`}
                        {" · "}each fires once at its set time, then drops into the history below.
                      </span>
                      {sched.quota != null && sched.activeCount >= sched.quota ? (
                        <button
                          type="button"
                          className={styles.slotStripUpgrade}
                          onClick={() => {
                            closeGallery();
                            if (connectedGuildId)
                              usePlanStore.getState().openPricing(connectedGuildId);
                          }}
                        >
                          Upgrade for more
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {libDetailError && activeLibraryLabel ? (
                  <GalleryDetailError
                    bodySearch={deferredQuery.trim().length > 0}
                    onRetry={retryLibraryDetails}
                  />
                ) : null}

                {librarySearchPending ? (
                  <GalleryGridSkeleton
                    cards={Math.min(8, Math.max(3, activeLibraryEntries.length))}
                  />
                ) : shown.length > 0 ? (
                  <div className={styles.grid}>
                    {visibleCards.map((c, i) => (
                      <GalleryCard
                        key={c.key}
                        card={c}
                        eagerThumb={i < EAGER_THUMBNAILS}
                        priorityThumb={i === 0}
                      />
                    ))}
                    {shown.length > visibleCards.length ? (
                      // Keyed on the revealed count so each reveal re-arms a fresh
                      // sentinel for the following page.
                      <LoadMoreSentinel
                        key={visibleCards.length}
                        remaining={shown.length - visibleCards.length}
                        onReveal={revealMore}
                      />
                    ) : null}
                  </div>
                ) : activeFilter === SCHEDULED_FILTER &&
                  sched.history.length > 0 &&
                  !query.trim() ? (
                  // Nothing upcoming, but the history section below still has rows.
                  <p className={styles.emptyInline}>
                    No upcoming scheduled posts — history is below.
                  </p>
                ) : (
                  <div className={styles.empty}>
                    <SearchIcon size={28} aria-hidden />
                    {query.trim() ? (
                      <>
                        <p className={styles.emptyTitle}>No matches for “{query.trim()}”.</p>
                        <button
                          type="button"
                          className={styles.emptyReset}
                          onClick={() => {
                            setQuery("");
                          }}
                        >
                          Clear search
                        </button>
                      </>
                    ) : activeFilter === SCHEDULED_FILTER ? (
                      <p className={styles.emptyTitle}>No scheduled posts yet.</p>
                    ) : (
                      // Reachable on the Posted tab when it exists only for the
                      // orphaned-slot strip above — no posted cards to show yet.
                      <p className={styles.emptyTitle}>No posted messages in this history yet.</p>
                    )}
                  </div>
                )}

                {/* Posted / failed schedules have no message to preview (the server
                deletes it once it fires), so they live as compact rows below the
                upcoming grid — view on Discord, remove, or clear the lot. */}
                {activeFilter === SCHEDULED_FILTER && sched.history.length > 0 ? (
                  <div className={styles.scheduleHistoryWrap}>
                    <ScheduleHistory
                      history={sched.history}
                      ttlDays={permanent?.ttl_days ?? null}
                      retentionDays={sched.retentionDays}
                      busyId={sched.busyId}
                      onRemove={(s) => {
                        void sched.cancel(s).then((ok) => {
                          if (!ok) pushToast("Couldn't remove it — try again.", "error");
                        });
                      }}
                      onClear={async () => {
                        const failed = await sched.clearHistory(sched.history);
                        pushToast(
                          failed === 0
                            ? "Cleared posted & failed schedules."
                            : `Cleared some; ${failed} couldn't be removed.`,
                          failed === 0 ? "success" : "info",
                        );
                      }}
                    />
                  </div>
                ) : null}
              </>
            )}
          </div>

          <footer className={styles.footer}>
            <span className={styles.footerHint}>
              {revealed
                ? `${shown.length} ${shown.length === 1 ? "result" : "results"}`
                : "Loading your messages…"}
            </span>
            <button type="button" className={styles.blankBtn} onClick={startBlank}>
              <PlusIcon size={16} />
              Start from scratch
            </button>
          </footer>
        </div>
      </div>

      <Modal
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        title={
          pendingDelete?.kind === "scheduled"
            ? "Cancel scheduled post?"
            : pendingDelete?.kind === "library"
              ? pendingDelete.posted
                ? "Remove from posted history?"
                : "Remove from the server library?"
              : "Delete browser draft?"
        }
        size="sm"
        // The gallery overlay sits at --app-z-tooltip; lift the confirm above it
        // so it (and its scrim) land on top rather than behind the gallery.
        backdropStyle={{ zIndex: "calc(var(--app-z-tooltip) + 10)" }}
      >
        <div className={styles.confirmBody}>
          <p className={styles.confirmText}>
            {pendingDelete?.kind === "scheduled" ? (
              <>
                Cancel <strong>{pendingDelete?.name}</strong>? It won't be posted. This can't be
                undone — you'd have to schedule it again.
              </>
            ) : pendingDelete?.kind === "library" ? (
              pendingDelete.posted ? (
                <>
                  Remove <strong>{pendingDelete?.name}</strong> from this server's posted history
                  now? It won't wait to roll off on its own — every manager loses the entry (the
                  message stays live on Discord). This can't be undone.
                </>
              ) : (
                <>
                  Remove <strong>{pendingDelete?.name}</strong> from the server library? Everyone
                  managing this server loses this entry (a posted message stays live on Discord).
                  This can't be undone.
                </>
              )
            ) : (
              <>
                Permanently delete <strong>"{pendingDelete?.name}"</strong>? This can't be undone.
              </>
            )}
          </p>
          <div className={styles.confirmActions}>
            <Button variant="ghost" type="button" onClick={() => setPendingDelete(null)}>
              {pendingDelete?.kind === "scheduled" ? "Keep it" : "Cancel"}
            </Button>
            <Button
              variant="danger"
              type="button"
              leadingIcon={<TrashIcon />}
              onClick={confirmDelete}
            >
              {pendingDelete?.kind === "saved"
                ? "Delete"
                : pendingDelete?.kind === "scheduled"
                  ? "Cancel post"
                  : "Remove"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!pendingFreeSlot}
        onClose={() => setPendingFreeSlot(null)}
        title="Turn off never-expire?"
        size="sm"
        backdropStyle={{ zIndex: "calc(var(--app-z-tooltip) + 10)" }}
      >
        <div className={styles.confirmBody}>
          <p className={styles.confirmText}>
            Free <strong>{pendingFreeSlot?.name}</strong>'s never-expire slot? Its buttons &amp;
            selects go back on the {permanent?.ttl_days ? `${permanent.ttl_days}-day ` : ""}expiry
            clock — counted from its last use, so a long-idle message's may lapse right away — and
            it rejoins the rolling history, where newer posts can push it off. You can re-pin it
            later if a slot is free.
          </p>
          <div className={styles.confirmActions}>
            <Button variant="ghost" type="button" onClick={() => setPendingFreeSlot(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              type="button"
              disabled={slotBusy}
              onClick={() => {
                if (pendingFreeSlot) void freeNeverExpire(pendingFreeSlot.messageId);
                setPendingFreeSlot(null);
              }}
            >
              Free slot
            </Button>
          </div>
        </div>
      </Modal>
    </>,
    document.body,
  );
}
