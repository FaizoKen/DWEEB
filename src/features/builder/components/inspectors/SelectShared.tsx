/**
 * Shared fields surfaced by every select inspector: custom_id, placeholder,
 * min/max values, disabled. Each select inspector wraps this with its own
 * type-specific fields below (options, default_values, channel_types).
 */

import { useMessageStore } from "@/core/state/messageStore";
import { LIMITS } from "@/core/schema/limits";
import type { SelectComponent } from "@/core/schema/types";
import { useAttachedPlugin } from "@/features/plugins/useAttachedPlugin";
import { Field } from "@/ui/Field";
import { Switch } from "@/ui/Switch";
import { TextInput } from "@/ui/TextInput";
import { CapabilityNote } from "./CapabilityNote";
import { CustomIdField } from "./CustomIdField";
import styles from "./inspectors.module.css";

interface Props {
  node: SelectComponent;
}

export function SelectBaseFields({ node }: Props) {
  const patch = useMessageStore((s) => s.patchNode);
  const attachedPlugin = useAttachedPlugin(node);

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
      {attachedPlugin ? (
        <CapabilityNote tone="info">
          <strong>Handled by {attachedPlugin.name}.</strong> Selections are processed by the
          plugin's service — send this message through an application-owned webhook so they reach
          it.
        </CapabilityNote>
      ) : (
        <CapabilityNote>
          <strong>Needs an application-owned webhook.</strong> Discord rejects messages containing
          select menus when sent through a regular user-created webhook — only application/bot-owned
          webhooks can post them.
        </CapabilityNote>
      )}
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

      {/* custom_id sits last so it's adjacent to the Plugin panel that follows
          in the Inspector — the plugin binding *is* this value, so keep the two
          visually grouped. Locked read-only while a plugin owns the select. */}
      <CustomIdField
        node={node}
        maxLength={LIMITS.SELECT_CUSTOM_ID}
        hint="Sent to your bot when a user changes the selection — set it to wire up the action."
        attachedPlugin={attachedPlugin}
      />
    </>
  );
}
