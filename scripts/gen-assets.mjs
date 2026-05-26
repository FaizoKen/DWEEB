// One-off brand-asset generator (not shipped / not a project dependency).
// Rasterizes the brand SVGs into the PNG icons + OG image that social
// platforms, iOS and Android require. The generated PNGs in public/ are
// committed, so this only needs to run when the artwork changes:
//   bun add -d sharp && bun scripts/gen-assets.mjs && bun remove sharp
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

// Chat-bubble + stacked component blocks, authored on a 512 grid.
const bubble = (radius) => `
  <rect width="512" height="512" rx="${radius}" fill="#5865F2"/>
  <path d="M128 128h256a32 32 0 0 1 32 32v144a32 32 0 0 1-32 32h-128l-80 64v-64h-48a32 32 0 0 1-32-32V160a32 32 0 0 1 32-32z" fill="#fff"/>
  <rect x="168" y="176" width="176" height="35" rx="17.5" fill="#5865F2"/>
  <rect x="168" y="234" width="128" height="35" rx="17.5" fill="#b5bac1"/>
  <rect x="168" y="291" width="88" height="35" rx="17.5" fill="#57F287"/>`;

const rounded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${bubble(128)}</svg>`;
const fullBleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${bubble(0)}</svg>`;

const og = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#1e1f22"/>
  <rect width="1200" height="630" fill="url(#g)"/>
  <defs>
    <radialGradient id="g" cx="18%" cy="22%" r="90%">
      <stop offset="0%" stop-color="#2b2d56"/>
      <stop offset="55%" stop-color="#1e1f22"/>
    </radialGradient>
  </defs>
  <!-- brand icon -->
  <g transform="translate(80,86) scale(0.32)">${bubble(128)}</g>
  <text x="262" y="158" font-family="system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="60" font-weight="700" fill="#ffffff">Discord Webhook Builder</text>
  <text x="84" y="286" font-family="system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="35" font-weight="600" fill="#d8dae0">Visually build, preview &amp; share Components V2 messages.</text>
  <!-- feature chips -->
  <g font-family="system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="28" font-weight="600">
    <rect x="84" y="346" width="206" height="56" rx="28" fill="#313338"/>
    <text x="112" y="383" fill="#b5bac1">No JSON</text>
    <rect x="306" y="346" width="232" height="56" rx="28" fill="#313338"/>
    <text x="334" y="383" fill="#b5bac1">No backend</text>
    <rect x="554" y="346" width="300" height="56" rx="28" fill="#313338"/>
    <text x="582" y="383" fill="#b5bac1">Shareable URL</text>
  </g>
  <!-- mock message card -->
  <g transform="translate(84,460)">
    <rect width="1032" height="118" rx="14" fill="#2b2d31" stroke="#3f4248" stroke-width="2"/>
    <circle cx="46" cy="59" r="26" fill="#5865F2"/>
    <rect x="92" y="34" width="240" height="20" rx="10" fill="#f2f3f5"/>
    <rect x="92" y="68" width="520" height="16" rx="8" fill="#b5bac1"/>
    <rect x="820" y="42" width="170" height="42" rx="8" fill="#57F287"/>
  </g>
</svg>`;

async function png(svg, size, file) {
  const buf = Buffer.isBuffer(svg) ? svg : Buffer.from(svg);
  await sharp(buf, { density: 384 }).resize(size.w, size.h).png().toFile(path.join(pub, file));
  console.log("wrote", file);
}

await png(rounded, { w: 192, h: 192 }, "icon-192.png");
await png(rounded, { w: 512, h: 512 }, "icon-512.png");
await png(fullBleed, { w: 512, h: 512 }, "icon-512-maskable.png");
await png(fullBleed, { w: 180, h: 180 }, "apple-touch-icon.png");
await png(og, { w: 1200, h: 630 }, "og-image.png");
