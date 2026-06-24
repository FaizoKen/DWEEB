/**
 * Re-links a reopened draft to the message it was editing.
 *
 * The auto-saved draft persists a *non-credential* origin pointer (the Discord
 * message id + its home guild) when it's editing an already-posted message, but
 * not the webhook token — that lives in the posted-messages store. On boot this
 * recovers the full restore origin by matching the message id, so the editor
 * reopens with "Update existing" armed and the origin-guild banner showing,
 * exactly as it was before the tab closed.
 *
 * It stands down whenever another source owns the editor on open — a share /
 * short link being decoded, or a `?template=` deep link — since those replace
 * the message (and its origin) themselves. It also never clobbers an origin
 * that's already set.
 */

import { useEffect, useRef } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { loadDraftMessage } from "@/core/state/draftStorage";
import { recordOrigin, usePostedMessagesStore } from "@/core/state/postedMessagesStore";
import { readShareTokenFromHash } from "@/core/serialization/url";
import { readShortLinkId } from "@/core/serialization/shortlink";
import { readTemplateParam } from "./useTemplateDeepLink";

export function useDraftOriginBootstrap(): void {
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    // A share/short link or template deep link replaces the editor on open and
    // owns its own origin — leave the draft's behind.
    if (readShareTokenFromHash(window.location.hash) || readShortLinkId(window.location.pathname)) {
      return;
    }
    if (readTemplateParam(window.location.search)) return;

    // Nothing to do unless the draft pointed at a posted message and no origin
    // has been set since (e.g. by a webhook redirect).
    const origin = loadDraftMessage()?.origin;
    if (!origin || useMessageStore.getState().restoredFrom) return;

    // Recover the webhook token from the posted-messages store. If the record is
    // gone (the user deleted that card), we can't PATCH it, so leave the editor
    // as a plain draft rather than half-arming an update.
    const record = usePostedMessagesStore
      .getState()
      .entries.find((e) => e.messageId === origin.messageId);
    if (record) useMessageStore.getState().setRestoreOrigin(recordOrigin(record));
  }, []);
}
