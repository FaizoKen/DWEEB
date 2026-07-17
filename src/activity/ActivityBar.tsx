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
 * named draft, browse the Message directory, or restore a posted message, plus
 * the pure-client JSON import/export (the same panel the web Share dialog uses).
 * Scheduling rides inside the post confirm (its "When → Schedule" choice)
 * rather than as bar chrome; existing schedules are managed in the Message
 * directory's Scheduled tab.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { usePostDestinationStore } from "@/core/state/postDestinationStore";
import { useGuildStore } from "@/core/guild/guildStore";
import { useActivityStore } from "@/core/activity/activityStore";
import { useFeedbackStore } from "@/features/feedback/feedbackStore";
import { useFeedbackConfigured } from "@/core/feedback/submit";
import { useMergedValidationView } from "@/features/builder/useValidation";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { Menu, MenuItem } from "@/ui/Menu";
import { pushToast } from "@/ui/Toast";
import {
  BookmarkIcon,
  BracesIcon,
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
import { ChannelPicker } from "@/features/guild/ChannelPicker";
import { GuildPicker, ServerGlyph, ServerGlyphSkeleton } from "./GuildPicker";
import { ActivityGallery } from "./ActivityGallery";
import { RestoreDialog } from "./RestoreDialog";
import { SaveDraftDialog } from "./SaveDraftDialog";
import { JsonDialog } from "./JsonDialog";
import { PostConfirm } from "./PostConfirm";
import { PostSuccess } from "./PostSuccess";
import { PlanBadge } from "@/features/plan/PlanBadge";
import { fetchActivityPlan } from "@/core/activity/api";
import { browserTimezone, formatInstant } from "@/core/schedule/recurrence";
import { MAX_INLINE_UTILITIES, measureNeededWidth } from "@/lib/measureBarFit";
import { useBarWidth } from "@/lib/useBarWidth";
import type { PlanInfo } from "@/core/guild/api";
import styles from "./ActivityBar.module.css";

/** While the launching server is missing the bot, a safety-net poll re-checks on
 *  this cadence — a backstop for clients that don't fire focus/visibility events
 *  (and for a teammate adding the bot). Bounded by {@link AUTO_RECHECK_MAX_TICKS}
 *  so an "Add DWEEB" screen left open doesn't poll the proxy forever; the free
 *  focus/visibility re-checks and the manual button keep working past the cap. */
const AUTO_RECHECK_INTERVAL_MS = 5_000;
const AUTO_RECHECK_MAX_TICKS = 24; // ~2 minutes of polling

/** One utility action in the bar's right cluster: an inline icon button while
 *  the bar has room, an overflow-menu row once the fit check folds it away. */
interface UtilityAction {
  key: string;
  icon: ComponentType<{ size?: number }>;
  /** Tooltip / accessible name on the inline icon button. */
  label: string;
  /** Row text once folded into the overflow menu. */
  menuLabel: string;
  disabled?: boolean;
  run: () => void;
}

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
  const feedbackOn = useFeedbackConfigured();

  // Live validation of the shared draft. Errors are the ones Discord would reject
  // (empty message, a button with no label, …); we block Post/Update while any
  // stand so the primary action never dead-ends on a server error. Warnings don't
  // gate. Computed fresh here — the bar sits above the tree's ValidationContext
  // provider — but it's memoized per message, so it's a single cheap pass.
  const validation = useMergedValidationView();
  const hasErrors = validation.errorCount > 0;
  // The destination-title rules (a forum/media channel needs a `thread_name`;
  // every other kind rejects one) only apply to *brand-new* posts — an update
  // PATCHes the existing message, where Discord disregards the create-only
  // `thread_name` param. A restored forum post's draft never carries one
  // (Discord doesn't echo execute-only params), so gate Update on every error
  // EXCEPT those; Post and "New" (a new copy) keep the full gate.
  const destErrorCount = validation.messageIssues.filter(
    (i) =>
      (i.code === "THREAD_NAME_REQUIRED" || i.code === "THREAD_NAME_FORBIDDEN") &&
      i.severity === "error",
  ).length;
  const hasUpdateErrors = validation.errorCount - destErrorCount > 0;

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

  // When the bar can't fit every control at full size on one row, its controls
  // collapse one small step at a time (see the ladder built below `showView`):
  // the row first tightens (`data-compact` — dividers go, sizes shrink, "New"
  // drops its label), then the utility actions fold into an overflow menu one
  // at a time, then — in the update state — "View" folds too. Wider bars keep
  // everything inline. Crucially this keys off the bar's *own* width, measured
  // below, not the viewport: the bar lives in the editor pane, which is only
  // half the window on desktop, so a viewport media query (the old approach)
  // kept everything inline in a pane far too narrow for it — the destination
  // got crushed and the actions overflowed. Mirrors the web builder's action
  // bar (see `features/builder/Builder`).
  const barRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const [level, setLevel] = useState(0);
  // Bumped whenever the bar's width changes, driving a fresh fit measurement.
  // (Width only — collapsing changes the bar's content, not its width, so this
  // never feeds back on itself.) The measurement is deliberately taken off the
  // resize-notification cycle — see `useBarWidth`.
  const barWidth = useBarWidth(barRef);

  // A server launch posts into the server it launched in — that server is FIXED
  // (the room is keyed to it, and its shared destination is a channel id and
  // nothing else), so the bar shows it as a static badge and only the channel is
  // pickable. A DM / group-DM launch has no guild of its own, so there the user
  // first picks a destination *server* (DMs can't receive a webhook post), then a
  // channel — that's the one launch kind with a server picker.
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
  // in the server picker, arming the postable-list refresh below so the newly
  // added server appears without a relaunch.
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

  // Mirror the picked destination into the shared post-destination store, so
  // the editor's validation goes destination-aware: selecting a forum/media
  // channel surfaces "needs a post title" live in the builder (banner + Forum
  // lane dot + disabled Post) instead of springing it in the confirm dialog.
  const setPostDestination = usePostDestinationStore((s) => s.setPostDestination);
  useEffect(() => {
    setPostDestination(channelType ?? null, channelName ?? null);
  }, [setPostDestination, channelType, channelName]);

  const [restoreOpen, setRestoreOpen] = useState(false);
  // The Activity has one useful save destination: the selected server's shared
  // library. Its dialog therefore only asks for a name (no browser/server
  // destination toggle like the web app).
  const [saveOpen, setSaveOpen] = useState(false);
  // The server-library "Message directory" dialog. Reads the same Manage-Webhooks
  // gate as Restore (the proxy enforces it), so it shares the disabled states.
  const [libraryOpen, setLibraryOpen] = useState(false);
  // Import / export the shared draft as JSON — pure client-side (no server call,
  // no permission gate); an import replaces the draft and collab syncs it to the
  // room. Available in every launch state, even before a destination is picked.
  const [jsonOpen, setJsonOpen] = useState(false);
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

  // Utility actions, most-reached-for first. Only the first
  // MAX_INLINE_UTILITIES get an inline icon; the rest ("Open on web",
  // JSON, feedback — occasional, and hard to tell apart as bare glyphs) are
  // overflow-menu rows at every width. The fit check below folds the inline
  // few away too as the bar narrows, one at a time from the END of the inline
  // run, so the least-reached-for icon leaves the row first and a near-fit
  // never strands a wide empty gap where a whole cluster used to be.
  const utilities: UtilityAction[] = [
    {
      key: "save",
      icon: SaveIcon,
      label: botMissing
        ? "Add DWEEB to this server first to save a server draft"
        : blockedFromPosting
          ? blockedReason
          : targetGuildId
            ? "Save the current message as a server draft"
            : "Pick a server before saving a draft",
      menuLabel: "Save current message",
      disabled: !targetGuildId || blockedFromPosting || botMissing,
      run: () => setSaveOpen(true),
    },
    {
      key: "library",
      icon: BookmarkIcon,
      label: botMissing
        ? "Add DWEEB to this server first to open its message library"
        : blockedFromPosting
          ? blockedReason
          : "Message directory — this server's message library",
      menuLabel: "Message directory",
      disabled: !targetGuildId || blockedFromPosting || botMissing,
      run: () => setLibraryOpen(true),
    },
    {
      key: "restore",
      icon: HistoryIcon,
      label: botMissing
        ? "Add DWEEB to this server first to restore a message"
        : blockedFromPosting
          ? blockedReason
          : "Restore a message DWEEB posted",
      menuLabel: "Restore a message",
      disabled: noDestination || blockedFromPosting || botMissing,
      run: () => setRestoreOpen(true),
    },
    {
      key: "web",
      icon: GlobeIcon,
      label: "Open on web for full features",
      menuLabel: "Open on web",
      run: () => void openOnWeb(),
    },
    {
      key: "json",
      icon: BracesIcon,
      label: "Import or export the message as JSON",
      menuLabel: "Import / export JSON",
      run: () => setJsonOpen(true),
    },
    ...(feedbackOn
      ? [
          {
            key: "feedback",
            icon: SupportIcon,
            label: "Send feedback",
            menuLabel: "Send feedback",
            run: openFeedback,
          } satisfies UtilityAction,
        ]
      : []),
  ];

  // The collapse ladder: step 1 tightens the row (`data-compact`), steps
  // 2..N+1 fold the N inline utility icons into the overflow menu one at a
  // time, and — in the update state — a final step folds the inline "View"
  // button too. N is the capped inline run, not the whole list: the tail past
  // the cap is already in the menu and has no ladder step to fold on.
  const inlineMax = Math.min(utilities.length, MAX_INLINE_UTILITIES);
  const foldMax = inlineMax;
  const maxLevel = 1 + foldMax + (showView ? 1 : 0);
  const tightened = level >= 1;
  const foldedCount = Math.min(Math.max(level - 1, 0), foldMax);
  const inlineCount = inlineMax - foldedCount;
  const inlineUtilities = utilities.slice(0, inlineCount);
  const foldedUtilities = utilities.slice(inlineCount);
  const viewFolded = showView && level >= 1 + foldMax + 1;

  // A signature of everything that changes the *inline* bar's width, so a state
  // flip (Post↔Update revealing New/View, the plan pill appearing, the
  // destination renaming) re-runs the fit measurement below — not just a raw
  // width change. The channel name matters because the left reserve tracks the
  // cluster's natural width; the server id because a DM launch's picker
  // collapses to its icon once a server is chosen ("Pick a server" until then) and
  // the channel picker only appears beside it from that point on. Feedback is
  // absent: it sits past the inline cap, so toggling it only ever adds or
  // removes a menu row.
  const planVisible = !!(plan && !botMissing && targetGuildId);
  const layoutKey = `${canUpdate}|${botMissing}|${blockedFromPosting}|${showView}|${planVisible}|${isDm}|${targetGuildId ?? ""}|${channelName ?? ""}`;

  // Measure whether the inline layout fits, collapsing one step when it can't:
  // on any width/content change, optimistically restore the full row, then —
  // before paint — check it against the bar's real width and collapse if the
  // actions (their natural, never-shrinking width) would leave the destination
  // less than it needs. The right cluster is `flex:none` so its box width *is*
  // its natural width; the left is allowed to truncate, so we reserve its
  // natural width capped at a readable maximum. Runs in a layout effect so the
  // staged collapse never flashes.
  //
  // Restart and measurement live in ONE effect on purpose. As separate effects
  // (the old shape), a width change made the reset queue `level = 0` while the
  // measurement pass in the same commit still saw the OUTGOING level's DOM and
  // queued `level + 1` — netting the same level as before, so the effect never
  // re-ran and the ladder wedged mid-collapse (crushed destination, overflowing
  // actions) on any gradual resize. Here a fresh cycle only resets; measuring
  // resumes next commit, once the DOM really shows the restored full row.
  const fitCycleRef = useRef("");
  useLayoutEffect(() => {
    const fitCycle = `${barWidth}|${layoutKey}`;
    if (fitCycleRef.current !== fitCycle) {
      fitCycleRef.current = fitCycle;
      if (level !== 0) {
        setLevel(0);
        return;
      }
    }
    const bar = barRef.current;
    const left = leftRef.current;
    const right = rightRef.current;
    if (!bar || !left || !right || level >= maxLevel) return;
    const needed = measureNeededWidth(bar, left, right);
    if (needed > bar.clientWidth + 1) setLevel((l) => l + 1);
  }, [level, maxLevel, barWidth, layoutKey]);

  // Undo/redo (and the overflow trigger) tighten to the small control size once
  // the row tightens; full size on wider bars.
  const iconSize = tightened ? ("sm" as const) : ("md" as const);

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
  // the message server-side to post at `at`, as `postAs` (a connected custom
  // bot, or null for DWEEB). Success is a toast rather than the post-success
  // dialog — nothing has landed in the channel yet, so there's no message to
  // view; a failure toasts (from the store) and leaves the confirm open to
  // adjust the time and retry.
  const confirmSchedule = async (makePermanent: boolean, at: number, postAs: string | null) => {
    if (!pending) return;
    const firesAt = await schedulePost(at, makePermanent, postAs);
    if (firesAt != null) {
      setPending(null);
      pushToast(
        `Scheduled for ${formatInstant(firesAt, browserTimezone())} — manage it under the Message directory's Scheduled tab.`,
        "success",
      );
    }
  };

  return (
    <div ref={barRef} className={styles.bar} data-compact={tightened ? "" : undefined}>
      <div ref={leftRef} className={styles.left}>
        {/* Server indicator, left corner — which server the post lands in. On a
            guild launch it's a STATIC badge for the launching server: no dropdown,
            because the destination server is fixed. The room is keyed to that
            server and its shared destination frame carries a channel id and nothing
            else, so a post aimed anywhere else couldn't be shared with the people
            you're editing with — the collaboration and the post would quietly come
            apart. Post elsewhere from the web app instead ("Open on web"). Only a
            DM launch gets a picker here (it has no server of its own to post into),
            collapsed to the chosen server's icon + arrow — or a "Pick a server"
            prompt before one's chosen. A guild launch holds a skeleton until its
            server's meta lands, so the badge doesn't pop in from an empty gap;
            should that lookup fail outright the slot stays empty (the destination
            still works — the meta is context, not a blocker). */}
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
          <span
            className={styles.serverBadge}
            role="img"
            aria-label={`Posting to ${targetGuildMeta.name}`}
            title={`Posting to ${targetGuildMeta.name}`}
          >
            <ServerGlyph guild={targetGuildMeta} size={28} />
          </span>
        ) : targetGuildMetaLoading ? (
          <span className={styles.serverBadge}>
            <ServerGlyphSkeleton size={28} />
          </span>
        ) : null}

        {/* The channel the post lands in. On a DM launch there are no channels to
            offer until a destination *server* is picked, so the dropdown only
            appears once one is. On a guild launch the destination is synced across
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

        {/* Utility actions — the everyday few only: saving/browsing the server
            library and restoring a message DWEEB posted here. Library actions
            are server-scoped (no channel needed); Restore reads through the
            channel's webhook. All three are gated on Manage Webhooks. The rest
            of the list ("Open on web", which hands the current draft to the web
            app for browser-local saves and account management; JSON; feedback)
            is menu-only at every width — see the cap above the list.

            When the bar is too narrow to hold every control at full size, the
            fit check folds even these into the overflow menu one at a time —
            which can also absorb the update state's "View" — keeping the row
            to the destination, undo/redo, and the primary action. */}
        {inlineUtilities.map((action) => (
          <IconButton
            key={action.key}
            label={action.label}
            onClick={action.run}
            disabled={action.disabled}
          >
            <action.icon />
          </IconButton>
        ))}

        {foldedUtilities.length > 0 || viewFolded ? (
          <Menu
            align="end"
            trigger={
              <IconButton label="More actions" size={iconSize}>
                <MoreHorizontalIcon />
              </IconButton>
            }
          >
            {(close) => (
              <>
                {viewFolded ? (
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
                {foldedUtilities.map((action) => (
                  <MenuItem
                    key={action.key}
                    icon={<action.icon size={16} />}
                    disabled={action.disabled}
                    onSelect={() => {
                      close();
                      action.run();
                    }}
                  >
                    {action.menuLabel}
                  </MenuItem>
                ))}
              </>
            )}
          </Menu>
        ) : null}

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
                through the SDK (see activityStore). On the tightest bars the
                fit check moves this into the overflow menu above (`viewFolded`),
                so it's only inline while there's room. */}
            {!viewFolded ? (
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
              disabled={publishing || noDestination || hasUpdateErrors}
              title={
                hasUpdateErrors
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
      <JsonDialog open={jsonOpen} onClose={() => setJsonOpen(false)} />
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
        onSchedule={(makePermanent, at, postAs) => void confirmSchedule(makePermanent, at, postAs)}
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
