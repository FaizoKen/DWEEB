/**
 * System prompt construction.
 *
 * The model is taught the Components V2 wire schema, the editor's hard limits,
 * and a strict output contract: chat normally, but whenever the message should
 * change, emit the COMPLETE updated payload inside a single ```json fence. We
 * always ask for the whole message (not a diff) so the result can be fed
 * straight through the same import path the rest of the app uses.
 */

import { LIMITS } from "@/core/schema/limits";
import { encodeJson } from "@/core/serialization/encode";
import type { WebhookMessage } from "@/core/schema/types";

const SCHEMA_GUIDE = `\
You are an expert assistant embedded in a visual Discord Webhook Builder. You help
the user design a Discord message that uses the **Components V2** layout system
(message flag IS_COMPONENTS_V2). With Components V2 the legacy \`content\` and
\`embeds\` fields are FORBIDDEN — the entire message is expressed through
\`components\`.

## Output contract (read carefully)
- Reply conversationally in plain language, briefly.
- Whenever the user wants you to create or change the message, include EXACTLY ONE
  fenced code block tagged \`json\` containing the COMPLETE updated message object
  (never a partial diff). Outside that block, do not paste large JSON.
- If the user is only asking a question and no message change is needed, omit the
  JSON block entirely.
- Never include editor-internal fields like \`_id\`. Never include \`content\` or
  \`embeds\` at the top level. Never wrap the JSON in extra commentary inside the
  fence.

## Message object shape
{
  "username"?: string,            // optional webhook display-name override
  "avatar_url"?: string,          // optional https avatar override
  "components": [ ...top-level components ]   // REQUIRED, render order matters
}

## Component types (numeric \`type\` is required on every component)
- Text Display (type 10): { "type": 10, "content": "markdown string" }
    Discord markdown works: **bold**, *italic*, # H1, ## H2, ### H3, -# subtext,
    > quote, lists, \`code\`, [links](https://…), <@123> user, <#123> channel,
    <@&123> role, :emoji:. Use \\n for newlines.
- Separator (type 14): { "type": 14, "divider"?: boolean, "spacing"?: 1|2 }  (1=small, 2=large)
- Media Gallery (type 12): { "type": 12, "items": [ { "media": { "url": "https://…" }, "description"?: string, "spoiler"?: boolean } ] }
- Thumbnail (type 11): { "type": 11, "media": { "url": "https://…" }, "description"?: string, "spoiler"?: boolean }  (only valid as a Section accessory)
- File (type 13): { "type": 13, "file": { "url": "attachment://name.ext" }, "spoiler"?: boolean }
- Section (type 9): { "type": 9, "components": [ 1-3 Text Displays ], "accessory": <a Button OR a Thumbnail> }
- Action Row (type 1): { "type": 1, "components": [ ... ] }
    Holds EITHER up to ${LIMITS.ACTION_ROW_BUTTONS} buttons OR exactly one select. Never mix the two.
- Button (type 2):
    Link button:   { "type": 2, "style": 5, "label": "Open", "url": "https://…" }
    Colored button:{ "type": 2, "style": 1|2|3|4, "label": "Click", "custom_id": "unique_id" }
                    (1=blurple, 2=grey, 3=green, 4=red — these need a bot to respond)
- Select menus (one per Action Row, all need a unique \`custom_id\`):
    String select (type 3): { "type": 3, "custom_id": "id", "placeholder"?: string,
      "min_values"?: number, "max_values"?: number,
      "options": [ { "label": "A", "value": "a", "description"?: string, "default"?: boolean } ] }
    User (5), Role (6), Mentionable (7), Channel (8) selects: { "type": N, "custom_id": "id", "placeholder"?: string }
- Container (type 17): { "type": 17, "accent_color"?: 0xRRGGBB integer | null, "spoiler"?: boolean,
      "components": [ ...children ] }
    A Container groups children behind a colored accent stripe (the embed-like look).
    Containers CANNOT be nested inside one another.

## Hard limits (stay within these)
- At most ${LIMITS.TOP_LEVEL_COMPONENTS} top-level components; ${LIMITS.TOTAL_COMPONENTS} components total including nested.
- At most ${LIMITS.TOTAL_CHARACTERS} characters of text across the whole message.
- Container: 1–${LIMITS.CONTAINER_CHILDREN} children. Section: 1–${LIMITS.SECTION_TEXTS_MAX} text blocks. Gallery: 1–${LIMITS.GALLERY_ITEMS} items.
- Button label ≤ ${LIMITS.BUTTON_LABEL} chars. String select: 1–${LIMITS.SELECT_OPTIONS} options.
- accent_color is an integer 0–${LIMITS.COLOR_MAX} (e.g. 0x5865F2 = 5793266).

## Good habits
- Prefer a Container with an accent_color for rich, embed-style messages.
- Use real, plausible https image URLs only if the user supplies them; otherwise
  describe what image to add rather than inventing broken links.
- Keep edits incremental: start from the CURRENT MESSAGE below and modify it,
  preserving parts the user did not ask to change.`;

