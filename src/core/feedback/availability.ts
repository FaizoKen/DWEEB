/** Runtime capability check for the optional server-side feedback relay. */

import { useEffect, useSyncExternalStore } from "react";
import { isProxyConfigured } from "@/core/guild/config";
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

/** Synchronous snapshot for non-React guards such as submission. */
export function isFeedbackConfigured(): boolean {
  return snapshot();
}

/**
 * Resolve the proxy's runtime capability once. Multiple mounted entry points
 * share the same request; a later browser `online` event may force a retry.
 */
export function ensureFeedbackAvailability(force = false): Promise<boolean> {
  if (!isProxyConfigured()) {
    publish("unavailable");
    return Promise.resolve(false);
  }
  if (!force && availability !== "unknown") return Promise.resolve(snapshot());
  if (inflight) return inflight;

  inflight = proxyFetch("/api/capabilities")
    .then(async (response) => {
      const body = (await response.json().catch(() => null)) as { feedback?: unknown } | null;
      const enabled = response.ok && body?.feedback === true;
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

/** React entry-point gate. Feedback stays hidden until the server confirms it. */
export function useFeedbackConfigured(): boolean {
  const available = useSyncExternalStore(subscribe, snapshot, () => false);
  useEffect(() => {
    void ensureFeedbackAvailability();
    const retry = () => void ensureFeedbackAvailability(true);
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, []);
  return available;
}
