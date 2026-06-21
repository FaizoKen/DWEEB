import { useRef, type InputHTMLAttributes } from "react";
import { TextInput } from "@/ui/TextInput";
import { usePlaceholderAutocomplete } from "@/ui/usePlaceholderAutocomplete";
import type { PlaceholderGroup } from "@/core/plugins/placeholders";

// Everything a plain TextInput accepts except the native event-based `onChange`,
// which we replace with a value-based one so callers don't juggle the synthetic
// event alongside programmatic token inserts.
type PassThroughProps = Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value">;

interface PlaceholderInputProps extends PassThroughProps {
  value: string;
  /** Receives the new value, whether typed or inserted from the `{` menu. */
  onChange: (value: string) => void;
  /**
   * Placeholders offered when the user types `{`, grouped by provider.
   * Empty/omitted makes this an ordinary TextInput, so it's a safe drop-in
   * anywhere a single-line TextInput is used.
   */
  placeholders?: PlaceholderGroup[];
  invalid?: boolean;
}

/**
 * A single-line {@link TextInput} with inline placeholder autocomplete: typing
 * `{` pops up the available tokens (the same set the markdown editor offers),
 * with no always-visible button cluttering the field. Stays controlled — the
 * parent owns `value`/`onChange`.
 */
export function PlaceholderInput({
  value,
  onChange,
  placeholders,
  invalid,
  onKeyDown,
  onClick,
  onSelect,
  onBlur,
  ...rest
}: PlaceholderInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  const ac = usePlaceholderAutocomplete(ref, value, onChange, placeholders);

  return (
    <>
      <TextInput
        ref={ref}
        value={value}
        invalid={invalid}
        onChange={(e) => {
          onChange(e.currentTarget.value);
          ac.onValueChange(
            e.currentTarget.value,
            e.currentTarget.selectionStart ?? e.currentTarget.value.length,
          );
        }}
        onKeyDown={(e) => {
          if (ac.onKeyDown(e)) return;
          onKeyDown?.(e);
        }}
        onClick={(e) => {
          ac.onSelectionChange();
          onClick?.(e);
        }}
        onSelect={(e) => {
          ac.onSelectionChange();
          onSelect?.(e);
        }}
        onBlur={(e) => {
          ac.close();
          onBlur?.(e);
        }}
        {...rest}
      />
      {ac.dropdown}
    </>
  );
}
