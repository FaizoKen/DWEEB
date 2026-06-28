/**
 * Embedded App SDK wrapper.
 *
 * Owns the single `DiscordSDK` instance and the URL-mapping setup that lets a
 * sandboxed Activity iframe reach our proxy at all. Inside Discord every request
 * must go through the client's proxy, so `patchUrlMappings` rewrites the proxy's
 * absolute URLs (HTTP **and** WebSocket) to a same-origin `/.proxy/<prefix>/…`
 * path that Discord forwards to the real host. The matching prefix is configured
 * once in the Developer Portal's URL Mappings (see `docs/activity.md`).
 *
 * Only the Activity entry imports this module, so the SDK never weighs down the
 * web app's bundle.
 */

import { DiscordSDK, patchUrlMappings } from "@discord/embedded-app-sdk";
import { DISCORD_CLIENT_ID, PROXY_BASE_URL } from "@/core/guild/config";
import { PROXY_MAPPING_PREFIX } from "./runtime";

let sdk: DiscordSDK | null = null;

/** The lazily-created SDK instance (one per page). */
export function getSdk(): DiscordSDK {
  if (!sdk) sdk = new DiscordSDK(DISCORD_CLIENT_ID);
  return sdk;
}

/** Host of the configured proxy, used as the URL-mapping target. "" when unset. */
function proxyHost(): string {
  try {
    return new URL(PROXY_BASE_URL).host;
  } catch {
    return "";
  }
}

/**
 * Route every call to the proxy (the absolute `PROXY_BASE_URL`, over HTTP and
 * WebSocket) through Discord's sandbox proxy. Must run before the first proxy
 * request. No-op when no proxy is configured.
 */
export function configureUrlMappings(): void {
  const host = proxyHost();
  if (!host) return;
  patchUrlMappings([{ prefix: PROXY_MAPPING_PREFIX, target: host }], {
    patchFetch: true,
    patchWebSocket: true,
    patchXhr: true,
  });
}
