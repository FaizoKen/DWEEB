/**
 * Discord's colored text: the escape sequences inside an ```ansi code block,
 * read the way the Discord client reads them.
 *
 * Measured 2026-10-16 off discord.com's own web bundle and stylesheets, not
 * from third-party lists — those still describe the 2022 feature (eight
 * Solarized-ish colors, "30 = gray", backgrounds with names like "firefly dark
 * blue"). Discord changed it twice during 2026. In August the colors became
 * theme colors (they now differ between Light, Ash, Dark and Onyx). Then a new
 * code renderer arrived — gated behind the user experiment
 * `2026-03-arborium-highlight`, rolling out since October — whose parser takes
 * the 16 named colors (30–37, 90–97 and their backgrounds), the xterm
 * 256-color table (`38;5;n`), 24-bit RGB (`38;2;r;g;b`), italic, strikethrough
 * and overline. Readers still on the older highlight.js renderer get only
 * `LEGACY_SGR_CODES` and see everything else as plain text, which is what
 * `usesExtendedAnsi` warns about. The parser below is the new renderer's,
 * quirks included, because the point of rendering it is to show what a reader
 * in Discord will see:
 *
 * - Only an SGR sequence (`ESC [ params m`) styles anything. Any other CSI
 *   sequence is removed from the text and does nothing; a lone ESC stays.
 * - Inside one sequence every reset applies before every set, whatever their
 *   order, so `ESC[31;0m` is red — not the terminal's "red, then reset".
 * - `ESC[m` (no parameters) does nothing; only an explicit `0` resets.
 * - Dim (2), reverse (7) and hidden (8) are tracked but never drawn, and
 *   blink (5/6) is ignored. `22` turns off dim *and* bold.
 * - A malformed `38;2;…` / `48;2;…` still consumes up to three parameters.
 *
 * Pure and dependency-free: the editor preview loads it lazily (it sits off the
 * boot path), and the static guide tools bundle it as-is.
 */

/** The 16 named colors in code order: 30–37 / 40–47, then 90–97 / 100–107. */
export const ANSI_COLOR_NAMES = [
  "Black",
  "Red",
  "Green",
  "Yellow",
  "Blue",
  "Magenta",
  "Cyan",
  "White",
  "Bright black",
  "Bright red",
  "Bright green",
  "Bright yellow",
  "Bright blue",
  "Bright magenta",
  "Bright cyan",
  "Bright white",
] as const;

/** Discord's four appearance themes, by the names its settings show. */
export type AnsiTheme = "ash" | "dark" | "onyx" | "light";

/**
 * What each named color resolves to in each theme (`--ansi-*` on `.theme-dark`
 * = Ash, `.theme-darker` = Dark, `.theme-midnight` = Onyx, `.theme-light`),
 * measured 2026-10-16. High-contrast mode shifts a few of these; it is not
 * modelled. Black is pure #000000 everywhere, so it vanishes on Onyx.
 */
export const ANSI_PALETTES: Readonly<Record<AnsiTheme, readonly string[]>> = {
  ash: [
    "#000000",
    "#ec6361",
    "#45a366",
    "#ce8100",
    "#4591ec",
    "#f549c9",
    "#049faa",
    "#b6b7bc",
    "#70717a",
    "#ff938e",
    "#21bb63",
    "#e79418",
    "#a0a9fa",
    "#fd99e9",
    "#5fbfc8",
    "#ffffff",
  ],
  dark: [
    "#000000",
    "#de464a",
    "#1b8d4d",
    "#b36c00",
    "#1a7ce6",
    "#d53fae",
    "#008995",
    "#b6b7bc",
    "#70717a",
    "#f47470",
    "#21bb63",
    "#e79418",
    "#5865f2",
    "#ff4cd2",
    "#2fa9b3",
    "#ffffff",
  ],
  onyx: [
    "#000000",
    "#ca2b37",
    "#017b40",
    "#9d5a00",
    "#0268ca",
    "#b73495",
    "#00757f",
    "#b6b7bc",
    "#70717a",
    "#e55455",
    "#108e4d",
    "#db6e00",
    "#5865f2",
    "#ff4cd2",
    "#0096a1",
    "#ffffff",
  ],
  light: [
    "#000000",
    "#e75858",
    "#399b5d",
    "#c07600",
    "#3789ea",
    "#e444bb",
    "#0098a3",
    "#b6b7bc",
    "#70717a",
    "#ca2b37",
    "#108e4d",
    "#db6e00",
    "#5865f2",
    "#b3269c",
    "#007782",
    "#ffffff",
  ],
};

export type AnsiColor =
  | { kind: "named"; index: number }
  | { kind: "table"; index: number }
  | { kind: "rgb"; rgb: readonly [number, number, number] };

export interface AnsiSegment {
  text: string;
  fg: AnsiColor | null;
  bg: AnsiColor | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  overline: boolean;
}

type Decoration = "bold" | "dim" | "italic" | "underline" | "reverse" | "hidden" | "strike";

