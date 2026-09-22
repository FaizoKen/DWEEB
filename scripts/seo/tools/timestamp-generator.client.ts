/**
 * Browser half of the Discord timestamp generator (see timestamp-generator.ts).
 *
 * Bundled at build time into `dist/tools/discord-timestamp-generator.js` by
 * `bundleGuideTools`, from the same `timestamp.ts` the editor's preview and
 * timestamp picker use — so a code copied here previews in DWEEB exactly as it
 * renders in Discord, and a tenth style added there appears here for free.
 *
 * Everything is written with `textContent`; nothing a visitor types is ever
 * parsed as HTML. The page's static table stays the fallback until this runs.
 */

import {
  formatTimestamp,
  isTimestampStyle,
  parseTimestampInput,
  TIMESTAMP_STYLES,
  timestampToken,
  type TimestampStyleCode,
} from "@/features/preview/markdown/timestamp";

const p2 = (n: number) => String(n).padStart(2, "0");
const dateValue = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const timeValue = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
const labelOf = (code: string) =>
  TIMESTAMP_STYLES.find((style) => style.code === code)?.label ?? code;

function init(root: HTMLElement): void {
  const q = <T extends Element>(selector: string) => root.querySelector<T>(selector);
  const date = q<HTMLInputElement>("[data-ts-date]");
  const time = q<HTMLInputElement>("[data-ts-time]");
  const raw = q<HTMLInputElement>("[data-ts-raw]");
  const now = q<HTMLButtonElement>("[data-ts-now]");
  const status = q<HTMLElement>("[data-ts-status]");
  const unixOut = q<HTMLElement>("[data-ts-unix]");
  const zoneOut = q<HTMLElement>("[data-ts-zone]");
  if (!date || !time || !raw || !now || !status) return;

  const rows = [...root.querySelectorAll<HTMLTableRowElement>("tr[data-ts-style]")].flatMap(
    (row) => {
      const style = row.dataset.tsStyle ?? "";
      const code = row.querySelector<HTMLElement>("[data-ts-code]");
      const preview = row.querySelector<HTMLElement>("[data-ts-preview]");
      const copy = row.querySelector<HTMLButtonElement>("[data-ts-copy]");
      return isTimestampStyle(style) && code && preview && copy
        ? [{ row, style, code, preview, copy }]
        : [];
    },
  );

  let unix = Math.floor(Date.now() / 60_000) * 60;
  let highlighted: TimestampStyleCode | null = null;

  const say = (message: string) => {
    status.textContent = message;
  };

  const render = () => {
    for (const { row, style, code, preview, copy } of rows) {
      code.textContent = timestampToken(unix, style);
      preview.textContent = formatTimestamp(unix, style);
      copy.setAttribute("aria-label", `Copy the ${labelOf(style).toLowerCase()} code`);
      row.toggleAttribute("data-ts-active", style === highlighted);
    }
    if (unixOut) unixOut.textContent = String(unix);
  };

  const syncPicker = () => {
    const at = new Date(unix * 1000);
    date.value = dateValue(at);
    time.value = timeValue(at);
  };

  const fromPicker = () => {
    if (!date.value) return;
    // Local wall-clock time (no trailing Z): the moment the visitor means in
    // their own zone, which is what Discord converts for everyone else.
    const at = new Date(`${date.value}T${time.value || "00:00:00"}`);
    if (Number.isNaN(at.getTime())) return;
    unix = Math.floor(at.getTime() / 1000);
    highlighted = null;
    raw.value = "";
    render();
    say("Copy a code below and paste it into Discord. Readers see it in their own timezone.");
  };

  const fromRaw = () => {
    const value = raw.value.trim();
    if (!value) return;
    const parsed = parseTimestampInput(value);
    if (!parsed) {
      say("Paste a unix timestamp in seconds, or a code such as <t:1767225600:R>.");
      return;
    }
    unix = parsed.unix;
    highlighted = parsed.style ?? null;
    syncPicker();
    render();
    const when = formatTimestamp(unix, "F");
    say(
      parsed.fromMilliseconds
        ? `That looked like milliseconds, so it was divided by 1000: ${when} in your timezone.`
        : `Decoded: ${when} in your timezone.`,
    );
  };

  const copyCode = async (token: string, button: HTMLButtonElement, code: HTMLElement) => {
    try {
      await navigator.clipboard.writeText(token);
      button.textContent = "Copied";
      button.setAttribute("data-copied", "");
      say(`Copied ${token}. Paste it into any Discord message.`);
      window.setTimeout(() => {
        button.textContent = "Copy";
        button.removeAttribute("data-copied");
      }, 1600);
    } catch {
      // Clipboard access can be refused (permissions, an insecure context, an
      // embedding frame). Select the code instead so a keyboard copy works.
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(code);
      selection?.removeAllRanges();
      selection?.addRange(range);
      say(`Press Ctrl+C (or ⌘C) to copy ${token}.`);
    }
  };

  for (const { copy, code } of rows) {
    copy.disabled = false;
    copy.addEventListener("click", () => void copyCode(code.textContent ?? "", copy, code));
  }
  date.addEventListener("input", fromPicker);
  time.addEventListener("input", fromPicker);
  raw.addEventListener("input", fromRaw);
  now.addEventListener("click", () => {
    unix = Math.floor(Date.now() / 1000);
    highlighted = null;
    raw.value = "";
    syncPicker();
    render();
    say("Set to now. Copy a code below and paste it into Discord.");
  });

  // Only the relative style changes on its own; refresh it while visible.
  window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    for (const { style, preview } of rows) {
      if (style === "R") preview.textContent = formatTimestamp(unix, "R");
    }
  }, 1000);

  if (zoneOut) {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    zoneOut.textContent = zone ? `shown in your timezone (${zone})` : "shown in your timezone";
  }
  for (const control of [date, time, raw, now]) control.disabled = false;
  syncPicker();
  render();
  say("Showing now in your timezone. Pick another date or time, then copy a code.");
}

const root = document.querySelector<HTMLElement>("[data-timestamp-tool]");
if (root) init(root);
