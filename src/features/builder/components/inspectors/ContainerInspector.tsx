import { useMessageStore } from "@/core/state/messageStore";
import type { ContainerComponent } from "@/core/schema/types";
import { ColorInput } from "@/ui/ColorInput";
import { Field } from "@/ui/Field";
import { Switch } from "@/ui/Switch";

interface Props {
  node: ContainerComponent;
}

export function ContainerInspector({ node }: Props) {
  const patch = useMessageStore((s) => s.patchNode);
  return (
    <>
      <Field label="Accent color" hint="Sets the left stripe color in Discord's UI.">
        {(id) => (
          <ColorInput
            id={id}
            value={node.accent_color}
            clearable
            onChange={(value) =>
              patch<ContainerComponent>(node._id, { accent_color: value })
            }
          />
        )}
      </Field>

      <Field label="Spoiler" hideLabel>
        {() => (
          <Switch
            checked={node.spoiler ?? false}
            onChange={(e) =>
              patch<ContainerComponent>(node._id, { spoiler: e.currentTarget.checked })
            }
            label="Hide behind spoiler"
          />
        )}
      </Field>
    </>
  );
}