/** SGR 1–9 (and, offset by 20, their resets 21–29). 5 and 6 (blink) are ignored. */
const DECORATIONS: Partial<Record<number, Decoration>> = {
  1: "bold",
  2: "dim",
  3: "italic",
  4: "underline",
  7: "reverse",
  8: "hidden",
  9: "strike",
};

/**
 * Any CSI sequence; only a plain `m` (SGR) one styles text. Built from a char
 * code because no-control-regex refuses a literal ESC in a pattern.
 */
const CSI = new RegExp(`${String.fromCharCode(0x1b)}\\[([0-?]*)([ -/]*)([@-~])`, "g");

interface State {
  fg: AnsiColor | null;
  bg: AnsiColor | null;
  decorations: Set<Decoration | "overline">;
}

/** Reads the color after a 38 or 48; consumes its arguments either way. */
function extendedColor(params: string[]): AnsiColor | null {
  const mode = params.shift();
  if (mode === "2") {
    const rgb = params.splice(0, 3).map((p) => Number.parseInt(p, 10));
    if (rgb.length !== 3 || rgb.some((n) => Number.isNaN(n))) return null;
    return { kind: "rgb", rgb: [rgb[0]!, rgb[1]!, rgb[2]!] };
  }
  if (mode === "5") {
    const index = params.shift();
    if (index) return { kind: "table", index: Number(index) };
  }
  return null;
}

/** Applies one SGR parameter list: all resets first, then all sets. */
function applySgr(state: State, raw: string): void {
  const params = raw.split(";");
  const resets: (() => void)[] = [];
  const sets: (() => void)[] = [];
  while (params.length > 0) {
    const param = params.shift();
    if (!param) continue;
    const code = Number.parseInt(param, 10);
    if (Number.isNaN(code)) continue;
    if (code === 0) {
      resets.push(() => {
        state.fg = null;
        state.bg = null;
        state.decorations.clear();
      });
    } else if (code <= 9) {
      const decoration = DECORATIONS[code];
      if (decoration) sets.push(() => state.decorations.add(decoration));
    } else if (code <= 29) {
      const decoration = DECORATIONS[code - 20];
      if (decoration) {
        resets.push(() => {
          state.decorations.delete(decoration);
          if (decoration === "dim") state.decorations.delete("bold");
        });
      }
    } else if (code <= 37) {
      const color: AnsiColor = { kind: "named", index: code - 30 };
      sets.push(() => (state.fg = color));
    } else if (code === 38) {
      const color = extendedColor(params);
      if (color) sets.push(() => (state.fg = color));
    } else if (code === 39) {
      resets.push(() => (state.fg = null));
    } else if (code <= 47) {
      const color: AnsiColor = { kind: "named", index: code - 40 };
      sets.push(() => (state.bg = color));
    } else if (code === 48) {
      const color = extendedColor(params);
      if (color) sets.push(() => (state.bg = color));
    } else if (code === 49) {
      resets.push(() => (state.bg = null));
    } else if (code === 53) {
      sets.push(() => state.decorations.add("overline"));
    } else if (code === 55) {
      resets.push(() => state.decorations.delete("overline"));
    } else if (code >= 90 && code <= 97) {
      const color: AnsiColor = { kind: "named", index: code - 90 + 8 };
      sets.push(() => (state.fg = color));
    } else if (code >= 100 && code <= 107) {
      const color: AnsiColor = { kind: "named", index: code - 100 + 8 };
      sets.push(() => (state.bg = color));
    }
  }
  for (const reset of resets) reset();
  for (const set of sets) set();
}

/** Splits an ```ansi block's body into styled runs, as Discord does. */
export function parseAnsi(source: string): AnsiSegment[] {
  const state: State = { fg: null, bg: null, decorations: new Set() };
  const segments: AnsiSegment[] = [];
  const push = (text: string) => {
    if (!text) return;
    const d = state.decorations;
    segments.push({
      text,
      fg: state.fg,
      bg: state.bg,
      bold: d.has("bold"),
      italic: d.has("italic"),
      underline: d.has("underline"),
      strike: d.has("strike"),
      overline: d.has("overline"),
    });
  };
  let cursor = 0;
  CSI.lastIndex = 0;
  for (let match = CSI.exec(source); match; match = CSI.exec(source)) {
    push(source.slice(cursor, match.index));
    const [, params = "", intermediates = "", final] = match;
    if (final === "m" && !intermediates && !/^[<=>?]/.test(params)) applySgr(state, params);
    cursor = match.index + match[0].length;
  }
  push(source.slice(cursor));
  return segments;
}

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

