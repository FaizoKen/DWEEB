/**
 * "Connect an AI client" dialog.
 *
 * DWEEB speaks the Model Context Protocol, but the feature was invisible from
 * inside the app: the connector URL lived only in `docs/mcp.md`, so the one
 * thing a person actually needs — a URL to paste into Claude — was somewhere
 * they would never look. This is that URL, with a copy button.
 *
 * It is deliberately the *whole* instruction set rather than a pointer to one.
 * Connecting is three steps (copy the address, add it in Claude, sign in with
 * Discord) and there is only one route to offer — the local stdio server was
 * removed, so nothing here needs a checkout, a runtime, or a token pasted into
 * an env var. A "Read the guide" button used to sit in the footer next to Done;
 * it went to `docs/mcp.md`, which is a maintainer's document (Rust internals,
 * the OAuth exchange, how the validator is pinned) and answers none of the
 * questions someone in this dialog is holding. Sending them to GitHub to read
 * about `MCP_ENABLED` instead of just naming the three steps here was the bug.
 * If a link ever comes back, point it at the public feature page
 * (`/features/discord-mcp-server/`), never at the repository.
 *
 * Shown only when the deployment actually serves the endpoint (see
 * `core/mcp/availability`) — handing someone a URL that answers 501 would send
 * them through a setup that cannot work and make it look like their mistake.
 * The menu entry is gated the same way, so this never opens empty.
 */

import { useState } from "react";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { CheckCircleIcon, CopyIcon, ExternalLinkIcon, SparkleIcon } from "@/ui/Icon";
import { pushToast } from "@/ui/Toast";
import { copyText } from "@/core/serialization/clipboard";
import { mcpEndpointUrl } from "@/core/mcp/availability";
import { useMcpStore } from "./mcpStore";
import styles from "./ConnectAiDialog.module.css";

/**
 * Where an individual claude.ai account adds a custom connector (verified
 * against Anthropic's own instructions, 2026-08-19). Deliberately a real
 * anchor rather than a button: it is a URL, so it should be middle-clickable
 * and copyable like one.
 *
 * It is a shortcut, never the instruction — the written path stays beside it,
 * because this link is right for exactly one of the three ways in. A Team or
 * Enterprise **owner** adds connectors at `/admin-settings/connectors`
 * instead, and Claude Desktop has no web URL at all. Both of those land here
 * on a page that at worst isn't where their Add button lives, which is why the
 * step still names the menu path in words. If Claude moves the page, fix the
 * URL *and* the step text together.
 */
const CLAUDE_CONNECTORS_URL = "https://claude.ai/customize/connectors";

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
        <Button variant="primary" onClick={close}>
          Done
        </Button>
      }
    >
      <div className={styles.hero} aria-hidden="true">
        <span className={styles.heroIcon}>
          <SparkleIcon size={26} />
        </span>
      </div>

      <p className={styles.lead}>
        Add DWEEB to <strong>Claude</strong> — or any client that speaks the{" "}
        <strong>Model Context Protocol</strong> — and it can build, check, and post your Discord
        messages using the same templates and validation as this editor.
      </p>

      <ol className={styles.steps} role="list">
        <li className={styles.step}>
          <div className={styles.stepBody}>
            <h3 className={styles.stepTitle}>Copy DWEEB&rsquo;s connector address</h3>
            <div className={styles.copyRow}>
              <code className={styles.code}>{endpoint}</code>
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={copied ? <CheckCircleIcon /> : <CopyIcon />}
                onClick={() => void copy()}
                aria-label="Copy the connector address"
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        </li>

        <li className={styles.step}>
          <div className={styles.stepBody}>
            <h3 className={styles.stepTitle}>Add it as a connector in Claude</h3>
            <p className={styles.stepText}>
              Open <strong>Customize → Connectors</strong>, click <strong>+</strong> →{" "}
              <strong>Add custom connector</strong>, and paste the address. Leave{" "}
              <em>Advanced settings</em> alone — there is no OAuth ID or secret to enter. In Claude
              Desktop the same page is under Settings.
            </p>
            <a
              className={styles.stepLink}
              href={CLAUDE_CONNECTORS_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Claude&rsquo;s connectors
              <ExternalLinkIcon size={13} />
            </a>
          </div>
        </li>

        <li className={styles.step}>
          <div className={styles.stepBody}>
            <h3 className={styles.stepTitle}>Sign in with Discord</h3>
            <p className={styles.stepText}>
              Claude sends you to Discord once to authorize. The connector then acts as{" "}
              <strong>your account</strong>, so it can only reach the servers and channels you can
              already reach.
            </p>
          </div>
        </li>
      </ol>

      <p className={styles.example}>
        Then just ask for what you want — &ldquo;announce Friday&rsquo;s event in #general with an
        RSVP button&rdquo; — and review it in this editor before it goes out.
      </p>
    </Modal>
  );
}
