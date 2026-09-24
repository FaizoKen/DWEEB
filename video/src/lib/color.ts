/**
 * Colour helpers for the film's inline styles.
 *
 * Why this exists: the v5 film built translucent colours by string-appending a
 * hex alpha (`${color}aa`). That only works on a #rrggbb token — on an rgba()
 * token (e.g. COLORS.dButtonSecondary) it produced `rgba(…)aa`, an invalid
 * value, and the browser silently dropped the WHOLE box-shadow, so four "this
 * just changed" glows never rendered. `withAlpha` parses every colour syntax the
 * film uses and throws on anything else, so a bad token fails loudly at render
 * time instead of vanishing.
 */

export type Rgba = { r: number; g: number; b: number; a: number };

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round3 = (n: number) => Math.round(n * 1000) / 1000;

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  // h in degrees, s/l in 0..1 (CSS Color 4 reference algorithm).
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** Parse #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba(), hsl() and hsla(). */
export function parseColor(color: string): Rgba {
  const c = color.trim().toLowerCase();
  if (c.startsWith("#")) {
    const hex = c.slice(1);
    if (!/^[0-9a-f]+$/.test(hex) || ![3, 4, 6, 8].includes(hex.length)) {
      throw new Error(`parseColor: bad hex colour "${color}"`);
    }
    const full =
      hex.length <= 4
        ? hex
            .split("")
            .map((ch) => ch + ch)
            .join("")
        : hex;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
    };
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(c);
  if (fn) {
    const parts = fn[2]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map((p) => p.trim());
    const num = (p: string) => parseFloat(p);
    const alpha = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? num(parts[3]) / 100 : num(parts[3]);
    if (fn[1].startsWith("rgb")) {
      if (parts.length < 3) throw new Error(`parseColor: bad rgb colour "${color}"`);
      return { r: num(parts[0]), g: num(parts[1]), b: num(parts[2]), a: alpha };
    }
    if (parts.length < 3) throw new Error(`parseColor: bad hsl colour "${color}"`);
    const [r, g, b] = hslToRgb(num(parts[0]), num(parts[1]) / 100, num(parts[2]) / 100);
    return { r, g, b, a: alpha };
  }
  throw new Error(`parseColor: unsupported colour "${color}"`);
}

const toCss = ({ r, g, b, a }: Rgba) =>
  `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${round3(clamp01(a))})`;

/** The colour at `alpha` opacity (replaces any alpha it already had). */
export function withAlpha(color: string, alpha: number): string {
  return toCss({ ...parseColor(color), a: alpha });
}

/** Linear blend of two colours in sRGB (t = 0 → a, 1 → b), alpha included. */
export function mixColor(a: string, b: string, t: number): string {
  const x = parseColor(a);
  const y = parseColor(b);
  const k = clamp01(t);
  return toCss({
    r: x.r + (y.r - x.r) * k,
    g: x.g + (y.g - x.g) * k,
    b: x.b + (y.b - x.b) * k,
    a: x.a + (y.a - x.a) * k,
  });
}

/** CSS hsla() from numbers — the product's tree tints are specified this way. */
export const hsla = (h: number, s: number, l: number, a = 1): string =>
  `hsla(${h}, ${s}%, ${l}%, ${round3(clamp01(a))})`;
