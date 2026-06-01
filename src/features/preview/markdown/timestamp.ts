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
 * "in 3 days" / "2 hours ago" — picks the coarsest sensible unit and leaves the
 * wording and pluralization to `Intl.RelativeTimeFormat`. A positive delta is
 * the future ("in …"), a negative one the past ("… ago").
 */
function formatRelative(unix: number): string {
  const deltaSec = unix - Date.now() / 1000;
  const abs = Math.abs(deltaSec);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });
  const at = (value: number, unit: Intl.RelativeTimeFormatUnit) =>
    rtf.format(Math.round(value), unit);
  if (abs < 60) return at(deltaSec, "second");
  if (abs < 3600) return at(deltaSec / 60, "minute");
  if (abs < 86_400) return at(deltaSec / 3600, "hour");
  if (abs < 2_592_000) return at(deltaSec / 86_400, "day");
  if (abs < 31_536_000) return at(deltaSec / 2_592_000, "month");
  return at(deltaSec / 31_536_000, "year");
}
