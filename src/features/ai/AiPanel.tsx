/**
 * AI assistant panel (a tab in the Share dialog).
 *
 * Describe the message you want in plain language; an on-device model rewrites
 * the editor's component tree to match. No request ever leaves the browser —
 * after the one-time model download it works with the network fully off.
 *
 * The panel is deliberately self-contained: model selection + load lives at the
 * top, the transcript in the middle, and the composer at the bottom. All real
 * work is delegated to `aiStore`.
 */

import { useEffect, useRef, useState } from "react";
import { Button } from "@/ui/Button";
import { Select } from "@/ui/Select";
import { SparkleIcon } from "@/ui/Icon";
import { cn } from "@/lib/cn";
import { LOCAL_MODELS } from "./models";
import { isAiSupported, useAiStore } from "./aiStore";
import styles from "./AiPanel.module.css";

const SUGGESTIONS = [
  "A welcome card with a heading, a short intro, and a green 'Get started' link button",
  "Make it look like an embed with a blurple accent stripe",
  "Add a row of three link buttons: Docs, GitHub, Support",
  "Add an image gallery with two placeholder images",
];

export function AiPanel() {
  if (!isAiSupported()) return <UnsupportedNotice />;
  return <Assistant />;
}

function UnsupportedNotice() {
  return (
    <div className={styles.notice}>
      <SparkleIcon size={18} />
      <div>
        <p className={styles.noticeTitle}>WebGPU isn’t available in this browser</p>
        <p className={styles.noticeBody}>
          The assistant runs the AI model on your own device, which needs WebGPU. Open this page in
          a recent desktop <strong>Chrome</strong>, <strong>Edge</strong>, or{" "}
          <strong>Safari 18+</strong> to use it. Everything else in the builder works without it.
        </p>
      </div>
    </div>
  );
}

function Assistant() {
  const modelId = useAiStore((s) => s.modelId);
  const status = useAiStore((s) => s.status);
  const progressRatio = useAiStore((s) => s.progressRatio);
  const progressText = useAiStore((s) => s.progressText);
  const cached = useAiStore((s) => s.cached);
  const error = useAiStore((s) => s.error);
  const generating = useAiStore((s) => s.generating);
  const messages = useAiStore((s) => s.messages);

  const setModel = useAiStore((s) => s.setModel);
  const load = useAiStore((s) => s.load);
  const send = useAiStore((s) => s.send);
  const clearChat = useAiStore((s) => s.clearChat);
  const refreshCache = useAiStore((s) => s.refreshCache);

  const [draft, setDraft] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void refreshCache();
  }, [refreshCache, modelId]);

  // Keep the latest turn in view.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, generating]);

  const busy = status === "loading" || generating;
  const model = LOCAL_MODELS.find((m) => m.id === modelId);

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    void send(text);
  };

  return (
    <div className={styles.panel}>
      <div className={styles.setup}>
        <div className={styles.modelRow}>
          <Select
            aria-label="Model"
            value={modelId}
            disabled={status === "loading"}
            onChange={(e) => setModel(e.currentTarget.value)}
          >
            {LOCAL_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} · {m.size}
              </option>
            ))}
          </Select>
          {status === "ready" ? (
            <span className={cn(styles.badge, styles.badgeReady)}>Ready · offline</span>
          ) : cached ? (
            <span className={styles.badge}>Cached · loads offline</span>
          ) : (
            <span className={styles.badge}>One-time download</span>
          )}
        </div>
        {model ? <p className={styles.modelBlurb}>{model.blurb}</p> : null}

        {status !== "ready" ? (
          <div className={styles.loadRow}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void load()}
              disabled={status === "loading"}
            >
              {status === "loading" ? "Loading…" : cached ? "Load model" : "Download & load model"}
            </Button>
            {status === "loading" ? (
              <div className={styles.progress} role="status" aria-live="polite">
                <div className={styles.progressBar}>
                  <div
                    className={styles.progressFill}
                    style={{
                      width: progressRatio != null ? `${Math.round(progressRatio * 100)}%` : "40%",
                    }}
                  />
                </div>
                <span className={styles.progressText}>{progressText}</span>
              </div>
            ) : null}
          </div>
        ) : null}

        {error ? <div className={styles.error}>{error}</div> : null}
      </div>

      <div className={styles.thread} ref={threadRef}>
        {messages.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyLead}>
              Describe the message you want — the AI edits the builder for you, on your device.
            </p>
            <div className={styles.suggestions}>
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={styles.suggestion}
                  disabled={busy}
                  onClick={() => void send(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => <Bubble key={m.id} message={m} />)
        )}
        {generating ? (
          <div className={cn(styles.bubble, styles.assistant)}>
            <span className={styles.typing}>Thinking…</span>
          </div>
        ) : null}
      </div>

      <div className={styles.composer}>
        <textarea
          className={styles.input}
          rows={2}
          placeholder="e.g. Add a red 'Delete' button under the text"
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className={styles.composerActions}>
          {messages.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={clearChat} disabled={busy}>
              Clear
            </Button>
          ) : (
            <span />
          )}
          <Button
            variant="primary"
            size="sm"
            leadingIcon={<SparkleIcon />}
            onClick={submit}
            disabled={busy || draft.trim().length === 0}
          >
            {generating ? "Working…" : "Generate"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Bubble({
  message,
}: {
  message: {
    role: "user" | "assistant";
    text: string;
    failed?: boolean;
    issues?: { severity: string; message: string }[];
  };
}) {
  const errors = (message.issues ?? []).filter((i) => i.severity === "error");
  const warnings = (message.issues ?? []).filter((i) => i.severity === "warning");
  return (
    <div
      className={cn(
        styles.bubble,
        message.role === "user" ? styles.user : styles.assistant,
        message.failed && styles.failed,
      )}
    >
      <span className={styles.bubbleText}>{message.text}</span>
      {errors.length > 0 || warnings.length > 0 ? (
        <ul className={styles.issues}>
          {errors.slice(0, 4).map((i, idx) => (
            <li key={`e${idx}`} className={styles.issueError}>
              {i.message}
            </li>
          ))}
          {warnings.slice(0, 3).map((i, idx) => (
            <li key={`w${idx}`} className={styles.issueWarn}>
              {i.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
