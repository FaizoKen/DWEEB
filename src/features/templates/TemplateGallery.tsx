/**
 * Template Gallery — the app's full-screen landing screen.
 *
 * Opens on every visit (see `App`) so a user always starts from a deliberate
 * choice instead of a cold editor. It blends three sources into one
 * app-store-style grid:
 *
 *  - **Posted** — the connected server's shared library history (messages sent
 *    through DWEEB, recorded server-side), ready to reload and update in
 *    place. Server-only by design: nothing posted is kept in this browser.
 *    This tab is also the never-expire manager: each card carries an
 *    assign/free slot control, the tab header shows slot usage, and slots
 *    whose message left the history are listed for recovery (freeing one is
 *    the only way to reclaim a slot held by a deleted message).
 *  - **Saved** — the user's named, stashed messages (a dedicated category), so
 *    reusable messages are reachable without digging through the Saved menu.
 *  - **Templates** — the curated starting points.
 *
 * Every card carries a **live, faithful thumbnail** — the real `Preview`
 * renderer scaled down and made `inert`, so what you see is exactly what you'll
 * get. Search spans name / description / tags. Interactive templates are tagged
 * "Bot needed" and name the plugin they pair with.
 *
 * Picking a template or saved message replaces the editor wholesale (fresh ids,
 * undoable) and closes the gallery. Rendered into a portal so it overlays the
 * whole app.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useMessageStore } from "@/core/state/messageStore";
import { useSavedMessagesStore } from "@/core/state/savedMessagesStore";
import { useAuthStore } from "@/core/auth/authStore";
import { useGuildStore } from "@/core/guild/guildStore";
import {
  addPermanentMessage,
  fetchPermanentSlots,
  isUnlimitedCap,
  removePermanentMessage,
  type PermanentSlots,
} from "@/core/guild/api";
import { useManagedMessagesStore } from "@/core/guild/managedMessagesStore";
import { usePlanStore } from "@/core/plan/planStore";
import { handleDiscordLinkClick } from "@/lib/discordDeepLink";
import { isLibraryConfigured } from "@/core/library/api";
import {
  libraryEntryMessage,
  libraryEntryOrigin,
  useLibraryStore,
} from "@/core/library/libraryStore";
import { interactiveComponents } from "@/core/plugins/targets";
import { alignConnectedGuild } from "@/core/guild/originGuild";
import { attachEditorFields } from "@/core/serialization/normalize";
import { TEMPLATES, type MessageTemplate, type TemplateCategory } from "@/data/presets";
import type { WebhookMessage } from "@/core/schema/types";
import { collectSearchText } from "@/core/schema/traversal";
import { isRegisteredPluginId } from "@/core/plugins/registry";
import { useSendNudgeStore } from "@/core/state/sendNudgeStore";
import { Preview } from "@/features/preview/Preview";
import { Button } from "@/ui/Button";
import { Modal } from "@/ui/Modal";
import { CloseIcon, PlusIcon, PuzzleIcon, SearchIcon, SparkleIcon, TrashIcon } from "@/ui/Icon";
import { pushToast } from "@/ui/Toast";
import { useTemplateGalleryStore } from "./templateGalleryStore";
import { useTemplateSetupStore } from "./templateSetupStore";
import styles from "./TemplateGallery.module.css";

/** The chip row's buckets: the user's own posted messages, their two draft
 *  shelves (this browser's saves and the server library's shared drafts), then
 *  all curated templates collapsed into one. Templates keep their per-card
 *  category label, but the chips no longer split by category. */
const SAVED_FILTER = "Saved" as const;
const SERVER_DRAFTS_FILTER = "Server drafts" as const;
const POSTED_FILTER = "Posted" as const;
const TEMPLATE_FILTER = "Template" as const;
type Filter =
  | typeof POSTED_FILTER
  | typeof SAVED_FILTER
  | typeof SERVER_DRAFTS_FILTER
  | typeof TEMPLATE_FILTER;

const ACCENT_TEAL = 0x1abc9c;
const ACCENT_GREEN = 0x3ba55d;

/** One renderable card — a continue draft, a posted message, a saved message,
 *  or a template. */
