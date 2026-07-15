/** Notify IndexNow after GitHub Pages has published the new sitemap. */

import { createHash } from "node:crypto";

const host = "dweeb.faizo.net";
const origin = `https://${host}`;
const key = "6f3a8c1d9e2b47a5b0c4d8e1f7a2b693";
const expectedCommit = process.env.GITHUB_SHA;
const FETCH_TIMEOUT_MS = 8_000;

let urls = [];
for (let attempt = 1; attempt <= 6; attempt++) {
  try {
    const nonce = Date.now();
    const headers = { "User-Agent": "DWEEB-IndexNow/1.0" };
    const [reportResponse, sitemapResponse] = await Promise.all([
      fetch(`${origin}/seo-report.json?deploy=${nonce}`, {
        cache: "no-store",
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }),
      fetch(`${origin}/sitemap.xml?deploy=${nonce}`, {
        cache: "no-store",
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }),
    ]);
    if (reportResponse.ok && sitemapResponse.ok) {
      const [report, xml] = await Promise.all([reportResponse.json(), sitemapResponse.text()]);
      const sitemapSha256 = createHash("sha256").update(xml).digest("hex");
      const currentCommit = !expectedCommit || report.buildCommit === expectedCommit;
      if (currentCommit && report.sitemapSha256 === sitemapSha256) {
        urls = [...xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
        if (urls.length) break;
      }
    }
  } catch {
    // A transient fetch/JSON error is the same as propagation lag: retry. The
    // final empty result below keeps the workflow step best-effort and visible.
  }
  if (attempt < 6) await new Promise((resolve) => setTimeout(resolve, 5_000));
}

if (!urls.length) {
  throw new Error("IndexNow: deployed report/sitemap did not reach the expected build in time");
}

const response = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({
    host,
    key,
    keyLocation: `${origin}/${key}.txt`,
    urlList: urls,
  }),
});

if (!response.ok) {
  throw new Error(`IndexNow rejected ${urls.length} URLs: HTTP ${response.status}`);
}
console.log(`[indexnow] submitted ${urls.length} deployed URLs (HTTP ${response.status})`);
