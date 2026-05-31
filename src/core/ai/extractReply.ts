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

/**
 * Parse model-emitted JSON a little more forgivingly than `JSON.parse`.
 *
 * Cheap models occasionally decorate otherwise-correct JSON with trailing
 * commas or `//` / block comments. Stripping those blindly would corrupt string
 * contents (the `//` inside an `https://` URL, a `,]` inside prose), so we walk
 * the text tracking whether we're inside a string literal and only edit
 * structural characters. The strict parse is tried first so well-formed JSON
 * pays no cost.
 */
function tolerantJsonParse(input: string): unknown {
  const text = input.trim();
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to the lenient, string-aware pass below.
  }
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // skip the closing slash
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") continue; // drop the trailing comma
    }
    out += ch;
  }
  return JSON.parse(out);
}

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
      parsed = tolerantJsonParse(body);
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
        const parsed = tolerantJsonParse(trimmed);
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

/**
 * Prose to show *while a reply is still streaming*.
 *
 * The model emits its message payload inside a ```json fence, usually after a
 * sentence or two of prose. Rendering that raw JSON token-by-token would be
 * noise, and a half-written fence can't be parsed yet — so we simply show
 * everything up to the first code fence and hide the rest until the stream
 * finishes, at which point `extractReply` does the precise split.
 */
export function streamingProse(raw: string): string {
  const fence = (raw ?? "").indexOf("```");
  const visible = fence >= 0 ? raw.slice(0, fence) : raw;
  return visible.replace(/\s+$/, "");
}
