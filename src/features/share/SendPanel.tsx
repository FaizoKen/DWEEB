/**
 * "Send" panel — POSTs the current message directly to a Discord webhook,
 * or PATCHes the original when the editor was populated from a restore.
 *
 * Mode logic:
 *  - The "Send as new" / "Update existing" toggle is always available, so a
 *    message this webhook already posted can be edited in place (PATCH) without
 *    restoring it first: pick "Update existing", paste the message ID/link, and
 *    the current editor content replaces the original.
 *  - "Send as new" (default) POSTs a brand-new message.
 *  - When the user just restored a message via the Restore tab, the store's
 *    `restoredFrom` field is set, the panel defaults to "Update existing", and
 *    the webhook + message ID are pre-filled from that restore. Switching to
 *    "Send as new" just ignores the restore origin for the next click; it
 *    doesn't clear it (so they can still hit Update later).
 *  - After a successful send, the posted message is recorded as the restore
 *    origin too, so the panel flips to "Update existing" pre-filled with the
 *    webhook + new message id (+ thread) — clicking send again edits the live
 *    message in place instead of posting a duplicate.
 *
 * A webhook PATCH replaces the whole message, so when updating without a
 * restore we warn that anything not rebuilt in the editor is overwritten.
 *
 * Messages with interactive components decide permanence in the confirm
 * dialog: slot state is fetched when the confirm opens, and the "Make
 * permanent" switch claims a slot — or, when the update target already holds
 * one, starts on and releases it when turned off. When every slot is taken
 * the switch gives way to a "Free a slot" button that closes the whole send
 * stack (confirm + Share dialog) and opens the "Managed messages" dialog,
 * which owns slot freeing. The claim/release runs right after the
 * send succeeds — permanence is keyed to the message id, which only exists
 * then — and never fails the send; the success dialog shows a read-only
 * receipt of the final state, with any failure attached.
 *
 * Before posting, the panel confirms who owns the webhook (a GET) whenever the
 * owner isn't already known from a prior check or saved entry. That keeps the
 * "this webhook isn't app-owned" block from being missed on a freshly-typed
 * URL — Discord rejects interactive components sent through a person/follower
 * webhook, so we catch it here instead of after the send bounces.
 *
 * Bot-owned isn't always enough either. Discord delivers component clicks to
 * the app that OWNS the webhook, so components bound to DWEEB plugins
 * (custom_ids the dispatcher routes) only respond when that app is DWEEB
 * itself or a custom bot registered for the server. The routing verdict only
 * fires for plugin-bound components — a hand-written custom_id aimed at someone
 * else's bot is a legitimate use and gets only the generic "the bot's backend
 * handles this" info note. So when a plugin-bound component's webhook is owned
 * by an unrelated app ("foreign"), it is provably dead — pure false traffic —
 * and the Send button is blocked (a banner here with a Remove action, plus a
 * notice in the confirm). A fresh URL, whose owner is only verified
 * mid-confirm, gets a one-time halt that then leaves the button disabled. The
 * signed-out "unverified" case is handled separately by requiring sign-in (see
 * `mustSignInToRouteCheck`); an authed-but-uncheckable "unverified" stays a
 * soft caution, since it can't be proven dead.
 *
 * A guild-scoped plugin binding (Self Role et al.) is a harder case: it only
 * works in the server it was set up for, so posting it to a webhook in another
 * server leaves every click dead ("this menu was set up for a different
 * server") — pure false traffic, never a legitimate use. So unlike the routing
 * warning this is a *block*: plugins surface their target guild on save (cached
 * per binding), and when it differs from the destination webhook's guild the
 * Send button is disabled (banner here + notice in the confirm). A fresh URL,
 * whose guild we only learn mid-confirm, gets a one-time halt that then leaves
 * the button disabled. Bindings whose guild isn't cached are skipped, so it
 * never false-positives; the fix is to reconfigure the menu (which recaches the
 * real guild) or post through a webhook in the right server.
 *
 * The webhook URL is treated as a credential:
 *  - The input uses `<TextInput masked>` (CSS dot masking, not
 *    `type="password"`) plus a show/hide toggle, so it doesn't appear in screen
 *    shares by default. We deliberately avoid `type="password"` because
 *    browsers offer to *save* password fields to the password manager (ignoring
 *    `autoComplete="off"`), which we don't want for a per-message token. The
 *    `masked` prop also opts the field out of autofill / password managers.
 *  - A successful send saves the webhook to history (this browser only); the
 *    "Save webhook" button does the same up front. Both record who owns it.
 *
 * The send call is cancellable via AbortController. A second click while a
 * send is in flight aborts the first.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { useAuthStore } from "@/core/auth/authStore";
import { useGuildStore } from "@/core/guild/guildStore";
import { getAttachmentSnapshot, subscribeAttachments } from "@/core/state/attachmentStore";
import { validateMessage } from "@/core/schema/validation";
import { inspectCapabilities } from "@/core/schema/capability";
import { summarizePings } from "@/core/schema/mentions";
import {
  classifyComponentRouting,
  classifyWebhookOwner,
  forgetWebhook,
  loadHistory,
  parseMessageIdInput,
  parseWebhookUrl,
  rememberWebhook,
  sendToWebhook,
  updateWebhookMessage,
  verifyWebhook,
  webhookAvatarHash,
  webhookChannelId,
  webhookGuildId,
  type ComponentRouting,
  type WebhookHistoryEntry,
  type WebhookOwner,
  type WebhookOwnerKind,
} from "@/core/webhook";
import { getPlugins } from "@/core/plugins/registry";
import { pluginBoundComponents } from "@/core/plugins/targets";
import { getPluginBindingGuild } from "@/core/state/pluginSummaryCache";
import {
  addPermanentMessage,
  createCustomBotWebhook,
  fetchCustomBots,
  fetchPermanentSlots,
  isAuthError,
  removePermanentMessage,
  type CustomBotItem,
  type PermanentSlots,
} from "@/core/guild/api";
import { useManagedMessagesStore } from "@/core/guild/managedMessagesStore";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { TextInput } from "@/ui/TextInput";
import { LockIcon, PlusIcon } from "@/ui/Icon";
import { pushToast } from "@/ui/Toast";
import { cn } from "@/lib/cn";
import {
  DISCORD_CLIENT_ID,
  isProxyConfigured,
  webhookCreateUrl,
  type IncomingWebhook,
} from "@/core/guild/config";
import { WebhookRecents } from "./WebhookRecents";
import { SendConfirm } from "./SendConfirm";
import { SendSuccess } from "./SendSuccess";
import type { PermanentStatusProps } from "./PermanentStatus";
import { Callout } from "./Callout";
import styles from "./SendPanel.module.css";

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "error"; message: string; retryAfter?: number; status?: number; body?: unknown };

/** Destination + deep link captured after a successful send, for `SendSuccess`. */
interface SendSuccessInfo {
  mode: "new" | "update";
  webhookName?: string;
  webhookId?: string;
  webhookAvatar?: string | null;
  guildId?: string;
  channelId?: string;
  guildName?: string;
  channelName?: string;
  /** Deep link to the message (or its channel); null when unresolved. */
  discordUrl: string | null;
  /**
   * True when the panel re-targeted itself at the posted message (the restore
   * origin was recorded), so clicking send again edits it in place. The success
   * dialog surfaces this as a note after a "new" post.
   */
  editOnResend: boolean;
  /** The posted/edited message's id, when the response carried it. */
  messageId?: string;
  /** Read-only component-expiry receipt for the success dialog — how the
   *  confirm dialog's permanence decision ended up. Undefined hides it. */
  permanentStatus?: Omit<PermanentStatusProps, "messageId">;
}

