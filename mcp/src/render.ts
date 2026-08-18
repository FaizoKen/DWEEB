/**
 * Text rendering of a Components V2 message.
 *
 * A model building a Discord message is working blind: it emits JSON and has
 * no way to see what lands in the channel. The JSON itself is a poor substitute
 * — nesting, ordering, and the button/select split are exactly the things it
 * gets wrong, and those are precisely what a flat object literal hides.
 *
 * So `renderOutline` re-states the payload as the structure a reader sees:
 * one line per component, indented by nesting, with the text content, the
 * media, and each button's target inline. It is deliberately not a pixel
 * preview (that is the web app's job, and `create_share_link` is how a human
 * gets to it) — it is the layout, in the order Discord will draw it.
 */

import {
  isActionRow,
  isButton,
  isChannelSelect,
  isContainer,
  isFile,
  isMediaGallery,
  isSection,
  isSelect,
  isSeparator,
  isStringSelect,
  isTextDisplay,
  isThumbnail,
} from "@/core/schema/guards";
import { COMPONENT_META } from "@/core/schema/metadata";
import {
  ButtonStyle,
  ComponentType,
  SeparatorSpacing,
  type AnyComponent,
  type ButtonComponent,
  type PartialEmoji,
  type SelectComponent,
  type UnfurledMediaItem,
  type WebhookMessage,
} from "@/core/schema/types";
import { messageStats } from "./message";

/** Longest run of message text reproduced verbatim before it is elided. A
 *  single Text Display may legally hold the whole 4000-character budget; the
 *  outline exists to show shape, and the caller already has the exact text. */
const MAX_TEXT = 600;

const BUTTON_STYLE_NAMES: Record<number, string> = {
  [ButtonStyle.Primary]: "blurple",
  [ButtonStyle.Secondary]: "grey",
  [ButtonStyle.Success]: "green",
  [ButtonStyle.Danger]: "red",
  [ButtonStyle.Link]: "link",
  [ButtonStyle.Premium]: "premium",
};

const SELECT_KINDS: Record<number, string> = {
  [ComponentType.StringSelect]: "options",
  [ComponentType.UserSelect]: "users",
  [ComponentType.RoleSelect]: "roles",
  [ComponentType.MentionableSelect]: "users or roles",
  [ComponentType.ChannelSelect]: "channels",
};

function glyph(node: AnyComponent): string {
  return COMPONENT_META[node.type]?.glyph ?? "•";
}

function label(node: AnyComponent): string {
  return COMPONENT_META[node.type]?.label ?? `Type ${node.type}`;
}

function quote(text: string): string {
  return JSON.stringify(text);
}

function emojiOf(emoji: PartialEmoji | undefined): string {
  if (!emoji) return "";
  if (emoji.name && !emoji.id) return `${emoji.name} `;
  if (emoji.name) return `:${emoji.name}: `;
  return "";
}

function hex(color: number | null | undefined): string {
  if (color == null) return "no accent";
  return `accent #${color.toString(16).padStart(6, "0").toUpperCase()}`;
}

function mediaOf(item: UnfurledMediaItem | undefined): string {
  if (!item) return "(no media)";
  if (item.url) return item.url;
  if (item.attachment_id) return `attachment id ${item.attachment_id}`;
  return "(no URL)";
}

/** Reproduce message text, elided past {@link MAX_TEXT} and with newlines kept
 *  as real line breaks so the outline reads the way the message does. */
function textBlock(content: string, indent: string): string[] {
  const clipped =
    content.length > MAX_TEXT
      ? `${content.slice(0, MAX_TEXT)}… (+${content.length - MAX_TEXT} more characters)`
      : content;
  const lines = clipped.split("\n");
  return lines.length === 1 && lines[0] === ""
    ? [`${indent}(empty)`]
    : lines.map((line) => `${indent}${line}`);
}

function describeButton(button: ButtonComponent): string {
  const style = BUTTON_STYLE_NAMES[button.style] ?? `style ${button.style}`;
  const parts: string[] = [];
  if (button.style === ButtonStyle.Premium) {
    parts.push(`SKU ${button.sku_id || "(none)"}`);
  } else {
    const text = `${emojiOf(button.emoji)}${button.label ?? ""}`.trim();
    parts.push(`[${text || "(no label)"}]`);
    parts.push(style);
    if (button.style === ButtonStyle.Link) parts.push(`→ ${button.url || "(no URL)"}`);
    else parts.push(`custom_id ${quote(button.custom_id ?? "")}`);
  }
  if (button.disabled) parts.push("disabled");
  return parts.join(" · ");
}

function describeSelect(select: SelectComponent): string {
  const kind = SELECT_KINDS[select.type] ?? "values";
  const parts = [`picks ${kind}`, `custom_id ${quote(select.custom_id ?? "")}`];
  if (select.placeholder) parts.push(`placeholder ${quote(select.placeholder)}`);
  const min = select.min_values;
  const max = select.max_values;
  if (min !== undefined || max !== undefined) parts.push(`choose ${min ?? 1}–${max ?? 1}`);
  if (select.disabled) parts.push("disabled");
  if (isChannelSelect(select) && select.channel_types?.length) {
    parts.push(`channel types ${select.channel_types.join(", ")}`);
  }
  return parts.join(" · ");
}

