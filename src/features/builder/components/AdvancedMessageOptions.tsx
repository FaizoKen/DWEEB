/**
 * Message-level controls outside the main component tree.
 *
 * Notable webhook-specific restrictions we surface inline (and again in the
 * Send panel's pre-flight check via `inspectCapabilities`):
 *
 *  - `tts`                   — accepted but no-op for V2 (TTS reads `content`,
 *                              which V2 forbids).
 *  - `thread_name`/`applied_tags` — only effective when the webhook posts
 *                              into a forum or media channel; ignored elsewhere.
 *  - `allowed_mentions`      — universally honoured. The most safety-relevant
 *                              control we expose.
 *  - `suppress_notifications` — universal flag.
 *
 * Note: `message_reference` is **not** accepted on webhook execute, so we do
 * not expose it. The schema preserves the field on import for round-trip
 * safety but the editor never lets the user set it.
 */

import { useState } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { useUiPrefs } from "@/core/state/uiPrefs";
import { LIMITS } from "@/core/schema/limits";
import type { AllowedMentions } from "@/core/schema/types";
import { Field } from "@/ui/Field";
import { Switch } from "@/ui/Switch";
import { TextInput } from "@/ui/TextInput";
import { TextArea } from "@/ui/TextArea";
import { cn } from "@/lib/cn";
import { AdvancedModeConfirm } from "./AdvancedModeConfirm";
import styles from "./ComponentTree.module.css";

type MentionKind = "everyone" | "roles" | "users";
const MENTION_LABELS: Record<MentionKind, string> = {
  everyone: "@everyone / @here",
  roles: "@role",
  users: "@user",
};

