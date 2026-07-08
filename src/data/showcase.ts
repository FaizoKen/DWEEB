/**
 * First-run default message (the "Component showcase").
 *
 * Kept in its own module — separate from the full template catalog in
 * `presets.ts` — because the editor store imports it eagerly (it's the initial
 * message when there's no saved draft or share link) and that import lands in
 * the always-loaded main chunk. The other ~two-dozen templates are only needed
 * when the (lazily loaded) Template Gallery opens, so `presets.ts` is reachable
 * only from those lazy chunks. Splitting the showcase out keeps the rest of the
 * catalog off the critical path. `presets.ts` re-uses `SHOWCASE_MESSAGE` here
 * for its `TEMPLATES[0]` entry, so the showcase is defined exactly once.
 */

import {
  ButtonStyle,
  ComponentType,
  SeparatorSpacing,
  type WebhookMessage,
} from "@/core/schema/types";
import { DEFAULT_MEDIA } from "@/core/media/defaultMedia";
import { newId } from "@/lib/id";

const id = newId;

/** Discord blurple — the showcase container's accent (mirrors `ACCENT.blurple`
 *  in `presets.ts`; inlined here so this module stays self-contained). */
const ACCENT_BLURPLE = 0x5865f2;

// Component showcase — striped blurple container, the full kit. Doubles as the
// first-run default message, so it's the first thing every visitor sees: a
// guided tour that demonstrates each block (not just names it) while staying
// webhook-safe — only link buttons and layout, nothing that needs a bot.
export const SHOWCASE_MESSAGE: WebhookMessage = {
  username: "DWEEB",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: ACCENT_BLURPLE,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "# 🧩 The Components V2 starter kit\nA hands-on tour of every block DWEEB gives you — and it's all live. **Click any component on the left to edit it**, watch the preview update instantly, then hit **Send** or **Share** when it looks right.",
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Large,
        },
        {
          _id: id(),
          type: ComponentType.Section,
          components: [
            {
              _id: id(),
              type: ComponentType.TextDisplay,
              content:
                "**Sections** set a short stack of text beside a single accessory. Pair one with a **thumbnail** — like this — for profile cards, product shots, and tidy call-outs.",
            },
          ],
          accessory: {
            _id: id(),
            type: ComponentType.Thumbnail,
            media: { url: DEFAULT_MEDIA.thumbnail },
            description: "Thumbnail accessory",
          },
        },
        {
          _id: id(),
          type: ComponentType.Section,
          components: [
            {
              _id: id(),
              type: ComponentType.TextDisplay,
              content:
                "Give a section a **button** instead and the same layout becomes an action card: a headline, a line of detail, and one tappable action docked on the right.",
            },
          ],
          accessory: {
            _id: id(),
            type: ComponentType.Button,
            style: ButtonStyle.Link,
            label: "Open",
            url: "https://dweeb.faizo.net",
          },
        },
        {
          _id: id(),
          type: ComponentType.MediaGallery,
          items: [
            {
              _id: id(),
              media: { url: DEFAULT_MEDIA.showcaseGallery1 },
              description: "Media galleries hold up to 10 images or clips",
            },
            {
              _id: id(),
              media: { url: DEFAULT_MEDIA.showcaseGallery2 },
              description: "Give every item its own description…",
            },
            {
              _id: id(),
              media: { url: DEFAULT_MEDIA.showcaseGallery3 },
              description: "…or mark any one of them as a spoiler",
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
            "**Every text block speaks full Discord markdown.**\nBlend **bold**, *italic*, __underline__, ~~strikethrough~~, `inline code`, and ||spoilers|| — each renders exactly as Discord shows it. Drop in [masked links](https://dweeb.faizo.net), lists, and quotes wherever you need them:\n> Good messages look effortless. DWEEB just makes effortless easy.",
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "**There's even more in the box** — dropdown menus, clickable (non-link) buttons, and file uploads are all one tap away in the **Add component** menu.",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "📖 Read the docs",
              url: "https://discord.com/developers/docs/components/reference",
            },
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "💬 Join the Discord",
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
        "-# 💡 **Posts through any webhook:** text, layout, media, and link buttons. Interactive pieces — clickable buttons and select menus — need a **bot or app** to own the webhook; a plain user webhook will reject them.\n-# Reopen this tour any time from the **Template Gallery**, or hit **Reset** (top-left) to start fresh.",
    },
  ],
};

/**
 * Used as the initial message on first visit (no draft, no share URL) and as
 * the fallback "default" message elsewhere. Mirrors `TEMPLATES[0]`.
 */
export const DEFAULT_PRESET: { message: WebhookMessage } = { message: SHOWCASE_MESSAGE };
