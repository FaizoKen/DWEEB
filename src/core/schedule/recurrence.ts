/**
 * Scheduling is one-time only: a message posts once at a chosen instant, then
 * the schedule is done. (The proxy can express recurring rules too, but the UI
 * deliberately keeps it to a single "post later" for simplicity.)
 *
 * `formatInstant` formats in the schedule's stored timezone via
 * `Intl.DateTimeFormat`, so the list reads in the same zone it was set in.
 */

/** The only rule the UI creates. */
export type Recurrence = { kind: "once" };

/** The viewer's IANA timezone (e.g. `America/New_York`), or UTC as a fallback. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Format an absolute unix-seconds instant in a given timezone. */
export function formatInstant(unixSecs: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz,
      weekday: "short",
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
