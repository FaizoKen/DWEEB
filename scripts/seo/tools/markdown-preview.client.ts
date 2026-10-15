/**
 * Browser half of the live Discord markdown preview (see markdown-preview.ts).
 *
 * Bundled at build time into `dist/tools/discord-markdown-preview.js` by
 * `bundleGuideTools`, from the editor's own parser and timestamp formatter, so
 * the preview follows every Discord quirk the editor is tested against. The
 * rendered HTML comes from `renderDiscordMarkdownHtml`, which escapes every
 * value and never turns input into a link or attribute — that is what makes the
 * `innerHTML` assignment below safe for whatever a visitor pastes.
 */

import { formatTimestamp } from "@/features/preview/markdown/timestamp";
import { copyToClipboard } from "./base";
import { renderDiscordMarkdownHtml } from "./markdown-html";
import { openInDweebHref } from "./share-link";

const ENTRY = "guide:discord-text-formatting";
/** A share link past this length risks being cut by chat apps and proxies. */
const MAX_LINK_TEXT = 4000;
const RENDER_DELAY_MS = 60;

function init(root: HTMLElement): void {
  const q = <T extends Element>(selector: string) => root.querySelector<T>(selector);
  const input = q<HTMLTextAreaElement>("[data-md-input]");
  const output = q<HTMLElement>("[data-md-output]");
  const copy = q<HTMLButtonElement>("[data-md-copy]");
  const reset = q<HTMLButtonElement>("[data-md-reset]");
  const clear = q<HTMLButtonElement>("[data-md-clear]");
  const open = q<HTMLAnchorElement>("[data-md-open]");
  const count = q<HTMLElement>("[data-md-count]");
  if (!input || !output || !copy || !reset || !clear || !open || !count) return;

  const sample = input.defaultValue;
  const fallbackHref = open.getAttribute("href") ?? "/";
  let timer = 0;

  const render = () => {
    const text = input.value;
    output.innerHTML = renderDiscordMarkdownHtml(text, formatTimestamp);
    count.textContent = String(text.length);
    open.href =
      text.trim() && text.length <= MAX_LINK_TEXT ? openInDweebHref(text, ENTRY) : fallbackHref;
  };
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(render, RENDER_DELAY_MS);
  };

  input.addEventListener("input", schedule);
  reset.addEventListener("click", () => {
    input.value = sample;
    render();
    input.focus();
  });
  clear.addEventListener("click", () => {
    input.value = "";
    render();
    input.focus();
  });
  copy.addEventListener("click", () => {
    // When the page may not write the clipboard, select the text instead so a
    // keyboard copy still works.
    void copyToClipboard(input.value, copy).then((ok) => {
      if (!ok) input.select();
    });
  });
  // Spoilers reveal on click or Enter, like Discord's.
  const toggleSpoiler = (target: EventTarget | null) => {
    const spoiler = target instanceof Element ? target.closest(".md-spoiler") : null;
    if (spoiler) spoiler.toggleAttribute("data-open");
  };
  output.addEventListener("click", (event) => toggleSpoiler(event.target));
  output.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      if (event.target instanceof Element && event.target.closest(".md-spoiler")) {
        event.preventDefault();
        toggleSpoiler(event.target);
      }
    }
  });

  for (const control of [input, copy, reset, clear]) control.disabled = false;
  // Re-render once so timestamps show the visitor's own locale and timezone.
  render();
}

for (const root of document.querySelectorAll<HTMLElement>("[data-md-tool]")) init(root);
