/**
 * "Connect an AI client" dialog.
 *
 * DWEEB speaks the Model Context Protocol, but the feature was invisible from
 * inside the app: the connector URL lived only in `docs/mcp.md`, so the one
 * thing a person actually needs — a URL to paste into Claude — was somewhere
 * they would never look. This is that URL, with a copy button.
 *
 * One route on purpose. There is a second way to speak MCP (a server the client
 * launches locally from a clone of this repository), but that is a developer's
 * path: it needs a checkout, a runtime, and a webhook URL pasted into an
 * environment variable. Offering it here would put a dead end in front of
 * everyone who just wants to connect Claude to the app they are already using.
 *
 * Shown only when the deployment actually serves the endpoint (see
 * `core/mcp/availability`) — handing someone a URL that answers 501 would send
 * them through a setup that cannot work and make it look like their mistake.
 * The menu entry is gated the same way, so this never opens empty.
 */

import { useState } from "react";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { CopyIcon, ExternalLinkIcon, SparkleIcon } from "@/ui/Icon";
import { pushToast } from "@/ui/Toast";
import { copyText } from "@/core/serialization/clipboard";
import { mcpEndpointUrl } from "@/core/mcp/availability";
import { useMcpStore } from "./mcpStore";
import styles from "./ConnectAiDialog.module.css";

const DOCS_URL = "https://github.com/FaizoKen/DWEEB/blob/main/docs/mcp.md";

export function ConnectAiDialog() {
  const close = useMcpStore((s) => s.closeMcp);
  const endpoint = mcpEndpointUrl();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const ok = await copyText(endpoint);
    if (!ok) {
      pushToast("Couldn't copy — select the address and copy it manually.", "error");
      return;
    }
    setCopied(true);
    pushToast("Copied.", "success");
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <Modal
      open
      onClose={close}
      title="Connect an AI client"
      footer={
        <>
          <Button
            variant="secondary"
            leadingIcon={<ExternalLinkIcon />}
            onClick={() => window.open(DOCS_URL, "_blank", "noopener,noreferrer")}
          >
            Read the guide
          </Button>
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      <div className={styles.hero} aria-hidden="true">
        <span className={styles.heroIcon}>
          <SparkleIcon size={26} />
        </span>
      </div>

      <p className={styles.lead}>
        DWEEB speaks the <strong>Model Context Protocol</strong>, so Claude — or any MCP client —
        can build, check, and post your messages using the same templates and validation as this
        editor.
      </p>

      <section className={styles.section}>
        <h3 className={styles.heading}>Add DWEEB as a connector</h3>
        <p className={styles.body}>
          In Claude, open <strong>Settings → Connectors → Add custom connector</strong> and paste
          this address. Leave the OAuth fields blank.
        </p>
        <div className={styles.copyRow}>
          <code className={styles.code}>{endpoint}</code>
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<CopyIcon />}
            onClick={() => void copy()}
            aria-label="Copy the connector address"
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className={styles.fine}>
          You&rsquo;ll sign in with Discord. The connector acts as your account, so it can only
          reach servers and channels you can already reach.
        </p>
      </section>
    </Modal>
  );
}
