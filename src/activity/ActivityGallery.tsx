/**
 * Activity "Message directory" — the embedded surface's version of the web
 * app's full-screen gallery, sharing its card layer (`galleryCards`) and CSS
 * so the two can't drift apart: the same searchable grid of live, faithful
 * thumbnails, mounted in pages so a large (Plus/Pro) shelf opens instantly.
 *
 * Four chips instead of the web's five:
 *  - **Posted** — the target server's shared library history; picking one
 *    re-wires the toolbar to update the live message in place
 *    (`activityStore.loadLibraryEntry`).
 *  - **Scheduled** — the server's upcoming one-time posts (created from the
 *    post confirm's "When → Schedule" choice) with live previews + cancel,
 *    and the posted/failed history below — the same view the web gallery
 *    shows, riding the same hook (`useScheduledPosts`; the schedule API sends
 *    the Activity bearer via `proxyFetch`).
 *  - **Server drafts** — the library's saved messages, shared with everyone
 *    who manages this server.
 *  - **Template** — the curated starting points, loaded straight into the
 *    room's shared editor.
 *
 * Posted cards carry the web gallery's never-expire pin chip — assign & free
 * slots on-card, through the Activity's bearer twin endpoints. Deliberately
 * absent: **Browser drafts** (localStorage isn't a surface inside Discord's
 * iframe — nothing local exists here by design) and the orphan-slot strip
 * (slots whose message left the history; the web gallery frees those).
 *
 * Rendered as a full-screen overlay via portal, exactly like the web gallery;
 * mounted only while open (see ActivityBar), so state resets per visit.
 */

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useActivityStore } from "@/core/activity/activityStore";
import { useMessageStore } from "@/core/state/messageStore";
import {
  libraryEntryHasDetails,
  libraryEntryMessage,
  libraryEntrySearchText,
  pendingLibraryDetailIds,
  useLibraryStore,
} from "@/core/library/libraryStore";
import type { PermanentSlots } from "@/core/guild/api";
import {
  addActivityPermanentMessage,
  fetchActivityPermanentSlots,
  removeActivityPermanentMessage,
} from "@/core/activity/api";
import { interactiveComponents } from "@/core/plugins/targets";
import { TEMPLATES, type MessageTemplate } from "@/data/presets";
import { isScheduleConfigured, type ScheduleView } from "@/core/schedule/api";
import { useScheduledPosts } from "@/core/schedule/useScheduledPosts";
import { formatInstant } from "@/core/schedule/recurrence";
import { ScheduleHistory } from "@/features/templates/GalleryScheduled";
import { validateMessage } from "@/core/schema/validation";
import { openExternalLink } from "@/core/activity/sdk";
import { Button } from "@/ui/Button";
import { Modal } from "@/ui/Modal";
import { CloseIcon, PlusIcon, SearchIcon, SparkleIcon, TrashIcon } from "@/ui/Icon";
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
} from "@/features/templates/galleryCards";
import { ServerGlyph } from "./GuildPicker";
import styles from "@/features/templates/TemplateGallery.module.css";

const POSTED_FILTER = "Posted" as const;
const SCHEDULED_FILTER = "Scheduled" as const;
const SERVER_DRAFTS_FILTER = "Server drafts" as const;
const TEMPLATE_FILTER = "Template" as const;
type Filter =
  | typeof POSTED_FILTER
  | typeof SCHEDULED_FILTER
  | typeof SERVER_DRAFTS_FILTER
  | typeof TEMPLATE_FILTER;

const ACCENT_TEAL = 0x1abc9c;
const ACCENT_GREEN = 0x3ba55d;
const ACCENT_INDIGO = 0x5865f2;

