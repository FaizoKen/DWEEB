/**
 * Shared recurrence types + display helpers for scheduled posts.
 *
 * The shapes mirror the proxy's `schedule_rule.rs` exactly (the wire form is
 * `{ kind, time?, weekdays?, day? }`), so a value round-trips between the panel,
 * the API, and the worker without translation. Weekdays are 0=Sunday..6=Saturday
 * to match `Date.getDay()`.
 *
 * Formatting (next-run line, "Daily at 9:00 AM") is timezone-aware via
 * `Intl.DateTimeFormat`, so the preview reads in the same zone the schedule
 * fires in — not the viewer's local zone.
 */

export interface TimeOfDay {
  hour: number;
  minute: number;
}

export type Recurrence =
  | { kind: "once" }
  | { kind: "daily"; time: TimeOfDay }
  | { kind: "weekly"; time: TimeOfDay; weekdays: number[] }
  | { kind: "monthly"; time: TimeOfDay; day: number };

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** The viewer's IANA timezone (e.g. `America/New_York`), or UTC as a fallback. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Every IANA timezone the runtime knows, for the picker. `supportedValuesOf` is
 * widely available now; a small curated list is the fallback for old engines.
 * The browser's own zone is always present and floated to the front.
 */
export function allTimezones(): string[] {
  const browser = browserTimezone();
  let zones: string[];
  const supported = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  if (typeof supported === "function") {
    try {
      zones = supported("timeZone");
    } catch {
      zones = FALLBACK_TIMEZONES.slice();
    }
  } else {
    zones = FALLBACK_TIMEZONES.slice();
  }
  const set = new Set<string>(["UTC", browser, ...zones]);
  const rest = [...set].filter((z) => z !== browser && z !== "UTC").sort();
  return [browser, ...(browser === "UTC" ? [] : ["UTC"]), ...rest];
}

const FALLBACK_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Moscow",
  "Africa/Cairo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

/** "9:00 AM" from a `TimeOfDay`, in the viewer's locale. */
export function formatTime(t: TimeOfDay): string {
  const d = new Date(2000, 0, 1, t.hour, t.minute);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** A human one-liner for a recurrence rule, e.g. "Weekly on Mon, Wed · 9:00 AM". */
export function formatRecurrence(rec: Recurrence): string {
  switch (rec.kind) {
    case "once":
      return "One time";
    case "daily":
      return `Daily · ${formatTime(rec.time)}`;
    case "weekly": {
      const days = [...rec.weekdays]
        .sort((a, b) => a - b)
        .map((d) => WEEKDAY_LABELS[d] ?? "?")
        .join(", ");
      return `Weekly on ${days || "—"} · ${formatTime(rec.time)}`;
    }
    case "monthly":
      return `Monthly on the ${ordinal(rec.day)} · ${formatTime(rec.time)}`;
  }
}

/** Format an absolute unix-seconds instant in a given timezone. */
export function formatInstant(unixSecs: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz,
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(unixSecs * 1000));
  } catch {
    return new Date(unixSecs * 1000).toUTCString();
  }
}

/** Long weekday name, for accessible checkbox labels. */
export function weekdayLong(d: number): string {
  return WEEKDAY_LONG[d] ?? "";
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}
