import { useMessageStore } from "@/core/state/messageStore";
import { useUiPrefs } from "@/core/state/uiPrefs";
import { LIMITS } from "@/core/schema/limits";
import type { FileComponent, UnfurledMediaItem } from "@/core/schema/types";
import { Field } from "@/ui/Field";
import { TextInput } from "@/ui/TextInput";
import { Switch } from "@/ui/Switch";
import { AttachmentPicker } from "./AttachmentPicker";

interface Props {
  node: FileComponent;
}

export function FileInspector({ node }: Props) {
  const patch = useMessageStore((s) => s.patchNode);
  const advancedMode = useUiPrefs((s) => s.advancedMode);

  const setFile = (partial: Partial<UnfurledMediaItem>) => {
    patch<FileComponent>(node._id, {
      file: { ...node.file, ...partial },
    });
  };

  return (
    <>
      <AttachmentPicker
        url={node.file.url ?? ""}
        onChange={(next) =>
          patch<FileComponent>(node._id, {
            file: { url: next, attachment_id: undefined },
          })
        }
      />
      {advancedMode ? (
        <>
          <Field
            label="URL override"
            hint="File components only display uploaded attachments — use attachment://filename, not an external link."
          >
            {(id) => (
              <TextInput
                id={id}
                value={node.file.url ?? ""}
                onChange={(e) => setFile({ url: e.currentTarget.value || undefined })}
              />
            )}
          </Field>
          <Field
            label="Attachment ID (optional)"
            hint="Discord snowflake. Use instead of URL to reference an already-uploaded file."
          >
            {(id) => (
              <TextInput
                id={id}
                value={node.file.attachment_id ?? ""}
                inputMode="numeric"
                maxLength={LIMITS.SNOWFLAKE_MAX}
                onChange={(e) =>
                  setFile({
                    attachment_id: e.currentTarget.value.replace(/[^\d]/g, "") || undefined,
                  })
                }
                placeholder="e.g. 1185234567890123456"
              />
            )}
          </Field>
        </>
      ) : null}
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
