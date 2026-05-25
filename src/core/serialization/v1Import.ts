/**
 * V1 → V2 webhook payload converter.
 *
 * Discord's pre-Components-V2 webhook payloads carried `content`, `embeds`,
 * `poll`, and `stickers` — all of which are forbidden once the IS_COMPONENTS_V2
 * flag is set. This module detects such payloads on import and rewrites them
 * into an equivalent V2 component tree so users can paste historic JSON and
 * keep editing.
 *
 * Conversion rules (kept conservative — we want a faithful translation, not
 * a redesign):
 *
 *  - `content`     → a TextDisplay prepended to the component list.
 *  - each `embed`  → a Container (with `accent_color = embed.color`) whose
 *                    children render the author / title / description /
 *                    fields / image / thumbnail / footer in that order.
 *  - `poll`        → dropped with a notice (V2 forbids polls outright).
 *  - `stickers` /  → dropped with a notice (not legal alongside V2 either).
 *    `sticker_ids`
 *
 * Embed-specific notes:
 *  - `video` and `provider` are dropped (V2 has no equivalent).
 *  - `author.icon_url` / `footer.icon_url` are dropped (V2 has no inline
 *    icon for text); the names/text are preserved.
 *  - `field.inline` is honoured loosely — V2 has no grid, so inline fields
 *    render stacked. The text is preserved.
 *  - If an embed produces more than `LIMITS.CONTAINER_CHILDREN` children we
 *    truncate and append a "[N more dropped]" footer.
 *
 * The converter does NOT mutate its input. It builds a fresh `WebhookMessage`
 * with editor ids stamped via the factories.
 */

import {
  ComponentType,
  type AnyComponent,
  type ContainerChild,
  type ContainerComponent,
  type FileComponent,
  type MediaGalleryComponent,
  type SectionComponent,
  type TextDisplayComponent,
  type ThumbnailComponent,
  type TopLevelComponent,
  type UnfurledMediaItem,
  type WebhookMessage,
} from "@/core/schema/types";
import { LIMITS } from "@/core/schema/limits";
import { newId } from "@/lib/id";
import { attachEditorFields } from "./normalize";

/** A single record of what the converter did to one V1 field. */
export interface V1ImportNote {
  level: "info" | "warning";
  /** Short tag — the field/source the note describes. */
  source: string;
  message: string;
}

export interface V1DetectionResult {
  /** True when the payload carries at least one V1-only field. */
  hasV1Fields: boolean;
  /** Field names actually present (informational). */
  fields: string[];
}

/**
 * Quick scan to decide whether the Import panel should preview a conversion.
 * Does not mutate or convert — that's `convertV1Payload`'s job.
 */
export function detectV1Fields(raw: unknown): V1DetectionResult {
  if (!raw || typeof raw !== "object") return { hasV1Fields: false, fields: [] };
  const obj = raw as Record<string, unknown>;
  const fields: string[] = [];
  if (typeof obj.content === "string" && obj.content.length > 0) fields.push("content");
  if (Array.isArray(obj.embeds) && obj.embeds.length > 0) fields.push("embeds");
  if (obj.poll && typeof obj.poll === "object") fields.push("poll");
  if (Array.isArray(obj.stickers) && obj.stickers.length > 0) fields.push("stickers");
  if (Array.isArray(obj.sticker_ids) && obj.sticker_ids.length > 0) fields.push("sticker_ids");
  return { hasV1Fields: fields.length > 0, fields };
}

export interface V1ConversionResult {
  message: WebhookMessage;
  notes: V1ImportNote[];
}

/**
 * Convert a payload that may contain V1 fields into a pure V2 message.
 *
 * Throws if the payload isn't an object at all — caller is expected to have
 * JSON-parsed and shape-checked first.
 */
