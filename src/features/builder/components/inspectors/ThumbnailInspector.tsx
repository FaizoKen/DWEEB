import { useMessageStore } from "@/core/state/messageStore";
import { LIMITS } from "@/core/schema/limits";
import type { ThumbnailComponent, UnfurledMediaItem } from "@/core/schema/types";
import { Disclosure } from "@/ui/Disclosure";
import { Field } from "@/ui/Field";
import { Switch } from "@/ui/Switch";
import { TextInput } from "@/ui/TextInput";
import { PlaceholderInput } from "@/ui/PlaceholderInput";
import { useMessagePlaceholders } from "@/features/builder/useMessagePlaceholders";
import { AttachmentPicker } from "./AttachmentPicker";

interface Props {
  node: ThumbnailComponent;
}

export function ThumbnailInspector({ node }: Props) {
  const patch = useMessageStore((s) => s.patchNode);
  const placeholders = useMessagePlaceholders();

  const setMedia = (partial: Partial<UnfurledMediaItem>) => {
    patch<ThumbnailComponent>(node._id, {
      media: { ...node.media, ...partial },
    });
  };

  return (
    <>
      <AttachmentPicker
        url={node.media.url ?? ""}
        accept="image/*"
        onChange={(next) =>
          patch<ThumbnailComponent>(node._id, {
            media: { url: next, attachment_id: undefined },
          })
        }
      />
      <Field label="Image URL" hint="Paste a direct image link (https://…).">
        {(id) => (
          <PlaceholderInput
            id={id}
            value={node.media.url ?? ""}
            placeholders={placeholders}
            onChange={(value) => setMedia({ url: value || undefined })}
          />
        )}
      </Field>
      <Disclosure label="Advanced media options">
        <Field
          label="Attachment ID (optional)"
          hint="Discord snowflake. Use instead of URL to reference an already-uploaded file."
        >
          {(id) => (
            <TextInput
              id={id}
              value={node.media.attachment_id ?? ""}
              inputMode="numeric"
              maxLength={LIMITS.SNOWFLAKE_MAX}
              onChange={(e) =>
                setMedia({
                  attachment_id: e.currentTarget.value.replace(/[^\d]/g, "") || undefined,
                })
              }
              placeholder="e.g. 1185234567890123456"
            />
          )}
        </Field>
      </Disclosure>
      <Field label="Alt text">
        {(id) => (
          <PlaceholderInput
            id={id}
            value={node.description ?? ""}
            maxLength={LIMITS.MEDIA_DESCRIPTION}
            placeholders={placeholders}
            onChange={(value) =>
              patch<ThumbnailComponent>(node._id, {
                description: value || undefined,
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
