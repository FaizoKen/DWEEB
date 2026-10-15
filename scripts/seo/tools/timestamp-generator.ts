/**
 * Static half of the Discord timestamp generator on
 * `/guides/discord-timestamp-format/`.
 *
 * The markup is a complete worked example on its own — the nine codes for one
 * fixed moment with the output an en-US reader in UTC sees — so the page still
 * answers the query with JavaScript off and for any crawler that does not run
 * it. `timestamp-generator.client.ts` (bundled at build time from the same
 * formatter the editor's preview uses) then makes the controls live, fills the
 * table for the visitor's own locale and timezone, and adds copy buttons.
 */

import { TIMESTAMP_STYLES, timestampToken } from "@/features/preview/markdown/timestamp";
import { escapeHtml } from "../render-message";
import { TOOL_BASE_CSS } from "./base";

/** 2026-01-01T00:00:00Z, the example the guide uses throughout. */
export const EXAMPLE_UNIX = 1767225600;

/**
 * What an en-US reader in UTC sees for {@link EXAMPLE_UNIX}. Written out rather
 * than computed because a build machine's own locale and zone would otherwise
 * leak into the page (the live tool renders the visitor's instead).
 */
export const EXAMPLE_OUTPUT: Readonly<Record<string, string>> = {
  t: "12:00 AM",
  T: "12:00:00 AM",
  d: "1/1/2026",
  D: "January 1, 2026",
  f: "January 1, 2026 at 12:00 AM",
  F: "Thursday, January 1, 2026 at 12:00 AM",
  s: "1/1/2026, 12:00 AM",
  S: "1/1/2026, 12:00:00 AM",
  R: "“in 2 days” / “2 hours ago”",
};

/** Where the bundled client script is published, relative to the site root. */
export const TIMESTAMP_TOOL_SCRIPT = "/tools/discord-timestamp-generator.js";

/** The tool's section. Its id is the anchor the guide and other pages link to. */
export function timestampGeneratorHtml(): string {
  // Every control ships in place, disabled and showing the example, so the
  // script only enables and fills it: revealing hidden controls after first
  // paint would shift the table below them on a slow connection (CLS).
  //
  // The explicit table roles are for phones: below 560px the rows restyle into
  // stacked cards (name + Copy, then the code, then what readers see) because a
  // four-column table left Copy and the preview off-screen at 390px. Changing a
  // row's `display` makes some engines drop the implicit table semantics, and
  // explicit roles keep a screen reader's row/column navigation intact.
  const rows = TIMESTAMP_STYLES.map(
    (style) =>
      `<tr role="row" data-ts-style="${style.code}"><th scope="row" role="rowheader">${escapeHtml(style.label)} <span class="tool-letter">${style.code}</span></th><td role="cell" class="tool-code-cell"><code data-ts-code>${escapeHtml(timestampToken(EXAMPLE_UNIX, style.code))}</code></td><td role="cell" data-ts-preview>${escapeHtml(EXAMPLE_OUTPUT[style.code] ?? "")}</td><td role="cell" class="tool-copy-cell"><button type="button" class="tool-btn tool-copy" data-ts-copy disabled>Copy</button></td></tr>`,
  ).join("");
  return `<section class="tool" id="timestamp-generator" aria-labelledby="timestamp-generator-heading" data-timestamp-tool>
        <h2 id="timestamp-generator-heading">Discord timestamp generator</h2>
        <p class="tool-intro">Pick a date and time in your own timezone, then copy the code for the style you want. Paste it into any Discord message, embed, webhook or bot reply and every reader sees it converted to their own timezone and language.</p>
        <div class="tool-controls">
          <div class="tool-fields">
            <label class="tool-field"><span>Date</span><input type="date" value="2026-01-01" data-ts-date disabled /></label>
            <label class="tool-field"><span>Time</span><input type="time" step="1" value="00:00:00" data-ts-time disabled /></label>
            <button type="button" class="tool-btn" data-ts-now disabled>Now</button>
          </div>
          <label class="tool-field tool-field-wide"><span>Or decode one: paste a unix timestamp or a &lt;t:…&gt; code</span><input type="text" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="1767225600 or &lt;t:1767225600:R&gt;" data-ts-raw disabled /></label>
        </div>
        <p class="tool-status" role="status" aria-live="polite" data-ts-status>Example: 1 January 2026, 00:00 UTC, as an en-US reader sees it. Turn on JavaScript to use your own date.</p>
        <div class="table-scroll tool-table" tabindex="0" role="region" aria-label="Discord timestamp codes">
          <table role="table">
            <caption class="sr-only">Discord timestamp codes for the chosen moment</caption>
            <thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Style</th><th scope="col" role="columnheader">Code to paste</th><th scope="col" role="columnheader">What readers see</th><th scope="col" role="columnheader"><span class="sr-only">Copy</span></th></tr></thead>
            <tbody role="rowgroup">${rows}</tbody>
          </table>
        </div>
        <p class="tool-note">Unix time <code data-ts-unix>${EXAMPLE_UNIX}</code> · <span data-ts-zone>shown in UTC</span></p>
      </section>`;
}

/** Tool styles, inlined only on the page that carries the tool. */
export const TIMESTAMP_TOOL_CSS = `${TOOL_BASE_CSS}
.tool-table{margin-top:10px}
.tool-table table{min-width:560px}
.tool-table th[scope="row"]{color:var(--text);font-weight:600;background:transparent;white-space:nowrap}
.tool-table code{font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e3e5e8;background:#1e1f22;border-radius:4px;padding:2px 6px;white-space:nowrap}
.tool-table tr[data-ts-active] td,.tool-table tr[data-ts-active] th{background:#2b2d55}
.tool-letter{display:inline-block;margin-left:6px;color:var(--dim);font:12px ui-monospace,Menlo,Consolas,monospace}
.tool-copy-cell{width:1%;white-space:nowrap}
@media(max-width:560px){
  .tool-table{overflow:visible;border:0;border-radius:0}
  .tool-table table{min-width:0;background:transparent}
  .tool-table thead{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
  .tool-table tr{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"style copy" "code code" "preview preview";align-items:center;gap:8px 12px;padding:12px 14px;margin-bottom:8px;background:var(--panel);border:1px solid var(--border);border-radius:10px}
  .tool-table th[scope="row"],.tool-table td{padding:0;border:0;background:transparent}
  .tool-table th[scope="row"]{grid-area:style;white-space:normal}
  .tool-table .tool-code-cell{grid-area:code}
  .tool-table td[data-ts-preview]{grid-area:preview;color:var(--text)}
  .tool-table td[data-ts-preview]::before{content:"Readers see: " / "";color:var(--dim)}
  .tool-table .tool-copy-cell{grid-area:copy;width:auto}
  .tool-table code{white-space:normal;overflow-wrap:anywhere}
  .tool-table .tool-copy{min-height:40px}
  .tool-table tr[data-ts-active]{background:#2b2d55}
}
`;
