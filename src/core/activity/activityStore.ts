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
import { DISCORD_CLIENT_ID, WEB_APP_BASE_URL, botInviteUrl } from "@/core/guild/config";
import { useGuildStore } from "@/core/guild/guildStore";
import { useAuthStore } from "@/core/auth/authStore";
import { fetchUserGuilds, type PickerGuild } from "@/core/guild/api";
import { customBotConfigUrl } from "@/core/guild/customBotLink";
import { useMessageStore } from "@/core/state/messageStore";
import type { WebhookMessage } from "@/core/schema/types";
import {
  encodeShare,
  createShortLink,
  isShortLinkConfigured,
  attachEditorFields,
} from "@/core/serialization";
import { buildWirePayload, parseMessageIdInput, prepareMessagePayload } from "@/core/webhook/send";
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
  schedulePostToChannel,
  type ActivityPostResult,
} from "./api";
import { browserTimezone } from "@/core/schedule/recurrence";
import { libraryEntryMessage } from "@/core/library/libraryStore";
import type { LibraryEntryView } from "@/core/library/api";
import { startCollab, stopCollab, broadcastTarget, type CollabParticipant } from "./collab";
import { setActivityToken } from "./runtime";
import { startHandshakeTrace } from "./telemetry";

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
  /** True once the shared editor has settled into its real starting content: the
   *  room's in-progress draft has synced in (via collab's `onHydrated`), or — for
   *  a fresh room where none is coming — a short grace has elapsed. The component
   *  list (and mobile mini-preview) hold a skeleton until this trips (see
   *  ActivityApp), so a joiner never sees the fresh-open default flash before the
   *  room's draft replaces it — while the bar/frame render live immediately. The
   *  preview additionally waits on the guild-data gate, folded in by the shell. */
  hydrated: boolean;
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
  /** True while a server launch's {@link targetGuildMeta} is being fetched, so the
   *  bar's server indicator can hold a skeleton instead of an empty gap. Only the
   *  guild-launch path sets this — a DM launch resolves its meta synchronously from
   *  the already-loaded postable list. */
  targetGuildMetaLoading: boolean;
  /** True on a server launch whose launching guild doesn't have the DWEEB bot —
   *  there's nothing to post into until it's added, and the guild bootstrap would
   *  just 404. Drives the bar's "Add DWEEB to this server" call-to-action instead
   *  of a dead-end error. Always false on a DM launch (its destination picker only
   *  lists servers that already have the bot) and while presence is still unknown
   *  (we stay optimistic then — the proxy is the real guard). */
  botMissing: boolean;
  /** An application id the server just confirmed connected as a custom bot (a
   *  live push from the connect callback over the collab socket). The post
   *  dialog consumes it — selecting the bot the instant OAuth completes, without
   *  polling or a focus event — then clears it via {@link clearConnectedBot}.
   *  Null when there's nothing pending. */
  connectedBot: string | null;
  /** Whether the signed-in user holds Manage Webhooks in {@link targetGuildId} —
   *  the gate `activity_post` enforces server-side. `null` while it's still being
   *  determined (a server launch's guild meta hasn't loaded yet, or it couldn't be
   *  resolved): the bar stays optimistic then, since the proxy is the real guard.
   *  `false` means the user can still edit and collaborate, but can't be the one to
   *  Post — the bar shows an "edit only" explainer instead of an enabled Post
   *  button, and a permitted teammate in the room does the posting. On a DM launch
   *  it's `true` once a server is picked: that list is pre-filtered to postable
   *  servers. */
  canPostToTarget: boolean | null;

  /** Run the SDK handshake and start the session. Safe to call once. */
  init(): Promise<void>;
  /** Post the current message into the chosen channel as a NEW message. Resolves
   *  with the post result on success (also stored as {@link lastPost}) so the
   *  caller can pop the success dialog, or null when it was guarded/failed (the
   *  failure is surfaced as a toast). `makePermanent` asks the proxy to also spend
   *  a never-expire slot on the new message (best-effort; the result reports how
   *  it went). `applicationId` posts as one of the server's connected custom bots
   *  instead of DWEEB (the confirm dialog's "Post as" choice); null = DWEEB. */
  publish(
    makePermanent?: boolean,
    applicationId?: string | null,
  ): Promise<ActivityPostResult | null>;
  /** Store the current message server-side to post LATER (one-time) into the
   *  chosen channel — the confirm dialog's "Schedule" choice. `startAt` is the
   *  fire time in unix seconds. Resolves with the validated fire time on
   *  success, or null when it was guarded/failed (surfaced as a toast). Always
   *  posts as DWEEB; managing/cancelling the schedule lives on the web. */
  schedule(startAt: number, makePermanent?: boolean): Promise<number | null>;
  /** PATCH the message last posted from this Activity with the current draft.
   *  Only meaningful while {@link lastPost} matches the chosen destination.
   *  Returns the result on success / null on failure, like {@link publish}. */
  update(): Promise<ActivityPostResult | null>;
  /** Pull a message DWEEB posted in the target channel back into the shared
   *  editor (`input` is a message id or a Discord message link). The proxy
   *  resolves the webhook, so — unlike the web app — no URL is needed. On success
   *  the editor is wired to update that message in place ({@link lastPost}).
   *  Throws with a user-facing message on failure so the caller can surface it. */
  restore(input: string): Promise<void>;
  /** Load a server-library entry into the shared editor (collab broadcasts it
   *  to the room). A posted entry in the target server also re-wires the
   *  toolbar to update that live message in place ({@link lastPost}), exactly
   *  like a restore. Returns false when the entry's payload couldn't be read
   *  (an unopenable seal), so the caller can say so. */
  loadLibraryEntry(entry: LibraryEntryView): boolean;
  /** Open the last posted message in Discord (the sandboxed iframe can't
   *  navigate to discord.com itself, so this goes through the SDK). */
  openLastPost(): Promise<void>;
  /** Pull more people into this collaboration room. Server launch → Discord's
   *  native invite dialog; DM / group-DM launch → the share-link modal (the
   *  invite dialog throws there). Both land joiners in this same instance. */
  invite(): Promise<void>;
  /** Hand off the current draft to the full web app (account menu, browser-local
   *  drafts, and other full-site management the embedded surface omits). Opens
   *  the public site with the draft carried in a share link. */
  openOnWeb(): Promise<void>;
  /** Open the web app's pricing page for a specific server. Embedded checkout is
   *  impossible (the Activity sandbox can't run Stripe), so upgrading happens on
   *  the site: this hands off to `/?plans=<guildId>`, which opens the pricing
   *  modal scoped to that server (signing the user in first if needed). */
  openPlansOnWeb(guildId: string): Promise<void>;
  /** Open the web app's custom-bot settings for the exact destination server.
   *  The web deep link signs in if needed, selects that guild, and opens its
   *  configuration dialog. */
  openCustomBotsOnWeb(guildId: string): Promise<void>;
  /** Open Discord's "Add to Server" flow for the launching guild so the user can
   *  add the missing DWEEB bot (see {@link botMissing}). Routes through the host
   *  SDK — the sandboxed iframe can't open discord.com itself — and pre-selects
   *  the launching server. Pairs with {@link recheckBot} once they're done. */
  addBotToServer(): Promise<void>;
  /** Re-check whether the bot has since been added to the launching guild, force-
   *  fresh (the proxy/Discord can lag a moment after an add). Clears
   *  {@link botMissing} and wires up the server's data once it's present. Silent
   *  by design: it's driven automatically (focus / visibility / poll — see the
   *  auto-recheck effect in ActivityBar), the persistent "Add DWEEB" CTA already
   *  signals a still-missing bot, and a success is confirmed by the bootstrap's
   *  own "Connected" toast. */
  recheckBot(): Promise<void>;
  /** Open Discord's "Add to Server" flow so the user can add DWEEB to another
   *  server — the DM-launch destination picker's "Add a server" action. Unlike
   *  {@link addBotToServer} it pre-selects nothing (a DM launch has no guild of
   *  its own), so the user picks any server they manage. Routes through the host
   *  SDK — the sandboxed iframe can't open discord.com itself. Pairs with
   *  {@link refreshPostableGuilds}, which the bar re-runs on return so the newly
   *  added server appears in the picker without a relaunch. */
  addServer(): Promise<void>;
  /** Re-fetch the DM-launch postable server list, force-fresh, and quietly swap
   *  it in (no loading flash) — used after {@link addServer} so a just-added
   *  server slots into the already-open picker. Failures keep the current list. */
  refreshPostableGuilds(): Promise<void>;
  /** Clear {@link connectedBot} once the post dialog has consumed the push. */
  clearConnectedBot(): void;
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
  hydrated: false,
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
  targetGuildMetaLoading: false,
  botMissing: false,
  canPostToTarget: null,
  connectedBot: null,

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
        // The override can't reach the proxy, so no collab room / guild bootstrap
        // runs — there's nothing to sync in. Reveal the builder straight away
        // rather than sitting on the skeleton until its grace/cap timer fires.
        hydrated: true,
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

    // Trace each handshake stage to the proxy (best-effort) so a stall in the
    // wild — where the in-Discord iframe has no reachable console — is visible in
    // the server logs, not just on the user's splash. Hoisted with `instanceId`
    // so the `catch` can name the stalling stage + context too.
    const trace = startHandshakeTrace();
    let instanceId: string | null = null;
    try {
      // Must precede any proxy call so requests are routed through the sandbox.
      configureUrlMappings();
      // First reliable beacon: fired *after* the URL mapping is configured, since
      // a pre-mapping proxy call can't leave the sandbox (CSP). A launch that
      // never reaches even this stalled before the app booted.
      trace.stage("starting", "reached");

      const sdk = getSdk();
      await withTimeout(sdk.ready(), READY_TIMEOUT_MS, "connecting to Discord");
      // Which client we're on, so the UI can apply the mobile-only safe-area
      // fallback (the native top bar's inset isn't populated until the first
      // layout change — see ActivityApp). `sdk.platform` is "mobile"/"desktop".
      const platform: ActivityPlatform = sdk.platform === "mobile" ? "mobile" : "desktop";
      set({ step: "sdk-ready", platform });
      trace.stage("sdk-ready", "reached", { platform });

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
      instanceId = sdk.instanceId;

      set({ step: "authorizing" });
      trace.stage("authorizing", "reached", { platform, instance: instanceId });
      const { code } = await withTimeout(
        authorizeActivity(sdk),
        AUTHORIZE_TIMEOUT_MS,
        "authorizing with Discord",
      );

      set({ step: "exchanging-token" });
      trace.stage("exchanging-token", "reached", { platform, instance: instanceId });
      const accessToken = await withTimeout(
        exchangeCode(code),
        EXCHANGE_TIMEOUT_MS,
        "exchanging the login code",
      );
      setActivityToken(accessToken);

      set({ step: "authenticating" });
      trace.stage("authenticating", "reached", { platform, instance: instanceId });
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
      // Handshake complete — the beacon that lets the server compute a launch
      // success rate and total time-to-ready alongside the stalls.
      trace.stage("done", "done", { platform, instance: instanceId });

      // Best-effort rich presence — friends see "Building a message in DWEEB" on
      // the user's profile. This command needs the `rpc.activities.write` scope,
      // which we deliberately don't request (a new authorize scope would perturb
      // the fragile handshake), so it silently no-ops without it and lights up
      // automatically if the scope is ever granted.
      void setActivityPresence("Building a message").catch(() => {});

      if (guildId) {
        // Server launch: resolve the launching server's display meta (name + icon
        // for the header indicator) AND whether the bot is even there, then — only
        // if it is — load its roles/channels/emoji for the preview and picker.
        // Gating the bootstrap on bot presence avoids a guaranteed 404 + dead-end
        // toast when the bot hasn't been added; the bar shows an "Add DWEEB" CTA
        // for that case instead (see `botMissing` / `loadTargetGuildMeta`).
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
        // Stamped onto our `focus` frames so peers can render per-node presence.
        self: { id: user.id, name: user.name, avatar: user.avatar },
        // Seed the room's shared destination with the launching channel (server
        // launch only) so a latecomer inherits it; null on a DM launch.
        targetChannelId: guildId ? channelId : null,
        onRoster: (participants) => set({ participants }),
        onConnectedChange: (collabConnected) => set({ collabConnected }),
        // A peer moved the shared destination — apply it locally WITHOUT
        // re-broadcasting (that would echo back to the room and loop).
        onTarget: (channelId) => {
          if (get().targetChannelId !== channelId) set({ targetChannelId: channelId });
        },
        // The room is full for the host's plan tier — keep editing solo.
        onRoomFull: (cap) =>
          pushToast(
            cap > 0
              ? `This room is full — the host's plan allows ${cap} live editors. You can keep editing on your own.`
              : "This collaboration room is full. You can keep editing on your own.",
            "info",
          ),
        // A custom bot's connect flow finished — surface it so the post dialog
        // selects it right away (see PostConfirm's consume effect).
        onBotConnected: (applicationId) => set({ connectedBot: applicationId }),
        // The room's initial content has settled — its in-progress draft synced
        // in, or (a fresh room) the connect grace elapsed with nothing coming.
        // Either way the editor now holds its real starting message, so let the
        // shell reveal the component list (see `hydrated`). Collab owns the timing
        // — it fires this after writing the draft to the store and, for a fresh
        // room, off a grace armed on socket connect (not launch), so a slow socket
        // can't reveal the fresh-open default before a draft arrives.
        onHydrated: () => {
          if (!get().hydrated) set({ hydrated: true });
        },
      });
    } catch (e) {
      stopCollab();
      const message =
        e instanceof Error ? e.message : "Couldn't start DWEEB inside Discord. Try relaunching.";
      // Record where it failed — the last stage we entered (`get().step`) is the
      // one that stalled. A per-stage timeout (`withTimeout`) is the fingerprint
      // of a silent hang, so it's reported distinctly from any other error.
      const timedOut = /timed out/i.test(message);
      trace.stage(get().step, timedOut ? "timeout" : "error", {
        platform: get().platform,
        instance: instanceId,
        detail: message,
      });
      set({ status: "error", error: message });
    }
  },

  async publish(makePermanent = false, applicationId: string | null = null) {
    const guildId = get().targetGuildId;
    if (!guildId) {
      pushToast("Pick a server to post to first.", "error");
      return null;
    }
    const channelId = get().targetChannelId;
    if (!channelId) {
      pushToast("Pick a channel to post to first.", "error");
      return null;
    }
    // Fail fast (and friendly) when we already know the user can't post here — the
    // proxy enforces the same gate, but this avoids a confusing server-error toast.
    if (get().canPostToTarget === false) {
      pushToast("You need the “Manage Webhooks” permission to post in this server.", "error");
      return null;
    }
    // Don't fire a post Discord would reject — validate the draft up front and
    // surface the count as a friendly toast rather than a raw server error. The
    // bar also disables Post while errors stand (see ActivityBar), so this mainly
    // guards non-UI paths and the race where a collaborator's edit invalidated the
    // draft between the click and here.
    const message = useMessageStore.getState().message;
    if (!guardValid(message, "post")) return null;
    if (get().publishing) return null;
    set({ publishing: true });
    try {
      // Resolve in-session uploads (`session://` blobs) into `attachment://`
      // references + the file bytes — the proxy forwards them to Discord as
      // multipart, exactly like the web builder's direct send.
      const { payload, files } = prepareMessagePayload(message);
      const result = await publishToChannel(
        guildId,
        channelId,
        payload,
        makePermanent,
        applicationId,
        files,
      );
      set({ lastPost: result });
      // Success is surfaced by the post-success dialog (see ActivityBar), so no
      // toast here — the two would be redundant.
      return result;
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Couldn't post the message.", "error");
      return null;
    } finally {
      set({ publishing: false });
    }
  },

  async schedule(startAt, makePermanent = false) {
    const guildId = get().targetGuildId;
    if (!guildId) {
      pushToast("Pick a server to post to first.", "error");
      return null;
    }
    const channelId = get().targetChannelId;
    if (!channelId) {
      pushToast("Pick a channel to post to first.", "error");
      return null;
    }
    // Same gate as a live post — the proxy enforces it too, this keeps the
    // failure friendly.
    if (get().canPostToTarget === false) {
      pushToast("You need the “Manage Webhooks” permission to post in this server.", "error");
      return null;
    }
    const message = useMessageStore.getState().message;
    if (!guardValid(message, "post")) return null;
    // Uploaded files exist only in this browser — the worker can't attach them
    // when the schedule fires later, so the post would land broken. (The proxy
    // re-guards this; mirrors the web app's schedule gate.)
    if (JSON.stringify(message).includes("session://")) {
      pushToast("Uploaded files can't be scheduled — use image/media URLs instead.", "error");
      return null;
    }
    if (get().publishing) return null;
    set({ publishing: true });
    try {
      const payload = buildWirePayload(message);
      // Cached "#channel · Server" so the web management list reads well.
      const channelName = useGuildStore.getState().data?.channelById[channelId]?.name;
      const serverName = get().targetGuildMeta?.name;
      const destLabel =
        channelName && serverName ? `#${channelName} · ${serverName}` : (serverName ?? undefined);
      const result = await schedulePostToChannel(
        guildId,
        channelId,
        payload,
        startAt,
        browserTimezone(),
        destLabel,
        makePermanent,
      );
      return result.next_run_at;
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Couldn't schedule the post.", "error");
      return null;
    } finally {
      set({ publishing: false });
    }
  },

  async update() {
    const last = get().lastPost;
    if (!last) {
      pushToast("Post the message first, then you can update it.", "error");
      return null;
    }
    // Same gate as a fresh post — bail early if we know the user can't post here.
    if (get().canPostToTarget === false) {
      pushToast("You need the “Manage Webhooks” permission to update messages here.", "error");
      return null;
    }
    // Same up-front validation as a fresh post — an edit to an invalid draft is
    // rejected by Discord just the same, so fail early and friendly.
    const message = useMessageStore.getState().message;
    if (!guardValid(message, "update")) return null;
    if (get().publishing) return null;
    set({ publishing: true });
    try {
      // Same upload resolution as a fresh post — an edit that (still) references
      // in-session files re-uploads them alongside the payload.
      const { payload, files } = prepareMessagePayload(message);
      // The update rides whichever identity authored the message — the
      // webhook (and custom bot, when it was one) from the original post.
      const result = await editPostedMessage(
        last.guild_id,
        last.channel_id,
        last.message_id,
        last.webhook_id ?? "",
        payload,
        last.application_id ?? null,
        files,
      );
      set({ lastPost: result });
      // The post-success dialog confirms it (see ActivityBar) — skip the toast.
      return result;
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Couldn't update the message.", "error");
      return null;
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
    // Restore reads through the channel's DWEEB webhook, so the proxy gates it on
    // Manage Webhooks too — surface that up front rather than as a server error.
    if (get().canPostToTarget === false) {
      throw new Error("You need the “Manage Webhooks” permission to restore a message here.");
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
      // (and the custom bot, when one authored it) so the next edit PATCHes it
      // in place under the same identity instead of posting a copy (same
      // affordance a fresh post leaves behind).
      set({
        lastPost: {
          message_id: result.message_id,
          channel_id: result.channel_id,
          guild_id: result.guild_id,
          url: result.url,
          webhook_id: result.webhook_id,
          application_id: result.application_id ?? null,
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

  loadLibraryEntry(entry) {
    const message = libraryEntryMessage(entry);
    if (!message) return false;
    // Load it into the shared editor — collab broadcasts the new draft to
    // everyone in the room, exactly like a restore.
    useMessageStore.getState().replaceMessage(message);
    // A posted entry that lives in the target server re-wires the toolbar to
    // update the live message in place. The Update button lights up once the
    // room's destination channel matches the message's channel (same rule as
    // after a fresh post); a draft just loads content.
    if (
      entry.label === "posted" &&
      entry.message_id &&
      entry.channel_id &&
      entry.guild_id === get().targetGuildId
    ) {
      set({
        lastPost: {
          message_id: entry.message_id,
          channel_id: entry.channel_id,
          guild_id: entry.guild_id,
          url: `https://discord.com/channels/${entry.guild_id}/${entry.channel_id}/${entry.message_id}`,
          webhook_id: entry.webhook_id ?? undefined,
          application_id: null,
        },
      });
      const onTarget = entry.channel_id === get().targetChannelId;
      pushToast(
        onTarget
          ? "Loaded from the library. Edits will update this message ✓"
          : "Loaded from the library — switch to its channel to update it in place.",
        "success",
      );
    } else {
      pushToast("Loaded from the server library.", "success");
    }
    return true;
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
    // Carry the server this draft is bound to (the launching guild, or the
    // destination the user picked on a DM launch). The web app parks it as a
    // pending guild and — once the visitor's Discord sign-in resolves there —
    // auto-connects the editor straight to that server, so "Open on web" lands
    // back on the same Discord server you were building for (its roles/channels/
    // mentions resolve) instead of whatever server the browser last used. It's
    // best-effort: a signed-out visitor just keeps the parked hint, and a
    // non-member's connect fails quietly. Rides in the hash (`g=`), so it stays
    // client-side and is readable before a short-link token is even fetched —
    // see `readShareGuildFromHash` / `pendingGuild.ts` / the AccountMenu.
    const guildId = get().targetGuildId ?? get().context?.guildId ?? null;
    const guildHash = guildId ? `&g=${encodeURIComponent(guildId)}` : "";
    // Carry the draft in the share hash so the web app opens with it loaded —
    // and the contents stay client-side (the hash never reaches our server).
    const hashUrl = `${WEB_APP_BASE_URL}/#s=${token}${guildHash}`;
    let url = hashUrl;
    // A very large draft makes that hash URL too long for the host to open
    // reliably; fall back to an opt-in short link (uploads the snapshot, auto-
    // deletes server-side after 7 days) built against the *site* origin — the
    // short-link client's own builder would use the sandbox origin instead. The
    // server hint still rides in the hash (read client-side before the token is
    // fetched), so the auto-connect works on this path too.
    if (hashUrl.length > WEB_HANDOFF_MAX_URL && isShortLinkConfigured()) {
      const short = await createShortLink(token);
      if (short.ok) {
        url = `${WEB_APP_BASE_URL}/s/${short.id}${guildId ? `#g=${encodeURIComponent(guildId)}` : ""}`;
      }
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

  async openPlansOnWeb(guildId: string) {
    // Deep-link the web app straight to this server's pricing modal. No draft is
    // carried — upgrading is a side-trip; the draft stays live here (and in the
    // server-side collab room) for when they return.
    const url = `${WEB_APP_BASE_URL}/?plans=${encodeURIComponent(guildId)}`;
    try {
      // The sandboxed iframe can't navigate to the site itself — hand the link to
      // the host client (same path as "Open on web").
      await openExternalLink(url);
    } catch {
      // The web app / dev URL-override aren't sandboxed, so a plain open works.
      try {
        window.open(url, "_blank", "noopener");
      } catch {
        /* nothing more we can do */
      }
    }
  },

  async openCustomBotsOnWeb(guildId: string) {
    const url = customBotConfigUrl(WEB_APP_BASE_URL, guildId);
    try {
      // A real Activity is sandboxed, so external navigation must go through
      // Discord's host client. The fallback keeps local URL-override dev useful.
      await openExternalLink(url);
    } catch {
      try {
        window.open(url, "_blank", "noopener");
      } catch {
        /* nothing more we can do */
      }
    }
  },

  async addBotToServer() {
    const guildId = get().context?.guildId ?? undefined;
    // Pre-select the launching server in Discord's picker, and omit the redirect
    // (the sandbox origin isn't a registered redirect URI — see `botInviteUrl`).
    const url = botInviteUrl(guildId, { redirect: false });
    if (!url) {
      pushToast("Adding the bot isn't available in this build.", "error");
      return;
    }
    try {
      // The sandboxed iframe can't open discord.com itself — hand it to the host.
      await openExternalLink(url);
      pushToast('Add DWEEB in the window that opened, then tap "Check again".', "info");
    } catch {
      // The web app / dev URL-override aren't sandboxed, so a plain open works
      // there when the SDK path can't.
      try {
        window.open(url, "_blank", "noopener");
      } catch {
        /* nothing more we can do */
      }
    }
  },

  async recheckBot() {
    const guildId = get().context?.guildId;
    if (!guildId || get().targetGuildMetaLoading) return;
    // Force-fresh: a just-added bot may not show in the proxy's cached guild list
    // yet. `loadTargetGuildMeta` clears `botMissing` and connects when it's now
    // present — the CTA gives way to the bar and the bootstrap's "Connected" toast
    // confirms it, so there's nothing to surface on a still-missing check.
    await loadTargetGuildMeta(set, guildId, true);
  },

  async addServer() {
    // Generic "add DWEEB to a server" for the DM-launch destination picker — no
    // pre-selected guild (a DM launch has none of its own), so the user picks any
    // server they manage. Same host-SDK external open as `addBotToServer`.
    const url = botInviteUrl(undefined, { redirect: false });
    if (!url) {
      pushToast("Adding the bot isn't available in this build.", "error");
      return;
    }
    try {
      // The sandboxed iframe can't open discord.com itself — hand it to the host.
      await openExternalLink(url);
      pushToast("Add DWEEB in the window that opened — it'll appear here once you do.", "info");
    } catch {
      // The web app / dev URL-override aren't sandboxed, so a plain open works.
      try {
        window.open(url, "_blank", "noopener");
      } catch {
        /* nothing more we can do */
      }
    }
  },

  async refreshPostableGuilds() {
    // Quiet, force-fresh re-fetch (no `guildsLoading` flash) so a just-added
    // server slots into the already-open picker. A just-added bot may not be in
    // the proxy's cached list yet, hence force-fresh. Keep the shown list on error.
    try {
      const all = await fetchUserGuilds(true);
      seedAuthGuilds(all);
      set({ guilds: all.filter((g) => g.bot_present && g.can_manage_webhooks) });
    } catch {
      /* transient — keep whatever's already listed */
    }
  },

  clearConnectedBot() {
    if (get().connectedBot !== null) set({ connectedBot: null });
  },

  setTargetChannel(channelId) {
    set({ targetChannelId: channelId });
    // On a server launch the destination is shared: tell the room so everyone's
    // editor re-points to the same channel. No-op on a DM launch (collaborators
    // don't share a postable server) — see `broadcastTarget`. Skip the broadcast
    // for an edit-only user: moving a shared destination is a posting decision, so
    // only someone who can post may re-point the room (the picker is read-only for
    // them too — this guards the path as defence in depth).
    if (get().canPostToTarget !== false) broadcastTarget(channelId);
  },

  setTargetGuild(guildId) {
    if (get().targetGuildId === guildId) return;
    // Switching destination drops the old channel pick and loads the new
    // server's channels + mapping data (which also re-resolves the preview). The
    // chosen server's meta (for the header indicator) is already in `guilds`.
    const meta = get().guilds.find((g) => g.id === guildId) ?? null;
    set({
      targetGuildId: guildId,
      targetChannelId: null,
      targetGuildMeta: meta,
      // `guilds` is pre-filtered to servers the user can post to (see
      // `loadPostableGuilds`), so a picked one is postable by construction.
      canPostToTarget: true,
    });
    void useGuildStore.getState().connect(guildId);
  },
}));

/** Load a server launch's launching-guild meta (name + icon) for the header's
 *  top-right server indicator, resolve whether the user can post there, and —
 *  only when the bot is actually present — kick off the guild bootstrap
 *  (roles/channels/emoji for the preview + channel picker). The bootstrap can't
 *  carry the guild's own name/icon, the caller's permission, or bot presence, so
 *  all three are read off the user's guild list here.
 *
 *  When we *positively* learn the bot is absent we set {@link ActivityState.botMissing}
 *  and skip the bootstrap (it would just 404 with a dead-end toast) — the bar
 *  shows an "Add DWEEB" CTA instead. When presence can't be resolved (fetch
 *  failed / the guild isn't in the list) we stay optimistic and load the
 *  bootstrap anyway, exactly as before — the proxy is the real guard.
 *
 *  Pass `force` (the "Check again" re-check) to bypass the proxy's cached guild
 *  list, since a just-added bot may not show in it yet. */
async function loadTargetGuildMeta(
  set: (partial: Partial<ActivityState>) => void,
  guildId: string,
  force = false,
): Promise<void> {
  set({ targetGuildMetaLoading: true });
  // Optimistic default: if we can't tell whether the bot is there, behave as
  // before and load the bootstrap. Only a *known* absence diverts to the CTA.
  let botPresent = true;
  try {
    const all = await fetchUserGuilds(force);
    seedAuthGuilds(all);
    const meta = all.find((g) => g.id === guildId);
    if (meta) {
      botPresent = meta.bot_present;
      set({
        targetGuildMeta: meta,
        botMissing: !botPresent,
        // No bot ⇒ nothing to post into. Otherwise honour the perm flag (absent
        // → no access, the same convention the Webhook Manager uses).
        canPostToTarget: botPresent ? (meta.can_manage_webhooks ?? false) : false,
      });
    }
  } catch {
    // Leave the indicator unrendered — it's context, not a blocker.
  } finally {
    // Clear loading either way: on failure the badge falls back to nothing rather
    // than holding a perpetual skeleton.
    set({ targetGuildMetaLoading: false });
    // Load the server's data unless we know the bot's missing (that fetch just
    // 404s, and the "Add DWEEB" CTA covers the case). This also wires up the
    // preview/picker when a "Check again" finds the bot was finally added.
    if (botPresent) void useGuildStore.getState().connect(guildId);
  }
}

/**
 * Make the user's server list visible to the shared cross-server emoji picker
 * (`features/guild/MentionPicker`), which sources its servers from the auth
 * store's `guilds`. The Activity authenticates with a bearer token and never
 * runs the auth store's cookie-session bootstrap, so without this its guild list
 * stays empty inside Discord and the emoji picker shows only its by-ID fallback
 * ("Connect a server to pick its emoji"). We piggyback on the guild list the
 * launch already fetches rather than firing a second request.
 */
function seedAuthGuilds(all: PickerGuild[]): void {
  useAuthStore.setState({ guilds: all, guildsStatus: "ready", guildsError: null });
}

/** Load the user's postable servers for a DM launch — those where the DWEEB bot
 *  is present and the user holds Manage Webhooks (the gate the post enforces).
 *  Failures are non-fatal: the picker just shows its empty state. */
async function loadPostableGuilds(set: (partial: Partial<ActivityState>) => void): Promise<void> {
  set({ guildsLoading: true });
  try {
    const all = await fetchUserGuilds();
    seedAuthGuilds(all);
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

/**
 * Block a post/update when the draft carries validation errors Discord would
 * reject, surfacing the count as a friendly toast instead of a raw server error.
 * Returns true when it's safe to send. Warnings don't block (Discord accepts
 * them); only `error`-severity issues do — matching the Send gate on the web app.
 */
function guardValid(message: WebhookMessage, action: "post" | "update"): boolean {
  const { ok, issues } = validateMessage(message);
  if (ok) return true;
  const errors = issues.filter((i) => i.severity === "error").length;
  const verb = action === "post" ? "posting" : "updating";
  pushToast(
    `Fix ${errors} ${errors === 1 ? "issue" : "issues"} before ${verb} — check the highlighted components.`,
    "error",
  );
  return false;
}

/**
 * Run the Embedded App SDK's `authorize`, requesting the rich-presence scope
 * (`rpc.activities.write`) alongside the two the session actually needs
 * (`identify` for who's editing, `guilds` for the membership/permission gate).
 *
 * The presence scope is what lets `setActivityPresence` light up "Building a
 * message in DWEEB" on the editor's profile. It was historically left off to
 * avoid perturbing a launch handshake that used to hang — but every stage is now
 * timeout-bounded (see the constants above), so it's safe to ask for. Even so we
 * stay defensive: if `authorize` *rejects* with the presence scope (an account
 * or app config where it isn't grantable under `prompt: "none"`), we retry once
 * with just the essential scopes, so presence being unavailable can never turn
 * into a failed launch. A rejection returns fast; a genuine hang is caught by the
 * caller's timeout, not here.
 */
async function authorizeActivity(sdk: ReturnType<typeof getSdk>): Promise<{ code: string }> {
  const base = {
    client_id: DISCORD_CLIENT_ID,
    response_type: "code" as const,
    state: cryptoState(),
    prompt: "none" as const,
  };
  type Scope = "identify" | "guilds" | "rpc.activities.write";
  try {
    return await sdk.commands.authorize({
      ...base,
      scope: ["identify", "guilds", "rpc.activities.write"] as Scope[],
    });
  } catch {
    // Presence scope not grantable here — fall back to the essentials so the
    // launch still succeeds (presence simply stays off, exactly as before).
    return await sdk.commands.authorize({
      ...base,
      scope: ["identify", "guilds"] as Scope[],
    });
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
