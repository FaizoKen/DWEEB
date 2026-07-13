import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import styles from "./TextInput.module.css";

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  /**
   * Masks the value like a password field (CSS dot masking) and opts the field
   * out of browser/extension autofill and password managers — without using
   * `type="password"`, which makes browsers offer to *save* the value even with
   * `autoComplete="off"`. Use for secrets shown behind a Show/Hide toggle
   * (webhook URLs, API keys). Toggle it off to reveal the value.
   */
  masked?: boolean;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { invalid, className, masked, type = "text", "aria-invalid": ariaInvalid, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      // A masked field is a secret: never a real password input (browsers offer
      // to save those) — we mask via CSS instead.
      type={masked ? "text" : type}
      className={cn(styles.input, invalid && styles.invalid, masked && styles.masked, className)}
      aria-invalid={ariaInvalid ?? (invalid ? true : undefined)}
      // Keep browser and extension autofill / password managers out of secrets.
      {...(masked
        ? {
            autoComplete: "off",
            autoCorrect: "off",
            autoCapitalize: "off",
            "data-1p-ignore": true,
            "data-lpignore": "true",
          }
        : null)}
      {...rest}
    />
  );
});
