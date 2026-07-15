/** Privacy-bounded product funnel events. No free-form or identifier fields. */

export type AnalyticsEvent =
  | "app_surface_ready"
  | "builder_ready"
  | "template_applied"
  | "send_dialog_opened"
  | "message_posted"
  | "message_scheduled";

export type AnalyticsParams = Record<string, string | number | boolean>;

const ALLOWED_PARAMS: Record<AnalyticsEvent, ReadonlySet<string>> = {
  app_surface_ready: new Set(["boot_ms", "surface"]),
  builder_ready: new Set(["boot_ms"]),
  template_applied: new Set(["template_id", "source"]),
  send_dialog_opened: new Set(["mode", "when"]),
  message_posted: new Set(["mode"]),
  message_scheduled: new Set(["recurrence"]),
};

/**
 * Queue an event through the privacy-gated gtag stub. Runtime filtering is a
 * second line of defence: each event has an explicit field allowlist, and only
 * short enum-like strings and finite numbers can leave. A future caller cannot
 * accidentally add a URL, token, message body or arbitrary identifier.
 */
export function trackAnalytics(event: AnalyticsEvent, params: AnalyticsParams = {}): void {
  if (typeof window === "undefined") return;
  const safe: AnalyticsParams = {};
  for (const [key, value] of Object.entries(params)) {
    if (!ALLOWED_PARAMS[event].has(key)) continue;
    if (typeof value === "string") {
      if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(value)) continue;
      safe[key] = value;
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) safe[key] = Math.round(value);
    } else {
      safe[key] = value;
    }
  }
  const analyticsWindow = window as Window & {
    gtag?: (command: "event", eventName: string, values: AnalyticsParams) => void;
  };
  analyticsWindow.gtag?.("event", event, safe);
}
