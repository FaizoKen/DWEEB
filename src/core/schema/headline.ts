/**
 * A message's own headline and first body line, for cards that have nothing
 * else to show.
 *
 * Posted history stores no title: the library only knows the destination, so
 * four posts to `#test` rendered as four cards titled `#test` with one
 * boilerplate sentence each, distinguishable only by a small date. The
 * message itself almost always opens with a heading or a first line that
 * says what it is — this pulls that out, Discord markdown stripped, so a card
 * can be named after its content and described by its next line.
 */

import { ComponentType } from "./types";
import type { AnyComponent, WebhookMessage } from "./types";

export interface MessageHeadline {
  /** First non-empty text line, markdown stripped and clipped. */
  title: string | null;
  /** The following non-empty text line, if any. */
  snippet: string | null;
}

const DEFAULT_TITLE_MAX = 60;
const DEFAULT_SNIPPET_MAX = 120;

/** Text-display contents in reading order, descending into containers and sections. */
function* textContents(nodes: readonly AnyComponent[]): Generator<string> {
  for (const node of nodes) {
    if (node.type === ComponentType.TextDisplay) {
      const content = (node as { content?: unknown }).content;
      if (typeof content === "string") yield content;
      continue;
    }
    const children = (node as { components?: unknown }).components;
    if (Array.isArray(children)) yield* textContents(children as AnyComponent[]);
  }
}

/** One line of Discord markdown as plain text: no heading/list/quote markers, emphasis, or raw mention syntax. */
export function stripMarkdownLine(line: string): string {
  return (
    line
      // Headings (`# `, `## `, `### `) and subtext (`-# `).
      .replace(/^\s*(?:-#|#{1,3})\s+/, "")
      // Block quotes and list markers.
      .replace(/^\s*>\s?/, "")
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
      // Masked links keep their label.
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      // Custom emoji become their `:name:`; mentions become readable stand-ins.
      .replace(/<a?:(\w+):\d+>/g, ":$1:")
      .replace(/<@!?\d+>/g, "@user")
      .replace(/<@&\d+>/g, "@role")
      .replace(/<#\d+>/g, "#channel")
      // Bold, underline, strikethrough, spoiler and code markers.
      .replace(/\*\*|__|~~|\|\||`/g, "")
      // Single-character italics around a word or phrase.
      .replace(/(^|\s)[*_]([^*_\n]+?)[*_](?=\s|$|[.,;:!?])/g, "$1$2")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function messageHeadline(
  message: WebhookMessage,
  maxTitle = DEFAULT_TITLE_MAX,
  maxSnippet = DEFAULT_SNIPPET_MAX,
): MessageHeadline {
  const lines: string[] = [];
  outer: for (const content of textContents(message.components)) {
    for (const raw of content.split("\n")) {
      const text = stripMarkdownLine(raw);
      if (text) lines.push(text);
      if (lines.length >= 2) break outer;
    }
  }
  return {
    title: lines[0] ? clip(lines[0], maxTitle) : null,
    snippet: lines[1] ? clip(lines[1], maxSnippet) : null,
  };
}
