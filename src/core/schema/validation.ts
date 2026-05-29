/**
 * Schema validation.
 *
 * Validation runs in two situations:
 *  1. Live in the editor, to surface inline warnings without blocking edits.
 *     Users may temporarily have e.g. an empty TextDisplay while typing.
 *  2. Before export, to refuse payloads Discord would reject.
 *
 * Both call sites use `validateMessage`. The `severity` field on each issue
 * controls UI treatment — `error` blocks export, `warning` is informational.
 */

import {
  isActionRow,
  isButton,
  isChannelSelect,
  isContainer,
  isFile,
  isMediaGallery,
  isMentionableSelect,
  isRoleSelect,
  isSection,
  isSelect,
  isStringSelect,
  isTextDisplay,
  isThumbnail,
  isUserSelect,
} from "./guards";
import { LIMITS } from "./limits";
import { countCharacters, countComponents, walk } from "./traversal";
import {
  ButtonStyle,
  type AnyComponent,
  type ButtonComponent,
  type EditorId,
  type SelectComponent,
  type UnfurledMediaItem,
  type WebhookMessage,
} from "./types";
import { getAttachmentFile, parseSessionUrl } from "@/core/state/attachmentStore";

export type IssueSeverity = "error" | "warning";

export interface ValidationIssue {
  /** Editor id of the offending component, when applicable. */
  nodeId?: EditorId;
  severity: IssueSeverity;
  code: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

const SNOWFLAKE_RE = /^\d{15,25}$/;

export function validateMessage(message: WebhookMessage): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (message.components.length === 0) {
    issues.push({
      severity: "error",
      code: "EMPTY_MESSAGE",
      message: "A message must contain at least one component.",
    });
  }

  if (message.components.length > LIMITS.TOP_LEVEL_COMPONENTS) {
    issues.push({
      severity: "error",
      code: "TOP_LEVEL_LIMIT",
      message: `A message can have at most ${LIMITS.TOP_LEVEL_COMPONENTS} top-level components.`,
    });
  }

  const total = countComponents(message);
  if (total > LIMITS.TOTAL_COMPONENTS) {
    issues.push({
      severity: "error",
      code: "TOTAL_COMPONENT_LIMIT",
      message: `A message can have at most ${LIMITS.TOTAL_COMPONENTS} components in total (currently ${total}).`,
    });
  }

  const chars = countCharacters(message);
  if (chars > LIMITS.TOTAL_CHARACTERS) {
    issues.push({
      severity: "error",
      code: "TOTAL_CHARACTER_LIMIT",
      message: `Total text length is ${chars}, exceeding the ${LIMITS.TOTAL_CHARACTERS}-character cap.`,
    });
  }

  if (message.username && message.username.length > LIMITS.WEBHOOK_USERNAME) {
    issues.push({
      severity: "error",
      code: "USERNAME_TOO_LONG",
      message: `Webhook username must be ≤${LIMITS.WEBHOOK_USERNAME} characters.`,
    });
  }

  validateMessageLevel(message, issues);

  for (const top of message.components) validateNode(top, issues);

  validateUniqueIds(message, issues);

  return { ok: issues.every((i) => i.severity !== "error"), issues };
}

/**
 * Discord rejects a message when two components share the same numeric `id`
 * (Components V2), or when two interactive components (buttons / selects)
 * share the same `custom_id`. Flag every offending node so the UI can
 * highlight all of them, not just the second occurrence.
 */
function validateUniqueIds(message: WebhookMessage, issues: ValidationIssue[]): void {
  const byNumericId = new Map<number, EditorId[]>();
  const byCustomId = new Map<string, EditorId[]>();

  for (const node of walk(message)) {
    if (typeof node.id === "number" && Number.isInteger(node.id)) {
      const seen = byNumericId.get(node.id);
      if (seen) seen.push(node._id);
      else byNumericId.set(node.id, [node._id]);
    }
    if ((isButton(node) || isSelect(node)) && "custom_id" in node && node.custom_id) {
      const seen = byCustomId.get(node.custom_id);
      if (seen) seen.push(node._id);
      else byCustomId.set(node.custom_id, [node._id]);
    }
  }

  for (const [id, nodeIds] of byNumericId) {
    if (nodeIds.length < 2) continue;
    for (const nodeId of nodeIds) {
      issues.push({
        nodeId,
        severity: "error",
        code: "COMPONENT_ID_DUPLICATE",
        message: `Component id ${id} is used by ${nodeIds.length} components — each id must be unique within a message.`,
      });
    }
  }

  for (const [customId, nodeIds] of byCustomId) {
    if (nodeIds.length < 2) continue;
    for (const nodeId of nodeIds) {
      issues.push({
        nodeId,
        severity: "error",
        code: "CUSTOM_ID_DUPLICATE",
        message: `custom_id "${customId}" is used by ${nodeIds.length} components — each custom_id must be unique within a message.`,
      });
    }
  }
}

