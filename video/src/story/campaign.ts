/**
 * THE STORY — every piece of copy and state the v6 film shows, in one module.
 *
 * One Season 4 campaign message travels from a stock template to a working
 * message in the server; the Activity coda edits the NEXT message ("Launch
 * night"). Scenes and shared components read from here so copy cannot drift
 * between shots, and hold cuts match because both sides derive their pixels
 * from the same state object.
 *
 * Pure TS on purpose (no React/Remotion imports): a Bun script at the repo root
 * imports `campaignPayload()` next to the product's real schema layer and
 * asserts the message is valid and that `campaignStats()` equals the real
 * countComponents/countCharacters (see video/out/stage1/ui/truthcheck.ts).
 *
 * Product strings are verbatim; each block cites where it lives in the app.
 */

import {
  COMPONENT_META,
  type ComponentKind,
  discordToday,
  graphemes,
  labelWithCount,
  previewClock,
  summarizeActionRow,
  summarizeContainer,
  summarizeGallery,
  summarizeText,
} from "./rules";

/* ── Cast & place ───────────────────────────────────────────────────────── */

/**
 * Aria is "you" (the signed-in builder); Kai is the one teammate who joins the
 * Activity — Free rooms allow 2 co-editors (server/src/config.rs:548), and the
 * VO asks for "another pair of hands". Kai also plays the member who clicks
 * Enter giveaway in Discord (a host's own click would open Host controls,
 * plugins/giveaway/src/discord.rs:321-331, not an entry). Mira and Theo are
 * the rest of the voice call Aria starts the Activity from; they stay in the
 * call (a third editor would be told the room is full on Free).
 */
export const CAST = {
  aria: { name: "Aria", color: "#eb459e" },
  kai: { name: "Kai", color: "#00a8fc" },
  mira: { name: "Mira", color: "#f0b232" },
  theo: { name: "Theo", color: "#23a559" },
} as const;
export type CastMember = { name: string; color: string };

/** The voice call the Activity coda opens in: the staff, hanging out. */
export const VOICE = {
  channel: "Staff Lounge",
  /** In call order (Discord lists the channel's members under it). */
  members: [CAST.aria, CAST.kai, CAST.mira, CAST.theo],
  /** Theo sits muted — a detail real calls always have. */
  muted: [CAST.theo.name] as readonly string[],
};

export const SERVER = {
  name: "Nebula Gaming",
  /** Channel-first send list, in the server's order. */
  channels: ["announcements", "general", "events"] as const,
};

/** The message's webhook identity: username override + the {server_icon} avatar. */
export const AUTHOR = "Nebula Gaming";
export const AVATAR_TOKEN = "{server_icon}";

/** The editor preview freezes its send time with toLocaleTimeString (2-digit). */
export const PREVIEW_TIME = previewClock(9, 41); // "09:41 AM"
/** Discord's own timestamp for the delivered message. */
export const DISCORD_TIME = discordToday(9, 41); // "Today at 9:41 AM"

/* ── The Season 4 campaign ──────────────────────────────────────────────── */

/**
 * Heading markdown level. The product's templates open with an H1 ("# 📢
 * Announcement", src/data/presets.ts ANNOUNCEMENT), and the preview renders H1
 * at 24px vs H3 at body size (preview/markdown/Markdown.module.css:26-34) — so
 * "# " is what makes the heading read as a heading AND matches the template's
 * first line verbatim.
 */
export const HEADING_LEVEL = "# ";

export const HEADING = {
  /** The Announcement template's own first line. */
  stock: "📢 Announcement",
  /** Typed in the Text row's inline editor during the build beat. */
  final: "🚀 Season 4 is live",
} as const;

export const BODY = {
  stock:
    "New maps, ranked rewards, and a fresh battle pass. Jump in and claim your founder badge before the weekend.",
  /** The AI's "punchier opening". */
  punchy:
    "New worlds. Bigger rewards. Season 4 starts now — claim your founder badge before the weekend.",
} as const;

/**
 * Media gallery items — the film paints the art (DiscordUI NebulaTile kinds).
 * No alt text on purpose: Discord (and the preview) badge every described
 * image "ALT", which would sit on top of the key art in every shot.
 */
