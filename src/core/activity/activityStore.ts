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
import { DISCORD_CLIENT_ID, WEB_APP_BASE_URL } from "@/core/guild/config";
import { useGuildStore } from "@/core/guild/guildStore";
import { fetchUserGuilds, type PickerGuild } from "@/core/guild/api";
import { useMessageStore } from "@/core/state/messageStore";
import type { WebhookMessage } from "@/core/schema/types";
import {
  encodeShare,
  createShortLink,
  isShortLinkConfigured,
  attachEditorFields,
} from "@/core/serialization";
import { buildWirePayload, parseMessageIdInput } from "@/core/webhook/send";
import { validateMessage } from "@/core/schema/validation";
import { pushToast } from "@/ui/Toast";
import {
  configureUrlMappings,
  getSdk,
  openExternalLink,
  openInviteDialog,
  shareActivityLink,
  setActivityPresence,
  subscribeLayoutMode,
  LAYOUT_MODE_PIP,
} from "./sdk";
import {
  editPostedMessage,
  exchangeCode,
  publishToChannel,
  restorePostedMessage,
  type ActivityPostResult,
} from "./api";
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
  /** True while Discord has the Activity minimised into its small picture-in-
   *  picture window. In that mode the surface drops the editor and shows only a
   *  full-bleed, live message preview (see ActivityApp). */
  pipMode: boolean;
  participants: CollabParticipant[];
  collabConnected: boolean;
  publishing: boolean;
  /** True while a restore is fetching a message back from Discord. */
  restoring: boolean;
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
  /** Display meta (name + icon) for the current target guild, shown by the
   *  header's top-right server indicator. For a server launch it's the launching
   *  guild (fetched once); for a DM launch it's the picked destination, taken
   *  from the postable list. Null until known. */
  targetGuildMeta: PickerGuild | null;

  /** Run the SDK handshake and start the session. Safe to call once. */
  init(): Promise<void>;
  /** Post the current message into the chosen channel as a NEW message. */
  publish(): Promise<void>;
  /** PATCH the message last posted from this Activity with the current draft.
   *  Only meaningful while {@link lastPost} matches the chosen destination. */
  update(): Promise<void>;
  /** Pull a message DWEEB posted in the target channel back into the shared
   *  editor (`input` is a message id or a Discord message link). The proxy
   *  resolves the webhook, so — unlike the web app — no URL is needed. On success
   *  the editor is wired to update that message in place ({@link lastPost}).
   *  Throws with a user-facing message on failure so the caller can surface it. */
  restore(input: string): Promise<void>;
  /** Open the last posted message in Discord (the sandboxed iframe can't
   *  navigate to discord.com itself, so this goes through the SDK). */
  openLastPost(): Promise<void>;
  /** Pull more people into this collaboration room. Server launch → Discord's
   *  native invite dialog; DM / group-DM launch → the share-link modal (the
   *  invite dialog throws there). Both land joiners in this same instance. */
  invite(): Promise<void>;
  /** Hand off the current draft to the full web app (account menu, scheduling,
   *  saved messages — the features the embedded surface omits). Opens the public
   *  site with the draft carried in a share link. */
  openOnWeb(): Promise<void>;
  /** Re-point `publish()` at a different channel in the target guild. */
  setTargetChannel(channelId: string): void;
  /** Pick the destination server (DM launch): loads its channels + preview data
   *  and resets the channel selection. */
  setTargetGuild(guildId: string): void;
}

/**
 * Per-stage handshake timeouts. Each step of `init()` awaits either the Discord
 * client (an SDK RPC) or the proxy; without a cap, any one of them hanging leaves
 * the splash spinning on "Connecting to Discord…" forever, with no way to tell
 * *which* stage stalled — a real in-Discord launch has no reachable console (see
 * the prod-launch hang in `docs/activity.md`). A timeout turns that silent hang
 * into a labelled, retryable error that names the stage. These are "something is
 * wrong" thresholds, not performance targets: generous enough not to trip on a
 * slow mobile client, short enough to fail fast.
 */
const READY_TIMEOUT_MS = 25_000;
const AUTHORIZE_TIMEOUT_MS = 25_000;
const EXCHANGE_TIMEOUT_MS = 20_000;
const AUTHENTICATE_TIMEOUT_MS = 20_000;

/** Above this hash-URL length the "Open on web" hand-off uploads the draft as a
 *  short link instead, so the host's external-link open never chokes on a huge
 *  URL. Small drafts stay fully client-side in the hash (nothing uploaded). */
const WEB_HANDOFF_MAX_URL = 8_000;

let initialised = false;

