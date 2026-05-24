import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import styles from "./Select.module.css";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid, className, children, ...rest },
  ref,
) {
  return (
    <div className={styles.wrapper}>
      <select
        ref={ref}
        className={cn(styles.select, invalid && styles.invalid, className)}
        {...rest}
      >
        {children}
      </select>
      <span className={styles.chevron} aria-hidden="true">▾</span>
    </div>
  );
});