interface CardData {
  kind: "posted" | "saved" | "template";
  key: string;
  emoji: string;
  name: string;
  description: string;
  message: WebhookMessage;
  accent?: number;
  /** Template only — drives the category chip + the search haystack. */
  category?: TemplateCategory;
  requiresBot?: boolean;
  pairsWith?: string;
  /** Saved / posted only — "last edited" stamp shown as a relative time. */
  savedAt?: number;
  /** Saved / posted only — the small pill shown in place of a category. */
  badge?: string;
  /** True when this card came from the connected server's shared library. */
  storedInServerLibrary?: boolean;
  onPick: () => void;
  /** Remove this entry from its list (local store or server library). */
  onDelete?: () => void;
  /** Extra status pills after the badge — the library's derived labels
   *  ("Never expires", "Buttons expired", "Shared"). */
  tags?: { text: string; tone: "ok" | "warn" | "info" }[];
  /** Posted only — the never-expire slot control rendered on the card:
   *  claim a slot ("assign") or give one back ("free"). */
  slot?: { kind: "assign" | "free"; busy: boolean; title: string; run: () => void };
  /** Lowercased text pulled from the message body (content, labels, …) so the
   *  card is findable by what the message says, not just its name. Precomputed
   *  when the card is built so search stays cheap per keystroke. */
  searchText?: string;
}

