/**
 * Authentication store.
 *
 * Tracks the Discord login state and the signed-in user's list of usable
 * servers (the picker source). The proxy owns the actual session (an encrypted
 * cookie); this store is just the browser's view of it, hydrated from
 * `GET /auth/me` on startup.
 *
 * Login is a full-page redirect to the proxy's `/auth/login` (so the OAuth
 * round-trip and cookie set happen at the top level, not via fetch). After
 * Discord bounces the user back to the app, `init()` sees the session and flips
 * to "authed".
 */

import { create } from "zustand";
import {
  fetchMe,
  fetchUserGuilds,
  isAuthError,
  postLogout,
  type AuthUser,
  type PickerGuild,
} from "@/core/guild/api";
import { isProxyConfigured, loginUrl } from "@/core/guild/config";
import { useGuildStore } from "@/core/guild/guildStore";
import { pushToast } from "@/ui/Toast";

/** Set right before the login redirect so we can greet the user only on the
 *  return from a real sign-in, not on every reload with a live session. */
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
  /** Begin Discord login (full-page redirect). */
  login(): void;
  /** Sign out: clear the proxy session and reset all server state. */
  logout(): Promise<void>;
  /** Flip to signed-out locally — called when a request returns 401. */
  markSignedOut(): void;
}

let initialised = false;

export const useAuthStore = create<AuthState>((set, get) => ({
  status: "unknown",
  user: null,
  guilds: [],
  guildsStatus: "idle",
  guildsError: null,

  async init() {
    if (initialised || !isProxyConfigured()) return;
    initialised = true;
    set({ status: "loading" });
    try {
      const user = await fetchMe();
      if (user) {
        set({ status: "authed", user });
        // Greet only right after an actual sign-in, not on every reload.
        try {
          if (sessionStorage.getItem(JUST_LOGGED_IN_KEY)) {
            sessionStorage.removeItem(JUST_LOGGED_IN_KEY);
            pushToast(`Signed in as ${user.name}`, "success");
          }
        } catch {
          // sessionStorage unavailable — skip the greeting, not worth failing over.
        }
        void get().loadGuilds();
      } else {
        set({ status: "anon", user: null });
      }
    } catch {
      // Network/again-later: treat as signed-out rather than wedging the UI.
      set({ status: "anon", user: null });
    }
  },

  async loadGuilds(force = false) {
    set({ guildsStatus: "loading", guildsError: null });
    try {
      const guilds = await fetchUserGuilds(force);
      set({ guilds, guildsStatus: "ready" });
    } catch (e) {
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
    try {
      sessionStorage.setItem(JUST_LOGGED_IN_KEY, "1");
    } catch {
      // No sessionStorage — we just skip the post-login greeting.
    }
    window.location.href = loginUrl();
  },

  async logout() {
    await postLogout();
    useGuildStore.getState().disconnect();
    set({ status: "anon", user: null, guilds: [], guildsStatus: "idle", guildsError: null });
    pushToast("Signed out", "info");
  },

  markSignedOut() {
    useGuildStore.getState().disconnect();
    set({
      status: "anon",
      user: null,
      guilds: [],
      guildsStatus: "idle",
      guildsError: null,
    });
    pushToast("Your session expired — sign in again.", "info");
  },
}));
