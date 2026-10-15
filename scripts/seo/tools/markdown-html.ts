/**
 * Discord markdown → safe HTML, from the editor's own parser.
 *
 * Shared by the markdown previewer and the rules generator on the static guide
 * pages: the build renders each tool's worked example with it, and the bundled
 * client script re-renders as the visitor types. Both halves walk the AST that
 * `parseMarkdown` produces — the same parser the editor's preview runs, with its
 * Discord-verified quirks (`*` needs a non-space opener, `_` needs word
 * boundaries, ordered items merging into a preceding bullet list…) — so what
 * this shows is what DWEEB shows, not a generic markdown dialect.
 *
 * Safety is by construction, because the client assigns the result to
 * `innerHTML`: every text value goes through `escapeHtml`, nothing from the
 * input ever becomes an attribute except a timestamp's ISO date (computed, not
 * copied), and links render as non-navigating spans exactly like the editor's
 * preview — so no URL a visitor types is ever made clickable on our origin.
 *
 * Headings render as `div[role=heading]`, never `<h*>`: the output sits inside
 * a guide whose outline belongs to the article, and message text must never
 * compete with the page's headings.
 */

import { parseMarkdown, type BlockNode, type InlineNode } from "@/features/preview/markdown/parse";

/** Renders a timestamp token's visible text; injected so the build stays locale-free. */
export type TimestampFormatter = (unix: number, style: string) => string;

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

const GUILD_NAV_LABEL: Record<string, string> = {
  customize: "Channels & Roles",
  browse: "Browse Channels",
  guide: "Server Guide",
  "linked-roles": "Linked Roles",
};

function inline(nodes: InlineNode[], ts: TimestampFormatter): string {
  return nodes.map((node) => inlineNode(node, ts)).join("");
}

function inlineNode(node: InlineNode, ts: TimestampFormatter): string {
  switch (node.kind) {
    case "text":
      return esc(node.value);
    case "break":
      return "<br>";
    case "bold":
      return `<strong>${inline(node.children, ts)}</strong>`;
    case "italic":
      return `<em>${inline(node.children, ts)}</em>`;
    case "underline":
      return `<u>${inline(node.children, ts)}</u>`;
    case "strike":
      return `<s>${inline(node.children, ts)}</s>`;
    case "spoiler":
      return `<span class="md-spoiler" tabindex="0" title="Spoiler — click to reveal">${inline(node.children, ts)}</span>`;
    case "code":
      return `<code class="md-code">${esc(node.value)}</code>`;
    case "link":
      return `<span class="md-link">${inline(node.children, ts)}</span>`;
    case "mention": {
      if (node.mention === "everyone" || node.mention === "here") {
        return `<span class="md-mention">@${node.mention}</span>`;
      }
      const tail = esc(node.id.slice(-4));
      const label =
        node.mention === "user"
          ? `@user-${tail}`
          : node.mention === "role"
            ? `@role-${tail}`
            : `#channel-${tail}`;
      return `<span class="md-mention">${label}</span>`;
    }
    case "guildNav":
      return `<span class="md-mention">${esc(GUILD_NAV_LABEL[node.nav] ?? node.nav)}</span>`;
    case "emoji":
      return `<span class="md-emoji-name">:${esc(node.name)}:</span>`;
    case "timestamp":
      return `<time class="md-time" datetime="${new Date(node.unix * 1000).toISOString()}">${esc(ts(node.unix, node.style))}</time>`;
  }
}

function blocks(nodes: BlockNode[], ts: TimestampFormatter): string {
  return nodes.map((node) => block(node, ts)).join("");
}

function block(node: BlockNode, ts: TimestampFormatter): string {
  switch (node.kind) {
    case "paragraph":
      return `<p class="md-p">${inline(node.children, ts)}</p>`;
    case "heading":
      return `<div class="md-h md-h${node.level}" role="heading" aria-level="${node.level + 2}">${inline(node.children, ts)}</div>`;
    case "subtext":
      return `<p class="md-sub">${inline(node.children, ts)}</p>`;
    case "quote":
      return `<blockquote class="md-quote">${blocks(node.children, ts)}</blockquote>`;
    case "list": {
      const items = node.items
        .map((item) => `<li>${inline(item.content, ts)}${blocks(item.children, ts)}</li>`)
        .join("");
      return node.ordered
        ? `<ol class="md-list"${node.start !== undefined && node.start !== 1 ? ` start="${Math.trunc(node.start)}"` : ""}>${items}</ol>`
        : `<ul class="md-list">${items}</ul>`;
    }
    case "codeblock":
      return `<pre class="md-pre"><code>${esc(node.value)}</code></pre>`;
  }
}

/** Render Discord markdown the way DWEEB's preview reads it, as escaped HTML. */
export function renderDiscordMarkdownHtml(source: string, ts: TimestampFormatter): string {
  return blocks(parseMarkdown(source).blocks, ts);
}

/** Styles for the rendered output, shared by every tool that shows a message. */
export const MARKDOWN_HTML_CSS = `
.md-msg{background:var(--msg);border:1px solid var(--border);border-radius:10px;padding:14px 16px;color:#dbdee1;font-size:16px;line-height:1.375;overflow-wrap:anywhere;min-height:64px}
.md-msg>:first-child{margin-top:0}
.md-p{margin:0;white-space:pre-wrap}
.md-p+.md-p{margin-top:4px}
.md-h{font-weight:700;line-height:1.375;color:#f2f3f5;margin:16px 0 8px}
.md-h1{font-size:24px}.md-h2{font-size:20px}.md-h3{font-size:16px}
.md-sub{margin:0;font-size:13px;color:#949ba4;white-space:pre-wrap}
.md-quote{position:relative;margin:0;padding:0 8px 0 16px}
.md-quote::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;border-radius:4px;background:#4e5058}
.md-list{margin:4px 0 0 16px;padding:0 0 0 8px}
.md-list li{margin-bottom:4px}
.md-list li::marker{color:#949ba4}
.md-code{font:.85em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#2b2d31;border:1px solid #1e1f22;border-radius:4px;padding:0 3px}
.md-pre{font:14px/18px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#2b2d31;border:1px solid #1e1f22;border-radius:4px;padding:7px;margin:6px 0 0;white-space:pre-wrap;overflow-x:auto}
.md-link{color:#4d96ee}
.md-mention{border-radius:3px;padding:0 2px;font-weight:500;color:#c9cdfb;background:rgba(88,101,242,.3)}
.md-spoiler{background:#1e1f22;color:transparent;border-radius:4px;cursor:pointer}
.md-spoiler *{visibility:hidden}
.md-spoiler[data-open]{background:rgba(255,255,255,.1);color:inherit}
.md-spoiler[data-open] *{visibility:visible}
.md-time{background:rgba(255,255,255,.06);border-radius:3px;padding:0 2px}
.md-emoji-name{color:#b5bac1}
`;
