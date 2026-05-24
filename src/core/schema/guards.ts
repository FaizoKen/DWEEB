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
  type ContainerComponent,
  type FileComponent,
  type MediaGalleryComponent,
  type SectionComponent,
  type SeparatorComponent,
  type TextDisplayComponent,
  type ThumbnailComponent,
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

export const isButton = (c: AnyComponent): c is ButtonComponent =>
  c.type === ComponentType.Button;
