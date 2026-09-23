import { isSelectRow } from "@/core/schema/guards";
import type { ActionRowComponent } from "@/core/schema/types";
import { LIMITS } from "@/core/schema/limits";
import styles from "./inspectors.module.css";

interface Props {
  node: ActionRowComponent;
}

export function ActionRowInspector({ node }: Props) {
  if (isSelectRow(node)) {
    return (
      <p className={styles.note}>
        This row holds a menu. Edit it from its own row just below this one.
      </p>
    );
  }
  return (
    <p className={styles.note}>
      This row holds {node.components.length} of {LIMITS.ACTION_ROW_BUTTONS} buttons. Edit each
      button from its own row just below this one.
    </p>
  );
}
