/**
 * What a failed "Create link" tells the user — always ending in something to
 * try. The proxy's own wording already does for a missing bot permission, a
 * server the user doesn't manage, and a rate limit, so those pass through; the
 * rest get the step that usually fixes them. (A 401 never reaches this: an
 * expired session signs out app-wide and the dialog swaps to its sign-in view.)
 */

import { GuildApiError } from "@/core/guild/api";

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function inviteErrorMessage(error: unknown): string {
  if (!(error instanceof GuildApiError) || !error.message.trim()) {
    return "Couldn’t create a collaboration link. Check your connection, then try again.";
  }
  const { status, message } = error;
  // The channel is gone, or Discord won't make an invite there: another one will.
  if (status === 400 || status === 404) return `${sentence(message)} Try a different channel.`;
  // Discord's side, or ours, having a moment — nothing the user did.
  if (status >= 500) return `${sentence(message)} Try again in a moment.`;
  return sentence(message);
}
