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
  convertV1Payload,
  copyText,
  createShortLink,
  decodeJson,
  decodeShare,
  detectV1Fields,
  encodeJson,
  encodeShare,
  isShortLinkConfigured,
  writeShareTokenToHash,
  type V1ImportNote,
} from "@/core/serialization";
import {
  classifyWebhookOwner,
  fetchWebhookMessage,
  loadHistory,
  parseMessageIdInput,
  parseWebhookUrl,
  rememberWebhook,
  verifyWebhook,
  webhookAvatarHash,
} from "@/core/webhook";
import { LockIcon } from "@/ui/Icon";
import { type IncomingWebhook } from "@/core/guild/config";
import { pushToast } from "@/ui/Toast";
import { validateMessage } from "@/core/schema/validation";
import { cn } from "@/lib/cn";
import { SendPanel } from "./SendPanel";
import { WebhookRecents } from "./WebhookRecents";
import { Callout } from "./Callout";
import styles from "./ShareDialog.module.css";

type Tab = "send" | "restore" | "share" | "json" | "import" | "about";

interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Tab to land on when the dialog opens. The Builder's action bar uses this
   * to drop the user straight onto the right panel for the button they
   * clicked (Send / Share / Restore).
   */
  initialTab?: Tab;
  /**
   * Forwarded to the Send panel: invoked when the user opts to clear the
   * interactive components a non-app webhook can't deliver. The App closes
   * the dialog and shows a confirmation over the editor.
   */
  onRequestRemoveInteractive?: () => void;
  /**
   * Forwarded to the Send panel: a webhook just created via Discord's
   * `webhook.incoming` flow (URL + resolved destination names), to prefill +
   * verify on open.
   */
  initialWebhook?: IncomingWebhook;
}

