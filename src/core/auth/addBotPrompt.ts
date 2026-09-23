/**
 * One automatic "add the bot" prompt per account, per browser.
 *
 * A signed-in user whose servers don't have the DWEEB bot yet gets the account
 * popover opened for them, so "Add to another server" is front and centre. That
 * used to happen on every page load (the only guard was a per-mount ref), which
 * turned a one-time pointer into a popover to dismiss before every session. The
 * record is the user id, so a different account signing in on the same browser
 * still gets its own first prompt.
 *
 * Throw-safe: storage can be missing or blocked (`getItem` itself throws when
 * site data is blocked). The prompt is only claimed once the record reads back,
 * so an unwritable store means no automatic prompt rather than one on every
 * load — the chevron on the account control still leads to the same menu.
 */

const STORAGE_KEY = "dweeb.account.addBotPrompted.v1";

/** True exactly once per user in this browser: the caller may open the prompt. */
export function claimAddBotPrompt(userId: string): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    if (localStorage.getItem(STORAGE_KEY) === userId) return false;
    localStorage.setItem(STORAGE_KEY, userId);
    return localStorage.getItem(STORAGE_KEY) === userId;
  } catch {
    return false;
  }
}
