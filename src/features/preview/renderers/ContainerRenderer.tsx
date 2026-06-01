/**
 * Container: a vertical stack of children with a left accent stripe.
 *
 * The stripe color comes from `accent_color` (RGB int). Discord uses a
 * subtle background tint plus a 4px left border for the accent — we keep
 * that exact treatment for fidelity.
 */

import type { ContainerComponent } from "@/core/schema/types";
import { useMessageStore } from "@/core/state/messageStore";
import { subtreeContainsId } from "@/core/schema/traversal";
import { cn } from "@/lib/cn";
import { ComponentRenderer } from "./ComponentRenderer";
import styles from "./ContainerRenderer.module.css";

function rgbStyle(value: number | null | undefined): string | undefined {
  if (value == null) return undefined;
  return `#${(value & 0xffffff).toString(16).padStart(6, "0")}`;
}

export function ContainerRenderer({ node }: { node: ContainerComponent }) {
  const accent = rgbStyle(node.accent_color);
  // Reveal follows the editor selection: a spoiler container stays revealed
  // while it (or anything inside it) is selected, and re-blurs once the
  // selection moves elsewhere. While obscured, the overlay below turns the
  // whole container into one click target — the click selects (reveals) the
  // container instead of activating a child behind the blur.
  const selectedId = useMessageStore((s) => s.selectedId);
  const obscured =
    node.spoiler === true && !(selectedId != null && subtreeContainsId(node, selectedId));
  return (
    <div
      className={cn(styles.container, obscured && styles.spoilered)}
      style={accent ? { borderLeftColor: accent } : undefined}
    >
      {/* The blur lives on the content (not the container) so the SPOILER pill —
          a sibling — stays crisp, mirroring Discord's obscured container. */}
      <div className={cn(styles.body, obscured && styles.spoilerBlur)}>
        {node.components.map((c) => (
          <ComponentRenderer key={c._id} node={c} />
        ))}
      </div>
      {obscured && (
        <>
          <div className={styles.spoilerOverlay} aria-hidden="true" />
          <span className={styles.spoilerPill} aria-hidden="true">
            Spoiler
          </span>
        </>
      )}
    </div>
  );
}
