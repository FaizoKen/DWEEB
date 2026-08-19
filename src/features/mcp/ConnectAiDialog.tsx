/**
 * "Connect an AI client" dialog.
 *
 * DWEEB speaks the Model Context Protocol, but the feature was invisible from
 * inside the app: the connector URL lived only in `docs/mcp.md`, so the one
 * thing a person actually needs — a URL to give Claude — was somewhere they
 * would never look.
 *
 * It is deliberately the *whole* instruction set rather than a pointer to one.
 * There is only one route to offer — the local stdio server was removed, so
 * nothing here needs a checkout, a runtime, or a token pasted into an env var.
 * A "Read the guide" button used to sit in the footer next to Done; it went to
 * `docs/mcp.md`, which is a maintainer's document (Rust internals, the OAuth
 * exchange, how the validator is pinned) and answers none of the questions
 * someone in this dialog is holding. Sending them to GitHub to read about
 * `MCP_ENABLED` instead of naming the steps here was the bug. If a link ever
 * comes back, point it at the public feature page
 * (`/features/discord-mcp-server/`), never at the repository.
 *
 * The primary path is now a one-click install link rather than a copy-paste
 * drill (see `claudeInstallUrl`), so the address itself is demoted to the
 * manual fallback beneath the steps — it is still needed by every client that
 * is not claude.ai, and it is one click away for anyone who prefers it.
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

/** Where claude.ai keeps an individual account's connectors. */
const CLAUDE_CONNECTORS_URL = "https://claude.ai/customize/connectors";

/**
 * Anthropic's documented *install link*: it opens the Add custom connector
 * dialog with the name and address already filled in, so the whole flow is one
 * click plus a confirmation instead of copy → navigate → find the button →
 * paste. Claude shows the user that the values came from an external link and
 * still makes them confirm, so this prefills a form and grants nothing —
 * that's why it is safe to lead with.
 *
 * Two details that are easy to get wrong. `connectorUrl` must be
 * percent-encoded, which is why this builds through `URLSearchParams` rather
 * than string concatenation — our endpoint carries `://` and a path. And this
 * is the *documented* form: an internal-looking variant that routes through
 * `/new?modal=…#settings/…` also opens the dialog today, but it is app
 * routing rather than a published contract, and a signed-out visitor lands on
 * a logout screen instead of the connector page (verified 2026-08-19). The
 * documented link signs them in and then delivers them to the prefilled
 * dialog, so prefer it even though both work while signed in.
 *
 * It covers claude.ai personal accounts. A Team/Enterprise **owner** adding a
 * connector for their whole org takes the same parameters on
 * `/admin-settings/connectors`, and Claude Desktop has no URL at all — which
 * is what the manual address below the steps is for.
 */
function claudeInstallUrl(endpoint: string): string {
  const params = new URLSearchParams({
    modal: "add-custom-connector",
    connectorName: "DWEEB",
    connectorUrl: endpoint,
  });
  return `${CLAUDE_CONNECTORS_URL}?${params.toString()}`;
}

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
            <h3 className={styles.stepTitle}>Add DWEEB to Claude</h3>
            <p className={styles.stepText}>
              This opens Claude&rsquo;s <strong>Add custom connector</strong> dialog with the
              address already filled in — check it over and click <strong>Add</strong>. Nothing to
              install or host, and no OAuth ID or secret to enter.
            </p>
            <a
              className={styles.installButton}
              href={claudeInstallUrl(endpoint)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Add to Claude
              <ExternalLinkIcon size={14} />
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

      <div className={styles.manual}>
        <p className={styles.manualLabel}>
          Using Claude Desktop or another client? Add this address by hand:
        </p>
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

      <p className={styles.example}>
        Then just ask for what you want — &ldquo;announce Friday&rsquo;s event in #general with an
        RSVP button&rdquo; — and review it in this editor before it goes out.
      </p>
    </Modal>
  );
}
