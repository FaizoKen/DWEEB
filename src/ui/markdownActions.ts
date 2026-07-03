/**
 * Pure text transforms behind the markdown toolbar.
 *
 * Every function takes the current textarea state — the full string plus the
 * selection range — and returns a new string together with the selection that
 * should be restored afterwards. They never touch the DOM, so they're trivially
 * testable and the component layer only has to wire selection in and out.
 *
 * The markdown dialect matches Discord's (see `features/preview/markdown`):
 *   **bold**, *italic*, __underline__, ~~strike~~, `code`, ```block```,
 *   ||spoiler||, `#`/`##`/`###` headings, `-#` subtext, `>` quote,
 *   `-` / `1.` lists, `[label](url)` masked links, and `<...>` tokens for
 *   mentions, custom emoji, and timestamps.
 */

export interface EditState {
  text: string;
  /** Selection anchor (caret when collapsed). */
  selStart: number;
  selEnd: number;
}

export interface EditResult {
  text: string;
  selStart: number;
  selEnd: number;
}

/** Heading + subtext prefixes form one mutually-exclusive group per line. */
const HEADING_GROUP = ["### ", "## ", "# ", "-# "];
const BULLET_RE = /^([*-])\s/;
const ORDERED_RE = /^\d+\.\s/;

/**
 * Toggle a symmetric inline marker (`**`, `*`, `__`, `~~`, `` ` ``, `||`) around
 * the selection. Wrapping is reversible: a second press on already-wrapped text
 * removes the markers, whether they sit inside or just outside the selection.
 * With no selection it drops the markers in and selects the (optional)
 * placeholder so the user can type over it.
 */
export function wrapInline(s: EditState, marker: string, placeholder = ""): EditResult {
  const { text, selStart, selEnd } = s;
  const n = marker.length;
  const selected = text.slice(selStart, selEnd);
  const before = text.slice(0, selStart);
  const after = text.slice(selEnd);

  // Unwrap — markers captured inside the selection.
  if (selected.length >= 2 * n && selected.startsWith(marker) && selected.endsWith(marker)) {
    const inner = selected.slice(n, selected.length - n);
    return { text: before + inner + after, selStart, selEnd: selStart + inner.length };
  }

  // Unwrap — markers sit just outside the selection.
  if (before.endsWith(marker) && after.startsWith(marker)) {
    return {
      text: before.slice(0, before.length - n) + selected + after.slice(n),
      selStart: selStart - n,
      selEnd: selEnd - n,
    };
  }

  // Wrap.
  if (selected.length === 0) {
    const start = selStart + n;
    return {
      text: before + marker + placeholder + marker + after,
      selStart: start,
      selEnd: start + placeholder.length,
    };
  }
  return {
    text: before + marker + selected + marker + after,
    selStart: selStart + n,
    selEnd: selEnd + n,
  };
}

/** Whether the selection is currently wrapped by `marker` (drives highlighting). */
export function isInlineActive(s: EditState, marker: string): boolean {
  const { text, selStart, selEnd } = s;
  const n = marker.length;
  const before = text.slice(0, selStart);
  const after = text.slice(selEnd);

  if (before.endsWith(marker) && after.startsWith(marker)) {
    // A lone `*`/`_` neighboured by a second one is really `**`/`__`, not this.
    if (n === 1 && (before.endsWith(marker + marker) || after.startsWith(marker + marker))) {
      return false;
    }
    return true;
  }

  const selected = text.slice(selStart, selEnd);
  if (selected.length >= 2 * n && selected.startsWith(marker) && selected.endsWith(marker)) {
    if (n === 1 && (selected.startsWith(marker + marker) || selected.endsWith(marker + marker))) {
      return false;
    }
    return true;
  }
  return false;
}

/** Expand the selection to whole lines and return the enclosing block. */
function lineBlock(text: string, selStart: number, selEnd: number) {
  const start = text.lastIndexOf("\n", selStart - 1) + 1;
  let end = text.indexOf("\n", selEnd);
  if (end === -1) end = text.length;
  // A collapsed caret sitting just past a trailing newline should still act on
  // the line it's on, not pull in the previous one.
  if (selEnd > selStart && end > start && text[end - 1] === "\n") end -= 1;
  return { start, end, block: text.slice(start, end) };
}

function replaceBlock(text: string, start: number, end: number, nextBlock: string): EditResult {
  return {
    text: text.slice(0, start) + nextBlock + text.slice(end),
    selStart: start,
    selEnd: start + nextBlock.length,
  };
}

/**
 * Apply a heading/subtext prefix to every selected line. Pressing the active
 * one again clears it; switching to another swaps the old one out so you never
 * stack `## # heading`.
 */
export function setHeading(s: EditState, prefix: string): EditResult {
  const { start, end, block } = lineBlock(s.text, s.selStart, s.selEnd);
  const lines = block.split("\n");
  const allHave = lines.every((l) => l.startsWith(prefix));
  const stripGroup = (l: string) => {
    for (const g of HEADING_GROUP) if (l.startsWith(g)) return l.slice(g.length);
    return l;
  };
  const next = allHave
    ? lines.map((l) => l.slice(prefix.length))
    : lines.map((l) => prefix + stripGroup(l));
  return replaceBlock(s.text, start, end, next.join("\n"));
}

