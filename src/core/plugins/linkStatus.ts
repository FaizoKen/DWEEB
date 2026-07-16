/**
 * Link-plugin setup probe — the live half of `setupUrl`.
 *
 * A link plugin's one quiet failure mode is a button posted before the server
 * is registered on the external service; the chip has always warned about it
 * *statically* because DWEEB had no way to check per-server state. A manifest
 * `statusUrl` closes that gap: a public, credential-less endpoint the service
 * exposes (`{"configured": true|false}` JSON with open CORS) that this module
 * probes for the connected server, so the chip can show a real
 * **Ready / Needs setup** state — plus the optional `role_count` the service
 * reports, so "ready" can say *how much* is set up ("2 linked roles").
 *
 * Strictly best-effort by design. Any failure — the service is down, CORS is
 * refused (e.g. inside a Discord Activity, whose CSP blocks external hosts),
 * the body doesn't parse — resolves to `"unknown"`, which renders exactly as
 * the pre-probe behavior. The probe never gates editing or sending.
 *
 * Results are cached per (probe URL) with a short TTL so chip re-renders and
 * repeated opens don't spam the service, and concurrent callers share one
 * in-flight fetch. A `fresh` probe bypasses both this cache and the browser's
 * HTTP cache — used when the admin returns from the service's dashboard, so a
 * just-created role link flips the chip immediately instead of after the TTL.
 */

import type { LinkPluginManifest } from "./linkManifest";
import { resolveGuildUrlTemplate } from "./linkManifest";

export type LinkPluginStatus = "ready" | "needs-setup" | "unknown";

export interface LinkPluginStatusResult {
  status: LinkPluginStatus;
  /** How many role links the service reports for the guild, when it says. */
  roleCount?: number;
}

const UNKNOWN: LinkPluginStatusResult = { status: "unknown" };

/** How long a resolved probe answer is trusted before re-fetching. */
const TTL_MS = 60_000;
/** Failures are retried sooner — the service may just have blipped. */
const FAILURE_TTL_MS = 20_000;
/** Bound the wait so a black-holed request can't hold the chip in limbo. */
const TIMEOUT_MS = 8_000;

interface CacheEntry {
  result: LinkPluginStatusResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<LinkPluginStatusResult>>();

/** Test seam: drop all cached/in-flight probe state. */
export function clearLinkStatusCache(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * The concrete probe URL for a guild, or `null` when the manifest has no
 * `statusUrl` (or the template still carries a non-`{server_id}` token).
 */
export function linkPluginStatusUrl(manifest: LinkPluginManifest, guildId: string): string | null {
  return manifest.statusUrl ? resolveGuildUrlTemplate(manifest.statusUrl, guildId) : null;
}

/** Strict parse of the probe body: `configured` must be a literal boolean;
 *  `role_count` is kept only when it's a sane non-negative integer. */
function parseProbeBody(body: unknown): LinkPluginStatusResult {
  if (!body || typeof body !== "object") return UNKNOWN;
  const record = body as Record<string, unknown>;
  if (record.configured !== true && record.configured !== false) return UNKNOWN;
  const rawCount = record.role_count;
  const roleCount =
    typeof rawCount === "number" && Number.isInteger(rawCount) && rawCount >= 0 && rawCount <= 1000
      ? rawCount
      : undefined;
  return {
    status: record.configured ? "ready" : "needs-setup",
    ...(roleCount !== undefined ? { roleCount } : {}),
  };
}

async function probe(url: string, fresh: boolean): Promise<LinkPluginStatusResult> {
  try {
    const response = await fetch(url, {
      // Public boolean only — never send cookies or auth to the service.
      credentials: "omit",
      // Normally let the browser honor the service's short Cache-Control; a
      // fresh probe (admin just came back from the dashboard) skips it so the
      // flip shows immediately.
      ...(fresh ? { cache: "no-store" as RequestCache } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return UNKNOWN;
    return parseProbeBody((await response.json()) as unknown);
  } catch {
    return UNKNOWN;
  }
}

/**
 * Resolve the setup status of `manifest` for `guildId`. Never rejects; every
 * failure mode is `"unknown"`. `fresh: true` bypasses the TTL and HTTP caches
 * (concurrent callers still share one in-flight fetch).
 */
export function fetchLinkPluginStatus(
  manifest: LinkPluginManifest,
  guildId: string,
  opts?: { fresh?: boolean },
): Promise<LinkPluginStatusResult> {
  const url = linkPluginStatusUrl(manifest, guildId);
  if (!url) return Promise.resolve(UNKNOWN);
  const fresh = opts?.fresh === true;

  if (!fresh) {
    const cached = cache.get(url);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.result);
  }

  const pending = inFlight.get(url);
  if (pending) return pending;

  const request = probe(url, fresh).then((result) => {
    inFlight.delete(url);
    cache.set(url, {
      result,
      expiresAt: Date.now() + (result.status === "unknown" ? FAILURE_TTL_MS : TTL_MS),
    });
    return result;
  });
  inFlight.set(url, request);
  return request;
}
