import { useMessageStore } from "@/core/state/messageStore";
import { LIMITS } from "@/core/schema/limits";
import type { TextDisplayComponent } from "@/core/schema/types";
import { Field } from "@/ui/Field";
import { TextArea } from "@/ui/TextArea";

interface Props {
  node: TextDisplayComponent;
}

export function TextDisplayInspector({ node }: Props) {
  const patch = useMessageStore((s) => s.patchNode);
  return (
    <Field
      label="Content"
      hint={`Markdown supported. ${node.content.length}/${LIMITS.TEXT_DISPLAY_CONTENT}`}
    >
      {(id) => (
        <TextArea
          id={id}
          value={node.content}
          maxLength={LIMITS.TEXT_DISPLAY_CONTENT}
          rows={8}
          onChange={(e) =>
            patch<TextDisplayComponent>(node._id, { content: e.currentTarget.value })
          }
          placeholder="Write your message…"
        />
      )}
    </Field>
  );
}
