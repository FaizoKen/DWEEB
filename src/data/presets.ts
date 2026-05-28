/**
 * Default example message shown to first-time users.
 *
 * Self-contained — applying it replaces the active message wholesale. Carries
 * no editor ids; the loader assigns fresh ones (see `messageStore.bootstrap`
 * and `replaceMessage`) so it can be applied repeatedly without colliding ids.
 */

import {
  ButtonStyle,
  ComponentType,
  SeparatorSpacing,
  type WebhookMessage,
} from "@/core/schema/types";
import { newId } from "@/lib/id";

const id = newId;

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
              media: { url: "https://picsum.photos/seed/wb-g1/600/400" },
              description: "Galleries support up to 10 items",
            },
            {
              media: { url: "https://picsum.photos/seed/wb-g2/600/400" },
              description: "Each item can have a description",
            },
            {
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
              label: "Source on GitHub",
              url: "https://github.com",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# There's more in this editor than the tour shows — dropdown menus, clickable (non-link) buttons, and file uploads all work too. File uploads go through any webhook, but Discord only accepts interactive components (clickable buttons, select menus) when the webhook URL was created by a bot or app — on regular user-created webhooks the message will be rejected. Link buttons and layout-only components are fine on any webhook. Hit **Reset** any time to bring this tour back.",
    },
  ],
};

/**
 * Used as the initial message on first visit (no draft, no share URL) and
 * by the Builder's "Reset" button.
 */
export const DEFAULT_PRESET: { message: WebhookMessage } = { message: DEFAULT_MESSAGE };