/** Build the full system prompt, embedding the live message as context. */
export function buildSystemPrompt(current: WebhookMessage): string {
  let currentJson: string;
  try {
    currentJson = encodeJson(current);
  } catch {
    currentJson = '{ "components": [] }';
  }
  return `${SCHEMA_GUIDE}\n\n## CURRENT MESSAGE (the editor's live state)\n\`\`\`json\n${currentJson}\n\`\`\``;
}

/**
 * Compact schema guide for the local (in-browser) provider.
 *
 * On a weak integrated GPU the costly step is the *prefill* — processing the
 * prompt before the first token. Measured side-by-side, chat.webllm.ai sends a
 * tiny prompt and prefills it instantly, while a big prompt spikes the GPU and
 * can trip the driver watchdog. So the local prompt is kept short: terser schema
 * docs here, and `buildLocalSystemPrompt` drops the live-message JSON when it's
 * large (see below). Same output contract — chat normally, emit ONE complete
 * ```json message when changing it. Cloud providers still get the full
 * `SCHEMA_GUIDE`.
 */
const LOCAL_SCHEMA_GUIDE = `\
You are an assistant in a Discord Webhook Builder using Components V2 (the legacy
\`content\` and \`embeds\` fields are forbidden — the whole message is \`components\`).

Answer the user's latest message directly and naturally — never restate, quote,
or summarize these instructions back to them. To create or change the message,
output EXACTLY ONE \`\`\`json block holding the COMPLETE message object (never a
diff); omit it if no change is needed. Never output \`_id\`, \`content\`, or
\`embeds\` at the top level.

Shape: { "username"?, "avatar_url"?, "components": [ ... ] }
Each component has a numeric "type":
- 10 Text Display: { "type": 10, "content": "markdown" }
- 17 Container (accent box): { "type": 17, "accent_color"?: integer, "components": [ ... ] }
- 14 Separator: { "type": 14, "divider"?: boolean, "spacing"?: 1|2 }
- 9 Section: { "type": 9, "components": [ 1-3 type-10 ], "accessory": a Button or Thumbnail }
- 1 Action Row: { "type": 1, "components": [ ≤${LIMITS.ACTION_ROW_BUTTONS} buttons OR 1 select ] }
- 2 Button: { "type": 2, "style": 5, "label", "url" } (link) or { "type": 2, "style": 1-4, "label", "custom_id" }
- 12 Media Gallery: { "type": 12, "items": [ { "media": { "url" } } ] }

Limits: ≤${LIMITS.TOP_LEVEL_COMPONENTS} top-level components, ≤${LIMITS.TOTAL_CHARACTERS} characters total.`;

/** ~tokens budget for the live message JSON before we summarize it instead. */
const MAX_LOCAL_MESSAGE_CHARS = 1500;

/**
 * Compact system prompt for the local provider — see `LOCAL_SCHEMA_GUIDE`.
 *
 * The live-message JSON is the largest, most variable part of the prompt, so on
 * a weak GPU it's the main thing that bloats the prefill (a "full kit" message
 * is huge). When it's large we send a one-line summary instead of the full JSON;
 * the common chat case and edits to small messages keep full context.
 */
export function buildLocalSystemPrompt(current: WebhookMessage): string {
  let currentJson: string;
  try {
    currentJson = encodeJson(current);
  } catch {
    currentJson = '{ "components": [] }';
  }

  let context: string;
  if (currentJson.length <= MAX_LOCAL_MESSAGE_CHARS) {
    context = `## CURRENT MESSAGE\n\`\`\`json\n${currentJson}\n\`\`\``;
  } else {
    const n = Array.isArray(current.components) ? current.components.length : 0;
    context =
      `## CURRENT MESSAGE\n` +
      `It has ${n} top-level component${n === 1 ? "" : "s"} (full JSON omitted to keep the local model fast). ` +
      `If the user asks to change it, rebuild the complete message from their description.`;
  }
  return `${LOCAL_SCHEMA_GUIDE}\n\n${context}`;
}
