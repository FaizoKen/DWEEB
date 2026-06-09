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
 *
 * A webhook PATCH replaces the whole message, so when updating without a
 * restore we warn that anything not rebuilt in the editor is overwritten.
 *
 * Before posting, the panel confirms who owns the webhook (a GET) whenever the
 * owner isn't already known from a prior check or saved entry. That keeps the
 * "this webhook isn't app-owned" block from being missed on a freshly-typed
 * URL — Discord rejects interactive components sent through a person/follower
 * webhook, so we catch it here instead of after the send bounces.
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
  type WebhookHistoryEntry,
  type WebhookOwner,
  type WebhookOwnerKind,
} from "@/core/webhook";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { TextInput } from "@/ui/TextInput";
import { LockIcon, PlusIcon } from "@/ui/Icon";
import { pushToast } from "@/ui/Toast";
import { cn } from "@/lib/cn";
import { isProxyConfigured, webhookCreateUrl, type IncomingWebhook } from "@/core/guild/config";
import { WebhookRecents } from "./WebhookRecents";
import { SendConfirm } from "./SendConfirm";
import { SendSuccess } from "./SendSuccess";
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
} = {}) {
  const message = useMessageStore((s) => s.message);
  const restoredFrom = useMessageStore((s) => s.restoredFrom);

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

  const abortRef = useRef<AbortController | null>(null);
  const saveAbortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      saveAbortRef.current?.abort();
    },
    [],
  );

  // If a restore happens while the panel is open (e.g. user switched to the
  // Restore tab, fetched, and came back), pull the new origin into the form.
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

  const sending = state.kind === "sending";

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
      // through to Discord and bounce back as a rejection.
      let ownerKind = knownOwnerKind;
      // The webhook's own name + avatar + location, captured if we end up
      // verifying here. Used to label and picture the recents entry (and to show
      // the destination in the confirm) without asking for input.
      let resolvedName: string | undefined;
      let resolvedAvatar: string | null | undefined;
      let resolvedChannelId: string | undefined;
      let resolvedGuildId: string | undefined;
      if (!ownerKind) {
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
        // A thread post lives under the thread id, which Discord uses as the
        // channel segment of the message link.
        const linkChannelSeg = threadId.trim() || effChannelId;
        const discordUrl =
          effGuildId && linkChannelSeg
            ? `https://discord.com/channels/${effGuildId}/${linkChannelSeg}${
                postedMessageId ? `/${postedMessageId}` : ""
              }`
            : null;
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
        hint={
          isProxyConfigured() ? (
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
          ) : undefined
        }
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
              ? "Pre-filled from the restored message — change it to update a different one."
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
        <Callout
          tone="info"
          role="note"
          title="Interactive responses are handled by the bot’s server."
          more={
            <>
              “{knownName || "This webhook"}” is app-owned, so Discord accepts and renders the
              buttons and select menus. Clicks are delivered to the owning app — its backend has to
              be running to respond. This builder only posts the message.{" "}
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
        onClose={() => setSuccess(null)}
      />
    </>
  );
}
