/**
 * Resources — the reference material a client can pull in without spending a
 * tool call.
 *
 * Everything here is also reachable through a tool (`describe_schema`,
 * `list_templates`, `get_template`) and that duplication is deliberate: tools
 * are offered to the model by every client, resources are not. A client whose
 * user attaches `dweeb://guide` to the conversation gets the schema for free;
 * one that ignores resources entirely loses nothing.
 *
 * Resources are read-only and carry no secrets: the guide, the limits, and the
 * built-in templates are all public, static content.
 */

import { TEMPLATES } from "@/data/presets";
import { attachEditorFields } from "@/core/serialization/normalize";
import { authoringGuide, limitsTable } from "./guide";
import { toWire } from "./message";

export interface ResourceDescriptor {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

export interface ResourceTemplateDescriptor {
  uriTemplate: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

export interface ResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

const TEMPLATE_PREFIX = "dweeb://templates/";

export const RESOURCES: ResourceDescriptor[] = [
  {
    uri: "dweeb://guide",
    name: "components-v2-guide",
    title: "Components V2 authoring guide",
    description:
      "How to build a Discord Components V2 message: every component type, the hard limits, and the mistakes Discord rejects the whole message for.",
    mimeType: "text/markdown",
  },
  {
    uri: "dweeb://limits",
    name: "components-v2-limits",
    title: "Components V2 limits",
    description:
      "The numeric caps DWEEB enforces before Discord does — component counts, the message-wide character budget, and every per-field maximum.",
    mimeType: "application/json",
  },
  {
    uri: "dweeb://templates",
    name: "template-index",
    title: "Built-in template index",
    description:
      "Every built-in DWEEB template: id, name, category, and whether it needs an application-owned webhook.",
    mimeType: "application/json",
  },
];

export const RESOURCE_TEMPLATES: ResourceTemplateDescriptor[] = [
  {
    uriTemplate: "dweeb://templates/{id}",
    name: "template",
    title: "Template payload",
    description: "The complete Components V2 payload behind one built-in template.",
    mimeType: "application/json",
  },
];

/** Read a resource by URI. Returns null when nothing is registered under it —
 *  the protocol layer turns that into the spec's "resource not found". */
export function readResource(uri: string): ResourceContents | null {
  if (uri === "dweeb://guide") {
    return { uri, mimeType: "text/markdown", text: authoringGuide() };
  }
  if (uri === "dweeb://limits") {
    return { uri, mimeType: "application/json", text: JSON.stringify(limitsTable(), null, 2) };
  }
  if (uri === "dweeb://templates") {
    const index = TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      tags: t.tags ?? [],
      interactive: t.requiresBot === true,
      pairs_with: t.pairsWith ?? null,
      uri: `${TEMPLATE_PREFIX}${t.id}`,
    }));
    return { uri, mimeType: "application/json", text: JSON.stringify(index, null, 2) };
  }
  if (uri.startsWith(TEMPLATE_PREFIX)) {
    const id = uri.slice(TEMPLATE_PREFIX.length);
    const template = TEMPLATES.find((t) => t.id === id);
    if (!template) return null;
    const payload = toWire(attachEditorFields(toWire(template.message)));
    return { uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) };
  }
  return null;
}
