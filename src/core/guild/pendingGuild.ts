/**
 * The "connect to this server next" hint, in sessionStorage.
 *
 * Written when an intent names a specific guild before its data can be loaded:
 *  - returning from the bot-add OAuth flow (the just-added server), or
 *  - opening an "Edit in DWEEB" link for a message in that server.
 *
 * The AccountMenu's auto-connect effect consumes it once Discord login resolves:
 * it connects straight by id (authorization only needs that the user manages the
 * server), so a just-added server the picker hasn't caught up on still connects,
 * and a deep link can target the right server the moment the user is signed in.
 *
 * sessionStorage (not local) keeps it tab-scoped and self-cleaning, while still
 * surviving the page navigations a connect may wait on — most importantly a
 * sign-in redirect away to Discord and back in the same tab.
 */

import { isValidGuildId } from "./api";

const PENDING_GUILD_KEY = "dweeb.guild.pending";

export function loadPendingGuildId(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const id = sessionStorage.getItem(PENDING_GUILD_KEY);
    return id && isValidGuildId(id) ? id : null;
  } catch {
    return null;
  }
}

export function savePendingGuildId(id: string): void {
  if (typeof sessionStorage === "undefined") return;
  if (!isValidGuildId(id)) return;
  try {
    sessionStorage.setItem(PENDING_GUILD_KEY, id);
  } catch {
    // ignore
  }
}

export function clearPendingGuildId(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(PENDING_GUILD_KEY);
  } catch {
    // ignore
  }
}
