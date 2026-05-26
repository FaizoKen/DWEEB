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
 * The webhook URL is treated as a credential:
 *  - The input is `type="password"` with a show/hide toggle so it doesn't
 *    appear in screen shares by default.
 *  - Saving to history is an **explicit action** — sending never touches
 *    localStorage; only the "Save webhook" button does (after verifying the
 *    webhook with Discord first).
 *  - `autoComplete="off"` keeps the browser password manager out of it.
 *
 * The send call is cancellable via AbortController. A second click while a
 * send is in flight aborts the first.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { validateMessage } from "@/core/schema/validation";
import { inspectCapabilities } from "@/core/schema/capability";
import {
  forgetWebhook,
  loadHistory,
  parseMessageIdInput,
  parseWebhookUrl,
  rememberWebhook,
  sendToWebhook,
  touchWebhook,
  updateWebhookMessage,
  verifyWebhook,
  type WebhookHistoryEntry,
} from "@/core/webhook";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { TextInput } from "@/ui/TextInput";
import { TrashIcon } from "@/ui/Icon";
import { IconButton } from "@/ui/IconButton";
import { pushToast } from "@/ui/Toast";
import { cn } from "@/lib/cn";
import styles from "./SendPanel.module.css";

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "ok"; status: number }
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

export function SendPanel() {
  const message = useMessageStore((s) => s.message);
  const restoredFrom = useMessageStore((s) => s.restoredFrom);

  // Prefill from the restore origin when the editor was just restored from a
  // previously-posted message; otherwise start empty.
  const [url, setUrl] = useState(() => restoredFrom?.webhookUrl ?? "");
  const [threadId, setThreadId] = useState(() => restoredFrom?.threadId ?? "");
  const [messageIdInput, setMessageIdInput] = useState(() => restoredFrom?.messageId ?? "");
  const [mode, setMode] = useState<"new" | "update">(() => (restoredFrom ? "update" : "new"));
  const [label, setLabel] = useState("");
  const [revealUrl, setRevealUrl] = useState(false);
  const [history, setHistory] = useState<WebhookHistoryEntry[]>(() => loadHistory());
  const [state, setState] = useState<SendState>({ kind: "idle" });
  const [showRaw, setShowRaw] = useState(false);
  const [saving, setSaving] = useState(false);

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

  const parsedMessageId = useMemo(() => parseMessageIdInput(messageIdInput), [messageIdInput]);
  const messageIdInvalid =
    mode === "update" && messageIdInput.trim().length > 0 && !parsedMessageId;

  const validation = useMemo(() => validateMessage(message), [message]);
  const blockingIssues = validation.issues.filter((i) => i.severity === "error");

  const capabilities = useMemo(
    () => inspectCapabilities(message, { threadIdProvided: threadId.trim().length > 0 }),
    [message, threadId],
  );

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
      setState({ kind: "ok", status: result.status });
      pushToast(
        mode === "update" ? "Original message updated." : "Message delivered to Discord.",
        "success",
      );
      // Sending never saves the URL on its own — that's the "Save webhook"
      // button's job. We only refresh lastUsedAt on an already-saved entry so
      // recents stay ordered by most-recent.
      touchWebhook(parsedUrl.id);
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
    const entry = rememberWebhook(parsedUrl.url, label.trim() || remoteName);
    if (entry) {
      setHistory(loadHistory());
      if (!label.trim() && remoteName) setLabel(remoteName);
      setState({ kind: "idle" });
      pushToast(
        remoteName ? `Verified and saved “${remoteName}”.` : "Webhook verified and saved.",
        "success",
      );
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    setState({ kind: "idle" });
  };

  const handleUseHistoryEntry = (entry: WebhookHistoryEntry) => {
    setUrl(entry.url);
    setLabel(entry.label);
    setState({ kind: "idle" });
  };

  const handleForget = (entry: WebhookHistoryEntry) => {
    forgetWebhook(entry.id);
    setHistory(loadHistory());
    pushToast("Webhook removed from this browser.", "info");
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

      {history.length > 0 ? (
        <div className={styles.history}>
          <div className={styles.historyTitle}>Recent webhooks (this browser)</div>
          <ul className={styles.historyList}>
            {history.map((entry) => (
              <li key={entry.id} className={styles.historyItem}>
                <button
                  type="button"
                  className={styles.historyButton}
                  onClick={() => handleUseHistoryEntry(entry)}
                >
                  <span className={styles.historyLabel}>{entry.label || "(unlabeled)"}</span>
                  <span className={styles.historyId}>id · {entry.id}</span>
                </button>
                <IconButton
                  size="sm"
                  variant="danger"
                  label="Forget this webhook"
                  onClick={() => handleForget(entry)}
                >
                  <TrashIcon size={12} />
                </IconButton>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Field
        label="Webhook URL"
        hint="https://discord.com/api/webhooks/{id}/{token}"
        error={urlInvalid ? "Not a valid Discord webhook URL." : undefined}
      >
        {(id) => (
          <div className={styles.urlRow}>
            <TextInput
              id={id}
              type={revealUrl ? "text" : "password"}
              autoComplete="off"
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

      <Field
        label="Label (optional)"
        hint="Used when you click “Save webhook” to identify it in the recents list."
      >
        {(id) => (
          <TextInput
            id={id}
            value={label}
            onChange={(e) => setLabel(e.currentTarget.value)}
            placeholder="e.g. Releases · #announcements"
            maxLength={60}
          />
        )}
      </Field>

      {capabilities.length > 0 ? (
        <section className={styles.capability} aria-label="Pre-send capability check">
          <header className={styles.capabilityHeader}>
            <span>Heads up — this message expects…</span>
          </header>
          <ul className={styles.capabilityList}>
            {capabilities.map((c, i) => (
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

      {state.kind === "ok" ? (
        <div className={styles.success} role="status">
          {mode === "update" ? "Updated. " : "Sent. "}
          Discord returned {state.status === 204 ? "204 No Content" : state.status}.
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
          variant="secondary"
          onClick={handleSaveWebhook}
          disabled={saving || sending || !parsedUrl}
        >
          {saving ? "Checking…" : "Save webhook"}
        </Button>
        <Button
          variant="primary"
          onClick={handleSend}
          disabled={
            sending ||
            saving ||
            !parsedUrl ||
            blockingIssues.length > 0 ||
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
