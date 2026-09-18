/**
 * A small pretty-printer shared by the builder-style targets.
 *
 * Generated code is read before it is run — it lands in a bot's repository and
 * in the static guides — so the layout rule is the one a formatter would apply:
 * an expression stays on one line while it fits, and otherwise breaks one
 * argument per line with trailing commas. Doing that here, rather than emitting
 * one long line and hoping the reader runs Prettier or Black, is most of what
 * makes the export usable as-is.
 */

export type Expr =
  /** A single-line token: a literal, an enum member, an identifier. */
  | { kind: "raw"; text: string }
  /** Pre-laid-out lines that must not be re-flowed (a multi-line string). */
  | { kind: "block"; lines: string[] }
  /** JavaScript builder chain: `new X().a(…).b(…)`. */
  | { kind: "chain"; head: string; calls: { name: string; args: Expr[] }[] }
  /** Python call: `callee(arg, kw=value)`. */
  | { kind: "call"; callee: string; args: Expr[]; kwargs: [string, Expr][] }
  /** A bracketed list, in either language. */
  | { kind: "list"; items: Expr[] };

export const raw = (text: string): Expr => ({ kind: "raw", text });
export const list = (items: Expr[]): Expr => ({ kind: "list", items });

const MAX_WIDTH = 88;
// Built from code points so no editor or formatter can turn the source itself
// into a line break.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * A double-quoted string literal that means the same thing in JavaScript, JSON
 * and Python 3. `JSON.stringify` already restricts itself to escapes all three
 * share (`\n`, `\"`, `\\`, `\uXXXX`); the two line separators it leaves bare are
 * escaped too, since a pre-2019 JavaScript parser ends the line at them.
 */
export function quote(value: string): string {
  return JSON.stringify(value)
    .replaceAll(LINE_SEPARATOR, "\\u2028")
    .replaceAll(PARAGRAPH_SEPARATOR, "\\u2029");
}

/** `0x5865f2` — the form colours are written in everywhere else in a bot. */
export function hexColor(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(6, "0")}`;
}

/**
 * Message text is the part of the export people actually edit, and a heading
 * plus four paragraphs as one `"…\n…\n…"` literal is unreadable. Text with line
 * breaks is laid out one source line per message line instead.
 */
export function jsString(value: string): Expr {
  if (!value.includes("\n")) return raw(quote(value));
  const lines = value.split("\n").map((line) => `  ${quote(line)},`);
  return { kind: "block", lines: ["[", ...lines, '].join("\\n")'] };
}

/** Python's equivalent: adjacent literals, which the compiler concatenates. */
export function pyString(value: string): Expr {
  if (!value.includes("\n")) return raw(quote(value));
  const parts = value.split("\n");
  return {
    kind: "block",
    lines: parts.map((line, index) => quote(index < parts.length - 1 ? `${line}\n` : line)),
  };
}

function inline(expr: Expr): string | null {
  switch (expr.kind) {
    case "raw":
      return expr.text;
    case "block":
      return expr.lines.length === 1 ? expr.lines[0]! : null;
    case "chain": {
      let out = expr.head;
      for (const call of expr.calls) {
        const args = call.args.map(inline);
        if (args.some((arg) => arg === null)) return null;
        out += `.${call.name}(${args.join(", ")})`;
      }
      return out;
    }
    case "call": {
      const args = expr.args.map(inline);
      const kwargs = expr.kwargs.map(([key, value]) => {
        const rendered = inline(value);
        return rendered === null ? null : `${key}=${rendered}`;
      });
      const all = [...args, ...kwargs];
      if (all.some((part) => part === null)) return null;
      return `${expr.callee}(${all.join(", ")})`;
    }
    case "list": {
      const items = expr.items.map(inline);
      return items.some((item) => item === null) ? null : `[${items.join(", ")}]`;
    }
  }
}

const pad = (lines: string[], spaces: number): string[] =>
  lines.map((line) => (line ? " ".repeat(spaces) + line : line));

/** Append `suffix` to the last line — how a trailing comma lands on a block. */
function withSuffix(lines: string[], suffix: string): string[] {
  const out = lines.slice();
  out[out.length - 1] += suffix;
  return out;
}

/**
 * Render `expr` as lines relative to column 0. `indent` is where the caller
 * will place it, so the one-line form is only chosen when it really fits.
 */
export function render(expr: Expr, indent: number, unit: number): string[] {
  const oneLine = inline(expr);
  if (oneLine !== null && indent + oneLine.length <= MAX_WIDTH) return [oneLine];
  return renderBroken(expr, indent, unit);
}

/** The multi-line form, for an expression already known not to fit on one line. */
function renderBroken(expr: Expr, indent: number, unit: number): string[] {
  switch (expr.kind) {
    case "raw":
      return [expr.text];
    case "block":
      return expr.lines;
    case "chain": {
      // A lone call hugs its receiver — `new TextDisplayBuilder().setContent(` —
      // the way Prettier keeps a short member chain together; only a real chain
      // of several calls is stacked one per line.
      const only = expr.calls.length === 1 ? expr.calls[0]! : null;
      if (only) {
        const lines = [`${expr.head}.${only.name}(`];
        for (const arg of only.args) {
          lines.push(...pad(withSuffix(render(arg, indent + unit, unit), ","), unit));
        }
        lines.push(")");
        return lines;
      }
      const lines = [expr.head];
      for (const call of expr.calls) {
        const flat = inline({ kind: "chain", head: "", calls: [call] });
        if (flat !== null && indent + unit + flat.length <= MAX_WIDTH) {
          lines.push(...pad([flat], unit));
          continue;
        }
        lines.push(...pad([`.${call.name}(`], unit));
        for (const arg of call.args) {
          lines.push(...pad(withSuffix(render(arg, indent + unit * 2, unit), ","), unit * 2));
        }
        lines.push(...pad([")"], unit));
      }
      return lines;
    }
    case "call": {
      const lines = [`${expr.callee}(`];
      for (const arg of expr.args) {
        lines.push(...pad(withSuffix(render(arg, indent + unit, unit), ","), unit));
      }
      for (const [key, value] of expr.kwargs) {
        // `key=` shares the value's first line only, exactly as in `assign`.
        const flat = inline(value);
        const rendered =
          flat !== null && indent + unit + key.length + 2 + flat.length <= MAX_WIDTH
            ? [flat]
            : renderBroken(value, indent + unit, unit);
        rendered[0] = `${key}=${rendered[0]}`;
        lines.push(...pad(withSuffix(rendered, ","), unit));
      }
      lines.push(")");
      return lines;
    }
    case "list": {
      const lines = ["["];
      for (const item of expr.items) {
        lines.push(...pad(withSuffix(render(item, indent + unit, unit), ","), unit));
      }
      lines.push("]");
      return lines;
    }
  }
}

/** `const name = <expr>;` / `name = <expr>` with the expression laid out. */
export function assign(prefix: string, expr: Expr, suffix: string, unit: number): string[] {
  // The prefix only occupies the first line: it decides whether the whole
  // expression fits on it, but a broken expression continues from column 0.
  const oneLine = inline(expr);
  const lines =
    oneLine !== null && prefix.length + oneLine.length + suffix.length <= MAX_WIDTH
      ? [oneLine]
      : renderBroken(expr, 0, unit);
  lines[0] = prefix + lines[0];
  return withSuffix(lines, suffix);
}

/** Indent a finished block — for code that sits inside a function body. */
export function indentLines(lines: string[], spaces: number): string[] {
  return pad(lines, spaces);
}
