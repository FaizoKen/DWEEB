/**
 * The colored half of an ```ansi block in the editor's preview. Loaded lazily
 * by `Markdown.tsx`, which sits on the boot path, so everything colored text
 * needs — the parser, the palettes, this renderer — costs nothing until a
 * message actually contains an ansi block.
 */

import type { ReactNode } from "react";
import { ANSI_PALETTES, ansiSegmentStyle, parseAnsi } from "./ansi";

/**
 * The block's text as Discord draws it. Ash palette: the preview canvas is
 * classic dark's #313338, and Ash's chat surface (#323339) is the theme it
 * matches — the colors Discord tuned for that background.
 */
export function renderAnsi(value: string): ReactNode {
  return parseAnsi(value).map((segment, i) => (
    <span key={i} style={ansiSegmentStyle(segment, ANSI_PALETTES.ash) ?? undefined}>
      {segment.text}
    </span>
  ));
}
