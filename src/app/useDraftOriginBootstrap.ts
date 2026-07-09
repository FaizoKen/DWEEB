/**
 * Re-links a reopened draft to the message it was editing.
 *
 * The auto-saved draft persists a *non-credential* origin pointer (the Discord
 * message id + its home guild) when it's editing an already-posted message, but
 * not the webhook token — that lives in the server library's posted entry. On
 * boot this recovers the full restore origin by fetching the home server's
 * library and matching the message id, so the editor reopens with "Update
 * existing" armed and the origin-guild banner showing, exactly as it was before
 * the tab closed. When the library can't answer (signed out, no Manage
 * Webhooks, or the entry rolled off the posted history), the editor reopens as
 * a plain draft rather than half-arming an update.
 *
 * It stands down whenever another source owns the editor on open — a share /
 * short link being decoded, or a `?template=` deep link — since those replace
 * the message (and its origin) themselves. It also never clobbers an origin
 * that's already set.
 */

import { useEffect, useRef } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { loadDraftMessage } from "@/core/state/draftStorage";
import { isLibraryConfigured, listLibrary } from "@/core/library/api";
import { libraryEntryOrigin } from "@/core/library/libraryStore";
import { readShareTokenFromHash } from "@/core/serialization/url";
import { readShortLinkId } from "@/core/serialization/shortlink";
import { readTemplateParam } from "./useTemplateDeepLink";

export function useDraftOriginBootstrap(): void {
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    // Posted messages used to be mirrored into localStorage; they now live
    // solely in the server library. Clear the legacy key old builds left behind.
    try {
      localStorage.removeItem("dweeb.posted.v1");
    } catch {
      // Storage disabled — nothing to clean.
    }

    // A share/short link or template deep link replaces the editor on open and
    // owns its own origin — leave the draft's behind.
    if (readShareTokenFromHash(window.location.hash) || readShortLinkId(window.location.pathname)) {
      return;
    }
    if (readTemplateParam(window.location.search)) return;

    // Nothing to do unless the draft pointed at a posted message and no origin
    // has been set since (e.g. by a webhook redirect). The guild id is required
    // — it names which server's library holds the webhook URL.
    const origin = loadDraftMessage()?.origin;
    if (!origin?.guildId || useMessageStore.getState().restoredFrom) return;
    if (!isLibraryConfigured()) return;

    // Recover the webhook URL from the home server's library, reading the API
    // directly (not the shared store) so this boot-time lookup can't fight the
    // gallery's own refresh over which guild the store shows.
    const { guildId, guildName, messageId } = origin;
    void listLibrary(guildId).then((res) => {
      if (!res.ok) return;
      // Another source may have armed an origin while the fetch was in flight.
      if (useMessageStore.getState().restoredFrom) return;
      const entry = res.items.find((e) => e.label === "posted" && e.message_id === messageId);
      const recovered = entry ? libraryEntryOrigin(entry) : null;
      if (recovered) {
        // The library entry doesn't carry the guild's display name — keep the
        // draft's, so the origin-guild banner reads the same as before.
        useMessageStore.getState().setRestoreOrigin({ ...recovered, guildName });
      }
    });
  }, []);
}
