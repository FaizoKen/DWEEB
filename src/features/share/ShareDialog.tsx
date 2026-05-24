/**
 * Share dialog — five tabs:
 *  - Send        : POST the current message to a Discord webhook (or PATCH
 *                  the original when the editor holds a restored message).
 *  - Restore     : GET a previously-posted webhook message back into the
 *                  editor by webhook URL + message ID/link.
 *  - Share link  : compressed URL containing the entire message state.
 *  - JSON export : the wire-format payload, ready to POST manually.
 *  - Import      : paste either a share token or a raw JSON payload.
 *
 * The dialog is stateless w.r.t. the message — it reads from the store on
 * open and pushes the parsed message back through `replaceMessage` (or
 * `replaceMessageFromRestore`) on import.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { TextArea } from "@/ui/TextArea";
import { TextInput } from "@/ui/TextInput";
import {
  buildShareUrl,
  copyText,
  decodeJson,
  decodeShare,
  encodeJson,
  encodeShare,
  writeShareTokenToHash,
} from "@/core/serialization";
import {
  fetchWebhookMessage,
  parseMessageIdInput,
  parseWebhookUrl,
} from "@/core/webhook";
import { pushToast } from "@/ui/Toast";
import { validateMessage } from "@/core/schema/validation";
import { cn } from "@/lib/cn";
import { SendPanel } from "./SendPanel";
import styles from "./ShareDialog.module.css";

type Tab = "send" | "restore" | "share" | "json" | "import";

interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Tab to land on when the dialog opens. The toolbar's dedicated "Send"
   * button uses this to drop the user straight onto the Send panel; the
   * generic "Share / Export" entry defaults to Send too, since that's the
   * action a beginner is most likely looking for after building.
   */
  initialTab?: Tab;
}

export function ShareDialog({ open, onClose, initialTab = "send" }: ShareDialogProps) {
  const [tab, setTab] = useState<Tab>(initialTab);

  // Snap to the requested tab whenever the dialog re-opens, so opening from
  // a different entry point doesn't show the last tab the user was on.
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);
  return (
    <Modal open={open} onClose={onClose} title="Share / Send / Export">
      <div className={styles.tabs} role="tablist">
        <TabButton active={tab === "send"} onClick={() => setTab("send")}>
          Send
        </TabButton>
        <TabButton active={tab === "restore"} onClick={() => setTab("restore")}>
          Restore
        </TabButton>
        <TabButton active={tab === "share"} onClick={() => setTab("share")}>
          Share link
        </TabButton>
        <TabButton active={tab === "json"} onClick={() => setTab("json")}>
          JSON export
        </TabButton>
        <TabButton active={tab === "import"} onClick={() => setTab("import")}>
          Import
        </TabButton>
      </div>
      <div className={styles.body}>
        {tab === "send" ? <SendPanel /> : null}
        {tab === "restore" ? <RestorePanel onDone={onClose} /> : null}
        {tab === "share" ? <ShareLinkPanel /> : null}
        {tab === "json" ? <JsonExportPanel /> : null}
        {tab === "import" ? <ImportPanel onDone={onClose} /> : null}
      </div>
    </Modal>
  );
}

function TabButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={cn(styles.tab, active && styles.tabActive)}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ShareLinkPanel() {
  const message = useMessageStore((s) => s.message);
  const token = useMemo(() => encodeShare(message), [message]);
  const url = useMemo(() => buildShareUrl(token), [token]);

  return (
    <>
      <p className={styles.lead}>
        Anyone who opens this URL loads the exact message tree below. The state lives entirely
        in the URL hash — nothing is uploaded.
      </p>
      <TextArea readOnly rows={4} value={url} />
      <div className={styles.statsRow}>
        <span className={styles.statChip}>URL length · {url.length}</span>
        <span className={styles.statChip}>Token length · {token.length}</span>
      </div>
      <div className={styles.actions}>
        <Button
          variant="primary"
          onClick={async () => {
            if (await copyText(url)) pushToast("Share URL copied", "success");
            else pushToast("Copy failed — your browser blocked the clipboard.", "error");
          }}
        >
          Copy URL
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            writeShareTokenToHash(token);
            pushToast("URL updated. Reload to verify.", "info");
          }}
        >
          Update address bar
        </Button>
      </div>
    </>
  );
}

