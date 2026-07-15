/**
 * JSON panel — combined export + import, shared by the web Share dialog and the
 * Discord Activity's JSON dialog.
 *
 * The field is prefilled with the current message's wire-format payload, so the
 * default action is export: **Copy** or **Download** the JSON. Edit or paste
 * over it and **Replace message** to import instead.
 *
 * Import accepts three shapes:
 *  1. A Components V2 JSON payload — decoded via `decodeJson`.
 *  2. A pre-V2 (V1) webhook payload (`content` / `embeds` / `poll` /
 *     `stickers`). The panel detects these as the user types, shows a
 *     preview of what the converter will do, and offers a typed
 *     "Convert to V2 and import" action so the conversion never happens
 *     by surprise. `convertV1Payload` rewrites the payload into a V2 component
 *     tree, returning notes describing every conversion or drop so users can
 *     spot data loss (poll, video, icons) before committing.
 *  3. A share URL or bare share token pasted in — decoded via `decodeShare`.
 *
 * Import goes through `replaceMessage`, so inside the Activity the collab layer
 * broadcasts the swap to the room as a full draft — the same path Restore and
 * "load a draft" already take.
 */

import { useMemo, useState } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { Button } from "@/ui/Button";
import { TextArea } from "@/ui/TextArea";
import {
  convertV1Payload,
  copyText,
  decodeJson,
  decodeShare,
  detectV1Fields,
  encodeJson,
  type V1ImportNote,
} from "@/core/serialization";
import { pushToast } from "@/ui/Toast";
import { validateMessage } from "@/core/schema/validation";
import { cn } from "@/lib/cn";
import styles from "./ShareDialog.module.css";

export function JsonPanel({ onDone }: { onDone: () => void }) {
  const message = useMessageStore((s) => s.message);
  const replace = useMessageStore((s) => s.replaceMessage);
  // The live wire-format export. The dialog blocks editing the message behind
  // it, so this is frozen while the panel is open — safe to seed the field once.
  const exported = useMemo(() => encodeJson(message), [message]);
  const [text, setText] = useState(exported);
  const [error, setError] = useState<string | null>(null);

  // Live V1 detection — only meaningful when the input parses as JSON. Share
  // tokens / share URLs go through their own paths and never preview V1.
  const v1Preview = useMemo(() => analyseInput(text), [text]);

  // Once the field diverges from the live export, the user is importing, so the
  // import action takes primary emphasis; until then export (Copy) leads.
  const importing = v1Preview.kind === "v1" || text.trim() !== exported.trim();

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
        const { message: converted, notes } = convertV1Payload(v1Preview.parsed);
        replace(converted);
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

  const copyJson = async () => {
    if (await copyText(text)) pushToast("JSON copied", "success");
    else pushToast("Copy failed", "error");
  };

  const downloadJson = () => {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "webhook-message.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <p className={styles.lead}>
        The wire-format payload for the current message. <strong>Copy</strong> or{" "}
        <strong>Download</strong> to export — POST it to your webhook URL with{" "}
        <code>?with_components=true</code> (the required <code>flags</code> are already included).
        Or edit / paste over it (JSON, a share link, or a V1 payload) and{" "}
        <strong>Replace message</strong> to import. V1 payloads (with <code>content</code>,{" "}
        <code>embeds</code>, <code>poll</code>, or <code>stickers</code>) are auto-converted to V2 —
        the panel previews what happens before you commit.
      </p>
      <TextArea
        rows={14}
        className={styles.mono}
        placeholder='{ "components": [ … ] }  ·  or  { "content": "...", "embeds": [...] }'
        invalid={!!error}
        value={text}
        onChange={(e) => {
          setText(e.currentTarget.value);
          if (error) setError(null);
        }}
      />
      {v1Preview.kind === "v1" ? (
        <V1ConversionPreview fields={v1Preview.detection.fields} notes={v1Preview.notes} />
      ) : null}
      {error ? <div className={styles.error}>{error}</div> : null}
      <div className={styles.actions}>
        <Button variant={importing ? "primary" : "secondary"} onClick={handleImport}>
          {v1Preview.kind === "v1" ? "Convert to V2 and import" : "Replace message"}
        </Button>
        <Button variant={importing ? "secondary" : "primary"} onClick={copyJson}>
          Copy JSON
        </Button>
        <Button variant="secondary" onClick={downloadJson}>
          Download file
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
