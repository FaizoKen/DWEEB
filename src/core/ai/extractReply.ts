/**
 * Split an assistant reply into prose + an optional message payload.
 *
 * The model is instructed to emit the full message inside a single ```json
 * fence. We pull the first fenced block that parses into an object carrying a
 * `components` array, strip it from the prose, and hand the parsed object back
 * for the importer to validate. Anything that doesn't parse is left in the
 * prose untouched so the user still sees what the model said.
 */

import type { ParsedAssistantReply } from "./types";

const FENCE_RE = /```(?:json|json5|jsonc)?\s*\n?([\s\S]*?)```/gi;

function looksLikeMessage(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as { components?: unknown }).components)
  );
}

export function extractReply(raw: string): ParsedAssistantReply {
  const text = raw ?? "";
  let payload: unknown | null = null;
  let strippedRanges: Array<[number, number]> = [];

  for (const match of text.matchAll(FENCE_RE)) {
    const body = match[1];
    if (body === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.trim());
    } catch {
      continue;
    }
    if (looksLikeMessage(parsed)) {
      payload = parsed;
      const start = match.index ?? 0;
      strippedRanges = [[start, start + match[0].length]];
      break;
    }
  }

  // If no fenced block matched, try a bare top-level JSON object as a fallback —
  // some models forget the fence. Only accept it when it spans the whole reply.
  if (payload === null) {
    const trimmed = text.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (looksLikeMessage(parsed)) {
          return { text: "", payload: parsed };
        }
      } catch {
        // fall through — keep the prose as-is
      }
    }
  }

  let prose = text;
  for (const [start, end] of strippedRanges) {
    prose = text.slice(0, start) + text.slice(end);
  }
  return { text: prose.trim(), payload };
}
