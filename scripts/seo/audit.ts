/**
 * Post-generation SEO contract. Audits the exact HTML shipped in `dist/` and
 * fails the build on crawl, metadata, schema, linking or social-card defects.
 */

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSeoEntry } from "../../src/core/seo/acquisition";
import { readFeatureIntent } from "../../src/app/featureIntent";
import { TEMPLATES } from "../../src/data/presets";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DIST = join(ROOT, "dist");
const ORIGIN = "https://dweeb.faizo.net";
const TODAY = new Date().toISOString().slice(0, 10);
const TEMPLATE_IDS = new Set(TEMPLATES.map((template) => template.id));
const TEMPLATE_BY_ID = new Map(TEMPLATES.map((template) => [template.id, template]));

interface PageAudit {
  url: string;
  file: string;
  title: string;
  description: string;
  h1: string;
  words: number;
  jsonLdBlocks: number;
  internalLinks: string[];
}

interface SitemapEntry {
  url: string;
  lastmod: string;
  images: string[];
}

const errors: string[] = [];
const warnings: string[] = [];

function first(html: string, pattern: RegExp): string {
  return pattern.exec(html)?.[1]?.trim() ?? "";
}

function decode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function pageFile(url: string): string {
  const pathname = new URL(url).pathname;
  if (pathname === "/") return join(DIST, "index.html");
  if (pathname === "/privacy" || pathname === "/terms") {
    return join(DIST, `${pathname.slice(1)}.html`);
  }
  return join(DIST, pathname.slice(1), "index.html");
}

function normalizedInternalPath(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href, ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== ORIGIN) return null;
  if (url.pathname.startsWith("/s/")) return null;
  if (/\.[a-z0-9]{2,5}$/i.test(url.pathname)) return null;
  return url.pathname === "/" || ["/privacy", "/terms"].includes(url.pathname)
    ? url.pathname
    : `${url.pathname.replace(/\/+$/, "")}/`;
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Schema properties Google validates as a *datetime* rather than a plain date:
 * a bare "YYYY-MM-DD" is rejected twice over, as an invalid datetime value AND
 * as a missing timezone (Search Console, 2026-07-20). Deliberately narrow —
 * `datePublished`/`dateModified` are Date-typed, are legitimately date-only
 * here, and are cross-checked against sitemap lastmod above.
 */
const DATETIME_PROPERTIES = new Set(["uploadDate"]);

function validDateTime(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/** Report any datetime-typed property in a JSON-LD tree that is not a zoned ISO 8601 datetime. */
function auditJsonLdDates(node: unknown, label: string): void {
  if (Array.isArray(node)) {
    for (const item of node) auditJsonLdDates(item, label);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (DATETIME_PROPERTIES.has(key)) {
      if (typeof value !== "string" || !validDateTime(value)) {
        errors.push(
          `${label}: JSON-LD "${key}" must be an ISO 8601 datetime with a timezone offset (got ${JSON.stringify(value)})`,
        );
      }
      continue;
    }
    auditJsonLdDates(value, label);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function assertPng(path: string, label: string): Promise<void> {
  if (!(await exists(path))) {
    errors.push(`${label}: missing image ${path}`);
    return;
  }
  const bytes = await readFile(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const png = view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a;
  if (!png) {
    errors.push(`${label}: social image is not a PNG`);
    return;
  }
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width !== 1200 || height !== 630) {
    errors.push(`${label}: social image is ${width}×${height}; expected 1200×630`);
  }
}

async function htmlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return htmlFiles(path);
      return entry.isFile() && entry.name.endsWith(".html") ? [path] : [];
    }),
  );
  return nested.flat();
}

function outputPath(file: string): string {
  const relative = file.slice(DIST.length).replaceAll("\\", "/");
  if (relative === "/index.html") return "/";
  if (relative === "/privacy.html" || relative === "/terms.html") {
    return relative.slice(0, -".html".length);
  }
  return relative.replace(/\/index\.html$/, "/");
}

