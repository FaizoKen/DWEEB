/**
 * Static half of the Discord colored text generator on
 * `/guides/discord-colored-text/`.
 *
 * Why it exists: "discord colored text" is a large search family DWEEB had no
 * page for, and the pages that answer it describe the 2022 feature — eight
 * fixed colors, "30 = gray", backgrounds called "firefly dark blue". Discord
 * moved the colors into its themes in August 2026 and, from October, started
 * rolling out a renderer that adds bright, 256-color and RGB colors, italic and
 * strikethrough (see `src/features/preview/markdown/ansi.ts`, measured off
 * discord.com). This tool writes for both renderers and says which parts only
 * the newer one draws.
 *
 * The markup ships complete — the example in the input, its rendering in the
 * preview, and its escape codes — so the section is a worked example with
 * JavaScript off. `colored-text.client.ts` makes it live; every control ships
 * disabled and is only enabled by the script (no layout shift).
 */

import { ANSI_COLOR_NAMES, ANSI_PALETTES, encodeAnsi } from "@/features/preview/markdown/ansi";
import { withClientParams } from "@/core/seo/clientParams";
import { attr } from "../layout";
import { TOOL_BASE_CSS } from "./base";
import {
  ANSI_THEMES,
  DEFAULT_ANSI_THEME,
  ansiSegmentsHtml,
  ansiStringLiteral,
  escapeAnsiText,
} from "./ansi-html";
import { COLORED_TEXT_SAMPLE } from "./colored-text-sample";

/** Where the bundled client script is published, relative to the site root. */
export const COLORED_TEXT_SCRIPT = "/tools/discord-colored-text-generator.js";

/** The builder, attributed to this guide; the script swaps in a link carrying the text. */
const OPEN_HREF = withClientParams("/", { entry: "guide:discord-colored-text" });

function swatch(kind: "fg" | "bg", index: number): string {
  const name = ANSI_COLOR_NAMES[index] ?? "";
  const code =
    kind === "fg" ? (index < 8 ? 30 + index : 82 + index) : index < 8 ? 40 + index : 92 + index;
  const label = `${kind === "fg" ? "Text" : "Background"} color: ${name} (${code})`;
  const color = ANSI_PALETTES[DEFAULT_ANSI_THEME][index] ?? "#4e5058";
  return `<button type="button" class="ansi-swatch" style="background:${color}" data-ansi-${kind}="${index}" aria-label="${attr(label)}" title="${attr(label)}" disabled></button>`;
}

function swatchRow(kind: "fg" | "bg"): string {
  const basic = Array.from({ length: 8 }, (_, i) => swatch(kind, i)).join("");
  const bright = Array.from({ length: 8 }, (_, i) => swatch(kind, i + 8)).join("");
  const label = kind === "fg" ? "Text color" : "Background";
  return `<div class="ansi-row" role="group" aria-label="${label}">
            <span class="ansi-row-label">${label}</span>
            <button type="button" class="ansi-chip" data-ansi-${kind}="none" disabled>None</button>
            <span class="ansi-swatches">${basic}</span>
            <span class="ansi-swatches ansi-newer" title="Drawn by Discord's newer renderer only">${bright}</span>
            <label class="ansi-custom ansi-newer"><span>Custom</span><input type="color" value="${kind === "fg" ? "#ff7a00" : "#3b2a66"}" data-ansi-${kind}-custom aria-label="${label}: custom RGB color" disabled></label>
          </div>`;
}