function hex(rgb: readonly number[]): string {
  return `#${rgb.map((v) => Math.max(0, Math.min(v, 255)).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The CSS color a reader sees. Named colors and table entries 0–15 follow the
 * reader's theme; RGB and table entries 16–255 are the same everywhere.
 * `undefined` for a table index outside 0–255 (Discord draws nothing either).
 */
export function ansiColorCss(color: AnsiColor, palette: readonly string[]): string | undefined {
  if (color.kind === "named") return palette[color.index];
  if (color.kind === "rgb") return hex(color.rgb);
  const i = color.index;
  if (!Number.isInteger(i) || i < 0 || i > 255) return undefined;
  if (i < 16) return palette[i];
  if (i < 232) {
    const n = i - 16;
    return hex([
      CUBE_LEVELS[Math.floor(n / 36)]!,
      CUBE_LEVELS[Math.floor(n / 6) % 6]!,
      CUBE_LEVELS[n % 6]!,
    ]);
  }
  const level = 8 + (i - 232) * 10;
  return hex([level, level, level]);
}

/** Inline style for one run, or `null` when it is plain text. */
export function ansiSegmentStyle(
  segment: AnsiSegment,
  palette: readonly string[],
): {
  color?: string;
  backgroundColor?: string;
  fontWeight?: string;
  fontStyle?: string;
  textDecorationLine?: string;
} | null {
  const style: {
    color?: string;
    backgroundColor?: string;
    fontWeight?: string;
    fontStyle?: string;
    textDecorationLine?: string;
  } = {};
  const color = segment.fg ? ansiColorCss(segment.fg, palette) : undefined;
  const background = segment.bg ? ansiColorCss(segment.bg, palette) : undefined;
  if (color) style.color = color;
  if (background) style.backgroundColor = background;
  if (segment.bold) style.fontWeight = "bold";
  if (segment.italic) style.fontStyle = "italic";
  const lines = [
    segment.underline && "underline",
    segment.strike && "line-through",
    segment.overline && "overline",
  ].filter(Boolean);
  if (lines.length > 0) style.textDecorationLine = lines.join(" ");
  return Object.keys(style).length > 0 ? style : null;
}

function colorCodes(color: AnsiColor, base: 30 | 40): string[] {
  if (color.kind === "named") {
    return [String(color.index < 8 ? base + color.index : base + 60 + color.index - 8)];
  }
  if (color.kind === "table") return [String(base + 8), "5", String(color.index)];
  return [String(base + 8), "2", ...color.rgb.map(String)];
}

/** The SGR parameters that draw one run's style, in a stable order. */
export function ansiCodesFor(segment: Omit<AnsiSegment, "text">): string[] {
  const codes: string[] = [];
  if (segment.bold) codes.push("1");
  if (segment.italic) codes.push("3");
  if (segment.underline) codes.push("4");
  if (segment.strike) codes.push("9");
  if (segment.overline) codes.push("53");
  if (segment.fg) codes.push(...colorCodes(segment.fg, 30));
  if (segment.bg) codes.push(...colorCodes(segment.bg, 40));
  return codes;
}

/**
 * Styled runs → the text of an ```ansi block. Each change of style is one
 * sequence that resets and then sets everything (`ESC[0;1;31m`), which both of
 * Discord's renderers read the same way: the newer one applies every reset
 * before every set, the older one reads the codes left to right. The block
 * ends reset so nothing leaks past it.
 */
export function encodeAnsi(segments: readonly AnsiSegment[]): string {
  const esc = String.fromCharCode(0x1b);
  let out = "";
  let current = "";
  for (const segment of segments) {
    if (!segment.text) continue;
    const key = ansiCodesFor(segment).join(";");
    if (key !== current) {
      out += !key ? `${esc}[0m` : current ? `${esc}[0;${key}m` : `${esc}[${key}m`;
      current = key;
    }
    out += segment.text;
  }
  if (current) out += `${esc}[0m`;
  return out;
}

/**
 * The codes Discord's older highlight.js renderer understands — reset, bold,
 * underline and the eight basic foreground and background colors. Every reader
 * sees these; anything else needs the newer renderer.
 */
export const LEGACY_SGR_CODES: ReadonlySet<number> = new Set([
  0, 1, 4, 30, 31, 32, 33, 34, 35, 36, 37, 40, 41, 42, 43, 44, 45, 46, 47,
]);

/**
 * True when `source` uses a code outside `LEGACY_SGR_CODES` — a bright, 256 or
 * RGB color, italic, strikethrough, overline or a partial reset — which readers
 * on Discord's older renderer see as plain text.
 */
export function usesExtendedAnsi(source: string): boolean {
  CSI.lastIndex = 0;
  for (let match = CSI.exec(source); match; match = CSI.exec(source)) {
    const [, params = "", intermediates = "", final] = match;
    if (final !== "m" || intermediates || /^[<=>?]/.test(params)) continue;
    for (const param of params.split(";")) {
      if (!param) continue;
      const code = Number.parseInt(param, 10);
      if (!Number.isNaN(code) && !LEGACY_SGR_CODES.has(code)) return true;
    }
  }
  return false;
}

/** True for the language tags Discord treats as ANSI (it lowercases the tag). */
export function isAnsiLanguage(lang: string | null | undefined): boolean {
  return lang?.toLowerCase() === "ansi";
}
