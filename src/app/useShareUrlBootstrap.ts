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
import { clearShareTokenFromHash, readShareTokenFromHash } from "@/core/serialization/url";
import {
  isShortLinkConfigured,
  readShortLinkId,
  resolveShortLink,
} from "@/core/serialization/shortlink";
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

    // Hash link: the token is right here in the URL.
    const token = readShareTokenFromHash(window.location.hash);
    if (!token) return;
    void applyToken(token, replaceMessage).then((ok) => {
      if (ok) clearShareTokenFromHash();
    });
  }, [replaceMessage]);
}