/** Lowercased search haystack for one card — its metadata plus the message body. */
function haystack(c: CardData): string {
  return [c.name, c.description, c.category, c.pairsWith, c.badge, c.searchText]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Compact "2m ago" / "yesterday" / "Mar 4" stamp for continue/saved cards. */
function formatRelative(savedAt: number): string {
  const minutes = Math.round((Date.now() - savedAt) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(savedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
  // Seeded once from the store so callers can deep-link straight to "Saved";
  // the gallery is remounted on each open, so this initialiser re-runs fresh.
  const [filter, setFilter] = useState<Filter>(
    () => useTemplateGalleryStore.getState().initialFilter,
  );
  const [pendingDelete, setPendingDelete] = useState<{
    kind: "saved" | "library";
    id: string;
    name: string;
    /** Library only — the server the entry belongs to. */
    guildId?: string;
    /** Library only — the entry holds a never-expire slot, which removing the
     *  history record does NOT free (the confirm says so). */
    neverExpires?: boolean;
  } | null>(null);

  // The connected server's shared library (posted messages + server drafts),
  // refreshed on open / when the connected server changes. Fails soft: a signed-
  // out user or a member without Manage Webhooks simply sees no server section.
  const libraryOn = isLibraryConfigured();
  const libEntries = useLibraryStore((s) => s.entries);
  const libGuild = useLibraryStore((s) => s.guildId);
  const libPosted = useLibraryStore((s) => s.posted);
  const libDrafts = useLibraryStore((s) => s.drafts);
  const libLoaded = useLibraryStore((s) => s.loaded);
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

  // Give a slot back. The message returns to the expiry clock, counted from
  // its send date — an old message's buttons may expire right away.
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
      if (e.key === "Escape") closeGallery();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeGallery]);

  // Saved messages, re-hydrated to editable form for their thumbnails. Skips any
  // entry whose payload won't parse (an older/corrupt record) rather than throw.
  const savedMessages = useMemo(
    () =>
      savedEntries.flatMap((e) => {
        try {
          return [{ entry: e, message: attachEditorFields(e.payload) }];
        } catch {
          return [];
        }
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
        description: "Saved in this browser — only visible on this device.",
        message,
        accent: ACCENT_TEAL,
        savedAt: entry.savedAt,
        badge: "Saved",
        searchText: collectSearchText(message),
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
      const message = libraryEntryMessage(entry);
      if (!message) continue;
      const isPosted = entry.label === "posted";
      const interactive = interactiveComponents(message).length > 0;
      const holdsSlot = isPosted && !!entry.message_id && grantIds.has(entry.message_id);
      // Derived labels: never-expire state from the permanent-slot API, and
      // "buttons expired" for an interactive message older than the component
      // TTL without a slot. Both display-only and best-effort.
      const tags: CardData["tags"] = [];
      if (isPosted && entry.message_id) {
        if (permanentIds.has(entry.message_id)) {
          tags.push({ text: "Never expires", tone: "ok" });
        } else if (holdsSlot) {
          // Granted but paused: the server is over its downgraded plan cap.
          tags.push({ text: "Never-expire paused", tone: "warn" });
        } else if (
          permanent?.ttl_days != null &&
          interactive &&
          Date.now() - entry.updated_at * 1000 > permanent.ttl_days * 86_400_000
        ) {
          tags.push({ text: "Buttons expired", tone: "warn" });
        }
      }
      // The on-card slot control: free the held slot, or claim one for an
      // interactive message (a message without components has nothing to keep
      // alive, so it gets no assign button).
      let slot: CardData["slot"];
      if (canManageSlots && isPosted && entry.message_id) {
        const messageId = entry.message_id;
        if (holdsSlot) {
          slot = {
            kind: "free",
            busy: slotBusy,
            title:
              "Puts the message back on the expiry clock, counted from its send date — older messages may expire right away. It also rejoins the posted history's rolling window.",
            run: () => void freeNeverExpire(messageId),
          };
        } else if (interactive && entry.channel_id) {
          const channelId = entry.channel_id;
          slot = {
            kind: "assign",
            busy: slotBusy,
            title:
              "Spends one of the server's never-expire slots so this message's buttons & selects keep working — and it stops rolling off this history.",
            run: () => void assignNeverExpire(messageId, channelId),
          };
        }
      }
      const origin = libraryEntryOrigin(entry);
      const displayName =
        entry.title?.trim() || entry.dest_label || (isPosted ? "Posted message" : "Server draft");
      const card: CardData = {
        kind: isPosted ? "posted" : "saved",
        key: `lib:${entry.id}`,
        emoji: isPosted ? "📤" : "🔖",
        name: displayName,
        description: isPosted
          ? holdsSlot
            ? `${entry.dest_label ? `Posted to ${entry.dest_label}` : "Posted"} · never-expire keeps it out of the rolling history window, so it stays here until you free the slot.`
            : `${entry.dest_label ? `Posted to ${entry.dest_label}` : "Posted"} · synced automatically in the ${
                connectedGuildName ?? "server"
              } history — it rolls off as newer posts land. Load it and save it to keep it.`
          : `A saved message in the ${connectedGuildName ?? "server"} library, shared with this server's managers.`,
        message,
        accent: isPosted ? ACCENT_GREEN : ACCENT_TEAL,
        savedAt: entry.updated_at * 1000,
        badge: isPosted ? "Posted" : "Server draft",
        storedInServerLibrary: true,
        tags,
        slot,
        searchText: collectSearchText(message),
        onDelete: () =>
          setPendingDelete({
            kind: "library",
            id: entry.id,
            guildId: entry.guild_id,
            name: displayName,
            neverExpires: holdsSlot,
          }),
        onPick: () => {
          if (origin) {
            // Posted with its webhook intact: restore content *and* origin so
            // the Send panel flips to "Update existing".
            replaceMessageFromRestore(message, origin);
            alignConnectedGuild(entry.guild_id);
            pushToast(
              "Loaded from the server library — edits will update the original.",
              "success",
            );
          } else {
            replaceMessage(message);
            pushToast(
              isPosted
                ? "Loaded from the server library (content only — sending posts a new copy)."
                : "Loaded from the server library.",
              "success",
            );
          }
          closeGallery();
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
    freeNeverExpire,
    connectedGuildName,
    replaceMessage,
    replaceMessageFromRestore,
    closeGallery,
  ]);

  // The Posted deck IS the connected server's shared history — server-fed only,
  // so what you see is exactly what the library holds, on every device. Drafts
  // stay SEPARATE: "Saved" is this browser's private stash, "Server drafts" is
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
        searchText: collectSearchText(t.message),
        onPick: () => {
          replaceMessage(t.message);
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

  // Chip row: Posted, the two draft shelves (this browser / server library —
  // each only when there are any), then a single Template chip for the whole
  // curated set (categories no longer split). Posted also shows when the only
  // thing to manage is orphaned never-expire slots — with no card holding
  // them, this tab's strip is the one place they can still be freed.
  const filters: Filter[] = useMemo(
    () => [
      ...(postedCards.length || orphanSlots.length ? [POSTED_FILTER] : []),
      ...(savedCards.length ? [SAVED_FILTER] : []),
      ...(libraryDraftCards.length ? [SERVER_DRAFTS_FILTER] : []),
      ...(templateCards.length ? [TEMPLATE_FILTER] : []),
    ],
    [
      postedCards.length,
      orphanSlots.length,
      savedCards.length,
      libraryDraftCards.length,
      templateCards.length,
    ],
  );
  const firstFilter = filters[0] ?? TEMPLATE_FILTER;
  const activeFilter = filters.includes(filter) ? filter : firstFilter;

  // Posted history is server-fed, so on a cold open the library hasn't
  // answered yet and the Posted/Server-drafts chips don't exist *yet* — that's
  // not the same as the tab being empty. Hold a requested library-backed
  // filter until the load settles so the gallery can land on it once the
  // entries arrive, instead of falling through to Templates on every open.
  const libraryPending =
    libraryOn && !!connectedGuildId && !(libGuild === connectedGuildId && libLoaded);

  // If the requested filter disappears (e.g. last saved message removed), fall
  // through to the first real chip so the gallery never opens on a combined view.
  useEffect(() => {
    if (libraryPending && (filter === POSTED_FILTER || filter === SERVER_DRAFTS_FILTER)) return;
    if (filter !== activeFilter) setFilter(activeFilter);
  }, [activeFilter, filter, libraryPending]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let base: CardData[];
    if (activeFilter === POSTED_FILTER) {
      base = postedCards;
    } else if (activeFilter === SAVED_FILTER) {
      base = savedCards;
    } else if (activeFilter === SERVER_DRAFTS_FILTER) {
      base = libraryDraftCards;
    } else {
      // TEMPLATE_FILTER — the whole curated set, no per-category split.
      base = templateCards;
    }
    return q ? base.filter((c) => haystack(c).includes(q)) : base;
  }, [activeFilter, query, postedCards, savedCards, libraryDraftCards, templateCards]);

  const startBlank = () => {
    clearAll();
    closeGallery();
    pushToast("Started a blank message", "info");
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    if (pendingDelete.kind === "library" && pendingDelete.guildId) {
      const { guildId, id } = pendingDelete;
      void removeLibrary(guildId, id).then((ok) => {
        pushToast(
          ok ? "Removed from the server library" : "Couldn't remove it — try again.",
          ok ? "info" : "error",
        );
      });
    } else {
      removeEntry(pendingDelete.id);
      pushToast(`Deleted "${pendingDelete.name}"`, "info");
    }
    setPendingDelete(null);
  };

  return createPortal(
    <>
      <div
        className={styles.backdrop}
        role="dialog"
        aria-modal="true"
        aria-label="Start a message"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) closeGallery();
        }}
      >
        <div className={styles.panel}>
          <header className={styles.header}>
            <div className={styles.headingRow}>
              <div className={styles.heading}>
                <h2 className={styles.title}>
                  <span className={styles.titleSpark} aria-hidden>
                    <SparkleIcon size={17} />
                  </span>
                  Start a message
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
                aria-label="Close template gallery"
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
                    postedCards.length || savedCards.length
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

              <div className={styles.chips} role="group" aria-label="Filter templates by category">
                {filters.map((f) => (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={activeFilter === f}
                    className={[
                      styles.chip,
                      // The Saved/Posted pseudo-categories carry their own tints
                      // (teal / green) so a user's own messages stand out from the
                      // curated template categories.
                      f === SAVED_FILTER || f === SERVER_DRAFTS_FILTER ? styles.chipSaved : "",
                      f === POSTED_FILTER ? styles.chipPosted : "",
                      activeFilter === f ? styles.chipActive : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => setFilter(f)}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
          </header>

          <div className={styles.body}>
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
                    {" · "}buttons &amp; selects stop working {permanent.ttl_days} days after
                    sending unless the message holds a slot — assign or free one right on its card.
                  </span>
                  {!isUnlimitedCap(permanent.cap) && permanent.used >= permanent.cap ? (
                    <button
                      type="button"
                      className={styles.slotStripUpgrade}
                      onClick={() => {
                        closeGallery();
                        if (connectedGuildId) usePlanStore.getState().openPricing(connectedGuildId);
                      }}
                    >
                      Upgrade for more
                    </button>
                  ) : null}
                </div>
                {permanent.suspended ? (
                  <p className={styles.slotStripNote}>
                    {permanent.suspended} never-expire{" "}
                    {permanent.suspended === 1 ? "message is" : "messages are"} paused — the server
                    holds more than its current plan allows. Nothing was deleted; upgrading restores
                    the oldest ones first.
                  </p>
                ) : null}
                {orphanSlots.length > 0 ? (
                  <div className={styles.orphanBlock}>
                    <p className={styles.slotStripNote}>
                      {orphanSlots.length === 1
                        ? "1 never-expire slot points at a message"
                        : `${orphanSlots.length} never-expire slots point at messages`}{" "}
                      that {orphanSlots.length === 1 ? "isn't" : "aren't"} in this history — free
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
                              title="Puts the message back on the expiry clock, counted from its send date"
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
            {shown.length === 0 ? (
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
                ) : (
                  // Reachable on the Posted tab when it exists only for the
                  // orphaned-slot strip above — no posted cards to show yet.
                  <p className={styles.emptyTitle}>No posted messages in this history yet.</p>
                )}
              </div>
            ) : (
              <div className={styles.grid}>
                {shown.map((c) => (
                  <GalleryCard key={c.key} card={c} />
                ))}
              </div>
            )}
          </div>

          <footer className={styles.footer}>
            <span className={styles.footerHint}>
              {shown.length} {shown.length === 1 ? "result" : "results"}
            </span>
            {/* The connected server's library usage + a hand-off to the full
                management dialog (scheduled posts, never-expire slots). Shown
                only once the shelf actually loaded for this server, so a
                non-manager never sees a meter for a list they can't read. */}
            {connectedGuildId && libGuild === connectedGuildId && libLoaded ? (
              <button
                type="button"
                className={styles.libraryMeter}
                data-over={
                  libDrafts.quota != null && libDrafts.used > libDrafts.quota ? "" : undefined
                }
                onClick={() => {
                  closeGallery();
                  useManagedMessagesStore.getState().open(connectedGuildId, connectedGuildName);
                }}
                title={
                  libDrafts.quota != null && libDrafts.used > libDrafts.quota
                    ? "More saved messages than the plan allows — they stay readable, but content can't be changed until you delete down to the limit or upgrade."
                    : "Posted messages sync automatically (the newest posts, oldest roll off; never-expire messages stay put). Saved messages are yours to add and remove. Open Managed messages for scheduled posts."
                }
              >
                Posted: last {Math.max(0, libPosted.used - pinnedPostedCount)}
                {libPosted.quota != null ? ` of ${libPosted.quota}` : ""}
                {pinnedPostedCount > 0 ? ` (+${pinnedPostedCount} pinned)` : ""}
                {" · Saved: "}
                {libDrafts.used}
                {libDrafts.quota != null ? ` / ${libDrafts.quota}` : ""}
                {libDrafts.quota != null && libDrafts.used > libDrafts.quota
                  ? " · over limit"
                  : " · Manage"}
              </button>
            ) : null}
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
          pendingDelete?.kind === "library"
            ? "Remove from the server library?"
            : "Delete saved message?"
        }
        size="sm"
        // The gallery overlay sits at --app-z-tooltip; lift the confirm above it
        // so it (and its scrim) land on top rather than behind the gallery.
        backdropStyle={{ zIndex: "calc(var(--app-z-tooltip) + 10)" }}
      >
        <div className={styles.confirmBody}>
          <p className={styles.confirmText}>
            {pendingDelete?.kind === "library" ? (
              <>
                Remove <strong>{pendingDelete?.name}</strong> from the server library? Everyone
                managing this server loses this entry (a posted message stays live on Discord). This
                can't be undone.
                {pendingDelete?.neverExpires ? (
                  <>
                    {" "}
                    Its never-expire slot stays claimed — free it from its card first if you want
                    the slot back.
                  </>
                ) : null}
              </>
            ) : (
              <>
                Permanently delete <strong>"{pendingDelete?.name}"</strong>? This can't be undone.
              </>
            )}
          </p>
          <div className={styles.confirmActions}>
            <Button variant="ghost" type="button" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              type="button"
              leadingIcon={<TrashIcon />}
              onClick={confirmDelete}
            >
              {pendingDelete?.kind === "saved" ? "Delete" : "Remove"}
            </Button>
          </div>
        </div>
      </Modal>
    </>,
    document.body,
  );
}

function GalleryCard({ card }: { card: CardData }) {
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      // Only the card itself activates on Enter/Space — keys aimed at the inner
      // delete button (a real <button>) must not also trigger a load.
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        card.onPick();
      }
    },
    [card],
  );

  // The card holds a Preview whose tree contains its own <button>s, so the card
  // is a div-with-role rather than a real <button> (nested buttons are invalid).
  const accent =
    card.accent !== undefined
      ? `#${card.accent.toString(16).padStart(6, "0")}`
      : "var(--app-accent)";

  const isTemplate = card.kind === "template";
  const isServerLibrary = card.storedInServerLibrary === true;
  const cardLabel = isTemplate
    ? `Start from the ${card.name} template`
    : isServerLibrary
      ? `${card.name}, saved in the server library`
      : card.name;
  const deleteLabel = isServerLibrary
    ? `Remove "${card.name}" from the server library`
    : `Delete saved message "${card.name}"`;
  const deleteTitle = isServerLibrary ? "Remove from server library" : "Delete saved message";

  return (
    <div
      className={styles.card}
      data-kind={card.kind}
      data-server-library={isServerLibrary ? "" : undefined}
      role="button"
      tabIndex={0}
      onClick={card.onPick}
      onKeyDown={onKeyDown}
      aria-label={cardLabel}
      style={{ "--card-accent": accent } as CSSProperties}
    >
      <div className={styles.cardPreview}>
        <TemplateThumbnail message={card.message} />
        <div className={styles.cardFade} aria-hidden />
        {card.onDelete ? (
          <button
            type="button"
            className={styles.cardDelete}
            onClick={(e) => {
              e.stopPropagation();
              card.onDelete?.();
            }}
            aria-label={deleteLabel}
            title={deleteTitle}
          >
            <TrashIcon size={15} />
          </button>
        ) : null}
        {card.requiresBot ? (
          <span
            className={styles.botBadge}
            title="Includes interactive components — needs a bot/app webhook"
          >
            Interactive
          </span>
        ) : null}
        <div className={styles.cardHover} aria-hidden>
          <span className={styles.useBtn}>
            {card.kind === "posted"
              ? "Edit & update →"
              : card.kind === "saved"
                ? "Load message →"
                : "Use this template →"}
          </span>
        </div>
      </div>

      <div className={styles.cardBody}>
        <div className={styles.cardTitleRow}>
          <span className={styles.cardEmoji} aria-hidden>
            {card.emoji}
          </span>
          <span className={styles.cardName}>{card.name}</span>
        </div>
        <p className={styles.cardDesc}>{card.description}</p>
        <div className={styles.cardMeta}>
          {isTemplate ? (
            <>
              <span className={styles.cardCategory}>{card.category}</span>
              {card.pairsWith ? (
                <span
                  className={styles.cardPlugin}
                  title={`Pairs with the ${card.pairsWith} plugin`}
                >
                  <PuzzleIcon size={12} aria-hidden />
                  {card.pairsWith}
                </span>
              ) : null}
            </>
          ) : (
            <>
              <span className={styles.cardCategory}>{card.badge}</span>
              {card.tags?.map((t) => (
                <span key={t.text} className={styles.cardTag} data-tone={t.tone}>
                  {t.text}
                </span>
              ))}
              {card.slot ? (
                <button
                  type="button"
                  className={styles.slotBtn}
                  data-kind={card.slot.kind}
                  disabled={card.slot.busy}
                  title={card.slot.title}
                  onClick={(e) => {
                    // A real <button> inside the card's div-with-role — the
                    // click must not also load the message into the editor.
                    e.stopPropagation();
                    card.slot?.run();
                  }}
                >
                  {card.slot.kind === "free" ? "Free slot" : "Never expire"}
                </button>
              ) : null}
              {card.savedAt !== undefined ? (
                <span className={styles.cardTime}>{formatRelative(card.savedAt)}</span>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A faithful, read-only thumbnail of a message. Renders the real `Preview` at
 * "double" size and scales it to 0.5, clipping to the card window — the same
 * trick as the mobile `MiniPreview`. The inner tree is `inert` so none of the
 * rendered buttons/avatars can steal focus or a tap; the card is the single
 * interactive target. Memoized on the (stable) message so typing in search
 * doesn't re-render every visible preview tree.
 */
const TemplateThumbnail = memo(function TemplateThumbnail({
  message,
}: {
  message: WebhookMessage;
}) {
  const makeInert = useCallback((el: HTMLDivElement | null) => {
    if (el) el.inert = true;
  }, []);
  return (
    <div className={styles.thumbViewport}>
      <div className={styles.thumbStage} ref={makeInert}>
        <Preview message={message} />
      </div>
    </div>
  );
});
