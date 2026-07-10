/**
 * Applies a `?custom-bot=<guildId>` deep link on first load.
 *
 * The embedded Activity uses this handoff for the + action in its Post-as row.
 * Custom-bot settings require a web session, so the intent is kept through a
 * Discord login redirect, the named server is selected, and the account menu's
 * existing per-server CustomBotDialog is opened once authentication resolves.
 */

import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "@/core/auth/authStore";
import {
  readCustomBotParam,
  isValidCustomBotGuildId,
  withoutCustomBotParam,
} from "@/core/guild/customBotLink";
import { savePendingGuildId } from "@/core/guild/pendingGuild";

/** Survives a popup-blocked, full-page Discord login redirect. */
const PENDING_KEY = "dweeb.customBot.pendingGuild";

function stripCustomBotParam(): void {
  window.history.replaceState(null, "", withoutCustomBotParam(window.location.href));
}

export function useCustomBotDeepLink(onOpen: (guildId: string) => void): void {
  const status = useAuthStore((s) => s.status);
  const login = useAuthStore((s) => s.login);
  const [pending, setPending] = useState<string | null>(null);
  const captured = useRef(false);
  const loginStarted = useRef(false);

  useEffect(() => {
    if (captured.current) return;
    captured.current = true;

    let guild = readCustomBotParam(window.location.search);
    if (guild) {
      try {
        sessionStorage.setItem(PENDING_KEY, guild);
      } catch {
        /* in-memory state still covers a login popup */
      }
      // Startup guards also inspect this query. Leave it in place until every
      // mount effect from this render has had a chance to stand down.
      setTimeout(stripCustomBotParam, 0);
    } else {
      try {
        const stored = sessionStorage.getItem(PENDING_KEY);
        guild = isValidCustomBotGuildId(stored) ? stored : null;
      } catch {
        guild = null;
      }
    }

    if (guild) {
      // AccountMenu consumes this after auth and connects the same server, so
      // every other guild-scoped control agrees with the dialog being opened.
      savePendingGuildId(guild);
      setPending(guild);
    }
  }, []);

  useEffect(() => {
    if (!pending) return;
    if (status === "authed") {
      try {
        sessionStorage.removeItem(PENDING_KEY);
      } catch {
        /* ignore */
      }
      onOpen(pending);
      setPending(null);
    } else if (status === "anon" && !loginStarted.current) {
      loginStarted.current = true;
      login();
    }
  }, [pending, status, login, onOpen]);
}
