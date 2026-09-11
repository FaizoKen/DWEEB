/** Regenerate display-only WebP samples: bun add -d sharp; run this; bun remove sharp. */
import sharp from "sharp";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DEFAULT_MEDIA } from "../src/core/media/defaultMedia";

const root = new URL("../", import.meta.url);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const entries: Record<string, { sourceSha256: string; previewSha256: string }> = {};
let before = 0;
let after = 0;
for (const url of Object.values(DEFAULT_MEDIA)) {
  const path = new URL(url).pathname;
  const original = await readFile(new URL(`public${path}`, root));
  // Retain the source dimensions and aspect ratio; only the encoding changes.
  const preview = await sharp(original).webp({ quality: 82, effort: 6 }).toBuffer();
  if (preview.length >= original.length)
    throw new Error(`${path}: preview did not reduce transfer`);
  await writeFile(new URL(`public${path.replace(/\.jpg$/, ".webp")}`, root), preview);
  entries[path] = { sourceSha256: hash(original), previewSha256: hash(preview) };
  before += original.length;
  after += preview.length;
}
await writeFile(
  fileURLToPath(new URL("scripts/seo/manifests/preview-media.json", root)),
  `${JSON.stringify(entries, null, 2)}\n`,
);
console.log(
  `Preview media: ${Object.keys(entries).length} files, ${before} → ${after} bytes (${Math.round((1 - after / before) * 100)}% smaller)`,
);
