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
import { GUIDES, PRODUCT_LANDING } from "./seo/guides";
import { ogCardSvg, type OgCardData } from "./seo/og-card";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_TEMPLATES = join(ROOT, "public", "templates-og");
const OUT_FEATURES = join(ROOT, "public", "features-og");
const OUT_GUIDES = join(ROOT, "public", "guides-og");
const OUT_LANDING = join(ROOT, "public", "landing-og");
const ACCENT_BLURPLE = 0x5865f2;

async function writeCard(dir: string, slug: string, card: OgCardData): Promise<void> {
  const png = await sharp(Buffer.from(ogCardSvg(card)), { density: 384 })
    .resize(1200, 630)
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(join(dir, `${slug}.png`), png);
}

async function main(): Promise<void> {
  const guidesOnly = process.argv.includes("--guides-only");
  await mkdir(OUT_TEMPLATES, { recursive: true });
  await mkdir(OUT_FEATURES, { recursive: true });
  await mkdir(OUT_GUIDES, { recursive: true });
  await mkdir(OUT_LANDING, { recursive: true });

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

  for (const guide of GUIDES) {
    await writeCard(OUT_GUIDES, guide.slug, {
      title: guide.h1,
      category: guide.eyebrow.replace(" · ", " — "),
      accent: ACCENT_BLURPLE,
      kicker: "Fact-checked Discord guide · Editable examples in DWEEB",
    });
  }
  await writeCard(OUT_GUIDES, "guides", {
    title: "Discord Webhook Guides",
    category: `${GUIDES.length} practical guides`,
    accent: ACCENT_BLURPLE,
    kicker: "Components V2 · Setup · Conversion · Security · Editing",
  });
  await writeCard(OUT_LANDING, "discord-webhook-builder", {
    title: PRODUCT_LANDING.h1,
    category: "Visual editor · Free core builder",
    accent: ACCENT_BLURPLE,
    kicker: "Build · Preview · Send · Edit · Schedule",
  });

  console.log(
    `[seo] wrote ${GUIDES.length + 2} guide/landing OG cards${guidesOnly ? "" : " plus template/feature cards"}`,
  );
}

await main();
