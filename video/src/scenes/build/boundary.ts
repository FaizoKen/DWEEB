import type { CampaignStage } from "../../story/campaign";
import { EDITOR_V } from "../contracts";

/**
 * The templates → build hold cut. Both scenes are written here, so the frame
 * on both sides is pinned in one place: the editor holding the STOCK
 * Announcement (its generic hero art — story/campaign.ts STOCK_ART), Undo lit (the
 * pick pushed the old message onto the history), no toast, no selection,
 * scrolls at 0, camera wide (EDITOR_WIDE_L / PORTRAIT_CAM) and static — and
 * in landscape the pointer resting beside the tree, where the templates scene
 * parked it after the pick and the build scene picks it up. (Portrait uses a
 * touch indicator, which only exists while a finger is down: none at the cut.)
 * Portrait: the builder sheet on the stock-bodied detent, which the build
 * keeps through cut B.
 */
export const TB = {
  stage: "stock" as CampaignStage,
  channel: null,
  canUndo: true,
  canRedo: false,
  sheetTop: EDITOR_V.sheetTop,
} as const;

/** Where the landscape pointer rests across the cut: empty tree pane, below the rows. */
export const TB_PARK_L = { x: 560, y: 690 } as const;
