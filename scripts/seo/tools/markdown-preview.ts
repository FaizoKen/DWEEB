/**
 * Static half of the live Discord markdown preview on
 * `/guides/discord-text-formatting/`.
 *
 * Search Console (2026-10-15, 28 days) put this guide at 1,350 impressions
 * across 239 queries at an average position of 14.8 with almost no clicks: the
 * head terms ("discord text formatting", "discord markdown", "discord
 * formatting") sit at 20-33 behind Discord's own Markdown Text 101, and the
 * tail asks for exactly what that article cannot do — "discord markdown live
 * preview", "discord text preview", "discord formatting test", "discord message
 * previewer". A reference table answers what the syntax is; this answers what
 * *my* message will look like, using the parser the editor's preview runs.
 *
 * The markup ships complete: the sample source in the textarea and its rendered
 * preview, both computed at build time, so the section is a worked example with
 * JavaScript off. `markdown-preview.client.ts` then makes it live.
 */

import { withClientParams } from "@/core/seo/clientParams";
import { attr } from "../layout";
import { escapeHtml } from "../render-message";
import { TOOL_BASE_CSS } from "./base";
import { MARKDOWN_HTML_CSS, renderDiscordMarkdownHtml } from "./markdown-html";
import { EXAMPLE_OUTPUT, EXAMPLE_UNIX } from "./timestamp-generator";

/** Where the bundled client script is published, relative to the site root. */
export const MARKDOWN_PREVIEW_SCRIPT = "/tools/discord-markdown-preview.js";

/** The builder, attributed to this guide; the script swaps in a link carrying the text. */
export const MARKDOWN_PREVIEW_OPEN_HREF = withClientParams("/", {
  entry: "guide:discord-text-formatting",
});

/**
 * The example every visitor starts from: one line per rule a searcher asks
 * about, so the first paint already shows headers, subtext, lists, quotes,
 * spoilers, code, a masked link and a timestamp side by side with their source.
 */
export const MARKDOWN_PREVIEW_SAMPLE = `# Big header
## Medium header
### Small header
**bold**, *italic*, __underline__, ~~strikethrough~~ and ||a spoiler||
***bold italic*** and __*underlined italic*__
-# Subtext: small, muted footnote text
> A quote block
- A bullet point
  - A nested bullet

1. A numbered item
2. Another numbered item
\`inline code\` and a [masked link](https://dweeb.faizo.net)
Event starts <t:${EXAMPLE_UNIX}:F> (<t:${EXAMPLE_UNIX}:R>)
\`\`\`
A code block — **markdown** stays literal in here
\`\`\``;

/** The build renders timestamps as an en-US reader in UTC sees them, like the generator. */
function staticTimestamp(_unix: number, style: string): string {
  return style === "R" ? "in 2 days" : (EXAMPLE_OUTPUT[style] ?? EXAMPLE_OUTPUT.f ?? "");
}

export function markdownPreviewHtml(): string {
  const preview = renderDiscordMarkdownHtml(MARKDOWN_PREVIEW_SAMPLE, staticTimestamp);
  // The controls ship disabled and the script only enables them, so nothing
  // appears after first paint and shifts the article below (CLS).
  return `<section class="tool" id="markdown-preview" aria-labelledby="markdown-preview-heading" data-md-tool>
        <h2 id="markdown-preview-heading">Live Discord markdown preview</h2>
        <p class="tool-intro">Type or paste a message on the left and see how Discord formats it on the right — headers, subtext, lists, spoilers, code blocks, masked links and timestamps included. It uses the same parser as DWEEB's message preview, which is tested against the live Discord client.</p>
        <div class="md-tool-grid">
          <label class="tool-field md-tool-input"><span>Your message</span><textarea rows="16" spellcheck="false" data-md-input disabled>${escapeHtml(MARKDOWN_PREVIEW_SAMPLE)}</textarea></label>
          <div class="md-tool-output">
            <span class="md-tool-label" id="markdown-preview-output-label">How Discord shows it</span>
            <div class="md-msg" role="region" aria-labelledby="markdown-preview-output-label" aria-live="polite" data-md-output>${preview}</div>
          </div>
        </div>
        <div class="md-tool-actions">
          <button type="button" class="tool-btn tool-copy" data-md-copy disabled>Copy text</button>
          <button type="button" class="tool-btn tool-copy" data-md-reset disabled>Reset example</button>
          <button type="button" class="tool-btn tool-copy" data-md-clear disabled>Clear</button>
          <a class="tool-btn md-tool-open" href="${attr(MARKDOWN_PREVIEW_OPEN_HREF)}" data-md-open data-analytics="guide" data-analytics-id="discord-text-formatting" data-analytics-location="body">Open in DWEEB</a>
        </div>
        <p class="tool-status" role="status" aria-live="polite" data-md-status><span data-md-count>${MARKDOWN_PREVIEW_SAMPLE.length}</span> characters · a normal message allows 2,000 (4,000 with Nitro); a webhook's Components V2 message allows 4,000 across all its text.</p>
      </section>`;
}

export const MARKDOWN_PREVIEW_CSS = `${TOOL_BASE_CSS}${MARKDOWN_HTML_CSS}
.md-tool-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start}
.md-tool-input textarea{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:400;color:var(--text);background:#1e1f22;border:1px solid var(--border);border-radius:8px;padding:10px 12px;width:100%;min-height:340px;resize:vertical;color-scheme:dark}
.md-tool-input textarea:focus{outline:2px solid #a6baff;outline-offset:1px}
.md-tool-input textarea:disabled{opacity:.8}
.md-tool-output{display:flex;flex-direction:column;gap:5px;min-width:0}
.md-tool-label{font-size:13px;font-weight:600;color:var(--dim)}
.md-tool-actions{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 6px}
.md-tool-open{display:inline-flex;align-items:center;text-decoration:none;min-height:34px;padding:6px 14px}
@media(max-width:760px){.md-tool-grid{grid-template-columns:minmax(0,1fr)}.md-tool-input textarea{min-height:220px}}
`;
