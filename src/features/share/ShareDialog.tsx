/**
 * Share dialog — four tabs:
 *  - Send        : POST the current message to a Discord webhook.
 *  - Share link  : compressed URL containing the entire message state.
 *  - JSON export : the wire-format payload, ready to POST manually.
 *  - Import      : paste either a share token or a raw JSON payload.
 *
 * The dialog is stateless w.r.t. the message — it reads from the store on
 * open and pushes the parsed message back through `replaceMessage` on import.
 */

import { useMemo, useRef, useState } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { TextArea } from "@/ui/TextArea";
import {
  buildShareUrl,
  copyText,
  decodeJson,
  decodeShare,
  encodeJson,
  encodeShare,
  writeShareTokenToHash,
} from "@/core/serialization";
import { pushToast } from "@/ui/Toast";
import { validateMessage } from "@/core/schema/validation";
import { cn } from "@/lib/cn";
import { SendPanel } from "./SendPanel";
import styles from "./ShareDialog.module.css";

interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
}

type Tab = "send" | "share" | "json" | "import";

export function ShareDialog({ open, onClose }: ShareDialogProps) {
  const [tab, setTab] = useState<Tab>("send");
  return (
    <Modal open={open} onClose={onClose} title="Share / Send / Export">
      <div className={styles.tabs} role="tablist">
        <TabButton active={tab === "send"} onClick={() => setTab("send")}>
          Send
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
