import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { TextArea } from "@/ui/TextArea";
import { MarkdownToolbar } from "@/ui/MarkdownToolbar";
import { wrapInline, type EditResult, type EditState } from "@/ui/markdownActions";
import { usePlaceholderAutocomplete } from "@/ui/usePlaceholderAutocomplete";
import type { PlaceholderGroup } from "@/core/plugins/placeholders";
import styles from "./MarkdownTextArea.module.css";

interface MarkdownTextAreaProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  rows?: number;
  placeholder?: string;
  invalid?: boolean;
  /** Placeholders (grouped by provider) offered inline when the user types `{`. */
  placeholders?: PlaceholderGroup[];
}

/**
 * A textarea fronted by a Discord-markdown formatting toolbar. It stays a
 * controlled component — the parent owns `value`/`onChange` exactly like a
 * plain `TextArea` — and internally manages the caret so toolbar edits and
 * keyboard shortcuts land where the user is typing.
 */
export function MarkdownTextArea({
  id,
  value,
  onChange,
  maxLength,
  rows = 8,
  placeholder,
  invalid,
  placeholders,
}: MarkdownTextAreaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Where to put the caret after the next controlled re-render. Only set by an
  // explicit toolbar/shortcut edit, so ordinary typing never reaches the
  // restore branch below.
  const pendingSelection = useRef<[number, number] | null>(null);
  const [selection, setSelection] = useState({ start: 0, end: 0 });

  // Inline `{`-triggered placeholder autocomplete — the same set the single-line
  // fields offer, no toolbar button needed.
  const ac = usePlaceholderAutocomplete(ref, value, onChange, placeholders);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !pendingSelection.current) return;
    const [start, end] = pendingSelection.current;
    pendingSelection.current = null;
    el.focus();
    el.setSelectionRange(start, end);
    setSelection({ start, end });
  }, [value]);

  const syncSelection = () => {
    const el = ref.current;
    if (el) setSelection({ start: el.selectionStart, end: el.selectionEnd });
  };

  const apply = (transform: (state: EditState) => EditResult) => {
    const el = ref.current;
    if (!el) return;
    const result = transform({
      text: value,
      selStart: el.selectionStart,
      selEnd: el.selectionEnd,
    });
    pendingSelection.current = [result.selStart, result.selEnd];
    onChange(result.text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // The open autocomplete claims arrows / Enter / Tab / Escape first.
    if (ac.onKeyDown(e)) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    const marker = key === "b" ? "**" : key === "i" ? "*" : key === "u" ? "__" : null;
    if (!marker) return;
    e.preventDefault();
    const placeholder =
      marker === "**" ? "bold text" : marker === "*" ? "italic text" : "underlined text";
    apply((s) => wrapInline(s, marker, placeholder));
  };

  return (
    <div className={styles.wrap}>
      <MarkdownToolbar
        state={{ text: value, selStart: selection.start, selEnd: selection.end }}
        onAction={apply}
      />
      <TextArea
        ref={ref}
        id={id}
        value={value}
        maxLength={maxLength}
        rows={rows}
        placeholder={placeholder}
        invalid={invalid}
        onChange={(e) => {
          onChange(e.currentTarget.value);
          ac.onValueChange(
            e.currentTarget.value,
            e.currentTarget.selectionStart ?? e.currentTarget.value.length,
          );
        }}
        onKeyDown={onKeyDown}
        onSelect={() => {
          syncSelection();
          ac.onSelectionChange();
        }}
        onKeyUp={syncSelection}
        onClick={() => {
          syncSelection();
          ac.onSelectionChange();
        }}
        onFocus={syncSelection}
        onBlur={ac.close}
      />
      {ac.dropdown}
    </div>
  );
}
