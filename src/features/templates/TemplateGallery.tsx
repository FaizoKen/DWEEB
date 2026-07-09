/**
 * Template Gallery — the app's full-screen landing screen.
 *
 * Opens on every visit (see `App`) so a user always starts from a deliberate
 * choice instead of a cold editor. It blends three sources into one
 * app-store-style grid:
 *
 *  - **Posted** — messages already sent through DWEEB, ready to reload and
 *    update in place.
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
import { recordOrigin, usePostedMessagesStore } from "@/core/state/postedMessagesStore";
import { useAuthStore } from "@/core/auth/authStore";
import { useGuildStore } from "@/core/guild/guildStore";
import { fetchPermanentSlots, guildIconUrl, type PermanentSlots } from "@/core/guild/api";
import { useManagedMessagesStore } from "@/core/guild/managedMessagesStore";
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
import {
  CloseIcon,
  PlusIcon,
  PuzzleIcon,
  SearchIcon,
  ServerStackIcon,
  SparkleIcon,
  TrashIcon,
} from "@/ui/Icon";
import { pushToast } from "@/ui/Toast";
import { useScrollActiveIntoView } from "@/lib/useScrollActiveIntoView";
import { useTemplateGalleryStore } from "./templateGalleryStore";
import { useTemplateSetupStore } from "./templateSetupStore";
import styles from "./TemplateGallery.module.css";

/** The chip row's buckets: the user's own posted/saved messages, then all
 *  curated templates collapsed into one. Templates keep their per-card category
 *  label, but the chips no longer split by category. */
const SAVED_FILTER = "Saved" as const;
const POSTED_FILTER = "Posted" as const;
const TEMPLATE_FILTER = "Template" as const;
type Filter = typeof POSTED_FILTER | typeof SAVED_FILTER | typeof TEMPLATE_FILTER;

const ACCENT_TEAL = 0x1abc9c;
const ACCENT_GREEN = 0x3ba55d;
const MAX_LIBRARY_TITLE_CHARS = 100;

function libraryDraftTitle(name: string): string {
  const trimmed = name.trim() || "Untitled message";
  return [...trimmed].slice(0, MAX_LIBRARY_TITLE_CHARS).join("");
}

