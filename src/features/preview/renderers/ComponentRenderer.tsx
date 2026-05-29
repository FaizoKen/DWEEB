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
export const ComponentRenderer = memo(function ComponentRenderer({
  node,
}: ComponentRendererProps) {
  const isSelected = useMessageStore((s) => s.selectedId === node._id);
  const select = useMessageStore((s) => s.select);
  const closePreview = usePreviewClose();

  return (
    <div
      data-node-id={node._id}
      className={cn(styles.wrapper, isSelected && styles.selected)}
      onClick={(e) => {
        e.stopPropagation();
        select(node._id);
        // On mobile this dismisses the preview slide-over so the editor
        // (and its now-revealed inspector) becomes visible. No-op on desktop.
        // When the AI chat is open the preview close cascades into closing
        // the chat too (see App.closePreview), so skip the dismiss and let
        // the user keep chatting while picking nodes. Read the AI state lazily
        // here so this node doesn't subscribe to (and re-render on) it.
        if (!useAiStore.getState().open) closePreview?.();
        // Bring the matching tree row into the builder's viewport. Deferred
        // one frame so the freshly-selected row's inline inspector has
        // mounted before `scrollIntoView` measures positions.
        const targetId = node._id;
        requestAnimationFrame(() => {
          const row = document.querySelector<HTMLElement>(
            `[data-tree-row="true"][data-row-id="${CSS.escape(targetId)}"]`,
          );
          row?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
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
