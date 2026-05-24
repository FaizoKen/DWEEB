import { useMessageStore } from "@/core/state/messageStore";
import { LIMITS } from "@/core/schema/limits";
import type { ThumbnailComponent } from "@/core/schema/types";
import { Field } from "@/ui/Field";
import { Switch } from "@/ui/Switch";
import { TextInput } from "@/ui/TextInput";

interface Props {
  node: ThumbnailComponent;
}

export function ThumbnailInspector({ node }: Props) {
  const patch = useMessageStore((s) => s.patchNode);
  return (
    <>
      <Field label="Image URL">
        {(id) => (
          <TextInput
            id={id}
            value={node.media.url}
            onChange={(e) =>
              patch<ThumbnailComponent>(node._id, { media: { url: e.currentTarget.value } })
            }
          />
        )}
      </Field>
      <Field label="Alt text">
        {(id) => (
          <TextInput
            id={id}
            value={node.description ?? ""}
            maxLength={LIMITS.MEDIA_DESCRIPTION}
            onChange={(e) =>
              patch<ThumbnailComponent>(node._id, {
                description: e.currentTarget.value || undefined,
              })
            }
          />
        )}
      </Field>
      <Switch
        checked={node.spoiler ?? false}
        onChange={(e) =>
          patch<ThumbnailComponent>(node._id, { spoiler: e.currentTarget.checked || undefined })
        }
        label="Mark as spoiler"
      />
    </>
  );
}
