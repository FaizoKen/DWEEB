/**
 * The Discord server rules generator on `/guides/discord-server-rules/`.
 *
 * Search Console (28 days to 2026-10-13) shows the rules cluster split across
 * two pages at positions 9-11 — "discord rules template" (317 impressions),
 * "discord server rules template" (141, no clicks), the copy-and-paste
 * variants — plus a generator tail the site did not answer: "discord rules
 * generator", "discord rule generator", "discord rules maker", "discord server
 * rules generator", where the template page that caught them still earned clicks
 * at position ~10. The guide already carries five fixed rule sets; this lets a
 * visitor tick the rules their server needs and get one ready-to-paste post.
 *
 * Everything here is shared by the build and the bundled client: the rule list,
 * the composer, and the defaults. The page ships with the default selection
 * already composed and rendered, so the section reads as a complete rules
 * template with JavaScript off.
 */

import { withClientParams } from "@/core/seo/clientParams";
import { attr } from "../layout";
import { escapeHtml } from "../render-message";
import { TOOL_BASE_CSS } from "./base";
import { MARKDOWN_HTML_CSS, renderDiscordMarkdownHtml } from "./markdown-html";
import {
  composeRules,
  DEFAULT_RULES_OPTIONS,
  RULE_OPTIONS,
  RULES_GENERATOR_ENTRY,
} from "./rules-data";

export const RULES_GENERATOR_SCRIPT = "/tools/discord-rules-generator.js";
const OPEN_HREF = withClientParams("/", { entry: RULES_GENERATOR_ENTRY });

export function rulesGeneratorHtml(): string {
  const source = composeRules(DEFAULT_RULES_OPTIONS);
  // A static build has no "today", so the shipped example leaves the date out;
  // the script turns the box on with the visitor's own date.
  const preview = renderDiscordMarkdownHtml(source, () => "");
  const groups = [...new Set(RULE_OPTIONS.map((rule) => rule.group))];
  const checkboxes = groups
    .map(
      (group) =>
        `<fieldset class="rg-group"><legend>${escapeHtml(group)}</legend>${RULE_OPTIONS.filter(
          (rule) => rule.group === group,
        )
          .map(
            (rule) =>
              `<label class="rg-check"><input type="checkbox" value="${attr(rule.id)}" data-rg-rule${rule.default ? " checked" : ""} disabled /><span><strong>${escapeHtml(rule.title)}</strong> ${escapeHtml(rule.text)}</span></label>`,
          )
          .join("")}</fieldset>`,
    )
    .join("");
  return `<section class="tool" id="rules-generator" aria-labelledby="rules-generator-heading" data-rg-tool>
        <h2 id="rules-generator-heading">Discord rules generator</h2>
        <p class="tool-intro">Tick the rules your server needs, pick a numbering style, and copy one ready-to-paste rules post — Discord formatting included. The preview uses DWEEB's message parser, so it shows what members will see.</p>
        <div class="rg-grid">
          <div class="rg-options">
            <div class="tool-fields">
              <label class="tool-field rg-wide"><span>Title</span><input type="text" maxlength="80" value="${attr(DEFAULT_RULES_OPTIONS.title)}" data-rg-title disabled /></label>
              <label class="tool-field"><span>Numbers</span><select data-rg-numbers disabled><option value="bold" selected>Bold numbers (1.)</option><option value="emoji">Emoji numbers (1️⃣)</option><option value="list">Discord list</option></select></label>
              <label class="tool-field"><span>Consequences</span><select data-rg-consequences disabled><option value="ladder" selected>Warning → timeout → ban</option><option value="strict">One warning, then a ban</option><option value="none">Leave out</option></select></label>
              <label class="tool-field rg-wide"><span>Footer</span><input type="text" maxlength="120" value="${attr(DEFAULT_RULES_OPTIONS.contact)}" data-rg-contact disabled /></label>
              <label class="rg-check rg-wide"><input type="checkbox" data-rg-date disabled /><span>Add a "last updated" date that shows in each reader's own format</span></label>
            </div>
            ${checkboxes}
          </div>
          <div class="rg-result">
            <label class="tool-field"><span>Your rules post (Discord markdown)</span><textarea rows="14" spellcheck="false" readonly data-rg-output>${escapeHtml(source)}</textarea></label>
            <div class="rg-actions">
              <button type="button" class="tool-btn" data-rg-copy disabled>Copy rules</button>
              <a class="tool-btn tool-copy rg-open" href="${attr(OPEN_HREF)}" data-rg-open data-analytics="guide" data-analytics-id="discord-server-rules" data-analytics-location="body">Open as a card in DWEEB</a>
            </div>
            <p class="tool-status" role="status" aria-live="polite" data-rg-status><span data-rg-count>${source.length}</span> characters · fits one Discord message (2,000)</p>
            <span class="rg-label" id="rules-generator-preview-label">Preview</span>
            <div class="md-msg" role="region" aria-labelledby="rules-generator-preview-label" data-rg-preview>${preview}</div>
          </div>
        </div>
      </section>`;
}

export const RULES_GENERATOR_CSS = `${TOOL_BASE_CSS}${MARKDOWN_HTML_CSS}
.rg-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px;align-items:start}
.rg-options .tool-fields{margin-bottom:12px}
.rg-options .tool-field{flex:1 1 180px}
.rg-wide{flex-basis:100% !important}
.rg-group{border:1px solid var(--border);border-radius:10px;padding:8px 12px 10px;margin:0 0 10px}
.rg-group legend{font-size:13px;font-weight:700;color:var(--dim);padding:0 4px}
.rg-check{display:flex;gap:9px;align-items:flex-start;font-size:14px;color:var(--muted);padding:5px 0;cursor:pointer}
.rg-check input{margin-top:3px;width:16px;height:16px;flex:none;accent-color:var(--accent)}
.rg-check strong{color:var(--text)}
.rg-result{position:sticky;top:76px;display:flex;flex-direction:column;gap:8px;min-width:0}
.rg-result textarea{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--text);background:#1e1f22;border:1px solid var(--border);border-radius:8px;padding:10px 12px;width:100%;resize:vertical;color-scheme:dark;font-weight:400}
.rg-actions{display:flex;flex-wrap:wrap;gap:8px}
.rg-open{display:inline-flex;align-items:center;text-decoration:none;min-height:42px;padding:9px 16px}
.rg-label{font-size:13px;font-weight:600;color:var(--dim)}
.tool-status[data-over]{color:#f0b232}
@media(max-width:860px){.rg-grid{grid-template-columns:minmax(0,1fr)}.rg-result{position:static}}
`;
