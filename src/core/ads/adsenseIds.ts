/**
 * Google AdSense identifiers, parsed strictly.
 *
 * Both values are build-time configuration (`VITE_ADSENSE_CLIENT`,
 * `VITE_ADSENSE_SLOT`) and both end up somewhere a typo is expensive: the
 * client id is written into `ads.txt` and the production CSP is widened for the
 * ad hosts only when it is present, and a slot id Google doesn't recognise just
 * serves nothing. So anything not shaped like the real thing reads as "not
 * configured" and ads stay off — the same fail-closed stance as every other
 * optional integration (an unset Stripe key, an unset proxy).
 *
 * Pure and dependency-free on purpose: `vite.config.ts` imports it to decide
 * the CSP and emit `ads.txt`, so it can't touch `import.meta.env`.
 */

/** `ca-pub-` plus the 16-digit publisher number AdSense shows under Account. */
const CLIENT = /^ca-pub-(\d{16})$/;
/** An ad unit's numeric `data-ad-slot` (10 digits today; allow some range). */
const SLOT = /^\d{6,20}$/;

/** The AdSense client (`ca-pub-…`) or `""` when absent or malformed. */
export function parseAdsenseClient(raw: string | undefined | null): string {
  const value = (raw ?? "").trim();
  return CLIENT.test(value) ? value : "";
}

/** The ad unit slot id or `""` when absent or malformed. */
export function parseAdsenseSlot(raw: string | undefined | null): string {
  const value = (raw ?? "").trim();
  return SLOT.test(value) ? value : "";
}

/**
 * The `ads.txt` record authorising Google to sell this site's inventory.
 * `f08c47fec0942fa0` is Google's published certification-authority id; the
 * account id is the client without its `ca-` prefix. Empty for a client that
 * didn't parse.
 */
export function adsTxt(client: string): string {
  const match = CLIENT.exec(client);
  if (!match) return "";
  return `google.com, pub-${match[1]}, DIRECT, f08c47fec0942fa0\n`;
}

/**
 * Hosts the AdSense tag needs beyond the base policy — added to the production
 * CSP only when a client is configured, so a build without ads keeps the tight
 * policy it always had. `img-src`/`connect-src` are already `https:`.
 *
 * - `script-src`: the tag and its implementation (`pagead2`), Google's consent
 *   message for EEA/UK visitors (`fundingchoicesmessages`), the ad-identity
 *   integrator (`adservice`), and the anti-fraud script (`adtrafficquality`).
 * - `frame-src`: the ad itself renders in a cross-origin iframe (safeframe on
 *   `*.googlesyndication.com`, or `googleads.g.doubleclick.net`); our CSP does
 *   not reach inside it.
 *
 * Google documents only a nonce + `strict-dynamic` policy as supported, which a
 * static host with a `<meta>` CSP can't issue; an allowlist that covers the
 * tag's own hosts is the workable equivalent. A host Google adds later is
 * refused rather than run — fewer fills, never a broken page.
 */
export const ADSENSE_CSP = {
  script: [
    "https://pagead2.googlesyndication.com",
    "https://tpc.googlesyndication.com",
    "https://fundingchoicesmessages.google.com",
    "https://adservice.google.com",
    "https://*.adtrafficquality.google",
  ],
  frame: [
    "https://*.googlesyndication.com",
    "https://*.doubleclick.net",
    "https://*.adtrafficquality.google",
    "https://fundingchoicesmessages.google.com",
    "https://www.google.com",
  ],
} as const;
