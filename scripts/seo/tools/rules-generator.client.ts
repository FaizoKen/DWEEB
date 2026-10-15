/**
 * Browser half of the Discord rules generator (see rules-generator.ts).
 *
 * Bundled at build time into `dist/tools/discord-rules-generator.js`. The rule
 * list and composer come from `rules-data.ts`, the same module the build used
 * to write the page's default post, and the preview from the editor's parser.
 * Everything the visitor types reaches the page only through the escaping
 * renderer or a textarea's `value`.
 */

import { formatTimestamp } from "@/features/preview/markdown/timestamp";
import { copyToClipboard } from "./base";
import { renderDiscordMarkdownHtml } from "./markdown-html";
import {
  composeRules,
  RULES_GENERATOR_ENTRY,
  type ConsequenceStyle,
  type NumberStyle,
} from "./rules-data";
import { openInDweebHref } from "./share-link";

/** Discord's limit for one ordinary message. */
const MESSAGE_LIMIT = 2000;
const NUMBER_STYLES: readonly NumberStyle[] = ["bold", "emoji", "list"];
const CONSEQUENCE_STYLES: readonly ConsequenceStyle[] = ["ladder", "strict", "none"];

function init(root: HTMLElement): void {
  const q = <T extends Element>(selector: string) => root.querySelector<T>(selector);
  const title = q<HTMLInputElement>("[data-rg-title]");
  const numbers = q<HTMLSelectElement>("[data-rg-numbers]");
  const consequences = q<HTMLSelectElement>("[data-rg-consequences]");
  const contact = q<HTMLInputElement>("[data-rg-contact]");
  const date = q<HTMLInputElement>("[data-rg-date]");
  const output = q<HTMLTextAreaElement>("[data-rg-output]");
  const preview = q<HTMLElement>("[data-rg-preview]");
  const copy = q<HTMLButtonElement>("[data-rg-copy]");
  const open = q<HTMLAnchorElement>("[data-rg-open]");
  const status = q<HTMLElement>("[data-rg-status]");
  const rules = [...root.querySelectorAll<HTMLInputElement>("[data-rg-rule]")];
  if (
    !title ||
    !numbers ||
    !consequences ||
    !contact ||
    !date ||
    !output ||
    !preview ||
    !copy ||
    !open ||
    !status
  ) {
    return;
  }

  // Midnight today in the visitor's zone: a "last updated" date, not a time.
  const today = () => {
    const now = new Date();
    return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
  };

  const update = () => {
    const number = NUMBER_STYLES.find((style) => style === numbers.value) ?? "bold";
    const consequence =
      CONSEQUENCE_STYLES.find((style) => style === consequences.value) ?? "ladder";
    const text = composeRules({
      title: title.value,
      ruleIds: rules.filter((box) => box.checked).map((box) => box.value),
      numbers: number,
      consequences: consequence,
      contact: contact.value,
      updated: date.checked ? today() : null,
    });
    output.value = text;
    preview.innerHTML = renderDiscordMarkdownHtml(text, formatTimestamp);
    open.href = openInDweebHref(text, RULES_GENERATOR_ENTRY);
    const over = text.length > MESSAGE_LIMIT;
    status.toggleAttribute("data-over", over);
    status.textContent = over
      ? `${text.length} characters — over Discord's 2,000 for one message. Untick a few rules, or open it in DWEEB, where a card holds 4,000.`
      : `${text.length} characters · fits one Discord message (2,000)`;
  };

  for (const control of [title, contact]) control.addEventListener("input", update);
  for (const control of [numbers, consequences, date, ...rules])
    control.addEventListener("change", update);
  copy.addEventListener("click", () => {
    void copyToClipboard(output.value, copy).then((ok) => {
      if (!ok) output.select();
    });
  });

  for (const control of [title, numbers, consequences, contact, date, copy, ...rules]) {
    control.disabled = false;
  }
  date.checked = true;
  update();
}

for (const root of document.querySelectorAll<HTMLElement>("[data-rg-tool]")) init(root);
