/**
 * Discord timestamp helpers, shared by the preview renderer, the toolbar's
 * timestamp picker and the static timestamp generator on
 * `/guides/discord-timestamp-format/` (bundled at build time by
 * `scripts/gen-template-pages.ts`), so a `<t:unix:style>` token previews
 * identically in all three.
 *
 * Discord renders timestamps in the *viewer's* locale and timezone; we mirror
 * that with `Intl`, which keys off the runtime's locale/zone. The styles, their
 * names and the order they're listed in follow Discord's message-formatting
 * reference, which gained `s` and `S` after the original seven — a token using
 * either of those used to fall through the preview parser and render as raw
 * `<t:…:s>` text while Discord showed a date.
 */

export type TimestampStyleCode = "t" | "T" | "d" | "D" | "f" | "F" | "s" | "S" | "R";

export interface TimestampStyle {
  /** The code that goes in `<t:unix:code>`. */
  code: TimestampStyleCode;
  /** Short label shown next to the live preview (Discord's own name for it). */
  label: string;
}

/** Styles in the order Discord's formatting reference lists them. */
export const TIMESTAMP_STYLES: readonly TimestampStyle[] = [
  { code: "t", label: "Short time" },
  { code: "T", label: "Medium time" },
  { code: "d", label: "Short date" },
  { code: "D", label: "Long date" },
  { code: "f", label: "Long date, short time" },
  { code: "F", label: "Full date, short time" },
  { code: "s", label: "Short date, short time" },
  { code: "S", label: "Short date, medium time" },
  { code: "R", label: "Relative" },
];

/** The style Discord uses when a token names none (`<t:unix>`). */
export const DEFAULT_TIMESTAMP_STYLE: TimestampStyleCode = "f";

const STYLE_CODES = new Set<string>(TIMESTAMP_STYLES.map((style) => style.code));

/** Whether `code` is one of Discord's timestamp style letters. Case-sensitive. */
export function isTimestampStyle(code: string): code is TimestampStyleCode {
  return STYLE_CODES.has(code);
}

/**
 * The widest range `Date` can represent, in seconds. Anything outside it would
 * render as "Invalid Date", so parsing refuses it rather than producing a token
 * nobody can read.
 */
const MAX_ABS_UNIX = 8_640_000_000_000;

/** The token Discord replaces with a localized date, e.g. `<t:1767225600:F>`. */
export function timestampToken(unix: number, style: TimestampStyleCode): string {
  return `<t:${Math.trunc(unix)}:${style}>`;
}

/** Render a unix timestamp (seconds) the way Discord would, for the given style. */
export function formatTimestamp(unix: number, style: string): string {
  const d = new Date(unix * 1000);
  switch (style) {
    // Discord names these "Short Time" and "Medium Time" — Intl's own short and
    // medium time styles, and the same short time `f` and `s` end with. (This
    // used to force a 2-digit hour, so `t` read "09:05 AM" beside `f`'s
    // "…at 9:05 AM" for the same moment.)
    case "t":
      return d.toLocaleTimeString([], { timeStyle: "short" });
    case "T":
      return d.toLocaleTimeString([], { timeStyle: "medium" });
    case "d":
      return d.toLocaleDateString();
    case "D":
      return d.toLocaleDateString([], { dateStyle: "long" });
    case "f":
      return d.toLocaleString([], { dateStyle: "long", timeStyle: "short" });
    case "F":
      return d.toLocaleString([], { dateStyle: "full", timeStyle: "short" });
    case "s":
      return d.toLocaleString([], {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    case "S":
      return d.toLocaleString([], {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      });
    case "R":
      return formatRelative(unix);
    default:
      return d.toLocaleString();
  }
}

/** What `parseTimestampInput` understood from a pasted value. */
export interface ParsedTimestampInput {
  /** Seconds since the unix epoch. */
  unix: number;
  /** The style named by a pasted `<t:…:X>` token, if any. */
  style?: TimestampStyleCode;
  /** True when the input looked like milliseconds and was divided by 1000. */
  fromMilliseconds?: boolean;
}

/**
 * Read whatever someone pastes into a timestamp decoder: a Discord token
 * (`<t:1767225600:R>`, with or without the brackets or a style), a unix time in
 * seconds, or one in milliseconds — the most common mistake, since
 * `Date.now()` and most JavaScript APIs return milliseconds. Anything with 13
 * or more digits is treated as milliseconds: 10^12 seconds is the year 33,658,
 * so no real timestamp in seconds is that long. Returns `null` for anything
 * else rather than guessing.
 */
export function parseTimestampInput(raw: string): ParsedTimestampInput | null {
  const text = raw.trim();
  if (!text) return null;
  const token = /^<?t:(-?\d{1,16})(?::([A-Za-z]))?>?$/.exec(text);
  if (token) {
    const unix = Number(token[1]);
    const style = token[2];
    if (style !== undefined && !isTimestampStyle(style)) return null;
    if (!Number.isSafeInteger(unix) || Math.abs(unix) > MAX_ABS_UNIX) return null;
    return style === undefined ? { unix } : { unix, style };
  }
  if (!/^-?\d{1,16}$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value)) return null;
  const digits = text.replace("-", "").length;
  const unix = digits >= 13 ? Math.trunc(value / 1000) : value;
  if (Math.abs(unix) > MAX_ABS_UNIX) return null;
  return digits >= 13 ? { unix, fromMilliseconds: true } : { unix };
}

/**
 * "in 3 days" / "2 hours ago" — wording and pluralization come from
 * `Intl.RelativeTimeFormat`, but the unit cutoffs mirror Discord's
 * moment-style humanize thresholds: 45s→minute, 45min→hour, 22h→day
 * (so 23h renders "in 1 day", like Discord's "in a day"), 26d→month,
 * 320d→year. A positive delta is the future, a negative one the past.
 */
function formatRelative(unix: number): string {
  const deltaSec = unix - Date.now() / 1000;
  const abs = Math.abs(deltaSec);
  const sign = deltaSec < 0 ? -1 : 1;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });
  const at = (value: number, unit: Intl.RelativeTimeFormatUnit) =>
    rtf.format(sign * Math.max(1, Math.round(value)), unit);
  const minutes = abs / 60;
  const hours = abs / 3600;
  const days = abs / 86_400;
  if (abs < 45) return at(abs, "second");
  if (minutes < 45) return at(minutes, "minute");
  if (hours < 22) return at(hours, "hour");
  if (days < 26) return at(days, "day");
  if (days < 320) return at(days / 30, "month");
  return at(days / 365, "year");
}