export function convertV1Payload(raw: unknown): V1ConversionResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("Payload must be a JSON object.");
  }
  const obj = raw as Record<string, unknown>;
  const notes: V1ImportNote[] = [];

  // Start with whatever V2 components are already present. We attach editor
  // ids by routing through the normal importer; this also reuses its
  // tolerance for unknown component fields.
  const baseMessage = attachEditorFields({
    ...obj,
    components: Array.isArray(obj.components) ? obj.components : [],
  });

  const prepended: TopLevelComponent[] = [];

  if (typeof obj.content === "string" && obj.content.trim().length > 0) {
    const text = String(obj.content);
    const truncated = text.length > LIMITS.TEXT_DISPLAY_CONTENT;
    prepended.push(
      mkTextDisplay(truncated ? text.slice(0, LIMITS.TEXT_DISPLAY_CONTENT) : text),
    );
    notes.push({
      level: "info",
      source: "content",
      message: truncated
        ? `\`content\` → TextDisplay (truncated to ${LIMITS.TEXT_DISPLAY_CONTENT} chars).`
        : "`content` → TextDisplay at the top of the message.",
    });
  }

  if (Array.isArray(obj.embeds) && obj.embeds.length > 0) {
    for (const [i, raw] of obj.embeds.entries()) {
      if (!raw || typeof raw !== "object") continue;
      const container = embedToContainer(raw as Record<string, unknown>, i, notes);
      if (container) prepended.push(container);
    }
  }

  if (obj.poll && typeof obj.poll === "object") {
    notes.push({
      level: "warning",
      source: "poll",
      message: "`poll` was dropped — Components V2 messages cannot carry polls.",
    });
  }

  if (
    (Array.isArray(obj.stickers) && obj.stickers.length > 0) ||
    (Array.isArray(obj.sticker_ids) && obj.sticker_ids.length > 0)
  ) {
    notes.push({
      level: "warning",
      source: "stickers",
      message: "`stickers` / `sticker_ids` were dropped — not legal on V2 messages.",
    });
  }

  const merged: TopLevelComponent[] = [...prepended, ...baseMessage.components];

  // Trim to the top-level cap if conversion overflowed it.
  if (merged.length > LIMITS.TOP_LEVEL_COMPONENTS) {
    const dropped = merged.length - LIMITS.TOP_LEVEL_COMPONENTS;
    merged.length = LIMITS.TOP_LEVEL_COMPONENTS;
    notes.push({
      level: "warning",
      source: "limits",
      message: `${dropped} top-level component(s) were dropped — V2 caps a message at ${LIMITS.TOP_LEVEL_COMPONENTS}.`,
    });
  }

  return {
    message: { ...baseMessage, components: merged },
    notes,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Embed → Container
// ────────────────────────────────────────────────────────────────────────────

interface V1EmbedField {
  name?: string;
  value?: string;
  inline?: boolean;
}

interface V1EmbedMedia {
  url?: string;
  proxy_url?: string;
  height?: number;
  width?: number;
}

function embedToContainer(
  embed: Record<string, unknown>,
  index: number,
  notes: V1ImportNote[],
): ContainerComponent | null {
  const authorObj = embed.author && typeof embed.author === "object"
    ? (embed.author as Record<string, unknown>)
    : null;
  const footerObj = embed.footer && typeof embed.footer === "object"
    ? (embed.footer as Record<string, unknown>)
    : null;
  const fields = Array.isArray(embed.fields) ? (embed.fields as V1EmbedField[]) : [];
  const image = pickMedia(embed.image);
  const thumbnail = pickMedia(embed.thumbnail);

  const headerLines: string[] = [];
  const authorLine = formatAuthorLine(authorObj);
  if (authorLine) headerLines.push(authorLine);
  const titleLine = formatTitleLine(
    typeof embed.title === "string" ? embed.title : undefined,
    typeof embed.url === "string" ? embed.url : undefined,
    headerLines.length > 0,
  );
  if (titleLine) headerLines.push(titleLine);

  const description = typeof embed.description === "string" ? embed.description : "";
  const accentColor =
    typeof embed.color === "number" && Number.isInteger(embed.color)
      ? embed.color
      : undefined;

  const children: ContainerChild[] = [];
  let firstBlockSpent = false;

  // If we have a thumbnail, wrap the header + description in a Section with
  // the thumbnail accessory — that's the natural V2 equivalent of an embed's
  // top-right thumbnail.
  if (thumbnail) {
    const sectionTexts: TextDisplayComponent[] = [];
    const headerText = headerLines.join("\n").trim();
    if (headerText) sectionTexts.push(mkTextDisplay(headerText));
    if (description) sectionTexts.push(mkTextDisplay(description));
    if (sectionTexts.length === 0) sectionTexts.push(mkTextDisplay(" "));
    // Section accepts 1–3 TextDisplays; truncate just in case.
    const limited = sectionTexts.slice(0, LIMITS.SECTION_TEXTS_MAX);
    children.push(mkSection(limited, mkThumbnail(thumbnail)));
    firstBlockSpent = true;
  } else {
    const headerText = headerLines.join("\n").trim();
    if (headerText) {
      children.push(mkTextDisplay(headerText));
      firstBlockSpent = true;
    }
    if (description) {
      children.push(mkTextDisplay(description));
      firstBlockSpent = true;
    }
  }

  // Fields — one TextDisplay per field. We honour `inline` only loosely;
  // V2 has no grid layout for text, so inline fields stack vertically.
  let inlineLossWarned = false;
  for (const field of fields) {
    if (!field || typeof field !== "object") continue;
    const name = typeof field.name === "string" ? field.name : "";
    const value = typeof field.value === "string" ? field.value : "";
    if (!name && !value) continue;
    const body =
      name && value
        ? `**${name}**\n${value}`
        : (name || value);
    children.push(mkTextDisplay(body));
    if (field.inline && !inlineLossWarned) {
      notes.push({
        level: "info",
        source: `embed[${index}].fields`,
        message:
          "`inline: true` on embed fields was dropped — V2 has no grid layout, so fields stack vertically.",
      });
      inlineLossWarned = true;
    }
  }

  if (image) {
    children.push(mkMediaGallery(image));
  }

  const footerText = formatFooterLine(footerObj, typeof embed.timestamp === "string" ? embed.timestamp : undefined);
  if (footerText) {
    children.push(mkTextDisplay(footerText));
  }

  // Drops with warnings for fields V2 doesn't model.
  if (embed.video && typeof embed.video === "object") {
    notes.push({
      level: "warning",
      source: `embed[${index}].video`,
      message: "`video` was dropped — V2 has no video player component.",
    });
  }
  if (embed.provider && typeof embed.provider === "object") {
    notes.push({
      level: "info",
      source: `embed[${index}].provider`,
      message: "`provider` was dropped — V2 has no provider line.",
    });
  }
  if (authorObj && typeof authorObj.icon_url === "string") {
    notes.push({
      level: "info",
      source: `embed[${index}].author.icon_url`,
      message: "`author.icon_url` was dropped — V2 cannot inline an icon next to text.",
    });
  }
  if (footerObj && typeof footerObj.icon_url === "string") {
    notes.push({
      level: "info",
      source: `embed[${index}].footer.icon_url`,
      message: "`footer.icon_url` was dropped — V2 cannot inline an icon next to text.",
    });
  }

  // Enforce container child cap.
  if (children.length > LIMITS.CONTAINER_CHILDREN) {
    const overflow = children.length - LIMITS.CONTAINER_CHILDREN;
    children.length = LIMITS.CONTAINER_CHILDREN - 1;
    children.push(
      mkTextDisplay(`*[${overflow} more component(s) dropped — V2 container cap is ${LIMITS.CONTAINER_CHILDREN}]*`),
    );
    notes.push({
      level: "warning",
      source: `embed[${index}]`,
      message: `Embed produced more than ${LIMITS.CONTAINER_CHILDREN} children — ${overflow} were truncated.`,
    });
  }

  if (children.length === 0) {
    // An entirely empty embed — emit a placeholder so the container is legal.
    children.push(mkTextDisplay("*[empty embed]*"));
  }

  // Suppress the unused-warning for `firstBlockSpent` (kept for readability).
  void firstBlockSpent;

  return {
    _id: newId(),
    type: ComponentType.Container,
    accent_color: accentColor,
    components: children,
  };
}

function formatAuthorLine(author: Record<string, unknown> | null): string | null {
  if (!author) return null;
  const name = typeof author.name === "string" ? author.name : "";
  if (!name) return null;
  const url = typeof author.url === "string" ? author.url : "";
  const linked = url ? `[${name}](${url})` : name;
  // "-# " is Discord's small/subtext markdown prefix.
  return `-# **${linked}**`;
}

function formatTitleLine(
  title: string | undefined,
  url: string | undefined,
  hasAuthor: boolean,
): string | null {
  if (!title) return null;
  // Use H2 when paired with an author block so the visual hierarchy reads
  // closer to Discord's native embed (author = small, title = headline).
  const heading = hasAuthor ? "##" : "#";
  const linked = url ? `[${title}](${url})` : title;
  return `${heading} ${linked}`;
}

function formatFooterLine(
  footer: Record<string, unknown> | null,
  timestamp: string | undefined,
): string | null {
  const footerText = footer && typeof footer.text === "string" ? footer.text : "";
  let tsBlock = "";
  if (timestamp) {
    const ts = Date.parse(timestamp);
    if (Number.isFinite(ts)) {
      // <t:unix:f> renders as the user-localised long date/time.
      tsBlock = `<t:${Math.floor(ts / 1000)}:f>`;
    }
  }
  const parts: string[] = [];
  if (footerText) parts.push(footerText);
  if (tsBlock) parts.push(tsBlock);
  if (parts.length === 0) return null;
  return `-# ${parts.join(" • ")}`;
}

function pickMedia(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const media = raw as V1EmbedMedia;
  if (typeof media.url === "string" && media.url.length > 0) return media.url;
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Component factories (local — these mint editor ids without going through
// the public `createComponent` helpers so we can pass exact field values).
// ────────────────────────────────────────────────────────────────────────────

function mkTextDisplay(content: string): TextDisplayComponent {
  const capped =
    content.length > LIMITS.TEXT_DISPLAY_CONTENT
      ? content.slice(0, LIMITS.TEXT_DISPLAY_CONTENT)
      : content;
  return { _id: newId(), type: ComponentType.TextDisplay, content: capped };
}

function mkSection(
  texts: TextDisplayComponent[],
  accessory: ThumbnailComponent | AnyComponent,
): SectionComponent {
  return {
    _id: newId(),
    type: ComponentType.Section,
    components: texts,
    accessory: accessory as SectionComponent["accessory"],
  };
}

function mkThumbnail(url: string): ThumbnailComponent {
  const media: UnfurledMediaItem = { url };
  return { _id: newId(), type: ComponentType.Thumbnail, media };
}

function mkMediaGallery(url: string): MediaGalleryComponent {
  return {
    _id: newId(),
    type: ComponentType.MediaGallery,
    items: [{ media: { url } }],
  };
}

// Re-exported for completeness (unused here but matching the factory style).
export type { FileComponent };
