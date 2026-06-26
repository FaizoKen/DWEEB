/**
 * Per-template Open Graph image generator (1200×630 PNG per template + one for
 * the /templates index).
 *
 * Like `gen-assets.mjs`, this is a one-off that rasterizes brand SVGs and is NOT
 * a project dependency: the PNGs it writes into `public/templates-og/` are
 * committed, so the deploy build (and CI) never needs `sharp`. Re-run it only
 * when templates or the card design change:
 *
 *   bun add -d sharp && bun scripts/gen-template-og.ts && bun remove sharp
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_TEMPLATES = join(ROOT, "public", "templates-og");
const OUT_FEATURES = join(ROOT, "public", "features-og");
const ACCENT_BLURPLE = 0x5865f2;

async function writeCard(dir: string, slug: string, card: OgCardData): Promise<void> {
  const png = await sharp(Buffer.from(ogCardSvg(card)), { density: 384 })
    .resize(1200, 630)
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(join(dir, `${slug}.png`), png);
}

async function main(): Promise<void> {
  await mkdir(OUT_TEMPLATES, { recursive: true });
  await mkdir(OUT_FEATURES, { recursive: true });

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

  console.log(
    `[seo] wrote ${TEMPLATES.length + 1} template + ${features.length + 1} feature OG cards`,
  );
}

await main();
