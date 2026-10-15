/**
 * Discord colors in the forms people paste them: `#5865F2`, `5865F2`,
 * `0x5865F2`, the decimal `5793266` a JSON body needs, or `rgb(88, 101, 242)`.
 *
 * Discord stores every color — an embed's `color`, a Components V2 container's
 * `accent_color`, a role's color — as one integer 0xRRGGBB, and JSON has no hex
 * notation, which is why the same color keeps needing converting. Used by the
 * color converter on `/guides/discord-color-codes/`.
 */

/** The largest color Discord accepts: 0xFFFFFF. */
export const MAX_COLOR = 0xffffff;

/**
 * Reads a color however it was written, or `null`. A bare run of digits is
 * decimal unless it carries a hex letter or a `#`/`0x` prefix — "5865F2" is
 * hex, "5793266" is decimal — because that is what each form looks like where
 * people copy it from (a stylesheet versus a JSON body).
 */
export function parseColorInput(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  const rgb = /^(?:rgb\s*\(\s*)?(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*\)?$/.exec(
    text,
  );
  if (rgb) {
    const channels = rgb.slice(1, 4).map(Number);
    if (channels.some((c) => c > 255)) return null;
    return (channels[0]! << 16) + (channels[1]! << 8) + channels[2]!;
  }
  const prefixed = /^(?:#|0x)([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
  const bareHex = /^[0-9a-f]{6}$/.test(text) && /[a-f]/.test(text) ? text : null;
  const hex = prefixed?.[1] ?? bareHex;
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    return Number.parseInt(full, 16);
  }
  if (/^\d{1,8}$/.test(text)) {
    const value = Number(text);
    return value <= MAX_COLOR ? value : null;
  }
  return null;
}

export interface ColorFormats {
  /** `#5865F2` */
  hex: string;
  /** `5793266` — what a JSON body's `color` / `accent_color` takes. */
  decimal: string;
  /** `0x5865F2` — the literal JavaScript and Python accept. */
  literal: string;
  /** `rgb(88, 101, 242)` */
  rgb: string;
}

export function colorFormats(value: number): ColorFormats {
  const v = Math.max(0, Math.min(MAX_COLOR, Math.trunc(value)));
  const hex = v.toString(16).toUpperCase().padStart(6, "0");
  return {
    hex: `#${hex}`,
    decimal: String(v),
    literal: `0x${hex}`,
    rgb: `rgb(${v >> 16}, ${(v >> 8) & 0xff}, ${v & 0xff})`,
  };
}

/** Text that stays readable on a swatch of this color: dark on light, light on dark. */
export function readableOn(value: number): "#000000" | "#ffffff" {
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return luminance > 0.179 ? "#000000" : "#ffffff";
}