export function AdvancedMessageOptions() {
  const message = useMessageStore((s) => s.message);
  const setSuppress = useMessageStore((s) => s.setSuppressNotifications);
  const setTts = useMessageStore((s) => s.setTts);
  const setAllowed = useMessageStore((s) => s.setAllowedMentions);
  const setThreadName = useMessageStore((s) => s.setThreadName);
  const setAppliedTags = useMessageStore((s) => s.setAppliedTags);
  const advancedMode = useUiPrefs((s) => s.advancedMode);
  const setAdvancedMode = useUiPrefs((s) => s.setAdvancedMode);

  // Controlled disclosure: a native <details> can't share its header lane with
  // an interactive toggle (clicking the switch would also toggle the panel), so
  // we drive open/closed ourselves and keep the Advanced switch as a sibling of
  // the disclosure button rather than a child of it.
  const [open, setOpen] = useState(false);

  // Gate activation behind a confirmation explaining the raw fields it unlocks.
  // Turning Advanced *off* skips the dialog — there's nothing to warn about.
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleAdvancedToggle = (next: boolean) => {
    if (next) {
      setConfirmOpen(true);
      return;
    }
    setAdvancedMode(false);
  };

  const confirmActivate = () => {
    setAdvancedMode(true);
    setConfirmOpen(false);
  };

  const am = message.allowed_mentions;

  const setParseKind = (kind: MentionKind, on: boolean) => {
    const parse = new Set<MentionKind>(am?.parse ?? []);
    if (on) parse.add(kind);
    else parse.delete(kind);
    updateAllowed({ parse: parse.size > 0 ? Array.from(parse) : undefined });
  };

  const updateAllowed = (patch: Partial<AllowedMentions>) => {
    const merged: AllowedMentions = { ...(am ?? {}), ...patch };
    if (merged.parse && merged.parse.length === 0) delete merged.parse;
    if (merged.roles && merged.roles.length === 0) delete merged.roles;
    if (merged.users && merged.users.length === 0) delete merged.users;
    setAllowed(Object.keys(merged).length > 0 ? merged : undefined);
  };

  const onSnowflakeList = (raw: string): string[] | undefined => {
    const ids = raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return ids.length > 0 ? ids : undefined;
  };

  return (
    <div className={styles.advanced}>
      <div className={styles.advancedHeader}>
        <button
          type="button"
          className={styles.advancedSummary}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          Message options
        </button>
        {/* Lives on the header lane, beside the disclosure — flips technical
            fields here and in the inspectors. Kept outside the button so a
            click toggles the switch, not the panel. */}
        <Switch
          className={styles.advancedToggle}
          checked={advancedMode}
          onChange={(e) => handleAdvancedToggle(e.currentTarget.checked)}
          label="Advanced"
          title="Show technical fields like custom_id, snowflake IDs, and component id"
        />
      </div>
      <AdvancedModeConfirm
        open={confirmOpen}
        onConfirm={confirmActivate}
        onCancel={() => setConfirmOpen(false)}
      />
      {open ? (
        <div className={styles.advancedBody}>
          {/* Silent send */}
          <Switch
            checked={message.suppress_notifications ?? false}
            onChange={(e) => setSuppress(e.currentTarget.checked)}
            label="Send silently (no notifications)"
          />

          {/* Allowed mentions */}
          <Field
            label="Allowed mentions"
            hint="Pick which classes of mention may resolve. Off = no pings."
          >
            {() => (
              <div className={styles.chipRow}>
                {(Object.keys(MENTION_LABELS) as MentionKind[]).map((k) => {
                  const active = am?.parse?.includes(k) ?? false;
                  return (
                    <button
                      key={k}
                      type="button"
                      className={cn(styles.chip, active && styles.chipActive)}
                      aria-pressed={active}
                      onClick={() => setParseKind(k, !active)}
                    >
                      {MENTION_LABELS[k]}
                    </button>
                  );
                })}
              </div>
            )}
          </Field>

          {/* The remaining controls are raw-snowflake / no-op / forum-only fields —
            power-user territory, so they only appear in Advanced mode. */}
          {advancedMode ? (
            <>
              {/* TTS — only meaningful for V1 (plain content) messages; no-op on V2 */}
              <Switch
                checked={message.tts ?? false}
                onChange={(e) => setTts(e.currentTarget.checked)}
                label="Text-to-speech (no audible effect on V2 messages)"
              />

              <Field
                label="Allowed role IDs"
                hint="Comma/space separated snowflakes. Conflicts with @role chip — use one."
              >
                {(id) => (
                  <TextInput
                    id={id}
                    value={(am?.roles ?? []).join(" ")}
                    onChange={(e) =>
                      updateAllowed({ roles: onSnowflakeList(e.currentTarget.value) })
                    }
                    placeholder="e.g. 1185234567890123456 1185234567890123457"
                  />
                )}
              </Field>

              <Field
                label="Allowed user IDs"
                hint="Comma/space separated snowflakes. Conflicts with @user chip — use one."
              >
                {(id) => (
                  <TextInput
                    id={id}
                    value={(am?.users ?? []).join(" ")}
                    onChange={(e) =>
                      updateAllowed({ users: onSnowflakeList(e.currentTarget.value) })
                    }
                    placeholder="e.g. 1185234567890123456"
                  />
                )}
              </Field>

              {/* Forum-channel options — labelled clearly so non-forum users know to skip them */}
              <div className={styles.sectionHint}>
                Forum / media channel only — Discord ignores these on text channels.
              </div>
              <Field
                label="Forum thread name"
                hint="Starts a new forum post with this title. Skip when posting into an existing thread."
              >
                {(id) => (
                  <TextArea
                    id={id}
                    rows={1}
                    value={message.thread_name ?? ""}
                    maxLength={LIMITS.THREAD_NAME}
                    onChange={(e) => setThreadName(e.currentTarget.value || undefined)}
                    placeholder="e.g. Release notes — v2.4"
                  />
                )}
              </Field>

              <Field
                label="Forum applied tags"
                hint={`Up to ${LIMITS.APPLIED_TAGS} tag snowflakes, comma/space separated.`}
              >
                {(id) => (
                  <TextInput
                    id={id}
                    value={(message.applied_tags ?? []).join(" ")}
                    onChange={(e) => setAppliedTags(onSnowflakeList(e.currentTarget.value))}
                    placeholder="e.g. 1185234567890123456"
                  />
                )}
              </Field>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