export const GALLERY = [
  { art: "hero", file: "season-4-hero.png" },
  { art: "sun", file: "season-4-sunrise.png" },
  { art: "ridge", file: "season-4-ridge.png" },
] as const;
export type GalleryArt = (typeof GALLERY)[number]["art"];

/**
 * The stock Announcement template's own key art. Making the message "yours"
 * includes dropping in the Season 4 hero, so the stock state paints generic
 * `aurora` art over the gallery's hero slot (shaped as DGallery's `swap`, with
 * t = 1 showing it), and the build's gallery check crossfades it back to
 * `hero` — the gallery of every later stage and of the hook's AFTER card.
 * The directory's Announcement card previews this same art: the card shows
 * exactly what "Use this template" loads.
 */
export const STOCK_ART = { index: 0, to: "aurora" } as const;

export type ButtonKind = "primary" | "secondary" | "success" | "danger" | "link";

export type CampaignButton = {
  id: string;
  label: string;
  kind: ButtonKind;
  /** Rendered in the emoji slot (1.375em), not part of the label text. */
  emoji?: string;
  /** Link buttons carry a url; every other style a custom_id. */
  url?: string;
  customId?: string;
};

export const BUTTONS = {
  /** A Discord Link button: grey with the ↗ glyph, works with zero setup. */
  patch: {
    id: "patch",
    label: "Patch notes",
    kind: "link",
    url: "https://example.com/season-4/patch-notes",
  },
  /** Added in the build beat through the Action row's "+ Add button". */
  claim: { id: "claim", label: "Claim reward", kind: "success", emoji: "🎁", customId: "claim_reward" },
  /** Added by the AI; later bound to the Giveaway plugin. */
  giveaway: {
    id: "giveaway",
    label: "Enter giveaway",
    kind: "primary",
    emoji: "🎉",
    customId: "enter_giveaway",
  },
} satisfies Record<string, CampaignButton>;

/** The plugin binding a Giveaway attach writes (custom_id prefix from registry.json). */
export const GIVEAWAY_CUSTOM_ID = "giveaway:s4founders";

export const SELECT = {
  placeholder: "Choose your platform…",
  /** A select's tree summary is its custom_id (ComponentTree.tsx:1795-1797). */
  customId: "platform",
  options: [
    { label: "PC", value: "pc", emoji: "🖥️" },
    { label: "Console", value: "console", emoji: "🎮" },
    { label: "Mobile", value: "mobile", emoji: "📱" },
  ],
} as const;

/** Container accent (DWEEB green) — also the preview's left stripe. */
export const CAMPAIGN_ACCENT = "#57F287";

/**
 * Stages of the one message, in story order:
 *  stock    — the Announcement template just loaded (templates → build start)
 *  retitled — heading typed to "🚀 Season 4 is live"
 *  reward   — + 🎁 Claim reward (success) via "+ Add button"
 *  select   — + Action row ▸ Options menu via "+ Add to container"
 *  final    — the AI's punchier body + 🎉 Enter giveaway (primary)
 *  attached — Enter giveaway bound to the Giveaway plugin; this exact message
 *             is the hook's AFTER card, the reveal card and the Discord post
 */
export const CAMPAIGN_STAGES = ["stock", "retitled", "reward", "select", "final", "attached"] as const;
export type CampaignStage = (typeof CAMPAIGN_STAGES)[number];

export const stageIndex = (s: CampaignStage) => CAMPAIGN_STAGES.indexOf(s);
/** True once the story has reached `at` (e.g. atLeast(stage, "reward")). */
export const atLeast = (stage: CampaignStage, at: CampaignStage) => stageIndex(stage) >= stageIndex(at);

export type CampaignState = {
  /** Heading text without the markdown prefix (may be mid-typing). */
  heading: string;
  body: string;
  buttons: CampaignButton[];
  hasSelect: boolean;
  giveawayBound: boolean;
};

export function campaignState(stage: CampaignStage, patch?: Partial<CampaignState>): CampaignState {
  const buttons: CampaignButton[] = [BUTTONS.patch];
  if (atLeast(stage, "reward")) buttons.push(BUTTONS.claim);
  if (atLeast(stage, "final")) buttons.push(BUTTONS.giveaway);
  const state: CampaignState = {
    heading: atLeast(stage, "retitled") ? HEADING.final : HEADING.stock,
    body: atLeast(stage, "final") ? BODY.punchy : BODY.stock,
    buttons,
    hasSelect: atLeast(stage, "select"),
    giveawayBound: atLeast(stage, "attached"),
  };
  return { ...state, ...patch };
}

