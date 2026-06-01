/**
 * Inspector — edits the selected component's fields.
 *
 * Looks up the node by id on every render via `findById`. The lookup is O(n)
 * over the tree, which is bounded by Discord's 40-component cap, so this is
 * never a perf concern. Keeping the dispatch logic shallow makes it trivial
 * to add a new inspector for a new component type.
 */

import { useMessageStore } from "@/core/state/messageStore";
import { useUiPrefs } from "@/core/state/uiPrefs";
import { findById } from "@/core/schema/traversal";
import { ComponentType, type AnyComponent } from "@/core/schema/types";
import { TextDisplayInspector } from "./inspectors/TextDisplayInspector";
import { ContainerInspector } from "./inspectors/ContainerInspector";
import { SectionInspector } from "./inspectors/SectionInspector";
import { SeparatorInspector } from "./inspectors/SeparatorInspector";
import { MediaGalleryInspector } from "./inspectors/MediaGalleryInspector";
import { FileInspector } from "./inspectors/FileInspector";
import { ButtonInspector } from "./inspectors/ButtonInspector";
import { ThumbnailInspector } from "./inspectors/ThumbnailInspector";
import { ActionRowInspector } from "./inspectors/ActionRowInspector";
import { StringSelectInspector } from "./inspectors/StringSelectInspector";
import { UserSelectInspector } from "./inspectors/UserSelectInspector";
import { RoleSelectInspector } from "./inspectors/RoleSelectInspector";
import { MentionableSelectInspector } from "./inspectors/MentionableSelectInspector";
import { ChannelSelectInspector } from "./inspectors/ChannelSelectInspector";
import { ComponentIdField } from "./inspectors/ComponentIdField";
import styles from "./Inspector.module.css";

export function Inspector() {
  const selectedId = useMessageStore((s) => s.selectedId);
  const message = useMessageStore((s) => s.message);
  const advancedMode = useUiPrefs((s) => s.advancedMode);

  const location = selectedId ? findById(message, selectedId) : null;
  const node = location?.node;

  if (!node) {
    return (
      <div className={styles.inspector}>
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No selection</p>
          <p className={styles.emptySub}>
            Pick a component from the tree (or the preview) to edit its fields.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.inspector}>
      <div className={styles.body}>
        {renderInspector(node)}
        {/* The per-component Discord id is a power-user concern — only surface
            it in Advanced mode. The value (if any) persists regardless. */}
        {advancedMode ? <ComponentIdField node={node} /> : null}
      </div>
    </div>
  );
}

function renderInspector(node: AnyComponent) {
  switch (node.type) {
    case ComponentType.TextDisplay:
      return <TextDisplayInspector node={node} />;
    case ComponentType.Container:
      return <ContainerInspector node={node} />;
    case ComponentType.Section:
      return <SectionInspector node={node} />;
    case ComponentType.Separator:
      return <SeparatorInspector node={node} />;
    case ComponentType.MediaGallery:
      return <MediaGalleryInspector node={node} />;
    case ComponentType.File:
      return <FileInspector node={node} />;
    case ComponentType.Button:
      return <ButtonInspector node={node} />;
    case ComponentType.Thumbnail:
      return <ThumbnailInspector node={node} />;
    case ComponentType.ActionRow:
      return <ActionRowInspector node={node} />;
    case ComponentType.StringSelect:
      return <StringSelectInspector node={node} />;
    case ComponentType.UserSelect:
      return <UserSelectInspector node={node} />;
    case ComponentType.RoleSelect:
      return <RoleSelectInspector node={node} />;
    case ComponentType.MentionableSelect:
      return <MentionableSelectInspector node={node} />;
    case ComponentType.ChannelSelect:
      return <ChannelSelectInspector node={node} />;
    default:
      return (
        <p className={styles.notImplemented}>
          This component type isn't editable from the inspector yet.
        </p>
      );
  }
}
