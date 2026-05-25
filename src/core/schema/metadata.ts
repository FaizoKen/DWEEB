/**
 * Human-facing labels for component types.
 *
 * Kept out of the type definitions so that pure schema imports don't pull in
 * any UI strings. The builder, share dialog, and tree all read from here.
 */

import { ChannelType, ComponentType, type ComponentTypeValue } from "./types";

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
    description: "Up to 5 buttons or one select side-by-side.",
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
  [ComponentType.StringSelect]: {
    label: "String Select",
    description: "Dropdown of custom options (needs a bot to handle clicks).",
    glyph: "▾",
  },
  [ComponentType.TextInput]: {
    label: "Text Input",
    description: "Modal text input (not allowed in messages).",
    glyph: "▭",
  },
  [ComponentType.UserSelect]: {
    label: "User Select",
    description: "Pick guild members (needs a bot to handle clicks).",
    glyph: "▾",
  },
  [ComponentType.RoleSelect]: {
    label: "Role Select",
    description: "Pick guild roles (needs a bot to handle clicks).",
    glyph: "▾",
  },
  [ComponentType.MentionableSelect]: {
    label: "Mentionable Select",
    description: "Pick users or roles (needs a bot to handle clicks).",
    glyph: "▾",
  },
  [ComponentType.ChannelSelect]: {
    label: "Channel Select",
    description: "Pick channels (needs a bot to handle clicks).",
    glyph: "▾",
  },
};

/**
 * Components V2 component types the editor exposes in the "add" menu.
 * TextInput is excluded because it only appears inside modals.
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

/**
 * Picker entries used for the "fill empty action row with…" menu — covers
 * the five select component types. A row holds EITHER buttons OR a single
 * select; once content is added the other class is hidden by the UI.
 */
export const ROW_SELECT_PICKER: ComponentTypeValue[] = [
  ComponentType.StringSelect,
  ComponentType.UserSelect,
  ComponentType.RoleSelect,
  ComponentType.MentionableSelect,
  ComponentType.ChannelSelect,
];

/**
 * Human-facing labels for the channel-type filter on Channel Select. Used by
 * the inspector; numeric values mirror `ChannelType` in `types.ts`.
 */
export const CHANNEL_TYPE_LABELS: Record<number, string> = {
  [ChannelType.GuildText]: "Text",
  [ChannelType.DM]: "DM",
  [ChannelType.GuildVoice]: "Voice",
  [ChannelType.GroupDM]: "Group DM",
  [ChannelType.GuildCategory]: "Category",
  [ChannelType.GuildAnnouncement]: "Announcement",
  [ChannelType.AnnouncementThread]: "Announcement thread",
  [ChannelType.PublicThread]: "Public thread",
  [ChannelType.PrivateThread]: "Private thread",
  [ChannelType.GuildStageVoice]: "Stage",
  [ChannelType.GuildDirectory]: "Directory",
  [ChannelType.GuildForum]: "Forum",
  [ChannelType.GuildMedia]: "Media",
};
