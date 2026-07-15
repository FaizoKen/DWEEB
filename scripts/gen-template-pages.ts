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
import { resolveAllFeatures, FEATURES_LASTMOD } from "./seo/features";
import { renderFeaturePage, renderFeaturesIndexPage } from "./seo/features-layout";
import { GUIDES, GUIDES_LASTMOD, PRODUCT_LANDING } from "./seo/guides";
import {
  renderGuidePage,
  renderGuidesIndexPage,
  renderProductLandingPage,
} from "./seo/guides-layout";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

const BUILD_DATE = new Date().toISOString().slice(0, 10);
const PRIVACY_LASTMOD = "2026-07-15";
const TERMS_LASTMOD = "2026-07-13";
const MAX_RELATED = 4;

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

/** Similarity-led and deterministically rotated so late catalogue entries also
 * receive contextual links instead of every page pointing at the first four. */
function pickRelated(current: ResolvedSeo, all: ResolvedSeo[]): ResolvedSeo[] {
  const meaningful = (keyword: string) =>
    ![
      "discord",
      "discord template",
      "discord components v2",
      "discord webhook",
      "discord message builder",
    ].includes(keyword);
  const currentKeywords = new Set(current.keywords.filter(meaningful));
  const ranked = all
    .filter((candidate) => candidate.id !== current.id)
    .map((candidate) => {
      const sharedPlugins = candidate.pluginIds.filter((id) =>
        current.pluginIds.includes(id),
      ).length;
      const sharedComponents = candidate.componentKinds.filter((kind) =>
        current.componentKinds.includes(kind),
      ).length;
      const sharedKeywords = candidate.keywords.filter(
        (keyword) => meaningful(keyword) && currentKeywords.has(keyword),
      ).length;
      const score =
        sharedPlugins * 24 +
        (candidate.category === current.category ? 8 : 0) +
        sharedKeywords * 3 +
        sharedComponents * 2 +
        (candidate.deliveryMode === current.deliveryMode ? 1 : 0);
      return { candidate, score, tie: stableHash(`${current.id}|${candidate.id}`) };
    })
    .sort((a, b) => b.score - a.score || a.tie - b.tie)
    .map(({ candidate }) => candidate);
  // Reserve one slot for the next catalogue item. This creates a complete
  // crawlable ring (every detail page receives at least one contextual inbound
  // link) while the other slots remain driven by topical similarity.
  const index = all.findIndex((item) => item.id === current.id);
  const neighbour = all[(index + 1) % all.length];
  const picked = ranked.slice(0, MAX_RELATED - 1);
  if (
    neighbour &&
    neighbour.id !== current.id &&
    !picked.some((item) => item.id === neighbour.id)
  ) {
    picked.push(neighbour);
  }
  return picked.slice(0, MAX_RELATED);
}

interface SitemapEntry {
  loc: string;
  lastmod: string;
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
    <lastmod>${e.lastmod}</lastmod>${images ? "\n" + images : ""}
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
  const features = resolveAllFeatures();

  // Per-template pages.
  for (const seo of all) {
    const template = byId.get(seo.id)!;
    const messageHtml = renderMessageHtml(template.message);
    const related = pickRelated(seo, all);
    const relatedFeatures = features.filter(
      (feature) => !!feature.pluginId && seo.pluginIds.includes(feature.pluginId),
    );
    const html = renderTemplatePage(seo, messageHtml, related, relatedFeatures);
    await writePage(join("templates", seo.slug, "index.html"), html);
  }

  // /templates index.
  await writePage(join("templates", "index.html"), renderIndexPage(all));

  // ── Feature pages (/features/<slug>/ + /features index) ──────────────────
  const seoById = new Map(all.map((s) => [s.id, s]));
  for (const feature of features) {
    const previewTpl = feature.previewTemplateId ? byId.get(feature.previewTemplateId) : undefined;
    const previewHtml = previewTpl ? renderMessageHtml(previewTpl.message) : null;
    // Templates wired to this plugin (via pluginSlots) cross-link both ways.
    const related = feature.pluginId
      ? TEMPLATES.filter((t) => t.pluginSlots?.some((slot) => slot.pluginId === feature.pluginId))
          .map((t) => seoById.get(t.id))
          .filter((s): s is ResolvedSeo => !!s)
      : [];
    const html = renderFeaturePage(feature, previewHtml, related);
    await writePage(join("features", feature.slug, "index.html"), html);
  }
  await writePage(join("features", "index.html"), renderFeaturesIndexPage(features));

  // ── Search-led guide cluster + core commercial-intent landing page ───────
  for (const guide of GUIDES) {
    await writePage(join("guides", guide.slug, "index.html"), renderGuidePage(guide, GUIDES));
  }
  await writePage(join("guides", "index.html"), renderGuidesIndexPage(GUIDES));
  await writePage(join("discord-webhook-builder", "index.html"), renderProductLandingPage());

  // Full sitemap: home + legal + templates index + every template page.
  const sitemap = buildSitemap([
    {
      loc: `${SITE.origin}/`,
      // Vite stamps the app shell's WebApplication + Open Graph modification
      // dates on every release; keep the sitemap's signal identical.
      lastmod: BUILD_DATE,
      images: [`${SITE.origin}/og-image.png`, `${SITE.origin}/screenshot.png`],
    },
    {
      loc: `${SITE.origin}/templates/`,
      lastmod: TEMPLATES_LASTMOD,
      images: [`${SITE.origin}/templates-og/templates.png`],
    },
    ...all.map((t) => ({
      loc: t.url,
      lastmod: TEMPLATES_LASTMOD,
      images: [t.ogImage],
    })),
    {
      loc: `${SITE.origin}/features/`,
      lastmod: FEATURES_LASTMOD,
      images: [`${SITE.origin}/features-og/features.png`],
    },
    ...features.map((f) => ({
      loc: f.url,
      lastmod: FEATURES_LASTMOD,
      images: [f.ogImage],
    })),
    {
      loc: `${SITE.origin}/guides/`,
      lastmod: GUIDES_LASTMOD,
      images: [`${SITE.origin}/guides-og/guides.png`],
    },
    ...GUIDES.map((guide) => ({
      loc: guide.url,
      lastmod: guide.modified,
      images: [guide.ogImage],
    })),
    {
      loc: PRODUCT_LANDING.url,
      lastmod: GUIDES_LASTMOD,
      images: [PRODUCT_LANDING.ogImage],
    },
    {
      loc: `${SITE.origin}/privacy`,
      lastmod: PRIVACY_LASTMOD,
      images: [SITE.ogImage],
    },
    {
      loc: `${SITE.origin}/terms`,
      lastmod: TERMS_LASTMOD,
      images: [SITE.ogImage],
    },
  ]);
  await writeFile(join(DIST, "sitemap.xml"), sitemap, "utf8");

  console.log(
    `[seo] generated ${all.length} templates + ${features.length} features + ${GUIDES.length} guides ` +
      `+ 4 section/landing pages + home/legal + sitemap.xml (${all.length + features.length + GUIDES.length + 7} urls)`,
  );
}

await main();
