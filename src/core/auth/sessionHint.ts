/**
 * "Was this browser signed in the last time it checked?" — a hint, never proof.
 *
 * The auth store sets it whenever `/auth/me` confirms a session and clears it
 * whenever a session ends (sign-out, a 401), so it answers the one question the
 * store can't before its first check lands: is whoever is looking probably
 * signed in? Two readers need that answer without asking the proxy — the
 * landing Message directory, which opens before anything checks the session and
 * picks its signed-out copy from this, and the store itself, which retries a
 * check that couldn't reach the proxy only when there's a session to recover.
 * Nothing may treat it as authorization: it steers copy and retries, and the
 * proxy still decides every request.
 *
 * Throw-safe like every other small storage read here (`getItem` itself throws
 * when site data is blocked); unreadable reads as "no".
 */

const STORAGE_KEY = "dweeb.auth.hadSession.v1";

export function readSessionHint(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSessionHint(signedIn: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (signedIn) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage disabled or full — the hint only steers copy and retries.
  }
}