function validateMessageLevel(message: WebhookMessage, issues: ValidationIssue[]): void {
  const am = message.allowed_mentions;
  if (am) {
    if (am.parse?.includes("roles") && am.roles && am.roles.length > 0) {
      issues.push({
        severity: "error",
        code: "ALLOWED_MENTIONS_CONFLICT_ROLES",
        message:
          "allowed_mentions: don't combine parse: ['roles'] with an explicit roles list — pick one.",
      });
    }
    if (am.parse?.includes("users") && am.users && am.users.length > 0) {
      issues.push({
        severity: "error",
        code: "ALLOWED_MENTIONS_CONFLICT_USERS",
        message:
          "allowed_mentions: don't combine parse: ['users'] with an explicit users list — pick one.",
      });
    }
    for (const id of am.roles ?? []) {
      if (!SNOWFLAKE_RE.test(id)) {
        issues.push({
          severity: "error",
          code: "ALLOWED_MENTIONS_BAD_ROLE",
          message: `allowed_mentions.roles: "${id}" is not a valid snowflake.`,
        });
      }
    }
    for (const id of am.users ?? []) {
      if (!SNOWFLAKE_RE.test(id)) {
        issues.push({
          severity: "error",
          code: "ALLOWED_MENTIONS_BAD_USER",
          message: `allowed_mentions.users: "${id}" is not a valid snowflake.`,
        });
      }
    }
  }

  // message_reference is intentionally not validated here — the webhook
  // execute endpoint does not accept it, so the wire encoder strips it.
  // Preserving the field on the editor type is enough for round-trip safety.

  if (message.thread_name && message.thread_name.length > LIMITS.THREAD_NAME) {
    issues.push({
      severity: "error",
      code: "THREAD_NAME_LONG",
      message: `Forum thread name must be ≤${LIMITS.THREAD_NAME} characters.`,
    });
  }

  if (message.applied_tags) {
    if (message.applied_tags.length > LIMITS.APPLIED_TAGS) {
      issues.push({
        severity: "error",
        code: "APPLIED_TAGS_LIMIT",
        message: `Forum posts accept at most ${LIMITS.APPLIED_TAGS} applied tags.`,
      });
    }
    for (const id of message.applied_tags) {
      if (!SNOWFLAKE_RE.test(id)) {
        issues.push({
          severity: "error",
          code: "APPLIED_TAG_BAD",
          message: `applied_tags: "${id}" is not a valid snowflake.`,
        });
      }
    }
    if (message.applied_tags.length > 0 && !message.thread_name) {
      issues.push({
        severity: "warning",
        code: "APPLIED_TAGS_NO_THREAD",
        message:
          "applied_tags are only honoured when posting to a forum channel with a thread_name.",
      });
    }
  }

  if (message.avatar_url && message.avatar_url.length > LIMITS.WEBHOOK_AVATAR_URL) {
    issues.push({
      severity: "error",
      code: "AVATAR_URL_TOO_LONG",
      message: `Avatar URL must be ≤${LIMITS.WEBHOOK_AVATAR_URL} characters.`,
    });
  }
  if (message.avatar_url && !isValidUrl(message.avatar_url)) {
    issues.push({
      severity: "warning",
      code: "AVATAR_URL_INVALID",
      message: "Avatar URL doesn't look like a valid http(s) URL.",
    });
  }
}

