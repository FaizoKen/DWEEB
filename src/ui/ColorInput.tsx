import {
  useEffect,
  useId,
  useState,
  type ChangeEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
} from "react";
import { cn } from "@/lib/cn";
import styles from "./ColorInput.module.css";

interface ColorInputProps {
  /** RGB integer 0xRRGGBB or null/undefined when no color is set. */
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  /** When true, exposes a button to clear the color (sets it to null). */
  clearable?: boolean;
  id?: string;
  className?: string;
  "aria-describedby"?: InputHTMLAttributes<HTMLInputElement>["aria-describedby"];
  "aria-errormessage"?: InputHTMLAttributes<HTMLInputElement>["aria-errormessage"];
  "aria-invalid"?: InputHTMLAttributes<HTMLInputElement>["aria-invalid"];
}

const toHex = (value: number | null | undefined): string => {
  if (value == null) return "#000000";
  return `#${(value & 0xffffff).toString(16).padStart(6, "0")}`;
};

const fromHex = (value: string): number => parseInt(value.slice(1), 16);

/** Parse a user-typed hex string (3 or 6 digits, optional leading #) into 0xRRGGBB, or null if invalid. */
const parseHexInput = (raw: string): number | null => {
  const cleaned = raw.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) return parseInt(cleaned, 16);
  if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
    const [r, g, b] = cleaned;
    return parseInt(`${r}${r}${g}${g}${b}${b}`, 16);
  }
  return null;
};

export function ColorInput({
  value,
  onChange,
  clearable,
  id,
  className,
  "aria-describedby": ariaDescribedBy,
  "aria-errormessage": ariaErrorMessage,
  "aria-invalid": ariaInvalid,
}: ColorInputProps) {
  const generated = useId();
  const controlId = id ?? generated;
  const hex = toHex(value);
  const isSet = value != null;
  const display = isSet ? hex.toUpperCase() : "";

  // Local draft lets the user type freely (including partial/invalid text)
  // without fighting the canonical value derived from the prop.
  const [draft, setDraft] = useState(display);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(display);
  }, [display, editing]);

  const handlePickerChange = (e: ChangeEvent<HTMLInputElement>) => {
    onChange(fromHex(e.currentTarget.value));
  };

  const handleTextChange = (e: ChangeEvent<HTMLInputElement>) => {
    const next = e.currentTarget.value;
    setDraft(next);
    // Commit live while the typed value is a complete, valid hex.
    const parsed = parseHexInput(next);
    if (parsed != null) onChange(parsed);
  };

  const commitDraft = () => {
    setEditing(false);
    if (draft.trim() === "") {
      if (clearable) onChange(null);
      return;
    }
    // Invalid input reverts to the canonical value via the effect.
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
    if (e.key === "Escape") {
      setDraft(display);
      e.currentTarget.blur();
    }
  };

  return (
    <div className={cn(styles.wrapper, className)}>
      <label htmlFor={controlId} className={styles.swatch} style={{ background: hex }}>
        <span className="sr-only">Pick color</span>
        <input
          id={controlId}
          type="color"
          value={hex}
          onChange={handlePickerChange}
          className={styles.colorInput}
          aria-label="Pick color"
          aria-describedby={ariaDescribedBy}
          aria-errormessage={ariaErrorMessage}
          aria-invalid={ariaInvalid}
        />
      </label>
      <input
        type="text"
        className={styles.value}
        value={draft}
        placeholder="Not set"
        spellCheck={false}
        autoComplete="off"
        maxLength={7}
        aria-label="Hex color value"
        onChange={handleTextChange}
        onFocus={() => setEditing(true)}
        onBlur={commitDraft}
        onKeyDown={handleKeyDown}
      />
      {clearable && isSet ? (
        <button type="button" className={styles.clear} onClick={() => onChange(null)}>
          Clear
        </button>
      ) : null}
    </div>
  );
}
