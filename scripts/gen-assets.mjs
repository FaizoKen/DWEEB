// One-off brand-asset generator (not shipped / not a project dependency).
// Rasterizes the brand SVGs into the PNG icons + OG image that social
// platforms, iOS and Android require. The generated PNGs in public/ are
// committed, so this only needs to run when the artwork changes:
//   bun add -d sharp && bun scripts/gen-assets.mjs && bun remove sharp
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

// A pair of chunky nerd glasses over two buck teeth — the literal "dweeb"
// face. The lenses are rounded squares (which also echo Components V2
// "blocks") bridged by a brand-green nose piece, with short white temple
// stubs and a soft glass glint on each. Below them sit two front teeth
// (flat tops, rounded bottoms) for the full goofy-nerd grin.
// White-on-blurple with a Discord-green accent.
// Drawn back-to-front: arms + bridge first, lenses over them, glints, then
// the teeth in the clear blurple below. Authored on a 512 grid.
const mark = (radius) => `
  <rect width="512" height="512" rx="${radius}" fill="#5865F2"/>
  <rect x="40" y="210" width="52" height="30" rx="15" fill="#fff"/>
  <rect x="420" y="210" width="52" height="30" rx="15" fill="#fff"/>
  <rect x="214" y="200" width="84" height="30" rx="15" fill="#57F287"/>
  <rect x="78" y="182" width="148" height="148" rx="46" fill="#fff"/>
  <rect x="286" y="182" width="148" height="148" rx="46" fill="#fff"/>
  <rect x="104" y="202" width="20" height="62" rx="10" fill="#5865F2" opacity="0.16" transform="rotate(-26 114 233)"/>
  <rect x="312" y="202" width="20" height="62" rx="10" fill="#5865F2" opacity="0.16" transform="rotate(-26 322 233)"/>
  <path d="M226 360 h28 v24 a12 12 0 0 1 -12 12 h-4 a12 12 0 0 1 -12 -12 z" fill="#fff"/>
  <path d="M258 360 h28 v24 a12 12 0 0 1 -12 12 h-4 a12 12 0 0 1 -12 -12 z" fill="#fff"/>`;

const rounded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${mark(128)}</svg>`;
const fullBleed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${mark(0)}</svg>`;

// The OG banner is a minimalist brand card: a centered icon + wordmark
// lockup, a short brand-green rule, and two tight lines of type — what it is,
// then a playful brand-voice kicker. One soft blurple glow behind the mark
// gives depth without clutter; everything else is negative space. Centered on
// the 600px axis so the lockup stays perfectly balanced.
const og = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="glow" cx="50%" cy="32%" r="64%">
      <stop offset="0%" stop-color="#2c2f5e"/>
      <stop offset="62%" stop-color="#1a1b1e" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="1200" height="630" fill="#1a1b1e"/>
  <rect width="1200" height="630" fill="url(#glow)"/>

  <!-- centered mark -->
  <g transform="translate(544,128) scale(0.21875)">${mark(128)}</g>

  <!-- wordmark + brand-green rule -->
  <text x="600" y="350" text-anchor="middle" font-family="system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="108" font-weight="800" letter-spacing="6" fill="#ffffff">DWEEB</text>
  <rect x="564" y="380" width="72" height="5" rx="2.5" fill="#57F287"/>

  <!-- what it is -->
  <text x="600" y="450" text-anchor="middle" font-family="system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="31" font-weight="500" fill="#c7cad1">The visual builder for Discord webhooks &amp; Components V2</text>

  <!-- brand-voice kicker -->
  <text x="600" y="502" text-anchor="middle" font-family="system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="23" font-weight="600" letter-spacing="0.4" fill="#6f747c">Built by dweebs, for dweebs</text>
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
