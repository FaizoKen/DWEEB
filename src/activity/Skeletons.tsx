/**
 * Inline loading skeletons for the Activity's two data-backed regions.
 *
 * The chrome around them — the action bar, the two-pane frame — renders for real
 * the instant the handshake resolves, so the app *looks* loaded immediately.
 * Only the parts still waiting on data wear a skeleton: the component list until
 * the collab room's draft syncs in (otherwise it would flash the fresh-open
 * default, then swap), and the preview message until that draft *and* the guild's
 * mention/emoji data are ready (otherwise it renders with raw, unresolved
 * mentions). Each fills the exact box its real counterpart will, so the swap is a
 * content cross-fade, not a reflow.
 *
 * Blocks use the same soft opacity-breathe as the server-glyph / channel-name
 * skeletons, so the whole surface reads as one loading language.
 */

import styles from "./Skeletons.module.css";

/** Placeholder for the editor's component list (below the real action bar), held
 *  while the shared draft is still syncing in. Mirrors the tree's shape: the two
 *  webhook-identity fields, a run of component rows, and the pinned add button. */
export function TreeSkeleton() {
  return (
    <div className={styles.tree} aria-hidden="true">
      <span role="status" className={styles.srOnly}>
        Loading the message…
      </span>
      <div className={styles.meta}>
        <span className={styles.field} />
        <span className={styles.field} />
      </div>
      <div className={styles.rows}>
        {ROW_WIDTHS.map((w, i) => (
          <span key={i} className={styles.row} style={{ width: w }} />
        ))}
      </div>
      <span className={styles.addBtn} />
    </div>
  );
}

/** Placeholder for the preview message, held until the draft and the guild's
 *  resolve-data are both ready. Sits in the real preview pane (Discord canvas),
 *  echoing a single message: avatar, name line, a few text lines, a media block. */
export function PreviewSkeleton() {
  return (
    <div className={styles.previewSurface} aria-hidden="true">
      <span role="status" className={styles.srOnly}>
        Loading the preview…
      </span>
      <div className={styles.message}>
        <span className={styles.avatar} />
        <div className={styles.messageBody}>
          <span className={styles.nameLine} />
          <span className={styles.textLine} style={{ width: "86%" }} />
          <span className={styles.textLine} style={{ width: "72%" }} />
          <span className={styles.block} />
          <span className={styles.textLine} style={{ width: "58%" }} />
        </div>
      </div>
    </div>
  );
}

/** Varied row widths so the placeholder reads as a list of real components rather
 *  than a stack of identical bars. */
const ROW_WIDTHS = ["78%", "64%", "88%", "52%", "70%"];
