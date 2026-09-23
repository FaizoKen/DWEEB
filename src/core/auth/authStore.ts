/**
 * Authentication store.
 *
 * Tracks the Discord login state and the signed-in user's list of usable
 * servers (the picker source). The proxy owns the actual session (an encrypted
 * cookie); this store is just the browser's view of it, hydrated from
 * `GET /auth/me` on startup.
 *
 * Login runs in a popup (see `core/oauth`) so the in-progress message survives.
 * The proxy sets the session cookie during the OAuth callback (origin-global),
 * so once the popup reports back we just re-read `/auth/me` and flip to "authed"
 * via `completeLogin`. A blocked popup falls back to a full-page redirect, in
 * which case the reload's `init()` picks the session up instead.
 *
 * Only an answer ends a session: a 401/403 from `/auth/me` clears everything, as
 * does sign-out or a 401 anywhere else (`markSignedOut`). A check that couldn't
 * reach the proxy (offline, a timeout, a 5xx) changes nothing it doesn't have to
 * — a signed-in user stays signed in; a first load settles on a usable
 * signed-out state without clearing the cached server — and, when there's a
 * session to recover, says so once and re-checks on a backoff and whenever the
 * browser comes back online or to the tab (see `sessionRetry`).
 */

import { create } from "zustand";
import { resetAccountScopedState } from "@/core/auth/accountScopedState";
import { readSessionHint, writeSessionHint } from "@/core/auth/sessionHint";
import {
  isTransientSessionError,
  MAX_TIMED_SESSION_RETRIES,
  sessionRetryDelayMs,
} from "@/core/auth/sessionRetry";
import {
  fetchMe,
  fetchUserGuilds,
  isAuthError,
  postLogout,
  type AuthUser,
  type PickerGuild,
} from "@/core/guild/api";
import { isProxyConfigured } from "@/core/guild/config";
import { syncGuildIdentity } from "@/core/guild/identityCache";
import { startLoginPopup } from "@/core/oauth/flows";
import { useGuildStore } from "@/core/guild/guildStore";
import { usePlanStore } from "@/core/plan/planStore";
import { pushToast } from "@/ui/Toast";

/** Set right before a popup-blocked full-page login redirect so we greet the user
 *  only on the return from a real sign-in, not on every reload with a live
 *  session. (The popup path greets directly from `completeLogin` instead.) */
const JUST_LOGGED_IN_KEY = "dweeb.auth.justLoggedIn";

type AuthStatus = "unknown" | "loading" | "authed" | "anon";
type GuildsStatus = "idle" | "loading" | "ready" | "error";

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  guilds: PickerGuild[];
  guildsStatus: GuildsStatus;
  guildsError: string | null;

  /** Resolve the current session once on app load. */
  init(): Promise<void>;
  /** (Re)load the user's server list for the picker. Pass `force` on a manual
   *  refresh to bypass the proxy's cache. */
  loadGuilds(force?: boolean): Promise<void>;
  /** Begin Discord login (in a popup). Call it from a click: a popup opened
   *  without one is blocked, and the fallback navigates the whole page away. */
  login(): void;
  /** Ask for a sign-in the user starts themselves — a toast whose "Sign in"
   *  button runs `login()`. For flows that arrive without a click (a deep link,
   *  a return from Discord), where calling `login()` directly is blocked. */
  requestLogin(message: string): void;
  /** Apply the result of the login popup: on success re-read the session and flip
   *  to "authed"; on failure (cancelled / no interaction) surface a gentle note. */
  completeLogin(ok: boolean): Promise<void>;
  /** Sign out: clear the proxy session and reset all server state. */
  logout(): Promise<void>;
  /** Flip to signed-out locally — called when a request returns 401. */
  markSignedOut(): void;
}

let initialised = false;
let sessionGeneration = 0;
/** Greet ("Signed in as …") when the next check finds a user. Set right after a
 *  real sign-in and kept through retries, so a sign-in whose check hit a blip
 *  is still acknowledged once the check gets through. */
let greetOnSuccess = false;
/** Bumped per check, so an older, slower check never overwrites a newer answer. */
let checkSeq = 0;
let checking = false;
/** Non-null while the last check couldn't reach the proxy and nothing has
 *  settled the session since: the timed backoff's attempt count and timer. */
let retry: { attempt: number; timer?: ReturnType<typeof setTimeout> } | null = null;

