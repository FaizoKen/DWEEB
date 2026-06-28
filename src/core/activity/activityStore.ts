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
import { fetchUserGuilds, type PickerGuild } from "@/core/guild/api";
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
  /** Null when launched from a DM / group DM, which has no guild. In that case
   *  there's nothing to post *into* (DMs can't host webhooks), so the user picks
   *  a server they manage as the destination instead — see `targetGuildId`. */
  guildId: string | null;
  /** The launching channel. Null when the Activity wasn't launched from a guild
   *  channel; in a DM it's the DM channel, which can't receive a webhook post. */
  channelId: string | null;
  instanceId: string;
}

export interface ActivityUser {
  id: string;
  name: string;
  avatar: string | null;
}

/** Which Discord client the Activity launched on, read off `sdk.platform`.
 *  Drives the mobile-only safe-area fallback (see `ActivityApp`): the mobile
 *  client overlays a native top bar whose inset isn't populated until the first
 *  layout change. Null until the handshake resolves. */
export type ActivityPlatform = "mobile" | "desktop";

interface ActivityState {
  status: ActivityStatus;
  step: ActivityStep;
  error: string | null;
  context: ActivityContext | null;
  user: ActivityUser | null;
  platform: ActivityPlatform | null;
  participants: CollabParticipant[];
  collabConnected: boolean;
  publishing: boolean;
  lastPost: ActivityPostResult | null;
  /** The guild the next post goes to. In a server launch this is the launching
   *  guild; in a DM launch it's null until the user picks a destination server
   *  they manage (from `guilds`) — DMs have no guild of their own to post into. */
  targetGuildId: string | null;
  /** Where the next post goes. Seeded to the launching channel in a server
   *  launch, but re-pointable at any channel in `targetGuildId` through the bar's
   *  picker. Null before a channel is chosen (always so on a DM launch, until a
   *  destination server *and* channel are picked). */
  targetChannelId: string | null;
  /** The user's postable servers — only loaded on a DM launch, where a
   *  destination must be chosen. Empty in a server launch (the guild is fixed). */
  guilds: PickerGuild[];
  /** True while the DM-launch server list is loading. */
  guildsLoading: boolean;

  /** Run the SDK handshake and start the session. Safe to call once. */
  init(): Promise<void>;
  /** Post the current message into the chosen channel. */
  publish(): Promise<void>;
  /** Re-point `publish()` at a different channel in the target guild. */
  setTargetChannel(channelId: string): void;
  /** Pick the destination server (DM launch): loads its channels + preview data
   *  and resets the channel selection. */
  setTargetGuild(guildId: string): void;
}

let initialised = false;

