/**
 * Builder pane — owns every editor control.
 *
 * Layout (top to bottom):
 *   1. ActionBar     — the builder's top bar, mirroring the Discord Activity's
 *                      (`activity/ActivityBar`): account/server on the left;
 *                      plan pill · utility icons · undo/redo · the primary
 *                      Send/Update on the right, in separated clusters.
 *   2. ComponentTree — webhook meta + tree; the selected row reveals its value
 *                      editor inline (no separate docked panel).
 *
 * Selecting in the tree or the preview updates the same store slice, so the
 * two stay in sync without prop drilling.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useMessageStore, type RestoredOrigin } from "@/core/state/messageStore";
import { useSendTargetStore } from "@/core/state/sendTargetStore";
import { usePostDestinationStore } from "@/core/state/postDestinationStore";
import { useGuildStore } from "@/core/guild/guildStore";
import { useAuthStore } from "@/core/auth/authStore";
import { usePlanStore } from "@/core/plan/planStore";
import { loadHistory, parseWebhookUrl, useCanManageGuildWebhooks } from "@/core/webhook";
import { useTemplateGalleryStore } from "@/features/templates/templateGalleryStore";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import {
  BookmarkIcon,
  BracesIcon,
  FilmIcon,
  HistoryIcon,
  InfoIcon,
  InstallIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RedoIcon,
  SaveIcon,
  SendIcon,
  ShareIcon,
  SupportIcon,
  TrashIcon,
  UndoIcon,
  UsersIcon,
} from "@/ui/Icon";
import { Menu, MenuItem, MenuDivider } from "@/ui/Menu";
import { ComponentTree } from "./components/ComponentTree";
import { SaveMessageDialog } from "./components/SaveMessageDialog";
import { AccountMenu } from "@/features/guild/AccountMenu";
import { ChannelPicker } from "@/features/guild/ChannelPicker";
import { PlanBadge } from "@/features/plan/PlanBadge";
import { activityLaunchUrl, isProxyConfigured } from "@/core/guild/config";
import { useFeedbackConfigured } from "@/core/feedback/submit";
import { useFeedbackStore } from "@/features/feedback/feedbackStore";
import { useCollaborateStore } from "@/features/collaborate/collaborateStore";
import { useInstallStore } from "@/features/install/installStore";
import { useInstallState } from "@/features/install/useInstallState";
import { useWelcomeStore } from "@/features/welcome/welcomeStore";
import { measureNeededWidth } from "@/lib/measureBarFit";
import { useBarWidth } from "@/lib/useBarWidth";
import styles from "./Builder.module.css";

/** One utility action in the bar's right cluster: an inline icon button while
 *  the bar has room, a "More"-menu row once the fit check folds it away. */
interface UtilityAction {
  key: string;
  icon: ComponentType<{ size?: number }>;
  /** Tooltip / accessible name on the inline icon button. */
  label: string;
  /** Row text once folded into the More menu. */
  menuLabel: string;
  run: () => void;
}

interface BuilderProps {
  /** Opens the Share / Export dialog on the Share-link tab. */
  onShare: () => void;
  /** Opens the Share / Export dialog on the combined JSON import/export tab. */
  onJson: () => void;
  /** Opens the Share / Export dialog focused on the Send panel (post as new). */
  onSend: () => void;
  /** Opens the Share / Export dialog on the Update tab (edit in place). */
  onUpdate: () => void;
  /** Opens the Share / Export dialog focused on the Restore panel. */
  onRestore: () => void;
  /** Opens the Share / Export dialog focused on the About panel. */
  onAbout: () => void;
}

export function Builder({ onShare, onJson, onSend, onUpdate, onRestore, onAbout }: BuilderProps) {
  return (
    <div className={styles.builder}>
      {/* ActionBar occupies the grid's first (auto) row; the tree fills the 1fr
          row below. The posted-message link indicator lives inside the tree's
          scroll area (see ComponentTree) so it scrolls with the content instead
          of pinning to the top. */}
      <div className={styles.header}>
        <ActionBar
          onShare={onShare}
          onJson={onJson}
          onSend={onSend}
          onUpdate={onUpdate}
          onRestore={onRestore}
          onAbout={onAbout}
        />
      </div>

      <ComponentTree />
    </div>
  );
}

