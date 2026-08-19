/**
 * Post-generation SEO contract. Audits the exact HTML shipped in `dist/` and
 * fails the build on crawl, metadata, schema, linking or social-card defects.
 */

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSeoEntry } from "../../src/core/seo/acquisition";
import { readFeatureIntent } from "../../src/app/featureIntent";
import { readClientParam, SEO_CLIENT_PARAM_KEYS } from "../../src/core/seo/clientParams";
import { TEMPLATES } from "../../src/data/presets";
import { SITE } from "./content";
import { guideLandingOgSources, OG_CARD_HEIGHT, OG_CARD_WIDTH } from "./og-card-catalog";
import { parseOgAssetManifest, sha256, type OgAssetManifest } from "./og-asset-manifest";
import { ROOT_OG_SVG } from "./root-og-source";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DIST = join(ROOT, "dist");
const ORIGIN = "https://dweeb.faizo.net";
// Public content dates follow the maintainer's calendar. A UTC date would make
// every legitimate after-midnight update look one day "future" for eight hours.
const TODAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kuala_Lumpur",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const TEMPLATE_IDS = new Set(TEMPLATES.map((template) => template.id));
const TEMPLATE_BY_ID = new Map(TEMPLATES.map((template) => [template.id, template]));
const WEB_BOOT_SOURCE_ROOTS = [
  { source: "index.html", chunkName: "index" },
  { source: "src/app/App.tsx", chunkName: "App" },
  { source: "src/core/pwa/installPrompt.ts", chunkName: "installPrompt" },
  { source: "src/core/seo/acquisition.ts", chunkName: "acquisition" },
  { source: "src/core/oauth/popupFlow.ts", chunkName: "popupFlow" },
  { source: "src/core/oauth/flows.ts", chunkName: "flows" },
] as const;
const MAX_CRITICAL_REQUESTS = 16;
/**
 * The `[label](/path)` form `renderProse` converts into an inline internal
 * link. Matching it in the *rendered* HTML means the renderer never saw it —
 * an authoring typo shipping as visible punctuation, which the broken-link gate
 * cannot catch because no link was ever emitted.
 */
const UNRENDERED_INLINE_LINK = /\[[^[\]<>]+\]\(\/[A-Za-z0-9\-._~/]*\)/;

interface PageAudit {
  url: string;
  file: string;
  title: string;
  description: string;
  h1: string;
  words: number;
  jsonLdBlocks: number;
  internalLinks: string[];
  contextualLinks: string[];
}

interface SitemapEntry {
  url: string;
  lastmod: string;
  images: string[];
}

interface ViteManifestChunk {
  file: string;
  name?: string;
  src?: string;
  imports?: string[];
  css?: string[];
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

async function webBootAssets(): Promise<string[]> {
  const manifest = JSON.parse(
    await readFile(join(DIST, ".vite", "manifest.json"), "utf8"),
  ) as Record<string, ViteManifestChunk>;
  const assets = new Set<string>();
  const visited = new Set<string>();

  function visit(key: string): void {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key];
    if (!chunk) {
      errors.push(`Vite manifest references missing chunk ${key}`);
      return;
    }
    if (/\.(?:js|css)$/.test(chunk.file)) assets.add(chunk.file);
    for (const css of chunk.css ?? []) assets.add(css);
    for (const dependency of chunk.imports ?? []) visit(dependency);
  }

  for (const root of WEB_BOOT_SOURCE_ROOTS) {
    const candidates = Object.entries(manifest).filter(
      ([key, chunk]) =>
        key === root.source || chunk.src === root.source || chunk.name === root.chunkName,
    );
    if (candidates.length !== 1) {
      errors.push(
        `Vite manifest must resolve web boot source ${root.source} exactly once (found ${candidates.length})`,
      );
      continue;
    }
    visit(candidates[0]![0]);
  }

