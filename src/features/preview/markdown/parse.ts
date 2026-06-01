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

export type BlockNode =
  | { kind: "paragraph"; children: InlineNode[] }
  | { kind: "heading"; level: 1 | 2 | 3; children: InlineNode[] }
  | { kind: "subtext"; children: InlineNode[] }
  | { kind: "quote"; children: BlockNode[] }
  | { kind: "list"; ordered: boolean; items: InlineNode[][] }
  | { kind: "codeblock"; lang: string | null; value: string };

export interface MarkdownAst {
  blocks: BlockNode[];
}

export function parseMarkdown(input: string): MarkdownAst {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
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

    // Lists
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      const ordered = !!ol;
      const items: InlineNode[][] = [];
      while (i < lines.length) {
        const m = ordered ? /^\d+\.\s+(.*)$/.exec(lines[i]!) : /^[-*]\s+(.*)$/.exec(lines[i]!);
        if (!m) break;
        items.push(parseInline(m[1]!));
        i++;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    // Blank line → paragraph break (collapsed by renderer).
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph: collect contiguous non-special lines, joined by hard breaks.
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !lines[i]!.startsWith("```") &&
      !/^(#{1,3})\s+/.test(lines[i]!) &&
      !/^-#\s+/.test(lines[i]!) &&
      !lines[i]!.startsWith("> ") &&
      !lines[i]!.startsWith(">>> ") &&
      !/^[-*]\s+/.test(lines[i]!) &&
      !/^\d+\.\s+/.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i++;
    }
    blocks.push({ kind: "paragraph", children: parseInline(para.join("\n")) });
  }

  return { blocks };
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

    // Hard line break
    if (ch === "\n") {
      flush();
      out.push({ kind: "break" });
      i++;
      continue;
    }

    // Code span — earliest because anything inside is literal
    if (ch === "`") {
      const end = input.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push({ kind: "code", value: input.slice(i + 1, end) });
        i = end + 1;
        continue;
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

    // Italic single `*` or `_`
    if ((ch === "*" || ch === "_") && input[i + 1] !== ch) {
      const close = input.indexOf(ch, i + 1);
      if (close > i + 1) {
        flush();
        out.push({ kind: "italic", children: parseInline(input.slice(i + 1, close)) });
        i = close + 1;
        continue;
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

    // Auto-link http(s)://
    if ((ch === "h" || ch === "H") && /^https?:\/\//i.test(input.slice(i))) {
      const m = /^https?:\/\/[^\s<>()]+/i.exec(input.slice(i));
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

  return null;
}