export const useAuthStore = create<AuthState>((set, get) => {
  // A retry the browser itself prompts: back online, or back to the tab.
  const wake = (): void => {
    if (retry && !checking && document.visibilityState !== "hidden") void check(false);
  };

  const stopRetrying = (): void => {
    if (!retry) return;
    clearTimeout(retry.timer);
    retry = null;
    if (typeof window === "undefined") return;
    window.removeEventListener("online", wake);
    document.removeEventListener("visibilitychange", wake);
  };

  // Say so once per outage, then keep asking: on a backoff for about two
  // minutes, and whenever the browser prompts (see `wake`) after that.
  const retryLater = (): void => {
    if (!retry) {
      retry = { attempt: 0 };
      pushToast("Couldn’t reach DWEEB to check your sign-in — retrying…", "info");
      if (typeof window !== "undefined") {
        window.addEventListener("online", wake);
        document.addEventListener("visibilitychange", wake);
      }
    }
    clearTimeout(retry.timer);
    retry.timer =
      retry.attempt < MAX_TIMED_SESSION_RETRIES
        ? setTimeout(() => {
            if (!checking) void check(false);
          }, sessionRetryDelayMs(retry.attempt++))
        : undefined;
  };

  /** End one account lifetime before publishing the anonymous state. Feature
   * resets abort or invalidate in-flight work so a late response cannot put
   * decrypted data back after sign-out. */
  const clearSession = (): void => {
    stopRetrying();
    greetOnSuccess = false;
    sessionGeneration += 1;
    useGuildStore.getState().disconnect();
    usePlanStore.getState().reset();
    resetAccountScopedState();
    writeSessionHint(false);
    set({ status: "anon", user: null, guilds: [], guildsStatus: "idle", guildsError: null });
  };

  // Ask the proxy who's signed in — on first load, after a sign-in, and on each
  // retry. A foreground check shows the loading state; a retry runs behind the
  // state it's trying to settle, so that state stays usable meanwhile.
  const check = async (foreground: boolean): Promise<void> => {
    const seq = ++checkSeq;
    const generation = sessionGeneration;
    const wasAuthed = get().status === "authed";
    if (foreground && !wasAuthed) set({ status: "loading" });
    checking = true;
    let outcome: AuthUser | "signed-out" | "unreachable";
    try {
      outcome = (await fetchMe()) ?? "signed-out";
    } catch (e) {
      outcome = isTransientSessionError(e) ? "unreachable" : "signed-out";
    } finally {
      if (seq === checkSeq) checking = false;
    }
    if (seq !== checkSeq || generation !== sessionGeneration) return;

    if (outcome === "signed-out") {
      clearSession();
      return;
    }
    if (outcome === "unreachable") {
      // No answer says nothing about the session. Signed in stays signed in;
      // otherwise settle on a usable signed-out state without clearing anything
      // (no account lifetime has ended), and keep asking while there's a
      // session worth recovering — an earlier one, or a sign-in just finished.
      if (!wasAuthed) set({ status: "anon" });
      if (wasAuthed || greetOnSuccess || readSessionHint() || useGuildStore.getState().guildId) {
        retryLater();
      }
      return;
    }
    stopRetrying();
    writeSessionHint(true);
    set({ status: "authed", user: outcome });
    if (greetOnSuccess) {
      greetOnSuccess = false;
      pushToast(`Signed in as ${outcome.name}`, "success");
    }
    void get().loadGuilds();
  };

  return {
    status: "unknown",
    user: null,
    guilds: [],
    guildsStatus: "idle",
    guildsError: null,

    async init() {
      if (initialised || !isProxyConfigured()) return;
      initialised = true;
      // Greet only right after an actual sign-in via the full-page fallback, not
      // on every reload with a live session.
      try {
        if (sessionStorage.getItem(JUST_LOGGED_IN_KEY)) {
          sessionStorage.removeItem(JUST_LOGGED_IN_KEY);
          greetOnSuccess = true;
        }
      } catch {
        // sessionStorage unavailable — skip the greeting, not worth failing over.
      }
      await check(true);
    },

    async loadGuilds(force = false) {
      if (get().status !== "authed") return;
      const generation = sessionGeneration;
      set({ guildsStatus: "loading", guildsError: null });
      try {
        const guilds = await fetchUserGuilds(force);
        if (generation !== sessionGeneration || get().status !== "authed") return;
        // The list is authoritative for the connected server's name/icon: refresh
        // (or drop) the cache that carries them across the next reload's boot gap,
        // before publishing the list that consumers re-render on.
        syncGuildIdentity(useGuildStore.getState().guildId, guilds);
        set({ guilds, guildsStatus: "ready" });
      } catch (e) {
        if (generation !== sessionGeneration) return;
        if (isAuthError(e)) {
          get().markSignedOut();
          return;
        }
        const message = e instanceof Error ? e.message : "Couldn't load your servers.";
        set({ guildsStatus: "error", guildsError: message });
      }
    },

    login() {
      if (!isProxyConfigured()) return;
      // Set the fallback greet flag in case the popup is blocked and we redirect
      // the whole page (the reload's `init` reads it). The popup path clears it
      // and greets from `completeLogin` instead.
      try {
        sessionStorage.setItem(JUST_LOGGED_IN_KEY, "1");
      } catch {
        // No sessionStorage — we just skip the post-login greeting.
      }
      startLoginPopup();
    },

    requestLogin(message) {
      if (!isProxyConfigured()) return;
      // Longer than an action toast's 7 s: whoever lands here has just switched
      // from Discord, and the intent that asked survives a missed toast anyway.
      pushToast(message, "info", {
        action: { label: "Sign in", onClick: () => get().login() },
        durationMs: 15_000,
      });
    },

    async completeLogin(ok: boolean) {
      if (!isProxyConfigured()) return;
      // The popup path never reloads, so the fallback greet flag would only go
      // stale — drop it and greet here instead.
      try {
        sessionStorage.removeItem(JUST_LOGGED_IN_KEY);
      } catch {
        /* ignore */
      }
      if (!ok) {
        pushToast("Sign-in didn’t finish — you can try again.", "info");
        return;
      }
      initialised = true; // a live session exists now; a later `init` is a no-op
      greetOnSuccess = true;
      await check(true);
    },

    async logout() {
      clearSession();
      await postLogout();
      pushToast("Signed out", "info");
    },

    markSignedOut() {
      // Concurrent requests can all observe the same expired cookie. Only the
      // first one needs to clear state and notify the user — unless the
      // signed-out state is only standing in for a check that couldn't get
      // through, in which case this 401 is the answer that check was after.
      if (get().status === "anon" && !retry) return;
      clearSession();
      pushToast("Your session expired — sign in again.", "info");
    },
  };
});
