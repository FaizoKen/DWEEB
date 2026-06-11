/**
 * Boots the editor from a shared link exactly once on first mount.
 *
 * One link shape feeds the editor: `#s=<token>` — the whole message lives in
 * the URL hash and is decoded inline. (The old Cloudflare deployment also
 * served `/s/<id>` short links from server-side storage; that storage is gone
 * with the move to GitHub Pages, so those paths now just get an explanatory
 * toast.)
 *
 * We decode, replace the active message, and strip the link from the address
 * bar so subsequent edits don't look "off" relative to the URL. Failures show
 * a toast but never block the editor from opening.
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
import { readShortLinkId } from "@/core/serialization/shortlink";
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

    // Legacy short link: the server-side store behind `/s/<id>` is gone, so
    // explain rather than fail mysteriously, then clear the path so a reload
    // starts clean.
    if (readShortLinkId(window.location.pathname)) {
      pushToast(
        "Short links are no longer supported — ask the sender for the full share link.",
        "error",
      );
      stripShortLinkFromPath();
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
