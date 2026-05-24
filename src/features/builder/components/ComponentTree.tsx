/**
 * Hierarchical view of the message's components.
 *
 * Each row carries its node's id in a `data-node-id` attribute and uses the
 * store's `select` action on click. Reordering happens through the store
 * (`moveSibling`) so the preview stays in lockstep with the tree without
 * intermediate state.
 *
 * The "add" affordance is contextual: the menu only offers component types
 * legal in the current parent. This avoids producing invalid trees that the
 * validator would then have to reject after the fact.
 */

import { useMessageStore } from "@/core/state/messageStore";
import { COMPONENT_META, CONTAINER_PICKER, TOP_LEVEL_PICKER } from "@/core/schema/metadata";
import {
  isActionRow,
  isContainer,
  isSection,
} from "@/core/schema/guards";
import { LIMITS } from "@/core/schema/limits";
import type {
  ActionRowComponent,
  AnyComponent,
  ContainerComponent,
  EditorId,
  MediaGalleryComponent,
  SectionComponent,
} from "@/core/schema/types";
import { ComponentType } from "@/core/schema/types";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { AddComponentMenu } from "./AddComponentMenu";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CopyIcon,
  TrashIcon,
} from "@/ui/Icon";
import { cn } from "@/lib/cn";
import styles from "./ComponentTree.module.css";
import type {
  ContainerChildFactoryKey,
  TopLevelFactoryKey,
} from "@/core/factory/createComponent";

export function ComponentTree() {
  const components = useMessageStore((s) => s.message.components);
  const addTopLevel = useMessageStore((s) => s.addTopLevel);
  const atLimit = components.length >= LIMITS.TOP_LEVEL_COMPONENTS;

  return (
    <div className={styles.tree}>
      <div className={styles.scroll}>
        {components.length === 0 ? (
          <div className={styles.empty}>
            <p>Nothing here yet. Add your first component to get started.</p>
          </div>
        ) : (
          <ul className={styles.list}>
            {components.map((c) => (
              <TreeNode key={c._id} node={c} depth={0} />
            ))}
          </ul>
        )}
      </div>

      <div className={styles.footer}>
        <AddComponentMenu
          allowed={TOP_LEVEL_PICKER}
          onPick={(t) => addTopLevel(t as TopLevelFactoryKey)}
          disabled={atLimit}
          align="top"
          trigger={
            <Button variant="primary" fullWidth disabled={atLimit}>
              {atLimit ? "Top-level limit reached" : "Add component"}
            </Button>
          }
        />
      </div>
    </div>
  );
}

interface TreeNodeProps {
  node: AnyComponent;
  depth: number;
}

