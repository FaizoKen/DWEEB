import { useId, type ChangeEvent } from "react";
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
}

const toHex = (value: number | null | undefined): string => {
  if (value == null) return "#000000";
  return `#${(value & 0xffffff).toString(16).padStart(6, "0")}`;
};

const fromHex = (value: string): number => parseInt(value.slice(1), 16);

export function ColorInput({ value, onChange, clearable, id, className }: ColorInputProps) {
  const generated = useId();
  const controlId = id ?? generated;
  const hex = toHex(value);
  const isSet = value != null;

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onChange(fromHex(e.currentTarget.value));
  };

  return (
    <div className={cn(styles.wrapper, className)}>
      <label htmlFor={controlId} className={styles.swatch} style={{ background: hex }}>
        <span className="sr-only">Pick color</span>
        <input
          id={controlId}
          type="color"
          value={hex}
          onChange={handleChange}
          className={styles.colorInput}
          aria-label="Pick color"
        />
      </label>
      <span className={styles.value}>{isSet ? hex.toUpperCase() : "Not set"}</span>
      {clearable && isSet ? (
        <button type="button" className={styles.clear} onClick={() => onChange(null)}>
          Clear
        </button>
      ) : null}
    </div>
  );
}
