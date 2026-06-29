/**
 * Shared avatar helpers for the Activity's presence UI — the bottom-right self
 * badge (your own avatar + connection status) and the top-bar roster of other
 * editors.
 *
 * A real Discord avatar loads natively inside the sandbox: `cdn.discordapp.com`
 * media is CSP-allowed in an Activity (see `docs/activity.md`). When a user has
 * no avatar — or the image fails to load — the caller falls back to a stable
 * colour + initial so the slot is never empty.
 */

/** Discord CDN URL for a user's avatar, or null when they have none (the caller
 *  then renders a coloured initial). Animated hashes (`a_…`) are served as gifs. */
export function userAvatarUrl(id: string, avatar: string | null, size = 64): string | null {
  if (!avatar) return null;
  const ext = avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${id}/${avatar}.${ext}?size=${size}`;
}

/** First letter of a name, upper-cased — the avatar fallback glyph. */
export function initial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

/** A stable, pleasant colour per user id (golden-angle hue around the wheel). */
export function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}deg 55% 45%)`;
}
