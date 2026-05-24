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

import { ComponentType, type AnyComponent } from "@/core/schema/types";
import { useMessageStore } from "@/core/state/messageStore";
import { cn } from "@/lib/cn";
import { ContainerRenderer } from "./ContainerRenderer";
import { SectionRenderer } from "./SectionRenderer";
import { TextDisplayRenderer } from "./TextDisplayRenderer";
import { MediaGalleryRenderer } from "./MediaGalleryRenderer";
import { SeparatorRenderer } from "./SeparatorRenderer";
import { FileRenderer } from "./FileRenderer";
import { ActionRowRenderer } from "./ActionRowRenderer";
import { ButtonRenderer } from "./ButtonRenderer";
import { ThumbnailRenderer } from "./ThumbnailRenderer";
import styles from "./ComponentRenderer.module.css";

interface ComponentRendererProps {
  node: AnyComponent;
  /** Hide the selection ring on a sub-component (e.g. accessory). */
  noSelectionRing?: boolean;
}

export function ComponentRenderer({ node, noSelectionRing }: ComponentRendererProps) {
  const selectedId = useMessageStore((s) => s.selectedId);
  const select = useMessageStore((s) => s.select);
  const isSelected = selectedId === node._id;

  return (
    <div
      data-node-id={node._id}
      className={cn(styles.wrapper, !noSelectionRing && isSelected && styles.selected)}
      onClick={(e) => {
        e.stopPropagation();
        select(node._id);
      }}
    >
      {renderByType(node)}
    </div>
  );
}

function renderByType(node: AnyComponent) {
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
  // Unreachable for any `AnyComponent` value. The fallback exists so that
  // imported JSON carrying an unknown / interactive-only type (selects,
  // text input) renders an explainer instead of throwing.
  return (
    <div className={styles.unsupported}>
      This component requires interactions (a bot) and isn't supported by webhook messages.
    </div>
  );
}
