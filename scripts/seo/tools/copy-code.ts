/**
 * Copy buttons for the generated pages' code blocks — every `pre.code-block`
 * (guide examples, a template's copy-and-paste text, its JSON and code).
 *
 * Progressive enhancement, deliberately: the static HTML carries no button, and
 * the script adds one only where the Clipboard API exists, so a reader without
 * JavaScript never meets a button that does nothing. The button is overlaid on
 * the block's corner (absolutely positioned inside a wrapper whose margins
 * collapse into the block's own), so adding it after first paint moves nothing
 * and costs no layout shift.
 *
 * Why it exists: the largest search cluster the guides and templates win is
 * "… copy and paste" (welcome messages, rules), and selecting a long block out
 * of a scrolling `<pre>` on a phone is the hard way to copy it.
 */

export const COPY_CODE_SCRIPT = "/tools/copy-code.js";

export const COPY_CODE_CSS =
  ".copy-wrap{position:relative}" +
  ".copy-btn{position:absolute;top:8px;right:8px;padding:5px 11px;border-radius:8px;border:1px solid var(--border);background:#1e1f22;color:var(--text);font-family:inherit;font-size:13px;font-weight:600;line-height:1.2;cursor:pointer;opacity:.92}" +
  ".copy-btn:hover{opacity:1;border-color:var(--muted)}" +
  ".copy-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}" +
  '.copy-btn[data-state="done"]{color:#3ba55d;border-color:#3ba55d}';

/** True when a page body has at least one code block worth a copy button. */
export function hasCodeBlocks(body: string): boolean {
  return body.includes('class="code-block');
}
