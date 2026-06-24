/**
 * Build-time generator for the static, SEO-focused template pages.
 *
 * Runs AFTER `vite build` (see the `build` script in package.json) and writes
 * into `dist/`, alongside the SPA the same way the legal pages are static files:
 *
 *   dist/templates/index.html                 — the /templates index
 *   dist/templates/<slug>/index.html          — one page per template
 *   dist/sitemap.xml                           — full sitemap (home + legal + all of the above)
 *
 * Each template page is pre-rendered HTML: the message itself, the SEO copy, a
 * "what's inside" breakdown, a how-to, an FAQ, JSON-LD, and an "Open in DWEEB"
 * deep link (`/?template=<id>`). No JS ships on these pages — they exist to be
 * crawled and to convert a searcher into the builder.
 *
 *   bun scripts/gen-template-pages.ts
 */

import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TEMPLATES } from "@/data/presets";
import { renderMessageHtml } from "./seo/render-message";
import { resolveSeo, SITE, TEMPLATES_LASTMOD, type ResolvedSeo } from "./seo/content";
import { renderIndexPage, renderTemplatePage } from "./seo/layout";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

const LEGAL_LASTMOD = "2026-06-11";
const MAX_RELATED = 4;

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Up to {@link MAX_RELATED} related templates: same category first, then the
 *  rest of the catalogue, never the page itself. */
function pickRelated(current: ResolvedSeo, all: ResolvedSeo[]): ResolvedSeo[] {
  const others = all.filter((t) => t.id !== current.id);
  const sameCat = others.filter((t) => t.category === current.category);
  const rest = others.filter((t) => t.category !== current.category);
  return [...sameCat, ...rest].slice(0, MAX_RELATED);
}

interface SitemapEntry {
  loc: string;
  lastmod: string;
  changefreq: string;
  priority: string;
  images?: string[];
}

function buildSitemap(entries: SitemapEntry[]): string {
  const urls = entries
    .map((e) => {
      const images = (e.images ?? [])
        .map((src) => `    <image:image><image:loc>${xmlEscape(src)}</image:loc></image:image>`)
        .join("\n");
      return `  <url>
    <loc>${xmlEscape(e.loc)}</loc>
    <lastmod>${e.lastmod}</lastmod>
    <changefreq>${e.changefreq}</changefreq>
    <priority>${e.priority}</priority>${images ? "\n" + images : ""}
  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset
  xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"
>
${urls}
</urlset>
`;
}

async function writePage(relPath: string, html: string): Promise<void> {
  const full = join(DIST, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, html, "utf8");
}

async function main(): Promise<void> {
  // The generator decorates a finished build — bail clearly if there's no dist.
  try {
    await access(DIST);
  } catch {
    throw new Error(
      `dist/ not found at ${DIST}. Run "vite build" first — this generator runs as a postbuild step.`,
    );
  }

  const all: ResolvedSeo[] = TEMPLATES.map(resolveSeo);
  const byId = new Map(TEMPLATES.map((t) => [t.id, t]));

  // Per-template pages.
  for (const seo of all) {
    const template = byId.get(seo.id)!;
    const messageHtml = renderMessageHtml(template.message);
    const related = pickRelated(seo, all);
    const html = renderTemplatePage(seo, messageHtml, related);
    await writePage(join("templates", seo.slug, "index.html"), html);
  }

  // /templates index.
  await writePage(join("templates", "index.html"), renderIndexPage(all));

  // Full sitemap: home + legal + templates index + every template page.
  const sitemap = buildSitemap([
    {
      loc: `${SITE.origin}/`,
      lastmod: TEMPLATES_LASTMOD,
      changefreq: "weekly",
      priority: "1.0",
      images: [`${SITE.origin}/og-image.png`, `${SITE.origin}/screenshot.png`],
    },
    {
      loc: `${SITE.origin}/templates/`,
      lastmod: TEMPLATES_LASTMOD,
      changefreq: "weekly",
      priority: "0.9",
    },
    ...all.map((t) => ({
      loc: t.url,
      lastmod: TEMPLATES_LASTMOD,
      changefreq: "monthly",
      priority: "0.7",
    })),
    {
      loc: `${SITE.origin}/privacy`,
      lastmod: LEGAL_LASTMOD,
      changefreq: "yearly",
      priority: "0.3",
    },
    {
      loc: `${SITE.origin}/terms`,
      lastmod: LEGAL_LASTMOD,
      changefreq: "yearly",
      priority: "0.3",
    },
  ]);
  await writeFile(join(DIST, "sitemap.xml"), sitemap, "utf8");

  console.log(
    `[seo] generated ${all.length} template pages + /templates index + sitemap.xml (${all.length + 4} urls)`,
  );
}

await main();
