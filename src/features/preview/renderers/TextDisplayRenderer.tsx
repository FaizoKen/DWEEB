import type { TextDisplayComponent } from "@/core/schema/types";
import { Markdown } from "../markdown/Markdown";
import styles from "./TextDisplayRenderer.module.css";

export function TextDisplayRenderer({ node }: { node: TextDisplayComponent }) {
  return (
    <div className={styles.text}>
      <Markdown source={node.content} />
    </div>
  );
}