function ActionBar({ onShare, onJson, onSend, onUpdate, onRestore, onAbout }: BuilderProps) {
  const undo = useMessageStore((s) => s.undo);
  const redo = useMessageStore((s) => s.redo);
  const canUndo = useMessageStore((s) => s.past.length > 0);
  const canRedo = useMessageStore((s) => s.future.length > 0);
  const clearAll = useMessageStore((s) => s.clearAll);
  const restoredFrom = useMessageStore((s) => s.restoredFrom);

  const openFeedback = useFeedbackStore((s) => s.openFeedback);
  const feedbackOn = useFeedbackConfigured();
  const openCollaborate = useCollaborateStore((s) => s.openCollaborate);
  const openInstall = useInstallStore((s) => s.openInstall);
  // Hide the install entry once we're already running as the installed app —
  // there's nothing left to install. Every browser (installable or not) still
  // sees it otherwise: the dialog either replays the native prompt or shows
  // per-platform steps.
  const { installed } = useInstallState();

  // The full-screen gallery — posted history, scheduled posts, server drafts,
  // browser drafts, and templates behind one bookmark icon (the web's "Message
  // directory"). No filter: the gallery lands on the first tab that has cards.
  const openGallery = useTemplateGalleryStore((s) => s.openGallery);

  // The connected server's plan, for the quiet plan pill (PlanBadge — shared
  // with the Activity bar). AccountMenu loads it whenever a server connects;
  // this only reads the result, and only trusts it when it belongs to the
  // currently connected server. A miss just hides the pill.
  const connectedGuildId = useGuildStore((s) => s.guildId);
  const plan = usePlanStore((s) =>
    connectedGuildId && s.guildId === connectedGuildId ? s.plan : null,
  );
  const openPricing = usePlanStore((s) => s.openPricing);
  const connectedGuildName = useAuthStore(
    (s) => s.guilds.find((g) => g.id === connectedGuildId)?.name,
  );
  const planVisible = !!plan && !!connectedGuildId;

  // ── Destination channel (mirrors the Activity bar) ────────────────────────
  // The chip next to the account control says where the next post lands. It
  // only exists where it can actually steer a send — the channel-first flow,
  // which needs a signed-in user with Manage Webhooks in the connected server;
  // in the paste-a-URL world the destination *is* the URL in the Send dialog.
  const authed = useAuthStore((s) => s.status === "authed");
  const canManage = useCanManageGuildWebhooks();
  const guildData = useGuildStore((s) => s.data);
  const destActive = authed && canManage && !!connectedGuildId;

  const sendTargetGuildId = useSendTargetStore((s) => s.guildId);
  const sendTargetChannelId = useSendTargetStore((s) => s.channelId);
  const setSendTarget = useSendTargetStore((s) => s.setSendTarget);
  // The pick only means something in the server it was made for; a server
  // switch parks it until the user returns to that server.
  const barChannelId =
    connectedGuildId && sendTargetGuildId === connectedGuildId ? sendTargetChannelId : null;

  // The linked (restored/posted) message's channel, recovered from this
  // browser's webhook history — the entry was written by the restore or send
  // that set the origin, so it's fresh whenever `restoredFrom` changes.
  const restoredChannelId = useMemo(() => {
    if (!restoredFrom) return null;
    const parsed = parseWebhookUrl(restoredFrom.webhookUrl);
    if (!parsed) return null;
    return loadHistory().find((e) => e.id === parsed.id)?.channelId ?? null;
  }, [restoredFrom]);

  // A restore origin is set after restoring a message, or after a successful
  // send re-targets the form at the now-live message. The primary action then
  // reads "Update" (edit in place), with a secondary "New" alongside for a
  // separate copy — mirroring the Activity bar's New/Update pair.
  //
  // The link is scoped to its server: while the connected server differs from
  // the message's home server, the link is *parked* — the bar behaves like a
  // fresh compose there (primary "Send", no mismatch banner to explain), and
  // Update resumes the moment the user reconnects to the message's server.
  // This replaced the old "Updating a message … [Detach]" banner outright; the
  // Send dialog's Update tab still covers the exotic cross-server edit.
  const parked =
    restoredFrom?.guildId != null &&
    !!connectedGuildId &&
    restoredFrom.guildId !== connectedGuildId;
  // Within the right server, "Update" additionally only holds while the
  // destination chip still points at the linked message's channel — like the
  // Activity, re-pointing it elsewhere flips the primary back to "Send" (a new
  // post there). When either channel is unknown (signed out, a pasted URL with
  // no saved entry), the link alone decides — the old behaviour.
  const isUpdate =
    restoredFrom != null &&
    !parked &&
    (!destActive || !barChannelId || !restoredChannelId || restoredChannelId === barChannelId);

  // Seed the chip once per server, so it isn't a blank "Pick a channel" for
  // returning users: the linked message's channel, else the channel of the
  // most recent saved webhook in this server. Only while nothing is picked for
  // this server — an explicit pick always wins.
  useEffect(() => {
    if (!destActive || !connectedGuildId) return;
    if (sendTargetGuildId === connectedGuildId) return;
    const channels = guildData?.guildId === connectedGuildId ? guildData.channelById : null;
    if (!channels) return;
    const fromHistory = loadHistory().find(
      (e) => e.guildId === connectedGuildId && e.channelId && channels[e.channelId],
    )?.channelId;
    const candidate =
      restoredChannelId && channels[restoredChannelId] ? restoredChannelId : (fromHistory ?? null);
    if (candidate) setSendTarget(connectedGuildId, candidate);
  }, [
    destActive,
    connectedGuildId,
    sendTargetGuildId,
    guildData,
    restoredChannelId,
    setSendTarget,
  ]);

  // A *new* link (a restore, or a send that just landed) snaps the chip to the
  // message's channel — the destination and the linked message start out
  // agreeing, like the Activity. Once-per-origin (the ref), so the user can
  // still re-point the chip afterwards without this yanking it back.
  const snappedOriginRef = useRef<RestoredOrigin | null>(null);
  useEffect(() => {
    if (!restoredFrom) {
      snappedOriginRef.current = null;
      return;
    }
    if (snappedOriginRef.current === restoredFrom) return;
    if (!destActive || !connectedGuildId || !restoredChannelId) return;
    if (guildData?.guildId !== connectedGuildId || !guildData.channelById[restoredChannelId])
      return;
    snappedOriginRef.current = restoredFrom;
    setSendTarget(connectedGuildId, restoredChannelId);
  }, [restoredFrom, destActive, connectedGuildId, restoredChannelId, guildData, setSendTarget]);

  // Mirror the picked channel's kind/name into the shared post-destination
  // store, so validation goes destination-aware exactly like the Activity: a
  // forum/media destination surfaces "needs a post title" live in the builder.
  // New posts only — while the primary is Update the next post PATCHes the
  // linked message, where Discord disregards the create-only `thread_name`.
  const setPostDestination = usePostDestinationStore((s) => s.setPostDestination);
  const barChannel =
    barChannelId && guildData?.guildId === connectedGuildId
      ? guildData.channelById[barChannelId]
      : undefined;
  useEffect(() => {
    if (isUpdate || !destActive) setPostDestination(null, null);
    else setPostDestination(barChannel?.type ?? null, barChannel?.name ?? null);
  }, [isUpdate, destActive, barChannel, setPostDestination]);

  // The save dialog behind the bar's save icon (see SaveMessageDialog).
  const [saveOpen, setSaveOpen] = useState(false);

  // Real-time co-editing lives only in the embedded Discord Activity; offer a
  // hand-off to it when a backend + app id are configured (both are required for
  // the Activity to function). Empty string ⇒ the entry point is hidden.
  const collaborateUrl = isProxyConfigured() ? activityLaunchUrl() : "";

  // Utility actions — inline icon buttons while the bar has room. The fit
  // check below folds them into the "More" overflow one at a time from the END
  // of this list, so the least-reached-for actions leave the row first and a
  // near-fit never strands a wide empty gap where a whole cluster used to be.
  const utilities: UtilityAction[] = [
    {
      key: "save",
      icon: SaveIcon,
      label: "Save the current message as a draft",
      menuLabel: "Save current message",
      run: () => setSaveOpen(true),
    },
    {
      key: "gallery",
      icon: BookmarkIcon,
      label: "Message directory — saved messages, posted history, and templates",
      menuLabel: "Message directory",
      run: () => openGallery(),
    },
    {
      key: "restore",
      icon: HistoryIcon,
      label: "Restore a message your webhook previously posted",
      menuLabel: "Restore a message",
      run: onRestore,
    },
    {
      key: "share",
      icon: ShareIcon,
      label: "Share this message as a link",
      menuLabel: "Share link",
      run: onShare,
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

  const barRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  // The action bar always stays on a single row. As its available width shrinks
  // — a narrow builder pane on desktop, or a phone — its controls collapse one
  // small step at a time rather than wrapping onto a second line, so every
  // width keeps as much inline as actually fits:
  //   step 1        — the row tightens: cluster dividers disappear, undo/redo
  //                   and the overflow trigger drop to the small control size,
  //                   and the secondary "New" collapses to its icon (all via
  //                   the `data-compact` flag) — nothing is hidden yet
  //   steps 2..N+1  — the N utility icons fold into the "More" overflow menu
  //                   one at a time, from the end of `utilities`
  //   final step    — the primary Send/Update button drops to its icon
  // We measure the real control widths instead of guessing a breakpoint, so the
  // full row survives on any width — viewport *or* pane — that has room for it.
  // Mirrors the Activity bar's own fit check (see ActivityBar).
  const [level, setLevel] = useState(0);
  const foldMax = utilities.length;
  const maxLevel = 1 + foldMax + 1;
  const tightened = level >= 1;
  const foldedCount = Math.min(Math.max(level - 1, 0), foldMax);
  const inlineUtilities = utilities.slice(0, foldMax - foldedCount);
  const foldedUtilities = utilities.slice(foldMax - foldedCount);
  const primaryIconOnly = level >= maxLevel;
  // Bumped whenever the bar's *width* changes; drives a fresh measurement pass.
  // (Width only — collapsing changes the bar's content, not its width, so this
  // never feeds back on itself.) The measurement is deliberately taken off the
  // resize-notification cycle — see `useBarWidth`.
  const barWidth = useBarWidth(barRef);

  // A signature of everything that changes the *inline* bar's width, so a state
  // flip (Send↔Update revealing New, the plan pill or destination chip
  // appearing or renaming, feedback toggling) re-runs the fit measurement below
  // — not just a raw width change. The channel name matters because the left
  // reserve tracks the cluster's natural width.
  const layoutKey = `${isUpdate}|${planVisible}|${feedbackOn}|${destActive}|${barChannel?.name ?? ""}`;

  // On every width or content change, optimistically restore the full row,
  // then collapse one step at a time until both clusters fit on one row. The
  // right cluster is `flex: none`, so its box width *is* its natural width; the
  // left (account + destination chip) is allowed to truncate, so we reserve its
  // natural width capped at a readable maximum — mirroring the Activity bar's
  // fit check. Each pass runs before paint, so the staged collapse never
  // flashes.
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

  return (
    <>
      <div ref={barRef} className={styles.actionBar} data-compact={tightened ? "" : undefined}>
        {/* Left corner — who you are, which server is connected, and where the
            next post lands (the Activity bar's destination cluster, web
            edition). The chip records intent: the Send dialog's channel-first
            picker resolves this channel's webhook when it opens. It only
            renders where it can steer a send — the paste-a-URL world keeps its
            destination in the dialog. */}
        <div ref={leftRef} className={`${styles.actionGroup} ${styles.left}`}>
          {isProxyConfigured() ? <AccountMenu /> : null}
          {destActive && connectedGuildId ? (
            <ChannelPicker
              selectedId={barChannelId}
              onSelect={(id) => setSendTarget(connectedGuildId, id)}
            />
          ) : null}
        </div>

        <div ref={rightRef} className={`${styles.actionGroup} ${styles.right}`}>
          {/* Quiet plan indicator, leading the utility cluster — a recessive
              pill showing the connected server's tier, opening a popover with
              the limits and the pricing modal. Hidden until a server is
              connected and its plan is known. */}
          {plan && connectedGuildId ? (
            <>
              <PlanBadge
                plan={plan}
                serverName={connectedGuildName}
                onSeePlans={() => openPricing(connectedGuildId)}
              />
              <span className={styles.sep} aria-hidden="true" />
            </>
          ) : null}

          {/* Utility actions — saving a draft, the message directory (gallery),
              restoring a posted message, sharing a link, and feedback. Inline
              icons while the bar has room; the fit check folds them into the
              "More" overflow below one at a time as the row tightens. */}
          {inlineUtilities.map((action) => (
            <IconButton key={action.key} label={action.label} onClick={action.run}>
              <action.icon />
            </IconButton>
          ))}

          {/* The overflow menu: the long tail of occasional actions, plus any
              utility icons the fit check folded in above them. */}
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
                {foldedUtilities.length > 0 ? (
                  <>
                    {foldedUtilities.map((action) => (
                      <MenuItem
                        key={action.key}
                        icon={<action.icon />}
                        onSelect={() => {
                          close();
                          action.run();
                        }}
                      >
                        {action.menuLabel}
                      </MenuItem>
                    ))}
                    <MenuDivider />
                  </>
                ) : null}
                {collaborateUrl ? (
                  <MenuItem
                    icon={<UsersIcon />}
                    onSelect={() => {
                      close();
                      // Opens the collaboration dialog, which mints a Discord
                      // Activity invite for a channel so the whole group lands
                      // in one shared instance and co-edits live. A bare launcher
                      // link only ever opens a solo call (see CollaborateDialog).
                      openCollaborate();
                    }}
                  >
                    Collaborate in Discord
                  </MenuItem>
                ) : null}
                <MenuItem
                  icon={<BracesIcon />}
                  onSelect={() => {
                    close();
                    onJson();
                  }}
                >
                  Import / export JSON
                </MenuItem>
                <MenuItem
                  icon={<TrashIcon />}
                  onSelect={() => {
                    close();
                    clearAll();
                  }}
                >
                  Clear current message
                </MenuItem>
                <MenuItem
                  icon={<InfoIcon />}
                  onSelect={() => {
                    close();
                    onAbout();
                  }}
                >
                  About
                </MenuItem>
                <MenuItem
                  icon={<FilmIcon />}
                  onSelect={() => {
                    close();
                    // Replay the intro film on demand — always available, so
                    // closing it on the first visit is never a one-way door.
                    useWelcomeStore.getState().openWelcome();
                  }}
                >
                  Watch the intro
                </MenuItem>
                {installed ? null : (
                  <MenuItem
                    icon={<InstallIcon />}
                    onSelect={() => {
                      close();
                      // Opens the install dialog, which replays the captured
                      // native PWA prompt on Chromium or shows per-platform steps
                      // elsewhere (see InstallDialog).
                      openInstall();
                    }}
                  >
                    Install app
                  </MenuItem>
                )}
              </>
            )}
          </Menu>

          <span className={styles.sep} aria-hidden="true" />

          <IconButton label="Undo" onClick={undo} disabled={!canUndo} size={iconSize}>
            <UndoIcon />
          </IconButton>
          <IconButton label="Redo" onClick={redo} disabled={!canRedo} size={iconSize}>
            <RedoIcon />
          </IconButton>

          <span className={styles.sep} aria-hidden="true" />

          {isUpdate ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={<SendIcon />}
                collapseLabel
                onClick={onSend}
                title="Post a separate new copy instead of updating"
              >
                New
              </Button>
              <Button
                // Stable anchor for the post-setup coach-mark (see SendCoachMark).
                id="builder-send-action"
                variant="primary"
                size="sm"
                leadingIcon={<PencilIcon />}
                onClick={onUpdate}
                aria-label="Update"
                title="Update the message you last posted or restored"
              >
                {/* Dropped last — only once folding every utility icon still
                    isn't enough to keep the bar on one row (see `level`). */}
                {primaryIconOnly ? null : "Update"}
              </Button>
            </>
          ) : (
            <Button
              id="builder-send-action"
              variant="primary"
              size="sm"
              leadingIcon={<SendIcon />}
              onClick={onSend}
              aria-label="Send"
              title="Post this message to your Discord webhook"
            >
              {primaryIconOnly ? null : "Send"}
            </Button>
          )}
        </div>
      </div>

      <SaveMessageDialog open={saveOpen} onClose={() => setSaveOpen(false)} />
    </>
  );
}
