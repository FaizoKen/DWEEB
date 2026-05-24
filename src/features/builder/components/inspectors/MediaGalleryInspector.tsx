import { useMessageStore } from "@/core/state/messageStore";
import { LIMITS } from "@/core/schema/limits";
import {
  ComponentType,
  type MediaGalleryComponent,
  type MediaGalleryItem,
} from "@/core/schema/types";
import { Field } from "@/ui/Field";
import { IconButton } from "@/ui/IconButton";
import { TextInput } from "@/ui/TextInput";
import { TrashIcon } from "@/ui/Icon";
import { Switch } from "@/ui/Switch";
import styles from "./inspectors.module.css";

interface Props {
  node: MediaGalleryComponent;
}

export function MediaGalleryInspector({ node }: Props) {
  const patch = useMessageStore((s) => s.patchNode);
  const addItem = useMessageStore((s) => s.addGalleryItem);

  const updateItem = (index: number, item: MediaGalleryItem) => {
    const items = node.items.slice();
    items[index] = item;
    patch<MediaGalleryComponent>(node._id, { items });
  };

  const removeItem = (index: number) => {
    const items = node.items.slice();
    items.splice(index, 1);
    if (items.length === 0) return; // keep at least one
    patch<MediaGalleryComponent>(node._id, { items });
  };

  return (
    <>
      <div className={styles.listHeader}>
        <span>Images ({node.items.length} / {LIMITS.GALLERY_ITEMS})</span>
        <button
          type="button"
          className={styles.addItem}
          disabled={node.items.length >= LIMITS.GALLERY_ITEMS}
          onClick={() => addItem(node._id)}
        >
          + Add image
        </button>
      </div>

      <div className={styles.cards}>
        {node.items.map((item, i) => (
          <div key={i} className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardTitle}>Image #{i + 1}</span>
              {node.items.length > 1 ? (
                <IconButton
                  size="sm"
                  variant="danger"
                  label="Remove image"
                  onClick={() => removeItem(i)}
                >
                  <TrashIcon size={12} />
                </IconButton>
              ) : null}
            </div>
            <Field label="URL" hint="https:// or attachment://filename">
              {(id) => (
                <TextInput
                  id={id}
                  value={item.media.url}
                  onChange={(e) =>
                    updateItem(i, { ...item, media: { url: e.currentTarget.value } })
                  }
                />
              )}
            </Field>
            <Field label="Alt text">
              {(id) => (
                <TextInput
                  id={id}
                  value={item.description ?? ""}
                  maxLength={LIMITS.MEDIA_DESCRIPTION}
                  onChange={(e) =>
                    updateItem(i, { ...item, description: e.currentTarget.value || undefined })
                  }
                />
              )}
            </Field>
            <Switch
              checked={item.spoiler ?? false}
              onChange={(e) =>
                updateItem(i, { ...item, spoiler: e.currentTarget.checked || undefined })
              }
              label="Mark as spoiler"
            />
          </div>
        ))}
      </div>

      <p className={styles.note}>
        This gallery sits at type <code>{ComponentType.MediaGallery}</code> in the wire format.
      </p>
    </>
  );
}
