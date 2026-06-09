/**
 * The interaction `custom_id` editor shared by the button and select inspectors.
 *
 * When a plugin owns the component the id *is* the plugin binding (see
 * {@link PluginPanel}) — editing it by hand would silently re-point or break the
 * attachment. So while a plugin is attached we lock the field read-only and
 * route the user to the panel's Detach action instead. It unlocks the moment
 * they detach, restoring the normal editable input.
 */

import type { ReactNode } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import type { AnyComponent } from "@/core/schema/types";
import type { PluginManifest } from "@/core/plugins/manifest";
import { Field } from "@/ui/Field";
import { TextInput } from "@/ui/TextInput";
import { LockIcon } from "@/ui/Icon";
import styles from "./CustomIdField.module.css";

interface Props {
  /** Any interactive node carrying a `custom_id` (button or select). */
  node: AnyComponent & { custom_id: string };
  maxLength: number;
  /** Hint shown while the field is editable (wording differs button vs select). */
  hint: ReactNode;
  /** Owning plugin, if the component is currently bound to one. */
  attachedPlugin: PluginManifest | null;
}

export function CustomIdField({ node, maxLength, hint, attachedPlugin }: Props) {
  const patch = useMessageStore((s) => s.patchNode);

  if (attachedPlugin) {
    return (
      <Field
        label="custom_id"
        hint={
          <>
            Set by <strong>{attachedPlugin.name}</strong> — detach the plugin below to edit it
            directly.
          </>
        }
      >
        {(id) => (
          <div className={styles.locked} title={`Managed by ${attachedPlugin.name}`}>
            <LockIcon size={14} className={styles.lockedIcon} aria-hidden />
            {/* Read-only (not disabled) so the value stays selectable to copy,
                but typing is a no-op until the plugin is detached. */}
            <input
              id={id}
              className={styles.lockedValue}
              value={node.custom_id}
              readOnly
              aria-readonly="true"
              spellCheck={false}
              onFocus={(e) => e.currentTarget.select()}
            />
          </div>
        )}
      </Field>
    );
  }

  return (
    <Field label="custom_id" hint={hint}>
      {(id) => (
        <TextInput
          id={id}
          maxLength={maxLength}
          value={node.custom_id}
          onChange={(e) => patch(node._id, { custom_id: e.currentTarget.value })}
        />
      )}
    </Field>
  );
}
