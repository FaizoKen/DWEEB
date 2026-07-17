/**
 * Attribution bridge from pre-rendered search pages into the SPA.
 *
 * Internal campaign parameters such as `utm_source` would overwrite genuine
 * organic acquisition in analytics. Discovery-page CTAs instead carry a small
 * first-party `entry=<type>:<id>` token. The builder records one custom event,
 * then removes only that token from the address bar (leaving `template`, OAuth,
 * share hashes, and every unrelated parameter untouched).
 */

export interface SeoEntry {
  sourceType: "landing" | "template" | "feature" | "guide";
  sourceId: string;
}

const ENTRY_PATTERN = /^(landing|template|feature|guide):([a-z0-9][a-z0-9-]{0,79})$/;
const CTA_STORAGE_KEY = "dweeb:seo-cta";
const CTA_MAX_AGE_MS = 10 * 60 * 1000;
const CTA_LOCATIONS = new Set(["hero", "body", "nav", "footer"]);

/**
 * Exact public discovery ids. `entry` lives in a URL and is therefore
 * attacker-controlled; a shape-only check would let arbitrary strings or
 * Discord snowflakes reach analytics. The generated-site audit verifies every
 * shipped CTA against this list so content additions cannot silently drift.
 */
const ENTRY_IDS: Record<SeoEntry["sourceType"], ReadonlySet<string>> = {
  landing: new Set(["discord-webhook-builder", "discord-embed-builder"]),
  template: new Set([
    "index",
    "discord-components-v2-example",
    "discord-welcome-message",
    "discord-server-rules-template",
    "discord-channel-guide-template",
    "discord-verification-message",
    "discord-topgg-vote-rewards",
    "discord-genshin-verification",
    "discord-youtube-subscriber-role",
    "discord-twitch-follower-role",
    "discord-steam-verification",
    "discord-referral-code-role",
    "discord-roblox-verification",
    "discord-tiktok-creator-role",
    "discord-form-role-quiz",
    "discord-kick-follower-role",
    "discord-birthday-role",
    "discord-osu-verification",
    "discord-bluesky-role",
    "discord-github-contributor-role",
    "discord-announcement-template",
    "discord-changelog-template",
    "discord-introductions-template",
    "discord-reaction-roles-menu",
    "discord-server-directory-template",
    "discord-suggestion-box-template",
    "discord-staff-application-template",
    "discord-event-announcement-template",
    "discord-poll-template",
    "discord-giveaway-template",
    "discord-help-center-template",
    "discord-faq-template",
    "discord-product-card-template",
    "discord-pricing-table-template",
    "discord-social-links-template",
    "discord-member-spotlight-template",
  ]),
  feature: new Set([
    "index",
    "discord-self-roles",
    "discord-ticket-bot",
    "discord-auto-reply",
    "discord-form-bot",
    "discord-giveaway-bot",
    "discord-select-menu",
    "discord-latency-check",
    "schedule-discord-messages",
    "discord-webhook-manager",
    "ai-discord-message-writer",
  ]),
  guide: new Set([
    "index",
    "discord-components-v2",
    "how-to-create-a-discord-webhook",
    "discord-embed-to-components-v2",
    "discord-webhook-security",
    "edit-discord-webhook-message",
    "discord-text-formatting",
    "discord-timestamp-format",
    "discord-webhook-limits",
    "discord-webhook-name-avatar",
  ]),
};

export function parseSeoEntry(search: string): SeoEntry | null {
  const raw = new URLSearchParams(search).get("entry");
  const match = raw ? ENTRY_PATTERN.exec(raw) : null;
  if (!match) return null;
  const sourceType = match[1] as SeoEntry["sourceType"];
  const sourceId = match[2]!;
  if (!ENTRY_IDS[sourceType].has(sourceId)) return null;
  return {
    sourceType,
    sourceId,
  };
}

/** A history-safe relative URL with only the attribution token removed. */
export function stripSeoEntry(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("entry");
  return url.pathname + url.search + url.hash;
}

function consumeCtaLocation(entry: SeoEntry): string | null {
  try {
    const raw = window.sessionStorage.getItem(CTA_STORAGE_KEY);
    window.sessionStorage.removeItem(CTA_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as { entry?: unknown; location?: unknown; at?: unknown };
    if (
      value.entry !== `${entry.sourceType}:${entry.sourceId}` ||
      typeof value.location !== "string" ||
      !CTA_LOCATIONS.has(value.location) ||
      typeof value.at !== "number" ||
      value.at > Date.now() + 60_000 ||
      Date.now() - value.at > CTA_MAX_AGE_MS
    ) {
      return null;
    }
    return value.location;
  } catch {
    return null;
  }
}

/**
 * Queue the SEO → builder conversion in the privacy-gated gtag stub installed
 * by `/gtag-init.js`. When DNT/GPC is enabled that stub intentionally doesn't
 * exist, so this becomes a quiet no-op while the URL is still cleaned up.
 */
export function captureSeoAcquisition(): void {
  if (typeof window === "undefined") return;
  const entry = parseSeoEntry(window.location.search);
  if (!entry) return;

  const analyticsWindow = window as Window & {
    gtag?: (command: "event", eventName: string, params: Record<string, string>) => void;
  };
  const ctaLocation = consumeCtaLocation(entry);
  if (ctaLocation) {
    analyticsWindow.gtag?.("event", "seo_cta_click", {
      content_type: entry.sourceType,
      content_id: entry.sourceId,
      cta_location: ctaLocation,
    });
  }
  analyticsWindow.gtag?.("event", "seo_builder_open", {
    source_type: entry.sourceType,
    source_id: entry.sourceId,
  });

  window.history.replaceState(null, "", stripSeoEntry(window.location.href));
}