  // This deferred analytics bootstrap is referenced directly by index.html,
  // so it is intentionally outside Vite's module graph but still a request
  // every ordinary web visit makes.
  assets.add("gtag-init.js");
  return [...assets].sort();
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

async function auditOgAssetManifest(
  manifestFile: string,
  expectedGenerator: string,
  expectedSources: ReadonlyMap<string, string>,
): Promise<void> {
  let manifest: OgAssetManifest;
  try {
    manifest = parseOgAssetManifest(await readFile(manifestFile, "utf8"));
  } catch (error) {
    errors.push(`${manifestFile}: invalid OG asset manifest (${String(error)})`);
    return;
  }

  if (manifest.generator !== expectedGenerator) {
    errors.push(
      `${manifestFile}: expected generator ${expectedGenerator}, found ${manifest.generator}`,
    );
  }

  const actualPaths = new Set(Object.keys(manifest.assets));
  for (const assetPath of actualPaths) {
    if (!expectedSources.has(assetPath)) {
      errors.push(`${manifestFile}: stale or unexpected OG asset entry ${assetPath}`);
    }
  }

  for (const [assetPath, sourceSvg] of expectedSources) {
    const fingerprint = manifest.assets[assetPath];
    if (!fingerprint) {
      errors.push(`${manifestFile}: missing OG asset entry ${assetPath}`);
      continue;
    }
    if (fingerprint.width !== OG_CARD_WIDTH || fingerprint.height !== OG_CARD_HEIGHT) {
      errors.push(
        `${manifestFile}: ${assetPath} records ${fingerprint.width}×${fingerprint.height}; expected ${OG_CARD_WIDTH}×${OG_CARD_HEIGHT}`,
      );
    }
    const sourceHash = sha256(sourceSvg);
    if (fingerprint.sourceSvgSha256 !== sourceHash) {
      errors.push(`${manifestFile}: ${assetPath} card copy/design changed without regeneration`);
    }
    const emittedFile = join(DIST, assetPath.slice(1));
    if (!(await exists(emittedFile))) {
      errors.push(`${manifestFile}: emitted OG asset is missing ${assetPath}`);
      continue;
    }
    const pngHash = sha256(await readFile(emittedFile));
    if (fingerprint.pngSha256 !== pngHash) {
      errors.push(`${manifestFile}: ${assetPath} PNG bytes do not match its generated manifest`);
    }
  }
}

async function auditOgAssetManifests(): Promise<void> {
  const manifests = join(ROOT, "scripts", "seo", "manifests");
  await auditOgAssetManifest(
    join(manifests, "guide-landing-og.json"),
    "scripts/gen-template-og.ts",
    new Map(guideLandingOgSources().map(({ assetPath, sourceSvg }) => [assetPath, sourceSvg])),
  );
  await auditOgAssetManifest(
    join(manifests, "root-og.json"),
    "scripts/gen-assets.mjs",
    new Map([["/og-image.png", ROOT_OG_SVG]]),
  );
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
  await auditOgAssetManifests();
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
  const clientStateUrls = new Set<string>();
  const crawlableClientStateUrls = new Set<string>();
  // The root paints a small HTML-first product shell while its app chunks load,
  // then App replaces it with the same document heading. Audit both states:
  // `<noscript>` must never stand in for either one.
  const appSource = await readFile(join(ROOT, "src", "app", "App.tsx"), "utf8");
  const appH1Matches = [...appSource.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)];
  const renderedRootH1 = decode((appH1Matches[0]?.[1] ?? "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  if (appH1Matches.length !== 1 || !/Discord message builder/i.test(renderedRootH1)) {
    errors.push(
      `/: rendered app source must contain one product H1 naming Discord message builder`,
    );
  }
  const markdownSource = await readFile(
    join(ROOT, "src", "features", "preview", "markdown", "Markdown.tsx"),
    "utf8",
  );
  if (/<h1\b/.test(markdownSource)) {
    errors.push(`/: Discord preview markdown must not emit document-level H1 elements`);
  }

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
    const rootPage = new URL(entry.url).pathname === "/";
    const htmlWithoutNoscript = rootPage
      ? html.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      : html;
    const rootShellH1Matches = rootPage
      ? [...htmlWithoutNoscript.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)]
      : [];
    const rootShellH1 = decode((rootShellH1Matches[0]?.[1] ?? "").replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    const h1Matches = rootPage ? [] : [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)];
    const h1 = rootPage
      ? renderedRootH1
      : decode((h1Matches[0]?.[1] ?? "").replace(/<[^>]+>/g, " "))
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
    if (
      rootPage &&
      (rootShellH1Matches.length !== 1 ||
        !/Discord message builder/i.test(rootShellH1) ||
        !/<main\b[^>]*\bdata-seo-boot\b/i.test(htmlWithoutNoscript))
    ) {
      errors.push(
        `${entry.url}: HTML-first app shell must contain one product H1 naming Discord message builder`,
      );
    } else if (!rootPage && h1Matches.length !== 1) {
      errors.push(`${entry.url}: expected exactly one h1, found ${h1Matches.length}`);
    } else if (!h1) {
      errors.push(`${entry.url}: missing h1`);
    }
    if (charsetEnd < 0 || charsetEnd > 1024) {
      errors.push(`${entry.url}: charset declaration starts at byte ${charsetEnd}`);
    }
    if (/<meta\s+name="keywords"/i.test(html))
      errors.push(`${entry.url}: obsolete meta keywords found`);
    if (/without the JSON/i.test(html))
      errors.push(`${entry.url}: forbidden positioning phrase found`);
    // Landing and guide prose may carry inline internal links written as
    // [label](/path) — see `renderProse`. Anything the renderer did not convert
    // reaches the reader as literal punctuation, so a mistyped target ships as
    // visible syntax rather than as a broken link the link gate would catch.
    if (UNRENDERED_INLINE_LINK.test(html))
      errors.push(`${entry.url}: unrendered inline link syntax in page copy`);
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
    let websiteDefinitions = 0;
    for (const [index, match] of jsonLdMatches.entries()) {
      try {
        const parsed = JSON.parse(match[1]!) as Record<string, unknown>;
        auditJsonLdDates(parsed, entry.url);
        const nodes = Array.isArray(parsed["@graph"]) ? parsed["@graph"] : [parsed];
        for (const rawNode of nodes) {
          if (!rawNode || typeof rawNode !== "object") continue;
          const node = rawNode as Record<string, unknown>;
          if (node["@id"] !== SITE.websiteId) continue;
          websiteDefinitions += 1;
          if (
            node.name !== SITE.name ||
            node.description !== SITE.description ||
            JSON.stringify(node.alternateName) !== JSON.stringify(SITE.alternateNames)
          ) {
            errors.push(`${entry.url}: WebSite identity disagrees with the canonical SITE entity`);
          }
        }
      } catch (error) {
        errors.push(`${entry.url}: JSON-LD block ${index + 1} does not parse (${String(error)})`);
      }
    }
    const legalPage = ["/privacy", "/terms"].includes(new URL(entry.url).pathname);
    if (!legalPage && websiteDefinitions !== 1) {
      errors.push(
        `${entry.url}: expected one canonical WebSite definition, found ${websiteDefinitions}`,
      );
    } else if (legalPage && websiteDefinitions > 1) {
      errors.push(`${entry.url}: duplicate canonical WebSite definitions (${websiteDefinitions})`);
    }

