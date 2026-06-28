/**
 * Activity store — the embedded surface's brain.
 *
 * `init()` runs the one-time handshake (SDK ready → authorize → token exchange →
 * authenticate), wires the editor to the launching server/channel, and opens the
 * collaboration room. After that it exposes the live context (guild/channel/
 * instance), the signed-in user, the presence roster, and `publish()` — the
 * one-click "post this into the channel" action.
 *
 * It deliberately reuses the existing stores: the guild store loads roles/
 * channels/emojis for the preview, and the message store *is* the shared draft
 * (collab syncs it). So everything below `core/activity` stays oblivious to the
 * fact that it's running inside Discord.
 */

import { create } from "zustand";
import { DISCORD_CLIENT_ID } from "@/core/guild/config";
import { useGuildStore } from "@/core/guild/guildStore";
import { useMessageStore } from "@/core/state/messageStore";
import { buildWirePayload } from "@/core/webhook/send";
import { pushToast } from "@/ui/Toast";
import { configureUrlMappings, getSdk } from "./sdk";
import { exchangeCode, publishToChannel, type ActivityPostResult } from "./api";
import { startCollab, stopCollab, type CollabParticipant } from "./collab";
import { setActivityToken } from "./runtime";

export type ActivityStatus = "idle" | "connecting" | "ready" | "error";

/** Fine-grained handshake progress, surfaced on the splash so a stalled launch
 *  shows *where* it stalled (the in-Discord iframe has no reachable console). */
export type ActivityStep =
  | "starting"
  | "sdk-ready"
  | "authorizing"
  | "exchanging-token"
  | "authenticating"
  | "done";

/** The launching context, read off the SDK once ready. */
export interface ActivityContext {
  guildId: string;
  /** Null when the Activity wasn't launched from a channel (e.g. a DM). */
  channelId: string | null;
  instanceId: string;
}

export interface ActivityUser {
  id: string;
  name: string;
  avatar: string | null;
}

interface ActivityState {
  status: ActivityStatus;
  step: ActivityStep;
  error: string | null;
  context: ActivityContext | null;
  user: ActivityUser | null;
  participants: CollabParticipant[];
  collabConnected: boolean;
  publishing: boolean;
  lastPost: ActivityPostResult | null;

  /** Run the SDK handshake and start the session. Safe to call once. */
  init(): Promise<void>;
  /** Post the current message into the Activity's channel. */
  publish(): Promise<void>;
}

let initialised = false;

export const useActivityStore = create<ActivityState>((set, get) => ({
  status: "idle",
  step: "starting",
  error: null,
  context: null,
  user: null,
  participants: [],
  collabConnected: false,
  publishing: false,
  lastPost: null,

  async init() {
    if (initialised) return;
    initialised = true;
    set({ status: "connecting", step: "starting", error: null });

    // Dev-only escape hatch for Discord's "Use Activity URL Override".
    //
    // The override (developer shelf) launches the Activity with a *faux* proxy
    // ticket (`discord_proxy_ticket=faux-proxy-ticket`), and Discord's edge does
    // NOT forward `/.proxy/…` requests for such launches — so every proxied call
    // (token exchange, guild bootstrap, publish, collab WS) 404s and the real
    // handshake can't complete. To still iterate the embedded UI locally, when we
    // detect that exact case we skip the proxy-bound handshake and seed a stub
    // session from the launch params so the builder renders. This NEVER runs in a
    // production build (`import.meta.env.DEV` is false), where the real launch
    // carries a real ticket and the handshake below runs normally.
    const mock = devOverrideSession();
    if (mock) {
      set({ status: "ready", step: "done", context: mock.context, user: mock.user });
      return;
    }

    try {
      // Must precede any proxy call so requests are routed through the sandbox.
      configureUrlMappings();

      const sdk = getSdk();
      await sdk.ready();
      set({ step: "sdk-ready" });

      const guildId = sdk.guildId;
      const channelId = sdk.channelId;
      const instanceId = sdk.instanceId;
      if (!guildId) {
        throw new Error(
          "Launch DWEEB from a server channel — it needs a server to build messages for.",
        );
      }

      set({ step: "authorizing" });
      const { code } = await sdk.commands.authorize({
        client_id: DISCORD_CLIENT_ID,
        response_type: "code",
        state: cryptoState(),
        prompt: "none",
        // identify → who's editing (presence); guilds → membership/permission gate.
        scope: ["identify", "guilds"] as ("identify" | "guilds")[],
      });

      set({ step: "exchanging-token" });
      const accessToken = await exchangeCode(code);
      setActivityToken(accessToken);

      set({ step: "authenticating" });
      const auth = await sdk.commands.authenticate({ access_token: accessToken });
      const user: ActivityUser = {
        id: auth.user.id,
        name: auth.user.global_name || auth.user.username,
        avatar: auth.user.avatar ?? null,
      };

      set({ status: "ready", step: "done", context: { guildId, channelId, instanceId }, user });

      // Load the launching server's data so the preview resolves mentions/emoji.
      void useGuildStore.getState().connect(guildId);

      // Open the shared editing room.
      startCollab({
        instanceId,
        guildId,
        token: accessToken,
        onRoster: (participants) => set({ participants }),
        onConnectedChange: (collabConnected) => set({ collabConnected }),
      });
    } catch (e) {
      stopCollab();
      const message =
        e instanceof Error ? e.message : "Couldn't start DWEEB inside Discord. Try relaunching.";
      set({ status: "error", error: message });
    }
  },

  async publish() {
    const ctx = get().context;
    if (!ctx) return;
    if (!ctx.channelId) {
      pushToast("No channel to post to — launch DWEEB from a text or voice channel.", "error");
      return;
    }
    if (get().publishing) return;
    set({ publishing: true });
    try {
      const payload = buildWirePayload(useMessageStore.getState().message);
      const result = await publishToChannel(ctx.guildId, ctx.channelId, payload);
      set({ lastPost: result });
      pushToast("Posted to the channel ✓", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Couldn't post the message.", "error");
    } finally {
      set({ publishing: false });
    }
  },
}));

/**
 * When running a dev build inside Discord's URL-Override launch, return a stub
 * session built from the launch query params (`guild_id`, `channel_id`,
 * `instance_id` are all present), or null otherwise. See the call site in
 * `init()` for why proxied calls can't work under the override.
 */
function devOverrideSession(): { context: ActivityContext; user: ActivityUser } | null {
  if (!import.meta.env.DEV) return null;
  const q = new URLSearchParams(window.location.search);
  if (q.get("discord_proxy_ticket") !== "faux-proxy-ticket") return null;
  const guildId = q.get("guild_id");
  if (!guildId) return null;
  return {
    context: {
      guildId,
      channelId: q.get("channel_id"),
      instanceId: q.get("instance_id") ?? "dev-override",
    },
    user: { id: "dev-override", name: "Dev (override)", avatar: null },
  };
}

/** A throwaway CSRF `state` for the authorize call. */
function cryptoState(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return Math.random().toString(36).slice(2);
  }
}
