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
import { CapabilityNote } from "./CapabilityNote";
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
      <CapabilityNote>
        <strong>Needs an application-owned webhook.</strong> Select menus
        render fine on any webhook but only fire interactions when an
        application/bot owns the webhook. On regular webhooks the selection
        goes nowhere.
      </CapabilityNote>
      <Field
        label="custom_id"
        hint="Sent to your bot when a user changes the selection."
      >
        {(id) => (
          <TextInput
            id={id}
            value={node.custom_id}
            maxLength={LIMITS.SELECT_CUSTOM_ID}
            onChange={(e) =>
              patch<SelectComponent>(node._id, { custom_id: e.currentTarget.value })
            }
          />
        )}
      </Field>

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
        <Field
          label="Min selections"
          hint={`0–${LIMITS.SELECT_MAX_VALUES}. Default 1.`}
        >
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
        <Field
          label="Max selections"
          hint={`1–${LIMITS.SELECT_MAX_VALUES}. Default 1.`}
        >
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
    </>
  );
}
