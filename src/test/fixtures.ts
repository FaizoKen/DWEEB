/**
 * Shared, deterministic message fixtures for the unit suite.
 *
 * These are plain literals (not factory output) so a test — and a diff reviewer
 * — can see the exact tree under assertion. Editor `_id`s are hand-written and
 * unique within each message; they are stripped from the wire form, so their
 * values never affect share-token output.
 */

import {
  ButtonStyle,
  ComponentType,
  SeparatorSpacing,
  type ActionRowComponent,
  type ContainerComponent,
  type SectionComponent,
  type StringSelectComponent,
  type TextDisplayComponent,
  type WebhookMessage,
} from "@/core/schema/types";

/** The simplest legal message: a single Text Display. */
export function simpleTextMessage(): WebhookMessage {
  return {
    components: [{ _id: "t1", type: ComponentType.TextDisplay, content: "Hello, world!" }],
  };
}

/**
 * A broad, valid message that exercises most of the schema surface: message
 * overrides, a coloured container wrapping a section-with-thumbnail, a button
 * row (link + interactive), a separator, and a media gallery.
 */
export function richMessage(): WebhookMessage {
  const heading: TextDisplayComponent = {
    _id: "s-text",
    type: ComponentType.TextDisplay,
    content: "# Welcome\nGlad you're here.",
  };
  const section: SectionComponent = {
    _id: "sec",
    type: ComponentType.Section,
    components: [heading],
    accessory: {
      _id: "thumb",
      type: ComponentType.Thumbnail,
      media: { url: "https://example.com/logo.png" },
      description: "Server logo",
    },
  };
  const buttons: ActionRowComponent = {
    _id: "row",
    type: ComponentType.ActionRow,
    components: [
      {
        _id: "btn-link",
        type: ComponentType.Button,
        style: ButtonStyle.Link,
        label: "Docs",
        url: "https://example.com/docs",
      },
      {
        _id: "btn-act",
        type: ComponentType.Button,
        style: ButtonStyle.Primary,
        label: "Verify",
        custom_id: "verify_me",
      },
    ],
  };
  const separator: ContainerComponent["components"][number] = {
    _id: "sep",
    type: ComponentType.Separator,
    divider: true,
    spacing: SeparatorSpacing.Small,
  };
  const container: ContainerComponent = {
    _id: "cont",
    type: ComponentType.Container,
    accent_color: 0x5865f2,
    components: [section, buttons, separator],
  };

  return {
    username: "Announcer",
    avatar_url: "https://example.com/avatar.png",
    suppress_notifications: true,
    allowed_mentions: { parse: ["users"] },
    components: [
      container,
      {
        _id: "gallery",
        type: ComponentType.MediaGallery,
        items: [
          { _id: "g1", media: { url: "https://example.com/1.png" }, description: "One" },
          { _id: "g2", media: { url: "https://example.com/2.png" } },
        ],
      },
    ],
  };
}

/** A message whose sole top-level component is an action row with a select. */
export function selectMessage(): WebhookMessage {
  const select: StringSelectComponent = {
    _id: "sel",
    type: ComponentType.StringSelect,
    custom_id: "pick_role",
    placeholder: "Choose a role",
    min_values: 1,
    max_values: 2,
    options: [
      { label: "Red", value: "red" },
      { label: "Green", value: "green" },
      { label: "Blue", value: "blue" },
    ],
  };
  const row: ActionRowComponent = {
    _id: "row",
    type: ComponentType.ActionRow,
    components: [select],
  };
  return { components: [row] };
}

/** Every fixture, keyed by a stable name — the golden generator iterates this. */
export const FIXTURES: Record<string, () => WebhookMessage> = {
  simpleText: simpleTextMessage,
  rich: richMessage,
  select: selectMessage,
};
