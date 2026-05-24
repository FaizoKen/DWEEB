import { SeparatorSpacing, type SeparatorComponent } from "@/core/schema/types";
import { cn } from "@/lib/cn";
import styles from "./SeparatorRenderer.module.css";

export function SeparatorRenderer({ node }: { node: SeparatorComponent }) {
  const divider = node.divider !== false; // default true per Discord
  const large = node.spacing === SeparatorSpacing.Large;
  return (
    <div
      className={cn(styles.separator, large && styles.large, divider && styles.divider)}
      aria-hidden="true"
    />
  );
}
