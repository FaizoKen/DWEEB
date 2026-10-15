/**
 * The example the colored text generator starts from: a small status board
 * that uses only what every Discord reader sees (the eight basic colors, bold
 * and underline), so the worked example on the page is true for everyone.
 * Client-safe — the generator page and its browser script both import it.
 */

import type { AnsiColor, AnsiSegment } from "@/features/preview/markdown/ansi";

const named = (index: number): AnsiColor => ({ kind: "named", index });

function run(text: string, style: Partial<Omit<AnsiSegment, "text">> = {}): AnsiSegment {
  return {
    text,
    fg: null,
    bg: null,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    overline: false,
    ...style,
  };
}

export const COLORED_TEXT_SAMPLE: readonly AnsiSegment[] = [
  run("Server status", { bold: true, underline: true }),
  run("\n● Website    "),
  run("ONLINE", { bold: true, fg: named(2) }),
  run("\n● Voice      "),
  run("DEGRADED", { bold: true, fg: named(3) }),
  run("\n● Database   "),
  run("OFFLINE", { bold: true, fg: named(1) }),
  run("\n\n"),
  run(" NEW ", { bold: true, fg: named(7), bg: named(4) }),
  run(" Colored text works in "),
  run("webhook posts", { fg: named(6) }),
  run(" too."),
];
