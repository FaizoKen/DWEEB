import type { ActionRowComponent } from "@/core/schema/types";
import { isSelect } from "@/core/schema/guards";
import { cn } from "@/lib/cn";
import { ComponentRenderer } from "./ComponentRenderer";
import styles from "./ActionRowRenderer.module.css";

export function ActionRowRenderer({ node }: { node: ActionRowComponent }) {
  // Rows hold either up to 5 buttons OR a single select. Selects grow to fill
  // the row but cap at 400px (Discord behavior); buttons stay content-sized.
  const children = node.components as ActionRowComponent["components"];
  const hasSelect = children.length === 1 && isSelect(children[0]);
  return (
    <div className={cn(styles.row, hasSelect && styles.rowSelect)}>
      {children.map((child) => (
        <ComponentRenderer key={child._id} node={child} />
      ))}
    </div>
  );
}
