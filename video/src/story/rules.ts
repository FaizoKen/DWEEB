/**
 * Product rules the film reproduces, mirrored from the DWEEB app so on-screen
 * strings are computed the same way the product computes them. Pure TS (no
 * React, no Remotion) so a Bun check at the repo root can import it next to the
 * real implementations and assert they agree.
 *
 * Sources (D:\repo\DWEEB):
 *  - COMPONENT_META labels/glyphs ........ src/core/schema/metadata.ts:32-108
 *  - tree row summaries ................... src/features/builder/components/ComponentTree.tsx:1773-1799
 *  - tree row hue/saturation per type ..... src/features/builder/components/ComponentTree.module.css:201-247
 *  - stat pills "n / max label" ........... ComponentTree.tsx:561-591 (LIMITS 40 / 4000)
 *  - giveaway button count label .......... plugins/giveaway/src/discord.rs:467-472
 *  - preview clock (2-digit h:mm AM) ...... src/features/preview/Preview.tsx:99-102
 */

/** The component kinds the film shows, keyed like the product's ComponentType. */
export type ComponentKind =
  | "container"
  | "section"
  | "text"
  | "gallery"
  | "file"
  | "separator"
  | "actionRow"
  | "button"
  | "thumbnail"
  | "select";

/**
 * Label + glyph exactly as COMPONENT_META defines them, plus the tree's
 * per-type tint (hue/saturation from ComponentTree.module.css). The film draws
 * the glyphs as SVG (see components/editor/glyphs.tsx) — the unicode characters
 * are not in the Inter subsets we load, so a font fallback would draw them
 * differently on every machine.
 */
export const COMPONENT_META: Record<
  ComponentKind,
  { label: string; glyph: string; hue: number; sat: number; addLabel?: string }
> = {
  container: { label: "Container", glyph: "▤", hue: 235, sat: 68 },
  section: { label: "Section", glyph: "◧", hue: 188, sat: 60 },
  text: { label: "Text", glyph: "¶", hue: 212, sat: 66 },
  gallery: { label: "Media gallery", glyph: "▦", hue: 268, sat: 60 },
  file: { label: "File", glyph: "⎘", hue: 38, sat: 75 },
  separator: { label: "Separator", glyph: "―", hue: 220, sat: 10 },
  actionRow: { label: "Action row", glyph: "⬚", hue: 145, sat: 52, addLabel: "Buttons & menus" },
  button: { label: "Button", glyph: "▭", hue: 150, sat: 52 },
  thumbnail: { label: "Thumbnail", glyph: "▣", hue: 330, sat: 62 },
  // The five selects share one tint; the film only ever shows the string one.
  select: { label: "Options menu", glyph: "▾", hue: 22, sat: 70 },
};

/** Discord's message-wide caps (src/core/schema/limits.ts). */
export const LIMITS = { TOTAL_COMPONENTS: 40, TOTAL_CHARACTERS: 4000 } as const;

/** Text row summary: whitespace collapsed, cut at 40 UTF-16 units + "…". */
export function summarizeText(content: string): string {
  const t = content.replace(/\s+/g, " ").trim();
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}

export const summarizeContainer = (children: number) =>
  `${children} ${children === 1 ? "child" : "children"}`;
export const summarizeGallery = (items: number) => `${items} ${items === 1 ? "item" : "items"}`;
export const summarizeActionRow = (buttons: number, isSelectRow = false) =>
  isSelectRow ? "1 select" : `${buttons} ${buttons === 1 ? "button" : "buttons"}`;

/** The MetaHeader budget pill text, e.g. "9 / 40 components", "1 / 4000 char". */
export function statPillText(value: number, max: number, singular: string, plural: string) {
  return `${value} / ${max} ${value === 1 ? singular : plural}`;
}

/** Thousands separators the way the giveaway plugin's `commas()` prints them. */
export const commas = (n: number) => Math.round(n).toLocaleString("en-US");

/**
 * The public Enter button after an entry: the plugin answers with a type-7
 * UPDATE_MESSAGE that restamps the label as `{label} ({count})` — there is no
 * ephemeral "you're entered" reply for a member's new entry.
 */
export const labelWithCount = (label: string, count: number) => `${label} (${commas(count)})`;

/** The editor preview's frozen send time: toLocaleTimeString 2-digit, en-US. */
export function previewClock(hour24: number, minute: number): string {
  const h12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const ampm = hour24 < 12 ? "AM" : "PM";
  return `${String(h12).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${ampm}`;
}

/** Discord's own cozy-mode timestamp for a message sent today. */
export function discordToday(hour24: number, minute: number): string {
  const h12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const ampm = hour24 < 12 ? "AM" : "PM";
  return `Today at ${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
}

/**
 * Split a string into user-perceived characters (grapheme-ish) so a typing
 * animation never shows half of an emoji's surrogate pair. Covers the emoji the
 * film types (🚀 📢 🎮 and ZWJ/VS16 sequences); plain Array.from would split a
 * ZWJ family or a keycap into several visible glyphs.
 */
export function graphemes(text: string): string[] {
  const out: string[] = [];
  for (const cp of Array.from(text)) {
    const prev = out[out.length - 1];
    const joiner = cp === "\u200d" || cp === "\ufe0f" || (prev !== undefined && prev.endsWith("\u200d"));
    if (joiner && prev !== undefined) out[out.length - 1] = prev + cp;
    else out.push(cp);
  }
  return out;
}