export function isHeadingActive(s: EditState, prefix: string): boolean {
  const { block } = lineBlock(s.text, s.selStart, s.selEnd);
  return block.split("\n").every((l) => l.startsWith(prefix));
}

/** Toggle a blockquote (`> `) across the selected lines. */
export function toggleQuote(s: EditState): EditResult {
  const { start, end, block } = lineBlock(s.text, s.selStart, s.selEnd);
  const lines = block.split("\n");
  const allHave = lines.every((l) => l.startsWith("> "));
  const next = allHave ? lines.map((l) => l.slice(2)) : lines.map((l) => "> " + l);
  return replaceBlock(s.text, start, end, next.join("\n"));
}

export function isQuoteActive(s: EditState): boolean {
  const { block } = lineBlock(s.text, s.selStart, s.selEnd);
  return block.split("\n").every((l) => l.startsWith("> "));
}

/** Toggle a bulleted list (`- `) across the selected lines. */
export function toggleBulletList(s: EditState): EditResult {
  const { start, end, block } = lineBlock(s.text, s.selStart, s.selEnd);
  const lines = block.split("\n");
  const allHave = lines.every((l) => BULLET_RE.test(l));
  const next = allHave
    ? lines.map((l) => l.replace(BULLET_RE, ""))
    : lines.map((l) => "- " + l.replace(ORDERED_RE, ""));
  return replaceBlock(s.text, start, end, next.join("\n"));
}

export function isBulletActive(s: EditState): boolean {
  const { block } = lineBlock(s.text, s.selStart, s.selEnd);
  return block.split("\n").every((l) => BULLET_RE.test(l));
}

/** Toggle an ordered list (`1. `, `2. `…) across the selected lines. */
export function toggleOrderedList(s: EditState): EditResult {
  const { start, end, block } = lineBlock(s.text, s.selStart, s.selEnd);
  const lines = block.split("\n");
  const allHave = lines.every((l) => ORDERED_RE.test(l));
  const next = allHave
    ? lines.map((l) => l.replace(ORDERED_RE, ""))
    : lines.map((l, i) => `${i + 1}. ` + l.replace(BULLET_RE, ""));
  return replaceBlock(s.text, start, end, next.join("\n"));
}

export function isOrderedActive(s: EditState): boolean {
  const { block } = lineBlock(s.text, s.selStart, s.selEnd);
  return block.split("\n").every((l) => ORDERED_RE.test(l));
}

/**
 * Wrap the selection in a fenced code block on its own lines, padding with
 * newlines only where needed so it doesn't glue onto neighbouring text. The
 * body (or caret, when empty) lands inside the fences ready to type.
 */
export function wrapCodeBlock(s: EditState, lang = ""): EditResult {
  const { text, selStart, selEnd } = s;
  const before = text.slice(0, selStart);
  const after = text.slice(selEnd);
  const body = text.slice(selStart, selEnd);
  const lead = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
  const trail = after.length > 0 && !after.startsWith("\n") ? "\n" : "";
  const open = "```" + lang + "\n";
  const close = "\n```";
  const bodyStart = before.length + lead.length + open.length;
  return {
    text: before + lead + open + body + close + trail + after,
    selStart: bodyStart,
    selEnd: bodyStart + body.length,
  };
}

/**
 * Insert a masked link. A selected URL becomes the target (caret on the label);
 * any other selection becomes the label (caret on the `url` placeholder); an
 * empty selection drops in `[text](url)` with `text` selected.
 */
export function insertLink(s: EditState): EditResult {
  const { text, selStart, selEnd } = s;
  const before = text.slice(0, selStart);
  const after = text.slice(selEnd);
  const selected = text.slice(selStart, selEnd);

  let label = "text";
  let url = "url";
  let select: "label" | "url" = "label";
  if (selected.length > 0) {
    if (/^https?:\/\/\S+$/i.test(selected.trim())) {
      url = selected.trim();
      select = "label";
    } else {
      label = selected;
      select = "url";
    }
  }

  const snippet = `[${label}](${url})`;
  const labelStart = before.length + 1;
  const urlStart = before.length + 1 + label.length + 2;
  const [selStartNext, len] =
    select === "label" ? [labelStart, label.length] : [urlStart, url.length];
  return {
    text: before + snippet + after,
    selStart: selStartNext,
    selEnd: selStartNext + len,
  };
}

/**
 * Replace the selection with a literal snippet. When `selectToken` is given and
 * found in the snippet, that token is left selected (e.g. the `id` in a mention
 * template) so the placeholder is easy to fill in; otherwise the caret lands at
 * the end of the inserted text.
 */
export function insertSnippet(s: EditState, snippet: string, selectToken?: string): EditResult {
  const { text, selStart, selEnd } = s;
  const before = text.slice(0, selStart);
  const after = text.slice(selEnd);
  if (selectToken) {
    const idx = snippet.indexOf(selectToken);
    if (idx >= 0) {
      const start = before.length + idx;
      return {
        text: before + snippet + after,
        selStart: start,
        selEnd: start + selectToken.length,
      };
    }
  }
  const caret = before.length + snippet.length;
  return { text: before + snippet + after, selStart: caret, selEnd: caret };
}
