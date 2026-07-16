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
    // Fall through to the lenient, string-aware passes below.
  }

  // Pass 1: strip comments. Runs BEFORE the trailing-comma pass, so a comma
  // separated from its closer only by a comment (`}, /* note */ ]`) is still
  // recognized as trailing.
  let noComments = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      noComments += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      noComments += ch;
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
    noComments += ch;
  }

  // Pass 2: drop trailing commas.
  let out = "";
  inString = false;
  escaped = false;
  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments[i];
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
    if (ch === ",") {
      let j = i + 1;
      while (j < noComments.length && /\s/.test(noComments[j]!)) j++;
      if (noComments[j] === "}" || noComments[j] === "]") continue; // drop it
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
  const strippedRanges: Array<[number, number]> = [];

  // Collect every fence that parses into a message. The contract tells the
  // model to put the payload LAST, so when a reply carries several candidates
  // (a "before/after" pair, an example followed by the real thing) the last one
  // wins — but all of them are stripped from the prose, because raw JSON walls
  // are never useful chat text.
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
      strippedRanges.push([start, start + match[0].length]);
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

  // Splice the stripped ranges out in one pass. (The old single-range logic
  // rebuilt `prose` from `text` on every iteration, which silently restored
  // earlier removals when more than one range existed.)
  let prose = "";
  let cursor = 0;
  for (const [start, end] of strippedRanges) {
    prose += text.slice(cursor, start);
    cursor = end;
  }
  prose += text.slice(cursor);
  return { text: prose.trim(), payload };
}

/**
 * Heuristic: does this prose ANNOUNCE a message edit?
 *
 * The failure this guards against (seen in production): the model replies
 * "Sure! Here's a streamlined version with just the essentials." — and no JSON
 * block. Nothing is applied, the user believes it was, and every follow-up
 * ("do it") produces another empty announcement. When a settled reply has no
 * payload but its prose announces one, the store runs a single recovery turn
 * asking for the JSON (with a NO_CHANGE escape hatch, so a false positive here
 * costs one cheap request and nothing else).
 */
const ANNOUNCE_RES = [
  // "Here's a streamlined version…", "here is the updated message…"
  /\b(here('|’)s|here is)\b[^.?!\n]{0,80}\b(version|message|update|json|payload)\b/i,
  /\b(here('|’)s|here is)\b[^.?!\n]{0,80}\b(simplified|streamlined|updated|revised|cleaner|simpler|pared)\b/i,
  // "I've simplified…", "I have removed…", "I'll update it to…"
  /\bi('|’)?(ve|ll| have| will)\b[^.?!\n]{0,60}\b(made|updated?|create[d]?|built?|add(ed)?|remov(e|ed)|chang(e|ed)|simplif(y|ied)|streamlin(e|ed)|trim(med)?|revis(e|ed)|redesign(ed)?|rework(ed)?|clean(ed)?|appl(y|ied)|swap(ped)?|replac(e|ed))\b/i,
  // "Updated version:", "new message below", "Done!" / "All set."
  /\b(updated|revised|simplified|streamlined|pared[- ]down|trimmed|new) (version|message)\b/i,
  /^(done|all set|all done)\b/i,
];

export function announcesEdit(prose: string): boolean {
  const text = (prose ?? "").trim();
  if (!text || text.endsWith("?")) return false;
  return ANNOUNCE_RES.some((re) => re.test(text));
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