export function coloredTextHtml(): string {
  const ansi = encodeAnsi(COLORED_TEXT_SAMPLE);
  const themeOptions = ANSI_THEMES.map(
    (theme) =>
      `<option value="${theme.id}"${theme.id === DEFAULT_ANSI_THEME ? " selected" : ""}>${theme.label}</option>`,
  ).join("");
  return `<section class="tool" id="colored-text-generator" aria-labelledby="colored-text-heading" data-ansi-tool>
        <h2 id="colored-text-heading">Discord colored text generator</h2>
        <p class="tool-intro">Type your message, select part of it and pick a color or a style. Then press <strong>Copy for Discord</strong> and paste: the copy is wrapped in the <code>ansi</code> code block Discord colors, with the invisible escape codes already in place. Pasting colored text you copied out of a Discord message brings its colors back in.</p>
        <div class="ansi-toolbar" role="toolbar" aria-label="Formatting for the selected text">
          <div class="ansi-row" role="group" aria-label="Style">
            <span class="ansi-row-label">Style</span>
            <button type="button" class="ansi-chip" data-ansi-style="bold" aria-pressed="false" disabled><b>Bold</b></button>
            <button type="button" class="ansi-chip" data-ansi-style="underline" aria-pressed="false" disabled><u>Underline</u></button>
            <button type="button" class="ansi-chip ansi-newer" data-ansi-style="italic" aria-pressed="false" disabled><i>Italic</i></button>
            <button type="button" class="ansi-chip ansi-newer" data-ansi-style="strike" aria-pressed="false" disabled><s>Strikethrough</s></button>
            <button type="button" class="ansi-chip" data-ansi-clear disabled>Clear formatting</button>
          </div>
          ${swatchRow("fg")}
          ${swatchRow("bg")}
        </div>
        <div class="ansi-grid">
          <div class="ansi-pane">
            <span class="ansi-label" id="colored-text-input-label">Your text <span class="ansi-hint">— select some, then pick a style</span></span>
            <div class="ansi-editor" role="textbox" aria-multiline="true" aria-labelledby="colored-text-input-label" spellcheck="false" data-ansi-editor>${ansiSegmentsHtml(COLORED_TEXT_SAMPLE, DEFAULT_ANSI_THEME, true)}</div>
          </div>
          <div class="ansi-pane">
            <span class="ansi-label" id="colored-text-preview-label">How it looks in Discord</span>
            <div class="ansi-message" data-ansi-surface data-theme="${DEFAULT_ANSI_THEME}">
              <pre class="ansi-preview" role="region" aria-labelledby="colored-text-preview-label" aria-live="polite"><code data-ansi-preview>${ansiSegmentsHtml(COLORED_TEXT_SAMPLE, DEFAULT_ANSI_THEME)}</code></pre>
            </div>
            <label class="tool-field ansi-theme"><span>Discord theme</span><select data-ansi-theme disabled>${themeOptions}</select></label>
          </div>
        </div>
        <div class="ansi-actions">
          <button type="button" class="tool-btn" data-ansi-copy disabled>Copy for Discord</button>
          <button type="button" class="tool-btn tool-copy" data-ansi-copy-code disabled>Copy for a bot or webhook</button>
          <a class="tool-btn tool-copy ansi-open" href="${attr(OPEN_HREF)}" data-ansi-open data-analytics="guide" data-analytics-id="discord-colored-text" data-analytics-location="body">Open in DWEEB</a>
          <button type="button" class="tool-btn tool-copy" data-ansi-reset disabled>Reset example</button>
          <button type="button" class="tool-btn tool-copy" data-ansi-empty disabled>Clear</button>
        </div>
        <p class="tool-status" role="status" aria-live="polite" data-ansi-status><span data-ansi-count>${ansi.length + 12}</span> characters with the code block and escape codes · a message allows 2,000 (4,000 with Nitro or in a webhook's Components V2 text).</p>
        <div class="ansi-code">
          <span class="ansi-label" id="colored-text-code-label">The same text as a string for a bot or webhook JSON</span>
          <pre aria-labelledby="colored-text-code-label"><code data-ansi-literal>${escapeAnsiText(ansiStringLiteral(ansi))}</code></pre>
        </div>
        <p class="tool-note"><span class="ansi-newer-mark" aria-hidden="true">✦</span> Bright and custom colors, italic and strikethrough are drawn by Discord's newer code renderer, which Discord has been rolling out since October 2026; a reader still on the older one sees those parts as plain text. Discord's phone apps have long shown colored code blocks without the colors, so never let color carry the meaning on its own.</p>
      </section>`;
}

export const COLORED_TEXT_CSS = `${TOOL_BASE_CSS}
.ansi-toolbar{display:grid;gap:10px;margin-bottom:14px}
.ansi-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}
.ansi-row-label{font-size:13px;font-weight:600;color:var(--dim);min-width:92px}
.ansi-swatches{display:inline-flex;flex-wrap:wrap;gap:4px}
.ansi-swatch{width:28px;height:28px;border-radius:6px;border:1px solid rgba(255,255,255,.28);background:#4e5058;cursor:pointer;padding:0}
.ansi-swatch:focus-visible,.ansi-chip:focus-visible,.ansi-custom input:focus-visible{outline:2px solid #a6baff;outline-offset:2px}
.ansi-swatch:disabled,.ansi-chip:disabled{cursor:default}
.ansi-chip{font:inherit;font-size:13px;color:var(--text);background:#2b2d31;border:1px solid var(--border);border-radius:8px;padding:5px 10px;min-height:32px;cursor:pointer}
.ansi-chip[aria-pressed="true"]{background:#3c4270;border-color:#7984f5}
.ansi-custom{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--dim)}
.ansi-custom input{width:40px;height:30px;padding:0 2px;border:1px solid var(--border);border-radius:6px;background:#1e1f22;cursor:pointer}
.ansi-newer{position:relative}
.ansi-swatches.ansi-newer::before,.ansi-custom.ansi-newer::before,.ansi-chip.ansi-newer::after{content:"✦";color:#f0b232;font-size:11px}
.ansi-swatches.ansi-newer::before{align-self:center;margin-right:2px}
.ansi-chip.ansi-newer::after{margin-left:4px}
.ansi-newer-mark{color:#f0b232}
.ansi-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start}
.ansi-pane{display:flex;flex-direction:column;gap:6px;min-width:0}
.ansi-label{font-size:13px;font-weight:600;color:var(--dim)}
.ansi-hint{font-weight:400}
.ansi-editor,.ansi-preview{font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
.ansi-editor{min-height:200px;padding:10px 12px;color:#e4e4e6;background:#1e1f22;border:1px solid var(--border);border-radius:8px;outline:none}
.ansi-editor[contenteditable="true"]:focus{outline:2px solid #a6baff;outline-offset:1px}
.ansi-message{padding:12px;border-radius:8px;border:1px solid var(--border)}
.ansi-preview{padding:8px 10px;border-radius:4px;background:rgba(89,102,242,.08);border:1px solid rgba(150,150,160,.2);min-height:176px}
${ANSI_THEMES.map((t) => `.ansi-message[data-theme="${t.id}"]{background:${t.surface};color:${t.text}}`).join("\n")}
.ansi-theme{margin-top:4px}
.ansi-theme select{max-width:200px}
.ansi-actions{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 6px}
.ansi-open{display:inline-flex;align-items:center;text-decoration:none;min-height:34px;padding:6px 14px}
.ansi-code{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.ansi-code pre{margin:0;padding:10px 12px;background:#1e1f22;border:1px solid var(--border);border-radius:8px;overflow-x:auto}
.ansi-code code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e3e5e8;white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:760px){.ansi-grid{grid-template-columns:minmax(0,1fr)}.ansi-row-label{min-width:0;width:100%}.ansi-editor{min-height:160px}.ansi-preview{min-height:0}}
`;
