/**
 * Open Graph image generator (1200×630 PNGs for templates, features, guides,
 * section indexes, and the product landing page).
 *
 * Like `gen-assets.mjs`, this is a one-off that rasterizes brand SVGs and is NOT
 * a project dependency: the PNGs it writes into `public/templates-og/` are
 * committed, so the deploy build (and CI) never needs `sharp`. Re-run it only
 * when templates or the card design change:
 *
 *   bun add -d sharp && bun scripts/gen-template-og.ts && bun remove sharp
 *
 * Guide/content-only changes can avoid rewriting established cards:
 *   bun add -d sharp && bun scripts/gen-template-og.ts --guides-only && bun remove sharp
 *
 * Each guide/landing run also refreshes a deterministic source-SVG + emitted-
 * PNG hash manifest under `scripts/seo/manifests/`; the SEO audit uses it to
 * reject a copy change whose committed card was not regenerated.
 *
 * The page generator (`gen-template-pages.ts`) references these by URL
 * (`/templates-og/<slug>.png`); see `resolveSeo().ogImage`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { TEMPLATES } from "@/data/presets";
import { resolveSeo } from "./seo/content";
import { resolveAllFeatures } from "./seo/features";
import { ogCardSvg, type OgCardData } from "./seo/og-card";
import { guideLandingOgSources, OG_CARD_HEIGHT, OG_CARD_WIDTH } from "./seo/og-card-catalog";
import {
  fingerprintOgAsset,
  serializeOgAssetManifest,
  type OgAssetFingerprint,
} from "./seo/og-asset-manifest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_TEMPLATES = join(ROOT, "public", "templates-og");
const OUT_FEATURES = join(ROOT, "public", "features-og");
const OUT_GUIDES = join(ROOT, "public", "guides-og");
const OUT_LANDING = join(ROOT, "public", "landing-og");
const MANIFEST_DIR = join(ROOT, "scripts", "seo", "manifests");
const GUIDE_LANDING_MANIFEST = join(MANIFEST_DIR, "guide-landing-og.json");
const ACCENT_BLURPLE = 0x5865f2;

async function writeSvg(file: string, svg: string): Promise<OgAssetFingerprint> {
  const png = await sharp(Buffer.from(svg), { density: 384 })
    .resize(OG_CARD_WIDTH, OG_CARD_HEIGHT)
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(file, png);
  return fingerprintOgAsset(svg, png, OG_CARD_WIDTH, OG_CARD_HEIGHT);
}

async function writeCard(dir: string, slug: string, card: OgCardData): Promise<OgAssetFingerprint> {
  return writeSvg(join(dir, `${slug}.png`), ogCardSvg(card));
}

async function main(): Promise<void> {
  const guidesOnly = process.argv.includes("--guides-only");
  await mkdir(OUT_TEMPLATES, { recursive: true });
  await mkdir(OUT_FEATURES, { recursive: true });
  await mkdir(OUT_GUIDES, { recursive: true });
  await mkdir(OUT_LANDING, { recursive: true });
  await mkdir(MANIFEST_DIR, { recursive: true });

  if (!guidesOnly) {
    for (const template of TEMPLATES) {
      const seo = resolveSeo(template);
      await writeCard(OUT_TEMPLATES, seo.slug, {
        title: seo.h1,
        category: template.category,
        accent: template.accent ?? ACCENT_BLURPLE,
      });
    }

    // The /templates index card.
    await writeCard(OUT_TEMPLATES, "templates", {
      title: "Discord Message Templates",
      category: `${TEMPLATES.length} free templates`,
      accent: ACCENT_BLURPLE,
      kicker: "Welcome · Rules · Announcements · Giveaways · Tickets & more",
    });

    // Per-feature cards + the /features index card.
    const features = resolveAllFeatures();
    for (const feature of features) {
      await writeCard(OUT_FEATURES, feature.slug, {
        title: feature.h1,
        category: feature.category,
        accent: feature.accent,
      });
    }
    await writeCard(OUT_FEATURES, "features", {
      title: "DWEEB Features",
      category: `${features.length} ways to do more`,
      accent: ACCENT_BLURPLE,
      kicker: "Self roles · Tickets · Giveaways · Forms · Scheduled posts & more",
    });
  }

  const guideLandingSources = guideLandingOgSources();
  const fingerprints: [string, OgAssetFingerprint][] = [];
  for (const { assetPath, sourceSvg } of guideLandingSources) {
    const fingerprint = await writeSvg(join(ROOT, "public", assetPath.slice(1)), sourceSvg);
    fingerprints.push([assetPath, fingerprint]);
  }
  await writeFile(
    GUIDE_LANDING_MANIFEST,
    serializeOgAssetManifest("scripts/gen-template-og.ts", fingerprints),
    "utf8",
  );

  console.log(
    `[seo] wrote ${guideLandingSources.length} guide/landing OG cards + manifest${guidesOnly ? "" : " plus template/feature cards"}`,
  );
}

await main();
