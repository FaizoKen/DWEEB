/**
 * "Send" panel — POSTs the current message directly to a Discord webhook.
 *
 * The webhook URL is treated as a credential:
 *  - The input is `type="password"` with a show/hide toggle so it doesn't
 *    appear in screen shares by default.
 *  - Saving to history is **opt-in per submission** — unchecking "Remember"
 *    sends without ever touching localStorage.
 *  - `autoComplete="off"` keeps the browser password manager out of it.
 *
 * The send call is cancellable via AbortController. A second click while a
 * send is in flight aborts the first.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { validateMessage } from "@/core/schema/validation";
import {
  forgetWebhook,
  loadHistory,
  parseWebhookUrl,
  rememberWebhook,
  sendToWebhook,
  touchWebhook,
  type WebhookHistoryEntry,
} from "@/core/webhook";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { Switch } from "@/ui/Switch";
import { TextInput } from "@/ui/TextInput";
import { TrashIcon } from "@/ui/Icon";
import { IconButton } from "@/ui/IconButton";
import { pushToast } from "@/ui/Toast";
import styles from "./SendPanel.module.css";

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "ok"; status: number }
  | { kind: "error"; message: string; retryAfter?: number };

export function SendPanel() {
  const message = useMessageStore((s) => s.message);

  const [url, setUrl] = useState("");
  const [threadId, setThreadId] = useState("");
  const [label, setLabel] = useState("");
  const [remember, setRemember] = useState(false);
  const [revealUrl, setRevealUrl] = useState(false);
  const [history, setHistory] = useState<WebhookHistoryEntry[]>(() => loadHistory());
  const [state, setState] = useState<SendState>({ kind: "idle" });

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const parsedUrl = useMemo(() => parseWebhookUrl(url), [url]);
  const urlInvalid = url.trim().length > 0 && !parsedUrl;

  const validation = useMemo(() => validateMessage(message), [message]);
  const blockingIssues = validation.issues.filter((i) => i.severity === "error");

  const sending = state.kind === "sending";

  const handleSend = async () => {
    if (!parsedUrl) {
      setState({ kind: "error", message: "Enter a valid Discord webhook URL." });
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
    const result = await sendToWebhook(parsedUrl, message, {
      threadId: threadId.trim() || undefined,
      signal: ac.signal,
    });

    if (result.ok) {
      setState({ kind: "ok", status: result.status });
      pushToast("Message delivered to Discord.", "success");
      if (remember) {
        const entry = rememberWebhook(parsedUrl.url, label);
        if (entry) setHistory(loadHistory());
      } else {
        // Even when not remembering, refresh lastUsedAt on a known entry so
        // recents stay ordered by most-recent.
        touchWebhook(parsedUrl.id);
        setHistory(loadHistory());
      }
    } else {
      setState({
        kind: "error",
        message: result.error,
        retryAfter: result.retryAfter,
      });
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    setState({ kind: "idle" });
  };

  const handleUseHistoryEntry = (entry: WebhookHistoryEntry) => {
    setUrl(entry.url);
    setLabel(entry.label);
    setRemember(true);
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

      <div className={styles.rememberRow}>
        <Switch
          checked={remember}
          onChange={(e) => setRemember(e.currentTarget.checked)}
          label="Remember this URL in this browser"
        />
      </div>

      {remember ? (
        <Field label="Label (optional)" hint="Helps you identify the webhook in the recents list.">
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
          Sent. Discord returned {state.status === 204 ? "204 No Content" : state.status}.
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
          disabled={sending || !parsedUrl || blockingIssues.length > 0}
        >
          {sending ? "Sending…" : "Send to webhook"}
        </Button>
      </div>
    </>
  );
}
