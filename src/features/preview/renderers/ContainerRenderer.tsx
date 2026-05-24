/**
 * Container: a vertical stack of children with a left accent stripe.
 *
 * The stripe color comes from `accent_color` (RGB int). Discord uses a
 * subtle background tint plus a 4px left border for the accent — we keep
 * that exact treatment for fidelity.
 */

import type { ContainerComponent } from "@/core/schema/types";
import { cn } from "@/lib/cn";
import { ComponentRenderer } from "./ComponentRenderer";
import styles from "./ContainerRenderer.module.css";

function rgbStyle(value: number | null | undefined): string | undefined {
  if (value == null) return undefined;
  return `#${(value & 0xffffff).toString(16).padStart(6, "0")}`;
}

export function ContainerRenderer({ node }: { node: ContainerComponent }) {
  const accent = rgbStyle(node.accent_color);
  return (
    <div
      className={cn(styles.container, node.spoiler && styles.spoiler)}
      style={accent ? { borderLeftColor: accent } : undefined}
    >
      <div className={styles.body}>
        {node.components.map((c) => (
          <ComponentRenderer key={c._id} node={c} />
        ))}
      </div>
    </div>
  );
}
