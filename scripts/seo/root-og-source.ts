/** Pure SVG sources shared by the one-off brand generator and the SEO audit. */

// A pair of chunky nerd glasses over two buck teeth — the literal "dweeb"
// face. Authored on a 512 grid; `radius=0` produces the maskable full bleed.
export const brandMarkSvg = (radius: number): string => `
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

export const ROUNDED_BRAND_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${brandMarkSvg(128)}</svg>`;
export const FULL_BLEED_BRAND_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${brandMarkSvg(0)}</svg>`;

// Keep the product/category line aligned with the root page's current search
// positioning. Its exact source bytes are fingerprinted in root-og.json.
export const ROOT_OG_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="glow" cx="50%" cy="32%" r="64%">
      <stop offset="0%" stop-color="#2c2f5e"/>
      <stop offset="62%" stop-color="#1a1b1e" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="1200" height="630" fill="#1a1b1e"/>
  <rect width="1200" height="630" fill="url(#glow)"/>

  <!-- centered mark -->
  <g transform="translate(544,128) scale(0.21875)">${brandMarkSvg(128)}</g>

  <!-- wordmark + brand-green rule -->
  <text x="600" y="350" text-anchor="middle" font-family="system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="108" font-weight="800" letter-spacing="6" fill="#ffffff">DWEEB</text>
  <rect x="564" y="380" width="72" height="5" rx="2.5" fill="#57F287"/>

  <!-- what it is -->
  <text x="600" y="450" text-anchor="middle" font-family="system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="31" font-weight="500" fill="#c7cad1">Discord Message Builder · Live preview, JSON &amp; webhooks</text>

  <!-- brand-voice kicker -->
  <text x="600" y="502" text-anchor="middle" font-family="system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="23" font-weight="600" letter-spacing="0.4" fill="#6f747c">Built by dweebs, for dweebs</text>
</svg>`;
