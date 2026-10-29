/**
 * Which add-menu sketch a picker row previews. Split from `AddMenuPreview` so
 * the menu can describe its rows at boot while the sketches themselves (and
 * their stylesheet) load only once the menu is opened.
 */

import { ComponentType, type ComponentTypeValue } from "@/core/schema/types";

export type AddPreviewKind =
  | "container"
  | "section"
  | "section-thumbnail"
  | "section-button"
  | "text"
  | "gallery"
  | "separator"
  | "file"
  | "row"
  | "button"
  | "select-string"
  | "select-user"
  | "select-role"
  | "select-mentionable"
  | "select-channel";

/**
 * Which sketch a picker row previews. `group` is the expandable parent the
 * row sits under (if any): "Thumbnail" under Section previews the whole
 * section-with-thumbnail it will add, not a bare thumbnail.
 */
export function previewKindFor(
  type: ComponentTypeValue,
  group?: ComponentTypeValue,
): AddPreviewKind {
  if (group === ComponentType.Section) {
    return type === ComponentType.Thumbnail ? "section-thumbnail" : "section-button";
  }
  switch (type) {
    case ComponentType.Container:
      return "container";
    case ComponentType.Section:
      return "section";
    case ComponentType.TextDisplay:
      return "text";
    case ComponentType.MediaGallery:
      return "gallery";
    case ComponentType.Separator:
      return "separator";
    case ComponentType.File:
      return "file";
    case ComponentType.ActionRow:
      return "row";
    case ComponentType.Button:
      return "button";
    case ComponentType.StringSelect:
      return "select-string";
    case ComponentType.UserSelect:
      return "select-user";
    case ComponentType.RoleSelect:
      return "select-role";
    case ComponentType.MentionableSelect:
      return "select-mentionable";
    case ComponentType.ChannelSelect:
      return "select-channel";
    default:
      return "text";
  }
}
