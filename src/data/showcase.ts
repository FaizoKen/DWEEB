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
import { newId } from "@/lib/id";

const id = newId;

/** Discord blurple — the showcase container's accent (mirrors `ACCENT.blurple`
 *  in `presets.ts`; inlined here so this module stays self-contained). */
const ACCENT_BLURPLE = 0x5865f2;

// Component showcase — striped blurple container, the full kit. Doubles as the
// first-run default message.
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
        "-# There's more in this editor than the tour shows — dropdown menus, clickable (non-link) buttons, and file uploads all work too. File uploads go through any webhook, but Discord only accepts interactive components (clickable buttons, select menus) when the webhook URL was created by a bot or app — on regular user-created webhooks the message will be rejected. Link buttons and layout-only components are fine on any webhook. Open the **Template Gallery** any time to bring this tour back.",
    },
  ],
};

/**
 * Used as the initial message on first visit (no draft, no share URL) and as
 * the fallback "default" message elsewhere. Mirrors `TEMPLATES[0]`.
 */
export const DEFAULT_PRESET: { message: WebhookMessage } = { message: SHOWCASE_MESSAGE };