function validateNode(node: AnyComponent, issues: ValidationIssue[]): void {
  if (node.id !== undefined && !Number.isInteger(node.id)) {
    issues.push({
      nodeId: node._id,
      severity: "error",
      code: "COMPONENT_ID_NOT_INTEGER",
      message: "Component `id` must be a 32-bit integer.",
    });
  }

  if (isContainer(node)) {
    if (node.components.length === 0) {
      issues.push({
        nodeId: node._id,
        severity: "error",
        code: "CONTAINER_EMPTY",
        message: "Container must contain at least one component.",
      });
    }
    if (node.components.length > LIMITS.CONTAINER_CHILDREN) {
      issues.push({
        nodeId: node._id,
        severity: "error",
        code: "CONTAINER_CHILDREN_LIMIT",
        message: `Container can hold at most ${LIMITS.CONTAINER_CHILDREN} children.`,
      });
    }
    if (
      node.accent_color !== undefined &&
      node.accent_color !== null &&
      (node.accent_color < 0 ||
        node.accent_color > LIMITS.COLOR_MAX ||
        !Number.isInteger(node.accent_color))
    ) {
      issues.push({
        nodeId: node._id,
        severity: "error",
        code: "CONTAINER_ACCENT_RANGE",
        message: `Container accent_color must be an integer in 0…${LIMITS.COLOR_MAX} (0xFFFFFF).`,
      });
    }
    for (const child of node.components) validateNode(child, issues);
    return;
  }

  if (isSection(node)) {
    const n = node.components.length;
    if (n < LIMITS.SECTION_TEXTS_MIN || n > LIMITS.SECTION_TEXTS_MAX) {
      issues.push({
        nodeId: node._id,
        severity: "error",
        code: "SECTION_TEXT_COUNT",
        message: `Section must contain ${LIMITS.SECTION_TEXTS_MIN}–${LIMITS.SECTION_TEXTS_MAX} text components.`,
      });
    }
    for (const t of node.components) validateNode(t, issues);
    validateNode(node.accessory, issues);
    return;
  }

  if (isMediaGallery(node)) {
    if (node.items.length === 0) {
      issues.push({
        nodeId: node._id,
        severity: "error",
        code: "GALLERY_EMPTY",
        message: "Media gallery must contain at least one item.",
      });
    }
    if (node.items.length > LIMITS.GALLERY_ITEMS) {
      issues.push({
        nodeId: node._id,
        severity: "error",
        code: "GALLERY_LIMIT",
        message: `Media gallery can hold at most ${LIMITS.GALLERY_ITEMS} items.`,
      });
    }
    for (const item of node.items) {
      validateMediaItem(item.media, node._id, issues, "Gallery item");
      if (item.description && item.description.length > LIMITS.MEDIA_DESCRIPTION) {
        issues.push({
          nodeId: node._id,
          severity: "error",
          code: "GALLERY_DESC_LONG",
          message: `Gallery item description must be ≤${LIMITS.MEDIA_DESCRIPTION} characters.`,
        });
      }
    }
    return;
  }

  if (isFile(node)) {
    validateMediaItem(node.file, node._id, issues, "File", { requireAttachment: true });
  }

  if (isThumbnail(node)) {
    validateMediaItem(node.media, node._id, issues, "Thumbnail");
    if (node.description && node.description.length > LIMITS.MEDIA_DESCRIPTION) {
      issues.push({
        nodeId: node._id,
        severity: "error",
        code: "THUMB_DESC_LONG",
        message: `Thumbnail description must be ≤${LIMITS.MEDIA_DESCRIPTION} characters.`,
      });
    }
  }

  if (isActionRow(node)) {
    if (node.components.length === 0) {
      issues.push({
        nodeId: node._id,
        severity: "error",
        code: "ROW_EMPTY",
        message: "Action row must contain at least one button or a select.",
      });
    }

    const firstChild = node.components[0];
    if (firstChild && isSelect(firstChild)) {
      if (node.components.length !== 1) {
        issues.push({
          nodeId: node._id,
          severity: "error",
          code: "ROW_SELECT_MIXED",
          message: "An action row with a select must contain exactly one component.",
        });
      }
      validateSelect(firstChild, issues);
    } else {
      if (node.components.length > LIMITS.ACTION_ROW_BUTTONS) {
        issues.push({
          nodeId: node._id,
          severity: "error",
          code: "ROW_LIMIT",
          message: `Action row can hold at most ${LIMITS.ACTION_ROW_BUTTONS} buttons.`,
        });
      }
      for (const child of node.components) {
        if (isSelect(child)) {
          issues.push({
            nodeId: node._id,
            severity: "error",
            code: "ROW_SELECT_MIXED",
            message: "Buttons and selects cannot share the same action row.",
          });
        } else {
          validateButton(child as ButtonComponent, issues);
        }
      }
    }
    return;
  }

  if (isTextDisplay(node)) {
    if (node.content.trim().length === 0) {
      issues.push({
        nodeId: node._id,
        severity: "warning",
        code: "TEXT_EMPTY",
        message: "Text display is empty.",
      });
    }
    if (node.content.length > LIMITS.TEXT_DISPLAY_CONTENT) {
      issues.push({
        nodeId: node._id,
        severity: "error",
        code: "TEXT_TOO_LONG",
        message: `Text content exceeds ${LIMITS.TEXT_DISPLAY_CONTENT} characters.`,
      });
    }
  }
}