/** The Text component's markdown: heading line + body (what the tree summarizes). */
export const textContent = (s: Pick<CampaignState, "heading" | "body">) =>
  `${HEADING_LEVEL}${s.heading}\n${s.body}`;

/**
 * The retitle, typed in the Text row's inline editor. The build scene selects
 * the whole stock heading ("📢 Announcement") and types the new one; the first
 * keystroke replaces the selection. Counted in graphemes so the emoji lands as
 * ONE keystroke (never half a surrogate pair).
 */
export const RETITLE_KEYS = graphemes(HEADING.final);
export function retitleHeading(typed: number): string {
  if (typed <= 0) return HEADING.stock;
  return RETITLE_KEYS.slice(0, Math.min(typed, RETITLE_KEYS.length)).join("");
}

/* ── Wire payload (Components V2) — the single source for validation/counts ── */

type WireButton = {
  type: 2;
  style: number;
  label: string;
  emoji?: { name: string };
  url?: string;
  custom_id?: string;
};

const STYLE_CODE: Record<ButtonKind, number> = { primary: 1, secondary: 2, success: 3, danger: 4, link: 5 };

function wireButton(b: CampaignButton, bound: boolean): WireButton {
  const out: WireButton = { type: 2, style: STYLE_CODE[b.kind], label: b.label };
  if (b.emoji) out.emoji = { name: b.emoji };
  if (b.kind === "link") out.url = b.url;
  else out.custom_id = b.id === "giveaway" && bound ? GIVEAWAY_CUSTOM_ID : b.customId;
  return out;
}

/** The message exactly as the editor would export it (stripEditorFields shape). */
export function campaignPayload(s: CampaignState) {
  const children: unknown[] = [
    { type: 10, content: textContent(s) },
    { type: 12, items: GALLERY.map((g) => ({ media: { url: `https://example.com/${g.file}` } })) },
    { type: 1, components: s.buttons.map((b) => wireButton(b, s.giveawayBound)) },
  ];
  if (s.hasSelect) {
    children.push({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: SELECT.customId,
          placeholder: SELECT.placeholder,
          options: SELECT.options.map((o) => ({ label: o.label, value: o.value, emoji: { name: o.emoji } })),
        },
      ],
    });
  }
  return {
    username: AUTHOR,
    avatar_url: AVATAR_TOKEN,
    components: [{ type: 17, accent_color: parseInt(CAMPAIGN_ACCENT.slice(1), 16), components: children }],
    flags: 32768,
  };
}

/**
 * The MetaHeader stat pills for a state, by the product's own rules
 * (traversal.ts countComponents / countCharacters): every component counts;
 * characters = text content + button labels + placeholder + option labels +
 * the username. Verified equal to the real functions for every stage.
 */
export function campaignStats(s: CampaignState): { components: number; chars: number } {
  const components = 1 /* container */ + 1 /* text */ + 1 /* gallery */ + 1 /* row */ + s.buttons.length + (s.hasSelect ? 2 : 0);
  let chars = AUTHOR.length + textContent(s).length;
  for (const b of s.buttons) chars += b.label.length;
  if (s.hasSelect) {
    chars += SELECT.placeholder.length;
    for (const o of SELECT.options) chars += o.label.length;
  }
  return { components, chars };
}

/* ── Tree model ─────────────────────────────────────────────────────────── */

export type TreeRowModel = {
  id: string;
  kind: ComponentKind;
  /** COMPONENT_META label. */
  label: string;
  /** Muted summary, per summarize(). */
  summary: string;
  depth: number;
};

export type TreeAdderModel = { id: "addButton" | "addToContainer"; label: string; depth: number; after: string };

/**
 * The campaign as the editor's tree shows it — Container ▸ Text ▸ Media gallery
 * ▸ Action row(buttons) ▸ Action row ▸ Options menu (9 rows in the final
 * state). Gallery item rows are folded away (the product lists each image as
 * its own row; the film keeps the tree to one row per component).
 */
