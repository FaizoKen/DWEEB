/**
 * Human-facing labels for component types.
 *
 * Kept out of the type definitions so that pure schema imports don't pull in
 * any UI strings. The builder, share dialog, and tree all read from here.
 */

import { ComponentType, type ComponentTypeValue } from "./types";

interface ComponentMeta {
  label: string;
  description: string;
  /** Single-glyph icon used in the tree/picker. */
  glyph: string;
}

export const COMPONENT_META: Record<ComponentTypeValue, ComponentMeta> = {
  [ComponentType.Container]: {
    label: "Container",
    description: "Grouped block with an accent stripe.",
    glyph: "▤",
  },
  [ComponentType.Section]: {
    label: "Section",
    description: "Text alongside a button or thumbnail.",
    glyph: "◧",
  },
  [ComponentType.TextDisplay]: {
    label: "Text",
    description: "Markdown text block.",
    glyph: "¶",
  },
  [ComponentType.MediaGallery]: {
    label: "Media Gallery",
    description: "Up to 10 images in a grid.",
    glyph: "▦",
  },
  [ComponentType.File]: {
    label: "File",
    description: "Attached file reference.",
    glyph: "⎘",
  },
  [ComponentType.Separator]: {
    label: "Separator",
    description: "Spacer or divider line.",
    glyph: "―",
  },
  [ComponentType.ActionRow]: {
    label: "Buttons Row",
    description: "Up to 5 buttons side-by-side.",
    glyph: "⬚",
  },
  [ComponentType.Button]: {
    label: "Button",
    description: "Link, action, or premium button.",
    glyph: "▭",
  },
  [ComponentType.Thumbnail]: {
    label: "Thumbnail",
    description: "Small image used as a section accessory.",
    glyph: "▣",
  },
  // Selects/TextInput aren't part of the V2 webhook editor surface but the
  // map is exhaustive so component-type switches stay total.
  [ComponentType.StringSelect]: {
    label: "String Select",
    description: "Interactive select (requires a bot).",
    glyph: "▾",
  },
  [ComponentType.TextInput]: {
    label: "Text Input",
    description: "Modal text input (requires a bot).",
    glyph: "▭",
  },
  [ComponentType.UserSelect]: {
    label: "User Select",
    description: "Interactive user picker (requires a bot).",
    glyph: "▾",
  },
  [ComponentType.RoleSelect]: {
    label: "Role Select",
    description: "Interactive role picker (requires a bot).",
    glyph: "▾",
  },
  [ComponentType.MentionableSelect]: {
    label: "Mentionable Select",
    description: "Interactive mentionable picker (requires a bot).",
    glyph: "▾",
  },
  [ComponentType.ChannelSelect]: {
    label: "Channel Select",
    description: "Interactive channel picker (requires a bot).",
    glyph: "▾",
  },
};

/**
 * Components V2 component types the editor exposes in the "add" menu.
 * Selects and TextInput are excluded because they require interactions which
 * a webhook-only app cannot handle.
 */
export const TOP_LEVEL_PICKER: ComponentTypeValue[] = [
  ComponentType.Container,
  ComponentType.Section,
  ComponentType.TextDisplay,
  ComponentType.MediaGallery,
  ComponentType.Separator,
  ComponentType.File,
  ComponentType.ActionRow,
];

export const CONTAINER_PICKER: ComponentTypeValue[] = [
  ComponentType.Section,
  ComponentType.TextDisplay,
  ComponentType.MediaGallery,
  ComponentType.Separator,
  ComponentType.File,
  ComponentType.ActionRow,
];
