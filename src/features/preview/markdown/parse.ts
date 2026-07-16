/**
 * Minimal Discord-flavored markdown parser.
 *
 * This is *not* CommonMark — it follows Discord's subset and quirks:
 *
 *   - `**bold**`, `*italic*`, `_italic_`, `__underline__`, `~~strike~~`
 *   - `` `inline code` ``, `` ```fenced``` `` (with optional language)
 *   - `# H1`, `## H2`, `### H3` (heading at start of line only)
 *   - `> quote`, `>>> multi-line quote` (rest of message)
 *   - `- list` and `1. list`
 *   - `||spoiler||`
 *   - `[label](url)` — masked links
 *   - User/role/channel mentions `<@id>`, `<@&id>`, `<#id>`
 *   - Guild navigation `<id:browse>`, `<id:guide>`, `<id:customize>`, `<id:linked-roles>`
 *   - Custom emoji `<:name:id>` / `<a:name:id>`
 *   - Timestamps `<t:unix:style>`
 *
 * The parser produces a structured AST consumed by `MarkdownRenderer`. We
 * keep parsing and rendering separate so the AST can be unit-tested in
 * isolation later.
 */

export type InlineNode =
  | { kind: "text"; value: string }
  | { kind: "bold"; children: InlineNode[] }
  | { kind: "italic"; children: InlineNode[] }
  | { kind: "underline"; children: InlineNode[] }
  | { kind: "strike"; children: InlineNode[] }
  | { kind: "spoiler"; children: InlineNode[] }
  | { kind: "code"; value: string }
  | { kind: "link"; href: string; children: InlineNode[] }
  | { kind: "mention"; mention: MentionKind; id: string }
  | { kind: "guildNav"; nav: GuildNavType }
  | { kind: "emoji"; name: string; id: string; animated: boolean }
  | { kind: "timestamp"; unix: number; style: string }
  | { kind: "break" };

export type MentionKind = "user" | "role" | "channel" | "everyone" | "here";

/** Discord's built-in "guild navigation" mentions (`<id:type>`). */
export type GuildNavType = "customize" | "browse" | "guide" | "linked-roles";

/** One entry in a list, with its own inline content plus any nested sub-lists. */
export interface ListItem {
  /** Inline content after the bullet/number. */
  content: InlineNode[];
  /** Blocks indented under this item — sub-lists, matching Discord nesting. */
  children: BlockNode[];
}

export type BlockNode =
  | { kind: "paragraph"; children: InlineNode[] }
  | { kind: "heading"; level: 1 | 2 | 3; children: InlineNode[] }
  | { kind: "subtext"; children: InlineNode[] }
  | { kind: "quote"; children: BlockNode[] }
  | { kind: "list"; ordered: boolean; start?: number; items: ListItem[] }
  | { kind: "codeblock"; lang: string | null; value: string };

export interface MarkdownAst {
  blocks: BlockNode[];
}

export function parseMarkdown(input: string): MarkdownAst {
  // Normalize newlines and trim leading/trailing blank lines (Discord does the
  // same) so a stray blank at either end doesn't render as an empty gap.
  const lines = input.replace(/\r\n?/g, "\n").replace(/^\n+/, "").replace(/\n+$/, "").split("\n");
  const blocks: BlockNode[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // Code fence
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || null;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        body.push(lines[i]!);
        i++;
      }
      // skip closing fence (if any)
      if (i < lines.length) i++;
      blocks.push({ kind: "codeblock", lang, value: body.join("\n") });
      continue;
    }

    // Subtext (`-# `) — Discord's small/muted text. Consecutive `-# ` lines
    // merge into a single block joined by hard breaks, matching paragraphs.
    if (/^-#\s+/.test(line)) {
      const buf: string[] = [line.replace(/^-#\s+/, "")];
      i++;
      while (i < lines.length && /^-#\s+/.test(lines[i]!)) {
        buf.push(lines[i]!.replace(/^-#\s+/, ""));
        i++;
      }
      blocks.push({ kind: "subtext", children: parseInline(buf.join("\n")) });
      continue;
    }

    // Headings (only at column 0)
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, children: parseInline(h[2]!) });
      i++;
      continue;
    }

    // Multi-line quote
    if (line.startsWith(">>> ")) {
      const rest = [line.slice(4), ...lines.slice(i + 1)].join("\n");
      blocks.push({ kind: "quote", children: parseMarkdown(rest).blocks });
      i = lines.length;
      continue;
    }

    // Single-line quote (may span multiple consecutive `>` lines)
    if (line.startsWith("> ")) {
      const buf: string[] = [line.slice(2)];
      i++;
      while (i < lines.length && lines[i]!.startsWith("> ")) {
        buf.push(lines[i]!.slice(2));
        i++;
      }
      blocks.push({ kind: "quote", children: parseMarkdown(buf.join("\n")).blocks });
      continue;
    }

    // Lists (bullet or ordered), with indentation-based nesting.
    if (matchListItem(line)) {
      const { block, next } = parseList(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }

    // Text run: collect contiguous lines up to the next structural line,
    // *including* blank lines. Discord keeps blank lines as real vertical gaps
    // rather than collapsing them, so we preserve them here (each newline
    // becomes a hard break at render time).
    const para: string[] = [line];
    i++;
    while (i < lines.length && !isStructuralStart(lines[i]!)) {
      para.push(lines[i]!);
      i++;
    }
    blocks.push({ kind: "paragraph", children: parseInline(para.join("\n")) });
  }

  return { blocks };
}

