/**
 * Prompt construction for the local assistant.
 *
 * The model never touches the editor tree directly. Instead it is asked to
 * return the *entire* message as a Discord Components V2 wire payload, which
 * we then run through the exact same import path a pasted JSON would take
 * (`decodeJson` → `attachEditorFields` → `validateMessage` → `replaceMessage`).
 * That keeps the AI on rails: anything it can produce, a human could have
 * pasted, so it can never push the editor into a state the rest of the app
 * can't represent.
 *
 * The schema reference below is hand-written rather than generated. A compact,
 * example-led description steers small on-device models far more reliably than
 * a formal JSON-Schema dump, and the response-format constraint (json_object)
 * handles syntactic validity.
 */

import { LIMITS } from "@/core/schema/limits";

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

const SCHEMA_REFERENCE = `You build Discord "Components V2" webhook messages. A message is a JSON object:

{
  "username": string?,          // optional webhook display-name override
  "avatar_url": string?,        // optional https avatar override
  "components": [ ... ]          // REQUIRED, 1..${LIMITS.TOP_LEVEL_COMPONENTS} top-level components, render order
}

There is NO "content" and NO "embeds" field in V2 — all visible text lives inside
TextDisplay components. Every component is an object with a numeric "type":

- Text (type 10):       { "type": 10, "content": "markdown string" }
    Discord markdown works: **bold**, *italic*, __underline__, ~~strike~~,
    \`code\`, > quote, # / ## / ### headings, - bullet lists, [label](https://url),
    <@123> user mention, <#123> channel, <@&123> role, :emoji:, and \\n newlines.

- Separator (type 14):  { "type": 14, "divider": true, "spacing": 1 }   // spacing 1=small 2=large

- Buttons row (type 1): { "type": 1, "components": [ ...up to ${LIMITS.ACTION_ROW_BUTTONS} buttons... ] }
    Link button:        { "type": 2, "style": 5, "label": "Open", "url": "https://..." }
    Colored button:     { "type": 2, "style": 1, "label": "Click", "custom_id": "unique_id" }
      styles: 1 blurple, 2 grey, 3 green, 4 red, 5 link(needs url). Colored buttons need a custom_id.
    A row holds EITHER buttons OR one select — never both.

- Section (type 9):     { "type": 9, "components": [ 1..${LIMITS.SECTION_TEXTS_MAX} Text objects ],
                          "accessory": <one Link/colored button OR a Thumbnail> }
    Thumbnail accessory: { "type": 11, "media": { "url": "https://image" }, "description": "alt"? }

- Media gallery (12):   { "type": 12, "items": [ { "media": { "url": "https://image" }, "description": "alt"? } ] }
    1..${LIMITS.GALLERY_ITEMS} items.

- Container (type 17):  { "type": 17, "accent_color": 5793266, "components": [ ...children... ] }
    accent_color is an RGB INTEGER (0..16777215) e.g. 0x5865F2 = 5793266, or omit for none.
    Children may be Text, Separator, Buttons row, Section, Media gallery, File — but NOT another Container.
    Use a Container for the classic "embed" look (colored left stripe).

- File (type 13):       { "type": 13, "file": { "url": "attachment://name.png" } }

Hard limits: ≤${LIMITS.TOTAL_COMPONENTS} components total, ≤${LIMITS.TOTAL_CHARACTERS} characters total,
button label ≤${LIMITS.BUTTON_LABEL} chars. Image/thumbnail URLs must be https.`;

const OUTPUT_CONTRACT = `Reply with ONE JSON object and nothing else, in this exact shape:

{
  "note": "<one short sentence describing what you built or changed>",
  "message": { "components": [ ... ] }
}

Rules:
- "message" must be the COMPLETE message after your change, not a diff. When editing,
  start from the current message and return the whole thing with your edit applied.
- Preserve parts of the current message the user did not ask you to change.
- Never include "_id", "content", or "embeds" at the message level. Use TextDisplay for text.
- Prefer a Container with an accent_color when the user wants something that looks like an embed.
- Keep it tasteful and within the limits above. Do not invent webhook URLs or tokens.`;

export function buildSystemPrompt(): string {
  return `You are an expert Discord message designer embedded in a visual webhook builder.
Your job is to translate a user's request into a valid Components V2 message.

${SCHEMA_REFERENCE}

${OUTPUT_CONTRACT}`;
}

/**
 * One-shot example. Concrete input/output pairs anchor small models on the
 * response contract far better than instructions alone.
 */
export function buildExampleTurns(): ChatTurn[] {
  return [
    {
      role: "user",
      content:
        'CURRENT MESSAGE:\n{\n  "components": []\n}\n\nREQUEST: A green-accented announcement card titled "We\'re live!" with a short line and a link button to example.com.',
    },
    {
      role: "assistant",
      content: JSON.stringify({
        note: 'Added a green container with a heading, a line of text, and a "Visit" link button.',
        message: {
          components: [
            {
              type: 17,
              accent_color: 5763719,
              components: [
                { type: 10, content: "# We're live!\nThanks for waiting — come check it out." },
                {
                  type: 1,
                  components: [{ type: 2, style: 5, label: "Visit", url: "https://example.com" }],
                },
              ],
            },
          ],
        },
      }),
    },
  ];
}

/** The per-request user turn: current message snapshot + the instruction. */
export function buildUserTurn(currentMessageJson: string, instruction: string): string {
  return `CURRENT MESSAGE:\n${currentMessageJson}\n\nREQUEST: ${instruction}`;
}
