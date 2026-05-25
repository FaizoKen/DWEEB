/**
 * Section: a stack of TextDisplays on the left, a single accessory on the right.
 *
 * Discord places the accessory in a fixed-width column and lets the text
 * wrap to fill the remaining space. We mirror that layout with a CSS grid
 * so accessory height never deforms the text column.
 */

import { ComponentType, type SectionComponent } from "@/core/schema/types";
import { ComponentRenderer } from "./ComponentRenderer";
import styles from "./SectionRenderer.module.css";

export function SectionRenderer({ node }: { node: SectionComponent }) {
  const isButton = node.accessory.type === ComponentType.Button;
  return (
    <div className={isButton ? styles.sectionButton : styles.sectionThumbnail}>
      <div className={styles.text}>
        {node.components.map((t) => (
          <ComponentRenderer key={t._id} node={t} />
        ))}
      </div>
      <div className={styles.accessory}>
        <ComponentRenderer node={node.accessory} />
      </div>
    </div>
  );
}
