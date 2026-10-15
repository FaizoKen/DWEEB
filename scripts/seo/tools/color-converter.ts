/**
 * Static half of the Discord color converter on `/guides/discord-color-codes/`.
 *
 * Every Discord color field — an embed's `color`, a Components V2 container's
 * `accent_color`, a role's color — is one integer, so the same color keeps
 * being converted between the hex a design tool shows, the decimal a JSON body
 * needs and the `0x` literal code uses. Searchers paste raw values
 * ("0x5865f2", "0x57f287" reached DWEEB's pages in Search Console) looking for
 * exactly this.
 *
 * The markup ships complete, showing Blurple in every form, so the section is
 * a worked example with JavaScript off; `color-converter.client.ts` makes the
 * input live and the swatches clickable. Controls ship disabled (no CLS).
 */

import { colorFormats, readableOn } from "@/core/color/colorCode";
import { withClientParams } from "@/core/seo/clientParams";
import { attr } from "../layout";
import { escapeHtml } from "../render-message";
import { TOOL_BASE_CSS } from "./base";
import { BRAND_COLORS, PALETTE_2021, ROLE_PRESETS, type NamedColor } from "./color-data";

/** Where the bundled client script is published, relative to the site root. */
export const COLOR_CONVERTER_SCRIPT = "/tools/discord-color-converter.js";

const OPEN_HREF = withClientParams("/", { entry: "guide:discord-color-codes" });
const START = 0x5865f2;

function swatches(label: string, colors: readonly NamedColor[]): string {
  const buttons = colors
    .map((color) => {
      const { hex } = colorFormats(color.value);
      const name = `${color.name} ${hex}`;
      return `<button type="button" class="cc-swatch" style="background:${hex}" data-cc-swatch="${color.value}" aria-label="${attr(name)}" title="${attr(name)}" disabled></button>`;
    })
    .join("");
  return `<div class="cc-palette"><span class="cc-palette-label">${escapeHtml(label)}</span><span class="cc-swatches">${buttons}</span></div>`;
}

function row(key: string, label: string, value: string, note: string): string {
  return `<tr><th scope="row">${label}</th><td><code data-cc-out="${key}">${escapeHtml(value)}</code></td><td class="cc-note">${note}</td><td class="tool-copy-cell"><button type="button" class="tool-btn tool-copy" data-cc-copy="${key}" disabled>Copy</button></td></tr>`;
}

export function colorConverterHtml(): string {
  const f = colorFormats(START);
  const ink = readableOn(START);
  return `<section class="tool" id="color-converter" aria-labelledby="color-converter-heading" data-cc-tool>
        <h2 id="color-converter-heading">Discord color converter</h2>
        <p class="tool-intro">Paste a color in any form — <code>#5865F2</code>, <code>0x5865F2</code>, <code>5793266</code> or <code>rgb(88, 101, 242)</code> — or pick one, and copy it in the form you need. Discord's JSON takes the decimal number.</p>
        <div class="cc-controls">
          <label class="tool-field"><span>Color</span><input type="text" value="${f.hex}" autocomplete="off" spellcheck="false" data-cc-input disabled /></label>
          <label class="tool-field cc-picker"><span>Pick</span><input type="color" value="${f.hex.toLowerCase()}" data-cc-picker disabled /></label>
          <div class="cc-sample" data-cc-sample style="background:${f.hex};color:${ink}" aria-hidden="true">Aa</div>
        </div>
        <p class="tool-status" role="status" aria-live="polite" data-cc-status>Blurple, Discord's brand color.</p>
        <div class="table-scroll cc-table" tabindex="0" role="region" aria-label="The color in each format">
          <table>
            <caption class="sr-only">The chosen color in each format Discord and its libraries use</caption>
            <thead><tr><th scope="col">Format</th><th scope="col">Value</th><th scope="col">Where it goes</th><th scope="col"><span class="sr-only">Copy</span></th></tr></thead>
            <tbody>
              ${row("decimal", "Decimal", f.decimal, "JSON: an embed's <code>color</code>, a container's <code>accent_color</code>")}
              ${row("hex", "Hex", f.hex, "Discord's role color field, design tools, CSS")}
              ${row("literal", "Code literal", f.literal, "discord.js, discord.py and most languages")}
              ${row("rgb", "RGB", f.rgb, "Image editors and CSS")}
            </tbody>
          </table>
        </div>
        <div class="cc-preview" aria-label="Accent preview">
          <div class="cc-card" data-cc-card style="border-left-color:${f.hex}"><strong>Your card's accent</strong><span>This is the stripe an embed or a Components V2 container shows in this color.</span></div>
        </div>
        ${swatches("Discord brand", BRAND_COLORS)}
        ${swatches("2021 palette", PALETTE_2021)}
        ${swatches("Role colors", ROLE_PRESETS)}
        <div class="cc-actions"><a class="tool-btn tool-copy cc-open" href="${attr(OPEN_HREF)}" data-cc-open data-analytics="guide" data-analytics-id="discord-color-codes" data-analytics-location="body">Open a card in this color in DWEEB</a></div>
      </section>`;
}

export const COLOR_CONVERTER_CSS = `${TOOL_BASE_CSS}
.cc-controls{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-bottom:8px}
.cc-controls .tool-field input[type=text]{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;width:240px}
.cc-picker input{width:64px;padding:4px;cursor:pointer}
.cc-sample{width:64px;height:42px;border-radius:8px;border:1px solid rgba(255,255,255,.2);display:grid;place-items:center;font-weight:700}
.cc-table table{min-width:520px}
.cc-table code{font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e3e5e8;background:#1e1f22;border-radius:4px;padding:2px 6px;white-space:nowrap}
.cc-table th[scope=row]{white-space:nowrap}
.cc-note{color:var(--muted);font-size:14px}
.cc-note code{font-size:12px;padding:1px 4px}
.cc-preview{margin:14px 0;padding:14px;background:#313338;border:1px solid var(--border);border-radius:10px}
.cc-card{display:flex;flex-direction:column;gap:4px;padding:12px 14px;background:#2b2d31;border-radius:8px;border-left:4px solid #5865f2;color:#dbdee1;font-size:15px}
.cc-card span{color:#b5bac1;font-size:14px}
.cc-palette{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:8px 0}
.cc-palette-label{font-size:13px;font-weight:600;color:var(--dim);min-width:110px}
.cc-swatches{display:inline-flex;flex-wrap:wrap;gap:5px}
.cc-swatch{width:28px;height:28px;border-radius:6px;border:1px solid rgba(255,255,255,.28);cursor:pointer;padding:0}
.cc-swatch:focus-visible{outline:2px solid #a6baff;outline-offset:2px}
.cc-swatch:disabled{cursor:default}
.cc-actions{margin-top:12px}
.cc-open{display:inline-flex;align-items:center;text-decoration:none;min-height:34px;padding:6px 14px}
@media(max-width:560px){.cc-palette-label{width:100%}.cc-controls .tool-field input[type=text]{width:100%}}
`;
