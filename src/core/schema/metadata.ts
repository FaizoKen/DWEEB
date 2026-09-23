/**
 * Human-facing labels for component types.
 *
 * Kept out of the type definitions so that pure schema imports don't pull in
 * any UI strings. The builder, share dialog, and tree all read from here.
 */

import { ChannelType, ComponentType, type ComponentTypeValue } from "./types";

interface ComponentMeta {
  /** What the tree, the preview and the editor's toasts call a component. */
  label: string;
  /** The add menu's one-line explanation of the entry. */
  description: string;
  /** Single-glyph icon used in the tree/picker. */
  glyph: string;
  /**
   * The add menu's name for the entry, when adding one reads differently from
   * what the tree calls the result. People open the add menu looking for a
   * button or a dropdown, never for the row that has to hold it — so the action
   * row is offered as "Buttons & menus" and sits in the tree as the row it is.
   */
  addLabel?: string;
}

/*
 * The five selects are named for what they list, in the same words the
 * template setup already uses (`targetNoun`), and each description keeps
 * Discord's own name for anyone who knows the API. A select is still a "menu"
 * throughout the editor — the Action panel, the add menu's group, validation.
 */
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
    label: "Media gallery",
    description: "Up to 10 images or videos in a grid.",
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
    label: "Action row",
    addLabel: "Buttons & menus",
    description: "A row of up to 5 buttons, or one dropdown menu.",
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
    label: "Options menu",
    description: "A dropdown of options you write (Discord’s string select).",
    glyph: "▾",
  },
  [ComponentType.TextInput]: {
    label: "Text input",
    description: "Modal text input (not allowed in messages).",
    glyph: "▭",
  },
  [ComponentType.UserSelect]: {
    label: "Member menu",
    description: "A dropdown of the server’s members (Discord’s user select).",
    glyph: "▾",
  },
  [ComponentType.RoleSelect]: {
    label: "Role menu",
    description: "A dropdown of the server’s roles (Discord’s role select).",
    glyph: "▾",
  },
  [ComponentType.MentionableSelect]: {
    label: "Member / role menu",
    description: "A dropdown of members and roles (Discord’s mentionable select).",
    glyph: "▾",
  },
  [ComponentType.ChannelSelect]: {
    label: "Channel menu",
    description: "A dropdown of the server’s channels (Discord’s channel select).",
    glyph: "▾",
  },
};

/** The add menu's name for a component type — its `addLabel` when adding reads
 *  differently from what the tree calls the result, else its label. */
export function addMenuLabel(type: ComponentTypeValue): string {
  const meta = COMPONENT_META[type];
  return meta.addLabel ?? meta.label;
}

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
