/**
 * The concrete OAuth popup flows, built on the generic {@link PopupFlow} engine.
 *
 * Each descriptor says how to recognise its return in a URL and how to dedupe
 * its result; the engine in `popupFlow.ts` does everything else (open, relay,
 * deliver, full-page fallback). The thin `start…` wrappers below are what UI
 * click handlers call — open a popup synchronously, point it at Discord, and
 * fall back to a full-page redirect only if the popup is blocked.
 */

import {
  navigatePopup,
  openPopup,
  redirectFullPage,
  watchPopup,
  type PopupFlow,
} from "./popupFlow";
import { botInviteUrl, loginUrl, type IncomingWebhookResult } from "@/core/guild/config";

/* ── webhook.incoming (DWEEB's own app, or a server's custom bot) ────────── */

/** Result of a Discord login round-trip. The session is a cookie set during the
 *  callback (origin-global), so the opener only needs the "it finished" signal —
 *  not a payload. */
export type LoginResult = { ok: true } | { error: true };

/** Result of adding the DWEEB bot to a server — Discord returns the chosen
 *  guild id in the query of the redirect back to our origin. */
export type BotAddResult = { guildId: string } | { error: true };

/** Discord snowflake shape, used to sanity-check the returned guild id. */
const SNOWFLAKE_RE = /^\d{15,25}$/;

/**
 * `webhook.incoming`: the proxy hands the created webhook's execute URL back in
 * the fragment (`#dweeb_webhook=<url>&channel=&guild=`); the names are
 * best-effort labels. The `kind` derives the exact storage keys the webhook flow
 * has always used, so its behaviour is unchanged by living on the shared engine.
 */
export const webhookFlow: PopupFlow<IncomingWebhookResult> = {
  kind: "webhook",
  parse({ hash }) {
    if (!hash || !hash.includes("dweeb_webhook")) return null;
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const raw = params.get("dweeb_webhook");
    if (raw === null) return null;
    if (raw === "error" || raw === "") return { error: true };
    return {
      url: raw,
      channelName: params.get("channel") || undefined,
      guildName: params.get("guild") || undefined,
    };
  },
  isError: (r) => "error" in r,
  successKey: (r) => ("error" in r ? "" : r.url),
  stripHashKeys: ["dweeb_webhook", "channel", "guild"],
  doneMessage: "Webhook created — you can close this window.",
};

/**
 * Discord login: the proxy callback redirects back with `#dweeb_login=ok` (or
 * `=error` on cancel / no-interaction). See `server/src/auth.rs`.
 */
export const loginFlow: PopupFlow<LoginResult> = {
  kind: "login",
  parse({ hash }) {
    if (!hash || !hash.includes("dweeb_login")) return null;
    const raw = new URLSearchParams(hash.replace(/^#/, "")).get("dweeb_login");
    if (raw === null) return null;
    return raw === "ok" ? { ok: true } : { error: true };
  },
  isError: (r) => "error" in r,
  successKey: () => "login",
  stripHashKeys: ["dweeb_login"],
  doneMessage: "Signed in — you can close this window.",
};

/**
 * Adding the DWEEB bot: Discord redirects back to our SPA origin with the chosen
 * server in the query (`?guild_id=…&code=…`), or `?error=` if the user cancels.
 * There's no server callback for this — the app reads the guild id directly.
 */
export const botAddFlow: PopupFlow<BotAddResult> = {
  kind: "botadd",
  parse({ search }) {
    if (!search) return null;
    const params = new URLSearchParams(search);
    if (params.get("error")) return { error: true };
    const gid = params.get("guild_id");
    return gid && SNOWFLAKE_RE.test(gid) ? { guildId: gid } : null;
  },
  isError: (r) => "error" in r,
  successKey: (r) => ("error" in r ? "" : r.guildId),
  stripSearchKeys: ["code", "guild_id", "permissions", "scope", "state", "error"],
  doneMessage: "Bot added — you can close this window.",
};

/* ── click-handler wrappers ─────────────────────────────────────────────── */

/**
 * Begin Discord login in a popup so the in-progress message survives. Only a
 * blocked popup falls back to a full-page redirect (handled in place on return).
 */
export function startLoginPopup(): void {
  const url = loginUrl();
  if (!url) return;
  const popup = openPopup(loginFlow);
  if (popup) {
    navigatePopup(popup, url);
    watchPopup(loginFlow, popup);
  } else {
    redirectFullPage(loginFlow, url);
  }
}

/**
 * Add the DWEEB bot to a server in a popup. `guildId` pre-selects that server in
 * Discord's picker (used by the re-invite prompts). The chosen guild id returns
 * to the opener, which connects to it.
 */
export function startBotAddPopup(guildId?: string): void {
  const url = botInviteUrl(guildId);
  if (!url) return; // no client id configured — the caller hides the CTA anyway
  const popup = openPopup(botAddFlow);
  if (popup) {
    navigatePopup(popup, url);
    watchPopup(botAddFlow, popup);
  } else {
    redirectFullPage(botAddFlow, url);
  }
}
