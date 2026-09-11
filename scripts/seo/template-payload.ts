/** Public examples use the editor's export path, so the reference cannot drift from the tool. */
import type { MessageTemplate } from "@/data/presets";
import { encodeJson } from "@/core/serialization/encode";
import { countCharacters, countComponents } from "@/core/schema/traversal";

export interface TemplatePayload {
  path: string;
  json: string;
  topLevel: number;
  components: number;
  characters: number;
}

export function templatePayload(template: MessageTemplate, pagePath: string): TemplatePayload {
  return {
    path: `${pagePath}message.json`,
    json: encodeJson(template.message),
    topLevel: template.message.components.length,
    components: countComponents(template.message),
    characters: countCharacters(template.message),
  };
}
