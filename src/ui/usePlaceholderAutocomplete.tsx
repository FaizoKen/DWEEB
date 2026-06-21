import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import type { PlaceholderGroup } from "@/core/plugins/placeholders";
import styles from "./PlaceholderAutocomplete.module.css";

/**
 * Inline placeholder autocomplete, shared by single-line {@link PlaceholderInput}
 * and the markdown {@link MarkdownTextArea}. Typing `{` opens a dropdown of the
 * available tokens; the partial text after `{` filters it, arrow keys move,
 * Enter/Tab inserts `{token}` (replacing what you typed), Escape dismisses. No
 * always-visible button — the `{` is the only affordance, which keeps narrow
 * inspector fields uncluttered.
 *
 * It's caret-driven and field-agnostic (works on `<input>` and `<textarea>`):
 * the consumer wires the returned handlers into its own change/keydown/selection
 * logic and renders `dropdown` once. The hook owns its own post-insert caret
 * restore so it never fights the consumer's other selection bookkeeping.
 */

/** A `{` followed by an optional partial token, anchored at the caret. */
const TRIGGER_RE = /\{([a-z0-9_]*)$/i;

type Field = HTMLInputElement | HTMLTextAreaElement;

interface FlatItem {
  token: string;
  label: string;
  /** Provider heading, repeated only on the first item of each run. */
  source: string;
}

export interface PlaceholderAutocomplete {
  /** Render once near the field; portalled, so placement in the tree is free. */
  dropdown: ReactNode;
  /** Call after the value changes (typing) to re-evaluate the trigger. */
  onValueChange: (text: string, caret: number) => void;
  /** Call when the caret moves without a value change (clicks, arrow keys). */
  onSelectionChange: () => void;
  /** Run first in the field's keydown; returns true when it consumed the event. */
  onKeyDown: (e: ReactKeyboardEvent<Field>) => boolean;
  /** Dismiss the dropdown (e.g. on blur). */
  close: () => void;
  /** Whether the dropdown is currently showing. */
  open: boolean;
}

export function usePlaceholderAutocomplete(
  ref: RefObject<Field>,
  value: string,
  onChange: (value: string) => void,
  placeholders: PlaceholderGroup[] | undefined,
): PlaceholderAutocomplete {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Index of the triggering `{` in the text, where an inserted token replaces to.
  const [start, setStart] = useState(0);
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  // Last trigger context, so repeated detects at the same spot don't reset the
  // keyboard highlight (arrow-key navigation must survive a selection re-check).
  const ctxRef = useRef<{ start: number; query: string } | null>(null);
  // Caret to restore after an insert's controlled re-render.
  const pendingCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || pendingCaret.current == null) return;
    const caret = pendingCaret.current;
    pendingCaret.current = null;
    el.focus();
    el.setSelectionRange(caret, caret);
  }, [value, ref]);

  const items = useMemo<FlatItem[]>(() => {
    if (!open || !placeholders) return [];
    const q = query.toLowerCase();
    const out: FlatItem[] = [];
    for (const group of placeholders) {
      for (const p of group.items) {
        if (!q || p.token.toLowerCase().includes(q) || p.label.toLowerCase().includes(q)) {
          out.push({ token: p.token, label: p.label, source: group.source });
        }
      }
    }
    return out;
  }, [open, placeholders, query]);

  // Nothing matched the partial — fold the dropdown away rather than show empty.
  const visible = open && items.length > 0 && rect != null;

  const measure = useCallback(() => {
    const el = ref.current;
    if (el) setRect(el.getBoundingClientRect());
  }, [ref]);

  const close = useCallback(() => {
    setOpen(false);
    ctxRef.current = null;
  }, []);

  const detect = useCallback(
    (text: string, caret: number) => {
      if (!placeholders || placeholders.length === 0) {
        close();
        return;
      }
      const m = TRIGGER_RE.exec(text.slice(0, caret));
      if (!m) {
        close();
        return;
      }
      const q = m[1] ?? "";
      const s = caret - m[0].length;
      const prev = ctxRef.current;
      // Reset the highlight only when the trigger moves or its query changes —
      // not on an idempotent re-check at the same caret.
      if (!prev || prev.start !== s || prev.query !== q) setActive(0);
      ctxRef.current = { start: s, query: q };
      setQuery(q);
      setStart(s);
      setOpen(true);
      measure();
    },
    [placeholders, close, measure],
  );

  const insert = useCallback(
    (token: string) => {
      const el = ref.current;
      const caret = el?.selectionStart ?? value.length;
      const snippet = `{${token}}`;
      const next = value.slice(0, start) + snippet + value.slice(caret);
      pendingCaret.current = start + snippet.length;
      onChange(next);
      close();
    },
    [ref, value, start, onChange, close],
  );

  // Keep the dropdown pinned to the field as the page scrolls/resizes.
  useEffect(() => {
    if (!open) return;
    const onReflow = () => measure();
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open, measure]);

  const onValueChange = useCallback((text: string, caret: number) => detect(text, caret), [detect]);

  const onSelectionChange = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    detect(el.value, el.selectionStart ?? el.value.length);
  }, [ref, detect]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<Field>): boolean => {
      if (!visible) return false;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActive((a) => (a + 1) % items.length);
          return true;
        case "ArrowUp":
          e.preventDefault();
          setActive((a) => (a - 1 + items.length) % items.length);
          return true;
        case "Enter":
        case "Tab": {
          const choice = items[active];
          if (!choice) return false;
          e.preventDefault();
          insert(choice.token);
          return true;
        }
        case "Escape":
          e.preventDefault();
          close();
          return true;
        default:
          return false;
      }
    },
    [visible, items, active, insert, close],
  );

  const dropdown = visible ? (
    <Dropdown rect={rect} items={items} active={active} onPick={insert} />
  ) : null;

  return { dropdown, onValueChange, onSelectionChange, onKeyDown, close, open: visible };
}

const GAP = 4;
const MAX_HEIGHT = 260;
const VIEWPORT_MARGIN = 8;

function Dropdown({
  rect,
  items,
  active,
  onPick,
}: {
  rect: DOMRect;
  items: FlatItem[];
  active: number;
  onPick: (token: string) => void;
}) {
  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceAbove = rect.top;
  const openUp = spaceBelow < Math.min(MAX_HEIGHT, 200) && spaceAbove > spaceBelow;

  const width = Math.max(rect.width, 220);
  let left = rect.left;
  if (left + width > window.innerWidth - VIEWPORT_MARGIN) {
    left = window.innerWidth - width - VIEWPORT_MARGIN;
  }
  if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;

  const style = openUp
    ? {
        left,
        width,
        bottom: window.innerHeight - rect.top + GAP,
        maxHeight: Math.min(MAX_HEIGHT, spaceAbove - VIEWPORT_MARGIN),
      }
    : {
        left,
        width,
        top: rect.bottom + GAP,
        maxHeight: Math.min(MAX_HEIGHT, spaceBelow - VIEWPORT_MARGIN),
      };

  return createPortal(
    <div className={styles.panel} role="listbox" style={style}>
      {items.map((it, i) => {
        const newGroup = i === 0 || items[i - 1]!.source !== it.source;
        return (
          <div key={`${it.source}:${it.token}`}>
            {newGroup ? <div className={styles.heading}>{it.source}</div> : null}
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              className={cn(styles.item, i === active && styles.itemActive)}
              // mousedown (not click) so the insert beats the field's blur, which
              // would otherwise close the dropdown before the click landed.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(it.token);
              }}
            >
              <span className={styles.itemLabel}>{it.label}</span>
              <span className={styles.itemToken}>{`{${it.token}}`}</span>
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
