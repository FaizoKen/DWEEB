/**
 * Discord timestamp helpers, shared by the preview renderer and the toolbar's
 * timestamp picker so a `<t:unix:style>` token previews identically in both.
 *
 * Discord renders timestamps in the *viewer's* locale and timezone; we mirror
 * that with `Intl`, which keys off the runtime's locale/zone. The styles and
 * the order they're listed in match Discord's own picker.
 */

export type TimestampStyleCode = "t" | "T" | "d" | "D" | "f" | "F" | "R";

export interface TimestampStyle {
  /** The code that goes in `<t:unix:code>`. */
  code: TimestampStyleCode;
  /** Short label shown next to the live preview. */
  label: string;
}

/** Styles in the order Discord lists them in its picker. */
export const TIMESTAMP_STYLES: readonly TimestampStyle[] = [
  { code: "t", label: "Short time" },
  { code: "T", label: "Long time" },
  { code: "f", label: "Short date/time" },
  { code: "F", label: "Long date/time" },
  { code: "d", label: "Short date" },
  { code: "D", label: "Long date" },
  { code: "R", label: "Relative" },
];

/** Render a unix timestamp (seconds) the way Discord would, for the given style. */
export function formatTimestamp(unix: number, style: string): string {
  const d = new Date(unix * 1000);
  switch (style) {
    case "t":
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    case "T":
      return d.toLocaleTimeString();
    case "d":
      return d.toLocaleDateString();
    case "D":
      return d.toLocaleDateString([], { dateStyle: "long" });
    case "f":
      return d.toLocaleString([], { dateStyle: "long", timeStyle: "short" });
    case "F":
      return d.toLocaleString([], { dateStyle: "full", timeStyle: "short" });
    case "R":
      return formatRelative(unix);
    default:
      return d.toLocaleString();
  }
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
