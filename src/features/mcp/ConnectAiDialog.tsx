/**
 * "Connect an AI client" dialog.
 *
 * DWEEB speaks the Model Context Protocol, but until this existed the feature
 * was invisible from inside the app: the connector URL lived only in
 * `docs/mcp.md`, so the one thing a person actually needs — a URL to paste into
 * Claude — was somewhere they would never look. This is that URL, with the two
 * ways to connect and a copy button on each.
 *
 * Two paths, because the clients split cleanly:
 *
 *  - **Remote** — claude.ai's custom connectors, which cannot launch a local
 *    process, so they need the hosted `/mcp` endpoint. One URL, and Discord
 *    handles the sign-in.
 *  - **Local** — Claude Code / Claude Desktop, which do launch commands, so
 *    they run the stdio server straight out of a clone. Nothing to host, and no
 *    account.
 *
 * The remote half is shown only when the deployment actually serves it (see
 * `core/mcp/availability`); handing someone a URL that answers 501 would send
 * them through a setup that cannot work and make it look like their mistake.
 * The whole entry point is gated the same way, so this dialog never opens with
 * nothing useful in it.
 */

import { useState } from "react";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { CopyIcon, ExternalLinkIcon, SparkleIcon } from "@/ui/Icon";
import { pushToast } from "@/ui/Toast";
import { copyText } from "@/core/serialization/clipboard";
import { mcpEndpointUrl, useMcpConfigured } from "@/core/mcp/availability";
import { useMcpStore } from "./mcpStore";
import styles from "./ConnectAiDialog.module.css";

const DOCS_URL = "https://github.com/FaizoKen/DWEEB/blob/main/docs/mcp.md";

/** The command a local client is pointed at. `<path-to-DWEEB>` is left as a
 *  placeholder on purpose — only the person running it knows where they cloned
 *  it, and a fake absolute path would look copy-pasteable and fail. */
const LOCAL_COMMAND = "claude mcp add dweeb -- bun <path-to-DWEEB>/mcp/src/main.ts";

/** One copyable line: monospace value plus a copy button. */
function CopyRow({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const ok = await copyText(value);
    if (!ok) {
      pushToast("Couldn't copy — select the text and copy it manually.", "error");
      return;
    }
    setCopied(true);
    pushToast("Copied.", "success");
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className={styles.copyRow}>
      <code className={styles.code}>{value}</code>
      <Button
        variant="secondary"
        size="sm"
        leadingIcon={<CopyIcon />}
        onClick={() => void copy()}
        aria-label={label}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

export function ConnectAiDialog() {
  const close = useMcpStore((s) => s.closeMcp);
  const remoteAvailable = useMcpConfigured();
  const endpoint = mcpEndpointUrl();

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

      {remoteAvailable && endpoint ? (
        <section className={styles.section}>
          <h3 className={styles.heading}>claude.ai</h3>
          <p className={styles.body}>
            In claude.ai, open <strong>Settings → Connectors → Add custom connector</strong> and
            paste this URL. Leave the OAuth fields blank.
          </p>
          <CopyRow value={endpoint} label="Copy the connector URL" />
          <p className={styles.fine}>
            You&rsquo;ll sign in with Discord. The connector acts as your account, so it can only
            reach servers and channels you can already reach.
          </p>
        </section>
      ) : null}

      <section className={styles.section}>
        <h3 className={styles.heading}>Claude Code &amp; Claude Desktop</h3>
        <p className={styles.body}>
          These launch the server themselves, straight from a clone of the DWEEB repository — no
          account needed.
        </p>
        <CopyRow value={LOCAL_COMMAND} label="Copy the setup command" />
        <p className={styles.fine}>
          Needs{" "}
          <a href="https://bun.sh" target="_blank" rel="noopener noreferrer">
            Bun
          </a>{" "}
          and the repository on your machine. Point it at a webhook to let it post.
        </p>
      </section>
    </Modal>
  );
}
