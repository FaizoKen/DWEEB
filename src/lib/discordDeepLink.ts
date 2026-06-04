/**
 * Open a Discord channel/message link, preferring the installed app.
 *
 * The difference between platforms matters:
 *
 *  - **Mobile (iOS/Android):** the OS routes an `https://discord.com/channels/…`
 *    link to the installed app via universal / app links (or opens the browser
 *    when it isn't installed). So the plain web link already does the right
 *    thing — a `discord://` attempt would only risk an error.
 *  - **Desktop:** browsers do *not* hand `discord.com` links to the desktop app.
 *    The only way in is the `discord://` custom scheme. If no app is registered
 *    we have to fall back to opening the web link instead.
 *
 * There is no reliable API to ask whether a custom-scheme handler exists, so the
 * desktop path is necessarily a best-effort race: launch the scheme, then watch
 * for the page losing focus/visibility (which a launching app causes). If that
 * doesn't happen within a short grace period we assume no app and open the web
 * link. This is the same technique Slack/Zoom/GitHub "open in app" buttons use.
 */

/** Matches the web links this app builds (always plain `discord.com`, no query). */
const DISCORD_CHANNEL_URL_RE = /^https:\/\/(?:canary\.|ptb\.)?discord\.com\/(channels\/[^?#]+)$/i;

/**
 * Turn an `https://discord.com/channels/…` link into its `discord://-/channels/…`
 * desktop-app equivalent. The `-` is Discord's placeholder host. Returns null for
 * anything that isn't a channel/message link, so callers know to just use the web
 * URL.
 */
export function discordAppUrl(webUrl: string): string | null {
  const m = DISCORD_CHANNEL_URL_RE.exec(webUrl);
  return m ? `discord://-/${m[1]}` : null;
}

/** Whether this looks like a mobile OS, where https links are app links. */
function isMobileOs(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // iPadOS 13+ reports a desktop "Macintosh" UA, so sniff its touch support.
  const iPadOs = /Macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
  return /Android|iPhone|iPad|iPod/i.test(ua) || iPadOs;
}

/**
 * Open a URL in a new tab, severing the opener for safety. If the popup is
 * blocked (can happen on the async desktop-fallback path in stricter browsers),
 * navigate the current tab instead so the link still opens.
 *
 * Note: we can't pass `noopener` in the features string and still detect a
 * blocked popup — `window.open` returns null with `noopener` even on success.
 * So we open normally and null the opener ourselves.
 */
function openWeb(webUrl: string): void {
  const win = window.open(webUrl, "_blank");
  if (!win) {
    // Popup blocked (can happen on the async desktop-fallback path in stricter
    // browsers like Safari) — navigate the current tab so the link still opens.
    window.location.href = webUrl;
    return;
  }
  // Best-effort opener severing (reverse-tabnabbing). A cross-origin write may
  // be rejected; that's fine — discord.com is a trusted destination.
  try {
    win.opener = null;
  } catch {
    /* ignore */
  }
}

/** A plain-left-click vs. modified-click discriminator — structurally matches a
 *  React `MouseEvent`, so callers can pass the synthetic event directly without
 *  this util depending on React. */
interface LinkClick {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  preventDefault: () => void;
}

/**
 * `onClick` for an `<a href={webUrl}>` that should open the Discord app on a
 * plain left-click, while leaving modified clicks (cmd/ctrl/shift/alt, or a
 * non-primary button) to the browser's native "open in new tab/window".
 *
 * Keep the real `href={webUrl}` on the anchor: middle-click, right-click "open
 * in new tab", "copy link", and the no-JS path all keep working, and this only
 * upgrades the common case.
 */
export function handleDiscordLinkClick(e: LinkClick, webUrl: string): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
    return;
  }
  e.preventDefault();
  openDiscordLink(webUrl);
}

/**
 * Open a Discord link, using the desktop app when one is installed.
 *
 * Always safe to call from a click handler. On mobile (or for a non-channel URL)
 * it just opens the web link; on desktop it tries the app and falls back to the
 * web link if nothing takes over.
 */
export function openDiscordLink(webUrl: string): void {
  const appUrl = discordAppUrl(webUrl);

  // Mobile, or a link we can't deep-link: the web URL is already the right call.
  if (!appUrl || isMobileOs()) {
    openWeb(webUrl);
    return;
  }

  // Desktop: race the app launch against a web fallback.
  let handedOff = false;
  const onBlur = () => {
    handedOff = true;
  };
  const onVisibility = () => {
    if (document.hidden) handedOff = true;
  };
  window.addEventListener("blur", onBlur, { once: true });
  document.addEventListener("visibilitychange", onVisibility);

  const cleanup = () => {
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibility);
  };

  // Launch the custom scheme. A registered handler opens the app *without*
  // unloading the page; an unregistered one is ignored (Chromium) or prompts
  // (Firefox). Assigning `location` is the most broadly-supported trigger —
  // iframes are blocked from launching external schemes in modern browsers.
  try {
    window.location.href = appUrl;
  } catch {
    // A few browsers throw outright on an unknown scheme — go straight to web.
    cleanup();
    openWeb(webUrl);
    return;
  }

  // If the app grabbed focus the page is now blurred/hidden — leave it be.
  // Otherwise no handler took it, so open the web link. The delay sits well
  // inside the browser's transient-activation window, so the fallback isn't
  // treated as an unsolicited popup.
  window.setTimeout(() => {
    cleanup();
    if (!handedOff && document.hasFocus()) openWeb(webUrl);
  }, 800);
}
