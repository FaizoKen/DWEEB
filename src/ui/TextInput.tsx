import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import styles from "./TextInput.module.css";

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { invalid, className, type = "text", ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(styles.input, invalid && styles.invalid, className)}
      {...rest}
    />
  );
});
