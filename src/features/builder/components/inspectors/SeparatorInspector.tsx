import { useMessageStore } from "@/core/state/messageStore";
import {
  SeparatorSpacing,
  type SeparatorComponent,
  type SeparatorSpacingValue,
} from "@/core/schema/types";
import { Field } from "@/ui/Field";
import { Select } from "@/ui/Select";
import { Switch } from "@/ui/Switch";

interface Props {
  node: SeparatorComponent;
}

export function SeparatorInspector({ node }: Props) {
  const patch = useMessageStore((s) => s.patchNode);
  return (
    <>
      <Field label="Show divider line" hideLabel>
        {() => (
          <Switch
            checked={node.divider !== false}
            onChange={(e) =>
              patch<SeparatorComponent>(node._id, { divider: e.currentTarget.checked })
            }
            label="Show divider line"
          />
        )}
      </Field>

      <Field label="Spacing">
        {(id) => (
          <Select
            id={id}
            value={String(node.spacing ?? SeparatorSpacing.Small)}
            onChange={(e) =>
              patch<SeparatorComponent>(node._id, {
                spacing: Number(e.currentTarget.value) as SeparatorSpacingValue,
              })
            }
          >
            <option value={String(SeparatorSpacing.Small)}>Small</option>
            <option value={String(SeparatorSpacing.Large)}>Large</option>
          </Select>
        )}
      </Field>
    </>
  );
}