export function campaignRows(s: CampaignState): TreeRowModel[] {
  const row = (id: string, kind: ComponentKind, summary: string, depth: number): TreeRowModel => ({
    id,
    kind,
    label: COMPONENT_META[kind].label,
    summary,
    depth,
  });
  const rows: TreeRowModel[] = [
    row("container", "container", summarizeContainer(3 + (s.hasSelect ? 1 : 0)), 0),
    row("text", "text", summarizeText(textContent(s)), 1),
    row("gallery", "gallery", summarizeGallery(GALLERY.length), 1),
    row("row1", "actionRow", summarizeActionRow(s.buttons.length), 1),
    ...s.buttons.map((b) => row(b.id, "button", b.label, 2)),
  ];
  if (s.hasSelect) {
    rows.push(row("row2", "actionRow", summarizeActionRow(0, true), 1));
    rows.push(row("select", "select", SELECT.customId, 2));
  }
  return rows;
}

/** The dashed adders the product renders under an Action row and a Container. */
export function campaignAdders(s: CampaignState): TreeAdderModel[] {
  const lastButton = s.buttons[s.buttons.length - 1].id;
  return [
    ...(s.buttons.length < 5 ? [{ id: "addButton" as const, label: "Add button", depth: 2, after: lastButton }] : []),
    { id: "addToContainer" as const, label: "Add to container", depth: 1, after: s.hasSelect ? "select" : lastButton },
  ];
}

/* ── AI assistant (src/features/ai/AiChatPanel.tsx) ─────────────────────── */

export const AI = {
  title: "AI Assistant", // :191
  placeholder: "Describe the message you want to build…", // :293
  prompt: "Make the opening punchier and add a giveaway button.",
  reply: "Punched up the opening and added an Enter giveaway button.",
  applied: "Updated the message", // :366
  undo: "Undo", // :381
  /** Signed-in built-in usage line (:264-265); Free = 8 requests/day (config.rs:558). */
  usage: (used: number) => `Free AI · ${used}/8 today`,
} as const;

/* ── Plugins (PluginPanel.tsx / PluginLibraryModal.tsx / giveaway config) ── */

export const GIVEAWAY_SETUP = {
  prize: "Founder badges",
  winners: 3,
  /** The config iframe's save summary: label + "{prize} · {n} winners" (config.html:771-774). */
  summaryLabel: "Giveaway",
  get summary() {
    return `${this.prize} · ${this.winners} winner${this.winners === 1 ? "" : "s"}`;
  },
  via: "via Giveaway",
};

/** Entry counts the public button restamps through as entries roll in. */
export const ENTRY_COUNTS = [129, 130, 131, 132, 134, 137] as const;
export const enterLabel = (count?: number) =>
  count === undefined ? BUTTONS.giveaway.label : labelWithCount(BUTTONS.giveaway.label, count);

/* ── Send (src/features/share/*) ─────────────────────────────────────────── */

export type ChannelStatus = "ready" | "create" | "busy";
export const SEND = {
  title: "Send message", // ShareDialog.tsx:88
  tabs: ["Send", "Update", "Restore", "Share link", "JSON", "Code", "About"], // ShareDialog.tsx:98-104
  lead: "Pick a channel below and hit send — your message goes straight from this browser to Discord. We never see or store it.", // sendCopy.ts:33
  timing: [
    { title: "Send now", sub: "Post immediately." },
    { title: "Schedule", sub: "Post at a set date & time." },
  ], // SendPanel.tsx:2051-2068
  pickerTitle: "Post to a channel", // GuildWebhookPicker.tsx:485
  pickerNote:
    "Choose where your message should go. DWEEB handles the technical setup behind the scenes — there's nothing to copy or configure.", // GuildWebhookPicker.tsx:980-981
  /** Film notes for the row's right edge (the product shows a check on a reusable channel). */
  status: { ready: "Webhook ready · reusing it", create: "Will create one", busy: "Setting up…" },
  channels: [
    { name: "announcements", status: "ready" as ChannelStatus },
    { name: "general", status: "create" as ChannelStatus },
    { name: "events", status: "create" as ChannelStatus },
  ],
  postingTo: "Posting to", // SendPanel.tsx:2863
  primary: "Send to webhook", // SendPanel.tsx:2945
};

/* ── Message directory (src/features/templates/*) ─────────────────────────── */

