/**
 * Boots the editor from `#s=<token>` exactly once on first mount.
 *
 * If the URL carries a share token we decode it, replace the active message,
 * and strip the token so subsequent edits don't appear to be "off" relative
 * to the URL. Failures show a toast but never block the editor from opening.
 *
 * After the initial boot we don't watch the hash — share state is one-way:
 * URL → editor on open, editor → URL only on user request.
 */

import { useEffect, useRef } from "react";
// Import the token readers directly from `url` (pure string ops, no lz-string)
// so the compression/migration code stays out of the initial bundle. The
// decoder — which pulls in lz-string — is loaded on demand below, only when a
// share token is actually present.
import { clearShareTokenFromHash, readShareTokenFromHash } from "@/core/serialization/url";
import { useMessageStore } from "@/core/state/messageStore";
import { pushToast } from "@/ui/Toast";

export function useShareUrlBootstrap(): void {
  const replaceMessage = useMessageStore((s) => s.replaceMessage);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const token = readShareTokenFromHash(window.location.hash);
    if (!token) return;
    // Defer the decoder (and lz-string) until we know there's a token to decode.
    void import("@/core/serialization/encode").then(({ decodeShare }) => {
      const result = decodeShare(token);
      if (result.ok) {
        replaceMessage(result.message);
        clearShareTokenFromHash();
        pushToast("Loaded message from shared link.", "info");
      } else {
        pushToast(`Couldn't load shared link: ${result.error}`, "error");
      }
    });
  }, [replaceMessage]);
}
