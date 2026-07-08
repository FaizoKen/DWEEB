/**
 * Builder-shaped loading skeleton.
 *
 * Shown for the brief window after the SDK handshake resolves but before the
 * shared editor has settled: the collaboration room's in-progress draft is still
 * syncing in, and (on a server launch) the guild's roles/channels/emoji are still
 * loading. Rendering the live builder during that window flashes the wrong things
 * — the fresh-open default message before the room's draft lands, a channel picker
 * with no channel name, a preview with unresolved mentions — so instead we hold
 * this calm placeholder until it's all in place (see `ActivityApp`'s reveal gate).
 *
 * It reuses the shell layout classes (`ActivityApp.module.css`) so the swap to the
 * real builder is a cross-fade of content within an identical frame, not a jump:
 * same two-pane grid, same bar height, same safe-area insets.
 */

import shell from "./ActivityApp.module.css";
import styles from "./BuilderSkeleton.module.css";
import type { ActivityPlatform } from "@/core/activity/activityStore";

export function BuilderSkeleton({
  platform,
  showPreview,
}: {
  platform: ActivityPlatform | null;
  /** Render the preview column. False in the mobile-sheet layout, where the
   *  preview is an off-screen bottom sheet and only the editor is on screen. */
  showPreview: boolean;
}) {
  return (
    <div className={shell.app} data-platform={platform ?? undefined}>
      {/* One polite live-region announcement for assistive tech; the shimmering
          blocks themselves are decorative. */}
      <span role="status" className={styles.srOnly}>
        Loading your workspace…
      </span>

      <div className={shell.panes} aria-hidden="true">
        <section className={shell.editor}>
          {/* Bar: destination cluster on the left, actions + primary on the right,
              mirroring ActivityBar's shape so nothing shifts on reveal. */}
          <div className={styles.bar}>
            <div className={styles.barSide}>
              <span className={styles.glyph} />
              <span className={styles.pill} style={{ width: 120 }} />
            </div>
            <div className={styles.barSide}>
              <span className={styles.iconBtn} />
              <span className={styles.iconBtn} />
              <span className={styles.primary} />
            </div>
          </div>

          {/* Tree: the meta header's two fields, then a handful of component rows,
              then the footer add-button. */}
          <div className={styles.tree}>
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
        </section>

        {showPreview ? (
          <section className={shell.preview}>
            <div className={styles.previewSurface}>
              <div className={styles.message}>
                <span className={styles.avatar} />
                <div className={styles.messageBody}>
                  <span className={styles.nameLine} />
                  <span className={styles.textLine} style={{ width: "88%" }} />
                  <span className={styles.textLine} style={{ width: "72%" }} />
                  <span className={styles.block} />
                  <span className={styles.textLine} style={{ width: "60%" }} />
                </div>
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

/** Varied row widths so the placeholder reads as a list of real components
 *  rather than a stack of identical bars. */
const ROW_WIDTHS = ["78%", "64%", "88%", "52%", "70%"];
