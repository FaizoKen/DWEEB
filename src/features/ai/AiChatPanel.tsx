/**
 * AI chat panel — docks to the far right of the app.
 *
 * The assistant edits the live message directly: when the model returns a
 * message payload, the store applies it through the normal import path and the
 * preview (center pane on desktop) updates instantly. The panel itself only
 * shows the conversation and a small "updated the message" affordance.
 *
 * Two views share the panel body: the settings form (forced when no key is
 * configured yet) and the chat transcript + composer.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { IconButton } from "@/ui/IconButton";
import { CloseIcon, SendIcon, SettingsIcon, SparkleIcon, TrashIcon } from "@/ui/Icon";
import { useAiStore } from "@/core/ai/aiStore";
import { PROVIDERS } from "@/core/ai/providerMeta";
import type { ChatMessage } from "@/core/ai/types";
import { AiSettingsForm } from "./AiSettingsForm";
import styles from "./AiChatPanel.module.css";

const SUGGESTIONS = [
  "Build a welcome message in a blurple container with a title and a Join button.",
  "Add a row of link buttons to the docs and GitHub.",
  "Make an announcement with a heading, a short blurb, and an image gallery.",
  "Turn this into a clean product card with a thumbnail and a buy button.",
];

export function AiChatPanel() {
  const titleId = useId();
  const open = useAiStore((s) => s.open);
  const closePanel = useAiStore((s) => s.closePanel);
  const messages = useAiStore((s) => s.messages);
  const thinking = useAiStore((s) => s.thinking);
  const error = useAiStore((s) => s.error);
  const send = useAiStore((s) => s.send);
  const cancel = useAiStore((s) => s.cancel);
  const clearChat = useAiStore((s) => s.clearChat);
  const settings = useAiStore((s) => s.settings);
  const isConfigured = useAiStore((s) => s.isConfigured());

  // "settings" view is forced until a key exists; afterwards the gear toggles it.
  const [showSettings, setShowSettings] = useState(false);
  const view = !isConfigured || showSettings ? "settings" : "chat";

  const [draft, setDraft] = useState("");
  const panelRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const latestMessage = messages[messages.length - 1];
  const assistantStatus = thinking
    ? "AI is generating a response."
    : latestMessage?.role === "assistant" && !latestMessage.streaming
      ? latestMessage.appliedMessage
        ? "AI response complete. The message was updated."
        : "AI response complete."
      : "";

  // Keep the transcript pinned to the latest turn.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, thinking, view]);

  // Keep the off-screen, persistently mounted panel out of the focus order and
  // give opening/closing the same predictable focus lifecycle as a disclosure.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;
    if (!panel || open === wasOpen) return;

    if (open) {
      const active = document.activeElement;
      // On first open this panel is lazy-mounted after the launcher's CSS has
      // hidden it, so browsers may already report `body` as active. The marked
      // launcher remains connected and becomes visible again on close.
      openerRef.current =
        active instanceof HTMLElement && active !== document.body
          ? active
          : document.querySelector<HTMLElement>("[data-preview-opener='ai']");
      const target =
        view === "chat"
          ? inputRef.current
          : panel.querySelector<HTMLElement>(
              "[data-ai-settings] input:not([disabled]), [data-ai-settings] select:not([disabled]), [data-ai-settings] textarea:not([disabled]), [data-ai-settings] button:not([disabled])",
            );
      (target ?? panel).focus({ preventScroll: true });
      return;
    }

    // Only move focus when it was left inside the panel. Selecting something
    // in the preview can also close AI; in that case the user's new focus wins.
    const current = document.activeElement;
    if (current instanceof HTMLElement && current !== document.body && !panel.contains(current)) {
      return;
    }
    const opener = openerRef.current;
    requestAnimationFrame(() => {
      if (opener?.isConnected && !opener.closest("[inert]")) {
        opener.focus({ preventScroll: true });
      }
    });
  }, [open, view]);

  // Moving from settings back to chat should land on the composer too.
  useEffect(() => {
    if (!open) return;
    if (view === "chat") {
      inputRef.current?.focus({ preventScroll: true });
      return;
    }
    panelRef.current
      ?.querySelector<HTMLElement>(
        "[data-ai-settings] input:not([disabled]), [data-ai-settings] select:not([disabled]), [data-ai-settings] textarea:not([disabled]), [data-ai-settings] button:not([disabled])",
      )
      ?.focus({ preventScroll: true });
  }, [open, view]);

  const submit = (value: string) => {
    const text = value.trim();
    if (!text || thinking) return;
    setDraft("");
    void send(text);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit(draft);
    }
  };

  return (
    <aside
      ref={panelRef}
      className={cn(styles.panel, "app-shell__pane--ai")}
      data-open={open ? "true" : "false"}
      inert={open ? undefined : true}
      aria-hidden={open ? undefined : "true"}
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <header className={styles.header}>
        <div className={styles.title}>
          <SparkleIcon size={18} />
          <span id={titleId}>AI Assistant</span>
        </div>
        <div className={styles.headerActions}>
          {view === "chat" && messages.length > 0 ? (
            <IconButton label="Clear chat" size="sm" onClick={clearChat}>
              <TrashIcon size={16} />
            </IconButton>
          ) : null}
          <IconButton
            label={view === "settings" ? "Back to chat" : "AI settings"}
            size="sm"
            onClick={() => isConfigured && setShowSettings((v) => !v)}
            disabled={!isConfigured}
            aria-pressed={view === "settings"}
          >
            <SettingsIcon size={16} />
          </IconButton>
          <IconButton label="Close AI assistant" size="sm" onClick={closePanel}>
            <CloseIcon size={16} />
          </IconButton>
        </div>
      </header>

      {view === "settings" ? (
        <div className={styles.scroll} data-ai-settings>
          <AiSettingsForm
            showCancel={isConfigured}
            onCancel={() => setShowSettings(false)}
            onSaved={() => setShowSettings(false)}
          />
        </div>
      ) : (
        <>
          <div className={styles.scroll} ref={scrollRef}>
            {messages.length === 0 ? (
              <EmptyState provider={PROVIDERS[settings.provider].label} onPick={submit} />
            ) : (
              <ul
                className={styles.messages}
                role="log"
                aria-label="AI conversation"
                aria-live="off"
              >
                {messages.map((m) => (
                  <MessageBubble key={m.id} message={m} />
                ))}
              </ul>
            )}
            {error ? (
              <div className={styles.error} role="alert">
                {error}
              </div>
            ) : null}
            <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {assistantStatus}
            </div>
          </div>

          <form
            className={styles.composer}
            onSubmit={(e) => {
              e.preventDefault();
              submit(draft);
            }}
          >
            <textarea
              ref={inputRef}
              className={styles.input}
              rows={1}
              aria-label="Message the AI assistant"
              placeholder="Describe the message you want to build…"
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={onKeyDown}
            />
            {thinking ? (
              <button type="button" className={styles.stopBtn} onClick={cancel}>
                Stop
              </button>
            ) : (
              <button
                type="submit"
                className={styles.sendBtn}
                disabled={!draft.trim()}
                aria-label="Send message"
              >
                <SendIcon size={16} />
              </button>
            )}
          </form>
        </>
      )}
    </aside>
  );
}

function EmptyState({ provider, onPick }: { provider: string; onPick: (v: string) => void }) {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyIcon}>
        <SparkleIcon size={28} />
      </div>
      <h3 className={styles.emptyTitle}>Build with AI</h3>
      <p className={styles.emptyText}>
        Tell me what you want and I'll build it directly in the editor — using{" "}
        <strong>{provider}</strong>. Try one of these:
      </p>
      <div className={styles.suggestions}>
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" className={styles.suggestion} onClick={() => onPick(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const mine = message.role === "user";
  const streaming = message.streaming;
  return (
    <li className={mine ? styles.rowMine : styles.rowTheirs}>
      <div className={mine ? styles.bubbleMine : styles.bubbleTheirs}>
        {message.content ? (
          <p className={styles.bubbleText}>
            {message.content}
            {streaming ? <span className={styles.caret} aria-hidden="true" /> : null}
          </p>
        ) : streaming ? (
          // Streaming but no prose yet (still waiting on the first token, or the
          // reply opens straight into the JSON payload) — show typing dots.
          <span className={styles.typing} aria-label="Generating response">
            <span className={styles.dot} />
            <span className={styles.dot} />
            <span className={styles.dot} />
          </span>
        ) : null}
        {message.appliedMessage ? (
          <div className={styles.applied}>
            <SparkleIcon size={13} />
            <span>
              Updated the message
              {message.issueCount
                ? ` · ${message.issueCount} validation issue${message.issueCount === 1 ? "" : "s"}`
                : ""}
            </span>
          </div>
        ) : null}
      </div>
    </li>
  );
}
