/**
 * Code panel — the current message as paste-ready code.
 *
 * The JSON tab is the right export for someone posting the payload themselves;
 * it is the wrong one for the developer whose bot is written in discord.js or
 * discord.py, who would otherwise retype the whole layout as builder calls. This
 * panel renders the same message through `core/codegen` for five destinations:
 * the two bot libraries, and three ways to call a webhook URL directly — plus
 * a sixth that sends nothing: the message as a Discord link preview (a
 * component embed) for a website's `<head>`.
 *
 * Read-only by design. The JSON tab doubles as an import box because JSON
 * round-trips; generated code does not, and an editable field here would only
 * invite edits that silently go nowhere.
 */

import { useMemo, useState } from "react";
import { useUniqueId } from "@/lib/useUniqueId";
import { useMessageStore } from "@/core/state/messageStore";
import { CODE_TARGETS, generateCode, isCodeTarget, type CodeTarget } from "@/core/codegen";
import { prepareCodegenInput } from "@/core/codegen/payload";
import { buildComponentEmbed, EMBED_DEBUGGER_URL } from "@/core/linkPreview/componentEmbed";
import { copyText } from "@/core/serialization";
import { validateMessage } from "@/core/schema/validation";
import { trackAnalytics } from "@/core/telemetry/analytics";
import { Button } from "@/ui/Button";
import { TextArea } from "@/ui/TextArea";
import { pushToast } from "@/ui/Toast";
import { cn } from "@/lib/cn";
import { Callout } from "./Callout";
import styles from "./ShareDialog.module.css";

const TARGET_STORAGE_KEY = "dweeb.codeTarget.v1";

const GROUPS = [
  { kind: "bot", label: "Bot library" },
  { kind: "webhook", label: "Webhook URL" },
  { kind: "website", label: "Website" },
] as const;

/**
 * The last language someone picked is almost always the one they want next
 * time. Storage can throw outright when site data is blocked — not merely come
 * back empty — so both directions are guarded and the panel works without it.
 */
function readStoredTarget(): CodeTarget {
  try {
    const stored = window.localStorage.getItem(TARGET_STORAGE_KEY);
    if (isCodeTarget(stored)) return stored;
  } catch {
    // Unreadable storage reads as "no preference".
  }
  return "discordjs";
}

function storeTarget(target: CodeTarget): void {
  try {
    window.localStorage.setItem(TARGET_STORAGE_KEY, target);
  } catch {
    // A preference that cannot be saved is not worth interrupting anyone over.
  }
}

export function CodePanel() {
  const message = useMessageStore((s) => s.message);
  const groupId = useUniqueId("code");
  const [target, setTarget] = useState<CodeTarget>(readStoredTarget);
  const info = CODE_TARGETS.find((item) => item.id === target)!;
  const code = useMemo(() => generateCode(message, target), [message, target]);
  // Code generated from a message Discord would reject runs, and then fails at
  // the API — say so here rather than let it surface as a 400 in someone's bot.
  // Only errors block a send; a warning-level note is not worth a callout here.
  const issues = useMemo(
    () => validateMessage(message).issues.filter((issue) => issue.severity === "error").length,
    [message],
  );
  // A link preview is judged by its own rules (one Container, link buttons,
  // https media, 3,000 bytes), not by whether the message would post.
  const preview = useMemo(
    () =>
      target === "linkpreview"
        ? buildComponentEmbed(prepareCodegenInput(message).payload.components)
        : null,
    [message, target],
  );

  const pick = (next: CodeTarget) => {
    setTarget(next);
    storeTarget(next);
  };

  const copy = async () => {
    if (await copyText(code)) {
      pushToast(`${info.label} code copied`, "success");
      trackAnalytics("code_exported", { language: target, action: "copy" });
    } else {
      pushToast("Copy failed — your browser blocked the clipboard.", "error");
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([code], { type: "text/plain" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = info.fileName;
    anchor.click();
    URL.revokeObjectURL(url);
    trackAnalytics("code_exported", { language: target, action: "download" });
  };

  return (
    <>
      <p className={styles.lead}>
        The current message as <strong>paste-ready code</strong>. Pick where it will run: a bot
        library builds the layout with its own classes, and the webhook options post the same
        payload the JSON tab exports.
      </p>

      <div className={styles.codeTargets}>
        {GROUPS.map((group) => (
          <div key={group.kind} className={styles.codeGroup}>
            <span className={styles.codeGroupLabel} id={`${groupId}-${group.kind}`}>
              {group.label}
            </span>
            <div
              className={styles.codeGroupOptions}
              role="group"
              aria-labelledby={`${groupId}-${group.kind}`}
            >
              {CODE_TARGETS.filter((item) => item.kind === group.kind).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={item.id === target}
                  className={cn(styles.codeTarget, item.id === target && styles.codeTargetActive)}
                  onClick={() => pick(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <p className={styles.lead}>{info.summary}</p>

      {preview ? (
        <LinkPreviewNotes
          omitted={[
            ...(preview.wrapped
              ? ["Your message was wrapped in a Container — a link preview is a single Container."]
              : []),
            ...preview.omitted,
          ]}
          problems={preview.problems}
          bytes={preview.bytes}
        />
      ) : issues > 0 ? (
        <Callout tone="warning" role="note">
          This message has {issues} validation issue{issues === 1 ? "" : "s"}. The code will run,
          but Discord will reject the message until {issues === 1 ? "it is" : "they are"} fixed —
          close this dialog to see {issues === 1 ? "it" : "them"} in the editor.
        </Callout>
      ) : null}

      <TextArea
        readOnly
        rows={16}
        wrap="off"
        spellCheck={false}
        className={cn(styles.mono, styles.codeBlock)}
        aria-label={`${info.label} code for the current message`}
        value={code}
      />

      <div className={styles.actions}>
        <Button variant="primary" onClick={copy}>
          {preview ? "Copy HTML" : "Copy code"}
        </Button>
        <Button variant="secondary" onClick={download}>
          Download {info.fileName}
        </Button>
      </div>
    </>
  );
}

/** What a link preview kept, left out, and still needs — and where to test it. */
function LinkPreviewNotes({
  omitted,
  problems,
  bytes,
}: {
  omitted: string[];
  problems: string[];
  bytes: number;
}) {
  return (
    <>
      {problems.length > 0 ? (
        <Callout tone="warning" role="note">
          {problems.map((line) => (
            <span key={line} className={styles.calloutLine}>
              {line}
            </span>
          ))}
        </Callout>
      ) : null}
      {omitted.length > 0 ? (
        <Callout tone="info" role="note">
          {omitted.map((line) => (
            <span key={line} className={styles.calloutLine}>
              {line}
            </span>
          ))}
        </Callout>
      ) : null}
      <p className={styles.lead}>
        {bytes > 0 ? `${bytes.toLocaleString("en-US")} of 3,000 bytes. ` : null}
        Discord reads it only from the HTML your server sends, so it can't be added by a script.
        Test the live page in{" "}
        <a href={EMBED_DEBUGGER_URL} target="_blank" rel="noopener noreferrer">
          Discord's Embed Debugger
        </a>
        .
      </p>
    </>
  );
}
