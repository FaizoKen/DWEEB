/**
 * A text field holding a list of snowflakes (allowed role/user IDs, applied
 * forum tags), committed to the store as a parsed array on every keystroke.
 *
 * It can't simply render `ids.join(" ")` as its value: typing the separator
 * after an id parses to the same list, the store writes a fresh message
 * anyway, and on that re-render Preact resets the DOM value to the prop —
 * erasing the space or comma just typed, so the next digits fused into one
 * invalid id and only pasting a whole list worked. So while the user types,
 * the field shows their own text (separators and all) for as long as it still
 * parses to what the store holds; the store's list takes over again the
 * moment the two disagree (an undo, an import, a peer's edit) or on blur.
 */

import { useState, type InputHTMLAttributes } from "react";
import { TextInput } from "@/ui/TextInput";

/** Split comma/space separated text into ids; `undefined` when there are none. */
export function parseSnowflakeList(raw: string): string[] | undefined {
  const ids = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return ids.length > 0 ? ids : undefined;
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((id, i) => id === right[i]);
}

type SnowflakeListInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "defaultValue"
> & {
  ids: readonly string[] | undefined;
  onChange(next: string[] | undefined): void;
  invalid?: boolean;
};

export function SnowflakeListInput({ ids, onChange, onBlur, ...rest }: SnowflakeListInputProps) {
  // `null` = not mid-edit; the field shows the store's list.
  const [draft, setDraft] = useState<string | null>(null);
  const showDraft = draft !== null && sameList(parseSnowflakeList(draft), ids);
  return (
    <TextInput
      {...rest}
      value={showDraft ? draft : (ids ?? []).join(" ")}
      onChange={(e) => {
        const raw = e.currentTarget.value;
        setDraft(raw);
        onChange(parseSnowflakeList(raw));
      }}
      onBlur={(e) => {
        setDraft(null);
        onBlur?.(e);
      }}
    />
  );
}
