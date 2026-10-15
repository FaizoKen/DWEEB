/**
 * Browser half of the Discord colored text generator (see colored-text.ts).
 *
 * Bundled at build time into `dist/tools/discord-colored-text-generator.js` by
 * `bundleGuideTools`. The editor's truth is a list of styled runs, not its DOM:
 * every edit is read back into runs and the input re-rendered from them, so
 * whatever the browser does inside a contenteditable (a `<div>` per line, a
 * stray `<b>` from Ctrl+B) never reaches the output. The output is the runs
 * encoded by `encodeAnsi`, and the preview is that exact string parsed back by
 * `parseAnsi` — the parser differentially tested against Discord's — so the
 * preview shows what Discord will draw from what the visitor copies.
 *
 * Every assignment to `innerHTML` below takes HTML from `ansi-html.ts`, which
 * escapes all text and only ever writes computed colors into attributes.
 */

import {
  ANSI_PALETTES,
  ansiCodesFor,
  encodeAnsi,
  parseAnsi,
  usesExtendedAnsi,
  type AnsiColor,
  type AnsiSegment,
  type AnsiTheme,
} from "@/features/preview/markdown/ansi";
import { copyToClipboard } from "./base";
import {
  ANSI_THEMES,
  DEFAULT_ANSI_THEME,
  ansiSegmentsHtml,
  ansiStringLiteral,
  discordAnsiBlock,
} from "./ansi-html";
import { COLORED_TEXT_SAMPLE } from "./colored-text-sample";
import { openInDweebHref } from "./share-link";

const ENTRY = "guide:discord-colored-text";
/** A share link past this length risks being cut by chat apps and proxies. */
const MAX_LINK_TEXT = 4000;
const MESSAGE_LIMIT = 2000;
const HISTORY_LIMIT = 100;
/** Keystrokes closer together than this undo as one step. */
const TYPING_COALESCE_MS = 800;
const ESC = String.fromCharCode(0x1b);

type Style = Omit<AnsiSegment, "text">;
type StyleFlag = "bold" | "italic" | "underline" | "strike";

const PLAIN: Style = {
  fg: null,
  bg: null,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  overline: false,
};

interface Char {
  c: string;
  s: Style;
}

const styleKey = (style: Style) => ansiCodesFor(style).join(";");

function toChars(segments: readonly AnsiSegment[]): Char[] {
  const chars: Char[] = [];
  for (const { text, ...style } of segments) {
    for (let i = 0; i < text.length; i++) chars.push({ c: text[i]!, s: style });
  }
  return chars;
}

function toSegments(chars: readonly Char[]): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let key = "";
  for (const { c, s } of chars) {
    const k = styleKey(s);
    const last = segments.at(-1);
    if (last && k === key) last.text += c;
    else segments.push({ ...s, text: c });
    key = k;
  }
  return segments;
}

/** Runs whose text contains no escapes, from pasted text that may contain some. */
function segmentsFromPaste(text: string): AnsiSegment[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized.includes(ESC)) return [{ ...PLAIN, text: normalized }];
  // Text copied out of a Discord message carries its fences; keep the body.
  const fenced = /^\s*```ansi[^\n]*\n([\s\S]*?)\n?```\s*$/i.exec(normalized);
  return parseAnsi(fenced ? fenced[1]! : normalized).map(({ text: t, ...s }) => ({
    ...PLAIN,
    ...s,
    text: t,
  }));
}

function styleFromCodes(codes: string): Style {
  const [segment] = parseAnsi(`${ESC}[${codes}mx`);
  if (!segment) return PLAIN;
  return {
    fg: segment.fg,
    bg: segment.bg,
    bold: segment.bold,
    italic: segment.italic,
    underline: segment.underline,
    strike: segment.strike,
    overline: segment.overline,
  };
}

/**
 * Reads a subtree as runs. `<br>` is a newline (except the trailing filler the
 * renderer adds), a block element starts a new line, and a `data-ansi` span
 * sets the style of everything inside it.
 */
