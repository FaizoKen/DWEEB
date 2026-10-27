/**
 * Applies a `?plans=<guildId>` deep link on first load.
 *
 * The embedded Activity can't run Stripe checkout inside Discord's sandbox, so
 * its plan indicator's "Upgrade" action hands off to the web app with this param
 * (see `activityStore.openPlansOnWeb`). This hook reads it and opens the pricing
 * modal scoped to that server — the same modal the account menu opens, but
 * pointed at the server the user was just building for.
 *
 * Auth-aware: the pricing/checkout flow needs a signed-in session, so when the
 * user lands signed out we ask them to sign in (a toast whose button opens the
 * Discord popup — a page load carries no click to open it with) and remember
 * the intent (in sessionStorage, so it survives a popup-blocked full-page
 * redirect through OAuth); once the session resolves we open pricing for the
 * remembered server.
 * An already-signed-in visitor opens it immediately.
 */

import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "@/core/auth/authStore";
import { usePlanStore } from "@/core/plan/planStore";
import type { UpgradePrompt } from "@/core/plan/upgradePrompt";

/** Survives the OAuth full-page redirect (the URL params are stripped on
 *  capture). Holds `<guild>:<prompt>` — or a bare guild, as a tab predating the
 *  prompt wrote it. */
const PENDING_KEY = "dweeb.plans.pendingGuild";

/** What the Activity asked for: the server, and which of its prompts sent them. */
export interface PlansIntent {
  guild: string;
  from: UpgradePrompt;
}

const SNOWFLAKE = /^\d{17,20}$/;

/** Only the Activity links here, so only its prompts are read — anything else
 *  is its plain hand-off. Kept to this one comparison rather than the full
 *  prompt list, because this hook is on the boot path. */
function activityPrompt(value: string | null | undefined): UpgradePrompt {
  return value === "room_full" ? "room_full" : "activity";
}

/** The `?plans=<id>` value, validated to the Discord snowflake shape. */
export function readPlansParam(search: string): string | null {
  const id = new URLSearchParams(search).get("plans");
  return id && SNOWFLAKE.test(id) ? id : null;
}

/** The whole `?plans=<id>&plans_from=<prompt>` link. A missing or unknown prompt
 *  reads as the Activity's plain hand-off. */
export function readPlansIntent(search: string): PlansIntent | null {
  const guild = readPlansParam(search);
  if (!guild) return null;
  return { guild, from: activityPrompt(new URLSearchParams(search).get("plans_from")) };
}

/** A stored intent, read back. */
export function parsePendingIntent(stored: string | null): PlansIntent | null {
  if (!stored) return null;
  const [guild = "", from] = stored.split(":");
  if (!SNOWFLAKE.test(guild)) return null;
  return { guild, from: activityPrompt(from) };
}

function stripPlansParam(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("plans");
  url.searchParams.delete("plans_from");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

export function usePlansDeepLink(): void {
  const status = useAuthStore((s) => s.status);
  const requestLogin = useAuthStore((s) => s.requestLogin);
  const openPricing = usePlanStore((s) => s.openPricing);

  // The server we owe a pricing modal, captured once from the URL (or a persisted
  // pending intent left by a login redirect). Null when there's no plans link.
  const [pending, setPending] = useState<PlansIntent | null>(null);
  const captured = useRef(false);
  const loginStarted = useRef(false);

  useEffect(() => {
    if (captured.current) return;
    captured.current = true;
    let intent = readPlansIntent(window.location.search);
    if (intent) {
      // Stash the intent synchronously so it outlives a full-page OAuth redirect…
      try {
        sessionStorage.setItem(PENDING_KEY, `${intent.guild}:${intent.from}`);
      } catch {
        /* no sessionStorage — the in-memory `pending` still covers the popup path */
      }
      // …but defer stripping the param past this synchronous effect batch, so the
      // gallery-auto-open guard (a later mount effect, also reading the URL) still
      // sees it and stands down instead of opening behind the pricing modal.
      setTimeout(stripPlansParam, 0);
    } else {
      try {
        intent = parsePendingIntent(sessionStorage.getItem(PENDING_KEY));
      } catch {
        intent = null;
      }
    }
    if (intent) setPending(intent);
  }, []);

  useEffect(() => {
    if (!pending) return;
    if (status === "authed") {
      try {
        sessionStorage.removeItem(PENDING_KEY);
      } catch {
        /* ignore */
      }
      openPricing(pending.guild, pending.from);
      setPending(null);
    } else if (status === "anon") {
      // Signed out: ask once for a sign-in the user starts. Opening the popup
      // from here, with no click behind it, is blocked and falls back to
      // navigating the whole page to Discord. The intent persists in
      // sessionStorage, so the return trip (this effect re-running as "authed",
      // or a fresh mount after a redirect) opens pricing for the same server —
      // however they end up signing in.
      if (!loginStarted.current) {
        loginStarted.current = true;
        requestLogin("Sign in with Discord to see this server’s plans.");
      }
    }
    // "unknown" / "loading": wait for the session to resolve, then act.
  }, [pending, status, requestLogin, openPricing]);
}
