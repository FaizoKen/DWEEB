/**
 * Inline editor for a single media-gallery image.
 *
 * Rendered in the component tree under its gallery row (the image behaves like
 * a component: select to expand this editor, reorder with the row arrows). All
 * edits route through `patchGalleryItem`, which targets the image by its
 * editor id so reordering never desyncs the wrong slot.
 */

import { useMessageStore } from "@/core/state/messageStore";
import { useUiPrefs } from "@/core/state/uiPrefs";
import { LIMITS } from "@/core/schema/limits";
import type { EditorId, MediaGalleryItem } from "@/core/schema/types";
import { Field } from "@/ui/Field";
import { TextInput } from "@/ui/TextInput";
import { Switch } from "@/ui/Switch";
import { useNodeIssues } from "@/features/builder/useValidation";
import { IssueList } from "../ValidationIssues";
import { AttachmentPicker } from "./AttachmentPicker";
import styles from "./inspectors.module.css";

interface Props {
  galleryId: EditorId;
  item: MediaGalleryItem;
}

export function GalleryItemInspector({ galleryId, item }: Props) {
  const patchItem = useMessageStore((s) => s.patchGalleryItem);
  const advancedMode = useUiPrefs((s) => s.advancedMode);
  const issues = useNodeIssues(item._id);

  return (
    <div className={styles.itemBody}>
      <IssueList issues={issues} />
      <AttachmentPicker
        url={item.media.url ?? ""}
        accept="image/*,video/*"
        onChange={(next) =>
          patchItem(galleryId, item._id, {
            media: { url: next, attachment_id: undefined },
          })
        }
      />
      <Field
        label="URL"
        hint={
          advancedMode
            ? "https:// or attachment://filename"
            : "Paste a direct image or video link (https://…)."
        }
      >
        {(id) => (
          <TextInput
            id={id}
            value={item.media.url ?? ""}
            onChange={(e) =>
              patchItem(galleryId, item._id, {
                media: { ...item.media, url: e.currentTarget.value || undefined },
              })
            }
          />
        )}
      </Field>
      {advancedMode ? (
        <Field
          label="Attachment ID (optional)"
          hint="Reference an already-uploaded attachment by snowflake."
        >
          {(id) => (
            <TextInput
              id={id}
              value={item.media.attachment_id ?? ""}
              inputMode="numeric"
              maxLength={LIMITS.SNOWFLAKE_MAX}
              onChange={(e) =>
                patchItem(galleryId, item._id, {
                  media: {
                    ...item.media,
                    attachment_id: e.currentTarget.value.replace(/[^\d]/g, "") || undefined,
                  },
                })
              }
              placeholder="e.g. 1185234567890123456"
            />
          )}
        </Field>
      ) : null}
      <Field label="Alt text">
        {(id) => (
          <TextInput
            id={id}
            value={item.description ?? ""}
            maxLength={LIMITS.MEDIA_DESCRIPTION}
            onChange={(e) =>
              patchItem(galleryId, item._id, {
                description: e.currentTarget.value || undefined,
              })
            }
          />
        )}
      </Field>
      <Switch
        checked={item.spoiler ?? false}
        onChange={(e) =>
          patchItem(galleryId, item._id, { spoiler: e.currentTarget.checked || undefined })
        }
        label="Mark as spoiler"
      />
    </div>
  );
}
