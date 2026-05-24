import { useMessageStore } from "@/core/state/messageStore";
import { ComponentType, type SectionComponent } from "@/core/schema/types";
import { Field } from "@/ui/Field";
import { Select } from "@/ui/Select";

interface Props {
  node: SectionComponent;
}

export function SectionInspector({ node }: Props) {
  const setKind = useMessageStore((s) => s.setSectionAccessoryKind);
  const accessoryKind = node.accessory.type === ComponentType.Button ? "button" : "thumbnail";

  return (
    <Field
      label="Accessory"
      hint="Sections render text with a single accessory pinned to the right."
    >
      {(id) => (
        <Select
          id={id}
          value={accessoryKind}
          onChange={(e) => {
            const v = e.currentTarget.value as "button" | "thumbnail";
            if (v !== accessoryKind) setKind(node._id, v);
          }}
        >
          <option value="thumbnail">Thumbnail</option>
          <option value="button">Button</option>
        </Select>
      )}
    </Field>
  );
}
