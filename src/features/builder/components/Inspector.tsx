/**
 * Inspector — edits the selected component's fields.
 *
 * Looks up the node by id on every render via `findById`. The lookup is O(n)
 * over the tree, which is bounded by Discord's 40-component cap, so this is
 * never a perf concern. Keeping the dispatch logic shallow makes it trivial
 * to add a new inspector for a new component type.
 */

import type { CSSProperties } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { useUiPrefs } from "@/core/state/uiPrefs";
import { findById } from "@/core/schema/traversal";
import { ComponentType, type AnyComponent } from "@/core/schema/types";
import { useNodeIssues } from "@/features/builder/useValidation";
import { useNodeEditors, type NodeEditor } from "@/core/activity/presence";
import { Avatar } from "@/activity/Avatar";
import { IssueList } from "./ValidationIssues";
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
import { PluginPanel } from "./inspectors/PluginPanel";
import { isPluginTarget } from "@/core/plugins/targets";
import styles from "./Inspector.module.css";

export function Inspector() {
  const selectedId = useMessageStore((s) => s.selectedId);
  const message = useMessageStore((s) => s.message);
  const advancedMode = useUiPrefs((s) => s.advancedMode);

  const location = selectedId ? findById(message, selectedId) : null;
  const node = location?.node;
  const issues = useNodeIssues(selectedId ?? "");
  // Other collaborators focused on the SAME node — a live warning that an edit
  // here may collide with theirs (sync is last-write-wins per node). Empty and
  // inert in the web app, so this costs nothing outside Discord.
  const editors = useNodeEditors(selectedId ?? "");

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
        <CollabEditingNotice editors={editors} />
        <IssueList issues={issues} />
        {/* Interactive components (buttons with a custom_id, selects) can hand
            their action to an external plugin. The action *is* the point of the
            component, so it leads — above the field editor. The bot/app-webhook
            requirement isn't repeated here: it's enforced (and explained) at the
            Send gate. Inert unless a plugin registry is configured. */}
        {isPluginTarget(node) ? <PluginPanel node={node} /> : null}
        {renderInspector(node)}
        {/* The per-component Discord id is a power-user concern — only surface
            it in Advanced mode. The value (if any) persists regardless. */}
        {advancedMode ? <ComponentIdField node={node} /> : null}
      </div>
    </div>
  );
}

/** How many collaborator avatars to show before collapsing to "+N". */
const MAX_COLLAB_AVATARS = 3;

/**
 * Live "someone else is in this block too" banner at the top of the inspector.
 *
 * The tree already rings a row when a teammate has it focused, but that cue is
 * out of sight while you're heads-down editing the fields here — which is exactly
 * where a last-write-wins collision happens. This surfaces the same per-node
 * presence right where the typing is, so the overwrite is something you saw
 * coming. Renders nothing when you're alone on the node (always so in the web
 * app, where the presence store stays empty), costing that surface nothing.
 */
function CollabEditingNotice({ editors }: { editors: NodeEditor[] }) {
  if (editors.length === 0) return null;
  const shown = editors.slice(0, MAX_COLLAB_AVATARS);
  const extra = editors.length - shown.length;
  const names = editors.map((e) => e.name);
  const who =
    names.length === 1
      ? `${names[0]} is`
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are`;
  const text = `${who} also editing this — only the last change is kept, so you may overwrite each other.`;
  return (
    <div className={styles.collab} role="status">
      <span className={styles.collabAvatars} aria-hidden="true">
        {shown.map((e) => (
          <span
            key={e.userId}
            className={styles.collabSlot}
            style={{ "--ring": e.color } as CSSProperties}
          >
            <Avatar id={e.userId} name={e.name} avatar={e.avatar} size={18} />
          </span>
        ))}
        {extra > 0 ? <span className={styles.collabMore}>+{extra}</span> : null}
      </span>
      <span className={styles.collabText}>{text}</span>
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
