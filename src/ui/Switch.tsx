import { forwardRef, useId, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import styles from "./Switch.module.css";

interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
}

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { label, className, id, ...rest },
  ref,
) {
  // The visible label is associated by wrapping, but the checkbox still wants its
  // own id/name so accessibility tooling and browser heuristics can address it.
  // Generate a stable id when the caller doesn't supply one.
  const generatedId = useId();
  return (
    <label className={cn(styles.wrapper, className)}>
      <input ref={ref} id={id ?? generatedId} type="checkbox" className={styles.input} {...rest} />
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
      {label ? <span className={styles.label}>{label}</span> : null}
    </label>
  );
});
