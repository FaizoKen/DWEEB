/**
 * Discord Components V2 schema.
 *
 * Types here mirror the wire format Discord expects when posting to a webhook
 * with the `IS_COMPONENTS_V2` message flag (1 << 15) set. They are intentionally
 * close to the official API shape so that `serialization/encode.ts` can emit a
 * payload Discord accepts with minimal transformation.
 *
 * Editor-only fields (an `id` we generate for selection/diffing) are stripped
 * before export — see `serialization/toWirePayload.ts`.
 *
 * Reference: https://discord.com/developers/docs/components/reference
 */

/** Discord component type discriminator. */
export const ComponentType = {
  ActionRow: 1,
  Button: 2,
  StringSelect: 3,
  TextInput: 4,
  UserSelect: 5,
  RoleSelect: 6,
  MentionableSelect: 7,
  ChannelSelect: 8,
  Section: 9,
  TextDisplay: 10,
  Thumbnail: 11,
  MediaGallery: 12,
  File: 13,
  Separator: 14,
  Container: 17,
} as const;

export type ComponentTypeValue = (typeof ComponentType)[keyof typeof ComponentType];

/** Discord button style discriminator. */
export const ButtonStyle = {
  Primary: 1,
  Secondary: 2,
  Success: 3,
  Danger: 4,
  Link: 5,
  Premium: 6,
} as const;

export type ButtonStyleValue = (typeof ButtonStyle)[keyof typeof ButtonStyle];

/** Separator vertical spacing. */
export const SeparatorSpacing = {
  Small: 1,
  Large: 2,
} as const;

export type SeparatorSpacingValue = (typeof SeparatorSpacing)[keyof typeof SeparatorSpacing];

/**
 * Editor-only identifier attached to every component so the builder can track
 * selection and reorder without relying on array indices. Stripped at export.
 */
export type EditorId = string;

/** Common fields present on every editor component. */
export interface BaseComponent {
  /** Editor-only stable id. Not sent to Discord. */
  _id: EditorId;
  type: ComponentTypeValue;
}

/** Partial emoji used on buttons / select options. */
export interface PartialEmoji {
  id?: string | null;
  name?: string | null;
  animated?: boolean;
}

/** Unfurled media item used by thumbnails, galleries, and files. */
export interface UnfurledMediaItem {
  /** Either an https:// URL or an `attachment://<filename>` reference. */
  url: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Leaf components
// ────────────────────────────────────────────────────────────────────────────

export interface TextDisplayComponent extends BaseComponent {
  type: typeof ComponentType.TextDisplay;
  content: string;
}

export interface ThumbnailComponent extends BaseComponent {
  type: typeof ComponentType.Thumbnail;
  media: UnfurledMediaItem;
  description?: string;
  spoiler?: boolean;
}

export interface MediaGalleryItem {
  media: UnfurledMediaItem;
  description?: string;
  spoiler?: boolean;
}

export interface MediaGalleryComponent extends BaseComponent {
  type: typeof ComponentType.MediaGallery;
  items: MediaGalleryItem[];
}

export interface FileComponent extends BaseComponent {
  type: typeof ComponentType.File;
  file: UnfurledMediaItem;
  spoiler?: boolean;
}

export interface SeparatorComponent extends BaseComponent {
  type: typeof ComponentType.Separator;
  divider?: boolean;
  spacing?: SeparatorSpacingValue;
}

/**
 * Buttons split into two structural variants:
 *  - URL/Premium buttons carry a target (`url` or `sku_id`) and never a custom_id.
 *  - Interactive buttons carry a `custom_id` and a non-link style.
 *
 * Webhook messages can include interactive buttons, but interactions cannot be
 * handled without a backend. We still allow editing them so users can ship
 * messages a separate bot will receive.
 */
export interface LinkButtonComponent extends BaseComponent {
  type: typeof ComponentType.Button;
  style: typeof ButtonStyle.Link;
  label?: string;
  emoji?: PartialEmoji;
  url: string;
  disabled?: boolean;
}

export interface PremiumButtonComponent extends BaseComponent {
  type: typeof ComponentType.Button;
  style: typeof ButtonStyle.Premium;
  sku_id: string;
  disabled?: boolean;
}

export interface InteractiveButtonComponent extends BaseComponent {
  type: typeof ComponentType.Button;
  style:
    | typeof ButtonStyle.Primary
    | typeof ButtonStyle.Secondary
    | typeof ButtonStyle.Success
    | typeof ButtonStyle.Danger;
  label?: string;
  emoji?: PartialEmoji;
  custom_id: string;
  disabled?: boolean;
}

export type ButtonComponent =
  | LinkButtonComponent
  | PremiumButtonComponent
  | InteractiveButtonComponent;

// ────────────────────────────────────────────────────────────────────────────
// Layout components
// ────────────────────────────────────────────────────────────────────────────

/** A Section accessory is either a single Button or a Thumbnail. */
export type SectionAccessory = ButtonComponent | ThumbnailComponent;

export interface SectionComponent extends BaseComponent {
  type: typeof ComponentType.Section;
  /** 1–3 TextDisplay children. */
  components: TextDisplayComponent[];
  accessory: SectionAccessory;
}

/** Action rows in V2 only hold buttons (selects require interactions). */
export interface ActionRowComponent extends BaseComponent {
  type: typeof ComponentType.ActionRow;
  components: ButtonComponent[];
}

/**
 * Top-level container. Renders with a left accent stripe in Discord, similar
 * to the legacy embed look. Cannot nest another Container.
 */
export interface ContainerComponent extends BaseComponent {
  type: typeof ComponentType.Container;
  /**
   * RGB integer (0xRRGGBB) or null. Discord renders no accent stripe when null.
   * We keep `undefined` and `null` distinct so the wire payload only emits the
   * field when the user explicitly chose a color.
   */
  accent_color?: number | null;
  spoiler?: boolean;
  components: ContainerChild[];
}

/** Components allowed inside a Container (no nested Container). */
export type ContainerChild =
  | ActionRowComponent
  | TextDisplayComponent
  | SectionComponent
  | MediaGalleryComponent
  | SeparatorComponent
  | FileComponent;

/** Top-level components allowed on a Components V2 message. */
export type TopLevelComponent =
  | ActionRowComponent
  | SectionComponent
  | TextDisplayComponent
  | MediaGalleryComponent
  | SeparatorComponent
  | FileComponent
  | ContainerComponent;

/** Any component (used for tree traversal). */
export type AnyComponent =
  | TopLevelComponent
  | ContainerChild
  | ButtonComponent
  | ThumbnailComponent
  | SectionAccessory;

// ────────────────────────────────────────────────────────────────────────────
// Message
// ────────────────────────────────────────────────────────────────────────────

/**
 * Message-level metadata. With Components V2, `content` and `embeds` are
 * forbidden — only `components` ship to Discord. Webhook execution params
 * (username, avatar_url) live alongside for the executor to consume.
 */
export interface WebhookMessage {
  /** Override webhook display name. */
  username?: string;
  /** Override webhook avatar URL. */
  avatar_url?: string;
  /** Whether to read message content with TTS. */
  tts?: boolean;
  /** Top-level component list. Order matters — this is the render order. */
  components: TopLevelComponent[];
}

/**
 * Message flag that tells Discord this message uses the Components V2 layout
 * system. Must be set when posting; the editor always emits it.
 */
export const MESSAGE_FLAG_IS_COMPONENTS_V2 = 1 << 15;
