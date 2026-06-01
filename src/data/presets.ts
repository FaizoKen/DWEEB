/**
 * Built-in message templates.
 *
 * Each template is a self-contained Components V2 message a user can drop into
 * the editor as a starting point. Applying one replaces the active message
 * wholesale. Templates carry no editor ids; the loader assigns fresh ones (see
 * `messageStore.bootstrap` / `replaceMessage`) so a template can be applied
 * repeatedly without colliding ids.
 *
 * The set is deliberately small and each template wears a distinct look — a
 * striped kitchen-sink, a borderless image-led layout, a typographic rulebook,
 * and a side-by-side card — so they read as different starting points rather
 * than recolors of one another. Every template is **static**: layout, text,
 * media, and link buttons only — no select menus or clickable (custom_id)
 * buttons, so they post cleanly through any webhook without a bot.
 */

import {
  ButtonStyle,
  ComponentType,
  SeparatorSpacing,
  type WebhookMessage,
} from "@/core/schema/types";
import { newId } from "@/lib/id";

const id = newId;

/** A named, pickable starting message shown in the Saved → Templates menu. */
export interface MessageTemplate {
  /** Stable key — used as the React key and to address the template. */
  id: string;
  /** Short display name. */
  name: string;
  /** One-line description of the use case, shown under the name. */
  description: string;
  /** Leading glyph for the menu row. */
  emoji: string;
  /** The message this template drops into the editor. */
  message: WebhookMessage;
}

// ────────────────────────────────────────────────────────────────────────────
// Component showcase — striped blurple container, the full kit. The original
// default tour and the first-run message.
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_MESSAGE: WebhookMessage = {
  username: "Webhook Builder",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: 0x5865f2,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "# 🧩 Components V2 — the full kit\nA quick tour of every block this editor supports. Click any component on the left to edit it.",
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Small,
        },
        {
          _id: id(),
          type: ComponentType.Section,
          components: [
            {
              _id: id(),
              type: ComponentType.TextDisplay,
              content:
                "**Sections** pair 1–3 text blocks with a single accessory — either a Thumbnail (like this) or a Button. Great for headshots, product cards, or call-outs.",
            },
          ],
          accessory: {
            _id: id(),
            type: ComponentType.Thumbnail,
            media: { url: "https://picsum.photos/seed/wb-thumb/256/256" },
            description: "Showcase thumbnail",
          },
        },
        {
          _id: id(),
          type: ComponentType.MediaGallery,
          items: [
            {
              _id: id(),
              media: { url: "https://picsum.photos/seed/wb-g1/600/400" },
              description: "Galleries support up to 10 items",
            },
            {
              _id: id(),
              media: { url: "https://picsum.photos/seed/wb-g2/600/400" },
              description: "Each item can have a description",
            },
            {
              _id: id(),
              media: { url: "https://picsum.photos/seed/wb-g3/600/400" },
              description: "Mark individual items as spoilers",
            },
          ],
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Large,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "**Also in the kit**\n- 📝 Text displays with full markdown (you're reading two)\n- 🪟 Containers with an accent stripe (this one!)\n- 🔗 Link buttons that open URLs (below)",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "Discord docs",
              url: "https://discord.com/developers/docs/components/reference",
            },
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "Join the Discord",
              url: "https://discord.gg/2wB7rHRDg2",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# There's more in this editor than the tour shows — dropdown menus, clickable (non-link) buttons, and file uploads all work too. File uploads go through any webhook, but Discord only accepts interactive components (clickable buttons, select menus) when the webhook URL was created by a bot or app — on regular user-created webhooks the message will be rejected. Link buttons and layout-only components are fine on any webhook. Open **Saved → Templates** any time to bring this tour back.",
    },
  ],
};

// ────────────────────────────────────────────────────────────────────────────
// Announcement — borderless and image-led. No container (no accent stripe): a
// full-width banner up top, headline, highlights, and call-to-action links.
// ────────────────────────────────────────────────────────────────────────────