type ServerLibraryCardAction = {
  kind: "save" | "saving" | "remove";
  label: string;
  title: string;
  onClick?: () => void;
};

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
  /** Posted only — the home server, used to bucket posted cards under per-server
   *  section headers. `guildId` is the stable group key; `guildName` is the
   *  label. Either can be absent on older records / non-guild webhooks. */
  guildId?: string;
  guildName?: string;
  onPick: () => void;
  /** Local saved/posted only: remove this entry from the local list. */
  onDelete?: () => void;
  /** Top-left stack action for saving/removing this card in the server library. */
  serverLibraryAction?: ServerLibraryCardAction;
  /** Extra status pills after the badge — the library's derived labels
   *  ("Never expires", "Buttons expired", "Shared"). */
  tags?: { text: string; tone: "ok" | "warn" | "info" }[];
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
  const postedEntries = usePostedMessagesStore((s) => s.entries);
  const removePosted = usePostedMessagesStore((s) => s.remove);
  // The signed-in user's servers carry the icon hash the posted records don't
  // store, so the Posted-tab section headers can show a real server glyph. Keyed
  // by id for a cheap per-section lookup; absent when the user isn't a member.
  const authGuilds = useAuthStore((s) => s.guilds);
  // The connected server — its Posted-tab section is scrolled into view on open.
  const connectedGuildId = useGuildStore((s) => s.guildId);
  const guildIconById = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const g of authGuilds) map.set(g.id, g.icon);
    return map;
  }, [authGuilds]);
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
    kind: "saved" | "posted" | "library";
    id: string;
    name: string;
    /** Library only — the server the entry belongs to. */
    guildId?: string;
    /** Source card whose save-to-library copy is being removed. */
    sourceKey?: string;
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
  const saveLibraryDraft = useLibraryStore((s) => s.saveDraft);
  const removeLibrary = useLibraryStore((s) => s.remove);
  const [savingLibraryKeys, setSavingLibraryKeys] = useState<Set<string>>(() => new Set());
  const [libraryCopies, setLibraryCopies] = useState<
    Record<string, { guildId: string; id: string }>
  >({});
  useEffect(() => {
    if (libraryOn && connectedGuildId) {
      void useLibraryStore.getState().refresh(connectedGuildId);
    }
  }, [libraryOn, connectedGuildId]);

  // Never-expire slot state for the connected server, so library cards can
  // carry "Never expires" / "Buttons expired" labels. Display-only and
  // fail-soft (a 501/403 just hides the labels).
  const [permanent, setPermanent] = useState<PermanentSlots | null>(null);
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
  const searchRef = useRef<HTMLInputElement | null>(null);
  // Scroll the connected server's Posted-tab section into view — the scrollable
  // body and the active section it should land on.
  const bodyRef = useRef<HTMLDivElement>(null);
  const activeSectionRef = useRef<HTMLElement>(null);

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

  const canSaveToServerLibrary =
    libraryOn && !!connectedGuildId && libGuild === connectedGuildId && libLoaded;

  const saveCardToLibrary = useCallback(
    async (key: string, name: string, message: WebhookMessage) => {
      if (!connectedGuildId) return;
      setSavingLibraryKeys((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      const title = libraryDraftTitle(name);
      try {
        const res = await saveLibraryDraft(connectedGuildId, title, message);
        if (res.ok) {
          setLibraryCopies((prev) => ({
            ...prev,
            [key]: { guildId: res.entry.guild_id, id: res.entry.id },
          }));
          pushToast(`Saved "${title}" to the ${connectedGuildName ?? "server"} library`, "success");
        } else {
          pushToast(res.error, "error");
        }
      } catch {
        pushToast("Couldn't reach the server library.", "error");
      } finally {
        setSavingLibraryKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [connectedGuildId, connectedGuildName, saveLibraryDraft],
  );

  const serverLibraryActionFor = useCallback(
    (key: string, name: string, message: WebhookMessage): ServerLibraryCardAction | undefined => {
      const copy = libraryCopies[key];
      const title = libraryDraftTitle(name);
      if (copy && copy.guildId === connectedGuildId) {
        return {
          kind: "remove",
          label: `Remove "${title}" from the ${connectedGuildName ?? "server"} library`,
          title: "Remove from server library",
          onClick: () =>
            setPendingDelete({
              kind: "library",
              id: copy.id,
              guildId: copy.guildId,
              name: title,
              sourceKey: key,
            }),
        };
      }
      if (savingLibraryKeys.has(key)) {
        return {
          kind: "saving",
          label: `Saving "${title}" to the server library`,
          title: "Saving to server library",
        };
      }
      if (!canSaveToServerLibrary) return undefined;
      return {
        kind: "save",
        label: `Save "${title}" to the ${connectedGuildName ?? "server"} library`,
        title: "Save to server library",
        onClick: () => void saveCardToLibrary(key, title, message),
      };
    },
    [
      canSaveToServerLibrary,
      connectedGuildId,
      connectedGuildName,
      libraryCopies,
      saveCardToLibrary,
      savingLibraryKeys,
    ],
  );

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
        description: "One of your saved messages.",
        message,
        accent: ACCENT_TEAL,
        savedAt: entry.savedAt,
        badge: "Saved",
        searchText: collectSearchText(message),
        serverLibraryAction: serverLibraryActionFor(entry.id, entry.name, message),
        onPick: () => {
          replaceMessage(message);
          closeGallery();
          pushToast(`Loaded "${entry.name}"`, "success");
        },
        onDelete: () => setPendingDelete({ kind: "saved", id: entry.id, name: entry.name }),
      })),
    [savedMessages, replaceMessage, closeGallery, serverLibraryActionFor],
  );

  // The connected server's library entries (only when the loaded library
  // actually matches the connected server — a switch mid-load must not show the
  // previous server's shelf), split by label and re-hydrated like the local
  // stores. Message ids already on the shelf suppress the local duplicates
  // below: the server copy is fresher (it upserts on every send from any
  // device) and shared, so it wins.
  const serverEntries = useMemo(
    () => (libGuild && libGuild === connectedGuildId ? libEntries : []),
    [libGuild, connectedGuildId, libEntries],
  );
  const libraryMessageIds = useMemo(
    () => new Set(serverEntries.map((e) => e.message_id).filter(Boolean) as string[]),
    [serverEntries],
  );
  // Active never-expire grants, for the "Never expires" tag.
  const permanentIds = useMemo(
    () => new Set((permanent?.items ?? []).filter((i) => !i.suspended).map((i) => i.message_id)),
    [permanent],
  );
  const { libraryPostedCards, libraryDraftCards } = useMemo(() => {
    const posted: CardData[] = [];
    const drafts: CardData[] = [];
    for (const entry of serverEntries) {
      const message = libraryEntryMessage(entry);
      if (!message) continue;
      const isPosted = entry.label === "posted";
      // Derived labels: never-expire state from the permanent-slot API, and
      // "buttons expired" for an interactive message older than the component
      // TTL without a slot. Both display-only and best-effort.
      const tags: CardData["tags"] = [];
      if (isPosted && entry.message_id) {
        if (permanentIds.has(entry.message_id)) {
          tags.push({ text: "Never expires", tone: "ok" });
        } else if (
          permanent?.ttl_days != null &&
          interactiveComponents(message).length > 0 &&
          Date.now() - entry.updated_at * 1000 > permanent.ttl_days * 86_400_000
        ) {
          tags.push({ text: "Buttons expired", tone: "warn" });
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
          ? `${entry.dest_label ? `Posted to ${entry.dest_label}` : "Posted"} · synced automatically in the ${
              connectedGuildName ?? "server"
            } history — it rolls off as newer posts land, so keep a copy to hold on to it.`
          : `A saved message in the ${connectedGuildName ?? "server"} library, shared with this server's managers.`,
        message,
        accent: isPosted ? ACCENT_GREEN : ACCENT_TEAL,
        savedAt: entry.updated_at * 1000,
        badge: isPosted ? "Posted" : "Server draft",
        storedInServerLibrary: true,
        guildId: entry.guild_id,
        guildName: connectedGuildName,
        tags,
        searchText: collectSearchText(message),
        // The posted history is sync-only — its stack action saves a lasting
        // COPY to the saved shelf (the record itself rolls off with time);
        // a saved message IS the copy, so it only offers deletion.
        serverLibraryAction: isPosted
          ? serverLibraryActionFor(`lib:${entry.id}`, displayName, message)
          : undefined,
        onDelete: () =>
          setPendingDelete({
            kind: "library",
            id: entry.id,
            guildId: entry.guild_id,
            name: displayName,
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
    permanentIds,
    permanent,
    connectedGuildName,
    replaceMessage,
    replaceMessageFromRestore,
    closeGallery,
    serverLibraryActionFor,
  ]);

  // Posted messages, re-hydrated for their thumbnails (same skip-on-corrupt
  // guard as saved). Each carries the origin that lets a reload default the Send
  // panel to "Update existing", so editing then re-sending updates the live
  // message in place — no manual webhook + message-id paste. Records the server
  // library already covers are suppressed (see `libraryMessageIds`).
  const postedMessages = useMemo(
    () =>
      postedEntries.flatMap((e) => {
        if (libraryMessageIds.has(e.messageId)) return [];
        try {
          return [{ entry: e, message: attachEditorFields(e.payload) }];
        } catch {
          return [];
        }
      }),
    [postedEntries, libraryMessageIds],
  );

  const localPostedCards: CardData[] = useMemo(
    () =>
      postedMessages.map(({ entry, message }) => {
        const where = entry.channelName
          ? `#${entry.channelName}${entry.guildName ? ` · ${entry.guildName}` : ""}`
          : entry.guildName;
        const name = entry.channelName ? `#${entry.channelName}` : "Posted message";
        return {
          kind: "posted",
          key: entry.id,
          emoji: "📤",
          name,
          description: where
            ? `Posted to ${where}. Reload to edit and update it in place.`
            : "A message you posted. Reload to edit and update it in place.",
          message,
          accent: ACCENT_GREEN,
          savedAt: entry.postedAt,
          badge: "Posted",
          guildId: entry.guildId,
          guildName: entry.guildName,
          searchText: collectSearchText(message),
          serverLibraryAction: serverLibraryActionFor(entry.id, name, message),
          onPick: () => {
            // Restore content *and* origin — the Send panel reads the origin and
            // flips to "Update existing" with the webhook + message id prefilled.
            replaceMessageFromRestore(message, recordOrigin(entry));
            // Re-align the connected guild to where this message lives, when the
            // user belongs to that server, so the preview's mentions/channels/
            // emoji resolve to the right names instead of placeholders. The
            // switch is visible (the guild selector updates) and never changes
            // where an update lands. When they aren't a member, the editor's
            // mismatch banner explains the placeholder names instead.
            alignConnectedGuild(entry.guildId);
            closeGallery();
            pushToast("Loaded your posted message — edits will update the original.", "success");
          },
          onDelete: () =>
            setPendingDelete({ kind: "posted", id: entry.id, name: where ?? "this message" }),
        };
      }),
    [postedMessages, replaceMessageFromRestore, closeGallery, serverLibraryActionFor],
  );

  // The merged decks the chips/sections read: the connected server's shared
  // shelf first (it's the fresher, cross-device record), then the local-only
  // remainder.
  const postedCards: CardData[] = useMemo(
    () => [...libraryPostedCards, ...localPostedCards],
    [libraryPostedCards, localPostedCards],
  );
  const savedCards: CardData[] = useMemo(
    () => [...libraryDraftCards, ...localSavedCards],
    [libraryDraftCards, localSavedCards],
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
        serverLibraryAction: serverLibraryActionFor(t.id, t.name, t.message),
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
    [replaceMessage, closeGallery, serverLibraryActionFor],
  );

  // Chip row: Posted and Saved (each only when there are any), then a single
  // Template chip for the whole curated set (categories no longer split).
  const filters: Filter[] = useMemo(
    () => [
      ...(postedCards.length ? [POSTED_FILTER] : []),
      ...(savedCards.length ? [SAVED_FILTER] : []),
      ...(templateCards.length ? [TEMPLATE_FILTER] : []),
    ],
    [postedCards.length, savedCards.length, templateCards.length],
  );
  const firstFilter = filters[0] ?? TEMPLATE_FILTER;
  const activeFilter = filters.includes(filter) ? filter : firstFilter;

  // If the requested filter disappears (e.g. last saved message removed), fall
  // through to the first real chip so the gallery never opens on a combined view.
  useEffect(() => {
    if (filter !== activeFilter) setFilter(activeFilter);
  }, [activeFilter, filter]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let base: CardData[];
    if (activeFilter === POSTED_FILTER) {
      base = postedCards;
    } else if (activeFilter === SAVED_FILTER) {
      base = savedCards;
    } else {
      // TEMPLATE_FILTER — the whole curated set, no per-category split.
      base = templateCards;
    }
    return q ? base.filter((c) => haystack(c).includes(q)) : base;
  }, [activeFilter, query, postedCards, savedCards, templateCards]);

  // On the dedicated Posted tab (idle, not searching), bucket the cards under
  // per-server headers — "where did I post this" is how sent messages are
  // actually remembered. Only when 2+ distinct servers are present; a single
  // header would just be noise, so we fall back to the flat grid. Records with
  // no resolved server collect under one "Other servers" bucket rather than
  // vanishing. Map insertion order keeps sections newest-post-first (shown is
  // already newest-first), matching the flat view's ordering.
  const postedSections = useMemo(() => {
    if (activeFilter !== POSTED_FILTER || query.trim()) return null;
    const groups = new Map<
      string,
      { key: string; guildId?: string; name: string; cards: CardData[] }
    >();
    for (const c of shown) {
      const key = c.guildId ?? c.guildName ?? "__unknown";
      let group = groups.get(key);
      if (!group) {
        group = { key, guildId: c.guildId, name: c.guildName ?? "Other servers", cards: [] };
        groups.set(key, group);
      }
      group.cards.push(c);
    }
    if (groups.size < 2) return null;
    return [...groups.values()];
  }, [activeFilter, query, shown]);

  // On the Posted tab, land on the server you're connected to — its section is
  // usually the one you came to update. Re-runs when the tab changes (so it also
  // fires if you switch to Posted after opening) or the connected server does;
  // does nothing when that server has no posted messages (no section to hit).
  useScrollActiveIntoView(bodyRef, activeSectionRef, [activeFilter, connectedGuildId], "start");

  const startBlank = () => {
    clearAll();
    closeGallery();
    pushToast("Started a blank message", "info");
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    if (pendingDelete.kind === "library" && pendingDelete.guildId) {
      const { guildId, id, sourceKey } = pendingDelete;
      void removeLibrary(guildId, id).then((ok) => {
        if (ok && sourceKey) {
          setLibraryCopies((prev) => {
            if (!prev[sourceKey]) return prev;
            const next = { ...prev };
            delete next[sourceKey];
            return next;
          });
        }
        pushToast(
          ok ? "Removed from the server library" : "Couldn't remove it — try again.",
          ok ? "info" : "error",
        );
      });
    } else if (pendingDelete.kind === "posted") {
      removePosted(pendingDelete.id);
      pushToast("Removed from your posted messages", "info");
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
                      f === SAVED_FILTER ? styles.chipSaved : "",
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

          <div className={styles.body} ref={bodyRef}>
            {shown.length === 0 ? (
              <div className={styles.empty}>
                <SearchIcon size={28} aria-hidden />
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
              </div>
            ) : postedSections ? (
              <div className={styles.sections}>
                {postedSections.map((section) => (
                  <section
                    key={section.key}
                    className={styles.section}
                    ref={section.guildId === connectedGuildId ? activeSectionRef : undefined}
                  >
                    <div className={styles.sectionHeader}>
                      <ServerIcon
                        guildId={section.guildId}
                        name={section.name}
                        iconHash={section.guildId ? guildIconById.get(section.guildId) : undefined}
                      />
                      <span className={styles.sectionName}>{section.name}</span>
                      <span className={styles.sectionCount}>{section.cards.length}</span>
                    </div>
                    <div className={styles.grid}>
                      {section.cards.map((c) => (
                        <GalleryCard key={c.key} card={c} />
                      ))}
                    </div>
                  </section>
                ))}
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
                    : "Posted messages sync automatically (the newest posts, oldest roll off); saved messages are yours to add and remove. Open Managed messages for scheduled posts, never-expire slots, and more."
                }
              >
                Posted: last {libPosted.used}
                {libPosted.quota != null ? ` of ${libPosted.quota}` : ""}
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
            : pendingDelete?.kind === "posted"
              ? "Remove posted message?"
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
              </>
            ) : pendingDelete?.kind === "posted" ? (
              <>
                Remove <strong>{pendingDelete?.name}</strong> from this list? It only forgets the
                local shortcut — the message stays live on Discord, and you can still edit it via
                Restore.
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

/** Small server glyph for a Posted-tab section header. Uses the real Discord
 *  icon when the user belongs to that server (so its icon hash is known via the
 *  auth guild list), otherwise a coloured initial — the same fallback the
 *  account menu's server rows use. The "Other servers" bucket has no id, so it
 *  too lands on the initial of its label. */
function ServerIcon({
  guildId,
  name,
  iconHash,
}: {
  guildId?: string;
  name: string;
  iconHash?: string | null;
}) {
  const url = guildId && iconHash ? guildIconUrl(guildId, iconHash, 32) : null;
  if (url) {
    return <img className={styles.sectionIcon} src={url} alt="" loading="lazy" />;
  }
  return (
    <span className={`${styles.sectionIcon} ${styles.sectionIconFallback}`} aria-hidden>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function ServerLibraryActionButton({ action }: { action: ServerLibraryCardAction }) {
  const disabled = action.kind === "saving" || !action.onClick;
  const label = action.label;
  return (
    <button
      type="button"
      className={styles.serverLibraryButton}
      data-mode={action.kind}
      aria-disabled={disabled ? "true" : undefined}
      tabIndex={disabled ? -1 : undefined}
      title={action.title}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) action.onClick?.();
      }}
    >
      <ServerStackIcon size={16} aria-hidden />
      {action.kind === "save" ? (
        <span className={styles.serverLibraryActionMark} aria-hidden>
          <PlusIcon size={10} />
        </span>
      ) : null}
    </button>
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
    : card.kind === "posted"
      ? `Remove posted message "${card.name}"`
      : `Delete saved message "${card.name}"`;
  const deleteTitle = isServerLibrary
    ? "Remove from server library"
    : card.kind === "posted"
      ? "Remove from posted messages"
      : "Delete saved message";

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
        {card.serverLibraryAction ? (
          <ServerLibraryActionButton action={card.serverLibraryAction} />
        ) : null}
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