function readRuns(root: Node): AnsiSegment[] {
  const chars: Char[] = [];
  const push = (text: string, style: Style) => {
    for (let i = 0; i < text.length; i++) chars.push({ c: text[i]!, s: style });
  };
  const walk = (node: Node, style: Style) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        push((child as Text).data, style);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = child as Element;
      const tag = element.tagName;
      if (tag === "BR") {
        if (!element.hasAttribute("data-filler")) push("\n", style);
        continue;
      }
      if ((tag === "DIV" || tag === "P") && chars.length > 0 && chars.at(-1)!.c !== "\n") {
        push("\n", style);
      }
      const codes = element.getAttribute("data-ansi");
      walk(element, codes !== null ? styleFromCodes(codes) : style);
    }
  };
  walk(root, PLAIN);
  return toSegments(chars);
}

const runsLength = (runs: readonly AnsiSegment[]) =>
  runs.reduce((sum, run) => sum + run.text.length, 0);

/** Character offset of a DOM point inside `root`, counted the way `readRuns` reads. */
function offsetOf(root: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(node, offset);
  return runsLength(readRuns(range.cloneContents()));
}

/** The DOM point for a character offset in the editor as the renderer wrote it. */
function pointAt(root: HTMLElement, target: number): [Node, number] {
  let count = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      const length = (node as Text).data.length;
      if (target <= count + length) return [node, target - count];
      count += length;
    } else if ((node as Element).tagName === "BR") {
      const parent = node.parentNode!;
      if (target === count) return [parent, Array.prototype.indexOf.call(parent.childNodes, node)];
      if (!(node as Element).hasAttribute("data-filler")) count += 1;
    }
  }
  return [root, root.childNodes.length];
}

