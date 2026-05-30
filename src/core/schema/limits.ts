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

  /**
   * Max children inside a Container. Discord enforces no independent
   * per-container cap — the binding constraint is the 40-total rule below.
   * A Container can't be nested and counts as 1 component itself, so its
   * true ceiling is TOTAL_COMPONENTS − 1 = 39 (verified against the live API:
   * 39 children accepted, 40 rejected with "Total number of components cannot
   * exceed 40"). The TOTAL_COMPONENTS check still catches cases where other
   * top-level components leave fewer than 39 slots.
   */
  CONTAINER_CHILDREN: 39,

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

  /** Select-component caps. */
  SELECT_CUSTOM_ID: 100,
  SELECT_PLACEHOLDER: 150,
  SELECT_OPTIONS: 25,
  SELECT_MIN_VALUES: 0,
  SELECT_MAX_VALUES: 25,
  SELECT_OPTION_LABEL: 100,
  SELECT_OPTION_VALUE: 100,
  SELECT_OPTION_DESCRIPTION: 100,
  SELECT_DEFAULT_VALUES: 25,

  /** Webhook execution overrides. */
  WEBHOOK_USERNAME: 80,
  WEBHOOK_AVATAR_URL: 2048,
  THREAD_NAME: 100,
  APPLIED_TAGS: 5,

  /** Max length of any Discord snowflake (used for input clamping). */
  SNOWFLAKE_MAX: 25,

  /** RGB integer maximum (0xFFFFFF). */
  COLOR_MAX: 0xffffff,
} as const;
