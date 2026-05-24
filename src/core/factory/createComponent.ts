/**
 * Factories for building empty components with sensible defaults.
 *
 * The factory is the single place new components come from — both the "add
 * component" menu and the importer (when filling in missing fields) go
 * through here. That guarantees every component leaves with an `_id` set
 * and the shape expected by the renderers.
 */

import { newId } from "@/lib/id";
import {
  ButtonStyle,
  ComponentType,
  SeparatorSpacing,
  type ActionRowComponent,
  type ContainerComponent,
  type FileComponent,
  type LinkButtonComponent,
  type MediaGalleryComponent,
  type SectionComponent,
  type SeparatorComponent,
  type TextDisplayComponent,
  type ThumbnailComponent,
  type TopLevelComponent,
} from "../schema/types";

export function createTextDisplay(content = "New text component"): TextDisplayComponent {
  return { _id: newId(), type: ComponentType.TextDisplay, content };
}

export function createSeparator(): SeparatorComponent {
  return {
    _id: newId(),
    type: ComponentType.Separator,
    divider: true,
    spacing: SeparatorSpacing.Small,
  };
}

export function createLinkButton(): LinkButtonComponent {
  return {
    _id: newId(),
    type: ComponentType.Button,
    style: ButtonStyle.Link,
    label: "Open link",
    url: "https://discord.com",
  };
}

export function createThumbnail(): ThumbnailComponent {
  return {
    _id: newId(),
    type: ComponentType.Thumbnail,
    media: { url: "https://placehold.co/256x256/5865F2/ffffff/png?text=Thumb" },
  };
}

export function createSection(): SectionComponent {
  return {
    _id: newId(),
    type: ComponentType.Section,
    components: [createTextDisplay("Section heading")],
    accessory: createThumbnail(),
  };
}

export function createMediaGallery(): MediaGalleryComponent {
  return {
    _id: newId(),
    type: ComponentType.MediaGallery,
    items: [
      { media: { url: "https://placehold.co/600x400/5865F2/ffffff/png?text=Image+1" } },
    ],
  };
}

export function createFile(): FileComponent {
  return {
    _id: newId(),
    type: ComponentType.File,
    file: { url: "attachment://file.txt" },
  };
}

export function createActionRow(): ActionRowComponent {
  return {
    _id: newId(),
    type: ComponentType.ActionRow,
    components: [createLinkButton()],
  };
}

export function createContainer(): ContainerComponent {
  return {
    _id: newId(),
    type: ComponentType.Container,
    accent_color: 0x5865f2,
    components: [createTextDisplay("Container body")],
  };
}

/** Map of factories used by the "add component" menu. */
export const COMPONENT_FACTORIES = {
  [ComponentType.Container]: createContainer,
  [ComponentType.Section]: createSection,
  [ComponentType.TextDisplay]: createTextDisplay,
  [ComponentType.MediaGallery]: createMediaGallery,
  [ComponentType.Separator]: createSeparator,
  [ComponentType.File]: createFile,
  [ComponentType.ActionRow]: createActionRow,
} as const;

export type TopLevelFactoryKey = keyof typeof COMPONENT_FACTORIES;
/** Component types allowed inside a Container — Container itself excluded (no nesting). */
export type ContainerChildFactoryKey = Exclude<TopLevelFactoryKey, typeof ComponentType.Container>;

export function createTopLevel(type: TopLevelFactoryKey): TopLevelComponent {
  return COMPONENT_FACTORIES[type]() as TopLevelComponent;
}
