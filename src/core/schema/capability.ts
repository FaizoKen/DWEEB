/**
 * Capability inspector.
 *
 * Components V2 has features that look legal in JSON but only actually do
 * something in specific contexts — and webhook execute is one of the more
 * restrictive contexts. This module produces a list of "what this message
 * needs in order to work as built" so the editor can surface preconditions
 * before the user hits Send.
 *
 * Categories:
 *  - `app_webhook`     — interactive components (buttons with `custom_id`,
 *                        selects, Premium buttons) only fire when the
 *                        webhook is owned by an application/bot. Regular
 *                        user-created webhooks render them but interactions
 *                        go nowhere.
 *  - `forum_channel`   — `thread_name` and `applied_tags` only apply when
 *                        the webhook posts into a forum/media channel.
 *                        Ignored elsewhere.
 *  - `existing_thread` — `thread_id` query param posts into a specific
 *                        thread; informational only.
 *  - `monetization`    — Premium buttons need an attached application with
 *                        a configured SKU.
 *  - `tts_noop`        — Discord's TTS reads `content`; V2 messages forbid
 *                        `content`, so the `tts` flag has no audible effect.
 *  - `conflict`        — fields that contradict each other (e.g. both
 *                        `thread_id` and `thread_name` set).
 *
 * The inspector intentionally does NOT block sending — it informs. The user
 * may know their webhook is app-owned, or that they'll create the thread
 * later. Send-time validation lives in `validation.ts`.
 */

import { isActionRow, isButton, isContainer, isSection, isSelect } from "./guards";
import { ButtonStyle, type AnyComponent, type EditorId, type WebhookMessage } from "./types";

export type CapabilityKind =
  | "app_webhook"
  | "forum_channel"
  | "existing_thread"
  | "monetization"
  | "tts_noop"
  | "conflict";

export interface CapabilityNote {
  kind: CapabilityKind;
  severity: "info" | "warning";
  title: string;
  detail: string;
  /** Editor ids of components contributing to this requirement, when relevant. */
  nodes?: EditorId[];
}

export interface CapabilityContext {
  /** Whether the Send panel currently has a thread_id filled in. */
  threadIdProvided?: boolean;
}

export function inspectCapabilities(
  message: WebhookMessage,
  ctx: CapabilityContext = {},
): CapabilityNote[] {
  const notes: CapabilityNote[] = [];

  const interactive: EditorId[] = [];
  const premium: EditorId[] = [];
  for (const node of walkAll(message)) {
    if (isSelect(node)) {
      interactive.push(node._id);
      continue;
    }
    if (isButton(node)) {
      if (node.style === ButtonStyle.Premium) premium.push(node._id);
      else if (node.style !== ButtonStyle.Link) interactive.push(node._id);
    }
  }

  if (interactive.length > 0) {
    notes.push({
      kind: "app_webhook",
      severity: "warning",
      title: `Needs an app-owned webhook (${interactive.length} interactive component${interactive.length === 1 ? "" : "s"})`,
      detail:
        "Buttons and menus only work from a webhook owned by a bot or app. A regular webhook can't post them.",
      nodes: interactive,
    });
  }

  if (premium.length > 0) {
    notes.push({
      kind: "monetization",
      severity: "warning",
      title: `Needs app monetization (${premium.length} Premium button${premium.length === 1 ? "" : "s"})`,
      detail:
        "Premium buttons only work if the owning app has a product set up. Otherwise the button won't.",
      nodes: premium,
    });
  }

  if (message.thread_name || (message.applied_tags && message.applied_tags.length > 0)) {
    const parts: string[] = [];
    if (message.thread_name) parts.push("thread name");
    if (message.applied_tags && message.applied_tags.length > 0) parts.push("applied tags");
    notes.push({
      kind: "forum_channel",
      severity: "warning",
      title: "Needs a forum or media channel",
      detail: `Your ${parts.join(" and ")} only take${parts.length > 1 ? "" : "s"} effect in a forum or media channel — Discord ignores ${parts.length > 1 ? "them" : "it"} on text channels.`,
    });
  }

  if (message.thread_name && ctx.threadIdProvided) {
    notes.push({
      kind: "conflict",
      severity: "warning",
      title: "Two thread settings clash",
      detail:
        "You set both a thread to post in and a new thread name. Discord uses the thread you picked and ignores the name — pick one.",
    });
  } else if (ctx.threadIdProvided) {
    notes.push({
      kind: "existing_thread",
      severity: "info",
      title: "Posts into an existing thread",
      detail: "A thread is set, so this posts there instead of the webhook's main channel.",
    });
  }

  if (message.tts) {
    notes.push({
      kind: "tts_noop",
      severity: "warning",
      title: "Text-to-speech won't play",
      detail:
        "Text-to-speech reads plain text, which this message type doesn't use. The setting is ignored.",
    });
  }

  return notes;
}

/** Yields every node (top-level + nested) for the capability walker. */
function* walkAll(message: WebhookMessage): Generator<AnyComponent> {
  for (const top of message.components) yield* deep(top);
}

function* deep(node: AnyComponent): Generator<AnyComponent> {
  yield node;
  if (isContainer(node)) {
    for (const child of node.components) yield* deep(child);
  } else if (isSection(node)) {
    for (const t of node.components) yield t;
    yield node.accessory;
  } else if (isActionRow(node)) {
    for (const child of node.components) yield child;
  }
}
