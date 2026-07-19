/**
 * System prompt construction.
 *
 * The model is taught the Components V2 wire schema, the editor's hard limits,
 * and a strict output contract: chat normally, but whenever the message should
 * change, emit the COMPLETE updated payload inside a single ```json fence. We
 * always ask for the whole message (not a diff) so the result can be fed
 * straight through the same import path the rest of the app uses.
 *
 * The instruction template itself lives in `server/src/ai_prompt.txt` — ONE
 * canonical copy shared with the Rust proxy, which embeds it via `include_str!`
 * for the built-in (server-relayed) provider. The BYOK providers get the same
 * text from here, so every provider answers under an identical prompt. It must
 * stay inside `server/src/` because the server's Docker build context only
 * copies that directory. `systemPrompt.test.ts` guards the baked-in limit
 * numbers against `LIMITS` drift.
 */

import rawGuide from "../../../server/src/ai_prompt.txt?raw";
import { encodeJson } from "@/core/serialization/encode";
import type { WebhookMessage } from "@/core/schema/types";

/** The shared instruction template, newline-normalized (a Windows checkout may
 *  hand the raw import CRLF line endings) and without the trailing newline so
 *  both sides assemble byte-identical prompts. Exported for the drift test. */
export const SCHEMA_GUIDE: string = rawGuide.replace(/\r\n/g, "\n").trimEnd();

/**
 * The live message as the JSON the prompt embeds — also what the built-in
 * provider sends to the proxy as `context` (the server wraps it under its own
 * copy of the template, so the client never supplies instructions).
 */
export function buildPromptContext(current: WebhookMessage): string {
  try {
    return encodeJson(current);
  } catch {
    return '{ "components": [] }';
  }
}

/** Build the full system prompt, embedding the live message as context. Keep
 *  this byte-identical to the server's `build_system` (`server/src/ai.rs`). */
export function buildSystemPrompt(current: WebhookMessage): string {
  return (
    `${SCHEMA_GUIDE}\n\n## CURRENT MESSAGE (the editor's live state)\n` +
    "This is the live editor state right now — any json block you emitted earlier " +
    "has already been applied to it. Base your next edit on THIS, not on memory.\n" +
    `\`\`\`json\n${buildPromptContext(current)}\n\`\`\``
  );
}

/**
 * Build the follow-up prompt for a missing-payload recovery turn.
 *
 * Cheap models sometimes ANNOUNCE an edit ("Here's a streamlined version!")
 * without emitting the JSON block — so nothing reaches the editor while the
 * chat claims otherwise. When the store detects that, it sends this single
 * nudge. The NO_CHANGE escape keeps a false-positive detection harmless: the
 * model can simply decline instead of inventing an unwanted edit.
 */
export function buildMissingPayloadPrompt(): string {
  return (
    "Your previous reply described a change but did not include the ```json block, " +
    "so NOTHING was applied to the editor — the app only applies changes carried " +
    "in that block. If the message should change, reply now with the COMPLETE " +
    "updated message as a single ```json block, with nothing after it. If you did " +
    "not intend to change the message, reply with exactly NO_CHANGE and nothing else."
  );
}

/**
 * Build the follow-up prompt for a self-repair turn.
 *
 * When the model's payload fails validation we feed the exact problems back and
 * ask for a corrected COMPLETE message. The validator's messages are precise
 * and actionable, so even a cheap model reliably fixes them on the second pass —
 * this is what turns "updated · 3 validation issues" into a clean message.
 */
export function buildRepairPrompt(errors: string[]): string {
  const list = errors.map((e) => `- ${e}`).join("\n");
  return (
    "The JSON you produced has problems that will make Discord reject the message:\n" +
    `${list}\n\n` +
    "Return the COMPLETE corrected message as a single ```json block, fixing every " +
    "issue above. Change only what's needed to resolve them — keep everything else " +
    "the same. Output nothing after the json block."
  );
}
