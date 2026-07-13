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

import { useEffect, useRef, useState } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { useValidationSummary } from "@/features/builder/useValidation";
import {
  routeMessageIssues,
  sectionForField,
  useOptionsRevealStore,
  type MessageIssueField,
  type OptionsSection,
} from "@/features/builder/optionsReveal";
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

/** The dot beside a lane title: danger when the lane holds an error, amber for
 *  a warning, the accent "configured" dot when it just has settings, else none. */
function LaneDot({ severity, active }: { severity: "error" | "warning" | null; active: boolean }) {
  if (severity === "error") {
    return (
      <span className={cn(styles.optionsTabDot, styles.optionsTabDotError)} aria-hidden="true" />
    );
  }
  if (severity === "warning") {
    return (
      <span className={cn(styles.optionsTabDot, styles.optionsTabDotWarn)} aria-hidden="true" />
    );
  }
  return active ? <span className={styles.optionsTabDot} aria-hidden="true" /> : null;
}

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

  // Jump-to-issue for message-level problems: the header's issue chip fires a
  // one-shot reveal (see `optionsReveal.ts`), and this card answers it — the
  // same way a node issue's jump scrolls its tree row into view. Expand the
  // lane hosting the field (when it lives in one), unfold any <details> around
  // it, bring it on screen, and focus it so the fix is a keystroke away.
  const rootRef = useRef<HTMLDivElement>(null);
  const revealToken = useOptionsRevealStore((s) => s.token);
  const revealField = useOptionsRevealStore((s) => s.field);
  useEffect(() => {
    if (revealToken === 0) return; // initial mount, no reveal requested yet
    const section = revealField ? sectionForField(revealField) : null;
    if (section) setOpenSection(section);
    // Deferred a frame so a just-expanded lane has mounted before we measure
    // scroll positions / look up its focus target.
    requestAnimationFrame(() => {
      // Lane fields carry data-reveal-focus; the meta header's username/avatar
      // inputs (outside this card) carry data-meta-field with the same names.
      const el = revealField
        ? (rootRef.current?.querySelector<HTMLElement>(`[data-reveal-focus="${revealField}"]`) ??
          document.querySelector<HTMLElement>(`[data-meta-field="${revealField}"]`))
        : null;
      // A target behind a collapsed Advanced fold can't be focused — open its
      // <details> ancestors first (native, so this sticks).
      for (let n = el?.parentElement; n; n = n.parentElement) {
        if (n instanceof HTMLDetailsElement) n.open = true;
      }
      (el ?? rootRef.current)?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.focus({ preventScroll: true });
    });
  }, [revealToken, revealField]);

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

  // Message-level issues, routed to the field they belong to (thread name,
  // applied tags, allowed-mention ids) — each renders inline under its own
  // control like any other field error, and its lane gets a danger (error) or
  // amber (warning) dot so the collapsed card points at the problem.
  const { messageIssues } = useValidationSummary();
  const fieldIssues = routeMessageIssues(messageIssues);
  const issueAt = (field: MessageIssueField) => fieldIssues.get(field);
  const laneSeverity = (fields: MessageIssueField[]): "error" | "warning" | null => {
    if (fields.some((f) => fieldIssues.get(f)?.error)) return "error";
    if (fields.some((f) => fieldIssues.get(f)?.warning)) return "warning";
    return null;
  };
  const forumSeverity = laneSeverity(["thread_name", "applied_tags"]);
  const notificationSeverity = laneSeverity(["mention_roles", "mention_users"]);

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
    <div ref={rootRef} className={styles.options}>
      <div className={styles.optionsTabs}>
        <button
          type="button"
          className={cn(
            styles.optionsTab,
            notificationActive && styles.optionsTabActive,
            notificationSeverity === "error" && styles.optionsTabError,
          )}
          aria-expanded={openSection === "notification"}
          onClick={() => toggleSection("notification")}
        >
          <span className={styles.optionsTabIcon}>
            <BellIcon size={16} />
          </span>
          <span className={styles.optionsTabText}>
            <span className={styles.optionsTabTitle}>
              Notifications
              <LaneDot severity={notificationSeverity} active={notificationActive} />
            </span>
            <span className={styles.optionsTabSub}>Silent send &amp; who gets pinged</span>
          </span>
          <ChevronDownIcon size={15} className={styles.optionsTabChevron} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={cn(
            styles.optionsTab,
            forumActive && styles.optionsTabActive,
            forumSeverity === "error" && styles.optionsTabError,
          )}
          aria-expanded={openSection === "forum"}
          onClick={() => toggleSection("forum")}
        >
          <span className={styles.optionsTabIcon}>
            <ForumIcon size={16} />
          </span>
          <span className={styles.optionsTabText}>
            <span className={styles.optionsTabTitle}>
              Forum post
              <LaneDot severity={forumSeverity} active={forumActive} />
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
              a subtle inline disclosure. Unfolded on mount when a field inside
              carries an issue, so the inline error isn't hidden by the fold. */}
          <Disclosure defaultOpen={notificationSeverity != null}>
            {/* TTS — only meaningful for V1 (plain content) messages; no-op on V2 */}
            <Switch
              checked={message.tts ?? false}
              onChange={(e) => setTts(e.currentTarget.checked)}
              label="Text-to-speech (no audible effect on V2 messages)"
            />

            <Field
              label="Allowed role IDs"
              hint="Comma/space separated snowflakes. Conflicts with @role chip — use one."
              error={issueAt("mention_roles")?.error}
              warning={issueAt("mention_roles")?.warning}
            >
              {(id) => (
                <TextInput
                  id={id}
                  value={(am?.roles ?? []).join(" ")}
                  onChange={(e) => updateAllowed({ roles: onSnowflakeList(e.currentTarget.value) })}
                  placeholder="e.g. 1185234567890123456 1185234567890123457"
                  data-reveal-focus="mention_roles"
                />
              )}
            </Field>

            <Field
              label="Allowed user IDs"
              hint="Comma/space separated snowflakes. Conflicts with @user chip — use one."
              error={issueAt("mention_users")?.error}
              warning={issueAt("mention_users")?.warning}
            >
              {(id) => (
                <TextInput
                  id={id}
                  value={(am?.users ?? []).join(" ")}
                  onChange={(e) => updateAllowed({ users: onSnowflakeList(e.currentTarget.value) })}
                  placeholder="e.g. 1185234567890123456"
                  data-reveal-focus="mention_users"
                />
              )}
            </Field>
          </Disclosure>
        </div>
      ) : null}

      {openSection === "forum" ? (
        <div className={styles.optionsBody}>
          <div className={styles.sectionHint}>
            Forum / media channel only — Discord rejects a post to other channels while these are
            set.
          </div>

          <Field
            label="Thread name"
            hint="Starts a new forum post with this title. Skip when posting into an existing thread."
            error={issueAt("thread_name")?.error}
            warning={issueAt("thread_name")?.warning}
          >
            {(id) => (
              <TextArea
                id={id}
                rows={1}
                value={message.thread_name ?? ""}
                maxLength={LIMITS.THREAD_NAME}
                onChange={(e) => setThreadName(e.currentTarget.value || undefined)}
                placeholder="e.g. Release notes — v2.4"
                data-reveal-focus="thread_name"
              />
            )}
          </Field>

          <Field
            label="Applied tags"
            hint={`Up to ${LIMITS.APPLIED_TAGS} tag snowflakes, comma/space separated.`}
            error={issueAt("applied_tags")?.error}
            warning={issueAt("applied_tags")?.warning}
          >
            {(id) => (
              <TextInput
                id={id}
                value={(message.applied_tags ?? []).join(" ")}
                onChange={(e) => setAppliedTags(onSnowflakeList(e.currentTarget.value))}
                placeholder="e.g. 1185234567890123456"
                data-reveal-focus="applied_tags"
              />
            )}
          </Field>
        </div>
      ) : null}
    </div>
  );
}
