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
  /** (Re)load the user's server list for the picker. */
  loadGuilds(): Promise<void>;
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
        void get().loadGuilds();
      } else {
        set({ status: "anon", user: null });
      }
    } catch {
      // Network/again-later: treat as signed-out rather than wedging the UI.
      set({ status: "anon", user: null });
    }
  },

  async loadGuilds() {
    set({ guildsStatus: "loading", guildsError: null });
    try {
      const guilds = await fetchUserGuilds();
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
    window.location.href = loginUrl();
  },

  async logout() {
    await postLogout();
    useGuildStore.getState().disconnect();
    set({ status: "anon", user: null, guilds: [], guildsStatus: "idle", guildsError: null });
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
  },
}));
