/**
 * Has this browser opened the Tools menu yet?
 *
 * The trigger carries a dot until it has. A label says the menu exists; the dot
 * says there's something in it worth a look, to people who have been walking
 * past it for months as well as to newcomers, without interrupting anyone: no
 * coach-mark, no toast, and it's gone after one click. The spots a new user can
 * be interrupted in are already taken (the Send coach-mark, the intro offer, the
 * rating card).
 *
 * `TOOLS_REVISION` relights the dot once for everyone. Bump it when a tool worth
 * a second look lands in the menu, not for a copy change.
 */

import { useCallback, useState } from "react";

const STORAGE_KEY = "dweeb.tools.seen.v1";

export const TOOLS_REVISION = 1;

/**
 * Whether the dot should show. A browser whose storage can't be read gets no
 * dot: nothing could ever record the click that clears it, so it would come back
 * on every load, nagging about a menu they may use daily.
 */
export function readToolsUnseen(): boolean {
  try {
    return Number(localStorage.getItem(STORAGE_KEY)) < TOOLS_REVISION;
  } catch {
    return false;
  }
}

export function recordToolsSeen(): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(TOOLS_REVISION));
  } catch {
    // Full or blocked: the dot still clears for this page.
  }
}

/** The dot's state, and the call that retires it. */
export function useToolsUnseen(): readonly [unseen: boolean, markSeen: () => void] {
  const [unseen, setUnseen] = useState(readToolsUnseen);
  const markSeen = useCallback(() => {
    setUnseen(false);
    recordToolsSeen();
  }, []);
  return [unseen, markSeen];
}
