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
import {
  clearShareTokenFromHash,
  decodeShare,
  readShareTokenFromHash,
} from "@/core/serialization";
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
    const result = decodeShare(token);
    if (result.ok) {
      replaceMessage(result.message);
      clearShareTokenFromHash();
      pushToast("Loaded message from shared link.", "info");
    } else {
      pushToast(`Couldn't load shared link: ${result.error}`, "error");
    }
  }, [replaceMessage]);
}
