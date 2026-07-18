/**
 * Re-links a reopened draft to the message it was editing.
 *
 * The auto-saved draft persists a *non-credential* origin pointer (the Discord
 * message id + its home guild) when it's editing an already-posted message, but
 * not the webhook token — that lives in the server library's posted entry. On
 * boot this recovers the full restore origin through a narrow indexed lookup
 * of that message id, so the editor reopens with "Update
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
import { getMessageDocumentGeneration, useMessageStore } from "@/core/state/messageStore";
import { loadDraft } from "@/core/state/draftStorage";
import { fetchLibraryOrigin, isLibraryConfigured } from "@/core/library/api";
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
    // messageStore already re-hydrated the draft during module bootstrap. Read
    // only its small raw origin record here instead of attaching editor ids to
    // the full component tree a second time.
    const origin = loadDraft()?.origin;
    if (!origin?.guildId || useMessageStore.getState().restoredFrom) return;
    if (!isLibraryConfigured()) return;

    // Recover only this row's update credential. The indexed endpoint returns
    // no message payload, so boot doesn't decrypt/download the whole library.
    const { guildId, guildName, messageId } = origin;
    const documentGeneration = getMessageDocumentGeneration();
    void fetchLibraryOrigin(guildId, messageId).then((res) => {
      if (!res.ok) return;
      // Another source may have armed an origin while the fetch was in flight.
      if (useMessageStore.getState().restoredFrom) return;
      // Import, Clear, a template, or any other whole-message replacement may
      // have taken ownership while the indexed lookup was in flight. Never arm
      // that new document to PATCH the old draft's live Discord message.
      if (getMessageDocumentGeneration() !== documentGeneration) return;
      const recovered = {
        webhookUrl: res.origin.webhook_url,
        messageId: res.origin.message_id,
        threadId: res.origin.thread_id ?? undefined,
        guildId: res.origin.guild_id,
      };
      if (recovered) {
        // The library entry doesn't carry the guild's display name — keep the
        // draft's, so the origin-guild banner reads the same as before.
        useMessageStore.getState().setRestoreOrigin({ ...recovered, guildName });
      }
    });
  }, []);
}
