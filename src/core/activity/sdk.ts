/**
 * Embedded App SDK wrapper.
 *
 * Owns the single `DiscordSDK` instance and the URL-mapping setup that lets a
 * sandboxed Activity iframe reach our proxy at all. Inside Discord every request
 * must go through the client's proxy, so `patchUrlMappings` rewrites the proxy's
 * absolute URLs (HTTP **and** WebSocket) to a same-origin `/.proxy/<prefix>/…`
 * path that Discord forwards to the real host. The matching prefix is configured
 * once in the Developer Portal's URL Mappings (see `docs/activity.md`).
 *
 * Only the Activity entry imports this module, so the SDK never weighs down the
 * web app's bundle.
 */

import { DiscordSDK, Common, Events, patchUrlMappings } from "@discord/embedded-app-sdk";
import { DISCORD_CLIENT_ID, PROXY_BASE_URL } from "@/core/guild/config";
import { PROXY_MAPPING_PREFIX } from "./runtime";

let sdk: DiscordSDK | null = null;

/** The lazily-created SDK instance (one per page). */
export function getSdk(): DiscordSDK {
  if (!sdk) sdk = new DiscordSDK(DISCORD_CLIENT_ID);
  return sdk;
}

/** Host of the configured proxy, used as the URL-mapping target. "" when unset. */
function proxyHost(): string {
  try {
    return new URL(PROXY_BASE_URL).host;
  } catch {
    return "";
  }
}

/**
 * Route every call to the proxy (the absolute `PROXY_BASE_URL`, over HTTP and
 * WebSocket) through Discord's sandbox proxy. Must run before the first proxy
 * request. No-op when no proxy is configured.
 */
export function configureUrlMappings(): void {
  const host = proxyHost();
  if (!host) return;
  patchUrlMappings([{ prefix: PROXY_MAPPING_PREFIX, target: host }], {
    patchFetch: true,
    patchWebSocket: true,
    patchXhr: true,
  });
}

/**
 * Open a discord.com (or any external) URL from inside the Activity. A sandboxed
 * `…discordsays.com` iframe can't navigate to discord.com itself, so the SDK
 * hands the link to the host client to open — used by "View message" after a post.
 */
export async function openExternalLink(url: string): Promise<void> {
  await getSdk().commands.openExternalLink({ url });
}

/**
 * Open Discord's invite dialog so the launcher can pull friends into this
 * Activity instance (they join the same collaboration room). Throws in a DM /
 * group-DM context or without the invite permission — callers should gate on a
 * server launch and treat a rejection as a no-op. DMs/group DMs use
 * {@link shareActivityLink} instead.
 */
export async function openInviteDialog(): Promise<void> {
  await getSdk().commands.openInviteDialog();
}

/** What the host reports back after the share modal closes. `success` is true
 *  when the link was actually handed to someone (sent or copied). */
export interface ShareLinkResult {
  success: boolean;
  didCopyLink: boolean;
  didSendMessage: boolean;
}

/**
 * Open Discord's "share the Activity link" modal — the universal counterpart to
 * {@link openInviteDialog} that also works in a DM / group DM (where the invite
 * dialog throws). The user can send the link to the current group DM / a friend
 * or copy it; opening it joins this same Activity instance, i.e. the same
 * collaboration room. `message` is the note sent alongside the link.
 */
export async function shareActivityLink(message: string): Promise<ShareLinkResult> {
  const r = await getSdk().commands.shareLink({ message });
  return {
    success: !!r?.success,
    didCopyLink: !!r?.didCopyLink,
    didSendMessage: !!r?.didSendMessage,
  };
}

/**
 * Set the user's rich presence so friends see "Building a message in DWEEB".
 * Best-effort: this command needs the `rpc.activities.write` scope, which we
 * deliberately don't request (a new scope would perturb the authorize handshake),
 * so callers should swallow a rejection — it lights up only if the scope is held.
 */
export async function setActivityPresence(details: string, state?: string): Promise<void> {
  await getSdk().commands.setActivity({
    activity: { type: 0, details, state, timestamps: { start: Date.now() } },
  });
}

/**
 * Discord's PIP (picture-in-picture) layout mode — the small floating window the
 * Activity collapses to when the user minimises it. The value the host reports to
 * {@link subscribeLayoutMode} equals this when minimised.
 */
export const LAYOUT_MODE_PIP: number = Common.LayoutModeTypeObject.PIP;

/**
 * Watch Discord's Activity layout mode and report every change. The host emits a
 * new mode as the user resizes the Activity between focused, picture-in-picture
 * (minimised — {@link LAYOUT_MODE_PIP}) and the multi-participant grid. Returns a
 * disposer that unsubscribes. Best-effort: a subscribe rejection (e.g. an older
 * client that never emits the event) is swallowed, so the surface simply stays in
 * its focused layout.
 */
export function subscribeLayoutMode(onMode: (mode: number) => void): () => void {
  const sdk = getSdk();
  const handler = (data: { layout_mode: number }) => onMode(data.layout_mode);
  void sdk.subscribe(Events.ACTIVITY_LAYOUT_MODE_UPDATE, handler).catch(() => {});
  return () => {
    void sdk.unsubscribe(Events.ACTIVITY_LAYOUT_MODE_UPDATE, handler).catch(() => {});
  };
}
