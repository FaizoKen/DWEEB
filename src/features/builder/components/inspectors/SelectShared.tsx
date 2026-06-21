/**
 * Shared fields surfaced by every select inspector: custom_id, placeholder,
 * min/max values, disabled. Each select inspector wraps this with its own
 * type-specific fields below (options, default_values, channel_types).
 *
 * When a plugin owns the select it may also own some of these fields (declared
 * in its manifest's `managesFields`): a menu that grants exactly one role pins
 * `min_values`/`max_values` to 1, say. Owned fields render read-only and locked
 * — exactly as the plugin-owned `custom_id` and wired options lock — so the user
 * can't widen them and silently break the binding. Reconfigure/detach the plugin
 * in the Action panel above to change them.
 */

import { useMessageStore } from "@/core/state/messageStore";
import { LIMITS } from "@/core/schema/limits";
import type { ManagedField } from "@/core/plugins/managedFields";
import type { SelectComponent } from "@/core/schema/types";
import { useAttachedPlugin } from "@/features/plugins/useAttachedPlugin";
import { useMessagePlaceholders } from "@/features/builder/useMessagePlaceholders";
import { Field } from "@/ui/Field";
import { Switch } from "@/ui/Switch";
import { TextInput } from "@/ui/TextInput";
import { PlaceholderInput } from "@/ui/PlaceholderInput";
import { LockIcon } from "@/ui/Icon";
import styles from "./inspectors.module.css";

interface Props {
  node: SelectComponent;
}

export function SelectBaseFields({ node }: Props) {
  const patch = useMessageStore((s) => s.patchNode);
  const placeholders = useMessagePlaceholders();
  const attachedPlugin = useAttachedPlugin(node);
  const managed = attachedPlugin?.managesFields;
  const owns = (field: ManagedField) => !!managed?.includes(field);
  const pluginName = attachedPlugin?.name ?? "the plugin";

  // Per-field hint shown when a plugin owns a field — mirrors CustomIdField's
  // wording so locked controls read consistently across the inspector.
  const lockedHint = (
    <>
      Set by <strong>{pluginName}</strong> — reconfigure or detach the plugin above to change it.
    </>
  );

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
      <Field label="Placeholder" hint={owns("placeholder") ? lockedHint : undefined}>
        {(id) =>
          owns("placeholder") ? (
            <LockedValue id={id} display={node.placeholder || "—"} pluginName={pluginName} />
          ) : (
            <PlaceholderInput
              id={id}
              value={node.placeholder ?? ""}
              maxLength={LIMITS.SELECT_PLACEHOLDER}
              placeholders={placeholders}
              onChange={(value) =>
                patch<SelectComponent>(node._id, {
                  placeholder: value || undefined,
                })
              }
              placeholder="Optional"
            />
          )
        }
      </Field>

      <div className={styles.row2}>
        <Field
          label="Min selections"
          hint={owns("min_values") ? lockedHint : `0–${LIMITS.SELECT_MAX_VALUES}. Default 1.`}
        >
          {(id) =>
            owns("min_values") ? (
              <LockedValue id={id} display={String(node.min_values ?? 1)} pluginName={pluginName} />
            ) : (
              <TextInput
                id={id}
                type="number"
                min={LIMITS.SELECT_MIN_VALUES}
                max={LIMITS.SELECT_MAX_VALUES}
                value={node.min_values ?? ""}
                onChange={(e) => setMin(e.currentTarget.value)}
                placeholder="1"
              />
            )
          }
        </Field>
        <Field
          label="Max selections"
          hint={owns("max_values") ? lockedHint : `1–${LIMITS.SELECT_MAX_VALUES}. Default 1.`}
        >
          {(id) =>
            owns("max_values") ? (
              <LockedValue id={id} display={String(node.max_values ?? 1)} pluginName={pluginName} />
            ) : (
              <TextInput
                id={id}
                type="number"
                min={1}
                max={LIMITS.SELECT_MAX_VALUES}
                value={node.max_values ?? ""}
                onChange={(e) => setMax(e.currentTarget.value)}
                placeholder="1"
              />
            )
          }
        </Field>
      </div>

      {owns("disabled") ? (
        <>
          <Switch checked={node.disabled ?? false} disabled label="Disabled" />
          <p className={styles.note}>{lockedHint}</p>
        </>
      ) : (
        <Switch
          checked={node.disabled ?? false}
          onChange={(e) =>
            patch<SelectComponent>(node._id, {
              disabled: e.currentTarget.checked || undefined,
            })
          }
          label="Disabled"
        />
      )}
      {/* The interaction's custom_id lives in the Action panel the Inspector
          renders above these fields — it's bound to (or freed from) a plugin
          there, so the two halves of that one decision stay together. */}
    </>
  );
}

/**
 * Read-only chip for a select field a plugin owns. Mirrors the locked custom_id
 * field: a lock icon + the value the plugin set, read-only (not disabled) so the
 * value stays selectable to copy but can't be typed over until the plugin is
 * detached.
 */
function LockedValue({
  id,
  display,
  pluginName,
}: {
  id: string;
  display: string;
  pluginName: string;
}) {
  return (
    <div className={styles.lockedField} title={`Managed by ${pluginName}`}>
      <LockIcon size={14} className={styles.lockedFieldIcon} aria-hidden />
      <input
        id={id}
        className={styles.lockedFieldValue}
        value={display}
        readOnly
        aria-readonly="true"
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
      />
    </div>
  );
}