function validateButton(btn: ButtonComponent, issues: ValidationIssue[]): void {
  if (btn.style === ButtonStyle.Link) {
    if (!isValidHttpsUrl(btn.url)) {
      issues.push({
        nodeId: btn._id,
        severity: "error",
        code: "BUTTON_URL_INVALID",
        message: "Link button needs a valid https:// URL.",
      });
    } else if (btn.url.length > LIMITS.BUTTON_URL) {
      issues.push({
        nodeId: btn._id,
        severity: "error",
        code: "BUTTON_URL_LONG",
        message: `Link button URL must be ≤${LIMITS.BUTTON_URL} characters.`,
      });
    }
  } else if (btn.style === ButtonStyle.Premium) {
    if (!btn.sku_id) {
      issues.push({
        nodeId: btn._id,
        severity: "error",
        code: "BUTTON_SKU_MISSING",
        message: "Premium button requires a SKU id.",
      });
    } else if (!SNOWFLAKE_RE.test(btn.sku_id)) {
      issues.push({
        nodeId: btn._id,
        severity: "error",
        code: "BUTTON_SKU_INVALID",
        message: "Premium button SKU id must be a Discord snowflake.",
      });
    }
  } else {
    if (!btn.custom_id) {
      issues.push({
        nodeId: btn._id,
        severity: "error",
        code: "BUTTON_CUSTOM_ID_MISSING",
        message: "Interactive button requires a custom_id (used by your bot).",
      });
    }
    if (btn.custom_id && btn.custom_id.length > LIMITS.BUTTON_CUSTOM_ID) {
      issues.push({
        nodeId: btn._id,
        severity: "error",
        code: "BUTTON_CUSTOM_ID_LONG",
        message: `custom_id must be ≤${LIMITS.BUTTON_CUSTOM_ID} characters.`,
      });
    }
  }

  const hasLabel = "label" in btn && btn.label && btn.label.length > 0;
  const hasEmoji = "emoji" in btn && btn.emoji && (btn.emoji.id || btn.emoji.name);
  if (btn.style !== ButtonStyle.Premium && !hasLabel && !hasEmoji) {
    issues.push({
      nodeId: btn._id,
      severity: "warning",
      code: "BUTTON_NO_LABEL",
      message: "Button has neither a label nor an emoji.",
    });
  }
  if ("label" in btn && btn.label && btn.label.length > LIMITS.BUTTON_LABEL) {
    issues.push({
      nodeId: btn._id,
      severity: "error",
      code: "BUTTON_LABEL_LONG",
      message: `Button label must be ≤${LIMITS.BUTTON_LABEL} characters.`,
    });
  }

  // Custom emoji needs both `id` and a non-empty `name` (the alias). Unicode
  // emoji needs only `name` — Discord rejects an `id` without a `name`.
  if ("emoji" in btn && btn.emoji?.id && !btn.emoji.name) {
    issues.push({
      nodeId: btn._id,
      severity: "error",
      code: "EMOJI_NAME_MISSING",
      message: "Custom emoji needs an alias name alongside its id.",
    });
  }
}

