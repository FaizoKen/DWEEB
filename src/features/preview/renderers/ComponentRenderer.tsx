/**
 * Component renderer dispatcher.
 *
 * One entry point that maps a Discord component to its dedicated renderer.
 * The dispatcher is exhaustive over `ComponentTypeValue` — if a new type is
 * added to the schema, TypeScript flags this switch as incomplete.
 *
 * Selecting in the editor highlights the matching rendered node via the
 * `data-node-id` attribute; the wrapper here is the single place that
 * attribute is applied.
 */

import { memo } from "react";
import { ComponentType, type AnyComponent } from "@/core/schema/types";
import { isSelect } from "@/core/schema/guards";
import { COMPONENT_META } from "@/core/schema/metadata";
import { useMessageStore } from "@/core/state/messageStore";
import { useAiStore } from "@/core/ai/aiStore";
import { cn } from "@/lib/cn";
import { usePreviewClose } from "../previewCloseContext";
import { ContainerRenderer } from "./ContainerRenderer";
import { SectionRenderer } from "./SectionRenderer";
import { TextDisplayRenderer } from "./TextDisplayRenderer";
import { MediaGalleryRenderer } from "./MediaGalleryRenderer";
import { SeparatorRenderer } from "./SeparatorRenderer";
import { FileRenderer } from "./FileRenderer";
import { ActionRowRenderer } from "./ActionRowRenderer";
import { ButtonRenderer } from "./ButtonRenderer";
import { ThumbnailRenderer } from "./ThumbnailRenderer";
import { SelectRenderer } from "./SelectRenderer";
import styles from "./ComponentRenderer.module.css";

interface ComponentRendererProps {
  node: AnyComponent;
}

// Memoized so a keystroke only re-renders the edited node's ancestor chain: the
// store shares structure across edits (unchanged subtrees keep their `node`
// reference), so memo lets every untouched node bail out. Selection state is
// read as a per-node boolean below, so changing the selection only re-renders
// the two nodes whose highlight actually flips — not the whole preview tree.
export const ComponentRenderer = memo(function ComponentRenderer({ node }: ComponentRendererProps) {
  const isSelected = useMessageStore((s) => s.selectedId === node._id);
  const select = useMessageStore((s) => s.select);
  const closePreview = usePreviewClose();

  const openEditor = (focusTreeRow: boolean) => {
    // Revealing an obscured spoiler shouldn't also dismiss the mobile preview
    // — the user needs to see the now-revealed content. A second activation
    // (the node is already selected) dismisses as usual.
    const revealingSpoiler = "spoiler" in node && node.spoiler === true && !isSelected;
    select(node._id);
    // On mobile this dismisses the preview slide-over so the editor (and its
    // now-revealed inspector) becomes visible. When AI is open, keep both up so
    // the user can continue chatting while picking nodes.
    if (!revealingSpoiler && !useAiStore.getState().open) closePreview?.();

    // Defer until the selected row's inline inspector has mounted. Keyboard
    // activation also moves focus to that row's real selection button.
    const targetId = node._id;
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(
        `[data-tree-row="true"][data-row-id="${CSS.escape(targetId)}"]`,
      );
      row?.scrollIntoView({ behavior: "smooth", block: "start" });
      if (focusTreeRow) {
        row
          ?.querySelector<HTMLButtonElement>("[data-row-select='true']")
          ?.focus({ preventScroll: true });
      }
    });
  };

  return (
    <div
      data-node-id={node._id}
      className={cn(styles.wrapper, isSelected && styles.selected)}
      role="group"
      aria-label={`${COMPONENT_META[node.type].label} component. Press Enter to edit.`}
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        openEditor(false);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        openEditor(true);
      }}
    >
      {renderByType(node)}
    </div>
  );
});

function renderByType(node: AnyComponent) {
  if (isSelect(node)) return <SelectRenderer node={node} />;
  switch (node.type) {
    case ComponentType.Container:
      return <ContainerRenderer node={node} />;
    case ComponentType.Section:
      return <SectionRenderer node={node} />;
    case ComponentType.TextDisplay:
      return <TextDisplayRenderer node={node} />;
    case ComponentType.MediaGallery:
      return <MediaGalleryRenderer node={node} />;
    case ComponentType.Separator:
      return <SeparatorRenderer node={node} />;
    case ComponentType.File:
      return <FileRenderer node={node} />;
    case ComponentType.ActionRow:
      return <ActionRowRenderer node={node} />;
    case ComponentType.Button:
      return <ButtonRenderer node={node} />;
    case ComponentType.Thumbnail:
      return <ThumbnailRenderer node={node} />;
  }
  // Anything not handled above — e.g. TextInput which can never appear in a
  // message — renders as an explainer block instead of throwing. After the
  // exhaustive switch on `AnyComponent` the type narrows to `never`; the cast
  // lets us still read `.type` for the user-facing diagnostic.
  const unknownType = (node as { type?: number }).type;
  return (
    <div className={styles.unsupported}>
      This component type ({String(unknownType)}) cannot appear in a webhook message.
    </div>
  );
}