function TreeNode({ node, depth }: TreeNodeProps) {
  const selectedId = useMessageStore((s) => s.selectedId);
  const select = useMessageStore((s) => s.select);
  const moveSibling = useMessageStore((s) => s.moveSibling);
  const remove = useMessageStore((s) => s.remove);
  const duplicate = useMessageStore((s) => s.duplicate);
  const addContainerChild = useMessageStore((s) => s.addContainerChild);
  const addSectionText = useMessageStore((s) => s.addSectionText);
  const addRowButton = useMessageStore((s) => s.addRowButton);
  const addGalleryItem = useMessageStore((s) => s.addGalleryItem);

  const isSelected = selectedId === node._id;
  const meta = COMPONENT_META[node.type];

  // Compute children that should render as sub-rows in the tree.
  const children = childrenOf(node);

  return (
    <li>
      <div
        className={cn(styles.row, isSelected && styles.rowSelected)}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={(e) => {
          e.stopPropagation();
          select(node._id);
        }}
      >
        <span className={styles.glyph}>{meta.glyph}</span>
        <span className={styles.label}>{meta.label}</span>
        <span className={styles.summary}>{summarize(node)}</span>

        <div className={styles.actions} onClick={(e) => e.stopPropagation()}>
          <IconButton size="sm" label="Move up" onClick={() => moveSibling(node._id, -1)}>
            <ArrowUpIcon size={12} />
          </IconButton>
          <IconButton size="sm" label="Move down" onClick={() => moveSibling(node._id, 1)}>
            <ArrowDownIcon size={12} />
          </IconButton>
          <IconButton size="sm" label="Duplicate" onClick={() => duplicate(node._id)}>
            <CopyIcon size={12} />
          </IconButton>
          <IconButton size="sm" variant="danger" label="Delete" onClick={() => remove(node._id)}>
            <TrashIcon size={12} />
          </IconButton>
        </div>
      </div>

      {children.length > 0 ? (
        <ul className={styles.list}>
          {children.map((child) => (
            <TreeNode key={(child as { _id: EditorId })._id} node={child} depth={depth + 1} />
          ))}
        </ul>
      ) : null}

      {isContainer(node) ? (
        <ChildAdder>
          <AddComponentMenu
            allowed={CONTAINER_PICKER}
            disabled={node.components.length >= LIMITS.CONTAINER_CHILDREN}
            onPick={(t) => addContainerChild(node._id, t as ContainerChildFactoryKey)}
            trigger={<AddChildButton label="Add to container" depth={depth + 1} />}
          />
        </ChildAdder>
      ) : null}

      {isSection(node) && (node as SectionComponent).components.length < LIMITS.SECTION_TEXTS_MAX ? (
        <ChildAdder>
          <AddChildButton
            label="Add text"
            depth={depth + 1}
            onClick={() => addSectionText(node._id)}
          />
        </ChildAdder>
      ) : null}

      {isActionRow(node) &&
      (node as ActionRowComponent).components.length < LIMITS.ACTION_ROW_BUTTONS ? (
        <ChildAdder>
          <AddChildButton
            label="Add button"
            depth={depth + 1}
            onClick={() => addRowButton(node._id)}
          />
        </ChildAdder>
      ) : null}

      {node.type === ComponentType.MediaGallery &&
      (node as MediaGalleryComponent).items.length < LIMITS.GALLERY_ITEMS ? (
        <ChildAdder>
          <AddChildButton
            label="Add image"
            depth={depth + 1}
            onClick={() => addGalleryItem(node._id)}
          />
        </ChildAdder>
      ) : null}
    </li>
  );
}

function ChildAdder({ children }: { children: React.ReactNode }) {
  return <div className={styles.adder}>{children}</div>;
}

function AddChildButton({
  label,
  depth,
  onClick,
}: {
  label: string;
  depth: number;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.addChild}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={onClick}
    >
      <span className={styles.addChildPlus} aria-hidden="true">+</span>
      <span>{label}</span>
    </button>
  );
}

function childrenOf(node: AnyComponent): AnyComponent[] {
  if (isContainer(node)) return node.components;
  if (isSection(node)) return [...node.components, node.accessory];
  if (isActionRow(node)) return node.components;
  return [];
}

function summarize(node: AnyComponent): string {
  if (node.type === ComponentType.TextDisplay) {
    const t = node.content.replace(/\s+/g, " ").trim();
    return t.length > 40 ? `${t.slice(0, 40)}…` : t;
  }
  if (node.type === ComponentType.Container) {
    const cc = (node as ContainerComponent).components.length;
    return `${cc} ${cc === 1 ? "child" : "children"}`;
  }
  if (node.type === ComponentType.MediaGallery) {
    const n = (node as MediaGalleryComponent).items.length;
    return `${n} ${n === 1 ? "image" : "images"}`;
  }
  if (node.type === ComponentType.ActionRow) {
    const n = (node as ActionRowComponent).components.length;
    return `${n} ${n === 1 ? "button" : "buttons"}`;
  }
  if (node.type === ComponentType.Button) {
    return "label" in node ? node.label ?? "" : "";
  }
  return "";
}
