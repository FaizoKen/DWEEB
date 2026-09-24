import type { IconName } from "./components/Icon";
import registryJson from "../../src/core/plugins/registry.json";
import { CAST as STORY_CAST } from "./story/campaign";

/**
 * Film-facing PRODUCT catalog data. Everything here mirrors the real app:
 *  - plugins are read straight from src/core/plugins/registry.json (imported,
 *    not copied, so the film's counts can't drift from the product again —
 *    the v5 film said "+3 more" when a button really has 25 actions);
 *  - template metadata is copied verbatim from src/data/presets.ts (that file
 *    needs the app's "@/" aliases, so the bundle can't import it) and pinned
 *    by video/out/stage1/ui/truthcheck.ts, which compares every field.
 * The film's own story copy lives in src/story/campaign.ts.
 */

/* ── Plugins ────────────────────────────────────────────────────────────── */

type RegistryEntry = {
  id: string;
  name: string;
  description: string;
  kind?: "link";
  targets?: string[];
  presets?: unknown[];
  requiresBot?: boolean;
  defaultEmoji?: string;
  customIdPrefix?: string;
};

const REGISTRY: RegistryEntry[] = (registryJson as unknown as { plugins: RegistryEntry[] }).plugins;

/**
 * The product's own icon tint per plugin (src/features/plugins/PluginIcon.tsx
 * BUILTIN_ICONS; Directory/Picker have no built-in art — Directory falls back
 * to its 🗂️ emoji, Picker to a monogram at hueOf("picker") = 158°). `icon` is
 * the film's legacy line icon, kept for the v5 plugins scene.
 */
const PLUGIN_ART: Record<string, { icon: IconName; color: string }> = {
  "modal-form": { icon: "form", color: "#a78bfa" },
  "ping-pong": { icon: "gauge", color: "#34d399" },
  "self-role": { icon: "id", color: "#60a5fa" },
  tickets: { icon: "ticket", color: "#fbbf24" },
  giveaway: { icon: "gift", color: "#f472b6" },
  "quick-replies": { icon: "reply", color: "#2dd4bf" },
  poll: { icon: "blocks", color: "#818cf8" },
  directory: { icon: "users", color: "#9b7bff" },
  picker: { icon: "users", color: "#3ecf8e" },
};

const TARGET_LABEL: Record<string, string> = {
  button: "Button",
  string_select: "Select",
};

export type PluginInfo = {
  id: string;
  name: string;
  /** Registry description, verbatim (the "Add an action" blurb). */
  desc: string;
  icon: IconName;
  color: string;
  /** e.g. "Button · Select". */
  targets: string;
  presets: number;
  requiresBot: boolean;
  /** Offered in a Button's "Add an action" library. */
  forButton: boolean;
  defaultEmoji?: string;
};

/** The interactive plugins (handled by DWEEB), in registry order. */
export const PLUGINS: PluginInfo[] = REGISTRY.filter((p) => p.kind !== "link").map((p) => {
  const targets = p.targets ?? [];
  const selectKinds = targets.filter((t) => t.endsWith("_select") && t !== "string_select").length;
  return {
    id: p.id,
    name: p.name,
    desc: p.description,
    icon: PLUGIN_ART[p.id]?.icon ?? "plug",
    color: PLUGIN_ART[p.id]?.color ?? "#5865f2",
    targets:
      selectKinds > 0
        ? `${selectKinds} select kinds`
        : targets.map((t) => TARGET_LABEL[t] ?? t).join(" · "),
    presets: p.presets?.length ?? 0,
    requiresBot: !!p.requiresBot,
    forButton: targets.includes("button"),
    defaultEmoji: p.defaultEmoji,
  };
});

/** The link-to-a-service plugins (buttons only; RoleLogic's role linkers). */
export const LINK_SERVICES: { id: string; name: string; desc: string }[] = REGISTRY.filter(
  (p) => p.kind === "link",
).map((p) => ({ id: p.id, name: p.name, desc: p.description }));

