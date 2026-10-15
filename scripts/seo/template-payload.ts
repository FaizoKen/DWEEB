/** Public examples use the editor's export path, so the reference cannot drift from the tool. */
import type { MessageTemplate } from "@/data/presets";
import { ComponentType } from "@/core/schema/types";
import { encodeJson } from "@/core/serialization/encode";
import { countCharacters, countComponents, walk } from "@/core/schema/traversal";

export interface TemplatePayload {
  path: string;
  json: string;
  topLevel: number;
  components: number;
  characters: number;
  /**
   * Every Text Display's markdown in reading order, one blank line apart — the
   * part of the template a person can paste straight into a Discord channel.
   * Search Console's template queries are dominated by "copy and paste"
   * variants, and the page used to offer that text only inside the JSON.
   */
  text: string;
}

function messageText(template: MessageTemplate): string {
  const parts: string[] = [];
  for (const node of walk(template.message)) {
    if (node.type === ComponentType.TextDisplay && node.content.trim())
      parts.push(node.content.trim());
  }
  return parts.join("\n\n");
}

export function templatePayload(template: MessageTemplate, pagePath: string): TemplatePayload {
  return {
    path: `${pagePath}message.json`,
    json: encodeJson(template.message),
    topLevel: template.message.components.length,
    components: countComponents(template.message),
    characters: countCharacters(template.message),
    text: messageText(template),
  };
}