function validateSelect(sel: SelectComponent, issues: ValidationIssue[]): void {
  if (!sel.custom_id) {
    issues.push({
      nodeId: sel._id,
      severity: "error",
      code: "SELECT_CUSTOM_ID_MISSING",
      message: "Select requires a custom_id (used by your bot).",
    });
  } else if (sel.custom_id.length > LIMITS.SELECT_CUSTOM_ID) {
    issues.push({
      nodeId: sel._id,
      severity: "error",
      code: "SELECT_CUSTOM_ID_LONG",
      message: `Select custom_id must be ≤${LIMITS.SELECT_CUSTOM_ID} characters.`,
    });
  }
  if (sel.placeholder && sel.placeholder.length > LIMITS.SELECT_PLACEHOLDER) {
    issues.push({
      nodeId: sel._id,
      severity: "error",
      code: "SELECT_PLACEHOLDER_LONG",
      message: `Select placeholder must be ≤${LIMITS.SELECT_PLACEHOLDER} characters.`,
    });
  }

  const min = sel.min_values ?? 1;
  const max = sel.max_values ?? 1;
  if (min < LIMITS.SELECT_MIN_VALUES || min > LIMITS.SELECT_MAX_VALUES) {
    issues.push({
      nodeId: sel._id,
      severity: "error",
      code: "SELECT_MIN_RANGE",
      message: `min_values must be ${LIMITS.SELECT_MIN_VALUES}–${LIMITS.SELECT_MAX_VALUES}.`,
    });
  }
  if (max < 1 || max > LIMITS.SELECT_MAX_VALUES) {
    issues.push({
      nodeId: sel._id,
      severity: "error",
      code: "SELECT_MAX_RANGE",
      message: `max_values must be 1–${LIMITS.SELECT_MAX_VALUES}.`,
    });
  }
  if (min > max) {
    issues.push({
      nodeId: sel._id,
      severity: "error",
      code: "SELECT_MIN_GT_MAX",
      message: "min_values cannot exceed max_values.",
    });
  }

  if (isStringSelect(sel)) {
    if (sel.options.length === 0) {
      issues.push({
        nodeId: sel._id,
        severity: "error",
        code: "SELECT_NO_OPTIONS",
        message: "String select needs at least one option.",
      });
    }
    if (sel.options.length > LIMITS.SELECT_OPTIONS) {
      issues.push({
        nodeId: sel._id,
        severity: "error",
        code: "SELECT_OPTIONS_LIMIT",
        message: `String select can hold at most ${LIMITS.SELECT_OPTIONS} options.`,
      });
    }
    const seenValues = new Set<string>();
    let defaults = 0;
    for (const [i, opt] of sel.options.entries()) {
      const where = `Option ${i + 1}`;
      if (!opt.label) {
        issues.push({
          nodeId: sel._id,
          severity: "error",
          code: "OPTION_LABEL_MISSING",
          message: `${where}: label is required.`,
        });
      } else if (opt.label.length > LIMITS.SELECT_OPTION_LABEL) {
        issues.push({
          nodeId: sel._id,
          severity: "error",
          code: "OPTION_LABEL_LONG",
          message: `${where}: label must be ≤${LIMITS.SELECT_OPTION_LABEL} chars.`,
        });
      }
      if (!opt.value) {
        issues.push({
          nodeId: sel._id,
          severity: "error",
          code: "OPTION_VALUE_MISSING",
          message: `${where}: value is required.`,
        });
      } else {
        if (opt.value.length > LIMITS.SELECT_OPTION_VALUE) {
          issues.push({
            nodeId: sel._id,
            severity: "error",
            code: "OPTION_VALUE_LONG",
            message: `${where}: value must be ≤${LIMITS.SELECT_OPTION_VALUE} chars.`,
          });
        }
        if (seenValues.has(opt.value)) {
          issues.push({
            nodeId: sel._id,
            severity: "error",
            code: "OPTION_VALUE_DUP",
            message: `${where}: value "${opt.value}" is duplicated.`,
          });
        } else {
          seenValues.add(opt.value);
        }
      }
      if (opt.description && opt.description.length > LIMITS.SELECT_OPTION_DESCRIPTION) {
        issues.push({
          nodeId: sel._id,
          severity: "error",
          code: "OPTION_DESC_LONG",
          message: `${where}: description must be ≤${LIMITS.SELECT_OPTION_DESCRIPTION} chars.`,
        });
      }
      if (opt.emoji?.id && !opt.emoji.name) {
        issues.push({
          nodeId: sel._id,
          severity: "error",
          code: "OPTION_EMOJI_NAME",
          message: `${where}: custom emoji needs an alias name alongside its id.`,
        });
      }
      if (opt.default) defaults++;
    }
    if (defaults > max) {
      issues.push({
        nodeId: sel._id,
        severity: "error",
        code: "OPTION_DEFAULT_OVER_MAX",
        message: "More options marked default than max_values allows.",
      });
    }
  } else if (
    isUserSelect(sel) ||
    isRoleSelect(sel) ||
    isMentionableSelect(sel) ||
    isChannelSelect(sel)
  ) {
    const dvs = sel.default_values ?? [];
    if (dvs.length > LIMITS.SELECT_DEFAULT_VALUES) {
      issues.push({
        nodeId: sel._id,
        severity: "error",
        code: "SELECT_DEFAULTS_LIMIT",
        message: `default_values can have at most ${LIMITS.SELECT_DEFAULT_VALUES} entries.`,
      });
    }
    if (dvs.length > max) {
      issues.push({
        nodeId: sel._id,
        severity: "error",
        code: "SELECT_DEFAULTS_OVER_MAX",
        message: "default_values has more entries than max_values allows.",
      });
    }
    for (const dv of dvs) {
      if (!SNOWFLAKE_RE.test(dv.id)) {
        issues.push({
          nodeId: sel._id,
          severity: "error",
          code: "SELECT_DEFAULT_BAD_ID",
          message: `default_values: "${dv.id}" is not a valid snowflake.`,
        });
      }
    }
  }
}

