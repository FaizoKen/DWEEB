import type { TextDisplayComponent } from "@/core/schema/types";
import { Markdown } from "../markdown/Markdown";
import styles from "./TextDisplayRenderer.module.css";

export function TextDisplayRenderer({ node }: { node: TextDisplayComponent }) {
  // Typed as text, but an imported payload isn't bound by the types — a
  // numeric `content` must preview as nothing rather than throw in the parser.
  const content: unknown = node.content;
  return (
    <div className={styles.text}>
      <Markdown source={typeof content === "string" ? content : ""} />
    </div>
  );
}