    const visibleSource = htmlWithoutNoscript;
    const visible = `${rootPage ? renderedRootH1 : ""} ${visibleSource}`
      .replace(/<!--[\s\S]*?-->/g, " ")
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
      if (url.origin !== ORIGIN) continue;

      const queryState = SEO_CLIENT_PARAM_KEYS.filter((key) => url.searchParams.has(key));
      if (queryState.length) {
        crawlableClientStateUrls.add(url.pathname + url.search);
        errors.push(
          `${entry.url}: client-only builder state must use the URL fragment, not query keys ${queryState.join(", ")} (${href})`,
        );
      }
      if (SEO_CLIENT_PARAM_KEYS.some((key) => readClientParam(key, url.search, url.hash))) {
        clientStateUrls.add(url.pathname + url.hash);
      }

      const acquisition = readClientParam("entry", url.search, url.hash);
      if (acquisition && !parseSeoEntry(url.search, url.hash)) {
        errors.push(`${entry.url}: builder CTA has unknown acquisition token ${acquisition}`);
      }
      const intent = readClientParam("intent", url.search, url.hash);
      if (intent && !readFeatureIntent(url.search, url.hash)) {
        errors.push(`${entry.url}: builder CTA has unknown intent ${intent}`);
      }
      const templateId = readClientParam("template", url.search, url.hash);
      if (templateId && !TEMPLATE_IDS.has(templateId)) {
        errors.push(`${entry.url}: builder CTA has unknown template ${templateId}`);
      }
      const setupPlugin = readClientParam("setup", url.search, url.hash);
      if (
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
    // Links inside <main> are the ones that carry descriptive anchor text and
    // real editorial weight; the nav and footer repeat the same generic anchors
    // on all 66 pages and say nothing about any one of them. They have to be
    // counted apart or the boilerplate makes every page look well linked.
    const mainHtml = html.slice(
      Math.max(html.indexOf("<main"), 0),
      html.includes("<footer") ? html.indexOf("<footer") : undefined,
    );
    const contextualLinks = new Set(
      [...mainHtml.matchAll(/<a\s+[^>]*href="([^"]+)"/gi)]
        .map((match) => normalizedInternalPath(decode(match[1]!)))
        .filter((path): path is string => !!path),
    );

    const contentPath = new URL(entry.url).pathname;
    if (
      (/\/(?:templates|features|guides)\/[^/]+\/$/.test(contentPath) ||
        contentPath === "/about/") &&
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
      contextualLinks: [...contextualLinks],
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

  // "Discord message builder" is the site's primary query, and `/` is a working
  // editor whose crawlable body is a UI rather than prose — so the landing that
  // carries the depth for that term is the page that has to be linked *to*.
  // Before 2026-08-20 its only inbound links were the nav and footer anchors
  // every page repeats verbatim, which describe nothing; the 47 template and
  // feature pages, the site's largest content mass, pointed at it from nowhere
  // inside their own copy. Losing that ring again would be invisible in review.
  const HEAD_TERM_LANDING = "/discord-message-builder/";
  for (const page of pages) {
    const path = new URL(page.url).pathname;
    if (!/^\/(?:templates|features)\/[^/]+\/$/.test(path)) continue;
    if (!page.contextualLinks.includes(HEAD_TERM_LANDING)) {
      errors.push(`${page.url}: no contextual link to ${HEAD_TERM_LANDING}`);
    }
  }

  // Non-flaky transfer budgets complement Lighthouse: they catch a critical
  // bundle or above-fold proof asset growing before noisy lab timing does. The
  // thresholds leave headroom over the 2026-08-20 baseline while still making
  // an accidental large dependency/image fail the build.
  const criticalAssetNames = await webBootAssets();
  const criticalBuffers = await Promise.all(
    criticalAssetNames.map((name) => readFile(join(DIST, name))),
  );
  const criticalRequestCount = criticalAssetNames.length;
  const criticalRawBytes = criticalBuffers.reduce((sum, bytes) => sum + bytes.byteLength, 0);
  const criticalGzipBytes = criticalBuffers.reduce(
    (sum, bytes) => sum + gzipSync(bytes).byteLength,
    0,
  );
  if (criticalRawBytes > 575_000 || criticalGzipBytes > 180_000) {
    errors.push(
      `/: critical JS/CSS budget exceeded (${criticalRawBytes} raw / ${criticalGzipBytes} gzip bytes)`,
    );
  }
  if (criticalRequestCount > MAX_CRITICAL_REQUESTS) {
    errors.push(
      `/: critical asset request budget exceeded (${criticalRequestCount} requests; maximum ${MAX_CRITICAL_REQUESTS})`,
    );
  }
  const primaryLandingHtml = await readFile(join(DIST, "discord-message-builder", "index.html"));
  const productPreview = await readFile(join(DIST, "builder-preview.webp"));
  const primaryLandingTransferBytes =
    gzipSync(primaryLandingHtml).byteLength + productPreview.byteLength;
  if (primaryLandingTransferBytes > 90_000) {
    errors.push(
      `/discord-message-builder/: HTML + product proof budget exceeded (${primaryLandingTransferBytes} bytes)`,
    );
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
    clientStateUrls: clientStateUrls.size,
    crawlableClientStateUrls: crawlableClientStateUrls.size,
    criticalAssets: criticalAssetNames.map((name) => `/${name}`),
    criticalRequestCount,
    criticalRawBytes,
    criticalGzipBytes,
    primaryLandingTransferBytes,
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
