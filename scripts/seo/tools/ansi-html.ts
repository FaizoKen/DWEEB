/**
 * Discord colored text (```ansi blocks) → safe HTML, for the colored text
 * generator on `/guides/discord-colored-text/`.
 *
 * Shared by the build (the tool's worked example) and the browser script, and
 * built on `src/features/preview/markdown/ansi.ts` — the module the editor's
 * preview colors with, differentially tested against Discord's own parser — so
 * the guide, the editor and Discord agree on what a sequence means.
 *
 * Safe for `innerHTML` by construction: text is escaped, and the only attribute
 * values are colors `ansiColorCss` computed from parsed numbers (always
 * `#rrggbb`), fixed keywords, and SGR digit strings.
 *
 * Client-safe: imports nothing from the page generator.
 */

import {
  ANSI_PALETTES,
  ansiCodesFor,
  ansiSegmentStyle,
  parseAnsi,
  type AnsiSegment,
  type AnsiTheme,
} from "@/features/preview/markdown/ansi";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeAnsiText(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * Each theme's chat surface and code text color, measured off discord.com
 * 2026-10-16 (`--background-base-lower` / `--text-code`), in the order
 * Discord's appearance settings list them.
 */
export const ANSI_THEMES: readonly {
  id: AnsiTheme;
  label: string;
  surface: string;
  text: string;
}[] = [
  { id: "light", label: "Light", surface: "#fbfbfb", text: "#36373e" },
  { id: "ash", label: "Ash", surface: "#323339", text: "#ffffff" },
  { id: "dark", label: "Dark", surface: "#1a1a1e", text: "#e4e4e6" },
  { id: "onyx", label: "Onyx", surface: "#000000", text: "#c9cace" },
];

export const DEFAULT_ANSI_THEME: AnsiTheme = "dark";

/** `style="…"` for one run, or "" when it is plain. */
export function ansiStyleAttr(segment: AnsiSegment, theme: AnsiTheme): string {
  const style = ansiSegmentStyle(segment, ANSI_PALETTES[theme]);
  if (!style) return "";
  const parts: string[] = [];
  if (style.color) parts.push(`color:${style.color}`);
  if (style.backgroundColor) parts.push(`background-color:${style.backgroundColor}`);
  if (style.fontWeight) parts.push(`font-weight:${style.fontWeight}`);
  if (style.fontStyle) parts.push(`font-style:${style.fontStyle}`);
  if (style.textDecorationLine) parts.push(`text-decoration-line:${style.textDecorationLine}`);
  return ` style="${parts.join(";")}"`;
}

/**
 * Runs as spans. `editable` is the generator's input: newlines become `<br>`
 * (a trailing one gets a filler so the caret can sit on the last line) and
 * every span records its SGR codes in `data-ansi` so the script can read the
 * styles back. Otherwise newlines stay literal, for a `<pre>`.
 */
export function ansiSegmentsHtml(
  segments: readonly AnsiSegment[],
  theme: AnsiTheme,
  editable = false,
): string {
  let html = "";
  for (const segment of segments) {
    if (!segment.text) continue;
    const text = escapeAnsiText(segment.text);
    const body = editable ? text.replace(/\n/g, "<br>") : text;
    const codes = ansiCodesFor(segment).join(";");
    const style = ansiStyleAttr(segment, theme);
    html +=
      codes || style
        ? `<span${editable && codes ? ` data-ansi="${codes}"` : ""}${style}>${body}</span>`
        : body;
  }
  const last = segments.at(-1)?.text ?? "";
  if (editable && (!html || last.endsWith("\n"))) html += "<br data-filler>";
  return html;
}

/** The body of an ```ansi block, rendered as Discord shows it. */
export function ansiSourceHtml(source: string, theme: AnsiTheme): string {
  return ansiSegmentsHtml(parseAnsi(source), theme);
}

/** What the visitor pastes into Discord: the escapes inside an ansi block. */
export function discordAnsiBlock(ansi: string): string {
  return `\`\`\`ansi\n${ansi}\n\`\`\``;
}

/**
 * The same text as a string literal for a bot or a webhook's JSON body. The
 * escape is written `\u001b`, which JSON, JavaScript and Python all read as ESC.
 */
export function ansiStringLiteral(ansi: string): string {
  return JSON.stringify(ansi);
}
