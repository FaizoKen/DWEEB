/**
 * Link-plugin setup probe — the live half of `setupUrl`.
 *
 * A link plugin's one quiet failure mode is a button posted before the server
 * is registered on the external service; the chip has always warned about it
 * *statically* because DWEEB had no way to check per-server state. A manifest
 * `statusUrl` closes that gap: a public, credential-less endpoint the service
 * exposes (`{"configured": true|false}` JSON with open CORS) that this module
 * probes for the connected server, so the chip can show a real
 * **Ready / Needs setup** state.
 *
 * Strictly best-effort by design. Any failure — the service is down, CORS is
 * refused (e.g. inside a Discord Activity, whose CSP blocks external hosts),
 * the body doesn't parse — resolves to `"unknown"`, which renders exactly as
 * the pre-probe behavior. The probe never gates editing or sending.
 *
 * Results are cached per (probe URL) with a short TTL so chip re-renders and
 * repeated opens don't spam the service, and concurrent callers share one
 * in-flight fetch.
 */

import type { LinkPluginManifest } from "./linkManifest";

export type LinkPluginStatus = "ready" | "needs-setup" | "unknown";

/** How long a resolved probe answer is trusted before re-fetching. */
const TTL_MS = 60_000;
/** Failures are retried sooner — the service may just have blipped. */
const FAILURE_TTL_MS = 20_000;
/** Bound the wait so a black-holed request can't hold the chip in limbo. */
const TIMEOUT_MS = 8_000;

interface CacheEntry {
  status: LinkPluginStatus;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<LinkPluginStatus>>();

/** Test seam: drop all cached/in-flight probe state. */
export function clearLinkStatusCache(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * The concrete probe URL for a guild, or `null` when the manifest has no
 * `statusUrl`. Only `{server_id}` is substituted — it's the one core token a
 * per-server probe can need; any other token left in the template makes the
 * URL unusable and disables the probe rather than sending a literal `{token}`.
 */
export function linkPluginStatusUrl(manifest: LinkPluginManifest, guildId: string): string | null {
  const template = manifest.statusUrl;
  if (!template) return null;
  const url = template.replaceAll("{server_id}", encodeURIComponent(guildId));
  return url.includes("{") ? null : url;
}

/** Strict parse of the probe body: `configured` must be a literal boolean. */
function parseProbeBody(body: unknown): LinkPluginStatus {
  if (!body || typeof body !== "object") return "unknown";
  const configured = (body as Record<string, unknown>).configured;
  if (configured === true) return "ready";
  if (configured === false) return "needs-setup";
  return "unknown";
}

async function probe(url: string): Promise<LinkPluginStatus> {
  try {
    const response = await fetch(url, {
      // Public boolean only — never send cookies or auth to the service.
      credentials: "omit",
      // The service sets its own short Cache-Control; let the browser honor it.
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return "unknown";
    return parseProbeBody((await response.json()) as unknown);
  } catch {
    return "unknown";
  }
}

/**
 * Resolve the setup status of `manifest` for `guildId`. Never rejects; every
 * failure mode is `"unknown"`.
 */
export function fetchLinkPluginStatus(
  manifest: LinkPluginManifest,
  guildId: string,
): Promise<LinkPluginStatus> {
  const url = linkPluginStatusUrl(manifest, guildId);
  if (!url) return Promise.resolve("unknown");

  const cached = cache.get(url);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.status);

  const pending = inFlight.get(url);
  if (pending) return pending;

  const request = probe(url).then((status) => {
    inFlight.delete(url);
    cache.set(url, {
      status,
      expiresAt: Date.now() + (status === "unknown" ? FAILURE_TTL_MS : TTL_MS),
    });
    return status;
  });
  inFlight.set(url, request);
  return request;
}