export function ActivityGallery({ onClose }: { onClose: () => void }) {
  const targetGuildId = useActivityStore((s) => s.targetGuildId);
  const targetGuildMeta = useActivityStore((s) => s.targetGuildMeta);
  const loadEntry = useActivityStore((s) => s.loadLibraryEntry);
  const replaceMessage = useMessageStore((s) => s.replaceMessage);
  const clearAll = useMessageStore((s) => s.clearAll);

  const libEntries = useLibraryStore((s) => s.entries);
  const libGuild = useLibraryStore((s) => s.guildId);
  const libPosted = useLibraryStore((s) => s.posted);
  const libDrafts = useLibraryStore((s) => s.drafts);
  const libLoaded = useLibraryStore((s) => s.loaded);
  const libDetailError = useLibraryStore((s) => s.detailError);
  const hydrateLibrary = useLibraryStore((s) => s.hydrate);
  const removeLibrary = useLibraryStore((s) => s.remove);

  // (Re)load the target server's shelf on open — posts from teammates or the
  // web app should show up without a relaunch.
  useEffect(() => {
    if (targetGuildId) void useLibraryStore.getState().refresh(targetGuildId);
  }, [targetGuildId]);

  // Never-expire slot state for the target server — posted cards carry the same
  // assign/free pin chip as the web gallery. Through the Activity's bearer-gated
  // twin endpoints: the web app's `/api/guilds/:id/permanent` is cookie-only and
  // 401s inside Discord's iframe. Fail-soft: a 501 (feature off) or 403 just
  // hides the chips, leaving the gallery a plain shelf.
  const [permanent, setPermanent] = useState<PermanentSlots | null>(null);
  const [slotBusy, setSlotBusy] = useState(false);
  useEffect(() => {
    if (!targetGuildId) {
      setPermanent(null);
      return;
    }
    const ac = new AbortController();
    fetchActivityPermanentSlots(targetGuildId, ac.signal)
      .then(setPermanent)
      .catch(() => setPermanent(null));
    return () => ac.abort();
  }, [targetGuildId]);

  // Claim a never-expire slot for a posted message, straight from its card.
  // Always asks the server (idempotent, and the local `used/cap` may be stale);
  // a 409 "all slots taken" comes back with the fresh state instead of throwing.
  const assignNeverExpire = useCallback(
    async (messageId: string, channelId: string) => {
      if (!targetGuildId) return;
      setSlotBusy(true);
      try {
        const res = await addActivityPermanentMessage(targetGuildId, messageId, channelId);
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
    [targetGuildId],
  );

  // Give a slot back. The message returns to the expiry clock, counted from
  // its send date — an old message's buttons may expire right away.
  const freeNeverExpire = useCallback(
    async (messageId: string) => {
      if (!targetGuildId) return;
      setSlotBusy(true);
      try {
        setPermanent(await removeActivityPermanentMessage(targetGuildId, messageId));
        pushToast("Slot freed — the message is back on the expiry clock.", "info");
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error");
      } finally {
        setSlotBusy(false);
      }
    },
    [targetGuildId],
  );

  // Freeing a never-expire slot goes through its own confirm — freeing is
  // meaningful (the message drops back onto the expiry clock) and, with no hover
  // to warn on touch, a bare tap on the chip must not silently remove it.
  const [pendingFreeSlot, setPendingFreeSlot] = useState<{
    messageId: string;
    name: string;
    paused: boolean;
  } | null>(null);

  const [query, setQuery] = useState("");
  // Filtering runs against the deferred value so typing stays responsive even
  // when a keystroke re-filters (and re-renders) a large deck.
  const deferredQuery = useDeferredValue(query);
  const [filter, setFilter] = useState<Filter>(POSTED_FILTER);
  const [visibleCount, setVisibleCount] = useState(CARD_PAGE_SIZE);
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    guildId: string;
    name: string;
    /** A `posted` history entry (vs a server draft) — the confirm frames it as
     *  pruning the shared history now rather than waiting for it to roll off. */
    posted: boolean;
    /** Set for a scheduled post — the confirm cancels it instead of removing a
     *  library entry. */
    schedule?: ScheduleView;
  } | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // The target server's scheduled (one-time) posts — the Scheduled tab. Same
  // hook the web gallery uses; inside the Activity the API rides the bearer
  // (proxyFetch), so a Manage-Webhooks member sees the whole server's list.
  // Payload fetches (for the preview thumbnails) only run on that tab.
  const scheduleOn = isScheduleConfigured();
  const sched = useScheduledPosts(
    targetGuildId ?? undefined,
    scheduleOn,
    filter === SCHEDULED_FILTER,
  );

  // Focus search on open so a user can start typing immediately.
  useEffect(() => {
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

  // Escape closes the gallery from anywhere within it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The target server's library entries — only when the loaded library actually
  // matches the target (a switch mid-load must not show another server's shelf).
  const serverEntries = useMemo(
    () => (libGuild && libGuild === targetGuildId ? libEntries : []),
    [libGuild, targetGuildId, libEntries],
  );

  const serverName = targetGuildMeta?.name;
  const grantIds = useMemo(
    () => new Set((permanent?.items ?? []).map((i) => i.message_id)),
    [permanent],
  );
  const permanentIds = useMemo(
    () => new Set((permanent?.items ?? []).filter((i) => !i.suspended).map((i) => i.message_id)),
    [permanent],
  );
  const canManageSlots = permanent != null && permanent.ttl_days != null && !!targetGuildId;

  const { postedCards, draftCards } = useMemo(() => {
    const posted: CardData[] = [];
    const drafts: CardData[] = [];
    for (const entry of serverEntries) {
      const hasDetails = libraryEntryHasDetails(entry);
      const message = hasDetails ? libraryEntryMessage(entry) : null;
      if (hasDetails && !message) continue;
      const isPosted = entry.label === "posted";
      const interactive = message ? interactiveComponents(message).length > 0 : false;
      const displayName =
        entry.title?.trim() || entry.dest_label || (isPosted ? "Posted message" : "Server draft");
      const holdsSlot = isPosted && !!entry.message_id && grantIds.has(entry.message_id);
      // The pin chip: ONE control that both shows never-expire state and
      // toggles it — the same behaviour as the web gallery. A held slot (even a
      // plan-paused one) opens a confirm before freeing; an interactive message
      // without a slot claims one on tap (additive, no confirm). A message with
      // no components has nothing to keep alive, so it gets no chip.
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
              : "This message never expires and stays in this history. Tap to free the slot — it goes back on the expiry clock, counted from its send date.",
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
              serverName ?? "server"
            } history — load it and edits update the live message in place.`
        : `A saved message in the ${serverName ?? "server"} library, shared with this server's managers.`;
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
        pin,
        search: searchHaystack(
          displayName,
          description,
          isPosted ? "Posted" : "Server draft",
          message ? libraryEntrySearchText(entry) : undefined,
        ),
        onPick: () => {
          void (async () => {
            const full = hasDetails
              ? entry
              : await useLibraryStore.getState().hydrateOne(entry.guild_id, entry.id);
            // loadLibraryEntry loads into the shared editor (collab broadcasts
            // to the room), re-wires Update-in-place for a posted entry, and
            // toasts.
            if (full && loadEntry(full)) {
              onClose();
            } else {
              pushToast(
                "This entry couldn't be read — it may predate a server key change.",
                "error",
              );
            }
          })();
        },
        onDelete: holdsSlot
          ? undefined
          : () =>
              setPendingDelete({
                id: entry.id,
                guildId: entry.guild_id,
                name: displayName,
                posted: isPosted,
              }),
      };
      (isPosted ? posted : drafts).push(card);
    }
    return { postedCards: posted, draftCards: drafts };
  }, [
    serverEntries,
    serverName,
    loadEntry,
    onClose,
    grantIds,
    permanentIds,
    canManageSlots,
    slotBusy,
    assignNeverExpire,
  ]);

  // Upcoming scheduled posts, as gallery cards with a live preview — mirrors
  // the web gallery's Scheduled tab. The message (thumbnail + editor load) is
  // fetched lazily by the hook; until it lands the card shows a placeholder.
  // Picking one loads it into the room's shared editor; the trash cancels the
  // schedule (through the shared confirm below).
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
        ? `Scheduled for ${s.dest_label}. Load it back to keep editing together.`
        : "One-time scheduled post. Load it back to keep editing together.";
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
          onClose();
          const validation = validateMessage(m);
          pushToast(
            validation.ok
              ? "Loaded the scheduled message into the editor."
              : `Loaded with ${validation.issues.length} validation issue${validation.issues.length === 1 ? "" : "s"}.`,
            validation.ok ? "success" : "info",
          );
        },
        onDelete: () =>
          setPendingDelete({
            id: s.id,
            guildId: s.guild_id ?? "",
            name,
            posted: false,
            schedule: s,
          }),
      };
    });
  }, [scheduleOn, sched.upcoming, sched.messages, replaceMessage, onClose]);

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
          // Straight into the room's shared editor — the Activity has no plugin
          // setup checklist (that guided flow lives on the web), so the template
          // lands ready to edit together and post.
          replaceMessage(t.message);
          onClose();
          pushToast(`Loaded the "${t.name}" template — everything's editable.`, "success");
        },
      })),
    [replaceMessage, onClose],
  );

  // Chips only for tabs that have something to show; Template is always there.
  // The Scheduled chip shows when the server has any scheduled posts (upcoming
  // or history), or while it's the active tab (so it can't vanish mid-look).
  const hasScheduled =
    scheduleOn &&
    (sched.upcoming.length > 0 || sched.history.length > 0 || filter === SCHEDULED_FILTER);
  const filters: Filter[] = useMemo(
    () => [
      ...(postedCards.length ? [POSTED_FILTER] : []),
      ...(hasScheduled ? [SCHEDULED_FILTER] : []),
      ...(draftCards.length ? [SERVER_DRAFTS_FILTER] : []),
      TEMPLATE_FILTER,
    ],
    [postedCards.length, hasScheduled, draftCards.length],
  );
  const activeFilter = filters.includes(filter) ? filter : (filters[0] ?? TEMPLATE_FILTER);
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
  useEffect(() => {
    if (!targetGuildId || !activeLibraryLabel || libDetailError) return;
    const needsBodySearch = deferredQuery.trim().length > 0;
    const ids = pendingLibraryDetailIds(
      activeLibraryEntries,
      needsBodySearch ? null : effectiveVisibleCount,
    );
    if (ids.length > 0) void hydrateLibrary(targetGuildId, ids);
  }, [
    targetGuildId,
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
    if (!targetGuildId || !activeLibraryLabel) return;
    const bodySearch = deferredQuery.trim().length > 0;
    const ids = pendingLibraryDetailIds(
      activeLibraryEntries,
      bodySearch ? null : effectiveVisibleCount,
    );
    useLibraryStore.setState({ detailError: null });
    if (ids.length > 0) void hydrateLibrary(targetGuildId, ids);
  }, [
    targetGuildId,
    activeLibraryLabel,
    activeLibraryEntries,
    deferredQuery,
    effectiveVisibleCount,
    hydrateLibrary,
  ]);

  // On a cold open the library hasn't answered yet, so the Posted/Server-drafts
  // chips don't exist *yet* — hold the requested filter until the load settles
  // so the gallery lands on Posted once entries arrive instead of bouncing to
  // Templates on every open. Likewise hold a requested Scheduled tab until the
  // schedule list settles.
  const libraryPending = !!targetGuildId && !(libGuild === targetGuildId && libLoaded);
  const schedulePending = scheduleOn && !!targetGuildId && !sched.loaded;
  useEffect(() => {
    if (libraryPending && (filter === POSTED_FILTER || filter === SERVER_DRAFTS_FILTER)) return;
    if (schedulePending && filter === SCHEDULED_FILTER) return;
    if (filter !== activeFilter) setFilter(activeFilter);
  }, [activeFilter, filter, libraryPending, schedulePending]);

  // Which chips exist and which tab the gallery lands on are both server
  // answers, so painting real content before they arrive meant opening on
  // Templates and swapping to Posted a beat later. Instead the directory holds
  // one skeleton pass until the server-fed lists settle — and once revealed it
  // never goes back (later refreshes merge in place).
  const directoryPending = libraryPending || schedulePending;
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

  const shown = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const base =
      activeFilter === POSTED_FILTER
        ? postedCards
        : activeFilter === SCHEDULED_FILTER
          ? scheduledCards
          : activeFilter === SERVER_DRAFTS_FILTER
            ? draftCards
            : templateCards;
    return q ? base.filter((c) => c.search.includes(q)) : base;
  }, [activeFilter, deferredQuery, postedCards, scheduledCards, draftCards, templateCards]);

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
    onClose();
    pushToast("Started a blank message", "info");
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const { guildId, id, schedule } = pendingDelete;
    if (schedule) {
      void sched.cancel(schedule).then((ok) => {
        pushToast(
          ok ? "Scheduled post canceled." : "Couldn't cancel it — try again.",
          ok ? "info" : "error",
        );
      });
    } else {
      void removeLibrary(guildId, id).then((ok) => {
        pushToast(
          ok ? "Removed from the server library" : "Couldn't remove it — try again.",
          ok ? "info" : "error",
        );
      });
    }
    setPendingDelete(null);
  };

  return createPortal(
    <>
      <div
        className={styles.backdrop}
        role="dialog"
        aria-modal="true"
        aria-label={serverName ? `Message directory for ${serverName}` : "Message directory"}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className={styles.panel}>
          <header className={styles.header}>
            <div className={styles.headingRow}>
              <div className={styles.heading}>
                <h2 className={styles.title}>
                  {targetGuildMeta ? (
                    <span
                      className={styles.titleGlyph}
                      role="img"
                      aria-label={`Discord server: ${targetGuildMeta.name}`}
                      title={`Discord server: ${targetGuildMeta.name}`}
                    >
                      <ServerGlyph guild={targetGuildMeta} size={22} />
                    </span>
                  ) : (
                    <span className={styles.titleSpark} aria-hidden>
                      <SparkleIcon size={17} />
                    </span>
                  )}
                  Message directory
                </h2>
                <p className={styles.subtitle}>
                  Reload a posted message, reuse a saved one, or pick a template — everything is
                  fully editable, together.
                </p>
              </div>
              <button
                type="button"
                className={styles.close}
                onClick={onClose}
                aria-label="Close message directory"
              >
                <CloseIcon size={20} />
              </button>
            </div>

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
                    !revealed || postedCards.length || draftCards.length
                      ? "Search this server's messages & templates…"
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

              <div className={styles.chips} role="group" aria-label="Filter by category">
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
                        f === SERVER_DRAFTS_FILTER ? styles.chipSaved : "",
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
            </div>
          </header>

          <div className={styles.body} aria-busy={!revealed || undefined}>
            {!revealed ? (
              <GalleryGridSkeleton />
            ) : (
              <>
                {/* Per-tab usage read-out, mirroring the web gallery. Shown once the
                shelf has loaded for the target server. */}
                {targetGuildId && libGuild === targetGuildId && libLoaded ? (
                  <>
                    {activeFilter === POSTED_FILTER ? (
                      <p
                        className={styles.tabMeter}
                        title="Posted messages sync automatically — the newest posts, oldest roll off."
                      >
                        <strong>Posted history:</strong> {libPosted.used}
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

                {/* The Scheduled tab's usage line — live timed posts against the
                plan cap. Independent of the library gate above (its own fetch). */}
                {activeFilter === SCHEDULED_FILTER &&
                (sched.upcoming.length > 0 || sched.history.length > 0) ? (
                  <p
                    className={styles.tabMeter}
                    title="Each scheduled post fires once at its set time, then drops into the history below."
                  >
                    <strong>Scheduled posts:</strong>{" "}
                    {sched.quota != null
                      ? `${sched.activeCount} / ${sched.quota} used`
                      : `${sched.activeCount} active`}
                  </p>
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
                          onClick={() => setQuery("")}
                        >
                          Clear search
                        </button>
                      </>
                    ) : activeFilter === SCHEDULED_FILTER ? (
                      <p className={styles.emptyTitle}>
                        {schedulePending
                          ? "Loading scheduled posts…"
                          : "No scheduled posts yet — pick “Schedule” in the post dialog to time one."}
                      </p>
                    ) : libraryPending && activeFilter !== TEMPLATE_FILTER ? (
                      <p className={styles.emptyTitle}>Loading the server library…</p>
                    ) : (
                      <p className={styles.emptyTitle}>
                        Nothing here yet — post a message and it lands in this history
                        automatically.
                      </p>
                    )}
                  </div>
                )}

                {/* Posted / failed schedules have no message to preview (the server
                deletes it once it fires), so they live as compact rows below the
                upcoming grid — view on Discord (through the SDK; the sandboxed
                iframe can't navigate out itself), remove, or clear the lot. */}
                {activeFilter === SCHEDULED_FILTER && sched.history.length > 0 ? (
                  <div className={styles.scheduleHistoryWrap}>
                    <ScheduleHistory
                      history={sched.history}
                      ttlDays={null}
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
                      openLink={(url) => void openExternalLink(url)}
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
          pendingDelete?.schedule
            ? "Cancel scheduled post?"
            : pendingDelete?.posted
              ? "Remove from posted history?"
              : "Remove from the server library?"
        }
        size="sm"
        // The gallery overlay sits at --app-z-tooltip; lift the confirm above it
        // so it (and its scrim) land on top rather than behind the gallery.
        backdropStyle={{ zIndex: "calc(var(--app-z-tooltip) + 10)" }}
      >
        <div className={styles.confirmBody}>
          <p className={styles.confirmText}>
            {pendingDelete?.schedule ? (
              <>
                Stop <strong>{pendingDelete?.name}</strong> from posting? This can't be undone —
                you'd have to schedule it again.
              </>
            ) : pendingDelete?.posted ? (
              <>
                Remove <strong>{pendingDelete?.name}</strong> from this server's posted history now?
                It won't wait to roll off on its own — every manager loses the entry (the message
                stays live on Discord). This can't be undone.
              </>
            ) : (
              <>
                Remove <strong>{pendingDelete?.name}</strong> from the server library? Everyone
                managing this server loses this entry (a posted message stays live on Discord). This
                can't be undone.
              </>
            )}
          </p>
          <div className={styles.confirmActions}>
            <Button variant="ghost" type="button" onClick={() => setPendingDelete(null)}>
              {pendingDelete?.schedule ? "Keep it" : "Cancel"}
            </Button>
            <Button
              variant="danger"
              type="button"
              leadingIcon={<TrashIcon />}
              onClick={confirmDelete}
            >
              {pendingDelete?.schedule ? "Cancel post" : "Remove"}
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
            clock — counted from when it was sent, so an older message's may lapse right away — and
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
