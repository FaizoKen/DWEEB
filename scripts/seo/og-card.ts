/**
 * Per-template Open Graph card (1200×630 SVG → PNG by `gen-template-og.ts`).
 *
 * A branded share card: the DWEEB lockup, the template's accent colour as a
 * kicker rule + rail, the title as the hero, and a category pill. Deliberately
 * emoji-free — `sharp`'s SVG rasterizer renders emoji as a monochrome glyph that
 * vanishes on the dark background — so it's pure shapes + text and looks
 * identical on every machine. Text is hand-wrapped (SVG has no auto-wrap); the
 * font stack matches `gen-assets.mjs` (Segoe UI / Arial resolve where these
 * rasterize).
 */

const FONT = "system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif";

export interface OgCardData {
  /** Large title — the template H1 (or the index title). */
  title: string;
  /** Category / kicker label for the pill. */
  category: string;
  /** Accent as 0xRRGGBB. */
  accent: number;
  /** Bottom kicker line. */
  kicker?: string;
}

function hex(n: number): string {
  return `#${(n & 0xffffff).toString(16).padStart(6, "0")}`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Greedy word-wrap to at most `maxLines` lines of roughly `maxChars` each. */
function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1]!.replace(/[\s.]+$/, "") + "…";
  }
  return lines;
}

/** Rough pixel width of a string at a given font size (800-weight ≈ 0.58em). */
function approxWidth(text: string, size: number): number {
  return Math.ceil(text.length * size * 0.58);
}

export function ogCardSvg(d: OgCardData): string {
  const accent = hex(d.accent);
  const kicker = d.kicker ?? "Free Discord message template · Components V2";

  const titleLines = wrapText(d.title, 19, 3);
  const titleSize = titleLines.length >= 3 ? 70 : 80;
  const lineH = titleSize * 1.1;
  // Vertically centre the title block around y≈300.
  const firstBaseline = 300 - ((titleLines.length - 1) * lineH) / 2 + titleSize * 0.34;
  const titleTspans = titleLines
    .map((ln, i) => `<tspan x="96" dy="${i === 0 ? 0 : lineH}">${escapeXml(ln)}</tspan>`)
    .join("");

  const pillW = approxWidth(d.category, 24) + 44;

  // DWEEB nerd-glasses mark, authored on a 512 grid, scaled into the header.
  const mark = `
    <rect width="512" height="512" rx="128" fill="#5865F2"/>
    <rect x="40" y="210" width="52" height="30" rx="15" fill="#fff"/>
    <rect x="420" y="210" width="52" height="30" rx="15" fill="#fff"/>
    <rect x="214" y="200" width="84" height="30" rx="15" fill="#57F287"/>
    <rect x="78" y="182" width="148" height="148" rx="46" fill="#fff"/>
    <rect x="286" y="182" width="148" height="148" rx="46" fill="#fff"/>
    <path d="M226 360 h28 v24 a12 12 0 0 1 -12 12 h-4 a12 12 0 0 1 -12 -12 z" fill="#fff"/>
    <path d="M258 360 h28 v24 a12 12 0 0 1 -12 12 h-4 a12 12 0 0 1 -12 -12 z" fill="#fff"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="glow" cx="22%" cy="24%" r="80%">
      <stop offset="0%" stop-color="#2c2f5e"/>
      <stop offset="60%" stop-color="#1a1b1e" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="1200" height="630" fill="#1a1b1e"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <rect x="0" y="0" width="14" height="630" fill="${accent}"/>

  <!-- brand lockup, top-right -->
  <g transform="translate(1012,56) scale(0.1289)">${mark}</g>
  <text x="992" y="104" text-anchor="end" font-family="${FONT}" font-size="38" font-weight="800" letter-spacing="3" fill="#ffffff">DWEEB</text>

  <!-- accent kicker rule -->
  <rect x="96" y="150" width="88" height="9" rx="4.5" fill="${accent}"/>

  <!-- title -->
  <text x="96" y="${Math.round(firstBaseline)}" font-family="${FONT}" font-size="${titleSize}" font-weight="800" letter-spacing="-1.5" fill="#ffffff">${titleTspans}</text>

  <!-- category pill -->
  <g transform="translate(96,486)">
    <rect x="0" y="-30" width="${pillW}" height="46" rx="23" fill="${accent}" opacity="0.16"/>
    <text x="22" y="0" font-family="${FONT}" font-size="24" font-weight="700" fill="${accent}">${escapeXml(d.category)}</text>
  </g>
  <text x="96" y="556" font-family="${FONT}" font-size="26" font-weight="500" fill="#b5bac1">${escapeXml(kicker)}</text>
</svg>`;
}
