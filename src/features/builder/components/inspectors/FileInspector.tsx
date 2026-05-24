import { useMessageStore } from "@/core/state/messageStore";
import type { FileComponent } from "@/core/schema/types";
import { Field } from "@/ui/Field";
import { TextInput } from "@/ui/TextInput";
import { Switch } from "@/ui/Switch";

interface Props {
  node: FileComponent;
}

export function FileInspector({ node }: Props) {
  const patch = useMessageStore((s) => s.patchNode);
  return (
    <>
      <Field
        label="Attachment URL"
        hint="Use attachment://<filename> when sending alongside multipart uploads."
      >
        {(id) => (
          <TextInput
            id={id}
            value={node.file.url}
            onChange={(e) =>
              patch<FileComponent>(node._id, {
                file: { url: e.currentTarget.value },
              })
            }
          />
        )}
      </Field>
      <Switch
        checked={node.spoiler ?? false}
        onChange={(e) =>
          patch<FileComponent>(node._id, { spoiler: e.currentTarget.checked || undefined })
        }
        label="Mark as spoiler"
      />
    </>
  );
}
