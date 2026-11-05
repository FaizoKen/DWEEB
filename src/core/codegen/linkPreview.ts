/**
 * The "Link preview" export: the message as a Discord **component embed** — the
 * `<script>` a website puts in its `<head>` so its links unfurl in Discord as
 * this layout (see `core/linkPreview/componentEmbed.ts` for the rules). Unlike
 * the other targets this isn't code that sends a message; it is markup a page
 * serves, so it carries the subset of the message a preview can show and says,
 * in an HTML comment, what was left out.
 */

import {
  buildComponentEmbed,
  componentEmbedScript,
  EMBED_DEBUGGER_URL,
} from "@/core/linkPreview/componentEmbed";
import type { CodegenInput } from "./payload";

export function generateLinkPreview(input: CodegenInput): string {
  const embed = buildComponentEmbed(input.payload.components);
  const notes = [
    ...(embed.wrapped
      ? ["Your message was wrapped in a Container: a preview is a single Container."]
      : []),
    ...embed.omitted,
    ...embed.problems,
  ];
  const head = [
    "<!--",
    "  Discord link preview (a component embed), designed in DWEEB (https://dweeb.faizo.net).",
    "  Paste the <script> below into the <head> of the page whose links should show it.",
    "  Discord reads it from the HTML your server sends and runs no JavaScript, so it",
    "  can't be added by a script. Keep your og: tags: they are Discord's fallback.",
    `  Check the live page in Discord's Embed Debugger: ${EMBED_DEBUGGER_URL}`,
    "  Discord caches a preview for about 30 minutes; share the link with ?v=2 to see a change sooner.",
    ...(notes.length ? ["", ...notes.map((line) => `  * ${line}`)] : []),
    "-->",
  ];
  if (!embed.payload) return [...head, ""].join("\n");
  return [...head, componentEmbedScript(embed.json), ""].join("\n");
}