export const useActivityStore = create<ActivityState>((set, get) => ({
  status: "idle",
  step: "starting",
  error: null,
  context: null,
  user: null,
  platform: null,
  pipMode: false,
  participants: [],
  collabConnected: false,
  publishing: false,
  restoring: false,
  lastPost: null,
  targetGuildId: null,
  targetChannelId: null,
  guilds: [],
  guildsLoading: false,
  targetGuildMeta: null,

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
      await withTimeout(sdk.ready(), READY_TIMEOUT_MS, "connecting to Discord");
      // Which client we're on, so the UI can apply the mobile-only safe-area
      // fallback (the native top bar's inset isn't populated until the first
      // layout change — see ActivityApp). `sdk.platform` is "mobile"/"desktop".
      set({ step: "sdk-ready", platform: sdk.platform === "mobile" ? "mobile" : "desktop" });

      // Track Discord's layout mode so the surface can collapse to a clean, full-
      // bleed message preview whenever the user minimises the Activity into the
      // small picture-in-picture window (see ActivityApp). Fire-and-forget: the
      // disposer is unneeded on this single-page surface (the page unloads on
      // exit), and a host that never emits the event just leaves `pipMode` false.
      subscribeLayoutMode((mode) => set({ pipMode: mode === LAYOUT_MODE_PIP }));

      // A DM / group-DM launch has no guild (`sdk.guildId` is null). We still
      // run the full handshake — the difference is only where the post goes:
      // a server launch posts into its own channel; a DM launch lets the user
      // pick a server they manage (DMs can't host webhooks, so there's nothing
      // to post into the DM itself).
      const guildId = sdk.guildId || null;
      const channelId = sdk.channelId;
      const instanceId = sdk.instanceId;

      set({ step: "authorizing" });
      const { code } = await withTimeout(
        sdk.commands.authorize({
          client_id: DISCORD_CLIENT_ID,
          response_type: "code",
          state: cryptoState(),
          prompt: "none",
          // identify → who's editing (presence); guilds → membership/permission gate.
          scope: ["identify", "guilds"] as ("identify" | "guilds")[],
        }),
        AUTHORIZE_TIMEOUT_MS,
        "authorizing with Discord",
      );

      set({ step: "exchanging-token" });
      const accessToken = await withTimeout(
        exchangeCode(code),
        EXCHANGE_TIMEOUT_MS,
        "exchanging the login code",
      );
      setActivityToken(accessToken);

      set({ step: "authenticating" });
      const auth = await withTimeout(
        sdk.commands.authenticate({ access_token: accessToken }),
        AUTHENTICATE_TIMEOUT_MS,
        "finishing sign-in",
      );
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

      // Best-effort rich presence — friends see "Building a message in DWEEB" on
      // the user's profile. This command needs the `rpc.activities.write` scope,
      // which we deliberately don't request (a new authorize scope would perturb
      // the fragile handshake), so it silently no-ops without it and lights up
      // automatically if the scope is ever granted.
      void setActivityPresence("Building a message").catch(() => {});

      if (guildId) {
        // Server launch: load the launching server's data so the preview
        // resolves mentions/emoji and the channel picker is populated.
        void useGuildStore.getState().connect(guildId);
        // …and its display meta (name + icon) for the header's server indicator,
        // which the bootstrap above doesn't carry.
        void loadTargetGuildMeta(set, guildId);
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

  async update() {
    const last = get().lastPost;
    if (!last) {
      pushToast("Post the message first, then you can update it.", "error");
      return;
    }
    if (get().publishing) return;
    set({ publishing: true });
    try {
      const payload = buildWirePayload(useMessageStore.getState().message);
      const result = await editPostedMessage(
        last.guild_id,
        last.channel_id,
        last.message_id,
        last.webhook_id ?? "",
        payload,
      );
      set({ lastPost: result });
      pushToast("Updated the message ✓", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Couldn't update the message.", "error");
    } finally {
      set({ publishing: false });
    }
  },

  async restore(input) {
    const guildId = get().targetGuildId;
    const channelId = get().targetChannelId;
    if (!guildId || !channelId) {
      throw new Error("Pick a channel to restore from first.");
    }
    // Accept a bare snowflake or a full message link (the channel is fixed to the
    // target, so the link's channel part is ignored — only the message id matters).
    const messageId = parseMessageIdInput(input);
    if (!messageId) {
      throw new Error("Enter a message ID or a Discord message link.");
    }
    if (get().restoring) return;
    set({ restoring: true });
    try {
      const result = await restorePostedMessage(guildId, channelId, messageId);
      const decoded = decodeRestored(result.message);
      // Load it into the shared editor — collab broadcasts the new draft to
      // everyone in the room (a top-level structural change, so a full snapshot).
      useMessageStore.getState().replaceMessage(decoded);
      // Wire the toolbar to update THIS message: `lastPost` carries the webhook
      // that authored it, so the next edit PATCHes it in place instead of posting
      // a copy (same affordance a fresh post leaves behind).
      set({
        lastPost: {
          message_id: result.message_id,
          channel_id: result.channel_id,
          guild_id: result.guild_id,
          url: result.url,
          webhook_id: result.webhook_id,
        },
      });
      const validation = validateMessage(decoded);
      pushToast(
        validation.ok
          ? "Restored. Edits will update this message ✓"
          : `Restored with ${validation.issues.length} validation issue${
              validation.issues.length === 1 ? "" : "s"
            }.`,
        validation.ok ? "success" : "info",
      );
    } finally {
      set({ restoring: false });
    }
  },

  async openLastPost() {
    const url = get().lastPost?.url;
    if (!url) return;
    try {
      await openExternalLink(url);
    } catch {
      // The web app / dev URL-override aren't sandboxed, so a plain open works
      // there when the SDK path can't (a real in-Discord Activity needs the SDK).
      try {
        window.open(url, "_blank", "noopener");
      } catch {
        /* nothing more we can do */
      }
    }
  },

  async invite() {
    // Two routes to "pull more people into this collaboration room". A server
    // launch uses Discord's native invite dialog (an activity invite dropped in
    // the channel). A DM / group-DM launch has no such dialog — it throws — so it
    // uses the share-link modal instead, which lets the user send the Activity
    // link to the group / a friend or copy it; opening it joins this same
    // instance (same room). Both end at the same place, just different host UI.
    const inDm = get().context?.guildId == null;
    if (inDm) {
      try {
        const r = await shareActivityLink("Edit this Discord message with me in DWEEB ✏️");
        // The modal is a fire-and-forget share; only confirm when something
        // actually happened (the user may just close it). `success` covers a
        // send/copy on older clients that don't split out the two flags.
        if (r.didSendMessage) {
          pushToast("Invite sent — they'll join when they open it.", "success");
        } else if (r.didCopyLink) {
          pushToast("Link copied — paste it to invite people in.", "success");
        } else if (r.success) {
          pushToast("Invite shared ✓", "success");
        }
      } catch {
        // Host declined / unsupported — nothing actionable, stay quiet.
      }
      return;
    }
    try {
      await openInviteDialog();
    } catch {
      // Server launch but the user can't create invites here.
      pushToast("You need permission to create invites in this server.", "error");
    }
  },

  async openOnWeb() {
    const token = encodeShare(useMessageStore.getState().message);
    // Carry the draft in the share hash so the web app opens with it loaded —
    // and the contents stay client-side (the hash never reaches our server).
    const hashUrl = `${WEB_APP_BASE_URL}/#s=${token}`;
    let url = hashUrl;
    // A very large draft makes that hash URL too long for the host to open
    // reliably; fall back to an opt-in short link (uploads the snapshot, auto-
    // deletes server-side after 7 days) built against the *site* origin — the
    // short-link client's own builder would use the sandbox origin instead.
    if (hashUrl.length > WEB_HANDOFF_MAX_URL && isShortLinkConfigured()) {
      const short = await createShortLink(token);
      if (short.ok) url = `${WEB_APP_BASE_URL}/s/${short.id}`;
    }
    try {
      // The sandboxed iframe can't navigate to the site itself — hand the link
      // to the host client (same path as "View posted message").
      await openExternalLink(url);
    } catch {
      // The web app / dev URL-override aren't sandboxed, so a plain open works
      // there when the SDK path can't (a real in-Discord Activity needs the SDK).
      try {
        window.open(url, "_blank", "noopener");
      } catch {
        /* nothing more we can do */
      }
    }
  },

  setTargetChannel(channelId) {
    set({ targetChannelId: channelId });
  },

  setTargetGuild(guildId) {
    if (get().targetGuildId === guildId) return;
    // Switching destination drops the old channel pick and loads the new
    // server's channels + mapping data (which also re-resolves the preview). The
    // chosen server's meta (for the header indicator) is already in `guilds`.
    const meta = get().guilds.find((g) => g.id === guildId) ?? null;
    set({ targetGuildId: guildId, targetChannelId: null, targetGuildMeta: meta });
    void useGuildStore.getState().connect(guildId);
  },
}));

/** Load a server launch's launching-guild meta (name + icon) for the header's
 *  top-right server indicator. The bootstrap load carries roles/channels/emoji
 *  but not the guild's own name/icon, so this finds it in the user's guild list.
 *  Non-fatal: on failure the indicator just doesn't render. */
async function loadTargetGuildMeta(
  set: (partial: Partial<ActivityState>) => void,
  guildId: string,
): Promise<void> {
  try {
    const all = await fetchUserGuilds();
    const meta = all.find((g) => g.id === guildId);
    if (meta) set({ targetGuildMeta: meta });
  } catch {
    // Leave the indicator unrendered — it's context, not a blocker.
  }
}

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

/**
 * Reject if `p` doesn't settle within `ms`, with a message naming the `stage` so
 * a stalled launch reports *where* it stuck instead of spinning forever. Used to
 * bound every step of the SDK handshake — see the timeout constants above and the
 * prod-launch hang in `docs/activity.md`.
 */
function withTimeout<T>(p: Promise<T>, ms: number, stage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out while ${stage}. Try relaunching DWEEB.`)),
      ms,
    );
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Decode a raw restored Discord message into the editor's shape, turning the
 *  rare "this isn't a Components V2 payload" parse failure into a friendly error.
 *  (DWEEB only posts V2 messages, so this only trips on something genuinely odd.) */
function decodeRestored(raw: unknown): WebhookMessage {
  try {
    return attachEditorFields(raw);
  } catch {
    throw new Error("That message can't be opened in the editor — it isn't a DWEEB message.");
  }
}

/** A throwaway CSRF `state` for the authorize call. */
function cryptoState(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return Math.random().toString(36).slice(2);
  }
}
