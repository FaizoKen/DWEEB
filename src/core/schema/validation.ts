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
  isContainer,
  isMediaGallery,
  isSection,
  isTextDisplay,
} from "./guards";
import { LIMITS } from "./limits";
import { countCharacters, countComponents } from "./traversal";
import {
  ButtonStyle,
  type AnyComponent,
  type ButtonComponent,
  type EditorId,
  type WebhookMessage,
} from "./types";

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

  for (const top of message.components) validateNode(top, issues);

  return { ok: issues.every((i) => i.severity !== "error"), issues };
}

function validateNode(node: AnyComponent, issues: ValidationIssue[]): void {
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
      if (!isValidMediaUrl(item.media.url)) {
        issues.push({
          nodeId: node._id,
          severity: "warning",
          code: "GALLERY_ITEM_URL",
          message: "Each gallery item needs a valid https:// or attachment:// URL.",
        });
      }
    }
    return;
  }

  if (isActionRow(node)) {
    if (node.components.length === 0) {
      issues.push({
        nodeId: node._id,
        severity: "error",
        code: "ROW_EMPTY",
        message: "Action row must contain at least one button.",
      });
    }
    if (node.components.length > LIMITS.ACTION_ROW_BUTTONS) {
      issues.push({
        nodeId: node._id,
        severity: "error",
        code: "ROW_LIMIT",
        message: `Action row can hold at most ${LIMITS.ACTION_ROW_BUTTONS} buttons.`,
      });
    }
    for (const btn of node.components) validateButton(btn, issues);
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
    if (!isValidUrl(btn.url)) {
      issues.push({
        nodeId: btn._id,
        severity: "error",
        code: "BUTTON_URL_INVALID",
        message: "Link button needs a valid https:// URL.",
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
  return isValidUrl(url);
}
