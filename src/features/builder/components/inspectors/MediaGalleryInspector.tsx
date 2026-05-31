import { useMessageStore } from "@/core/state/messageStore";
import { scrollTreeRowIntoView } from "@/features/builder/scrollTreeRow";
import { LIMITS } from "@/core/schema/limits";
import { ComponentType, type MediaGalleryComponent } from "@/core/schema/types";
import styles from "./inspectors.module.css";

interface Props {
  node: MediaGalleryComponent;
}

export function MediaGalleryInspector({ node }: Props) {
  const addItem = useMessageStore((s) => s.addGalleryItem);

  return (
    <>
      <div className={styles.listHeader}>
        <span>
          Images ({node.items.length} / {LIMITS.GALLERY_ITEMS})
        </span>
        <button
          type="button"
          className={styles.addItem}
          disabled={node.items.length >= LIMITS.GALLERY_ITEMS}
          onClick={() => {
            addItem(node._id);
            // addGalleryItem selects the new image; scroll its freshly-mounted
            // tree row into view so editing continues without a hunt.
            const newId = useMessageStore.getState().selectedId;
            if (newId) scrollTreeRowIntoView(newId);
          }}
        >
          + Add image
        </button>
      </div>

      <p className={styles.note}>
        Each image is its own row in the tree below — select a row to edit it, or use its up/down
        arrows to reorder.
      </p>

      <p className={styles.note}>
        This gallery sits at type <code>{ComponentType.MediaGallery}</code> in the wire format.
      </p>
    </>
  );
}
