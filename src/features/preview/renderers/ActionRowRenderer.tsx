import type { ActionRowComponent } from "@/core/schema/types";
import { ComponentRenderer } from "./ComponentRenderer";
import styles from "./ActionRowRenderer.module.css";

export function ActionRowRenderer({ node }: { node: ActionRowComponent }) {
  return (
    <div className={styles.row}>
      {node.components.map((btn) => (
        <ComponentRenderer key={btn._id} node={btn} />
      ))}
    </div>
  );
}
