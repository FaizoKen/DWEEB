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
 * user lands signed out we start Discord login and remember the intent (in
 * sessionStorage, so it survives a popup-blocked full-page redirect through
 * OAuth); once the session resolves we open pricing for the remembered server.
 * An already-signed-in visitor opens it immediately.
 */

import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "@/core/auth/authStore";
import { usePlanStore } from "@/core/plan/planStore";

/** Survives the OAuth full-page redirect (the URL param is stripped on capture). */
const PENDING_KEY = "dweeb.plans.pendingGuild";

/** The `?plans=<id>` value, validated to the Discord snowflake shape. */
export function readPlansParam(search: string): string | null {
  const id = new URLSearchParams(search).get("plans");
  return id && /^\d{17,20}$/.test(id) ? id : null;
}

function stripPlansParam(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("plans");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

export function usePlansDeepLink(): void {
  const status = useAuthStore((s) => s.status);
  const login = useAuthStore((s) => s.login);
  const openPricing = usePlanStore((s) => s.openPricing);

  // The server we owe a pricing modal, captured once from the URL (or a persisted
  // pending intent left by a login redirect). Null when there's no plans link.
  const [pending, setPending] = useState<string | null>(null);
  const captured = useRef(false);
  const loginStarted = useRef(false);

  useEffect(() => {
    if (captured.current) return;
    captured.current = true;
    let guild = readPlansParam(window.location.search);
    if (guild) {
      // Stash the intent synchronously so it outlives a full-page OAuth redirect…
      try {
        sessionStorage.setItem(PENDING_KEY, guild);
      } catch {
        /* no sessionStorage — the in-memory `pending` still covers the popup path */
      }
      // …but defer stripping the param past this synchronous effect batch, so the
      // gallery-auto-open guard (a later mount effect, also reading the URL) still
      // sees it and stands down instead of opening behind the pricing modal.
      setTimeout(stripPlansParam, 0);
    } else {
      try {
        guild = sessionStorage.getItem(PENDING_KEY);
      } catch {
        guild = null;
      }
    }
    if (guild) setPending(guild);
  }, []);

  useEffect(() => {
    if (!pending) return;
    if (status === "authed") {
      try {
        sessionStorage.removeItem(PENDING_KEY);
      } catch {
        /* ignore */
      }
      openPricing(pending);
      setPending(null);
    } else if (status === "anon") {
      // Signed out: send them through Discord login once. The intent persists in
      // sessionStorage, so the return trip (this effect re-running as "authed",
      // or a fresh mount after a redirect) opens pricing for the same server.
      if (!loginStarted.current) {
        loginStarted.current = true;
        login();
      }
    }
    // "unknown" / "loading": wait for the session to resolve, then act.
  }, [pending, status, login, openPricing]);
}