async function main(): Promise<void> {
  const sitemap = await readFile(join(DIST, "sitemap.xml"), "utf8");
  const sitemapEntries: SitemapEntry[] = [...sitemap.matchAll(/<url>([\s\S]*?)<\/url>/g)].map(
    (match) => {
      const block = match[1]!;
      return {
        url: decode(first(block, /<loc>([^<]+)<\/loc>/i)),
        lastmod: first(block, /<lastmod>([^<]+)<\/lastmod>/i),
        images: [...block.matchAll(/<image:loc>([^<]+)<\/image:loc>/gi)].map((image) =>
          decode(image[1]!),
        ),
      };
    },
  );
  if (!sitemapEntries.length) errors.push("sitemap.xml contains no URL entries");
  if (new Set(sitemapEntries.map((entry) => entry.url)).size !== sitemapEntries.length) {
    errors.push("sitemap.xml contains duplicate page URLs");
  }
  for (const entry of sitemapEntries) {
    let url: URL;
    try {
      url = new URL(entry.url);
    } catch {
      errors.push(`sitemap.xml contains invalid URL ${entry.url}`);
      continue;
    }
    if (url.origin !== ORIGIN || url.protocol !== "https:") {
      errors.push(`${entry.url}: sitemap URL must use the canonical HTTPS origin ${ORIGIN}`);
    }
  }

  // A collection page changes when a child is added or materially revised.
  // Catch the common stale-lastmod failure without pretending that an old but
  // genuinely unchanged article needs an artificial freshness date.
  for (const hub of ["/templates/", "/features/", "/guides/"]) {
    const hubEntry = sitemapEntries.find((entry) => new URL(entry.url).pathname === hub);
    const newestChild = sitemapEntries
      .filter((entry) => {
        const path = new URL(entry.url).pathname;
        return path.startsWith(hub) && path !== hub;
      })
      .reduce((latest, entry) => (entry.lastmod > latest ? entry.lastmod : latest), "");
    if (hubEntry && newestChild && hubEntry.lastmod < newestChild) {
      errors.push(
        `${hubEntry.url}: stale lastmod ${hubEntry.lastmod}; newest child is ${newestChild}`,
      );
    }
  }

  const indexablePaths = new Set(sitemapEntries.map((entry) => new URL(entry.url).pathname));
  const discoveredHtml = await htmlFiles(DIST);
  for (const file of discoveredHtml) {
    const path = outputPath(file);
    const html = await readFile(file, "utf8");
    const robots = first(html, /<meta\s+name="robots"\s+content="([^"]*)"\s*\/?\s*>/i);
    const noindex = /(?:^|[,\s])noindex(?:[,\s]|$)/i.test(robots);
    if (indexablePaths.has(path) && noindex) {
      errors.push(`${path}: sitemap page is accidentally noindex`);
    } else if (!indexablePaths.has(path) && !noindex) {
      errors.push(`${path}: indexable HTML output is orphaned from sitemap.xml`);
    }
  }
  const pages: PageAudit[] = [];
  const titles = new Map<string, string>();
  const canonicals = new Map<string, string>();

  for (const entry of sitemapEntries) {
    if (!validDate(entry.lastmod) || entry.lastmod > TODAY) {
      errors.push(`${entry.url}: invalid or future sitemap lastmod ${entry.lastmod}`);
    }
    const file = pageFile(entry.url);
    if (!(await exists(file))) {
      errors.push(`${entry.url}: sitemap target missing at ${file}`);
      continue;
    }
    const html = await readFile(file, "utf8");
    const title = decode(first(html, /<title>([\s\S]*?)<\/title>/i));
    const description = decode(
      first(html, /<meta\s+name="description"\s+content="([^"]*)"\s*\/?\s*>/i),
    );
    const canonical = decode(first(html, /<link\s+rel="canonical"\s+href="([^"]+)"\s*\/?\s*>/i));
    const h1 = decode(first(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i).replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    const charsetEnd = html.search(/<meta\s+charset=/i);

    if (!title) errors.push(`${entry.url}: missing title`);
    if (!description) errors.push(`${entry.url}: missing meta description`);
    if (!canonical) errors.push(`${entry.url}: missing canonical`);
    if (canonical !== entry.url) errors.push(`${entry.url}: canonical is ${canonical}`);
    if (canonical) {
      try {
        if (new URL(canonical).origin !== ORIGIN) {
          errors.push(`${entry.url}: canonical must use ${ORIGIN}`);
        }
      } catch {
        errors.push(`${entry.url}: canonical is not a valid absolute URL`);
      }
    }
    if (!h1) errors.push(`${entry.url}: missing h1`);
    if (charsetEnd < 0 || charsetEnd > 1024) {
      errors.push(`${entry.url}: charset declaration starts at byte ${charsetEnd}`);
    }
    if (/<meta\s+name="keywords"/i.test(html))
      errors.push(`${entry.url}: obsolete meta keywords found`);
    if (/without the JSON/i.test(html))
      errors.push(`${entry.url}: forbidden positioning phrase found`);
    if (/no (?:usage )?limits?|unlimited usage/i.test(html)) {
      errors.push(`${entry.url}: copy conflicts with quota-only plan positioning`);
    }
    if (title.length > 65) warnings.push(`${entry.url}: title is ${title.length} characters`);
    if (title.length > 80) errors.push(`${entry.url}: title is excessively long (${title.length})`);
    if (description.length > 165) {
      warnings.push(`${entry.url}: description is ${description.length} characters`);
    }
    if (description.length > 220) {
      errors.push(`${entry.url}: description is excessively long (${description.length})`);
    }

    const declaredModifiedDates = new Set([
      ...[...html.matchAll(/"dateModified"\s*:\s*"(\d{4}-\d{2}-\d{2})"/g)].map(
        (match) => match[1]!,
      ),
      ...[
        ...html.matchAll(
          /<meta\s+property="(?:og:updated_time|article:modified_time)"\s+content="(\d{4}-\d{2}-\d{2})[^" ]*"/gi,
        ),
      ].map((match) => match[1]!),
    ]);
    for (const declared of declaredModifiedDates) {
      if (declared !== entry.lastmod) {
        errors.push(
          `${entry.url}: metadata dateModified ${declared} disagrees with sitemap ${entry.lastmod}`,
        );
      }
    }

    const jsonLdMatches = [
      ...html.matchAll(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi),
    ];
    for (const [index, match] of jsonLdMatches.entries()) {
      try {
        auditJsonLdDates(JSON.parse(match[1]!), entry.url);
      } catch (error) {
        errors.push(`${entry.url}: JSON-LD block ${index + 1} does not parse (${String(error)})`);
      }
    }

    const visible = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z#0-9]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const words = visible ? visible.split(" ").length : 0;
    const hrefs = [...html.matchAll(/<a\s+[^>]*href="([^"]+)"/gi)].map((match) =>
      decode(match[1]!),
    );
    for (const href of hrefs) {
      const url = new URL(href, ORIGIN);
      if (url.origin === ORIGIN && url.searchParams.has("entry") && !parseSeoEntry(url.search)) {
        errors.push(
          `${entry.url}: builder CTA has unknown acquisition token ${url.searchParams.get("entry")}`,
        );
      }
      if (
        url.origin === ORIGIN &&
        url.searchParams.has("intent") &&
        !readFeatureIntent(url.search)
      ) {
        errors.push(
          `${entry.url}: builder CTA has unknown intent ${url.searchParams.get("intent")}`,
        );
      }
      const templateId = url.searchParams.get("template");
      if (url.origin === ORIGIN && templateId && !TEMPLATE_IDS.has(templateId)) {
        errors.push(`${entry.url}: builder CTA has unknown template ${templateId}`);
      }
      const setupPlugin = url.searchParams.get("setup");
      if (
        url.origin === ORIGIN &&
        setupPlugin &&
        (!templateId ||
          !TEMPLATE_BY_ID.get(templateId)?.pluginSlots?.some(
            (slot) => slot.pluginId === setupPlugin,
          ))
      ) {
        errors.push(
          `${entry.url}: builder CTA setup ${setupPlugin} is not paired with template ${templateId ?? "(none)"}`,
        );
      }
    }
    const internalLinks = hrefs
      .map((href) => normalizedInternalPath(href))
      .filter((path): path is string => !!path);

    if (
      /\/(?:templates|features|guides)\/[^/]+\/$/.test(new URL(entry.url).pathname) &&
      words < 350
    ) {
      errors.push(`${entry.url}: detail page is too thin (${words} words)`);
    }
    if (titles.has(title))
      errors.push(`${entry.url}: duplicate title also used by ${titles.get(title)}`);
    else titles.set(title, entry.url);
    if (canonicals.has(canonical)) {
      errors.push(`${entry.url}: duplicate canonical also used by ${canonicals.get(canonical)}`);
    } else canonicals.set(canonical, entry.url);

    const ogImage = decode(
      first(html, /<meta\s+property="og:image"\s+content="([^"]+)"\s*\/?\s*>/i),
    );
    const ogAlt = first(html, /<meta\s+property="og:image:alt"\s+content="([^"]+)"\s*\/?\s*>/i);
    if (!ogImage) errors.push(`${entry.url}: missing og:image`);
    if (!ogAlt) warnings.push(`${entry.url}: missing og:image:alt`);
    if (ogImage) {
      try {
        if (new URL(ogImage).origin !== ORIGIN) {
          errors.push(`${entry.url}: og:image must use ${ORIGIN}`);
        }
      } catch {
        errors.push(`${entry.url}: og:image is not a valid absolute URL`);
      }
    }
    if (ogImage && !entry.images.includes(ogImage)) {
      errors.push(`${entry.url}: sitemap image does not include page og:image ${ogImage}`);
    }
    for (const image of entry.images) {
      if (
        image.startsWith(ORIGIN) &&
        !(await exists(join(DIST, new URL(image).pathname.slice(1))))
      ) {
        errors.push(`${entry.url}: sitemap image target is missing (${image})`);
      }
    }
    if (ogImage.startsWith(ORIGIN)) {
      await assertPng(join(DIST, new URL(ogImage).pathname.slice(1)), entry.url);
    }

    pages.push({
      url: entry.url,
      file,
      title,
      description,
      h1,
      words,
      jsonLdBlocks: jsonLdMatches.length,
      internalLinks,
    });
  }

  for (const page of pages) {
    for (const path of page.internalLinks) {
      if (!indexablePaths.has(path))
        errors.push(`${page.url}: broken or unsitemapped internal link ${path}`);
    }
  }

  const templatePages = pages.filter((page) =>
    /\/templates\/[^/]+\/$/.test(new URL(page.url).pathname),
  );
  const inbound = new Map(templatePages.map((page) => [new URL(page.url).pathname, 0]));
  for (const page of templatePages) {
    for (const link of new Set(page.internalLinks)) {
      if (inbound.has(link)) inbound.set(link, inbound.get(link)! + 1);
    }
  }
  for (const [path, count] of inbound) {
    if (count === 0) errors.push(`${path}: template has no contextual inbound detail-page link`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    buildCommit: process.env.GITHUB_SHA ?? null,
    sitemapSha256: createHash("sha256").update(sitemap).digest("hex"),
    pages: pages.length,
    templates: templatePages.length,
    guides: pages.filter((page) => new URL(page.url).pathname.startsWith("/guides/")).length,
    totalWords: pages.reduce((sum, page) => sum + page.words, 0),
    jsonLdBlocks: pages.reduce((sum, page) => sum + page.jsonLdBlocks, 0),
    longestTitle: Math.max(...pages.map((page) => page.title.length)),
    longestDescription: Math.max(...pages.map((page) => page.description.length)),
    warnings,
    errors,
  };
  await writeFile(join(DIST, "seo-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (warnings.length) {
    console.warn(`[seo:audit] ${warnings.length} metadata warning(s); see dist/seo-report.json`);
  }
  if (errors.length) {
    throw new Error(`[seo:audit] ${errors.length} error(s):\n- ${errors.join("\n- ")}`);
  }
  console.log(
    `[seo:audit] ${pages.length} indexable pages, ${report.totalWords.toLocaleString("en-US")} words, ` +
      `${report.jsonLdBlocks} JSON-LD blocks, complete internal-link graph`,
  );
}

await main();
