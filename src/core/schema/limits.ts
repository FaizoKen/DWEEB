/**
 * Discord-enforced limits for Components V2 messages.
 *
 * These are the ceilings the editor uses to warn or block invalid edits.
 * Numbers come from the official Discord API reference and may shift over
 * time — when Discord updates a limit, change it here, not in feature code.
 */

export const LIMITS = {
  /** Max total components in a message (including nested). */
  TOTAL_COMPONENTS: 40,

  /** Max top-level components on a Components V2 message. */
  TOP_LEVEL_COMPONENTS: 10,

  /** Combined character cap across every text-bearing field in the message. */
  TOTAL_CHARACTERS: 4000,

  /** Max children inside a Container. */
  CONTAINER_CHILDREN: 10,

  /** Min/Max TextDisplay children in a Section. */
  SECTION_TEXTS_MIN: 1,
  SECTION_TEXTS_MAX: 3,

  /** Max items in a MediaGallery. */
  GALLERY_ITEMS: 10,

  /** Max buttons in an ActionRow. */
  ACTION_ROW_BUTTONS: 5,

  /** Per-field character maxima. */
  TEXT_DISPLAY_CONTENT: 4000,
  BUTTON_LABEL: 80,
  BUTTON_CUSTOM_ID: 100,
  BUTTON_URL: 512,
  MEDIA_DESCRIPTION: 1024,

  /** Webhook execution overrides. */
  WEBHOOK_USERNAME: 80,
  WEBHOOK_AVATAR_URL: 2048,
} as const;
