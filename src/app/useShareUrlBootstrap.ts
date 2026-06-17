/**
 * Boots the editor from a shared link exactly once on first mount.
 *
 * Two link shapes feed the editor:
 *  - `#s=<token>` — the whole message lives in the URL hash. Decoded inline.
 *  - `/s/<id>`    — an opt-in short link; the token is fetched from the DWEEB
 *                   proxy (which auto-deletes it after 7 days), then decoded
 *                   the same way. GitHub Pages serves the SPA shell for the
 *                   path via the 404.html fallback, and an inline script in
 *                   `index.html` starts the token fetch before this code even
 *                   loads (see `shortlink.ts`), so resolution costs no extra
 *                   round trip after boot.
 *
 * In both cases we decode, replace the active message, and strip the link from
 * the address bar so subsequent edits don't look "off" relative to the URL.
 * Failures show a toast but never block the editor from opening.
 *
 * After the initial boot we don't watch the URL — share state is one-way:
 * URL → editor on open, editor → URL only on user request.
 */

import { useEffect, useRef } from "react";
// Import the token readers directly (pure string ops, no lz-string) so the
// compression/migration code stays out of the initial bundle. The decoder —
// which pulls in lz-string — is loaded on demand below, only when a share link
// is actually present.
import {
  clearShareTokenFromHash,
  readShareOriginFromHash,
  readShareTokenFromHash,
} from "@/core/serialization/url";
import {
  isShortLinkConfigured,
  readShortLinkId,
  resolveShortLink,
} from "@/core/serialization/shortlink";
import { loadHistory } from "@/core/webhook";
import { useMessageStore } from "@/core/state/messageStore";
import { pushToast } from "@/ui/Toast";

type ReplaceMessage = ReturnType<typeof useMessageStore.getState>["replaceMessage"];

/** Decode a token and either load it into the editor or toast the failure. */
async function applyToken(token: string, replaceMessage: ReplaceMessage): Promise<boolean> {
  const { decodeShare } = await import("@/core/serialization/encode");
  const result = decodeShare(token);
  if (result.ok) {
    replaceMessage(result.message);
    pushToast("Loaded message from shared link.", "info");
    return true;
  }
  pushToast(`Couldn't load shared link: ${result.error}`, "error");
  return false;
}

/** Replace `/s/<id>` in the address bar with `/` once it's been consumed. */
function stripShortLinkFromPath(): void {
  window.history.replaceState(null, "", window.location.origin + "/");
}

export function useShareUrlBootstrap(): void {
  const replaceMessage = useMessageStore((s) => s.replaceMessage);
  const replaceMessageFromRestore = useMessageStore((s) => s.replaceMessageFromRestore);
  const setPendingEditOrigin = useMessageStore((s) => s.setPendingEditOrigin);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    // Short link first: resolve the token from the server, then decode it.
    const shortId = readShortLinkId(window.location.pathname);
    if (shortId) {
      if (!isShortLinkConfigured()) {
        // A build without a proxy can't resolve `/s/<id>` — explain rather
        // than fail mysteriously.
        pushToast(
          "Short links aren't supported on this deployment — ask the sender for the full share link.",
          "error",
        );
        stripShortLinkFromPath();
        return;
      }
      void (async () => {
        const resolved = await resolveShortLink(shortId);
        if (resolved.ok) {
          await applyToken(resolved.token, replaceMessage);
        } else {
          pushToast(`Couldn't load shared link: ${resolved.error}`, "error");
        }
        // Either way, clear the id from the URL so a reload starts clean.
        stripShortLinkFromPath();
      })();
      return;
    }

    // Hash link: the token is right here in the URL. An "Edit in DWEEB" link
    // also carries the message's origin so the editor can update it in place.
    const token = readShareTokenFromHash(window.location.hash);
    if (!token) return;
    const origin = readShareOriginFromHash(window.location.hash);
    if (!origin) {
      // Plain share link — load the content, nothing to update.
      void applyToken(token, replaceMessage).then((ok) => {
        if (ok) clearShareTokenFromHash();
      });
      return;
    }
    void (async () => {
      const { decodeShare } = await import("@/core/serialization/encode");
      const result = decodeShare(token);
      if (!result.ok) {
        pushToast(`Couldn't load shared link: ${result.error}`, "error");
        return; // Leave the token in the URL so a reload can retry.
      }
      // The link names the message's webhook. If this browser has that webhook
      // saved (its URL holds the token needed to PATCH), open the message as a
      // restore so edits update the original in place. Skip entries a prior
      // health check found gone — restoring against a dead webhook would only
      // fail at send time.
      const saved = loadHistory().find((e) => e.id === origin.webhookId && !e.deletedAt);
      if (saved) {
        replaceMessageFromRestore(result.message, {
          webhookUrl: saved.url,
          messageId: origin.messageId,
          threadId: origin.threadId,
        });
        pushToast("Loaded from Discord — edits will update the original in place.", "success");
      } else {
        // No saved webhook → only the user holds its URL. Load the content and
        // stash the origin so that when the user opens the Restore panel, the
        // message id + thread are already prefilled and they need only add the
        // webhook that posted it.
        replaceMessage(result.message);
        setPendingEditOrigin(origin);
        pushToast(
          "Loaded from Discord. To update the original in place, add its webhook under Restore.",
          "info",
        );
      }
      clearShareTokenFromHash();
    })();
  }, [replaceMessage, replaceMessageFromRestore, setPendingEditOrigin]);
}
