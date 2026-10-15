/**
 * Browser half of the Discord color converter (see color-converter.ts).
 * Bundled at build time into `dist/tools/discord-color-converter.js`.
 * Every value written to the page is set with `textContent` or a computed
 * `#RRGGBB` style, never parsed HTML.
 */

import {
  colorFormats,
  parseColorInput,
  readableOn,
  type ColorFormats,
} from "@/core/color/colorCode";
import { copyToClipboard } from "./base";
import { BRAND_COLORS, LIBRARY_COLORS, PALETTE_2021, ROLE_PRESETS } from "./color-data";
import { openInDweebHref } from "./share-link";

const ENTRY = "guide:discord-color-codes";

/** What the status line says about a known color. */
function describeColor(value: number): string {
  const brand = [...BRAND_COLORS, ...PALETTE_2021].find((c) => c.value === value);
  const role = ROLE_PRESETS.find((c) => c.value === value);
  const library = LIBRARY_COLORS.find((c) => c.value === value);
  const parts: string[] = [];
  if (brand) parts.push(`Discord's ${brand.name}`);
  if (role) parts.push(`a role color preset (${role.name.toLowerCase()})`);
  if (library?.js) parts.push(`discord.js Colors.${library.js}`);
  if (library?.py) parts.push(`discord.py Colour.${library.py}`);
  return parts.length > 0 ? `This is ${parts.join(", ")}.` : "A custom color.";
}

function init(root: HTMLElement): void {
  const q = <T extends Element>(selector: string) => root.querySelector<T>(selector);
  const input = q<HTMLInputElement>("[data-cc-input]");
  const picker = q<HTMLInputElement>("[data-cc-picker]");
  const sample = q<HTMLElement>("[data-cc-sample]");
  const status = q<HTMLElement>("[data-cc-status]");
  const card = q<HTMLElement>("[data-cc-card]");
  const open = q<HTMLAnchorElement>("[data-cc-open]");
  if (!input || !picker || !sample || !status || !card || !open) return;
  const outputs = Array.from(root.querySelectorAll<HTMLElement>("[data-cc-out]"));
  const copies = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-cc-copy]"));
  const swatches = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-cc-swatch]"));

  let current: ColorFormats = colorFormats(0x5865f2);

  const show = (value: number, from: "input" | "picker" | "swatch") => {
    current = colorFormats(value);
    for (const output of outputs) {
      const key = output.dataset.ccOut as keyof ColorFormats;
      output.textContent = current[key];
    }
    sample.style.background = current.hex;
    sample.style.color = readableOn(value);
    card.style.borderLeftColor = current.hex;
    if (from !== "picker") picker.value = current.hex.toLowerCase();
    if (from !== "input") input.value = current.hex;
    status.textContent = describeColor(value);
    open.href = openInDweebHref(
      `## Accent ${current.hex}\nThis card's accent color is \`${current.decimal}\` — paste it into any \`accent_color\`.`,
      ENTRY,
      value,
    );
  };

  input.addEventListener("input", () => {
    const value = parseColorInput(input.value);
    if (value === null) {
      status.textContent = input.value.trim()
        ? "Not a color Discord accepts yet — try #5865F2, 0x5865F2, 5793266 or rgb(88, 101, 242)."
        : "Paste or type a color.";
      return;
    }
    show(value, "input");
  });
  picker.addEventListener("input", () => {
    const value = parseColorInput(picker.value);
    if (value !== null) show(value, "picker");
  });
  for (const swatch of swatches) {
    swatch.addEventListener("click", () => show(Number(swatch.dataset.ccSwatch), "swatch"));
  }
  for (const button of copies) {
    button.addEventListener("click", () => {
      const key = button.dataset.ccCopy as keyof ColorFormats;
      void copyToClipboard(current[key], button);
    });
  }

  for (const control of [input, picker, ...copies, ...swatches]) control.disabled = false;
  show(0x5865f2, "swatch");
}

for (const root of document.querySelectorAll<HTMLElement>("[data-cc-tool]")) init(root);
