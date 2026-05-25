/**
 * Editor for the `default_values` array on User/Role/Mentionable/Channel
 * selects. Each entry pairs a snowflake id with a type ("user" / "role" /
 * "channel"). User and Channel selects fix the type; Mentionable lets the
 * user pick per-entry.
 */

import { useMessageStore } from "@/core/state/messageStore";
import { LIMITS } from "@/core/schema/limits";
import type { SelectComponent } from "@/core/schema/types";
import { Field } from "@/ui/Field";
import { IconButton } from "@/ui/IconButton";
import { Select } from "@/ui/Select";
import { TextInput } from "@/ui/TextInput";
import { TrashIcon } from "@/ui/Icon";
import styles from "./inspectors.module.css";

type Entry = { id: string; type: "user" | "role" | "channel" };

interface Props {
  node: SelectComponent & { default_values?: Entry[] };
  /** Which types the snowflake may take. Single entry locks the type column. */
  allowedTypes: Array<"user" | "role" | "channel">;
}

export function DefaultValuesEditor({ node, allowedTypes }: Props) {
  const patch = useMessageStore((s) => s.patchNode);
  const values = node.default_values ?? [];
  const fixedType = allowedTypes.length === 1 ? allowedTypes[0]! : null;

  const update = (next: Entry[]) => {
    patch<SelectComponent>(node._id, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      default_values: next.length > 0 ? (next as any) : undefined,
    });
  };

  const updateEntry = (index: number, entry: Entry) => {
    const next = values.slice();
    next[index] = entry;
    update(next);
  };

  const removeEntry = (index: number) => {
    const next = values.slice();
    next.splice(index, 1);
    update(next);
  };

  const addEntry = () => {
    update([...values, { id: "", type: fixedType ?? allowedTypes[0]! }]);
  };

  return (
    <div className={styles.subPanel}>
      <div className={styles.listHeader}>
        <span>
          default_values ({values.length} / {LIMITS.SELECT_DEFAULT_VALUES})
        </span>
        <button
          type="button"
          className={styles.addItem}
          disabled={values.length >= LIMITS.SELECT_DEFAULT_VALUES}
          onClick={addEntry}
        >
          + Add default
        </button>
      </div>

      {values.length === 0 ? (
        <p className={styles.note}>
          Pre-selects an entry when the user opens the menu. Leave empty for none.
        </p>
      ) : (
        <div className={styles.cards}>
          {values.map((entry, i) => (
            <div key={i} className={styles.card}>
              <div className={styles.cardHeader}>
                <span className={styles.cardTitle}>Entry #{i + 1}</span>
                <IconButton
                  size="sm"
                  variant="danger"
                  label="Remove"
                  onClick={() => removeEntry(i)}
                >
                  <TrashIcon size={12} />
                </IconButton>
              </div>
              <div className={styles.row2}>
                <Field label="Snowflake ID">
                  {(id) => (
                    <TextInput
                      id={id}
                      value={entry.id}
                      inputMode="numeric"
                      maxLength={LIMITS.SNOWFLAKE_MAX}
                      onChange={(e) =>
                        updateEntry(i, {
                          ...entry,
                          id: e.currentTarget.value.replace(/[^\d]/g, ""),
                        })
                      }
                      placeholder="e.g. 1185234567890123456"
                    />
                  )}
                </Field>
                <Field label="Type">
                  {(id) => (
                    <Select
                      id={id}
                      value={entry.type}
                      disabled={fixedType !== null}
                      onChange={(e) =>
                        updateEntry(i, {
                          ...entry,
                          type: e.currentTarget.value as Entry["type"],
                        })
                      }
                    >
                      {allowedTypes.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