const ANNOUNCEMENT_MESSAGE: WebhookMessage = {
  username: "Announcements",
  components: [
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "# 📢 Announcement\n**A quick heads-up for everyone** — here's what's new and what it means for you.",
    },
    {
      _id: id(),
      type: ComponentType.MediaGallery,
      items: [
        {
          _id: id(),
          media: { url: "https://picsum.photos/seed/wb-banner/900/320" },
          description: "Announcement banner",
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "We just rolled out a big update — faster, cleaner, and packed with the features you asked for. Skim the highlights, then dive in:\n- 🚀 Noticeably faster across the board\n- 🎨 A fresh new look\n- 🛠️ Dozens of fixes and tweaks",
    },
    {
      _id: id(),
      type: ComponentType.Separator,
      divider: true,
      spacing: SeparatorSpacing.Small,
    },
    {
      _id: id(),
      type: ComponentType.ActionRow,
      components: [
        {
          _id: id(),
          type: ComponentType.Button,
          style: ButtonStyle.Link,
          label: "Read the full post",
          url: "https://example.com/announcement",
        },
        {
          _id: id(),
          type: ComponentType.Button,
          style: ButtonStyle.Link,
          label: "Join the discussion",
          url: "https://discord.gg/2wB7rHRDg2",
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content: "-# Posted by the team • Thanks for being part of the community 💜",
    },
  ],
};

// ────────────────────────────────────────────────────────────────────────────
// Server rules — striped green container, purely typographic. No media, no
// buttons: a heading, a numbered list, and a consequences blockquote.
// ────────────────────────────────────────────────────────────────────────────

const RULES_MESSAGE: WebhookMessage = {
  username: "Server Rules",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: 0x57f287,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "# 📜 Server Rules\nWelcome! Being here means you agree to follow these.",
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Large,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "**1.** Be respectful — no harassment, hate speech, or discrimination.\n**2.** Keep it civil — no spam, flooding, or wall-to-wall caps.\n**3.** Use the right channels and stay on topic.\n**4.** No NSFW, gore, or illegal content.\n**5.** No unsolicited advertising or DM spam.\n**6.** Follow staff direction — their word is final.",
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Small,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "> Breaking the rules may lead to a warning, mute, kick, or ban depending on severity.",
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content: "-# Last updated June 2026 • Questions? Ask a moderator.",
    },
  ],
};

// ────────────────────────────────────────────────────────────────────────────
// Giveaway — striped gold container built around a Section: prize details on
// the left, a prize thumbnail on the right, then the entry steps.
// ────────────────────────────────────────────────────────────────────────────

const GIVEAWAY_MESSAGE: WebhookMessage = {
  username: "Giveaways",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: 0xfee75c,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "# 🎉 GIVEAWAY 🎉",
        },
        {
          _id: id(),
          type: ComponentType.Section,
          components: [
            {
              _id: id(),
              type: ComponentType.TextDisplay,
              content:
                "### Win a $50 Gift Card!\n**🎁 Prize:** $50 Gift Card\n**🏆 Winners:** 1\n**⏰ Ends:** in 24 hours",
            },
          ],
          accessory: {
            _id: id(),
            type: ComponentType.Thumbnail,
            media: { url: "https://picsum.photos/seed/wb-prize/256/256" },
            description: "Prize",
          },
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Large,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "**How to enter**\n- 🎉 React below to enter\n- ✅ Make sure you're a member of the server\n- ⏳ A winner is drawn automatically when it ends",
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content: "-# Must be 18+ to claim • One entry per person • Good luck! 🍀",
    },
  ],
};

/**
 * Ordered template list shown in the Saved → Templates menu. The first entry
 * is the component showcase that doubles as the first-run default message.
 */
export const TEMPLATES: MessageTemplate[] = [
  {
    id: "showcase",
    name: "Component showcase",
    description: "A guided tour of every block",
    emoji: "🧩",
    message: DEFAULT_MESSAGE,
  },
  {
    id: "announcement",
    name: "Announcement",
    description: "Borderless banner for big news",
    emoji: "📢",
    message: ANNOUNCEMENT_MESSAGE,
  },
  {
    id: "rules",
    name: "Server rules",
    description: "Clean, numbered rulebook",
    emoji: "📜",
    message: RULES_MESSAGE,
  },
  {
    id: "giveaway",
    name: "Giveaway",
    description: "Prize card with entry steps",
    emoji: "🎉",
    message: GIVEAWAY_MESSAGE,
  },
];

/**
 * Used as the initial message on first visit (no draft, no share URL) and as
 * the fallback "default" message elsewhere. Mirrors `TEMPLATES[0]`.
 */
export const DEFAULT_PRESET: { message: WebhookMessage } = { message: DEFAULT_MESSAGE };