function validateMediaItem(
  media: UnfurledMediaItem,
  nodeId: EditorId,
  issues: ValidationIssue[],
  context: string,
  opts: { requireAttachment?: boolean } = {},
): void {
  const hasUrl = typeof media.url === "string" && media.url.length > 0;
  const hasAttachmentId = typeof media.attachment_id === "string" && media.attachment_id.length > 0;

  if (!hasUrl && !hasAttachmentId) {
    issues.push({
      nodeId,
      severity: "error",
      code: "MEDIA_REQUIRED",
      message: `${context} needs a URL or an attachment_id.`,
    });
    return;
  }
  if (hasAttachmentId && !SNOWFLAKE_RE.test(media.attachment_id!)) {
    issues.push({
      nodeId,
      severity: "error",
      code: "MEDIA_ATTACHMENT_ID_BAD",
      message: `${context}: attachment_id must be a Discord snowflake.`,
    });
  }
  if (hasUrl) {
    if (!isValidMediaUrl(media.url!)) {
      issues.push({
        nodeId,
        severity: "warning",
        code: "MEDIA_URL_INVALID",
        message: `${context}: URL must be https://, attachment://filename, or an in-session upload.`,
      });
    } else if (
      opts.requireAttachment &&
      isExternalWebUrl(media.url!) &&
      !isDiscordCdnUrl(media.url!)
    ) {
      // The File component's media only renders uploaded attachments — Discord
      // rejects an external URL here (unlike Thumbnail / Media Gallery).
      issues.push({
        nodeId,
        severity: "error",
        code: "FILE_URL_NOT_ATTACHMENT",
        message: `${context} can only display an uploaded attachment — upload a file or use an attachment://filename reference, not an external URL.`,
      });
    }
    checkAttachmentResolves(media.url!, nodeId, issues);
  }
}

function isValidHttpsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function isValidMediaUrl(url: string): boolean {
  if (url.startsWith("attachment://")) return url.length > "attachment://".length;
  if (url.startsWith("session://")) return parseSessionUrl(url) !== null;
  return isValidUrl(url);
}

/** A plain external web URL — not an `attachment://` or in-session `session://` ref. */
function isExternalWebUrl(url: string): boolean {
  if (url.startsWith("attachment://") || url.startsWith("session://")) return false;
  return isValidUrl(url);
}

/**
 * Discord's own CDN hosts. A File component restored from a Discord message
 * response can carry a CDN url in `url`, so we don't flag those — that keeps a
 * restore → edit → resend round-trip from being blocked. Freshly-pasted
 * external URLs are still rejected, since the File component won't render them.
 */
function isDiscordCdnUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "cdn.discordapp.com" || host === "media.discordapp.net";
  } catch {
    return false;
  }
}

/**
 * If `url` is a session blob ref, flag the component when the blob is no
 * longer in memory (page reload, manual eviction). Errors block send so the
 * user knows to re-attach the file before posting.
 */
function checkAttachmentResolves(url: string, nodeId: EditorId, issues: ValidationIssue[]): void {
  const parsed = parseSessionUrl(url);
  if (!parsed) return;
  if (getAttachmentFile(parsed.blobId)) return;
  issues.push({
    nodeId,
    severity: "error",
    code: "ATTACHMENT_MISSING",
    message:
      "Uploaded file is no longer in this browser session — re-attach the file before sending.",
  });
}
