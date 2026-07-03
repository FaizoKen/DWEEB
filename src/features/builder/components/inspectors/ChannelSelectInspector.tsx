/**
 * Channel select inspector. Adds the `channel_types` filter (a multi-select
 * of channel-type integers) on top of the shared select base + the snowflake
 * default-values list.
 */

import { useMessageStore } from "@/core/state/messageStore";
import { CHANNEL_TYPE_LABELS } from "@/core/schema/metadata";
import type { ChannelSelectComponent } from "@/core/schema/types";
import { ChannelType } from "@/core/schema/types";
import { Field } from "@/ui/Field";
import { cn } from "@/lib/cn";
import { DefaultValuesEditor } from "./DefaultValuesEditor";
import { SelectBaseFields } from "./SelectShared";
import styles from "./inspectors.module.css";

interface Props {
  node: ChannelSelectComponent;
}

const ALL_TYPES: number[] = Object.values(ChannelType);

export function ChannelSelectInspector({ node }: Props) {
  const patch = useMessageStore((s) => s.patchNode);
  const types = new Set(node.channel_types ?? []);

  const toggle = (t: number) => {
    const next = new Set(types);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    patch<ChannelSelectComponent>(node._id, {
      channel_types: next.size > 0 ? Array.from(next).sort((a, b) => a - b) : undefined,
    });
  };

  return (
    <>
      <SelectBaseFields node={node} />

      <Field label="Channel types filter" hint="Leave all off to allow any channel type.">
        {() => (
          <div className={styles.chipRow}>
            {ALL_TYPES.map((t) => {
              const active = types.has(t);
              return (
                <button
                  key={t}
                  type="button"
                  className={cn(styles.chip, active && styles.chipActive)}
                  onClick={() => toggle(t)}
                  aria-pressed={active}
                >
                  {CHANNEL_TYPE_LABELS[t] ?? `Type ${t}`}
                </button>
              );
            })}
          </div>
        )}
      </Field>

      <DefaultValuesEditor node={node} allowedTypes={["channel"]} />
    </>
  );
}
