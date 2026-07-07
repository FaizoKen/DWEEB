/**
 * StringSelect inspector — edits the base fields plus the option list.
 *
 * Each option is rendered as a card with label / value / description /
 * default-flag controls. We refuse to allow zero options (validator already
 * surfaces that as an error) but otherwise let the user freely add/remove.
 *
 * Exception: when a plugin owns the select (by `custom_id` prefix) it also owns
 * the option list — it wired each option's `value` to a meaning its service
 * relies on (a role id, say) — so we lock the list read-only and route edits
 * through the plugin, exactly as the shared {@link CustomIdField} locks the id.
 */

import { useMessageStore } from "@/core/state/messageStore";
import { LIMITS } from "@/core/schema/limits";
import type { StringSelectComponent, StringSelectOption } from "@/core/schema/types";
import { useAttachedPlugin } from "@/features/plugins/useAttachedPlugin";
import { useMessagePlaceholders } from "@/features/builder/useMessagePlaceholders";
import { Field } from "@/ui/Field";
import { IconButton } from "@/ui/IconButton";
import { Switch } from "@/ui/Switch";
import { PlaceholderInput } from "@/ui/PlaceholderInput";
import { LockIcon, TrashIcon } from "@/ui/Icon";
import { EmojiField } from "./EmojiField";
import { SelectBaseFields } from "./SelectShared";
import styles from "./inspectors.module.css";

interface Props {
  node: StringSelectComponent;
}

export function StringSelectInspector({ node }: Props) {
  const patch = useMessageStore((s) => s.patchNode);
  const placeholders = useMessagePlaceholders();
  const attachedPlugin = useAttachedPlugin(node);

  // A plugin only owns the option list when it declares `managesSelectOptions`
  // (a plugin that leaves options to the user keeps the normal editor). When it
  // does, each option's value is the binding its service relies on (e.g. a role
  // id), so hand-editing would silently break it — mirror the locked custom_id:
  // show the wired options read-only and route changes through the plugin.
  if (attachedPlugin?.managesSelectOptions) {
    return (
      <>
        <SelectBaseFields node={node} />
        <div className={styles.listHeader}>
          <span>Options ({node.options.length})</span>
        </div>
        <p className={styles.note}>
          Wired and locked by <strong>{attachedPlugin.name}</strong>. Reconfigure or detach the
          plugin in the Action panel above to change them.
        </p>
        <div className={styles.cards}>
          {node.options.map((opt, i) => (
            <div
              key={i}
              className={styles.lockedOption}
              title={`Managed by ${attachedPlugin.name}`}
            >
              <LockIcon size={13} className={styles.lockedOptionIcon} aria-hidden />
              <span className={styles.lockedOptionLabel}>{opt.label}</span>
              <code className={styles.lockedOptionValue}>{opt.value}</code>
            </div>
          ))}
        </div>
      </>
    );
  }

  const updateOption = (index: number, opt: StringSelectOption) => {
    const options = node.options.slice();
    options[index] = opt;
    patch<StringSelectComponent>(node._id, { options });
  };

  const addOption = () => {
    const n = node.options.length + 1;
    patch<StringSelectComponent>(node._id, {
      options: [...node.options, { label: `Option ${n}`, value: `option_${n}` }],
    });
  };

  const removeOption = (index: number) => {
    if (node.options.length <= 1) return;
    const options = node.options.slice();
    options.splice(index, 1);
    patch<StringSelectComponent>(node._id, { options });
  };

  return (
    <>
      <SelectBaseFields node={node} />

      <div className={styles.listHeader}>
        <span>
          Options ({node.options.length} / {LIMITS.SELECT_OPTIONS})
        </span>
        <button
          type="button"
          className={styles.addItem}
          disabled={node.options.length >= LIMITS.SELECT_OPTIONS}
          onClick={addOption}
        >
          + Add option
        </button>
      </div>

      <div className={styles.cards}>
        {node.options.map((opt, i) => (
          <div key={i} className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardTitle}>Option #{i + 1}</span>
              {node.options.length > 1 ? (
                <IconButton
                  size="sm"
                  variant="danger"
                  label="Remove option"
                  onClick={() => removeOption(i)}
                >
                  <TrashIcon size={12} />
                </IconButton>
              ) : null}
            </div>
            <Field label="Label">
              {(id) => (
                <PlaceholderInput
                  id={id}
                  value={opt.label}
                  maxLength={LIMITS.SELECT_OPTION_LABEL}
                  placeholders={placeholders}
                  onChange={(value) => updateOption(i, { ...opt, label: value })}
                />
              )}
            </Field>
            <EmojiField
              emoji={opt.emoji}
              onChange={(emoji) => updateOption(i, { ...opt, emoji })}
            />
            <Field label="Value" hint="Sent to your bot when the option is picked.">
              {(id) => (
                <PlaceholderInput
                  id={id}
                  value={opt.value}
                  maxLength={LIMITS.SELECT_OPTION_VALUE}
                  placeholders={placeholders}
                  onChange={(value) => updateOption(i, { ...opt, value })}
                />
              )}
            </Field>
            <Field label="Description">
              {(id) => (
                <PlaceholderInput
                  id={id}
                  value={opt.description ?? ""}
                  maxLength={LIMITS.SELECT_OPTION_DESCRIPTION}
                  placeholders={placeholders}
                  onChange={(value) =>
                    updateOption(i, {
                      ...opt,
                      description: value || undefined,
                    })
                  }
                  placeholder="Optional"
                />
              )}
            </Field>
            <Switch
              checked={opt.default ?? false}
              onChange={(e) =>
                updateOption(i, {
                  ...opt,
                  default: e.currentTarget.checked || undefined,
                })
              }
              label="Selected by default"
            />
          </div>
        ))}
      </div>
    </>
  );
}