export const useActivityStore = create<ActivityState>((set, get) => ({
  status: "idle",
  step: "starting",
  error: null,
  context: null,
  user: null,
  platform: null,
  participants: [],
  collabConnected: false,
  publishing: false,
  lastPost: null,
  targetGuildId: null,
  targetChannelId: null,
  guilds: [],
  guildsLoading: false,

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
      set({
        status: "ready",
        step: "done",
        context: mock.context,
        user: mock.user,
        platform: mock.platform,
        targetGuildId: mock.context.guildId,
        // Only a server launch can seed a postable channel; a DM stub has none.
        targetChannelId: mock.context.guildId ? mock.context.channelId : null,
      });
      // The override can't reach the proxy (its faux ticket 404s every proxied
      // call), so don't try to load a DM launch's server list here — the picker
      // just shows empty under the override. A real launch loads it below.
      return;
    }

    try {
      // Must precede any proxy call so requests are routed through the sandbox.
      configureUrlMappings();

      const sdk = getSdk();
      await sdk.ready();
      // Which client we're on, so the UI can apply the mobile-only safe-area
      // fallback (the native top bar's inset isn't populated until the first
      // layout change — see ActivityApp). `sdk.platform` is "mobile"/"desktop".
      set({ step: "sdk-ready", platform: sdk.platform === "mobile" ? "mobile" : "desktop" });

      // A DM / group-DM launch has no guild (`sdk.guildId` is null). We still
      // run the full handshake — the difference is only where the post goes:
      // a server launch posts into its own channel; a DM launch lets the user
      // pick a server they manage (DMs can't host webhooks, so there's nothing
      // to post into the DM itself).
      const guildId = sdk.guildId || null;
      const channelId = sdk.channelId;
      const instanceId = sdk.instanceId;

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

      set({
        status: "ready",
        step: "done",
        context: { guildId, channelId, instanceId },
        user,
        targetGuildId: guildId,
        // A server launch can post into its own channel straight away; a DM
        // launch has no postable channel until a destination server is chosen.
        targetChannelId: guildId ? channelId : null,
      });

      if (guildId) {
        // Server launch: load the launching server's data so the preview
        // resolves mentions/emoji and the channel picker is populated.
        void useGuildStore.getState().connect(guildId);
      } else {
        // DM launch: load the servers the user can post to, so they can pick a
        // destination. The preview resolves against whichever they choose.
        void loadPostableGuilds(set);
      }

      // Open the shared editing room. A DM launch passes no guild — the room is
      // keyed by the unguessable instance id instead (see `server/activity.rs`).
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
    const guildId = get().targetGuildId;
    if (!guildId) {
      pushToast("Pick a server to post to first.", "error");
      return;
    }
    const channelId = get().targetChannelId;
    if (!channelId) {
      pushToast("Pick a channel to post to first.", "error");
      return;
    }
    if (get().publishing) return;
    set({ publishing: true });
    try {
      const payload = buildWirePayload(useMessageStore.getState().message);
      const result = await publishToChannel(guildId, channelId, payload);
      set({ lastPost: result });
      pushToast("Posted to the channel ✓", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Couldn't post the message.", "error");
    } finally {
      set({ publishing: false });
    }
  },

  setTargetChannel(channelId) {
    set({ targetChannelId: channelId });
  },

  setTargetGuild(guildId) {
    if (get().targetGuildId === guildId) return;
    // Switching destination drops the old channel pick and loads the new
    // server's channels + mapping data (which also re-resolves the preview).
    set({ targetGuildId: guildId, targetChannelId: null });
    void useGuildStore.getState().connect(guildId);
  },
}));

/** Load the user's postable servers for a DM launch — those where the DWEEB bot
 *  is present and the user holds Manage Webhooks (the gate the post enforces).
 *  Failures are non-fatal: the picker just shows its empty state. */
async function loadPostableGuilds(set: (partial: Partial<ActivityState>) => void): Promise<void> {
  set({ guildsLoading: true });
  try {
    const all = await fetchUserGuilds();
    const postable = all.filter((g) => g.bot_present && g.can_manage_webhooks);
    set({ guilds: postable });
  } catch {
    set({ guilds: [] });
  } finally {
    set({ guildsLoading: false });
  }
}

/**
 * When running a dev build inside Discord's URL-Override launch, return a stub
 * session built from the launch query params (`guild_id`, `channel_id`,
 * `instance_id` are all present), or null otherwise. See the call site in
 * `init()` for why proxied calls can't work under the override.
 */
function devOverrideSession(): {
  context: ActivityContext;
  user: ActivityUser;
  platform: ActivityPlatform;
} | null {
  if (!import.meta.env.DEV) return null;
  const q = new URLSearchParams(window.location.search);
  if (q.get("discord_proxy_ticket") !== "faux-proxy-ticket") return null;
  // `guild_id` is absent on a DM launch — seed a guild-less (DM) stub then, so
  // the embedded builder still renders for UI iteration (the server picker stays
  // empty, since its list needs the proxy the override can't reach).
  return {
    context: {
      guildId: q.get("guild_id"),
      channelId: q.get("channel_id"),
      instanceId: q.get("instance_id") ?? "dev-override",
    },
    user: { id: "dev-override", name: "Dev (override)", avatar: null },
    // Discord appends `platform=mobile|desktop` to the launch URL; honour it so
    // the override can exercise the mobile layout from a desktop browser too.
    platform: q.get("platform") === "mobile" ? "mobile" : "desktop",
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
