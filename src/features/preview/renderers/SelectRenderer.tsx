/**
 * Preview renderer for all five Components V2 select types.
 *
 * The preview is read-only (this app cannot drive interactions), so we render
 * each select as a Discord-styled "closed" dropdown showing the placeholder
 * or, when defaults are set, the selected values as inline pills — matching
 * what Discord itself shows for a closed select with pre-selected entries.
 */

import {
  ComponentType,
  type ChannelSelectComponent,
  type MentionableSelectComponent,
  type RoleSelectComponent,
  type SelectComponent,
  type StringSelectComponent,
  type UserSelectComponent,
} from "@/core/schema/types";
import { cn } from "@/lib/cn";
import styles from "./SelectRenderer.module.css";

interface Props {
  node: SelectComponent;
}

export function SelectRenderer({ node }: Props) {
  const selections = collectSelections(node);
  const placeholder = node.placeholder?.trim() || "Make a selection";

  return (
    <div className={cn(styles.select, node.disabled && styles.disabled)}>
      <div className={styles.body}>
        {selections.length === 0 ? (
          <span className={styles.placeholder}>{placeholder}</span>
        ) : (
          <div className={styles.pills}>
            {selections.map((s, i) => (
              <span key={i} className={styles.pill}>{s}</span>
            ))}
          </div>
        )}
      </div>
      <svg
        className={styles.chevron}
        aria-hidden="true"
        viewBox="0 0 24 24"
        width="20"
        height="20"
      >
        <path
          d="M6 9l6 6 6-6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function collectSelections(node: SelectComponent): string[] {
  if (node.type === ComponentType.StringSelect) {
    return node.options.filter((o) => o.default).map((o) => o.label);
  }
  const dvs = (node as Exclude<SelectComponent, StringSelectComponent>).default_values;
  if (!dvs || dvs.length === 0) return [];
  return dvs.map((dv) => formatDefault(node, dv));
}

function formatDefault(
  node: SelectComponent,
  dv: { id: string; type: "user" | "role" | "channel" },
): string {
  const prefix = symbolForDefault(node, dv);
  return `${prefix}${dv.id.slice(-6)}`;
}

function symbolForDefault(
  node: SelectComponent,
  dv: { id: string; type: "user" | "role" | "channel" },
): string {
  if (node.type === ComponentType.UserSelect) return "@";
  if (node.type === ComponentType.RoleSelect) return "@&";
  if (node.type === ComponentType.ChannelSelect) return "#";
  if (node.type === ComponentType.MentionableSelect) return dv.type === "role" ? "@&" : "@";
  return "";
}

export type { ChannelSelectComponent, MentionableSelectComponent, RoleSelectComponent, UserSelectComponent };
