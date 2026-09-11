/** Audit linked downloads and navigation against the final static artifact. */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { TEMPLATES } from "@/data/presets";
import { decodeJson, encodeJson } from "@/core/serialization/encode";
import { resolveSeo, SITE } from "./content";
import { createHash } from "node:crypto";
import { DEFAULT_MEDIA } from "@/core/media/defaultMedia";

function decodeHtml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export async function auditDiscoveryArtifacts(
  dist: string,
  pageUrls: readonly string[],
): Promise<string[]> {
  const errors: string[] = [];
  const mediaManifest = JSON.parse(
    await readFile(new URL("./manifests/preview-media.json", import.meta.url), "utf8"),
  ) as Record<string, { sourceSha256: string; previewSha256: string }>;
  for (const url of Object.values(DEFAULT_MEDIA)) {
    const path = new URL(url).pathname;
    try {
      const original = await readFile(join(dist, path));
      const preview = await readFile(join(dist, path.replace(/\.jpg$/, ".webp")));
      const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
      if (
        hash(original) !== mediaManifest[path]?.sourceSha256 ||
        hash(preview) !== mediaManifest[path]?.previewSha256 ||
        preview.length >= original.length
      ) {
        errors.push(
          `${path}: preview media is stale or exceeds the original; run scripts/gen-preview-media.ts`,
        );
      }
    } catch {
      errors.push(`${path}: missing original or WebP preview`);
    }
  }
  const documents = new Map<string, string>();
  const fileExists = async (path: string) => {
    try {
      return (await stat(join(dist, path))).isFile();
    } catch {
      return false;
    }
  };
  for (const url of pageUrls) {
    const path = new URL(url).pathname;
    const file = ["/privacy", "/terms"].includes(path) ? `${path}.html` : `${path}index.html`;
    try {
      documents.set(path, await readFile(join(dist, file), "utf8"));
    } catch {
      /* Main audit reports it. */
    }
  }

  const assetLinks = new Set<string>();
  const inspectLink = (href: string, from: string) => {
    const url = new URL(href, from);
    if (url.origin !== SITE.origin) return;
    if (/\.[a-z0-9]+$/i.test(url.pathname)) {
      assetLinks.add(url.pathname);
      return;
    }
    if (!documents.has(url.pathname)) {
      errors.push(`${from}: discovery link has no canonical page (${href})`);
      return;
    }
    // Root fragments are application state; article fragments are real targets.
    if (!url.hash || url.pathname === "/") return;
    const id = decodeURIComponent(url.hash.slice(1).split(":~:text=")[0]!);
    if (!id) return;
    const ids = [...documents.get(url.pathname)!.matchAll(/\sid="([^"]+)"/g)].map((match) =>
      decodeHtml(match[1]!),
    );
    if (!ids.includes(id)) errors.push(`${from}: missing section target (${href})`);
  };
  for (const [path, html] of documents) {
    for (const match of html.matchAll(/<a\s+[^>]*href="([^"]+)"/g)) {
      inspectLink(decodeHtml(match[1]!), `${SITE.origin}${path}`);
    }
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!);
    if (new Set(ids).size !== ids.length) errors.push(`${path}: duplicate HTML IDs`);
  }

  const reference = await readFile(join(dist, "llms.txt"), "utf8");
  if (!reference.startsWith("# DWEEB\n") || !reference.includes("## Guides")) {
    errors.push("llms.txt: missing product identity or guide directory");
  }
  for (const match of reference.matchAll(/https:\/\/dweeb\.faizo\.net[^\s)]+/g)) {
    inspectLink(match[0], `${SITE.origin}/llms.txt`);
  }
  for (const path of assetLinks) {
    if (!(await fileExists(path))) errors.push(`Missing linked discovery asset: ${path}`);
  }
  const robots = await readFile(join(dist, "robots.txt"), "utf8");
  if (!robots.includes(`Sitemap: ${SITE.origin}/sitemap.xml`)) {
    errors.push("robots.txt: canonical sitemap is not advertised");
  }

  for (const template of TEMPLATES) {
    const seo = resolveSeo(template);
    const path = `${seo.path}message.json`;
    try {
      const json = (await readFile(join(dist, path), "utf8")).trim();
      const html = documents.get(seo.path) ?? "";
      const inline = /<code data-template-json>([\s\S]*?)<\/code>/.exec(html)?.[1];
      if (!inline || decodeHtml(inline) !== json || json !== encodeJson(template.message)) {
        errors.push(`${path}: download, visible example and editor export disagree`);
      }
      const parsed = JSON.parse(json) as { flags?: number };
      if (!decodeJson(json).ok || !((parsed.flags ?? 0) & 32768) || /"_id"\s*:/.test(json)) {
        errors.push(`${path}: not an importable Components V2 payload without editor IDs`);
      }
    } catch (error) {
      errors.push(`${path}: unreadable template JSON (${String(error)})`);
    }
  }

  const fallback = await readFile(join(dist, "404.html"), "utf8");
  if (
    !/<meta\s+name="robots"\s+content="noindex, follow"/i.test(fallback) ||
    /rel="canonical"|application\/ld\+json/.test(fallback)
  ) {
    errors.push(
      "404.html: fallback must be noindex and carry no canonical or structured-data claims",
    );
  }
  const executableScripts = (html: string) =>
    [...html.matchAll(/<script(?![^>]*application\/ld\+json)[^>]*>[\s\S]*?<\/script>/g)].map(
      (match) => match[0],
    );
  if (
    JSON.stringify(executableScripts(fallback)) !==
    JSON.stringify(executableScripts(documents.get("/") ?? ""))
  ) {
    errors.push("404.html: short-link bootstrap scripts differ from the app shell");
  }
  return errors;
}
