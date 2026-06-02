// One-off brand-asset generator (not shipped / not a project dependency).
// Rasterizes the brand SVGs into the PNG icons + OG image that social
// platforms, iOS and Android require. The generated PNGs in public/ are
// committed, so this only needs to run when the artwork changes:
//   bun add -d sharp && bun scripts/gen-assets.mjs && bun remove sharp
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

// A pair of chunky nerd glasses — the literal "dweeb" — built from two
// rounded-square lenses (which also echo Components V2 "blocks") bridged
// by a brand-green nose piece, with short white temple stubs and a soft
// glass glint on each lens. White-on-blurple with a Discord-green accent.
// Drawn back-to-front: arms + bridge first, lenses over them, glints on top.
// Authored on a 512 grid.
const mark = (radius) => `
  <rect width="512" height="512" rx="${radius}" fill="#5865F2"/>
  <rect x="40" y="210" width="52" height="30" rx="15" fill="#fff"/>
  <rect x="420" y="210" width="52" height="30" rx="15" fill="#fff"/>
  <rect x="214" y="200" width="84" height="30" rx="15" fill="#57F287"/>
  <rect x="78" y="182" width="148" height="148" rx="46" fill="#fff"/>
  <rect x="286" y="182" width="148" height="148" rx="46" fill="#fff"/>
  <rect x="104" y="202" width="20" height="62" rx="10" fill="#5865F2" opacity="0.16" transform="rotate(-26 114 233)"/>
  <rect x="312" y="202" width="20" height="62" rx="10" fill="#5865F2" opacity="0.16" transform="rotate(-26 322 233)"/>`;

const rounded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${mark(128)}</svg>`;
const fullBleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${mark(0)}</svg>`;

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
  <g transform="translate(80,86) scale(0.32)">${mark(128)}</g>
  <text x="262" y="190" font-family="system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="96" font-weight="800" letter-spacing="2" fill="#ffffff">DWEEB</text>
  <text x="84" y="286" font-family="system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="35" font-weight="600" fill="#d8dae0">Discord Webhook Embed Builder · Components V2</text>
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
