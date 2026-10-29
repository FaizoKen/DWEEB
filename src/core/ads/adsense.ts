/**
 * The AdSense tag, loaded on demand.
 *
 * Nothing here runs at boot: the tag is requested the first time a send
 * receipt decides to carry an ad, so a visitor who never sends — and every
 * Lighthouse run, every crawler — never downloads a byte of it. Its outcome is
 * remembered for the page: a tag an ad blocker refused stays refused, and the
 * receipt then simply has no ad slot rather than an empty box or a plea.
 *
 * Ads are requested **non-personalized** (`requestNonPersonalizedAds`), and
 * `gtag-init.js` already starts Google's consent state with every advertising
 * purpose denied, so AdSense serves contextual ads without ad cookies — the
 * privacy policy's "no cross-site tracking" stays true.
 *
 * Nothing here may throw or reject: an escaping error lands in our own crash
 * traps and pages, over an ad.
 */

import { ADSENSE_CLIENT } from "./config";

/** How long the tag may take before the receipt gives up on it. */
const LOAD_TIMEOUT_MS = 8_000;

type AdsByGoogle = unknown[] & { requestNonPersonalizedAds?: number };

let loading: Promise<boolean> | null = null;
let failed = false;

/** True once the tag failed to load on this page (blocked, offline, timed out). */
export function adScriptFailed(): boolean {
  return failed;
}

/** Load the tag once per page. Resolves `true` when it ran, `false` when it was
 *  refused or never arrived; never rejects. */
export function loadAdSense(): Promise<boolean> {
  if (loading) return loading;
  loading = new Promise<boolean>((resolve) => {
    if (!ADSENSE_CLIENT || typeof document === "undefined") {
      resolve(false);
      return;
    }
    const settle = (ok: boolean) => {
      window.clearTimeout(timer);
      if (!ok) failed = true;
      resolve(ok);
    };
    const timer = window.setTimeout(() => settle(false), LOAD_TIMEOUT_MS);
    try {
      const w = window as Window & { adsbygoogle?: AdsByGoogle };
      const queue: AdsByGoogle = w.adsbygoogle ?? [];
      queue.requestNonPersonalizedAds = 1;
      w.adsbygoogle = queue;

      const script = document.createElement("script");
      script.async = true;
      script.crossOrigin = "anonymous";
      script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(ADSENSE_CLIENT)}`;
      script.addEventListener("load", () => settle(true), { once: true });
      script.addEventListener("error", () => settle(false), { once: true });
      document.head.appendChild(script);
    } catch {
      settle(false);
    }
  });
  return loading;
}

/**
 * Ask the tag to fill the next empty `ins.adsbygoogle` on the page. Call it only
 * once that element is attached and laid out (AdSense measures it), and only
 * once per element — a second push for the same slot throws a `TagError`, as
 * does a zero-width one. Those throws land here, not in the crash traps.
 */
export function requestAd(): boolean {
  try {
    const w = window as Window & { adsbygoogle?: AdsByGoogle };
    (w.adsbygoogle ??= []).push({});
    return true;
  } catch {
    return false;
  }
}

/** Test seam: forget the page's load outcome. */
export function resetAdSenseForTests(): void {
  loading = null;
  failed = false;
}
