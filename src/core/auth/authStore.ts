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
 */

import { create } from "zustand";
import { resetAccountScopedState } from "@/core/auth/accountScopedState";
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
  /** Begin Discord login (in a popup). */
  login(): void;
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

export const useAuthStore = create<AuthState>((set, get) => {
  /** End one account lifetime before publishing the anonymous state. Feature
   * resets abort or invalidate in-flight work so a late response cannot put
   * decrypted data back after sign-out. */
  const clearSession = (): void => {
    sessionGeneration += 1;
    useGuildStore.getState().disconnect();
    usePlanStore.getState().reset();
    resetAccountScopedState();
    set({ status: "anon", user: null, guilds: [], guildsStatus: "idle", guildsError: null });
  };

  // Core session hydration, shared by first-load `init` and post-login refresh.
  // Greets only when asked (right after an actual sign-in), and only once a user
  // actually comes back.
  const hydrate = async (greet: boolean): Promise<void> => {
    const generation = sessionGeneration;
    set({ status: "loading" });
    try {
      const user = await fetchMe();
      if (generation !== sessionGeneration) return;
      if (user) {
        set({ status: "authed", user });
        if (greet) pushToast(`Signed in as ${user.name}`, "success");
        void get().loadGuilds();
      } else clearSession();
    } catch {
      // Network/again-later: treat as signed-out rather than wedging the UI.
      if (generation === sessionGeneration) clearSession();
    }
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
      let greet = false;
      try {
        if (sessionStorage.getItem(JUST_LOGGED_IN_KEY)) {
          sessionStorage.removeItem(JUST_LOGGED_IN_KEY);
          greet = true;
        }
      } catch {
        // sessionStorage unavailable — skip the greeting, not worth failing over.
      }
      await hydrate(greet);
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
      await hydrate(true);
    },

    async logout() {
      clearSession();
      await postLogout();
      pushToast("Signed out", "info");
    },

    markSignedOut() {
      // Concurrent requests can all observe the same expired cookie. Only the
      // first one needs to clear state and notify the user.
      if (get().status === "anon") return;
      clearSession();
      pushToast("Your session expired — sign in again.", "info");
    },
  };
});