/**
 * What a Button's "Add an action" library counts (PluginLibraryModal.tsx
 * placeholderFor): interactive plugins targeting a button + every link
 * service → "Search 25 actions…", headers "INTERACTIVE 8" / "LINK TO A SERVICE 17".
 */
export const PLUGIN_COUNTS = {
  interactive: PLUGINS.length,
  interactiveForButton: PLUGINS.filter((p) => p.forButton).length,
  linkServices: LINK_SERVICES.length,
  get buttonActions() {
    return this.interactiveForButton + this.linkServices;
  },
};

export const pluginById = (id: string): PluginInfo => {
  const p = PLUGINS.find((x) => x.id === id);
  if (!p) throw new Error(`data.ts: no plugin "${id}" in registry.json`);
  return p;
};

/* ── Templates (src/data/presets.ts) ────────────────────────────────────── */

/** `TEMPLATES.length` in presets.ts → "Search 36 templates…". */
export const TEMPLATE_COUNT = 36;

export type TemplateMeta = {
  id: string;
  name: string;
  emoji: string;
  category: string;
  description: string;
  /** The template's accent_color — the card's top stripe. */
  accent: string;
  /** requiresBot → the card's amber "Interactive" badge. */
  interactive?: boolean;
  /** The plugin chip under the description. */
  pairsWith?: string;
};

/** The directory cards the film can show, verbatim, in catalogue order. */
export const DIRECTORY_TEMPLATES: TemplateMeta[] = [
  {
    id: "showcase",
    name: "Component showcase",
    emoji: "🧩",
    category: "Featured",
    description: "A guided tour of every block — the best place to learn the editor.",
    accent: "#5865f2",
  },
  {
    id: "welcome",
    name: "Welcome",
    emoji: "👋",
    category: "Welcome",
    description: "Greet new members and point them to the essentials.",
    accent: "#5865f2",
  },
  {
    id: "announcement",
    name: "Announcement",
    emoji: "📢",
    category: "Community",
    description: "A borderless, image-led banner for big news.",
    accent: "#5865f2",
  },
  {
    id: "spotlight",
    name: "Member spotlight",
    emoji: "🌟",
    category: "Fun",
    description: "A borderless gallery to feature community work.",
    accent: "#fee75c",
  },
  {
    id: "event",
    name: "Event / RSVP",
    emoji: "🎟️",
    category: "Events",
    description: "A dated event card with cover art and a working one-tap RSVP button.",
    accent: "#e67e22",
    interactive: true,
    pairsWith: "Self Role",
  },
  {
    id: "giveaway-button",
    name: "Giveaway",
    emoji: "🎉",
    category: "Events",
    description: "One-click entry — the prize, live entrant count, and winners fill themselves in.",
    accent: "#fee75c",
    interactive: true,
    pairsWith: "Giveaway",
  },
  {
    id: "patch-notes",
    name: "Patch notes",
    emoji: "🛠️",
    category: "Community",
    description: "Tidy New / Improved / Fixed changelog sections.",
    accent: "#9b59b6",
  },
  {
    id: "poll",
    name: "Poll",
    emoji: "📊",
    category: "Events",
    description: "A live poll with real ballots — bars, counts and status update on the message.",
    accent: "#3498db",
    interactive: true,
    pairsWith: "Poll",
  },
];

export const templateById = (id: string): TemplateMeta => {
  const t = DIRECTORY_TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`data.ts: no directory template "${id}"`);
  return t;
};

/* ── Cast ───────────────────────────────────────────────────────────────── */

/**
 * The story cast lives in story/campaign.ts (Aria = you, Kai = the one
 * teammate — Free rooms allow 2 co-editors, so the Activity coda never shows a
 * third).
 */
export const CAST = {
  ...STORY_CAST,
} as const;