export const DIRECTORY = {
  title: "Message directory", // TemplateGallery.tsx:1052
  /** Signed-in subtitle (:1077) — the film's user is signed in. */
  subtitle: "Reload a posted message, reuse a saved one, or pick a template — everything is fully editable.",
  /** The same promise as a signed-out visitor reads it (:1076). */
  subtitleSignedOut: "Pick a template to start — every part is fully editable.",
  useTemplate: "Use this template", // galleryCards.tsx:259 (drawn with an SVG →)
  startFromScratch: "Start from scratch", // TemplateGallery.tsx:1467
};
export const pickToast = (name: string) => `Loaded the “${name}” template — make it yours, then Send.`; // TemplateGallery.tsx:714

/* ── Discord payoff ─────────────────────────────────────────────────────── */

/** Dimmed older posts seeded above the delivered message in #announcements. */
export const ANNOUNCEMENT_HISTORY = [
  { author: AUTHOR, time: "Yesterday at 6:12 PM", text: "Ranked queue is back online — thanks for your patience!" },
  { author: AUTHOR, time: "Yesterday at 8:30 PM", text: "Season 4 drops tomorrow. Set your alarms. ⏰" },
] as const;

export const REACTIONS = [
  { emoji: "🎉", counts: [1, 4, 9, 14, 21] },
  { emoji: "🔥", counts: [1, 3, 7, 12] },
] as const;

/* ── Activity coda: the NEXT message ─────────────────────────────────────── */

export const LAUNCH_NIGHT = {
  channel: "events",
  heading: "🎮 Launch night",
  /** Kai types this onto the heading, live. */
  headingSuffix: " — Friday!",
  body: "Customs at 7, movie after. Bring a friend — winners get the Founder role.",
  /** Orange like the product's Event / RSVP template accent (presets.ts, 15105570). */
  accent: "#e67e22",
  rsvp: { id: "rsvp", label: "RSVP", kind: "success", emoji: "🎟️", customId: "launch_rsvp" } satisfies CampaignButton,
  /** Aria adds this one; a new button starts Primary (createComponent.ts:54-62). */
  suggest: {
    id: "suggest",
    label: "Suggest a game",
    kind: "primary",
    emoji: "💡",
    customId: "suggest_game",
  } satisfies CampaignButton,
};

export type LaunchState = { heading: string; buttons: CampaignButton[] };

export function launchState(opts: { kaiTyped?: number; suggestAdded?: boolean } = {}): LaunchState {
  const suffix = graphemes(LAUNCH_NIGHT.headingSuffix);
  const typed = Math.max(0, Math.min(opts.kaiTyped ?? 0, suffix.length));
  return {
    heading: LAUNCH_NIGHT.heading + suffix.slice(0, typed).join(""),
    buttons: opts.suggestAdded ? [LAUNCH_NIGHT.rsvp, LAUNCH_NIGHT.suggest] : [LAUNCH_NIGHT.rsvp],
  };
}
export const LAUNCH_SUFFIX_KEYS = graphemes(LAUNCH_NIGHT.headingSuffix).length;

export const launchText = (s: LaunchState) => `${HEADING_LEVEL}${s.heading}\n${LAUNCH_NIGHT.body}`;

export function launchRows(s: LaunchState): TreeRowModel[] {
  const meta = (k: ComponentKind) => COMPONENT_META[k].label;
  return [
    { id: "container", kind: "container", label: meta("container"), summary: summarizeContainer(2), depth: 0 },
    { id: "text", kind: "text", label: meta("text"), summary: summarizeText(launchText(s)), depth: 1 },
    { id: "row", kind: "actionRow", label: meta("actionRow"), summary: summarizeActionRow(s.buttons.length), depth: 1 },
    ...s.buttons.map((b) => ({ id: b.id, kind: "button" as const, label: meta("button"), summary: b.label, depth: 2 })),
  ];
}

export function launchPayload(s: LaunchState) {
  return {
    username: AUTHOR,
    avatar_url: AVATAR_TOKEN,
    components: [
      {
        type: 17,
        accent_color: parseInt(LAUNCH_NIGHT.accent.slice(1), 16),
        components: [
          { type: 10, content: launchText(s) },
          { type: 1, components: s.buttons.map((b) => wireButton(b, false)) },
        ],
      },
    ],
    flags: 32768,
  };
}
