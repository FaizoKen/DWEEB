/**
 * The Activity's top bar — the one piece of chrome the embedded surface adds on
 * top of the reused editor: where the message is going (the channel), undo/redo,
 * and the primary **Post** action. Presence and inviting live in the bottom
 * `PresenceDock` instead.
 *
 * The web app's action bar (account menu, share links) is mostly absent: inside
 * Discord the context is fixed and publishing is one server-side call, so this
 * stays focused on "edit together, then post". It keeps the server-scoped
 * library actions that are useful in the room: save the current message as a
 * named draft, browse the Message directory, or restore a posted message.
 * Scheduling rides inside the post confirm (its "When → Schedule" choice)
 * rather than as bar chrome; existing schedules are managed in the Message
 * directory's Scheduled tab.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { useGuildStore } from "@/core/guild/guildStore";
import { useActivityStore } from "@/core/activity/activityStore";
import { useFeedbackStore } from "@/features/feedback/feedbackStore";
import { isFeedbackConfigured } from "@/core/feedback/submit";
import { useMergedValidationView } from "@/features/builder/useValidation";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Menu, MenuItem } from "@/ui/Menu";
import { pushToast } from "@/ui/Toast";
import {
  BookmarkIcon,
  ExternalLinkIcon,
  GlobeIcon,
  HistoryIcon,
  LockIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RedoIcon,
  RefreshIcon,
  SaveIcon,
  SendIcon,
  SupportIcon,
  UndoIcon,
} from "@/ui/Icon";
import { ChannelPicker } from "./ChannelPicker";
import { GuildPicker, ServerGlyph, ServerGlyphSkeleton } from "./GuildPicker";
import { ActivityGallery } from "./ActivityGallery";
import { RestoreDialog } from "./RestoreDialog";
import { SaveDraftDialog } from "./SaveDraftDialog";
import { PostConfirm } from "./PostConfirm";
import { PostSuccess } from "./PostSuccess";
import { PlanBadge } from "./PlanBadge";
import { fetchActivityPlan } from "@/core/activity/api";
import { browserTimezone, formatInstant } from "@/core/schedule/recurrence";
import type { PlanInfo } from "@/core/guild/api";
import styles from "./ActivityBar.module.css";

/** While the launching server is missing the bot, a safety-net poll re-checks on
 *  this cadence — a backstop for clients that don't fire focus/visibility events
 *  (and for a teammate adding the bot). Bounded by {@link AUTO_RECHECK_MAX_TICKS}
 *  so an "Add DWEEB" screen left open doesn't poll the proxy forever; the free
 *  focus/visibility re-checks and the manual button keep working past the cap. */
const AUTO_RECHECK_INTERVAL_MS = 5_000;
const AUTO_RECHECK_MAX_TICKS = 24; // ~2 minutes of polling

/** Space (px) the destination cluster (server glyph + channel picker) needs to
 *  stay readable. The fit check below collapses the utility actions into an
 *  overflow menu once they'd squeeze the destination below this — so a long
 *  channel name truncates gracefully instead of the whole row overflowing. */
const LEFT_MIN_WIDTH = 150;

/** A post the user has asked for but not yet confirmed (the pre-post dialog is
 *  open). `newCopy` marks the "New" button — a separate copy alongside the
 *  already-linked message — so the confirm/success wording stays honest. */
interface PendingPost {
  mode: "new" | "update";
  newCopy: boolean;
}

