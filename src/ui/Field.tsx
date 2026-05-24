import { useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import styles from "./Field.module.css";

/**
 * Generic labeled wrapper used by every inspector control. Renders a label
 * row, optional hint, and an optional error/warning under the control.
 *
 * It accepts a render-prop child so the underlying control owns its own
 * accessibility wiring (an id is passed in and should be applied to the
 * control's `id` attribute).
 */
interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  htmlFor?: string;
  /** When true, the label is visually hidden but still announced to AT. */
  hideLabel?: boolean;
  className?: string;
  children: (controlId: string) => ReactNode;
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  hideLabel,
  className,
  children,
}: FieldProps) {
  const reactId = useId();
  const controlId = htmlFor ?? reactId;
  return (
    <div className={cn(styles.field, className)}>
      <label
        htmlFor={controlId}
        className={cn(styles.label, hideLabel && styles.labelHidden)}
      >
        {label}
      </label>
      <div className={styles.control}>{children(controlId)}</div>
      {hint ? <div className={styles.hint}>{hint}</div> : null}
      {error ? <div className={styles.error}>{error}</div> : null}
    </div>
  );
}
