/**
 * StringSelect inspector — edits the base fields plus the option list.
 *
 * Each option is rendered as a card with label / value / description /
 * default-flag controls. We refuse to allow zero options (validator already
 * surfaces that as an error) but otherwise let the user freely add/remove.
 */

import { useMessageStore } from "@/core/state/messageStore";
import { LIMITS } from "@/core/schema/limits";
import type { StringSelectComponent, StringSelectOption } from "@/core/schema/types";
import { Field } from "@/ui/Field";
import { IconButton } from "@/ui/IconButton";
import { Switch } from "@/ui/Switch";
import { TextInput } from "@/ui/TextInput";
import { TrashIcon } from "@/ui/Icon";
import { SelectBaseFields } from "./SelectShared";
import styles from "./inspectors.module.css";

interface Props {
  node: StringSelectComponent;
}

export function StringSelectInspector({ node }: Props) {
  const patch = useMessageStore((s) => s.patchNode);

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
                <TextInput
                  id={id}
                  value={opt.label}
                  maxLength={LIMITS.SELECT_OPTION_LABEL}
                  onChange={(e) =>
                    updateOption(i, { ...opt, label: e.currentTarget.value })
                  }
                />
              )}
            </Field>
            <Field label="Value" hint="Sent to your bot when the option is picked.">
              {(id) => (
                <TextInput
                  id={id}
                  value={opt.value}
                  maxLength={LIMITS.SELECT_OPTION_VALUE}
                  onChange={(e) =>
                    updateOption(i, { ...opt, value: e.currentTarget.value })
                  }
                />
              )}
            </Field>
            <Field label="Description">
              {(id) => (
                <TextInput
                  id={id}
                  value={opt.description ?? ""}
                  maxLength={LIMITS.SELECT_OPTION_DESCRIPTION}
                  onChange={(e) =>
                    updateOption(i, {
                      ...opt,
                      description: e.currentTarget.value || undefined,
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
