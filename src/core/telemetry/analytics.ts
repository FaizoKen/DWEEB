/** Privacy-bounded product funnel events. No free-form or identifier fields. */

export type AnalyticsEvent =
  | "app_surface_ready"
  | "builder_ready"
  | "seo_builder_ready"
  | "template_applied"
  | "send_dialog_opened"
  | "message_posted"
  | "message_scheduled"
  | "code_exported"
  | "pricing_opened"
  | "checkout_started"
  | "checkout_completed"
  | "ad_slot";

export type AnalyticsParams = Record<string, string | number | boolean>;

/**
 * Never name a field `source`, `medium`, `campaign`, `term` or `content`. GA4
 * reads those five on *any* event as a manual campaign override, so
 * `template_applied { source: "gallery" }` re-attributed the whole session to a
 * traffic source called "gallery": over the 90 days to 2026-09-17, 565 of 3,279
 * sessions (17%) were filed under `gallery / (not set)` or `seo / (not set)` —
 * GA's "Unassigned" channel — with the search engine or AI assistant that really
 * sent them overwritten. `trackAnalytics` refuses the five names outright, and
 * `analytics.test.ts` pins that no allowlist can reintroduce one.
 */
export const RESERVED_CAMPAIGN_PARAMS: ReadonlySet<string> = new Set([
  "source",
  "medium",
  "campaign",
  "term",
  "content",
]);

const ALLOWED_PARAMS: Record<AnalyticsEvent, ReadonlySet<string>> = {
  app_surface_ready: new Set(["boot_ms", "surface"]),
  builder_ready: new Set(["boot_ms"]),
  seo_builder_ready: new Set(["source_type", "source_id"]),
  template_applied: new Set(["template_id", "applied_from"]),
  send_dialog_opened: new Set(["mode", "when"]),
  message_posted: new Set(["mode"]),
  message_scheduled: new Set(["recurrence"]),
  code_exported: new Set(["language", "action"]),
  // The upgrade funnel. `opened_from` is the prompt that opened the plans
  // (`core/plan/upgradePrompt.ts`) and rides every step, so a purchase traces
  // back to the limit that sold it. `tier` and `interval` are enums.
  pricing_opened: new Set(["opened_from"]),
  checkout_started: new Set(["opened_from", "tier", "interval"]),
  checkout_completed: new Set(["opened_from", "tier", "interval"]),
  // How the send receipt's one ad attempt ended (`features/ads/SendAd.tsx`):
  // filled / unfilled / blocked / timeout / no_room / ad_free — an enum, so the
  // fill rate and the ad-blocked share can be read without anything about the
  // ad, the message or the server leaving the page.
  ad_slot: new Set(["result"]),
};

/** Exposed for the test that keeps every allowlist clear of the reserved names. */
export const ALLOWED_ANALYTICS_PARAMS: Readonly<Record<AnalyticsEvent, ReadonlySet<string>>> =
  ALLOWED_PARAMS;

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
    if (!ALLOWED_PARAMS[event].has(key) || RESERVED_CAMPAIGN_PARAMS.has(key)) continue;
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
