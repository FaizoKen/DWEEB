/**
 * Turn raw model output into an editor update.
 *
 * The model is asked for `{ note, message }`, but small models occasionally
 * wrap JSON in prose or code fences, or return the bare message object. We
 * recover from all three, then funnel the payload through the same import path
 * a pasted JSON uses so validation and id-stamping behave identically.
 */

import { decodeJson } from "@/core/serialization";
import { validateMessage, type ValidationIssue } from "@/core/schema/validation";
import { useMessageStore } from "@/core/state/messageStore";

export interface ApplyOk {
  ok: true;
  note: string;
  /** Non-blocking issues surfaced after applying (warnings, or soft errors). */
  issues: ValidationIssue[];
}

export interface ApplyErr {
  ok: false;
  error: string;
}

export type ApplyResult = ApplyOk | ApplyErr;

/** Pull the first balanced top-level JSON object out of arbitrary text. */
function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  // Strip a ```json fence if present.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const body = fenced ? fenced[1]!.trim() : trimmed;

  const start = body.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

interface ParsedEnvelope {
  note: string;
  message: unknown;
}

/** Interpret the model's JSON as either `{note,message}` or a bare message. */
function parseEnvelope(raw: string): ParsedEnvelope | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const record = obj as Record<string, unknown>;

  // Preferred shape: { note, message }.
  if (record.message && typeof record.message === "object") {
    return {
      note: typeof record.note === "string" ? record.note : "Updated the message.",
      message: record.message,
    };
  }
  // Fallback: the object is itself a message (has a components array).
  if (Array.isArray(record.components)) {
    return { note: "Updated the message.", message: record };
  }
  return null;
}

/**
 * Apply a model response to the editor. Returns a typed result so the chat UI
 * can show the note, surface validation issues, or explain a parse failure.
 */
export function applyAiResponse(raw: string): ApplyResult {
  const envelope = parseEnvelope(raw);
  if (!envelope) {
    return {
      ok: false,
      error:
        "The model didn't return a usable message. Try rephrasing, or switch to a larger model.",
    };
  }

  const decoded = decodeJson(JSON.stringify(envelope.message));
  if (!decoded.ok) {
    return { ok: false, error: `The generated message was malformed: ${decoded.error}` };
  }

  const validation = validateMessage(decoded.message);
  // Apply regardless of warnings/errors — the editor already tolerates
  // in-progress invalid states and shows the same issues inline, so the user
  // can fix them or ask the assistant to.
  useMessageStore.getState().replaceMessage(decoded.message);

  return { ok: true, note: envelope.note, issues: validation.issues };
}