export function ActivityBar() {
  const undo = useMessageStore((s) => s.undo);
  const redo = useMessageStore((s) => s.redo);
  const canUndo = useMessageStore((s) => s.past.length > 0);
  const canRedo = useMessageStore((s) => s.future.length > 0);

  // "Send feedback" — same form the web app uses, relayed through the proxy from
  // inside Discord (see `core/feedback/submit`). Shown only when the build has a
  // feedback webhook wired up; hidden entirely otherwise.
  const openFeedback = useFeedbackStore((s) => s.openFeedback);
  const feedbackOn = isFeedbackConfigured();

  // Live validation of the shared draft. Errors are the ones Discord would reject
  // (empty message, a button with no label, …); we block Post/Update while any
  // stand so the primary action never dead-ends on a server error. Warnings don't
  // gate. Computed fresh here — the bar sits above the tree's ValidationContext
  // provider — but it's memoized per message, so it's a single cheap pass.
  const validation = useMergedValidationView();
  const hasErrors = validation.errorCount > 0;

  const publishing = useActivityStore((s) => s.publishing);
  const publish = useActivityStore((s) => s.publish);
  const update = useActivityStore((s) => s.update);
  const schedulePost = useActivityStore((s) => s.schedule);
  const openLastPost = useActivityStore((s) => s.openLastPost);
  const openOnWeb = useActivityStore((s) => s.openOnWeb);
  const openPlansOnWeb = useActivityStore((s) => s.openPlansOnWeb);
  const openCustomBotsOnWeb = useActivityStore((s) => s.openCustomBotsOnWeb);
  const lastPost = useActivityStore((s) => s.lastPost);
  const targetChannelId = useActivityStore((s) => s.targetChannelId);
  const setTargetChannel = useActivityStore((s) => s.setTargetChannel);
  const canPostToTarget = useActivityStore((s) => s.canPostToTarget);

  // When the bar can't fit every control at full size on one row the utility
  // actions (restore, open-on-web, feedback, and — in the update state — view)
  // fold into a single overflow menu and the secondary "New" button collapses to
  // its icon; wider bars keep everything inline. Crucially this keys off the
  // bar's *own* width, measured below, not the viewport: the bar lives in the
  // editor pane, which is only half the window on desktop, so a viewport media
  // query (the old approach) kept everything inline in a pane far too narrow for
  // it — the destination got crushed and the actions overflowed. Mirrors the web
  // builder's action bar (see `features/builder/Builder`).
  const barRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  // Bumped by the ResizeObserver whenever the bar's width changes, driving a
  // fresh fit measurement. (Width only — collapsing changes the bar's content,
  // not its width, so this never feeds back on itself.)
  const [barWidth, setBarWidth] = useState(0);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const ro = new ResizeObserver(() => setBarWidth(bar.clientWidth));
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);

  // A DM / group-DM launch has no guild of its own, so the user first picks a
  // destination *server* (DMs can't receive a webhook post), then a channel.
  const isDm = useActivityStore((s) => s.context != null && s.context.guildId == null);
  const guilds = useActivityStore((s) => s.guilds);
  const guildsLoading = useActivityStore((s) => s.guildsLoading);
  const targetGuildId = useActivityStore((s) => s.targetGuildId);
  const setTargetGuild = useActivityStore((s) => s.setTargetGuild);
  const addServer = useActivityStore((s) => s.addServer);
  const refreshPostableGuilds = useActivityStore((s) => s.refreshPostableGuilds);
  const targetGuildMeta = useActivityStore((s) => s.targetGuildMeta);
  const targetGuildMetaLoading = useActivityStore((s) => s.targetGuildMetaLoading);

  // The DWEEB bot isn't in the launching server: there's nothing to post into
  // until it's added, so the primary action becomes "Add DWEEB" rather than a
  // Post button that would dead-end on a 404 (see `botMissing` in activityStore).
  const botMissing = useActivityStore((s) => s.botMissing);
  const addBotToServer = useActivityStore((s) => s.addBotToServer);
  const recheckBot = useActivityStore((s) => s.recheckBot);

  // Bumped each time the user taps "Add DWEEB" — restarts the auto-recheck below
  // with a fresh poll window, since that tap is the moment they're off to add the
  // bot and will return shortly.
  const [recheckArm, setRecheckArm] = useState(0);

  // The DM-launch twin of `recheckArm`: bumped when the user taps "Add a server"
  // in the destination picker, arming the postable-list refresh below so the
  // newly added server appears without a relaunch.
  const [addArm, setAddArm] = useState(0);

  // Auto-detect when the bot finally gets added — no manual step needed. While
  // it's missing, re-check whenever the Activity regains focus/visibility (the
  // user returning from Discord's add-bot flow) plus a bounded safety-net poll
  // for clients that don't fire those events (or when a teammate adds it). All
  // silent (no toast); finding the bot clears `botMissing`, and the guild
  // bootstrap's own "Connected" toast confirms it — which also tears this down
  // (the effect re-runs once `botMissing` is false and bails). The poll is capped
  // so an idle screen doesn't poll forever, but the free focus/visibility watch
  // stays for the whole time, and tapping "Add DWEEB" re-arms a fresh window.
  useEffect(() => {
    if (!botMissing) return;
    const check = () => void recheckBot();
    const onVisibility = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", check);
    let ticks = 0;
    const poll = window.setInterval(() => {
      if (++ticks > AUTO_RECHECK_MAX_TICKS) {
        window.clearInterval(poll);
        return;
      }
      check();
    }, AUTO_RECHECK_INTERVAL_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", check);
      window.clearInterval(poll);
    };
  }, [botMissing, recheckBot, recheckArm]);

  // DM launch: once the user taps "Add a server" in the picker, refresh the
  // postable list when they return — on focus/visibility (coming back from the
  // add-bot flow) plus a bounded safety-net poll for clients that don't fire
  // those events. Mirrors the botMissing auto-recheck above and is capped the
  // same way, so an abandoned add doesn't poll the proxy forever; the free
  // focus/visibility watch keeps working past the cap, and re-tapping re-arms.
  useEffect(() => {
    if (!isDm || addArm === 0) return;
    const check = () => void refreshPostableGuilds();
    const onVisibility = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", check);
    let ticks = 0;
    const poll = window.setInterval(() => {
      if (++ticks > AUTO_RECHECK_MAX_TICKS) {
        window.clearInterval(poll);
        return;
      }
      check();
    }, AUTO_RECHECK_INTERVAL_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", check);
      window.clearInterval(poll);
    };
  }, [isDm, addArm, refreshPostableGuilds]);

  // The destination server's plan, for the quiet plan indicator (PlanBadge). A
  // display-only read that fails soft — any error just leaves it null and the
  // pill hidden, so it never intrudes on the builder. Reloads when the target
  // server changes; a DM launch with no destination picked yet shows nothing.
  const [plan, setPlan] = useState<PlanInfo | null>(null);
  useEffect(() => {
    if (!targetGuildId) {
      setPlan(null);
      return;
    }
    setPlan(null);
    const ac = new AbortController();
    void fetchActivityPlan(targetGuildId, ac.signal).then((p) => {
      if (p) setPlan(p);
    });
    return () => ac.abort();
  }, [targetGuildId]);

  // Destination channel name + kind for the confirm/success dialogs — resolved
  // from the connected guild's channel map (the same source the picker reads).
  // The kind lets the confirm require a post title on a forum/media destination.
  const connectedData = useGuildStore((s) => s.data);
  const targetChannel = targetChannelId ? connectedData?.channelById[targetChannelId] : undefined;
  const channelName = targetChannel?.name;
  const channelType = targetChannel?.type;

  const [restoreOpen, setRestoreOpen] = useState(false);
  // The Activity has one useful save destination: the selected server's shared
  // library. Its dialog therefore only asks for a name (no browser/server
  // destination toggle like the web app).
  const [saveOpen, setSaveOpen] = useState(false);
  // The server-library "Message directory" dialog. Reads the same Manage-Webhooks
  // gate as Restore (the proxy enforces it), so it shares the disabled states.
  const [libraryOpen, setLibraryOpen] = useState(false);
  // The pre-post confirm dialog: non-null while a post awaits confirmation. The
  // actual POST/PATCH runs from `confirmPost` once the user confirms.
  const [pending, setPending] = useState<PendingPost | null>(null);
  // The post-success dialog: set after a publish/update lands, cleared on close.
  // `permanent`/`permanentError` carry the never-expire outcome for its receipt.
  const [posted, setPosted] = useState<{
    mode: "new" | "update";
    permanent: boolean;
    permanentError: string | null;
  } | null>(null);

  const noDestination = !targetGuildId || !targetChannelId;
  // The user lacks Manage Webhooks in the destination server: they can edit and
  // collaborate, but can't be the one to Post (a permitted teammate in the room
  // does that). Only a *known* `false` gates the UI — while it's still being
  // resolved (`null`) we stay optimistic, since the proxy is the real guard.
  const blockedFromPosting = canPostToTarget === false;
  // The full "you can't post here" explanation, reused as the pill's tooltip and
  // the Restore button's disabled hint.
  const blockedReason =
    "You don't have the “Manage Webhooks” permission in this server, so you can't " +
    "post here — but you can still edit together. Ask someone who can post, or use " +
    "“Open on web”.";
  // "Update" applies only while the chosen destination still matches where we
  // last posted; re-point the channel/server and the primary reverts to "Post".
  const canUpdate =
    lastPost != null &&
    lastPost.guild_id === targetGuildId &&
    lastPost.channel_id === targetChannelId;

  // "View the posted message" belongs to the update state and only when posting
  // here is actually possible — mirroring the wide-layout `canUpdate` arm below,
  // where it sits inline. When compact it rides in the overflow menu instead.
  const showView = canUpdate && !botMissing && !blockedFromPosting;

  // A signature of everything that changes the *inline* bar's width, so a state
  // flip (Post↔Update revealing New/View, the plan pill appearing, feedback
  // toggling) re-runs the fit measurement below — not just a raw width change.
  const planVisible = !!(plan && !botMissing && targetGuildId);
  const layoutKey = `${canUpdate}|${botMissing}|${blockedFromPosting}|${showView}|${planVisible}|${feedbackOn}|${isDm}`;

  // Measure whether the inline layout fits, collapsing to compact when it can't.
  // First optimistically restore the full row on any width/content change…
  useLayoutEffect(() => {
    setCompact(false);
  }, [barWidth, layoutKey]);
  // …then, before paint, check it against the bar's real width and collapse if
  // the actions (their natural, never-shrinking width) would leave the
  // destination less than a readable minimum. The right cluster is `flex:none`
  // so its box width *is* its natural width; the left is allowed to truncate, so
  // we reserve a fixed minimum for it rather than its content width. Runs in a
  // layout effect so the collapse never flashes.
  useLayoutEffect(() => {
    const bar = barRef.current;
    const right = rightRef.current;
    if (!bar || !right || compact) return;
    const cs = getComputedStyle(bar);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const gap = parseFloat(cs.columnGap) || 0;
    const needed = right.getBoundingClientRect().width + LEFT_MIN_WIDTH + gap + padX;
    if (needed > bar.clientWidth + 1) setCompact(true);
  }, [compact, barWidth, layoutKey]);

  // Undo/redo (and the overflow trigger) tighten to the small control size when
  // compact so the row keeps breathing room; full size on wider bars.
  const iconSize = compact ? "sm" : "md";

  // Run the confirmed post. `publish`/`update` resolve with the result on
  // success (null on failure, which they toast), so we only swap the confirm
  // dialog for the success one when something actually landed; a failure leaves
  // the confirm open so the user can retry. `makePermanent` (the confirm's
  // "Never expire" choice) and `postAs` (its "Post as" choice — a connected
  // custom bot, or null for DWEEB) only apply to a new post — an update keeps
  // the message's slot and rides the identity that authored it.
  const confirmPost = async (makePermanent: boolean, postAs: string | null) => {
    if (!pending) return;
    const { mode } = pending;
    const result = mode === "update" ? await update() : await publish(makePermanent, postAs);
    if (result) {
      setPending(null);
      setPosted({
        mode,
        permanent: result.permanent ?? false,
        permanentError: result.permanent_error ?? null,
      });
    }
  };

  // Run the confirmed SCHEDULE (the confirm's "When → Schedule" choice): store
  // the message server-side to post at `at`. Success is a toast rather than the
  // post-success dialog — nothing has landed in the channel yet, so there's no
  // message to view; a failure toasts (from the store) and leaves the confirm
  // open to adjust the time and retry.
  const confirmSchedule = async (makePermanent: boolean, at: number) => {
    if (!pending) return;
    const firesAt = await schedulePost(at, makePermanent);
    if (firesAt != null) {
      setPending(null);
      pushToast(
        `Scheduled for ${formatInstant(firesAt, browserTimezone())} — manage it under the Message directory's Scheduled tab.`,
        "success",
      );
    }
  };

  return (
    <div ref={barRef} className={styles.bar} data-compact={compact ? "" : undefined}>
      <div ref={leftRef} className={styles.left}>
        {/* Server indicator, left corner — which server the post lands in. On a
            DM launch it's the destination picker, collapsed to the chosen
            server's icon + dropdown arrow (or a "Pick a server" prompt before
            one's chosen). On a guild launch it's a static icon for the launching
            server — no dropdown, since the server is fixed. */}
        {isDm ? (
          <GuildPicker
            guilds={guilds}
            loading={guildsLoading}
            selectedId={targetGuildId}
            onSelect={setTargetGuild}
            onAddServer={() => {
              void addServer();
              setAddArm((n) => n + 1);
            }}
            compact
          />
        ) : targetGuildMeta ? (
          <span className={styles.serverBadge} title={`Posting to ${targetGuildMeta.name}`}>
            <ServerGlyph guild={targetGuildMeta} size={28} />
          </span>
        ) : targetGuildMetaLoading ? (
          // Meta still resolving on a guild launch — hold a skeleton in the slot so
          // the indicator doesn't pop in from an empty gap once it lands.
          <span className={styles.serverBadge}>
            <ServerGlyphSkeleton size={28} />
          </span>
        ) : null}

        {/* The channel the post lands in. On a DM launch there are no channels to
            offer until a destination *server* is picked, so the dropdown only
            appears once one is. On a server launch the destination is synced across
            the room (`shared`), so the picker shows a "shared" marker and changing
            it re-points everyone. */}
        {!isDm || targetGuildId ? (
          <ChannelPicker
            selectedId={targetChannelId}
            onSelect={setTargetChannel}
            shared={!isDm}
            // Edit-only collaborators see the destination but can't move it —
            // re-pointing a shared room is a posting decision they don't hold.
            // Also inert until the bot's in the server (no channels are loaded).
            disabled={blockedFromPosting || botMissing}
          />
        ) : null}
      </div>

      <div ref={rightRef} className={styles.right}>
        {/* Quiet plan indicator, leading the utility cluster — a recessive pill
            showing the server's tier, opening a popover with the limits + a
            "see plans on web" hand-off. Hidden until a destination server is
            known and the bot's in it (in the "Add DWEEB" state the bar is about
            getting set up, not plans). See PlanBadge for the newcomer rationale. */}
        {plan && !botMissing && targetGuildId ? (
          <>
            <PlanBadge
              plan={plan}
              serverName={targetGuildMeta?.name}
              onSeePlans={() => void openPlansOnWeb(targetGuildId)}
            />
            <span className={styles.sep} aria-hidden="true" />
          </>
        ) : null}

        {/* Utility actions — saving/browsing the server library, restoring a
            message DWEEB posted here, and jumping to the full web app. Library
            actions are server-scoped (no channel needed); Restore reads through
            the channel's webhook. All three server actions are gated on Manage
            Webhooks. "Open on web" hands the current draft to the web app for
            browser-local saves, account, and other full-site management.

            When the bar is too narrow to hold every control at full size, these
            fold into a single overflow menu — which also absorbs the update
            state's "View" — keeping the row to the destination, undo/redo, and
            the primary action. Wider bars show them inline. */}
        {compact ? (
          <Menu
            align="end"
            trigger={
              <IconButton label="More actions" size="sm">
                <MoreHorizontalIcon />
              </IconButton>
            }
          >
            {(close) => (
              <>
                {showView ? (
                  <MenuItem
                    icon={<ExternalLinkIcon size={16} />}
                    onSelect={() => {
                      close();
                      void openLastPost();
                    }}
                  >
                    View posted message
                  </MenuItem>
                ) : null}
                <MenuItem
                  icon={<SaveIcon size={16} />}
                  disabled={!targetGuildId || blockedFromPosting || botMissing}
                  onSelect={() => {
                    close();
                    setSaveOpen(true);
                  }}
                >
                  Save current message
                </MenuItem>
                <MenuItem
                  icon={<BookmarkIcon size={16} />}
                  disabled={!targetGuildId || blockedFromPosting || botMissing}
                  onSelect={() => {
                    close();
                    setLibraryOpen(true);
                  }}
                >
                  Message directory
                </MenuItem>
                <MenuItem
                  icon={<HistoryIcon size={16} />}
                  disabled={noDestination || blockedFromPosting || botMissing}
                  onSelect={() => {
                    close();
                    setRestoreOpen(true);
                  }}
                >
                  Restore a message
                </MenuItem>
                <MenuItem
                  icon={<GlobeIcon size={16} />}
                  onSelect={() => {
                    close();
                    void openOnWeb();
                  }}
                >
                  Open on web
                </MenuItem>
                {feedbackOn ? (
                  <MenuItem
                    icon={<SupportIcon size={16} />}
                    onSelect={() => {
                      close();
                      openFeedback();
                    }}
                  >
                    Send feedback
                  </MenuItem>
                ) : null}
              </>
            )}
          </Menu>
        ) : (
          <>
            <IconButton
              label={
                botMissing
                  ? "Add DWEEB to this server first to save a server draft"
                  : blockedFromPosting
                    ? blockedReason
                    : targetGuildId
                      ? "Save the current message as a server draft"
                      : "Pick a server before saving a draft"
              }
              onClick={() => setSaveOpen(true)}
              disabled={!targetGuildId || blockedFromPosting || botMissing}
            >
              <SaveIcon />
            </IconButton>

            <IconButton
              label={
                botMissing
                  ? "Add DWEEB to this server first to open its message library"
                  : blockedFromPosting
                    ? blockedReason
                    : "Message directory — this server's message library"
              }
              onClick={() => setLibraryOpen(true)}
              disabled={!targetGuildId || blockedFromPosting || botMissing}
            >
              <BookmarkIcon />
            </IconButton>

            <IconButton
              label={
                botMissing
                  ? "Add DWEEB to this server first to restore a message"
                  : blockedFromPosting
                    ? blockedReason
                    : "Restore a message DWEEB posted"
              }
              onClick={() => setRestoreOpen(true)}
              disabled={noDestination || blockedFromPosting || botMissing}
            >
              <HistoryIcon />
            </IconButton>

            <IconButton label="Open on web for full features" onClick={() => void openOnWeb()}>
              <GlobeIcon />
            </IconButton>

            {feedbackOn ? (
              <IconButton label="Send feedback" onClick={openFeedback}>
                <SupportIcon />
              </IconButton>
            ) : null}
          </>
        )}

        <span className={styles.sep} aria-hidden="true" />

        <IconButton label="Undo" onClick={undo} disabled={!canUndo} size={iconSize}>
          <UndoIcon />
        </IconButton>
        <IconButton label="Redo" onClick={redo} disabled={!canRedo} size={iconSize}>
          <RedoIcon />
        </IconButton>

        <span className={styles.sep} aria-hidden="true" />

        {botMissing ? (
          // The bot isn't in this server — posting is impossible until it's added.
          // Swap the Post button for a direct "Add DWEEB" call-to-action (opens
          // Discord's add-bot flow via the host). No "check" button: we re-detect
          // it automatically on return (see the auto-recheck effect above).
          // Editing/collab still works in the meantime.
          <Button
            variant="primary"
            size="sm"
            leadingIcon={<PlusIcon size={14} />}
            onClick={() => {
              void addBotToServer();
              setRecheckArm((n) => n + 1);
            }}
            title="Add the DWEEB bot to this server so you can post here"
          >
            Add DWEEB
          </Button>
        ) : blockedFromPosting ? (
          // No Manage Webhooks here: editing/collab stays open (above), but the
          // primary action becomes an "edit only" explainer rather than a Post
          // button that would dead-end on a 403. Tapping it surfaces the reason as
          // a toast, so the "why" reaches mobile (which has no hover tooltip).
          <button
            type="button"
            className={styles.gated}
            aria-label={blockedReason}
            title={blockedReason}
            onClick={() => pushToast(blockedReason, "info")}
          >
            <LockIcon size={14} />
            Edit only
          </button>
        ) : canUpdate ? (
          <>
            {/* The iframe can't open discord.com itself; openLastPost routes
                through the SDK (see activityStore). When compact this moves into
                the overflow menu above, so it's only inline on wider bars. */}
            {!compact ? (
              <IconButton label="View the posted message" onClick={() => void openLastPost()}>
                <ExternalLinkIcon />
              </IconButton>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<SendIcon />}
              collapseLabel
              onClick={() => setPending({ mode: "new", newCopy: true })}
              disabled={publishing || noDestination || hasErrors}
              title={
                hasErrors
                  ? "Fix the highlighted issues before posting"
                  : "Post a separate new copy into the channel"
              }
            >
              New
            </Button>
            <Button
              variant="primary"
              size="sm"
              leadingIcon={<RefreshIcon />}
              onClick={() => setPending({ mode: "update", newCopy: false })}
              disabled={publishing || noDestination || hasErrors}
              title={
                hasErrors
                  ? "Fix the highlighted issues before updating"
                  : "Update the message you posted with the current draft"
              }
            >
              {publishing ? "Updating…" : "Update"}
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            size="sm"
            leadingIcon={<SendIcon />}
            onClick={() => setPending({ mode: "new", newCopy: false })}
            disabled={publishing || noDestination || hasErrors}
            title={
              hasErrors
                ? "Fix the highlighted issues before posting"
                : "Post this message into the selected channel"
            }
          >
            {publishing ? "Posting…" : "Post"}
          </Button>
        )}
      </div>

      <SaveDraftDialog
        open={saveOpen}
        guildId={targetGuildId}
        serverName={targetGuildMeta?.name}
        onClose={() => setSaveOpen(false)}
      />
      <RestoreDialog open={restoreOpen} onClose={() => setRestoreOpen(false)} />
      {/* Full-screen, like the web app's gallery; mounted only while open so
          each visit starts fresh (default tab, empty search, page one). */}
      {libraryOpen ? <ActivityGallery onClose={() => setLibraryOpen(false)} /> : null}

      <PostConfirm
        open={pending != null}
        mode={pending?.mode ?? "new"}
        newCopy={pending?.newCopy ?? false}
        guild={targetGuildMeta}
        guildId={targetGuildId}
        channelName={channelName}
        channelType={channelType}
        busy={publishing}
        onConfirm={(makePermanent, postAs) => void confirmPost(makePermanent, postAs)}
        onSchedule={(makePermanent, at) => void confirmSchedule(makePermanent, at)}
        onCancel={() => setPending(null)}
        onManageOnWeb={() => void openOnWeb()}
        onManageCustomBots={() => {
          if (targetGuildId) void openCustomBotsOnWeb(targetGuildId);
        }}
      />

      <PostSuccess
        open={posted != null}
        mode={posted?.mode ?? "new"}
        guild={targetGuildMeta}
        channelName={channelName}
        canView={lastPost?.url != null}
        onView={() => void openLastPost()}
        permanent={posted?.permanent ?? false}
        permanentError={posted?.permanentError ?? null}
        onManageOnWeb={() => void openOnWeb()}
        onClose={() => setPosted(null)}
      />
    </div>
  );
}