/** A line that begins its own block — paragraphs stop when they hit one. */
function isStructuralStart(line: string): boolean {
  return (
    line.startsWith("```") ||
    /^(#{1,3})\s+/.test(line) ||
    /^-#\s+/.test(line) ||
    line.startsWith("> ") ||
    line.startsWith(">>> ") ||
    matchListItem(line) !== null
  );
}

interface ListLine {
  /** Leading-space count — drives nesting depth. */
  indent: number;
  ordered: boolean;
  /** Parsed number for ordered items (the first item sets the list's start). */
  num?: number;
  content: string;
}

/** Match a single list line (bullet `-`/`*` or ordered `N.`), allowing indent. */
function matchListItem(line: string): ListLine | null {
  const m = /^(\s*)(?:[-*]|(\d{1,9})\.)\s+(.*)$/.exec(line);
  if (!m) return null;
  return {
    indent: m[1]!.length,
    ordered: m[2] !== undefined,
    num: m[2] !== undefined ? Number.parseInt(m[2]!, 10) : undefined,
    content: m[3]!,
  };
}

type ListBlock = Extract<BlockNode, { kind: "list" }>;

/**
 * Consume a run of consecutive list lines into a (possibly nested) list block.
 * Nesting is driven purely by indentation: a deeper-indented item becomes a
 * sub-list of the previous item, mirroring Discord. Each (sub-)list's `start`
 * is taken from its first item's number.
 */
function parseList(lines: string[], start: number): { block: BlockNode; next: number } {
  let i = start;
  const stack: { indent: number; list: ListBlock }[] = [];
  let root: ListBlock | null = null;

  while (i < lines.length) {
    const m = matchListItem(lines[i]!);
    if (!m) break;
    const item: ListItem = { content: parseInline(m.content), children: [] };

    if (stack.length === 0) {
      const list: ListBlock = { kind: "list", ordered: m.ordered, start: m.num, items: [item] };
      stack.push({ indent: m.indent, list });
      root = list;
    } else {
      // Pop out to the shallowest level still at least as deep as this item.
      while (stack.length > 1 && m.indent < stack[stack.length - 1]!.indent) stack.pop();
      const top = stack[stack.length - 1]!;
      if (m.indent > top.indent) {
        // Deeper → a new sub-list hanging off the previous item at this level.
        const parentItem = top.list.items[top.list.items.length - 1]!;
        const list: ListBlock = { kind: "list", ordered: m.ordered, start: m.num, items: [item] };
        parentItem.children.push(list);
        stack.push({ indent: m.indent, list });
      } else {
        // Same level → append to the current list.
        top.list.items.push(item);
      }
    }
    i++;
  }

  return { block: root ?? { kind: "list", ordered: false, items: [] }, next: i };
}

/**
 * Inline parser. Greedy left-to-right scan that recognizes the strongest
 * delimiter at the current position. Not pretty, but it matches Discord's
 * approach: spans terminate at their closing delimiter without nesting
 * the same kind.
 */
export function parseInline(input: string): InlineNode[] {
  const out: InlineNode[] = [];
  let i = 0;
  let buf = "";

  const flush = () => {
    if (buf.length > 0) {
      out.push({ kind: "text", value: buf });
      buf = "";
    }
  };

  while (i < input.length) {
    const ch = input[i]!;

    // Backslash escape: a backslash before a punctuation/symbol char emits that
    // char literally and is itself consumed (so `\*` is a literal `*`, `\\` a
    // literal `\`). Before a letter/digit/space the backslash stays literal,
    // matching Discord.
    if (ch === "\\" && i + 1 < input.length) {
      const next = input[i + 1]!;
      if (!/[0-9A-Za-z\s]/.test(next)) {
        buf += next;
        i += 2;
        continue;
      }
    }

    // Hard line break
    if (ch === "\n") {
      flush();
      out.push({ kind: "break" });
      i++;
      continue;
    }

    // Code span — earliest because anything inside is literal. Discord also
    // supports double-backtick spans (`` ` `` inside), so a run of two opens a
    // span closed by the next double run, letting single backticks stay literal
    // within it.
    if (ch === "`") {
      const run = input[i + 1] === "`" ? 2 : 1;
      const open = "`".repeat(run);
      const end = input.indexOf(open, i + run);
      if (end > i + run - 1) {
        const value = input.slice(i + run, end);
        if (value.length > 0) {
          flush();
          out.push({ kind: "code", value });
          i = end + run;
          continue;
        }
      }
    }

    // Spoiler
    if (ch === "|" && input[i + 1] === "|") {
      const end = input.indexOf("||", i + 2);
      if (end > i) {
        flush();
        out.push({ kind: "spoiler", children: parseInline(input.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    // Triple emphasis: `***x***` → bold+italic, `___x___` → underline+italic.
    // Matched before the double-delimiter rules so the extra marker isn't left
    // dangling (which would corrupt the rest of the line). Discord nests italic
    // on the outside (`<em><strong>` / `<em><u>`).
    if (ch === "*" && input[i + 1] === "*" && input[i + 2] === "*") {
      const end = input.indexOf("***", i + 3);
      if (end > i + 2) {
        flush();
        out.push({
          kind: "italic",
          children: [{ kind: "bold", children: parseInline(input.slice(i + 3, end)) }],
        });
        i = end + 3;
        continue;
      }
    }
    if (ch === "_" && input[i + 1] === "_" && input[i + 2] === "_") {
      const end = input.indexOf("___", i + 3);
      if (end > i + 2) {
        flush();
        out.push({
          kind: "italic",
          children: [{ kind: "underline", children: parseInline(input.slice(i + 3, end)) }],
        });
        i = end + 3;
        continue;
      }
    }

    // Bold (`**`) — must come before `*`
    if (ch === "*" && input[i + 1] === "*") {
      const end = input.indexOf("**", i + 2);
      if (end > i) {
        flush();
        out.push({ kind: "bold", children: parseInline(input.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    // Underline (`__`)
    if (ch === "_" && input[i + 1] === "_") {
      const end = input.indexOf("__", i + 2);
      if (end > i) {
        flush();
        out.push({ kind: "underline", children: parseInline(input.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    // Strikethrough (`~~`)
    if (ch === "~" && input[i + 1] === "~") {
      const end = input.indexOf("~~", i + 2);
      if (end > i) {
        flush();
        out.push({ kind: "strike", children: parseInline(input.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    // Italic single `*`. Discord requires the opening `*` to be followed by a
    // non-space character (so `2 * 3 * 4` stays literal math), but the closing
    // `*` may be preceded by a space.
    if (ch === "*" && input[i + 1] !== ch) {
      const next = input[i + 1];
      if (next !== undefined && !/\s/.test(next)) {
        const close = input.indexOf(ch, i + 1);
        if (close > i + 1) {
          flush();
          out.push({ kind: "italic", children: parseInline(input.slice(i + 1, close)) });
          i = close + 1;
          continue;
        }
      }
    }

    // Italic single `_`. Discord anchors underscores to word boundaries
    // (`\b_…_\b`), so intra-word underscores — `snake_case_word` — stay
    // literal, while `_ padded _` still italicizes.
    if (ch === "_" && input[i + 1] !== ch) {
      const prev = i > 0 ? input[i - 1]! : "";
      if (!/[0-9A-Za-z_]/.test(prev)) {
        const close = input.indexOf(ch, i + 1);
        const after = close >= 0 ? input[close + 1] : undefined;
        if (close > i + 1 && (after === undefined || !/[0-9A-Za-z_]/.test(after))) {
          flush();
          out.push({ kind: "italic", children: parseInline(input.slice(i + 1, close)) });
          i = close + 1;
          continue;
        }
      }
    }

    // Masked link `[label](url)`
    if (ch === "[") {
      const close = input.indexOf("]", i + 1);
      if (close > i && input[close + 1] === "(") {
        const urlEnd = input.indexOf(")", close + 2);
        if (urlEnd > close) {
          flush();
          out.push({
            kind: "link",
            href: input.slice(close + 2, urlEnd),
            children: parseInline(input.slice(i + 1, close)),
          });
          i = urlEnd + 1;
          continue;
        }
      }
    }

    // Mentions, emoji, timestamps `<...>`
    if (ch === "<") {
      const end = input.indexOf(">", i + 1);
      if (end > i) {
        const inner = input.slice(i + 1, end);
        const parsed = parseAngleToken(inner);
        if (parsed) {
          flush();
          out.push(parsed);
          i = end + 1;
          continue;
        }
      }
    }

    // Bare mentions `@everyone` / `@here`
    if (ch === "@") {
      if (input.startsWith("@everyone", i)) {
        flush();
        out.push({ kind: "mention", mention: "everyone", id: "" });
        i += "@everyone".length;
        continue;
      }
      if (input.startsWith("@here", i)) {
        flush();
        out.push({ kind: "mention", mention: "here", id: "" });
        i += "@here".length;
        continue;
      }
    }

    // Auto-link http(s)://. Discord's URL rule allows any non-space chars but
    // the *final* character may not be closing punctuation (`.,:;"')]`), so
    // `(https://x/wiki)` and `https://x/a, next` both exclude the trailer.
    if ((ch === "h" || ch === "H") && /^https?:\/\//i.test(input.slice(i))) {
      const m = /^https?:\/\/[^\s<]+[^<.,:;"')\]\s]/i.exec(input.slice(i));
      if (m) {
        flush();
        out.push({
          kind: "link",
          href: m[0],
          children: [{ kind: "text", value: m[0] }],
        });
        i += m[0].length;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

const GUILD_NAV_TYPES = new Set<string>(["customize", "browse", "guide", "linked-roles"]);

function parseAngleToken(token: string): InlineNode | null {
  // User mention <@123> or <@!123>
  let m = /^@!?(\d+)$/.exec(token);
  if (m) return { kind: "mention", mention: "user", id: m[1]! };

  // Role mention <@&123>
  m = /^@&(\d+)$/.exec(token);
  if (m) return { kind: "mention", mention: "role", id: m[1]! };

  // Channel mention <#123>
  m = /^#(\d+)$/.exec(token);
  if (m) return { kind: "mention", mention: "channel", id: m[1]! };

  // Guild navigation <id:browse> / <id:guide> / <id:customize> / <id:linked-roles>
  m = /^id:([a-z-]+)$/.exec(token);
  if (m && GUILD_NAV_TYPES.has(m[1]!)) {
    return { kind: "guildNav", nav: m[1] as GuildNavType };
  }

  // Custom emoji <:name:id> / <a:name:id>
  m = /^(a)?:([a-zA-Z0-9_]+):(\d+)$/.exec(token);
  if (m) {
    return {
      kind: "emoji",
      animated: m[1] === "a",
      name: m[2]!,
      id: m[3]!,
    };
  }

  // Timestamp <t:unix> / <t:unix:style>
  m = /^t:(-?\d+)(?::([tTdDfFR]))?$/.exec(token);
  if (m) {
    return {
      kind: "timestamp",
      unix: Number.parseInt(m[1]!, 10),
      style: m[2] ?? "f",
    };
  }

  // Angle-bracketed link <https://example.com> — Discord renders the URL as a
  // link (the brackets only suppress its embed). Kept last so the more specific
  // tokens above win.
  if (/^https?:\/\/\S+$/i.test(token)) {
    return { kind: "link", href: token, children: [{ kind: "text", value: token }] };
  }

  return null;
}
