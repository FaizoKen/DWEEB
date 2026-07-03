/**
 * Type guards for discriminating Components V2 nodes by their `type` field.
 *
 * These exist so renderers/inspectors can switch on a single union without
 * littering casts at every call site. Each guard checks the discriminator
 * only — structural validity is the validator's job.
 */

import {
  ComponentType,
  type ActionRowComponent,
  type AnyComponent,
  type ButtonComponent,
  type ChannelSelectComponent,
  type ContainerComponent,
  type FileComponent,
  type MediaGalleryComponent,
  type MentionableSelectComponent,
  type RoleSelectComponent,
  type SectionComponent,
  type SelectComponent,
  type SeparatorComponent,
  type StringSelectComponent,
  type TextDisplayComponent,
  type ThumbnailComponent,
  type UserSelectComponent,
} from "./types";

export const isContainer = (c: AnyComponent): c is ContainerComponent =>
  c.type === ComponentType.Container;

export const isSection = (c: AnyComponent): c is SectionComponent =>
  c.type === ComponentType.Section;

export const isTextDisplay = (c: AnyComponent): c is TextDisplayComponent =>
  c.type === ComponentType.TextDisplay;

export const isThumbnail = (c: AnyComponent): c is ThumbnailComponent =>
  c.type === ComponentType.Thumbnail;

export const isMediaGallery = (c: AnyComponent): c is MediaGalleryComponent =>
  c.type === ComponentType.MediaGallery;

export const isFile = (c: AnyComponent): c is FileComponent => c.type === ComponentType.File;

export const isSeparator = (c: AnyComponent): c is SeparatorComponent =>
  c.type === ComponentType.Separator;

export const isActionRow = (c: AnyComponent): c is ActionRowComponent =>
  c.type === ComponentType.ActionRow;

export const isButton = (c: AnyComponent): c is ButtonComponent => c.type === ComponentType.Button;

export const isStringSelect = (c: AnyComponent): c is StringSelectComponent =>
  c.type === ComponentType.StringSelect;

export const isUserSelect = (c: AnyComponent): c is UserSelectComponent =>
  c.type === ComponentType.UserSelect;

export const isRoleSelect = (c: AnyComponent): c is RoleSelectComponent =>
  c.type === ComponentType.RoleSelect;

export const isMentionableSelect = (c: AnyComponent): c is MentionableSelectComponent =>
  c.type === ComponentType.MentionableSelect;

export const isChannelSelect = (c: AnyComponent): c is ChannelSelectComponent =>
  c.type === ComponentType.ChannelSelect;

export const isSelect = (c: AnyComponent): c is SelectComponent =>
  isStringSelect(c) ||
  isUserSelect(c) ||
  isRoleSelect(c) ||
  isMentionableSelect(c) ||
  isChannelSelect(c);

/**
 * True when the row carries a select (1 child of one of the 5 select types).
 * Buttons and selects can never mix in the same row, so this answer also
 * tells callers what `addRowButton` etc. should refuse to do.
 */
export const isSelectRow = (row: ActionRowComponent): boolean =>
  row.components.length === 1 && isSelect(row.components[0]!);
