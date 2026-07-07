/**
 * Message-level controls outside the main component tree: one card with two
 * disclosure lanes side by side — "Notifications" (delivery behaviour + mention
 * safety) and "Forum post" (fields Discord only honours on forum/media
 * channels). Each lane carries an icon + a plain-language subtitle so the
 * collapsed card explains itself, and lights up an accent dot when it holds a
 * non-default setting. Clicking a lane expands its settings below; at most one
 * lane is open, so the card stays a single compact row until it's needed.
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
import { LIMITS } from "@/core/schema/limits";
import type { AllowedMentions } from "@/core/schema/types";
import { Disclosure } from "@/ui/Disclosure";
import { Field } from "@/ui/Field";
import { Switch } from "@/ui/Switch";
import { TextInput } from "@/ui/TextInput";
import { TextArea } from "@/ui/TextArea";
import { BellIcon, ChevronDownIcon, ForumIcon } from "@/ui/Icon";
import { cn } from "@/lib/cn";
import styles from "./ComponentTree.module.css";

type MentionKind = "everyone" | "roles" | "users";
const MENTION_LABELS: Record<MentionKind, string> = {
  everyone: "@everyone / @here",
  roles: "@role",
  users: "@user",
};

type OptionsSection = "notification" | "forum";

export function MessageOptions() {
  const message = useMessageStore((s) => s.message);
  const setSuppress = useMessageStore((s) => s.setSuppressNotifications);
  const setTts = useMessageStore((s) => s.setTts);
  const setAllowed = useMessageStore((s) => s.setAllowedMentions);
  const setThreadName = useMessageStore((s) => s.setThreadName);
  const setAppliedTags = useMessageStore((s) => s.setAppliedTags);

  const [openSection, setOpenSection] = useState<OptionsSection | null>(null);
  const toggleSection = (section: OptionsSection) =>
    setOpenSection((current) => (current === section ? null : section));

  const am = message.allowed_mentions;

  // Whether each lane holds any non-default setting — drives the "configured"
  // dot + accent so the collapsed card tells you at a glance what you've touched.
  const notificationActive =
    (message.suppress_notifications ?? false) ||
    (message.tts ?? false) ||
    (am != null &&
      ((am.parse?.length ?? 0) > 0 || (am.roles?.length ?? 0) > 0 || (am.users?.length ?? 0) > 0));
  const forumActive =
    (message.thread_name?.trim().length ?? 0) > 0 || (message.applied_tags?.length ?? 0) > 0;

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
    <div className={styles.options}>
      <div className={styles.optionsTabs}>
        <button
          type="button"
          className={cn(styles.optionsTab, notificationActive && styles.optionsTabActive)}
          aria-expanded={openSection === "notification"}
          onClick={() => toggleSection("notification")}
        >
          <span className={styles.optionsTabIcon}>
            <BellIcon size={16} />
          </span>
          <span className={styles.optionsTabText}>
            <span className={styles.optionsTabTitle}>
              Notifications
              {notificationActive ? (
                <span className={styles.optionsTabDot} aria-hidden="true" />
              ) : null}
            </span>
            <span className={styles.optionsTabSub}>Silent send &amp; who gets pinged</span>
          </span>
          <ChevronDownIcon size={15} className={styles.optionsTabChevron} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={cn(styles.optionsTab, forumActive && styles.optionsTabActive)}
          aria-expanded={openSection === "forum"}
          onClick={() => toggleSection("forum")}
        >
          <span className={styles.optionsTabIcon}>
            <ForumIcon size={16} />
          </span>
          <span className={styles.optionsTabText}>
            <span className={styles.optionsTabTitle}>
              Forum post
              {forumActive ? <span className={styles.optionsTabDot} aria-hidden="true" /> : null}
            </span>
            <span className={styles.optionsTabSub}>Thread title &amp; tags</span>
          </span>
          <ChevronDownIcon size={15} className={styles.optionsTabChevron} aria-hidden="true" />
        </button>
      </div>

      {openSection === "notification" ? (
        <div className={styles.optionsBody}>
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

          {/* Raw-snowflake / no-op fields — power-user territory, parked behind
              a subtle inline disclosure. */}
          <Disclosure>
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
                  onChange={(e) => updateAllowed({ roles: onSnowflakeList(e.currentTarget.value) })}
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
                  onChange={(e) => updateAllowed({ users: onSnowflakeList(e.currentTarget.value) })}
                  placeholder="e.g. 1185234567890123456"
                />
              )}
            </Field>
          </Disclosure>
        </div>
      ) : null}

      {openSection === "forum" ? (
        <div className={styles.optionsBody}>
          <div className={styles.sectionHint}>
            Forum / media channel only — Discord ignores these on text channels.
          </div>

          <Field
            label="Thread name"
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
            label="Applied tags"
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
        </div>
      ) : null}
    </div>
  );
}
