/**
 * Shared fields surfaced by every select inspector: custom_id, placeholder,
 * min/max values, disabled. Each select inspector wraps this with its own
 * type-specific fields below (options, default_values, channel_types).
 */

import { useMessageStore } from "@/core/state/messageStore";
import { LIMITS } from "@/core/schema/limits";
import type { SelectComponent } from "@/core/schema/types";
import { Field } from "@/ui/Field";
import { Switch } from "@/ui/Switch";
import { TextInput } from "@/ui/TextInput";
import styles from "./inspectors.module.css";

interface Props {
  node: SelectComponent;
}

export function SelectBaseFields({ node }: Props) {
  const patch = useMessageStore((s) => s.patchNode);

  const setMin = (v: string) => {
    const parsed = v === "" ? undefined : Number.parseInt(v, 10);
    patch<SelectComponent>(node._id, {
      min_values: parsed === undefined || Number.isNaN(parsed) ? undefined : parsed,
    });
  };
  const setMax = (v: string) => {
    const parsed = v === "" ? undefined : Number.parseInt(v, 10);
    patch<SelectComponent>(node._id, {
      max_values: parsed === undefined || Number.isNaN(parsed) ? undefined : parsed,
    });
  };

  return (
    <>
      {/* The select's capability notice now renders above the Action panel, just
          ahead of these shared fields — see the Inspector. */}
      <Field label="Placeholder">
        {(id) => (
          <TextInput
            id={id}
            value={node.placeholder ?? ""}
            maxLength={LIMITS.SELECT_PLACEHOLDER}
            onChange={(e) =>
              patch<SelectComponent>(node._id, {
                placeholder: e.currentTarget.value || undefined,
              })
            }
            placeholder="Optional"
          />
        )}
      </Field>

      <div className={styles.row2}>
        <Field label="Min selections" hint={`0–${LIMITS.SELECT_MAX_VALUES}. Default 1.`}>
          {(id) => (
            <TextInput
              id={id}
              type="number"
              min={LIMITS.SELECT_MIN_VALUES}
              max={LIMITS.SELECT_MAX_VALUES}
              value={node.min_values ?? ""}
              onChange={(e) => setMin(e.currentTarget.value)}
              placeholder="1"
            />
          )}
        </Field>
        <Field label="Max selections" hint={`1–${LIMITS.SELECT_MAX_VALUES}. Default 1.`}>
          {(id) => (
            <TextInput
              id={id}
              type="number"
              min={1}
              max={LIMITS.SELECT_MAX_VALUES}
              value={node.max_values ?? ""}
              onChange={(e) => setMax(e.currentTarget.value)}
              placeholder="1"
            />
          )}
        </Field>
      </div>

      <Switch
        checked={node.disabled ?? false}
        onChange={(e) =>
          patch<SelectComponent>(node._id, {
            disabled: e.currentTarget.checked || undefined,
          })
        }
        label="Disabled"
      />
      {/* The interaction's custom_id lives in the Action panel the Inspector
          renders above these fields — it's bound to (or freed from) a plugin
          there, so the two halves of that one decision stay together. */}
    </>
  );
}