/** Pull the new message's snowflake from a Discord response (POST wait=true / PATCH). */
function messageIdFromBody(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const id = (body as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}

/** Channel id echoed back on a Discord message body — a fallback destination. */
function channelIdFromBody(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const id = (body as { channel_id?: unknown }).channel_id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}

/** Pretty-print a Discord error body for the raw-response view. */
function formatRawBody(body: unknown): string {
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return String(body);
  }
}

export function SendPanel({
  onRequestRemoveInteractive,
  initialWebhook,
  onCloseDialog,
}: {
  /**
   * Asked when the user clicks "Remove them" on the app-owned-webhook block.
   * The App closes the dialog and pops a confirmation over the editor.
   */
  onRequestRemoveInteractive?: () => void;
  /**
   * A webhook just created via Discord's `webhook.incoming` flow and handed back
   * through the redirect (URL + resolved destination names). When present it
   * prefills the field and is verified + saved on mount, so the user lands ready
   * to send.
   */
  initialWebhook?: IncomingWebhook;
  /**
   * Closes the Share dialog hosting this panel. Used by the confirm's
   * "Free a slot" hand-off, which drops the whole send stack before opening
   * the "Managed messages" dialog.
   */
  onCloseDialog?: () => void;
} = {}) {
  const message = useMessageStore((s) => s.message);
  const restoredFrom = useMessageStore((s) => s.restoredFrom);
  const setRestoreOrigin = useMessageStore((s) => s.setRestoreOrigin);

  // Prefill from a just-created webhook (the `webhook.incoming` return) first,
  // else the restore origin; otherwise start empty.
  const [url, setUrl] = useState(() => initialWebhook?.url ?? restoredFrom?.webhookUrl ?? "");
  const [threadId, setThreadId] = useState(() => restoredFrom?.threadId ?? "");
  const [messageIdInput, setMessageIdInput] = useState(() => restoredFrom?.messageId ?? "");
  const [mode, setMode] = useState<"new" | "update">(() => (restoredFrom ? "update" : "new"));
  const [revealUrl, setRevealUrl] = useState(false);
  const [history, setHistory] = useState<WebhookHistoryEntry[]>(() => loadHistory());
  const [state, setState] = useState<SendState>({ kind: "idle" });
  const [showRaw, setShowRaw] = useState(false);
  const [saving, setSaving] = useState(false);
  // Pre-send confirmation. Opened by `handleSend` once inputs validate; the
  // actual POST/PATCH runs from `handleConfirmedSend` when the user confirms.
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Permanent-slot state fetched when the confirm opens (interactive message,
  // signed in, guild known). Null until it resolves — the confirm's "Make
  // permanent" control only renders on a successful fetch, and the success
  // dialog's receipt degrades to a generic expiry note.
  const [confirmSlots, setConfirmSlots] = useState<PermanentSlots | null>(null);
  // The fetch answered 501: this deployment doesn't run the feature at all,
  // so even the generic expiry note would be wrong.
  const [slotsUnavailable, setSlotsUnavailable] = useState(false);
  // The switch itself: where the message should end up. Initialised to the
  // update target's current state, so on = claim a slot after the send,
  // off on an already-permanent target = release it ("set back to temporary").
  const [makePermanent, setMakePermanent] = useState(false);
  // Post-send result dialog — confirms delivery and offers a deep link straight
  // to the message in Discord. Null when closed.
  const [success, setSuccess] = useState<SendSuccessInfo | null>(null);
  // True while a confirmed send is in flight. Keeps the confirm dialog open with
  // a loading button instead of closing it the instant "Post" is clicked.
  const [confirmBusy, setConfirmBusy] = useState(false);
  // Result of the last "Save webhook" verify GET — used to show who owns the
  // webhook (bot vs. person) and where it posts (guild/channel) before any
  // message is sent.
  const [verified, setVerified] = useState<{
    name: string;
    owner: WebhookOwner;
    channelId?: string;
    guildId?: string;
  } | null>(null);
  // Custom-bot registrations for the webhook's guild — fetched only while the
  // plugin-routing question is open (see `routingCheckable` below). `failed`
  // parks the verdict at "unverified" instead of retry-looping the fetch.
  const [registeredApps, setRegisteredApps] = useState<{
    guildId: string;
    ids: string[];
  } | null>(null);
  const [registeredAppsFailed, setRegisteredAppsFailed] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const saveAbortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      saveAbortRef.current?.abort();
    },
    [],
  );

  // Mirror the store's origin into the form whenever it changes: a restore
  // made while the panel is open (user switched to the Restore tab, fetched,
  // and came back), or this panel's own successful send re-targeting the form
  // at the message that's now live.
  useEffect(() => {
    if (!restoredFrom) return;
    setUrl(restoredFrom.webhookUrl);
    setMessageIdInput(restoredFrom.messageId);
    setThreadId(restoredFrom.threadId ?? "");
    setMode("update");
  }, [restoredFrom]);

  const parsedUrl = useMemo(() => parseWebhookUrl(url), [url]);
  const urlInvalid = url.trim().length > 0 && !parsedUrl;

  // A verified result only describes the URL it was fetched for; editing the
  // URL (or restoring a different one) invalidates it.
  useEffect(() => setVerified(null), [url]);

  const parsedMessageId = useMemo(() => parseMessageIdInput(messageIdInput), [messageIdInput]);
  const messageIdInvalid =
    mode === "update" && messageIdInput.trim().length > 0 && !parsedMessageId;

  // Validation reads the attachment registry (a missing blob blocks send), so
  // recompute when blobs hydrate from IndexedDB / are added / GC'd — not only
  // when the message changes. Otherwise a restored upload would stay flagged.
  const attachmentsVersion = useSyncExternalStore(
    subscribeAttachments,
    getAttachmentSnapshot,
    getAttachmentSnapshot,
  );
  const validation = useMemo(() => validateMessage(message), [message, attachmentsVersion]);
  const blockingIssues = validation.issues.filter((i) => i.severity === "error");

  // Who the message will actually ping, after applying allowed_mentions. Shown
  // in the confirmation dialog so the blast radius is visible before sending.
  const pings = useMemo(() => summarizePings(message), [message]);

  const capabilities = useMemo(
    () => inspectCapabilities(message, { threadIdProvided: threadId.trim().length > 0 }),
    [message, threadId],
  );

  // Best-known owner for the URL currently entered: a fresh verify result, or
  // the kind we persisted on a saved (recents) entry. Undefined until verified.
  const knownOwnerKind: WebhookOwnerKind | undefined = useMemo(() => {
    if (verified) return verified.owner.kind;
    if (!parsedUrl) return undefined;
    return history.find((e) => e.id === parsedUrl.id)?.ownerKind;
  }, [verified, parsedUrl, history]);

  // The owning app's id, same sources as `knownOwnerKind`. Only meaningful
  // when that kind is "bot"; undefined until verified (or on older saved
  // entries from before the field existed).
  const knownApplicationId = useMemo(() => {
    if (verified) return verified.owner.applicationId ?? undefined;
    if (!parsedUrl) return undefined;
    return history.find((e) => e.id === parsedUrl.id)?.applicationId;
  }, [verified, parsedUrl, history]);

  // Whether the URL in the field is a saved webhook a health check found gone
  // on Discord (deleted / token revoked). Posting to it can only 404, so this
  // hard-blocks the send. Recomputes live if the check flags it while the dialog
  // is open (the recents list reloads our `history` on change).
  const knownGone = useMemo(() => {
    if (!parsedUrl) return false;
    return history.find((e) => e.id === parsedUrl.id)?.deletedAt != null;
  }, [parsedUrl, history]);

  // Best-known display name for the URL — from a fresh verify or a saved entry —
  // so the ownership banners can name the webhook instead of "this webhook".
  const knownName = useMemo(() => {
    if (verified?.name) return verified.name;
    if (!parsedUrl) return undefined;
    return history.find((e) => e.id === parsedUrl.id)?.name || undefined;
  }, [verified, parsedUrl, history]);

  // Avatar hash for the URL, from a saved entry. Undefined for a freshly-typed
  // webhook (only verified on confirm) — the confirm dialog then shows Discord's
  // default avatar.
  const knownAvatar = useMemo(() => {
    if (!parsedUrl) return undefined;
    return history.find((e) => e.id === parsedUrl.id)?.avatar ?? undefined;
  }, [parsedUrl, history]);

  // Where the webhook posts — from a fresh verify or a saved entry. Shown in the
  // confirm dialog so the destination is explicit; undefined until verified for
  // a freshly-typed URL (resolved on confirm, same as ownership).
  const knownChannelId = useMemo(() => {
    if (verified?.channelId) return verified.channelId;
    if (!parsedUrl) return undefined;
    return history.find((e) => e.id === parsedUrl.id)?.channelId;
  }, [verified, parsedUrl, history]);

  const knownGuildId = useMemo(() => {
    if (verified?.guildId) return verified.guildId;
    if (!parsedUrl) return undefined;
    return history.find((e) => e.id === parsedUrl.id)?.guildId;
  }, [verified, parsedUrl, history]);

  // Human names for the destination, so the confirm dialog reads "#general ·
  // Faizo's server" instead of raw snowflakes. Prefer the names saved on the
  // entry (resolved at creation); fall back to live data — the server from the
  // signed-in guild list, the channel from the connected guild.
  const authGuilds = useAuthStore((s) => s.guilds);
  const authStatus = useAuthStore((s) => s.status);
  const login = useAuthStore((s) => s.login);
  const connectedData = useGuildStore((s) => s.data);

  const knownGuildName = useMemo(() => {
    const stored = parsedUrl ? history.find((e) => e.id === parsedUrl.id)?.guildName : undefined;
    if (stored) return stored;
    return knownGuildId ? authGuilds.find((g) => g.id === knownGuildId)?.name : undefined;
  }, [parsedUrl, history, authGuilds, knownGuildId]);

  const knownChannelName = useMemo(() => {
    const stored = parsedUrl ? history.find((e) => e.id === parsedUrl.id)?.channelName : undefined;
    if (stored) return stored;
    return knownChannelId ? connectedData?.channelById[knownChannelId]?.name : undefined;
  }, [parsedUrl, history, connectedData, knownChannelId]);

  // The capability inspector flags interactive components, but what that flag
  // means depends on who owns the webhook:
  //  - person/follower → hard block: Discord rejects the send outright.
  //  - app/bot         → satisfied: Discord accepts them, so the generic
  //                      "needs an app-owned webhook" warning is just noise.
  //                      Swap it for a calmer note explaining that the clicks
  //                      are actually handled by the bot's own backend.
  const appWebhookNote = capabilities.find((c) => c.kind === "app_webhook");
  const ownershipBlocked =
    appWebhookNote != null && (knownOwnerKind === "user" || knownOwnerKind === "follower");
  const ownershipSatisfied = appWebhookNote != null && knownOwnerKind === "bot";

  // Don't say the same thing twice: a dedicated banner (blocked or app-owned)
  // supersedes the generic capability note.
  const visibleCapabilities =
    ownershipBlocked || ownershipSatisfied
      ? capabilities.filter((c) => c.kind !== "app_webhook")
      : capabilities;

  // Interactive components whose custom_id belongs to a bundled plugin. These
  // only respond when the webhook's owning app routes clicks to the DWEEB
  // dispatcher, so a generic "app-owned" pass isn't enough — they get their
  // own routing verdict below.
  const pluginBound = useMemo(() => pluginBoundComponents(getPlugins(), message), [message]);
  const pluginNames = useMemo(
    () => [...new Set(pluginBound.map((b) => b.plugin.name))],
    [pluginBound],
  );

  // The routing question is open when plugin-bound components head to a
  // bot-owned webhook that isn't DWEEB's own app — and answerable only with a
  // guild to ask about and a signed-in session to ask with.
  const routingInQuestion =
    pluginBound.length > 0 &&
    knownOwnerKind === "bot" &&
    knownApplicationId != null &&
    knownApplicationId !== DISCORD_CLIENT_ID;
  const routingCheckable =
    routingInQuestion && knownGuildId != null && isProxyConfigured() && authStatus === "authed";

  useEffect(() => {
    if (!routingCheckable || !knownGuildId) return;
    if (registeredApps?.guildId === knownGuildId) return; // already resolved for this guild
    setRegisteredAppsFailed(false);
    const ac = new AbortController();
    fetchCustomBots(knownGuildId, ac.signal)
      .then((bots) =>
        setRegisteredApps({ guildId: knownGuildId, ids: bots.items.map((i) => i.application_id) }),
      )
      .catch(() => {
        if (!ac.signal.aborted) setRegisteredAppsFailed(true);
      });
    return () => ac.abort();
  }, [routingCheckable, knownGuildId, registeredApps]);

  // Where this message's plugin-bound components will deliver their clicks.
  // Undefined while there's nothing to judge (no plugin components, ownership
  // unknown until confirm) or while the registration fetch is still in
  // flight — the callouts and the confirm dialog only render on a verdict.
  const componentRouting: ComponentRouting | undefined = useMemo(() => {
    if (pluginBound.length === 0 || knownOwnerKind !== "bot" || !knownApplicationId) {
      return undefined;
    }
    const resolvedIds =
      registeredApps != null && registeredApps.guildId === knownGuildId ? registeredApps.ids : null;
    if (
      knownApplicationId !== DISCORD_CLIENT_ID &&
      resolvedIds === null &&
      routingCheckable &&
      !registeredAppsFailed
    ) {
      return undefined; // check in flight — hold the verdict
    }
    return classifyComponentRouting({
      applicationId: knownApplicationId,
      dweebApplicationId: DISCORD_CLIENT_ID,
      customBotIds: resolvedIds,
    });
  }, [
    pluginBound,
    knownOwnerKind,
    knownApplicationId,
    knownGuildId,
    registeredApps,
    registeredAppsFailed,
    routingCheckable,
  ]);

  // A signed-out user can never have the custom-bot registration checked, so a
  // plugin-bound message to a bot-owned webhook lands at "unverified" purely for
  // lack of a session. Rather than ship that as a soft "couldn't confirm"
  // caution and let the clicks die, require sign-in: once authed the check runs
  // and the verdict resolves (custom-bot / foreign / dweeb). Gated on a proxy
  // (so sign-in is actually possible) and a definitively signed-out session
  // (not the brief "loading"/"unknown" window, which would flash the block).
  const mustSignInToRouteCheck =
    componentRouting === "unverified" && authStatus === "anon" && isProxyConfigured();

  // A guild-scoped plugin binding (Self Role and the like) only works in the
  // server it was set up for — posting it elsewhere leaves the component dead
  // ("this menu was set up for a different server"). Plugins surface their
  // target guild on save and we cache it per binding, so when the destination
  // webhook's guild is known and a binding's cached guild differs, we can warn
  // before the send. Bindings whose guild we don't have cached (configured on
  // another device, cache cleared) are simply skipped — never a false positive.
  const pluginGuildMismatch = useMemo(() => {
    if (!knownGuildId) return null;
    for (const b of pluginBound) {
      const configuredGuildId = getPluginBindingGuild(b.customId);
      if (configuredGuildId && configuredGuildId !== knownGuildId) {
        return { plugin: b.plugin, configuredGuildId };
      }
    }
    return null;
  }, [pluginBound, knownGuildId]);

  // Human name for the mismatched binding's server, when it's one of the user's
  // own servers; otherwise the raw id (still better than nothing in the warning).
  const mismatchGuildName = pluginGuildMismatch
    ? (authGuilds.find((g) => g.id === pluginGuildMismatch.configuredGuildId)?.name ??
      pluginGuildMismatch.configuredGuildId)
    : undefined;

  const sending = state.kind === "sending";

  // Fetch slot state for the confirm dialog's "Make permanent" control. Only
  // worth a request when the message actually carries interactive components
  // and the user could act on it (signed in, proxy, guild known). Errors
  // (403 non-manager, network) just leave the control hidden — the success
  // dialog then shows a generic expiry note instead of a concrete state.
  const hasInteractiveComponents = appWebhookNote != null;
  const updateTargetId = mode === "update" ? (parsedMessageId ?? undefined) : undefined;
  useEffect(() => {
    if (!confirmOpen) return;
    setConfirmSlots(null);
    setMakePermanent(false);
    setSlotsUnavailable(false);
    if (
      !hasInteractiveComponents ||
      !isProxyConfigured() ||
      authStatus !== "authed" ||
      !knownGuildId
    ) {
      return;
    }
    const ac = new AbortController();
    fetchPermanentSlots(knownGuildId, ac.signal)
      .then((slots) => {
        setConfirmSlots(slots);
        // An update target that already holds a slot starts the switch on —
        // leaving it on keeps the slot, turning it off releases it after the
        // PATCH. Everything else starts off (opt in to claim).
        setMakePermanent(
          updateTargetId != null && slots.items.some((i) => i.message_id === updateTargetId),
        );
      })
      .catch((e) => {
        if (e instanceof Error && "status" in e && (e as { status: number }).status === 501) {
          setSlotsUnavailable(true);
        }
      });
    return () => ac.abort();
  }, [confirmOpen, hasInteractiveComponents, authStatus, knownGuildId, updateTargetId]);

  // What the confirm dialog renders. Hidden when expiry is off on this
  // deployment (nothing to decide) or the slot state never loaded; when every
  // slot is taken by other messages the switch gives way to a "Free a slot"
  // button that hands off to the "Managed messages" dialog (below).
  const targetAlreadyPermanent =
    updateTargetId != null &&
    confirmSlots != null &&
    confirmSlots.items.some((i) => i.message_id === updateTargetId);
  const slotsFull =
    confirmSlots != null && !targetAlreadyPermanent && confirmSlots.used >= confirmSlots.cap;

  // "Free a slot" on the confirm's locked switch: abandon the pending send,
  // drop the whole dialog stack (confirm + Share dialog), and open the
  // "Managed messages" dialog for the webhook's server — the only place
  // slots are freed. Nothing is lost: the editor keeps the message and this
  // panel stays mounted, so clicking Send again picks up where it left off.
  const handleManageSlots = () => {
    setConfirmOpen(false);
    onCloseDialog?.();
    if (knownGuildId) {
      useManagedMessagesStore.getState().open(knownGuildId, knownGuildName);
    }
  };

  const permanentOption =
    confirmSlots != null && confirmSlots.ttl_days !== null
      ? {
          used: confirmSlots.used,
          cap: confirmSlots.cap,
          alreadyPermanent: targetAlreadyPermanent,
          checked: makePermanent,
          onChange: setMakePermanent,
          slotsFull,
          onManageSlots: slotsFull ? handleManageSlots : undefined,
        }
      : undefined;

  // Synchronous pre-flight. Validate the inputs the same way the send used to,
  // then open the confirmation dialog instead of posting straight away — the
  // user reviews the target webhook + ping list before anything reaches Discord.
  const handleSend = () => {
    if (!parsedUrl) {
      setState({ kind: "error", message: "Enter a valid Discord webhook URL." });
      return;
    }
    if (knownGone) {
      setState({
        kind: "error",
        message: "This webhook was deleted on Discord. Create a new one and use that URL.",
      });
      return;
    }
    if (mode === "update" && !parsedMessageId) {
      setState({
        kind: "error",
        message: "Enter the ID (or link) of the message to update.",
      });
      return;
    }
    if (blockingIssues.length > 0) {
      setState({
        kind: "error",
        message: `${blockingIssues.length} validation error${blockingIssues.length === 1 ? "" : "s"} — fix them before sending.`,
      });
      return;
    }
    if (mustSignInToRouteCheck) {
      setState({
        kind: "error",
        message: "Sign in so DWEEB can confirm these plugin components route to it before sending.",
      });
      return;
    }
    if (componentRouting === "foreign") {
      // Owned by an unrelated app — clicks never reach DWEEB, so the plugin
      // components are provably dead. Block rather than post false traffic.
      setState({
        kind: "error",
        message: `“${knownName || "This webhook"}” delivers clicks to a different app, so the ${pluginNames.join(" / ") || "plugin"} component${pluginBound.length === 1 ? "" : "s"} here would never respond. Post through a DWEEB webhook (or a registered custom bot), or remove the interactive components.`,
      });
      return;
    }
    if (pluginGuildMismatch) {
      // Provably dead in this server — block rather than post false traffic.
      setState({
        kind: "error",
        message: `This ${pluginGuildMismatch.plugin.name} menu was set up for ${mismatchGuildName}, not the server this webhook posts to — post through a webhook in ${mismatchGuildName}, or reconfigure the menu for this server.`,
      });
      return;
    }
    setState({ kind: "idle" });
    setConfirmOpen(true);
  };

  const handleConfirmedSend = async () => {
    // Inputs were validated in handleSend; re-guard for type-narrowing.
    if (!parsedUrl) return;
    if (mode === "update" && !parsedMessageId) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    // Keep the confirm dialog open with a loading button while the POST/PATCH is
    // in flight — closing it the instant "Post" is hit (then opening a separate
    // result modal) made the transition flicker. It's closed in the `finally`
    // below, once the outcome is known and the next view is ready.
    setConfirmBusy(true);
    setState({ kind: "sending" });
    setShowRaw(false);

    try {
      // Always confirm who owns the webhook before posting. When we don't yet
      // know (no prior "Save webhook" or saved entry), GET it first so the
      // ownership block fires here instead of letting an interactive message slip
      // through to Discord and bounce back as a rejection. Also re-GET when the
      // plugin-routing question is open but the saved entry predates the
      // `applicationId` field — `ownerKind` alone can't answer it.
      let ownerKind = knownOwnerKind;
      // The webhook's own name + avatar + location, captured if we end up
      // verifying here. Used to label and picture the recents entry (and to show
      // the destination in the confirm) without asking for input.
      let resolvedName: string | undefined;
      let resolvedAvatar: string | null | undefined;
      let resolvedChannelId: string | undefined;
      let resolvedGuildId: string | undefined;
      // Owning app id, for the plugin-routing check and the recents entry.
      let appId = knownApplicationId ?? null;
      // True when ownership was resolved by THIS call — i.e. the user answered
      // the confirm before any routing verdict could have been shown.
      let freshlyVerified = false;
      if (!ownerKind || (pluginBound.length > 0 && ownerKind === "bot" && !appId)) {
        const check = await verifyWebhook(parsedUrl, { signal: ac.signal });
        if (!check.ok) {
          if (check.status === 0 && check.error === "Check was cancelled.") {
            setState({ kind: "idle" });
            return;
          }
          setState({ kind: "error", message: check.error, status: check.status, body: check.body });
          return;
        }
        const owner = classifyWebhookOwner(check.webhook);
        ownerKind = owner.kind;
        appId = owner.applicationId;
        freshlyVerified = true;
        resolvedName = typeof check.webhook.name === "string" ? check.webhook.name : undefined;
        resolvedAvatar = webhookAvatarHash(check.webhook);
        resolvedChannelId = webhookChannelId(check.webhook) ?? undefined;
        resolvedGuildId = webhookGuildId(check.webhook) ?? undefined;
        setVerified({
          name: resolvedName ?? "",
          owner,
          channelId: resolvedChannelId,
          guildId: resolvedGuildId,
        });
      }

      if (appWebhookNote != null && (ownerKind === "user" || ownerKind === "follower")) {
        // Setting `verified` above flips `ownershipBlocked`, so the banner (with
        // the "Remove interactive components" action) now renders on its own —
        // don't duplicate it as an error line. Just leave the send un-started.
        setState({ kind: "idle" });
        return;
      }

      // The ownership pass above guarantees Discord will ACCEPT the message; it
      // doesn't guarantee the components will work. When the webhook was
      // verified just now — meaning the user answered the confirm before any
      // routing verdict existed — and the message carries plugin-bound
      // components owned by an app other than DWEEB, resolve the custom-bot
      // registration before posting. A definitive "foreign" leaves the send
      // un-started, exactly like the ownership block: `setVerified` above flips
      // the verdict, so on the next render the banner shows and the Send button
      // is disabled (a second attempt can't slip through). "Unverified" is let
      // through here — it's not provably dead (signed-out is handled earlier by
      // the sign-in gate; an authed-but-failed check can't learn more by
      // waiting).
      if (freshlyVerified && pluginBound.length > 0 && appId && appId !== DISCORD_CLIENT_ID) {
        const gid = resolvedGuildId ?? knownGuildId;
        let ids =
          registeredApps != null && registeredApps.guildId === gid ? registeredApps.ids : null;
        if (ids === null && gid && isProxyConfigured() && authStatus === "authed") {
          try {
            const bots = await fetchCustomBots(gid, ac.signal);
            ids = bots.items.map((i) => i.application_id);
            setRegisteredApps({ guildId: gid, ids });
          } catch {
            if (ac.signal.aborted) {
              setState({ kind: "idle" });
              return;
            }
            setRegisteredAppsFailed(true);
          }
        }
        const routing = classifyComponentRouting({
          applicationId: appId,
          dweebApplicationId: DISCORD_CLIENT_ID,
          customBotIds: ids,
        });
        if (routing === "foreign") {
          setState({ kind: "idle" });
          return;
        }
        // Signed out → the registration fetch above was skipped, so the verdict
        // is only "unverified" for lack of a session. Mirror the main Send gate
        // (`mustSignInToRouteCheck`): leave the send un-started so the sign-in
        // banner renders — `setVerified` above already flipped the owner state
        // that drives it. (An authed-but-failed check still falls through;
        // waiting can't learn more there.)
        if (routing === "unverified" && authStatus === "anon" && isProxyConfigured()) {
          setState({ kind: "idle" });
          return;
        }
      }

      // Block a guild-scoped binding (Self Role et al.) that targets a different
      // server than this freshly-verified webhook posts to. The mismatch can
      // only be checked once we know the webhook's guild, which for a fresh URL
      // is just now — so the disabled-button block couldn't have caught it yet.
      // Leave the send un-started: `setVerified` above resolved the guild, so on
      // the next render the "wrong server" banner shows and the Send button is
      // disabled (a second attempt can't slip through). Skipped for bindings
      // whose guild isn't cached — never a false positive.
      if (freshlyVerified && pluginBound.length > 0) {
        const gid = resolvedGuildId ?? knownGuildId;
        const mismatched =
          gid != null &&
          pluginBound.some((b) => {
            const cfg = getPluginBindingGuild(b.customId);
            return cfg != null && cfg !== gid;
          });
        if (mismatched) {
          setState({ kind: "idle" });
          return;
        }
      }

      const result =
        mode === "update" && parsedMessageId
          ? await updateWebhookMessage(parsedUrl, parsedMessageId, message, {
              threadId: threadId.trim() || undefined,
              signal: ac.signal,
            })
          : await sendToWebhook(parsedUrl, message, {
              threadId: threadId.trim() || undefined,
              // Ask Discord to echo the created message so we can deep-link to it
              // from the success dialog (without `wait` a POST is a bodyless 204).
              wait: true,
              signal: ac.signal,
            });

      if (result.ok) {
        // Success is surfaced by the result dialog below; no inline banner needed.
        setState({ kind: "idle" });
        // Always remember the webhook on a successful send so it shows up in
        // recents without a separate "Save webhook" click. Records the name +
        // owner we resolved above; any inline label is preserved by the upsert,
        // which also refreshes lastUsedAt so recents stay ordered by most-recent.
        rememberWebhook(parsedUrl.url, {
          name: resolvedName,
          ownerKind,
          applicationId: appId ?? undefined,
          avatar: resolvedAvatar,
          channelId: resolvedChannelId,
          guildId: resolvedGuildId,
        });
        setHistory(loadHistory());

        // Pop the success dialog with a deep link straight to the message. Prefer
        // the ids resolved on this send (a freshly-verified URL) over the
        // best-known ones, and pull the message id out of the response (POST uses
        // wait=true; PATCH always echoes it) so "Open in Discord" lands on the
        // exact message — falling back to the channel, or to no link when the
        // guild/channel can't be resolved.
        const effGuildId = resolvedGuildId ?? knownGuildId;
        const effChannelId = resolvedChannelId ?? knownChannelId ?? channelIdFromBody(result.body);
        const postedMessageId =
          messageIdFromBody(result.body) ??
          (mode === "update" ? (parsedMessageId ?? undefined) : undefined);
        // The thread the message lives in: the id the user supplied, or — when
        // a POST carried `thread_name` and so created a brand-new forum
        // thread — the echoed message's channel_id, which IS that thread's id.
        // Needed for the deep link and for the follow-up PATCH origin below.
        const effThreadId =
          threadId.trim() ||
          (mode === "new" && message.thread_name ? channelIdFromBody(result.body) : undefined);

        // Point the form at the message that's now live: record it as the
        // restore origin, which flips the panel to "Update existing" with this
        // webhook + message id (+ thread) pre-filled — clicking send again
        // edits the message in place instead of posting a duplicate. Lives on
        // the message store (like a restore) so it survives closing and
        // reopening the dialog.
        if (postedMessageId) {
          setRestoreOrigin({
            webhookUrl: parsedUrl.url,
            messageId: postedMessageId,
            threadId: effThreadId || undefined,
          });
        }

        // A thread post lives under the thread id, which Discord uses as the
        // channel segment of the message link.
        const linkChannelSeg = effThreadId || effChannelId;
        const discordUrl =
          effGuildId && linkChannelSeg
            ? `https://discord.com/channels/${effGuildId}/${linkChannelSeg}${
                postedMessageId ? `/${postedMessageId}` : ""
              }`
            : null;

        // The confirm dialog's "Make permanent" switch resolves here, where the
        // message id is real: claim a slot when it was turned on, release the
        // update target's slot when it was turned off. The message is already
        // live either way — a failure never fails the send, it rides into the
        // success dialog's receipt as an error line (updating the message
        // again re-opens the confirm, which is the retry).
        let permanentError: string | undefined;
        let isPermanent = targetAlreadyPermanent;
        if (confirmSlots != null && postedMessageId && effGuildId) {
          if (makePermanent && !targetAlreadyPermanent && effChannelId) {
            try {
              const claim = await addPermanentMessage(effGuildId, postedMessageId, effChannelId);
              if (claim.full) {
                // Slots filled up between the confirm fetch and now.
                permanentError =
                  "All permanent slots were taken in the meantime — free one under Managed messages in the account menu, then update the message to try again.";
              } else {
                isPermanent = true;
              }
            } catch (e) {
              if (isAuthError(e)) {
                useAuthStore.getState().markSignedOut();
                permanentError =
                  "Your session expired before the slot was claimed — sign in and update the message to try again.";
              } else {
                permanentError = e instanceof Error ? e.message : String(e);
              }
            }
          } else if (!makePermanent && targetAlreadyPermanent) {
            try {
              await removePermanentMessage(effGuildId, postedMessageId);
              isPermanent = false;
            } catch (e) {
              if (isAuthError(e)) {
                useAuthStore.getState().markSignedOut();
                permanentError =
                  "Your session expired before the slot was released — sign in and update the message to try again.";
              } else {
                permanentError = e instanceof Error ? e.message : String(e);
              }
            }
          }
        }

        // The receipt the success dialog shows. Concrete (permanent/expiring)
        // when the slot state loaded; a generic expiry note when it didn't
        // (signed out, fetch failed); nothing at all when the message has no
        // interactive components, the deployment doesn't run the feature, or
        // components never expire there.
        let permanentStatus: SendSuccessInfo["permanentStatus"];
        if (appWebhookNote != null && isProxyConfigured() && !slotsUnavailable) {
          if (confirmSlots == null) {
            permanentStatus = { status: "unknown", signInHint: authStatus !== "authed" };
          } else if (confirmSlots.ttl_days !== null) {
            permanentStatus = isPermanent
              ? { status: "permanent", error: permanentError }
              : {
                  status: "expiring",
                  ttlDays: confirmSlots.ttl_days,
                  error: permanentError,
                };
          }
        }

        setSuccess({
          mode,
          webhookName: resolvedName ?? knownName,
          webhookId: parsedUrl.id,
          webhookAvatar: resolvedAvatar ?? knownAvatar,
          guildId: effGuildId,
          channelId: effChannelId,
          guildName:
            knownGuildName ??
            (effGuildId ? authGuilds.find((g) => g.id === effGuildId)?.name : undefined),
          channelName:
            knownChannelName ??
            (effChannelId ? connectedData?.channelById[effChannelId]?.name : undefined),
          discordUrl,
          editOnResend: postedMessageId != null,
          messageId: postedMessageId,
          permanentStatus,
        });
      } else if (result.status === 0 && /cancel/i.test(result.error)) {
        // Aborted via the dialog's Cancel — not an error worth surfacing.
        setState({ kind: "idle" });
      } else {
        setState({
          kind: "error",
          message: result.error,
          retryAfter: result.retryAfter,
          status: result.status,
          body: result.body,
        });
      }
    } finally {
      // Whatever the outcome, drop the loading state and close the confirm —
      // success swaps to the result modal; error/blocked reveals the panel.
      setConfirmBusy(false);
      setConfirmOpen(false);
    }
  };

  // Cancel from the confirm dialog. While a send is in flight this aborts it
  // (so dismissing mid-post doesn't leave the request running); otherwise it
  // just closes. Either way the `finally` above tidies up the busy/open state.
  const handleConfirmCancel = () => {
    if (confirmBusy) abortRef.current?.abort();
    setConfirmOpen(false);
  };

  // Verify the webhook with Discord (GET), then store it — no message is posted.
  const handleSaveWebhook = async () => {
    if (!parsedUrl) {
      setState({ kind: "error", message: "Enter a valid Discord webhook URL." });
      return;
    }

    saveAbortRef.current?.abort();
    const ac = new AbortController();
    saveAbortRef.current = ac;

    setSaving(true);
    setShowRaw(false);
    const result = await verifyWebhook(parsedUrl, { signal: ac.signal });
    setSaving(false);

    if (!result.ok) {
      if (result.status === 0 && result.error === "Check was cancelled.") return;
      setState({ kind: "error", message: result.error, status: result.status, body: result.body });
      return;
    }

    const remoteName = typeof result.webhook.name === "string" ? result.webhook.name : "";
    const owner = classifyWebhookOwner(result.webhook);
    const channelId = webhookChannelId(result.webhook) ?? undefined;
    const guildId = webhookGuildId(result.webhook) ?? undefined;
    setVerified({ name: remoteName, owner, channelId, guildId });
    const entry = rememberWebhook(parsedUrl.url, {
      name: remoteName,
      ownerKind: owner.kind,
      applicationId: owner.applicationId ?? undefined,
      avatar: webhookAvatarHash(result.webhook),
      channelId,
      guildId,
    });
    if (entry) {
      setHistory(loadHistory());
      setState({ kind: "idle" });
      pushToast(
        remoteName
          ? `Verified “${remoteName}” — ${owner.badge.toLowerCase()}. Saved.`
          : `Webhook verified — ${owner.badge.toLowerCase()}. Saved.`,
        "success",
      );
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    setState({ kind: "idle" });
  };

  // A webhook just created via `webhook.incoming` was handed back through the
  // redirect (prefilled into `url` above). Verify it once with Discord to capture
  // its name/owner/destination, then remember it — the ownership banners, confirm
  // dialog, and "already verified" send path all read those from history by id,
  // so no extra GET happens at send time.
  const initialVerifiedRef = useRef(false);
  useEffect(() => {
    if (!initialWebhook || initialVerifiedRef.current) return;
    const parsed = parseWebhookUrl(initialWebhook.url);
    if (!parsed) return;
    initialVerifiedRef.current = true;
    // Save the destination names right away (resolved server-side, present even
    // when signed out) so the recents entry is labelled even if the verify GET
    // below is slow or fails.
    rememberWebhook(parsed.url, {
      channelName: initialWebhook.channelName,
      guildName: initialWebhook.guildName,
    });
    setHistory(loadHistory());
    const ac = new AbortController();
    void (async () => {
      const result = await verifyWebhook(parsed, { signal: ac.signal });
      if (!result.ok) return; // a bad/expired URL just stays in the field, unsaved
      const remoteName = typeof result.webhook.name === "string" ? result.webhook.name : "";
      const owner = classifyWebhookOwner(result.webhook);
      rememberWebhook(parsed.url, {
        name: remoteName,
        ownerKind: owner.kind,
        applicationId: owner.applicationId ?? undefined,
        avatar: webhookAvatarHash(result.webhook),
        channelId: webhookChannelId(result.webhook) ?? undefined,
        guildId: webhookGuildId(result.webhook) ?? undefined,
        channelName: initialWebhook.channelName,
        guildName: initialWebhook.guildName,
      });
      setHistory(loadHistory());
      pushToast(
        remoteName
          ? `Webhook “${remoteName}” ready — review and send.`
          : "Webhook ready — review and send.",
        "success",
      );
    })();
    return () => ac.abort();
  }, [initialWebhook]);

  return (
    <>
      <p className={styles.lead}>
        Posts straight from your browser to Discord — nothing touches our servers.
      </p>

      <Callout tone="warning" icon={<LockIcon size={15} />} role="note">
        <strong>Treat the webhook URL like a password.</strong> It's a credential that lets anyone
        post to your channel — keep it secret and only use webhooks you own.
      </Callout>

      <div className={styles.modeToggle} role="radiogroup" aria-label="Send mode">
        <button
          type="button"
          role="radio"
          aria-checked={mode === "new"}
          className={cn(styles.modeOption, mode === "new" && styles.modeOptionActive)}
          onClick={() => setMode("new")}
        >
          <strong>Send as new</strong>
          <span>Post a new message (POST).</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === "update"}
          className={cn(styles.modeOption, mode === "update" && styles.modeOptionActive)}
          onClick={() => setMode("update")}
        >
          <strong>Update existing</strong>
          <span>Edit a posted message (PATCH).</span>
        </button>
      </div>

      <WebhookRecents
        history={history}
        activeId={parsedUrl?.id ?? null}
        onUse={(entry) => {
          setUrl(entry.url);
          setState({ kind: "idle" });
        }}
        onChange={() => setHistory(loadHistory())}
      />

      <Field
        label="Webhook URL"
        error={urlInvalid ? "Not a valid Discord webhook URL." : undefined}
        hint={isProxyConfigured() ? <CreateWebhookLinks /> : undefined}
      >
        {(id) => (
          <div className={styles.urlRow}>
            <TextInput
              id={id}
              masked={!revealUrl}
              spellCheck={false}
              value={url}
              onChange={(e) => setUrl(e.currentTarget.value)}
              invalid={urlInvalid}
              placeholder="https://discord.com/api/webhooks/…"
            />
            <button
              type="button"
              className={styles.revealBtn}
              onClick={() => setRevealUrl((v) => !v)}
              aria-pressed={revealUrl}
            >
              {revealUrl ? "Hide" : "Show"}
            </button>
            <button
              type="button"
              className={styles.revealBtn}
              onClick={handleSaveWebhook}
              disabled={saving || sending || !parsedUrl}
            >
              {saving ? "Checking…" : "Save"}
            </button>
          </div>
        )}
      </Field>

      <Field label="Thread ID (optional)" hint="Post into a forum thread or text-channel thread.">
        {(id) => (
          <TextInput
            id={id}
            value={threadId}
            onChange={(e) => setThreadId(e.currentTarget.value.replace(/[^\d]/g, ""))}
            placeholder="e.g. 1185234567890123456"
            inputMode="numeric"
          />
        )}
      </Field>

      {mode === "update" ? (
        <Field
          label="Message ID or link to update"
          hint={
            restoredFrom
              ? "Pre-filled from the message you last posted or restored — change it to update a different one."
              : "A message this webhook posted. In Discord: right-click → Copy Message ID (Developer Mode)."
          }
          error={messageIdInvalid ? "Not a valid message ID or link." : undefined}
        >
          {(id) => (
            <TextInput
              id={id}
              value={messageIdInput}
              onChange={(e) => setMessageIdInput(e.currentTarget.value)}
              invalid={messageIdInvalid}
              placeholder="1185234567890123456  ·  or  https://discord.com/channels/…"
              spellCheck={false}
            />
          )}
        </Field>
      ) : null}

      {mode === "update" && !restoredFrom ? (
        <Callout
          tone="info"
          role="note"
          title="Update overwrites the entire message."
          more={
            <>
              What’s in the editor now replaces the original completely — anything you don’t rebuild
              here is removed. Only this webhook can edit its own messages (Discord 404s otherwise).
              To tweak the live message instead of replacing it, pull it in from the{" "}
              <strong>Restore</strong> tab first.
            </>
          }
          moreLabel="What this means"
        />
      ) : null}

      {knownGone ? (
        <Callout
          tone="danger"
          role="alert"
          title={<>Can’t send: “{knownName || "this webhook"}” was deleted on Discord.</>}
          more={
            <>
              A health check couldn’t find this webhook anymore — it was deleted, or its token was
              reset. Create a new webhook and send to that URL instead.
            </>
          }
          moreLabel="What happened"
          actions={
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                if (!parsedUrl) return;
                forgetWebhook(parsedUrl.id);
                setHistory(loadHistory());
                setUrl("");
                setState({ kind: "idle" });
              }}
            >
              Remove from recents
            </Button>
          }
        />
      ) : null}

      {ownershipBlocked && !knownGone ? (
        <Callout
          tone="danger"
          role="alert"
          title={
            <>
              Can’t send: “{knownName || "this webhook"}” is owned by{" "}
              {knownOwnerKind === "follower" ? "Channel Following" : "a person"}, not an app.
            </>
          }
          more={
            <>
              Discord only accepts interactive components (buttons with custom_id, select menus)
              from application-owned webhooks. Use a bot/app-owned webhook, or remove the
              interactive components.
            </>
          }
          moreLabel="Why"
          actions={
            onRequestRemoveInteractive ? (
              <Button variant="danger" size="sm" onClick={onRequestRemoveInteractive}>
                Remove interactive components
              </Button>
            ) : null
          }
        />
      ) : null}

      {ownershipSatisfied && !knownGone ? (
        componentRouting === "foreign" ? (
          <Callout
            tone="danger"
            role="alert"
            title={
              <>
                Can’t send: “{knownName || "This webhook"}” won’t deliver clicks to DWEEB — the{" "}
                {pluginNames.join(" / ")} component{pluginBound.length === 1 ? "" : "s"} here would
                never respond.
              </>
            }
            more={
              <>
                Discord delivers component clicks to the app that owns the webhook. This one belongs
                to a different app — not DWEEB and not one of this server’s registered custom bots —
                so DWEEB’s backend never sees them. Sent here every click would fail, so the send is
                blocked. To make them work, post through a webhook created in DWEEB (see the links
                under the URL field), or register the owning app as a custom bot first — or remove
                the interactive components.
              </>
            }
            moreLabel="Why"
            actions={
              onRequestRemoveInteractive ? (
                <Button variant="danger" size="sm" onClick={onRequestRemoveInteractive}>
                  Remove interactive components
                </Button>
              ) : null
            }
          />
        ) : componentRouting === "unverified" ? (
          mustSignInToRouteCheck ? (
            <Callout
              tone="danger"
              role="alert"
              title={
                <>
                  Sign in to send {pluginNames.join(" / ")} component
                  {pluginBound.length === 1 ? "" : "s"} through “{knownName || "this webhook"}”.
                </>
              }
              more={
                <>
                  These components only respond when the webhook’s owning app routes interactions
                  through DWEEB — DWEEB’s own webhooks do, and so do this server’s registered custom
                  bots. Signing in lets DWEEB verify that automatically, so the clicks aren’t
                  silently dropped. Until then it can’t be confirmed, so the send is held.
                </>
              }
              moreLabel="Why"
              actions={
                <Button size="sm" variant="primary" onClick={() => login()}>
                  Sign in with Discord
                </Button>
              }
            />
          ) : (
            <Callout
              tone="warning"
              role="note"
              title={
                <>Couldn’t confirm “{knownName || "this webhook"}” delivers clicks to DWEEB.</>
              }
              more={
                <>
                  The {pluginNames.join(" / ")} component
                  {pluginBound.length === 1 ? "" : "s"} here only respond when the webhook’s owning
                  app routes interactions through DWEEB — DWEEB’s own webhooks do, and so do the
                  server’s registered custom bots. The registration check didn’t go through, so this
                  couldn’t be confirmed. If the app is unrelated, the message still posts but those
                  components never respond.
                </>
              }
              moreLabel="What this means"
            />
          )
        ) : componentRouting === "dweeb" || componentRouting === "custom-bot" ? (
          <Callout
            tone="info"
            role="note"
            title="Plugin components are handled by DWEEB."
            more={
              <>
                “{knownName || "This webhook"}”{" "}
                {componentRouting === "dweeb"
                  ? "belongs to DWEEB"
                  : "belongs to a custom bot registered for this server"}
                , so Discord delivers button and select clicks to DWEEB’s backend, where the
                attached plugins respond.
              </>
            }
            moreLabel="What this means"
          />
        ) : (
          <Callout
            tone="info"
            role="note"
            title="Interactive responses are handled by the bot’s server."
            more={
              <>
                “{knownName || "This webhook"}” is app-owned, so Discord accepts and renders the
                buttons and select menus. Clicks are delivered to the owning app — its backend has
                to be running to respond. This builder only posts the message.{" "}
                <a
                  href="https://discord.com/developers/docs/interactions/receiving-and-responding"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  How Discord interactions work →
                </a>
              </>
            }
            moreLabel="What this means"
          />
        )
      ) : null}

      {pluginGuildMismatch && !knownGone ? (
        <Callout
          tone="danger"
          role="alert"
          title={
            <>
              Can’t send: this {pluginGuildMismatch.plugin.name} menu was set up for a different
              server than “{knownName || "this webhook"}” posts to.
            </>
          }
          more={
            <>
              It only changes roles in <strong>{mismatchGuildName}</strong>, but this webhook posts
              to {knownGuildName ? <strong>{knownGuildName}</strong> : "another server"}. Sent here
              every click would just return “this menu was set up for a different server” and change
              nothing, so the send is blocked. Post through a webhook in{" "}
              <strong>{mismatchGuildName}</strong>, or reconfigure the menu for this server.
            </>
          }
          moreLabel="Why"
        />
      ) : null}

      {visibleCapabilities.length > 0 ? (
        <section className={styles.capability} aria-label="Pre-send capability check">
          <header className={styles.capabilityHeader}>
            <span>Heads up — this message expects…</span>
          </header>
          <ul className={styles.capabilityList}>
            {visibleCapabilities.map((c, i) => (
              <li key={i} className={styles.capabilityItem}>
                <span
                  className={cn(
                    styles.capabilityBadge,
                    c.severity === "warning" ? styles.capabilityWarn : styles.capabilityInfo,
                  )}
                >
                  {c.severity === "warning" ? "Needs" : "Note"}
                </span>
                <div>
                  <div className={styles.capabilityTitle}>{c.title}</div>
                  <div className={styles.capabilityDetail}>{c.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {blockingIssues.length > 0 ? (
        <Callout tone="danger" role="alert" title="Fix before sending:">
          <ul className={styles.issueList}>
            {blockingIssues.slice(0, 5).map((issue, i) => (
              <li key={i}>{issue.message}</li>
            ))}
            {blockingIssues.length > 5 ? <li>…and {blockingIssues.length - 5} more</li> : null}
          </ul>
        </Callout>
      ) : null}

      {state.kind === "error" ? (
        <div className={styles.error} role="alert">
          {state.message}
          {state.retryAfter ? (
            <div className={styles.errorSub}>
              Discord asked us to wait {state.retryAfter.toFixed(1)}s.
            </div>
          ) : null}
          {state.body != null ? (
            <div className={styles.errorRaw}>
              <button
                type="button"
                className={styles.errorRawToggle}
                onClick={() => setShowRaw((v) => !v)}
                aria-expanded={showRaw}
              >
                {showRaw ? "Hide raw Discord response" : "Show raw Discord response"}
              </button>
              {showRaw ? (
                <pre className={styles.errorRawBody}>{formatRawBody(state.body)}</pre>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={styles.actions}>
        {sending ? (
          <Button variant="secondary" onClick={handleCancel}>
            Cancel
          </Button>
        ) : null}
        <Button
          variant="primary"
          onClick={handleSend}
          disabled={
            sending ||
            saving ||
            !parsedUrl ||
            knownGone ||
            blockingIssues.length > 0 ||
            ownershipBlocked ||
            mustSignInToRouteCheck ||
            componentRouting === "foreign" ||
            pluginGuildMismatch != null ||
            (mode === "update" && !parsedMessageId)
          }
        >
          {sending
            ? mode === "update"
              ? "Updating…"
              : "Sending…"
            : mode === "update"
              ? "Update message"
              : "Send to webhook"}
        </Button>
      </div>

      <SendConfirm
        open={confirmOpen}
        mode={mode}
        webhookName={knownName}
        ownerKind={knownOwnerKind}
        webhookId={parsedUrl?.id}
        webhookAvatar={knownAvatar}
        guildId={knownGuildId}
        channelId={knownChannelId}
        guildName={knownGuildName}
        channelName={knownChannelName}
        threadId={threadId.trim() || undefined}
        messageId={mode === "update" ? (parsedMessageId ?? undefined) : undefined}
        pings={pings}
        componentRouting={componentRouting}
        pluginNames={pluginNames}
        pluginGuildMismatch={
          pluginGuildMismatch
            ? {
                pluginName: pluginGuildMismatch.plugin.name,
                configuredGuildName: mismatchGuildName ?? pluginGuildMismatch.configuredGuildId,
                webhookGuildName: knownGuildName,
              }
            : undefined
        }
        permanentOption={permanentOption}
        busy={confirmBusy}
        onConfirm={handleConfirmedSend}
        onCancel={handleConfirmCancel}
      />

      <SendSuccess
        open={success != null}
        mode={success?.mode ?? "new"}
        webhookName={success?.webhookName}
        webhookId={success?.webhookId}
        webhookAvatar={success?.webhookAvatar}
        guildId={success?.guildId}
        channelId={success?.channelId}
        guildName={success?.guildName}
        channelName={success?.channelName}
        discordUrl={success?.discordUrl ?? null}
        editOnResend={success?.editOnResend ?? false}
        messageId={success?.messageId}
        permanentStatus={success?.permanentStatus}
        onClose={() => setSuccess(null)}
      />
    </>
  );
}

/**
 * The "create a webhook" affordances under the URL field.
 *
 * Always offers Discord's standard `webhook.incoming` flow (a webhook owned
 * by the DWEEB app). When the connected server has custom bots registered
 * (account menu → Custom bot) with a stored client secret, each one appears
 * as its own option — the webhook then belongs to THEIR app, so the message
 * posts under their bot's identity and its components route through DWEEB.
 * One click, no secret prompt: the proxy uses the secret stored (encrypted)
 * at registration.
 *
 * The custom-bot list is fetched quietly when the section mounts; any
 * failure (signed out, feature off, network) just leaves the default link.
 */
function CreateWebhookLinks() {
  const authed = useAuthStore((s) => s.status === "authed");
  const guildId = useGuildStore((s) => s.guildId);
  const [bots, setBots] = useState<CustomBotItem[]>([]);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!authed || !guildId) {
      setBots([]);
      return;
    }
    const ac = new AbortController();
    fetchCustomBots(guildId, ac.signal)
      .then((b) => setBots(b.items.filter((i) => i.has_secret)))
      .catch(() => setBots([]));
    return () => ac.abort();
  }, [authed, guildId]);

  return (
    <span className={styles.createWebhookLinks}>
      <button
        type="button"
        className={styles.createWebhookLink}
        onClick={() => {
          // Pre-select the server the builder is connected to, if any, so
          // the webhook lands where the user is already working.
          window.location.href = webhookCreateUrl(useGuildStore.getState().guildId);
        }}
      >
        <PlusIcon size={13} className={styles.createWebhookIcon} />
        Don’t have one? Create a webhook on a Discord channel
      </button>
      {guildId
        ? bots.map((bot) => (
            <button
              key={bot.application_id}
              type="button"
              className={styles.createWebhookLink}
              disabled={starting}
              onClick={() => {
                setStarting(true);
                createCustomBotWebhook(guildId, bot.application_id)
                  .then((url) => {
                    // Leaving the page; Discord's channel picker takes over.
                    window.location.assign(url);
                  })
                  .catch((e) => {
                    setStarting(false);
                    pushToast(e instanceof Error ? e.message : String(e), "error");
                  });
              }}
            >
              <PlusIcon size={13} className={styles.createWebhookIcon} />
              Create a webhook from {bot.name || "your custom bot"}
              <span className={styles.createWebhookBadge}>your bot</span>
            </button>
          ))
        : null}
    </span>
  );
}