export function ShareDialog({
  open,
  onClose,
  initialTab = "send",
  onRequestRemoveInteractive,
  initialWebhook,
}: ShareDialogProps) {
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
        <TabButton active={tab === "about"} onClick={() => setTab("about")}>
          About
        </TabButton>
      </div>
      <div className={styles.body}>
        {tab === "send" ? (
          <SendPanel
            onRequestRemoveInteractive={onRequestRemoveInteractive}
            initialWebhook={initialWebhook}
            onCloseDialog={onClose}
          />
        ) : null}
        {tab === "restore" ? <RestorePanel onDone={onClose} /> : null}
        {tab === "share" ? <ShareLinkPanel /> : null}
        {tab === "json" ? <JsonExportPanel /> : null}
        {tab === "import" ? <ImportPanel onDone={onClose} /> : null}
        {tab === "about" ? <AboutPanel /> : null}
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

  // The short link is opt-in: it uploads this message so it can be served from
  // a tiny `/s/…` URL (auto-deleted server-side after 7 days). A short link
  // pins one specific snapshot, so clear it whenever the message (token)
  // changes.
  const [shortUrl, setShortUrl] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => setShortUrl(null), [token]);

  const handleCreateShort = async () => {
    setCreating(true);
    const result = await createShortLink(token);
    setCreating(false);
    if (result.ok) {
      setShortUrl(result.url);
      pushToast("Short link created — expires in 7 days.", "success");
    } else {
      pushToast(`Couldn't create short link: ${result.error}`, "error");
    }
  };

  return (
    <>
      <p className={styles.lead}>
        Anyone who opens this URL loads the exact message tree below. The state lives entirely in
        the URL hash — nothing is uploaded.
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

      {isShortLinkConfigured() ? (
        <section className={styles.shortLink}>
          <p className={styles.lead}>
            <strong>Short link (optional).</strong> Need a tiny URL? This{" "}
            <strong>uploads the message to our server</strong> and serves it back from{" "}
            <code>/s/…</code>, auto-deleting after <strong>7 days</strong>. Unlike the hash link
            above, the contents leave your browser — skip it for sensitive messages.
          </p>
          {shortUrl ? (
            <>
              <div className={styles.urlRow}>
                <TextInput readOnly value={shortUrl} spellCheck={false} />
                <button
                  type="button"
                  className={styles.revealBtn}
                  onClick={async () => {
                    if (await copyText(shortUrl)) pushToast("Short link copied", "success");
                    else pushToast("Copy failed", "error");
                  }}
                >
                  Copy
                </button>
              </div>
              <div className={styles.statsRow}>
                <span className={styles.statChip}>Expires in 7 days</span>
              </div>
            </>
          ) : (
            <div className={styles.actions}>
              <Button variant="secondary" onClick={handleCreateShort} disabled={creating}>
                {creating ? "Creating…" : "Create short link"}
              </Button>
            </div>
          )}
        </section>
      ) : null}
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
        parameter. The required <code>flags</code> (Components V2, plus silent-send if enabled) are
        already included below — Discord rejects the payload without them.
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

/**
 * About panel — surfaces a short description of the app, the author
 * credit, the source-available/GitHub link, the support-server invite, and the
 * legal pages. Lives in the Share dialog so it's reachable from the same
 * place as Import/Export.
 */
function AboutPanel() {
  return (
    <>
      <p className={styles.lead}>
        <strong>DWEEB</strong> builds Discord's <strong>Components V2</strong> messages —
        containers, sections, buttons, select menus, and media galleries, not just legacy embeds.
        You design against a pixel-accurate live preview, send straight to a webhook (then pull a
        message back to edit it in place), and share any design as a single link.
      </p>
      <p className={styles.lead}>
        <strong>Private by design.</strong> Everything runs in your browser — message drafts,
        webhook URLs, and share links never reach our servers (share state lives in the URL hash;
        webhook tokens go only to Discord). No account, no database, nothing uploaded. The one
        exception is opt-in: creating a <em>short link</em> uploads that message so it can be
        served from a tiny URL, and it's auto-deleted after 7 days — for sensitive announcements,
        stick with the default hash link.
      </p>
      <p className={styles.lead}>
        And yes, it stands for <em>Discord Webhook Embed Builder</em>. 🤓
      </p>
      <p className={styles.lead}>
        DWEEB is <strong>source-available</strong> and free for noncommercial use (commercial use
        isn't permitted). The code lives on{" "}
        <a href="https://github.com/FaizoKen/DWEEB" target="_blank" rel="noopener noreferrer">
          GitHub
        </a>{" "}
        — stars, issues, and pull requests welcome.
      </p>
      <p className={styles.lead}>
        Made with 💖 by{" "}
        <a href="https://faizo.net" target="_blank" rel="noopener noreferrer">
          <strong>Faizo</strong>
        </a>
        .
      </p>
      <p className={styles.lead}>
        Feedback?{" "}
        <a href="https://discord.gg/2wB7rHRDg2" target="_blank" rel="noopener noreferrer">
          Join the support server
        </a>
        .
      </p>
      <nav className={styles.aboutLinks} aria-label="Legal and source links">
        <a href="https://github.com/FaizoKen/DWEEB" target="_blank" rel="noopener noreferrer">
          Source on GitHub
        </a>
        <a href="/privacy" target="_blank" rel="noopener noreferrer">
          Privacy Policy
        </a>
        <a href="/terms" target="_blank" rel="noopener noreferrer">
          Terms of Service
        </a>
      </nav>
    </>
  );
}

/**
 * Import panel.
 *
 * Accepts three shapes:
 *  1. A share URL or bare share token — decoded via `decodeShare`.
 *  2. A Components V2 JSON payload — decoded via `decodeJson`.
 *  3. A pre-V2 (V1) webhook payload (`content` / `embeds` / `poll` /
 *     `stickers`). The panel detects these as the user types, shows a
 *     preview of what the converter will do, and offers a typed
 *     "Convert to V2 and import" action so the conversion never happens
 *     by surprise.
 *
 * For (3), the converter `convertV1Payload` rewrites the payload into a V2
 * component tree, returning a list of notes describing every conversion or
 * drop so users can spot data loss (poll, video, icons) before committing.
 */
function ImportPanel({ onDone }: { onDone: () => void }) {
  const replace = useMessageStore((s) => s.replaceMessage);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Live V1 detection — only meaningful when the input parses as JSON. Share
  // tokens / share URLs go through their own paths and never preview V1.
  const v1Preview = useMemo(() => analyseInput(text), [text]);

  const handleImport = () => {
    const value = text.trim();
    if (!value) {
      setError("Paste a share URL, share token, or JSON payload.");
      return;
    }
    // Try share URL first.
    const urlMatch = /#s=([^&]+)/.exec(value);
    if (urlMatch) {
      finish(decodeShare(urlMatch[1]!));
      return;
    }
    // Maybe a bare token (`v.body`).
    if (/^\d+\./.test(value)) {
      finish(decodeShare(value));
      return;
    }
    // JSON path — if V1 fields are present, route through the converter so the
    // editor never silently drops `content`/`embeds`/etc.
    if (v1Preview.kind === "v1") {
      try {
        const { message, notes } = convertV1Payload(v1Preview.parsed);
        replace(message);
        const dropped = notes.filter((n) => n.level === "warning").length;
        pushToast(
          dropped > 0
            ? `Converted V1 payload to V2 — ${dropped} field${dropped === 1 ? "" : "s"} dropped (see preview).`
            : "Converted V1 payload to V2.",
          dropped > 0 ? "info" : "success",
        );
        setError(null);
        onDone();
        return;
      } catch (e) {
        setError((e as Error).message);
        return;
      }
    }
    finish(decodeJson(value));
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
        Paste a share URL, a share token, or a webhook JSON payload. V1 payloads (with{" "}
        <code>content</code>, <code>embeds</code>, <code>poll</code>, or <code>stickers</code>) are
        auto-converted to V2 — the panel previews what happens before you commit.
      </p>
      <TextArea
        rows={10}
        placeholder='{ "components": [ … ] }  ·  or  { "content": "...", "embeds": [...] }'
        invalid={!!error}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
      />
      {v1Preview.kind === "v1" ? (
        <V1ConversionPreview fields={v1Preview.detection.fields} notes={v1Preview.notes} />
      ) : null}
      {error ? <div className={styles.error}>{error}</div> : null}
      <div className={styles.actions}>
        <Button variant="primary" onClick={handleImport}>
          {v1Preview.kind === "v1" ? "Convert to V2 and import" : "Replace message"}
        </Button>
      </div>
    </>
  );
}

type Analysis =
  | { kind: "empty" }
  | { kind: "not-json" }
  | { kind: "v2" }
  | {
      kind: "v1";
      parsed: unknown;
      detection: ReturnType<typeof detectV1Fields>;
      notes: V1ImportNote[];
    };

/**
 * Try to parse the input as JSON and decide whether it carries V1 fields.
 * Share URLs / tokens / non-JSON return `not-json` (or `empty`) — the
 * preview only fires for JSON that actually has V1-only fields.
 */
function analyseInput(text: string): Analysis {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "empty" };
  // Skip share URLs and bare tokens — those have their own decode path.
  if (trimmed.startsWith("http") || trimmed.includes("#s=") || /^\d+\./.test(trimmed)) {
    return { kind: "not-json" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "not-json" };
  }
  const detection = detectV1Fields(parsed);
  if (!detection.hasV1Fields) return { kind: "v2" };
  // Dry-run the converter to surface notes without applying them.
  try {
    const { notes } = convertV1Payload(parsed);
    return { kind: "v1", parsed, detection, notes };
  } catch {
    // Converter throws only when the payload isn't an object — already filtered.
    return { kind: "v2" };
  }
}

function V1ConversionPreview({ fields, notes }: { fields: string[]; notes: V1ImportNote[] }) {
  return (
    <section className={styles.v1Preview} aria-label="V1 → V2 conversion preview">
      <header className={styles.v1PreviewHeader}>
        <span className={styles.v1PreviewTitle}>V1 payload detected — preview</span>
        <div className={styles.v1PreviewChips}>
          {fields.map((f) => (
            <span key={f} className={styles.v1PreviewChip}>
              {f}
            </span>
          ))}
        </div>
      </header>
      {notes.length > 0 ? (
        <ul className={styles.v1PreviewList}>
          {notes.map((n, i) => (
            <li key={i} className={styles.v1PreviewItem}>
              <span
                className={cn(
                  styles.v1PreviewBadge,
                  n.level === "warning" ? styles.v1PreviewBadgeWarn : styles.v1PreviewBadgeInfo,
                )}
              >
                {n.level === "warning" ? "Drop" : "Map"}
              </span>
              <div>
                <span className={styles.v1PreviewSource}>{n.source}</span>
                {" — "}
                {n.message}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.lead}>V1 fields will be converted with no data loss.</p>
      )}
    </section>
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Webhooks saved in this browser — same list the Send panel shows, so the
  // user can fill the URL field from a saved entry instead of re-pasting it.
  const [history, setHistory] = useState(() => loadHistory());

  const saveAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => saveAbortRef.current?.abort(), []);

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
    // A successful restore proves the webhook is valid, so remember it for the
    // recents list (this browser only). The fetch returns the message, not the
    // webhook object, so we can't capture a name/owner here — `rememberWebhook`
    // keeps any details a prior save recorded and the user can enrich it via
    // "Save webhook". Refresh local history so the list reflects it on reopen.
    rememberWebhook(parsedUrl.url);
    setHistory(loadHistory());
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

  // Verify the webhook with Discord (GET), then store it — no message is
  // fetched. Mirrors the Send panel's "Save webhook" so a webhook can be saved
  // (with its name + owner) from here without restoring a message first.
  const handleSaveWebhook = async () => {
    setError(null);
    if (!parsedUrl) {
      setError("Enter a valid Discord webhook URL.");
      return;
    }

    saveAbortRef.current?.abort();
    const ac = new AbortController();
    saveAbortRef.current = ac;

    setSaving(true);
    const result = await verifyWebhook(parsedUrl, { signal: ac.signal });
    setSaving(false);

    if (!result.ok) {
      if (result.status === 0 && result.error === "Check was cancelled.") return;
      setError(result.error);
      return;
    }

    const remoteName = typeof result.webhook.name === "string" ? result.webhook.name : "";
    const owner = classifyWebhookOwner(result.webhook);
    const entry = rememberWebhook(parsedUrl.url, {
      name: remoteName,
      ownerKind: owner.kind,
      avatar: webhookAvatarHash(result.webhook),
    });
    if (entry) {
      setHistory(loadHistory());
      pushToast(
        remoteName
          ? `Verified “${remoteName}” — ${owner.badge.toLowerCase()}. Saved.`
          : `Webhook verified — ${owner.badge.toLowerCase()}. Saved.`,
        "success",
      );
    }
  };

  return (
    <>
      <p className={styles.lead}>
        Pull a message <strong>this webhook</strong> posted back into the editor — Discord won’t
        return user or bot messages, even in the same channel.
      </p>

      <Callout tone="warning" icon={<LockIcon size={15} />} role="note">
        <strong>Treat the webhook URL like a password.</strong> It's a credential that lets anyone
        post to your channel — keep it secret and only use webhooks you own.
      </Callout>

      <WebhookRecents
        history={history}
        activeId={parsedUrl?.id ?? null}
        onUse={(entry) => setUrl(entry.url)}
        onChange={() => setHistory(loadHistory())}
      />

      <Field
        label="Webhook URL"
        error={urlInvalid ? "Not a valid Discord webhook URL." : undefined}
      >
        {(id) => (
          <div className={styles.urlRow}>
            <TextInput
              id={id}
              masked={!revealUrl}
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
            <button
              type="button"
              className={styles.revealBtn}
              onClick={handleSaveWebhook}
              disabled={saving || busy || !parsedUrl}
            >
              {saving ? "Checking…" : "Save"}
            </button>
          </div>
        )}
      </Field>

      <Field
        label="Message ID or link"
        hint="In Discord: right-click → Copy Message ID (Developer Mode), or paste the message link."
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

      <div className={cn(styles.actions, styles.actionsEnd)}>
        <Button
          variant="primary"
          onClick={handleFetch}
          disabled={busy || saving || !parsedUrl || !messageId}
        >
          {busy ? "Fetching…" : "Restore into editor"}
        </Button>
      </div>
    </>
  );
}
