import type { ActionRowComponent } from "@/core/schema/types";
import { LIMITS } from "@/core/schema/limits";
import styles from "./inspectors.module.css";

interface Props {
  node: ActionRowComponent;
}

export function ActionRowInspector({ node }: Props) {
  return (
    <p className={styles.note}>
      Rows hold {node.components.length} of {LIMITS.ACTION_ROW_BUTTONS} buttons. Edit each button
      from the tree on the left.
    </p>
  );
}
