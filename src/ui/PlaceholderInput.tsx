import { useLayoutEffect, useRef, type InputHTMLAttributes } from "react";
import { TextInput } from "@/ui/TextInput";
import { Menu } from "@/ui/Menu";
import { BracesIcon } from "@/ui/Icon";
import { insertSnippet } from "@/ui/markdownActions";
import { PlaceholderMenuItems } from "@/ui/PlaceholderMenu";
import type { PlaceholderGroup } from "@/core/plugins/placeholders";
import styles from "./PlaceholderInput.module.css";

// Everything a plain TextInput accepts except the native event-based `onChange`,
// which we replace with a value-based one so callers don't juggle the synthetic
// event alongside programmatic token inserts.
type PassThroughProps = Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value">;

interface PlaceholderInputProps extends PassThroughProps {
  value: string;
  /** Receives the new value, whether typed or inserted from the `{}` menu. */
  onChange: (value: string) => void;
  /**
   * Placeholders offered as a trailing `{}` insert menu, grouped by provider.
   * Empty/omitted renders a bare TextInput, so this is a safe drop-in anywhere a
   * single-line TextInput is used.
   */
  placeholders?: PlaceholderGroup[];
  invalid?: boolean;
}

/**
 * A single-line {@link TextInput} fronted by the same `{}` placeholder dropdown
 * the markdown toolbar offers, for fields that aren't full markdown areas —
 * button labels and URLs, select placeholders, option fields, media alt-text and
 * URLs, the webhook username/avatar. It stays controlled (parent owns
 * `value`/`onChange`) and tracks the caret so an inserted `{token}` lands where
 * the user last was, restoring the selection after the controlled re-render.
 */
export function PlaceholderInput({
  value,
  onChange,
  placeholders,
  invalid,
  ...rest
}: PlaceholderInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  // Last known caret/selection, captured as the user moves through the field so
  // a menu click (which happens while focus is elsewhere) still inserts in place.
  const selRef = useRef<[number, number]>([value.length, value.length]);
  // Selection to restore after the next controlled re-render — only set by an
  // insert, so ordinary typing never reaches the restore branch.
  const pendingSelection = useRef<[number, number] | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !pendingSelection.current) return;
    const [start, end] = pendingSelection.current;
    pendingSelection.current = null;
    el.focus();
    el.setSelectionRange(start, end);
    selRef.current = [start, end];
  }, [value]);

  const syncSelection = () => {
    const el = ref.current;
    if (el) selRef.current = [el.selectionStart ?? value.length, el.selectionEnd ?? value.length];
  };

  const insert = (snippet: string) => {
    const [start, end] = selRef.current;
    const result = insertSnippet({ text: value, selStart: start, selEnd: end }, snippet);
    pendingSelection.current = [result.selStart, result.selEnd];
    onChange(result.text);
  };

  const hasPlaceholders = !!placeholders && placeholders.length > 0;

  const input = (
    <TextInput
      ref={ref}
      value={value}
      invalid={invalid}
      className={hasPlaceholders ? styles.input : undefined}
      onChange={(e) => onChange(e.currentTarget.value)}
      onSelect={syncSelection}
      onKeyUp={syncSelection}
      onClick={syncSelection}
      onFocus={syncSelection}
      {...rest}
    />
  );

  if (!hasPlaceholders) return input;

  return (
    <div className={styles.wrap}>
      {input}
      <Menu
        align="end"
        trigger={
          <button
            type="button"
            className={styles.btn}
            aria-label="Insert placeholder"
            title="Insert placeholder"
            // Keep the field's caret/selection put while the menu opens, so the
            // token inserts where the user was rather than at the end.
            onMouseDown={(e) => e.preventDefault()}
          >
            <BracesIcon size={15} />
          </button>
        }
      >
        {(close) => (
          <PlaceholderMenuItems placeholders={placeholders} onInsert={insert} close={close} />
        )}
      </Menu>
    </div>
  );
}
