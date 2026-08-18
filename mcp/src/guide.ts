/**
 * The authoring guide handed to whatever model is driving this server.
 *
 * DWEEB already maintains exactly one canonical description of the Components
 * V2 wire format it accepts — `server/src/ai_prompt.txt`, shared verbatim
 * between the Rust proxy (`include_str!`) and the browser's AI panel so every
 * provider answers under identical instructions. Writing a second one here
 * would guarantee the two drift, and the drift would show up as messages
 * Discord rejects.
 *
 * One section of it does not apply, though. The shared template opens with an
 * output contract — "put the complete message in a single ```json block, the
 * app applies changes only from that block" — which describes the *editor's*
 * apply path. Over MCP there is no such block: the message travels as a tool
 * argument, and repeating the instruction invites a model to answer a tool call
 * with a fenced code block instead of calling the tool. So that one section is
 * replaced by the equivalent contract for this transport, and everything
 * downstream of it (the shape, the limits, the rejections, the habits) is used
 * exactly as written.
 *
 * The slice is by heading, and it is checked: if `ai_prompt.txt` ever loses the
 * headings this depends on, {@link authoringGuide} returns the full text
 * unmodified rather than silently dropping half the schema, and the test in
 * `guide.test.ts` fails so the drift is fixed rather than discovered in
 * production.
 */

import { SCHEMA_GUIDE } from "@/core/ai/systemPrompt";
import { LIMITS } from "@/core/schema/limits";

/** Heading that opens the editor-specific output contract. */
const CONTRACT_HEADING = "## Output contract (read carefully)";
/** Heading the schema proper starts at. */
const SHAPE_HEADING = "## Message object shape";

const MCP_CONTRACT = `## How this server is driven
- The message is a JSON object passed as the \`message\` argument of a tool — never a
  fenced code block in your reply. Describing a change does nothing; calling a tool does.
- Always pass the COMPLETE message object, never a partial diff. The tools replace,
  they do not merge.
- \`validate_message\` is cheap and exact: it runs Discord's own rules before Discord
  does, and names the path of every offending component. Run it before sending.
- \`preview_message\` re-states the payload as the layout a reader sees, which is the
  fastest way to catch nesting and ordering mistakes.
- \`create_share_link\` opens the message in DWEEB's visual editor. That is how a human
  reviews it — prefer offering the link over describing the message in prose.
- Never include editor-internal fields like \`_id\`. Never include \`content\` or
  \`embeds\` at the top level.`;

/** The schema half of the shared guide, or the whole text when the headings
 *  it is sliced by have moved. */
export function schemaSection(): string {
  const start = SCHEMA_GUIDE.indexOf(SHAPE_HEADING);
  return start === -1 ? SCHEMA_GUIDE : SCHEMA_GUIDE.slice(start).trimEnd();
}

/** True when the shared template still carries the two headings the slice
 *  depends on. Exported so the drift test can say which one moved. */
export function guideHeadingsPresent(): { contract: boolean; shape: boolean } {
  return {
    contract: SCHEMA_GUIDE.includes(CONTRACT_HEADING),
    shape: SCHEMA_GUIDE.includes(SHAPE_HEADING),
  };
}

/** The full guide as this server presents it: MCP's contract, then DWEEB's
 *  canonical schema description. */
export function authoringGuide(): string {
  const { contract, shape } = guideHeadingsPresent();
  if (!contract || !shape) return SCHEMA_GUIDE;
  return `${MCP_CONTRACT}\n\n${schemaSection()}`;
}

/** The hard limits, as data rather than prose — the guide states the ones that
 *  matter in a sentence, but a model fixing a specific overflow wants the
 *  number for that one field. Single source of truth: `core/schema/limits.ts`,
 *  which the validator enforces. */
export function limitsTable(): Record<string, number> {
  return { ...LIMITS };
}
