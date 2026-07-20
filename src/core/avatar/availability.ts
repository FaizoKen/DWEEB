/**
 * Runtime capability check for the optional avatar-upload store.
 *
 * Mirrors `core/feedback/availability.ts`. The builder must not show an upload
 * control that would 501: a deployment can run with `AVATAR_UPLOADS_ENABLED`
 * off (or with no proxy at all), and in that case the avatar field degrades to
 * exactly what it was before — paste a URL.
 */

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

/** Synchronous snapshot for non-React guards. */
export function isAvatarUploadConfigured(): boolean {
  return snapshot();
}

/** Resolve the proxy's capability once; concurrent callers share the request. */
export function ensureAvatarUploadAvailability(force = false): Promise<boolean> {
  if (!isProxyConfigured()) {
    publish("unavailable");
    return Promise.resolve(false);
  }
  if (!force && availability !== "unknown") return Promise.resolve(snapshot());
  if (inflight) return inflight;

  inflight = proxyFetch("/api/capabilities")
    .then(async (response) => {
      const body = (await response.json().catch(() => null)) as {
        avatarUploads?: unknown;
      } | null;
      const enabled = response.ok && body?.avatarUploads === true;
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

/** React gate — the upload affordance stays hidden until the server confirms it. */
export function useAvatarUploadConfigured(): boolean {
  const available = useSyncExternalStore(subscribe, snapshot, () => false);
  useEffect(() => {
    void ensureAvatarUploadAvailability();
    const retry = () => void ensureAvatarUploadAvailability(true);
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, []);
  return available;
}