function renderNode(node: AnyComponent, depth: number, out: string[]): void {
  const pad = "  ".repeat(depth);
  const body = "  ".repeat(depth + 1);
  const head = `${pad}${glyph(node)} ${label(node)}`;

  if (isTextDisplay(node)) {
    out.push(head);
    out.push(...textBlock(node.content ?? "", body));
    return;
  }

  if (isContainer(node)) {
    const flags = [hex(node.accent_color)];
    if (node.spoiler) flags.push("spoiler");
    out.push(`${head} — ${flags.join(", ")}`);
    for (const child of node.components) renderNode(child, depth + 1, out);
    return;
  }

  if (isSection(node)) {
    out.push(head);
    for (const child of node.components) renderNode(child, depth + 1, out);
    if (node.accessory) {
      out.push(`${body}accessory:`);
      renderNode(node.accessory, depth + 2, out);
    } else {
      out.push(`${body}accessory: (missing — Discord requires one)`);
    }
    return;
  }

  if (isActionRow(node)) {
    const children = node.components as AnyComponent[];
    out.push(`${head} — ${children.length} item${children.length === 1 ? "" : "s"}`);
    for (const child of children) renderNode(child, depth + 1, out);
    return;
  }

  if (isButton(node)) {
    out.push(`${pad}${glyph(node)} ${describeButton(node)}`);
    return;
  }

  if (isSelect(node)) {
    out.push(`${head} — ${describeSelect(node)}`);
    if (isStringSelect(node)) {
      node.options.forEach((option, i) => {
        const bits = [
          `${emojiOf(option.emoji)}${option.label}`.trim(),
          `value ${quote(option.value)}`,
        ];
        if (option.description) bits.push(quote(option.description));
        if (option.default) bits.push("selected by default");
        out.push(`${body}${i + 1}. ${bits.join(" · ")}`);
      });
      if (node.options.length === 0) out.push(`${body}(no options — Discord requires 1–25)`);
    }
    return;
  }

  if (isMediaGallery(node)) {
    out.push(`${head} — ${node.items.length} item${node.items.length === 1 ? "" : "s"}`);
    node.items.forEach((item, i) => {
      const bits = [mediaOf(item.media)];
      if (item.description) bits.push(`alt ${quote(item.description)}`);
      if (item.spoiler) bits.push("spoiler");
      out.push(`${body}${i + 1}. ${bits.join(" · ")}`);
    });
    return;
  }

  if (isThumbnail(node)) {
    const bits = [mediaOf(node.media)];
    if (node.description) bits.push(`alt ${quote(node.description)}`);
    if (node.spoiler) bits.push("spoiler");
    out.push(`${head} — ${bits.join(" · ")}`);
    return;
  }

  if (isFile(node)) {
    const bits = [mediaOf(node.file)];
    if (node.spoiler) bits.push("spoiler");
    out.push(`${head} — ${bits.join(" · ")}`);
    return;
  }

  if (isSeparator(node)) {
    const bits = [node.divider === false ? "invisible" : "divider"];
    bits.push(node.spacing === SeparatorSpacing.Large ? "large spacing" : "small spacing");
    out.push(`${head} — ${bits.join(", ")}`);
    return;
  }

  out.push(head);
}

/** Message-level settings worth stating above the tree. */
function renderHeader(message: WebhookMessage): string[] {
  const stats = messageStats(message);
  const lines = [
    `Message · ${stats.top_level_components} top-level · ${stats.total_components} components total · ${stats.characters} characters`,
  ];
  if (message.username) lines.push(`Posts as: ${quote(message.username)}`);
  if (message.avatar_url) lines.push(`Avatar: ${message.avatar_url}`);
  if (message.thread_name) lines.push(`Forum post title: ${quote(message.thread_name)}`);
  if (message.applied_tags?.length) lines.push(`Forum tags: ${message.applied_tags.join(", ")}`);
  if (message.suppress_notifications) lines.push("Silent send: notifications suppressed");
  if (message.tts) lines.push("TTS: set (ignored — Components V2 has no plain content to read)");
  const mentions = message.allowed_mentions;
  if (mentions) {
    const parts: string[] = [];
    if (mentions.parse) parts.push(`parse ${mentions.parse.join("/") || "nothing"}`);
    if (mentions.roles?.length) parts.push(`${mentions.roles.length} role(s)`);
    if (mentions.users?.length) parts.push(`${mentions.users.length} user(s)`);
    lines.push(`Allowed mentions: ${parts.join(", ") || "none"}`);
  }
  return lines;
}

/** Render the whole message as an indented outline. */
export function renderOutline(message: WebhookMessage): string {
  const out = renderHeader(message);
  out.push("");
  if (message.components.length === 0) {
    out.push("(no components — Discord rejects an empty Components V2 message)");
    return out.join("\n");
  }
  for (const node of message.components) renderNode(node, 0, out);
  return out.join("\n");
}
