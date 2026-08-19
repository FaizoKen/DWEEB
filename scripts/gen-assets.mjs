// One-off brand-asset generator (not shipped / not a project dependency).
// Rasterizes the brand SVGs into the PNG icons + OG image that social
// platforms, iOS and Android require. The generated PNGs in public/ are
// committed, so this only needs to run when the artwork changes:
//   bun add -d sharp && bun scripts/gen-assets.mjs && bun remove sharp
// Root OG copy-only changes can preserve every icon byte:
//   bun add -d sharp && bun scripts/gen-assets.mjs --og-only && bun remove sharp
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fingerprintOgAsset, serializeOgAssetManifest } from "./seo/og-asset-manifest.ts";
import { FULL_BLEED_BRAND_SVG, ROOT_OG_SVG, ROUNDED_BRAND_SVG } from "./seo/root-og-source.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(root, "public");
const manifestDir = path.join(root, "scripts", "seo", "manifests");
const rootOgManifest = path.join(manifestDir, "root-og.json");

async function png(svg, size, file) {
  const buf = Buffer.isBuffer(svg) ? svg : Buffer.from(svg);
  const output = await sharp(buf, { density: 384 }).resize(size.w, size.h).png().toBuffer();
  await writeFile(path.join(pub, file), output);
  console.log("wrote", file);
  return output;
}

const ogOnly = process.argv.includes("--og-only");
if (!ogOnly) {
  await png(ROUNDED_BRAND_SVG, { w: 192, h: 192 }, "icon-192.png");
  await png(ROUNDED_BRAND_SVG, { w: 512, h: 512 }, "icon-512.png");
  await png(FULL_BLEED_BRAND_SVG, { w: 512, h: 512 }, "icon-512-maskable.png");
  await png(FULL_BLEED_BRAND_SVG, { w: 180, h: 180 }, "apple-touch-icon.png");
}

const rootOgPng = await png(ROOT_OG_SVG, { w: 1200, h: 630 }, "og-image.png");
await mkdir(manifestDir, { recursive: true });
await writeFile(
  rootOgManifest,
  serializeOgAssetManifest("scripts/gen-assets.mjs", [
    ["/og-image.png", fingerprintOgAsset(ROOT_OG_SVG, rootOgPng, 1200, 630)],
  ]),
  "utf8",
);
console.log("wrote", path.relative(root, rootOgManifest));
