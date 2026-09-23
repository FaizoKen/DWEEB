/**
 * Telling "you're signed out" apart from "we couldn't ask".
 *
 * `GET /auth/me` answers 200 (signed in) or 401 (not). Anything else says
 * nothing about the session: the request never completed (the proxy's client
 * maps a failed fetch to status 0), it timed out, it was rate limited, or the
 * proxy — or Caddy in front of it during a restart — failed. Treating those as
 * a sign-out cleared the connected server and every account-scoped store on a
 * network blip, with no message; the auth store now keeps what it had and
 * retries instead. A 401, a 403, and anything unrecognised still end the
 * session exactly as before.
 */

/** True for a failure that says nothing about the session itself. */
export function isTransientSessionError(error: unknown): boolean {
  const status =
    typeof error === "object" && error !== null && "status" in error ? error.status : null;
  if (typeof status !== "number") return false;
  return status === 0 || status === 408 || status === 429 || (status >= 500 && status < 600);
}

/** Timed retries stop after this many (about two minutes in all); coming back
 *  online or back to the tab still re-checks after that. */
export const MAX_TIMED_SESSION_RETRIES = 6;

/** Delay before timed retry `attempt` (0-based): 2 s, doubling, capped at 60 s. */
export function sessionRetryDelayMs(attempt: number): number {
  return Math.min(2_000 * 2 ** attempt, 60_000);
}
