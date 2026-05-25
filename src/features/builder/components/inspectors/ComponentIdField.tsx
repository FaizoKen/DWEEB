/**
 * Optional `id` integer attached to every component in the V2 schema.
 *
 * This is Discord's per-component identifier — not the editor's `_id`. It
 * defaults to "auto" (Discord assigns sequential integers at send time).
 * Most users leave this blank; we surface it so power users importing or
 * crafting a payload by hand can pin specific ids that downstream code
 * relies on for stable references across edits.
 */

import { useMessageStore } from "@/core/state/messageStore";
import type { AnyComponent } from "@/core/schema/types";
import { Field } from "@/ui/Field";
import { TextInput } from "@/ui/TextInput";

interface Props {
  node: AnyComponent;
}

export function ComponentIdField({ node }: Props) {
  const patch = useMessageStore((s) => s.patchNode);

  const value = node.id !== undefined ? String(node.id) : "";

  return (
    <Field
      label="Component id"
      hint="Optional 32-bit integer. Leave blank to let Discord auto-assign."
    >
      {(controlId) => (
        <TextInput
          id={controlId}
          value={value}
          inputMode="numeric"
          onChange={(e) => {
            const raw = e.currentTarget.value.replace(/[^\d]/g, "");
            if (raw === "") {
              patch<AnyComponent>(node._id, { id: undefined });
              return;
            }
            const n = Number.parseInt(raw, 10);
            patch<AnyComponent>(node._id, {
              id: Number.isFinite(n) ? n : undefined,
            });
          }}
          placeholder="Auto"
        />
      )}
    </Field>
  );
}
