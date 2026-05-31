/**
 * "Send" panel — POSTs the current message directly to a Discord webhook,
 * or PATCHes the original when the editor was populated from a restore.
 *
 * Mode logic:
 *  - With no restore origin set, the panel POSTs (creates a new message).
 *  - When the user just restored a message via the Restore tab, the store's
 *    `restoredFrom` field is set, and the panel defaults to "Update existing"
 *    (PATCH) with the webhook + message ID pre-filled. The user can switch
 *    back to "Send as new" — that simply ignores the restore origin for the
 *    next click; it doesn't clear it (so they can still hit Update later).
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

import { useEffect, useMemo, useRef, useState } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { validateMessage } from "@/core/schema/validation";
import { inspectCapabilities } from "@/core/schema/capability";
import {
  classifyWebhookOwner,
  loadHistory,
  parseMessageIdInput,
  parseWebhookUrl,
  rememberWebhook,
  sendToWebhook,
  updateWebhookMessage,
  verifyWebhook,
  webhookAvatarHash,
  type WebhookHistoryEntry,
  type WebhookOwner,
  type WebhookOwnerKind,
} from "@/core/webhook";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { TextInput } from "@/ui/TextInput";
import { pushToast } from "@/ui/Toast";
import { cn } from "@/lib/cn";
import { WebhookRecents } from "./WebhookRecents";
import styles from "./SendPanel.module.css";

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "error"; message: string; retryAfter?: number; status?: number; body?: unknown };

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
}: {
  /**
   * Asked when the user clicks "Remove them" on the app-owned-webhook block.
   * The App closes the dialog and pops a confirmation over the editor.
   */
  onRequestRemoveInteractive?: () => void;
} = {}) {
  const message = useMessageStore((s) => s.message);
  const restoredFrom = useMessageStore((s) => s.restoredFrom);

  // Prefill from the restore origin when the editor was just restored from a
  // previously-posted message; otherwise start empty.
  const [url, setUrl] = useState(() => restoredFrom?.webhookUrl ?? "");
  const [threadId, setThreadId] = useState(() => restoredFrom?.threadId ?? "");
  const [messageIdInput, setMessageIdInput] = useState(() => restoredFrom?.messageId ?? "");
  const [mode, setMode] = useState<"new" | "update">(() => (restoredFrom ? "update" : "new"));
  const [revealUrl, setRevealUrl] = useState(false);
  const [history, setHistory] = useState<WebhookHistoryEntry[]>(() => loadHistory());
  const [state, setState] = useState<SendState>({ kind: "idle" });
  const [showRaw, setShowRaw] = useState(false);
  const [saving, setSaving] = useState(false);
  // Result of the last "Save webhook" verify GET — used to show who owns the
  // webhook (bot vs. person) before any message is sent.
  const [verified, setVerified] = useState<{ name: string; owner: WebhookOwner } | null>(null);

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

  const validation = useMemo(() => validateMessage(message), [message]);
  const blockingIssues = validation.issues.filter((i) => i.severity === "error");

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

  // Best-known display name for the URL — from a fresh verify or a saved entry —
  // so the ownership banners can name the webhook instead of "this webhook".
  const knownName = useMemo(() => {
    if (verified?.name) return verified.name;
    if (!parsedUrl) return undefined;
    return history.find((e) => e.id === parsedUrl.id)?.name || undefined;
  }, [verified, parsedUrl, history]);

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

  const handleSend = async () => {
    if (!parsedUrl) {
      setState({ kind: "error", message: "Enter a valid Discord webhook URL." });
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
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setState({ kind: "sending" });
    setShowRaw(false);

    // Always confirm who owns the webhook before posting. When we don't yet
    // know (no prior "Save webhook" or saved entry), GET it first so the
    // ownership block fires here instead of letting an interactive message slip
    // through to Discord and bounce back as a rejection.
    let ownerKind = knownOwnerKind;
    // The webhook's own name + avatar, captured if we end up verifying here.
    // Used to label and picture the recents entry without asking for input.
    let resolvedName: string | undefined;
    let resolvedAvatar: string | null | undefined;
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
      setVerified({ name: resolvedName ?? "", owner });
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
            signal: ac.signal,
          });

    if (result.ok) {
      // Success is surfaced by the toast below; no inline banner needed.
      setState({ kind: "idle" });
      pushToast(
        mode === "update" ? "Original message updated." : "Message delivered to Discord.",
        "success",
      );
      // Always remember the webhook on a successful send so it shows up in
      // recents without a separate "Save webhook" click. Records the name +
      // owner we resolved above; any inline label is preserved by the upsert,
      // which also refreshes lastUsedAt so recents stay ordered by most-recent.
      rememberWebhook(parsedUrl.url, { name: resolvedName, ownerKind, avatar: resolvedAvatar });
      setHistory(loadHistory());
    } else {
      setState({
        kind: "error",
        message: result.error,
        retryAfter: result.retryAfter,
        status: result.status,
        body: result.body,
      });
    }
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
    setVerified({ name: remoteName, owner });
    const entry = rememberWebhook(parsedUrl.url, {
      name: remoteName,
      ownerKind: owner.kind,
      avatar: webhookAvatarHash(result.webhook),
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

  return (
    <>
      <p className={styles.lead}>
        Send the current message straight to a Discord webhook. The request goes from your browser
        to Discord — nothing is uploaded to our servers (there are none).
      </p>

      {restoredFrom ? (
        <div className={styles.modeToggle} role="radiogroup" aria-label="Send mode">
          <button
            type="button"
            role="radio"
            aria-checked={mode === "update"}
            className={cn(styles.modeOption, mode === "update" && styles.modeOptionActive)}
            onClick={() => setMode("update")}
          >
            <strong>Update the original</strong>
            <span>Edit the message you restored in place (PATCH).</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "new"}
            className={cn(styles.modeOption, mode === "new" && styles.modeOptionActive)}
            onClick={() => setMode("new")}
          >
            <strong>Send as a copy</strong>
            <span>Post a new message; leaves the original untouched.</span>
          </button>
        </div>
      ) : null}

      <div className={styles.warning} role="note">
        <strong>Treat the webhook URL like a password.</strong> Anyone with it can post to your
        channel. We never send it anywhere; saving to history stores it in this browser's
        localStorage only.
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
        hint="https://discord.com/api/webhooks/{id}/{token}"
        error={urlInvalid ? "Not a valid Discord webhook URL." : undefined}
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
          hint="Pre-filled from the message you restored. Change it to update a different message instead."
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

      {ownershipBlocked ? (
        <div className={styles.blocking} role="alert">
          <strong>
            Can’t send: this webhook is owned by{" "}
            {knownOwnerKind === "follower" ? "Channel Following" : "a person"}, not an app.
          </strong>
          <p className={styles.blockingDetail}>
            Discord only accepts interactive components (buttons with custom_id, select menus) from
            application-owned webhooks. Sending “{knownName || "this webhook"}” would be rejected.
            Use a bot/app-owned webhook, or remove the interactive components.
          </p>
          {onRequestRemoveInteractive ? (
            <div className={styles.blockingActions}>
              <Button variant="danger" size="sm" onClick={onRequestRemoveInteractive}>
                Remove interactive components
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {ownershipSatisfied ? (
        <div className={styles.appOwned} role="note">
          <strong>Interactive responses are handled by the bot’s server.</strong>
          <p className={styles.appOwnedDetail}>
            “{knownName || "This webhook"}” is app-owned, so Discord accepts and renders the buttons
            and select menus. Clicks and selections are delivered to the application that owns it —
            its backend has to be running to respond. This builder only posts the message.
          </p>
          <a
            className={styles.appOwnedLink}
            href="https://discord.com/developers/docs/interactions/receiving-and-responding"
            target="_blank"
            rel="noopener noreferrer"
          >
            How Discord interactions work →
          </a>
        </div>
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
        <div className={styles.blocking}>
          <strong>Fix before sending:</strong>
          <ul>
            {blockingIssues.slice(0, 5).map((issue, i) => (
              <li key={i}>{issue.message}</li>
            ))}
            {blockingIssues.length > 5 ? <li>…and {blockingIssues.length - 5} more</li> : null}
          </ul>
        </div>
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
    </>
  );
}