function init(root: HTMLElement): void {
  const q = <T extends Element>(selector: string) => root.querySelector<T>(selector);
  const editor = q<HTMLElement>("[data-ansi-editor]");
  const preview = q<HTMLElement>("[data-ansi-preview]");
  const surface = q<HTMLElement>("[data-ansi-surface]");
  const literal = q<HTMLElement>("[data-ansi-literal]");
  const status = q<HTMLElement>("[data-ansi-status]");
  const themeSelect = q<HTMLSelectElement>("[data-ansi-theme]");
  const copy = q<HTMLButtonElement>("[data-ansi-copy]");
  const copyCode = q<HTMLButtonElement>("[data-ansi-copy-code]");
  const open = q<HTMLAnchorElement>("[data-ansi-open]");
  const reset = q<HTMLButtonElement>("[data-ansi-reset]");
  const empty = q<HTMLButtonElement>("[data-ansi-empty]");
  const clear = q<HTMLButtonElement>("[data-ansi-clear]");
  if (
    !editor ||
    !preview ||
    !surface ||
    !literal ||
    !status ||
    !themeSelect ||
    !copy ||
    !copyCode ||
    !open ||
    !reset ||
    !empty ||
    !clear
  ) {
    return;
  }
  const styleButtons = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-ansi-style]"));
  const fgButtons = Array.from(root.querySelectorAll<HTMLButtonElement>("button[data-ansi-fg]"));
  const bgButtons = Array.from(root.querySelectorAll<HTMLButtonElement>("button[data-ansi-bg]"));
  const fgCustom = q<HTMLInputElement>("[data-ansi-fg-custom]");
  const bgCustom = q<HTMLInputElement>("[data-ansi-bg-custom]");
  const fallbackHref = open.getAttribute("href") ?? "/";

  let theme: AnsiTheme = DEFAULT_ANSI_THEME;
  let model: AnsiSegment[] = COLORED_TEXT_SAMPLE.map((run) => ({ ...run }));
  /** The last selection inside the editor, kept while focus is on a control. */
  let selection: [number, number] | null = null;
  let composing = false;
  const undo: { model: AnsiSegment[]; selection: [number, number] | null }[] = [];
  const redo: typeof undo = [];
  let lastTyping = 0;

  const remember = (typing = false) => {
    const now = Date.now();
    if (typing && now - lastTyping < TYPING_COALESCE_MS) {
      lastTyping = now;
      return;
    }
    lastTyping = typing ? now : 0;
    undo.push({ model, selection });
    if (undo.length > HISTORY_LIMIT) undo.shift();
    redo.length = 0;
  };

  const liveSelection = (): [number, number] | null => {
    const current = window.getSelection();
    if (!current || current.rangeCount === 0) return null;
    const range = current.getRangeAt(0);
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
    return [
      offsetOf(editor, range.startContainer, range.startOffset),
      offsetOf(editor, range.endContainer, range.endOffset),
    ];
  };

  const select = ([start, end]: [number, number]) => {
    const current = window.getSelection();
    if (!current) return;
    const range = document.createRange();
    const [startNode, startOffset] = pointAt(editor, start);
    const [endNode, endOffset] = pointAt(editor, end);
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    current.removeAllRanges();
    current.addRange(range);
    selection = [start, end];
  };

  const say = (message: string) => {
    status.textContent = message;
  };

  const describe = (ansi: string): string => {
    const length = discordAnsiBlock(ansi).length;
    const parts = [
      `${length.toLocaleString("en-US")} characters with the code block and escape codes`,
      length > MESSAGE_LIMIT
        ? "over the 2,000 a normal message allows (4,000 with Nitro or in a webhook's Components V2 text)"
        : "a message allows 2,000 (4,000 with Nitro or in a webhook's Components V2 text)",
    ];
    let text = parts.join(" · ") + ".";
    if (usesExtendedAnsi(ansi)) {
      text +=
        " ✦ Uses bright or custom colors, italic or strikethrough: readers on Discord's older renderer see those parts as plain text.";
    }
    return text;
  };

  const updatePressed = () => {
    const range = selection && selection[0] !== selection[1] ? selection : null;
    const chars = range ? toChars(model).slice(Math.min(...range), Math.max(...range)) : [];
    for (const button of styleButtons) {
      const flag = button.dataset.ansiStyle as StyleFlag;
      button.setAttribute(
        "aria-pressed",
        String(chars.length > 0 && chars.every((char) => char.s[flag])),
      );
    }
  };

  const paintSwatches = () => {
    const palette = ANSI_PALETTES[theme];
    for (const button of [...fgButtons, ...bgButtons]) {
      const value = button.dataset.ansiFg ?? button.dataset.ansiBg;
      if (value && value !== "none") button.style.background = palette[Number(value)] ?? "";
    }
  };

  const render = (keep: [number, number] | null = null) => {
    editor.innerHTML = ansiSegmentsHtml(model, theme, true);
    const ansi = encodeAnsi(model);
    // The preview is the output read back, not the model: it shows what the
    // copied text will do.
    preview.innerHTML = ansiSegmentsHtml(parseAnsi(ansi), theme);
    literal.textContent = ansiStringLiteral(ansi);
    say(describe(ansi));
    const block = discordAnsiBlock(ansi);
    open.href =
      ansi.trim() && block.length <= MAX_LINK_TEXT ? openInDweebHref(block, ENTRY) : fallbackHref;
    if (keep) select(keep);
    updatePressed();
  };

  const range = (): [number, number] | null => {
    const current = liveSelection() ?? selection;
    if (!current || current[0] === current[1]) return null;
    return [Math.min(...current), Math.max(...current)];
  };

  const restyle = (change: (style: Style, all: readonly Char[]) => Style) => {
    const target = range();
    if (!target) {
      say("Select some text in the box first, then pick a style or a color.");
      editor.focus();
      return;
    }
    remember();
    const chars = toChars(model);
    const picked = chars.slice(target[0], target[1]);
    for (let i = target[0]; i < target[1]; i++) chars[i]!.s = change(chars[i]!.s, picked);
    model = toSegments(chars);
    editor.focus();
    render(target);
  };

  const insert = (runs: readonly AnsiSegment[], inheritStyle: boolean) => {
    const current = liveSelection() ?? selection ?? [runsLength(model), runsLength(model)];
    const start = Math.min(...current);
    const end = Math.max(...current);
    remember();
    const chars = toChars(model);
    const style = inheritStyle ? (chars[start - 1]?.s ?? PLAIN) : null;
    const inserted = toChars(style ? runs.map((run) => ({ ...style, text: run.text })) : runs);
    chars.splice(start, end - start, ...inserted);
    model = toSegments(chars);
    render([start + inserted.length, start + inserted.length]);
  };

  const sync = () => {
    if (composing) return;
    const caret = liveSelection();
    const next = readRuns(editor);
    remember(true);
    model = next;
    render(caret);
  };

  const step = (from: typeof undo, to: typeof undo) => {
    const entry = from.pop();
    if (!entry) return;
    to.push({ model, selection });
    model = entry.model;
    lastTyping = 0;
    render(entry.selection);
  };

  // Styles toggle on when any selected character lacks them, off otherwise.
  for (const button of styleButtons) {
    const flag = button.dataset.ansiStyle as StyleFlag;
    button.addEventListener("click", () =>
      restyle((style, all) => ({ ...style, [flag]: !all.every((char) => char.s[flag]) })),
    );
  }
  const colorFrom = (value: string): AnsiColor | null =>
    value === "none" ? null : { kind: "named", index: Number(value) };
  for (const button of fgButtons) {
    button.addEventListener("click", () =>
      restyle((style) => ({ ...style, fg: colorFrom(button.dataset.ansiFg ?? "none") })),
    );
  }
  for (const button of bgButtons) {
    button.addEventListener("click", () =>
      restyle((style) => ({ ...style, bg: colorFrom(button.dataset.ansiBg ?? "none") })),
    );
  }
  const rgbOf = (hex: string): AnsiColor => ({
    kind: "rgb",
    rgb: [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) || 0) as [
      number,
      number,
      number,
    ],
  });
  fgCustom?.addEventListener("change", () =>
    restyle((style) => ({ ...style, fg: rgbOf(fgCustom.value) })),
  );
  bgCustom?.addEventListener("change", () =>
    restyle((style) => ({ ...style, bg: rgbOf(bgCustom.value) })),
  );
  clear.addEventListener("click", () => restyle(() => PLAIN));

  // Clicking a control must not move the selection out of the editor.
  for (const control of [...styleButtons, ...fgButtons, ...bgButtons, clear]) {
    control.addEventListener("mousedown", (event) => event.preventDefault());
  }

  document.addEventListener("selectionchange", () => {
    const current = liveSelection();
    if (current) {
      selection = current;
      updatePressed();
    }
  });

  editor.addEventListener("compositionstart", () => {
    composing = true;
  });
  editor.addEventListener("compositionend", () => {
    composing = false;
    sync();
  });
  editor.addEventListener("input", sync);
  editor.addEventListener("beforeinput", (event) => {
    const type = event.inputType;
    if (type === "historyUndo" || type === "historyRedo") {
      event.preventDefault();
      if (type === "historyUndo") step(undo, redo);
      else step(redo, undo);
    } else if (type.startsWith("format")) {
      // The browser's own bold/italic would write <b>/<i>, which mean nothing here.
      event.preventDefault();
    }
  });
  editor.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (event.key === "Enter") {
      event.preventDefault();
      insert([{ ...PLAIN, text: "\n" }], true);
    } else if (mod && key === "z") {
      event.preventDefault();
      if (event.shiftKey) step(redo, undo);
      else step(undo, redo);
    } else if (mod && key === "y") {
      event.preventDefault();
      step(redo, undo);
    } else if (mod && (key === "b" || key === "u" || key === "i")) {
      event.preventDefault();
      const flag: StyleFlag = key === "b" ? "bold" : key === "u" ? "underline" : "italic";
      restyle((style, all) => ({ ...style, [flag]: !all.every((char) => char.s[flag]) }));
    }
  });
  editor.addEventListener("paste", (event) => {
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text) insert(segmentsFromPaste(text), false);
  });
  editor.addEventListener("drop", (event) => event.preventDefault());

  themeSelect.addEventListener("change", () => {
    const next = ANSI_THEMES.find((t) => t.id === themeSelect.value);
    if (!next) return;
    theme = next.id;
    surface.dataset.theme = theme;
    paintSwatches();
    render();
  });

  copy.addEventListener("click", () => {
    void copyToClipboard(discordAnsiBlock(encodeAnsi(model)), copy).then((ok) => {
      if (!ok)
        say(
          "This page can't write to your clipboard here — use Copy for a bot or webhook and type the code block around it.",
        );
    });
  });
  copyCode.addEventListener("click", () => {
    void copyToClipboard(ansiStringLiteral(encodeAnsi(model)), copyCode);
  });
  reset.addEventListener("click", () => {
    remember();
    model = COLORED_TEXT_SAMPLE.map((run) => ({ ...run }));
    selection = null;
    render();
  });
  empty.addEventListener("click", () => {
    remember();
    model = [];
    selection = null;
    render();
    editor.focus();
  });

  editor.contentEditable = "true";
  for (const control of [
    ...styleButtons,
    ...fgButtons,
    ...bgButtons,
    themeSelect,
    copy,
    copyCode,
    reset,
    empty,
    clear,
  ]) {
    control.disabled = false;
  }
  if (fgCustom) fgCustom.disabled = false;
  if (bgCustom) bgCustom.disabled = false;
  paintSwatches();
  render();
}

for (const root of document.querySelectorAll<HTMLElement>("[data-ansi-tool]")) init(root);
