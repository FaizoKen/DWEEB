/**
 * Example messages shown to first-time users.
 *
 * Each preset is fully self-contained — applying one replaces the active
 * message wholesale. Presets carry no editor ids; the loader assigns fresh
 * ones (see `messageStore.loadPreset`) so users can apply the same preset
 * twice without colliding ids.
 */

import {
  ButtonStyle,
  ComponentType,
  SeparatorSpacing,
  type WebhookMessage,
} from "@/core/schema/types";
import { newId } from "@/lib/id";

/**
 * A preset describes the message minus editor ids. The loader walks it once
 * and assigns ids so the in-memory tree satisfies the BaseComponent invariant.
 */
export interface MessagePreset {
  id: string;
  name: string;
  description: string;
  message: WebhookMessage;
}

const id = newId;

export const PRESETS: MessagePreset[] = [
  {
    id: "blank",
    name: "Blank message",
    description: "Empty starter — a single text box waiting for your content.",
    message: {
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "",
        },
      ],
    },
  },
  {
    id: "release-notes",
    name: "Release notes",
    description: "Containered changelog with a CTA button.",
    message: {
      username: "Release Bot",
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
                "# 🚀 Release v1.4.0\nSeveral quality-of-life improvements and a few performance wins.",
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
                "**Highlights**\n- ⚡ 30% faster cold start\n- 🧩 New plugin API\n- 🐛 Fixed crash on Windows ARM",
            },
            {
              _id: id(),
              type: ComponentType.ActionRow,
              components: [
                {
                  _id: id(),
                  type: ComponentType.Button,
                  style: ButtonStyle.Link,
                  label: "Read the changelog",
                  url: "https://github.com",
                },
                {
                  _id: id(),
                  type: ComponentType.Button,
                  style: ButtonStyle.Link,
                  label: "Download",
                  url: "https://github.com",
                },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    id: "event-card",
    name: "Event card",
    description: "Section with a thumbnail and a join button.",
    message: {
      components: [
        {
          _id: id(),
          type: ComponentType.Container,
          accent_color: 0xeb459e,
          components: [
            {
              _id: id(),
              type: ComponentType.Section,
              components: [
                {
                  _id: id(),
                  type: ComponentType.TextDisplay,
                  content:
                    "## Community Game Night 🎮\n**Friday · 8 PM UTC** — bring a friend.",
                },
              ],
              accessory: {
                _id: id(),
                type: ComponentType.Thumbnail,
                media: {
                  url: "https://placehold.co/256x256/eb459e/ffffff/png?text=Event",
                },
              },
            },
            {
              _id: id(),
              type: ComponentType.ActionRow,
              components: [
                {
                  _id: id(),
                  type: ComponentType.Button,
                  style: ButtonStyle.Link,
                  label: "RSVP",
                  url: "https://discord.com/events",
                },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    id: "minimal-text",
    name: "Minimal text",
    description: "Just a single TextDisplay — the smallest valid V2 message.",
    message: {
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "Hello, world! This message uses **Components V2**.",
        },
      ],
    },
  },
];

/**
 * Preset used as a fallback when no draft and no share URL is present.
 * Kept as the showcase "release-notes" message rather than the blank one
 * so first-time-loads-with-welcome-dismissed still see something useful.
 */
export const DEFAULT_PRESET = PRESETS.find((p) => p.id === "release-notes")!;

/** Convenience: the empty starter, used by the welcome dialog's "Blank" path. */
export const BLANK_PRESET = PRESETS.find((p) => p.id === "blank")!;
