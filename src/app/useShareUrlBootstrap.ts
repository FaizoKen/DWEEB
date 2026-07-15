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
 * In both cases we decode, load the message, and strip the link from the
 * address bar so subsequent edits don't look "off" relative to the URL.
 * Failures show a toast but never block the editor from opening.
 *
 * An "Edit in DWEEB" link carries two extra hints in the hash (see `url.ts`):
 * the message's edit origin (opened as an in-place-updatable restore when its
 * webhook is saved here) and the server it lives in (handed to the account
 * menu's auto-connect so the editor lines up with that guild's data).
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
  readShareGuildFromHash,
  readShareOriginFromHash,
  readShareTokenFromHash,
} from "@/core/serialization/url";
import {
  isShortLinkConfigured,
  readShortLinkId,
  resolveShortLink,
} from "@/core/serialization/shortlink";
import { loadHistory } from "@/core/webhook";
import { isProxyConfigured } from "@/core/guild/config";
import { savePendingGuildId } from "@/core/guild/pendingGuild";
import { useMessageStore } from "@/core/state/messageStore";
import { type WebhookMessage } from "@/core/schema";
import { pushToast } from "@/ui/Toast";

/** Replace `/s/<id>` in the address bar with `/` once it's been consumed. */
function stripShortLinkFromPath(): void {
  window.history.replaceState(null, "", window.location.origin + "/");
}

export function useShareUrlBootstrap(enabled = true, onSettled?: () => void): void {
  const replaceMessage = useMessageStore((s) => s.replaceMessage);
  const replaceMessageFromRestore = useMessageStore((s) => s.replaceMessageFromRestore);
  const setPendingEditOrigin = useMessageStore((s) => s.setPendingEditOrigin);
  const ran = useRef(false);

  useEffect(() => {
    if (!enabled || ran.current) return;
    ran.current = true;

    // An "Edit in DWEEB" link (either shape) carries the message's edit origin
    // and the server it lives in, both in the hash — read once, applied below.
    const origin = readShareOriginFromHash(window.location.hash);
    const guildId = readShareGuildFromHash(window.location.hash);

    // Park the message's server *now*, synchronously — not after the decode.
    // The `g=` id is in the hash and readable immediately (even for a short
    // link, whose token still needs a network fetch). The AccountMenu's
    // auto-connect consumes this the moment login resolves; parking it before
    // that round-trip guarantees an already-signed-in session connects to the
    // message's guild instead of racing ahead to the last-used one (which would
    // latch its one-shot guard and ignore the link's server, leaving the loaded
    // message's roles/channels/mentions unresolved). See `pendingGuild.ts`.
    if (guildId && isProxyConfigured()) savePendingGuildId(guildId);

    // Load a decoded message into the editor: as an in-place-updatable restore
    // when its webhook is saved here, else as a fresh draft (parking the origin
    // so Restore can finish the link), and line the editor up with its server.
    const applyDecoded = (message: WebhookMessage) => {
      if (origin) {
        // The webhook URL (with the token needed to PATCH) only lives in this
        // browser's saved webhooks. Skip entries a prior health check found
        // gone — restoring against a dead webhook would only fail at send time.
        const saved = loadHistory().find((e) => e.id === origin.webhookId && !e.deletedAt);
        if (saved) {
          replaceMessageFromRestore(message, {
            webhookUrl: saved.url,
            messageId: origin.messageId,
            threadId: origin.threadId,
          });
          pushToast("Loaded from Discord — edits will update the original in place.", "success");
        } else {
          replaceMessage(message);
          setPendingEditOrigin(origin);
          pushToast(
            "Loaded from Discord. To update the original in place, add its webhook under Restore.",
            "info",
          );
        }
      } else {
        replaceMessage(message);
        pushToast("Loaded message from shared link.", "info");
      }
      // The message's server was already parked synchronously above (before the
      // token fetch) so the account menu's auto-connect lines the editor up with
      // it regardless of whether the user was already signed in.
    };

    // Decode a share token and apply it; toast (and bail) on a bad token.
    const decodeAndApply = async (token: string): Promise<boolean> => {
      const { decodeShare } = await import("@/core/serialization/encode");
      const result = decodeShare(token);
      if (!result.ok) {
        pushToast(`Couldn't load shared link: ${result.error}`, "error");
        return false;
      }
      applyDecoded(result.message);
      return true;
    };

    // Short link first: resolve the token from the proxy, then decode it. The
    // origin/guild ride in the short URL's hash, so they're already read above.
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
        onSettled?.();
        return;
      }
      void (async () => {
        try {
          const resolved = await resolveShortLink(shortId);
          if (resolved.ok) {
            await decodeAndApply(resolved.token);
          } else {
            pushToast(`Couldn't load shared link: ${resolved.error}`, "error");
          }
          // Either way, clear the id (and any origin/guild hash) so a reload
          // starts clean.
          stripShortLinkFromPath();
        } finally {
          onSettled?.();
        }
      })();
      return;
    }

    // Hash link: the token is right here in the URL.
    const token = readShareTokenFromHash(window.location.hash);
    if (!token) {
      onSettled?.();
      return;
    }
    void decodeAndApply(token)
      .then((ok) => {
        if (ok) clearShareTokenFromHash();
      })
      .finally(() => onSettled?.());
  }, [enabled, onSettled, replaceMessage, replaceMessageFromRestore, setPendingEditOrigin]);
}
