/**
 * Builder pane — split into a tree panel (top) and an inspector panel (bottom).
 *
 * The pane intentionally renders the same tree shape Discord sees, mirrored
 * 1:1 with the preview. Selecting in either pane updates the same store
 * slice, so the two stay in sync without prop drilling.
 */

import { useState } from "react";
import { ComponentTree } from "./components/ComponentTree";
import { Inspector } from "./components/Inspector";
import { MessageMetaPanel } from "./components/MessageMetaPanel";
import styles from "./Builder.module.css";
import { cn } from "@/lib/cn";

type Tab = "tree" | "meta";

export function Builder() {
  const [tab, setTab] = useState<Tab>("tree");

  return (
    <div className={styles.builder}>
      <div className={styles.tabs} role="tablist">
        <button
          role="tab"
          aria-selected={tab === "tree"}
          className={cn(styles.tab, tab === "tree" && styles.tabActive)}
          onClick={() => setTab("tree")}
        >
          Components
        </button>
        <button
          role="tab"
          aria-selected={tab === "meta"}
          className={cn(styles.tab, tab === "meta" && styles.tabActive)}
          onClick={() => setTab("meta")}
        >
          Message
        </button>
      </div>

      <div className={styles.panels}>
        {tab === "tree" ? <ComponentTree /> : <MessageMetaPanel />}
        <Inspector />
      </div>
    </div>
  );
}
