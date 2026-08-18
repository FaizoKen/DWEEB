/**
 * Runtime capability check for the remote MCP endpoint.
 *
 * The endpoint is off by default and enabled per deployment (`MCP_ENABLED` on
 * the proxy), so the app cannot know at build time whether there is a connector
 * URL worth showing. It asks the proxy once, exactly as the feedback relay and
 * avatar uploads do.
 *
 * Gating the entry point on the answer matters more here than it looks: the
 * dialog's whole purpose is to hand someone a URL to paste into their AI
 * client. Offering that on a deployment where the URL answers 501 would send
 * them through a connector setup that cannot possibly work, and the failure
 * would look like their mistake.
 */

import { useEffect, useSyncExternalStore } from "react";
import { isProxyConfigured, PROXY_BASE_URL } from "@/core/guild/config";
import { proxyFetch } from "@/core/net/proxyFetch";

type Availability = "unknown" | "available" | "unavailable";

let availability: Availability = isProxyConfigured() ? "unknown" : "unavailable";
let inflight: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

function publish(next: Availability): void {
  if (availability === next) return;
  availability = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): boolean {
  return isProxyConfigured() && availability === "available";
}

/** Synchronous snapshot for non-React callers. */
export function isMcpConfigured(): boolean {
  return snapshot();
}

/**
 * The URL a remote MCP client connects to on this deployment.
 *
 * Derived from the configured proxy rather than hard-coded, so a self-hosted
 * build hands out its own address and never this project's. Empty when no proxy
 * is configured at all.
 */
export function mcpEndpointUrl(): string {
  return PROXY_BASE_URL ? `${PROXY_BASE_URL}/mcp` : "";
}

/**
 * Resolve the proxy's runtime capability once. Mounted entry points share the
 * request; a browser `online` event can force a retry.
 */
export function ensureMcpAvailability(force = false): Promise<boolean> {
  if (!isProxyConfigured()) {
    publish("unavailable");
    return Promise.resolve(false);
  }
  if (!force && availability !== "unknown") return Promise.resolve(snapshot());
  if (inflight) return inflight;

  inflight = proxyFetch("/api/capabilities")
    .then(async (response) => {
      const body = (await response.json().catch(() => null)) as { mcp?: unknown } | null;
      const enabled = response.ok && body?.mcp === true;
      publish(enabled ? "available" : "unavailable");
      return enabled;
    })
    .catch(() => {
      publish("unavailable");
      return false;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** React entry-point gate. The connector stays hidden until the server confirms
 *  it serves one. */
export function useMcpConfigured(): boolean {
  const available = useSyncExternalStore(subscribe, snapshot, () => false);
  useEffect(() => {
    void ensureMcpAvailability();
    const retry = () => void ensureMcpAvailability(true);
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, []);
  return available;
}