function JsonExportPanel() {
  const message = useMessageStore((s) => s.message);
  const json = useMemo(() => encodeJson(message), [message]);
  return (
    <>
      <p className={styles.lead}>
        POST this body to your webhook URL with the <code>?with_components=true</code> query
        parameter and the Components V2 message flag set on the receiving bot.
      </p>
      <TextArea readOnly rows={14} value={json} className={styles.mono} />
      <div className={styles.actions}>
        <Button
          variant="primary"
          onClick={async () => {
            if (await copyText(json)) pushToast("JSON copied", "success");
            else pushToast("Copy failed", "error");
          }}
        >
          Copy JSON
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            const blob = new Blob([json], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "webhook-message.json";
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Download file
        </Button>
      </div>
    </>
  );
}

function ImportPanel({ onDone }: { onDone: () => void }) {
  const replace = useMessageStore((s) => s.replaceMessage);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState<string | null>(null);

  const handleImport = () => {
    const value = ref.current?.value.trim() ?? "";
    if (!value) {
      setError("Paste a share URL, share token, or JSON payload.");
      return;
    }
    // Try share URL first.
    const urlMatch = /#s=([^&]+)/.exec(value);
    if (urlMatch) {
      const result = decodeShare(urlMatch[1]!);
      finish(result);
      return;
    }
    // Maybe a bare token (`v.body`).
    if (/^\d+\./.test(value)) {
      const result = decodeShare(value);
      finish(result);
      return;
    }
    // Fall back to JSON.
    const result = decodeJson(value);
    finish(result);
  };

  function finish(result: ReturnType<typeof decodeJson>) {
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const validation = validateMessage(result.message);
    replace(result.message);
    setError(null);
    if (!validation.ok) {
      pushToast(
        `Imported with ${validation.issues.length} validation issue${validation.issues.length === 1 ? "" : "s"}.`,
        "info",
      );
    } else {
      pushToast("Imported.", "success");
    }
    onDone();
  }

  return (
    <>
      <p className={styles.lead}>
        Paste a share URL, a share token, or a Components V2 JSON payload. This replaces the
        current message.
      </p>
      <TextArea
        ref={ref}
        rows={10}
        placeholder='{ "components": [ … ] }'
        invalid={!!error}
      />
      {error ? <div className={styles.error}>{error}</div> : null}
      <div className={styles.actions}>
        <Button variant="primary" onClick={handleImport}>
          Replace message
        </Button>
      </div>
    </>
  );
}

/* ── Restore panel ─────────────────────────────────────────────────────
 *
 * Fetches a message that was previously posted by the same webhook and
 * loads it into the editor. Only the webhook that originally sent the
 * message can read it back — Discord 404s for anything else, even messages
 * from the same channel posted by users or other bots/webhooks.
 *
 * On success we record the origin in the store so the Send panel can offer
 * "Update existing" (PATCH) instead of "Send as new" (POST) by default.
 */
function RestorePanel({ onDone }: { onDone: () => void }) {
  const replaceFromRestore = useMessageStore((s) => s.replaceMessageFromRestore);
  const restoredFrom = useMessageStore((s) => s.restoredFrom);

  // Prefill when the user reopens the panel against an already-restored message.
  const [url, setUrl] = useState(() => restoredFrom?.webhookUrl ?? "");
  const [revealUrl, setRevealUrl] = useState(false);
  const [idInput, setIdInput] = useState(() => restoredFrom?.messageId ?? "");
  const [threadId, setThreadId] = useState(() => restoredFrom?.threadId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedUrl = useMemo(() => parseWebhookUrl(url), [url]);
  const messageId = useMemo(() => parseMessageIdInput(idInput), [idInput]);
  const urlInvalid = url.trim().length > 0 && !parsedUrl;
  const idInvalid = idInput.trim().length > 0 && !messageId;

  const handleFetch = async () => {
    setError(null);
    if (!parsedUrl) {
      setError("Enter a valid Discord webhook URL.");
      return;
    }
    if (!messageId) {
      setError("Enter a message ID or a Discord message link.");
      return;
    }

    setBusy(true);
    const result = await fetchWebhookMessage(parsedUrl, messageId, {
      threadId: threadId.trim() || undefined,
    });
    setBusy(false);

    if (!result.ok) {
      // 404 from this endpoint almost always means "wrong webhook for that
      // message" — call that out explicitly, the raw error is unhelpful.
      if (result.status === 404) {
        setError(
          "Discord couldn't find that message under this webhook. Only messages that " +
            "this same webhook originally posted can be restored.",
        );
      } else {
        setError(result.error);
      }
      return;
    }

    const validation = validateMessage(result.message);
    replaceFromRestore(result.message, {
      webhookUrl: parsedUrl.url,
      messageId,
      threadId: threadId.trim() || undefined,
    });
    if (!validation.ok) {
      pushToast(
        `Restored with ${validation.issues.length} validation issue${validation.issues.length === 1 ? "" : "s"}.`,
        "info",
      );
    } else {
      pushToast("Restored. Edits will update the original by default.", "success");
    }
    onDone();
  };

  return (
    <>
      <p className={styles.lead}>
        Pull a previously-posted webhook message back into the editor. Discord only allows this
        for messages <strong>this webhook</strong> originally sent — not for user or bot
        messages, even in the same channel.
      </p>

      <Field
        label="Webhook URL"
        hint="The same URL you used (or would use) to post."
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

      <Field
        label="Message ID or link"
        hint="Right-click the message in Discord → Copy Message ID (Developer Mode), or paste the message URL."
        error={idInvalid ? "Not a valid message ID or Discord message link." : undefined}
      >
        {(id) => (
          <TextInput
            id={id}
            value={idInput}
            onChange={(e) => setIdInput(e.currentTarget.value)}
            invalid={idInvalid}
            placeholder="1185234567890123456  ·  or  https://discord.com/channels/…"
            spellCheck={false}
          />
        )}
      </Field>

      <Field label="Thread ID (optional)" hint="Required only if the message lives in a thread.">
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

      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.actions}>
        <Button
          variant="primary"
          onClick={handleFetch}
          disabled={busy || !parsedUrl || !messageId}
        >
          {busy ? "Fetching…" : "Restore into editor"}
        </Button>
      </div>
    </>
  );
}
