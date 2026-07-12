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

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  DownloadIcon,
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
  UploadIcon,
  UsersIcon,
} from "@/ui/Icon";
import { Menu, MenuItem, MenuDivider } from "@/ui/Menu";
import { ComponentTree } from "./components/ComponentTree";
import { SaveMessageDialog } from "./components/SaveMessageDialog";
import { AccountMenu } from "@/features/guild/AccountMenu";
import { ChannelPicker } from "@/features/guild/ChannelPicker";
import { PlanBadge } from "@/features/plan/PlanBadge";
import { activityLaunchUrl, isProxyConfigured } from "@/core/guild/config";
import { isFeedbackConfigured } from "@/core/feedback/submit";
import { useFeedbackStore } from "@/features/feedback/feedbackStore";
import { useCollaborateStore } from "@/features/collaborate/collaborateStore";
import { useInstallStore } from "@/features/install/installStore";
import { useInstallState } from "@/features/install/useInstallState";
import { useWelcomeStore } from "@/features/welcome/welcomeStore";
import styles from "./Builder.module.css";

/** Space (px) the left cluster (account control + destination chip) needs to
 *  stay readable. The fit check collapses the right-side actions into the More
 *  menu once they'd squeeze the destination below this — so a long channel
 *  name truncates gracefully instead of the whole row overflowing. Mirrors the
 *  Activity bar's constant. */
const LEFT_MIN_WIDTH = 150;

interface BuilderProps {
  /** Opens the Share / Export dialog on the Share-link tab. */
  onShare: () => void;
  /** Opens the Share / Export dialog on the JSON export tab. */
  onExport: () => void;
  /** Opens the Share / Export dialog on the Import tab. */
  onImport: () => void;
  /** Opens the Share / Export dialog focused on the Send panel (post as new). */
  onSend: () => void;
  /** Opens the Share / Export dialog on the Update tab (edit in place). */
  onUpdate: () => void;
  /** Opens the Share / Export dialog focused on the Restore panel. */
  onRestore: () => void;
  /** Opens the Share / Export dialog focused on the About panel. */
  onAbout: () => void;
}

export function Builder({
  onShare,
  onExport,
  onImport,
  onSend,
  onUpdate,
  onRestore,
  onAbout,
}: BuilderProps) {
  return (
    <div className={styles.builder}>
      {/* ActionBar occupies the grid's first (auto) row; the tree fills the 1fr
          row below. The posted-message link indicator lives inside the tree's
          scroll area (see ComponentTree) so it scrolls with the content instead
          of pinning to the top. */}
      <div className={styles.header}>
        <ActionBar
          onShare={onShare}
          onExport={onExport}
          onImport={onImport}
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

function ActionBar({
  onShare,
  onExport,
  onImport,
  onSend,
  onUpdate,
  onRestore,
  onAbout,
}: BuilderProps) {
  const undo = useMessageStore((s) => s.undo);
  const redo = useMessageStore((s) => s.redo);
  const canUndo = useMessageStore((s) => s.past.length > 0);
  const canRedo = useMessageStore((s) => s.future.length > 0);
  const clearAll = useMessageStore((s) => s.clearAll);
  const restoredFrom = useMessageStore((s) => s.restoredFrom);

  const openFeedback = useFeedbackStore((s) => s.openFeedback);
  const feedbackOn = isFeedbackConfigured();
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
  // separate copy — mirroring the Activity bar's New/Update pair. And like the
  // Activity, "Update" only holds while the destination still points at the
  // linked message's channel: re-pointing the chip elsewhere flips the primary
  // back to "Send" (a new post there), which is why the old banner's "Detach"
  // button isn't needed. When either channel is unknown (signed out, a pasted
  // URL with no saved entry), the link alone decides — the old behaviour.
  const isUpdate =
    restoredFrom != null &&
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

  const barRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  // The action bar always stays on a single row. As its available width shrinks
  // — a narrow builder pane on desktop, or a phone — its controls collapse in
  // stages rather than wrapping onto a second line:
  //   0 — everything inline: the utility icon cluster, full-size undo/redo,
  //       and the labelled primary
  //   1 — the utility icons fold into the "More" overflow menu, undo/redo and
  //       the overflow trigger tighten to small, the secondary "New" drops its
  //       label (via the `data-compact` flag its CSS keys off), and the cluster
  //       dividers disappear
  //   2 — the primary Send/Update button also drops to its icon
  // We measure the real control widths instead of guessing a breakpoint, so the
  // full row survives on any width — viewport *or* pane — that has room for it.
  // Mirrors the Activity bar's own fit check (see ActivityBar).
  const [compact, setCompact] = useState(0);
  // Bumped by the ResizeObserver below whenever the bar's *width* changes; drives
  // a fresh measurement pass. (Width only — collapsing changes the bar's content,
  // not its width, so this never feeds back on itself.)
  const [barWidth, setBarWidth] = useState(0);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const ro = new ResizeObserver(() => setBarWidth(bar.clientWidth));
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);

  // A signature of everything that changes the *inline* bar's width, so a state
  // flip (Send↔Update revealing New, the plan pill or destination chip
  // appearing, feedback toggling) re-runs the fit measurement below — not just
  // a raw width change.
  const layoutKey = `${isUpdate}|${planVisible}|${feedbackOn}|${destActive}`;

  // On every width or content change, optimistically restore the full row…
  useLayoutEffect(() => {
    setCompact(0);
  }, [barWidth, layoutKey]);

  // …then collapse one stage at a time until both clusters fit on one row. The
  // right cluster is `flex: none`, so its box width *is* its natural width; the
  // left (account + destination chip) is allowed to truncate, so we reserve a
  // readable minimum for it rather than its content width — mirroring the
  // Activity bar's fit check. Each pass runs before paint, so the staged
  // collapse never flashes.
  useLayoutEffect(() => {
    const bar = barRef.current;
    const left = leftRef.current;
    const right = rightRef.current;
    if (!bar || !left || !right || compact >= 2) return;
    const cs = getComputedStyle(bar);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const gap = parseFloat(cs.columnGap) || 0;
    // Without the destination chip the left side is just the fixed-size account
    // control — reserve what it actually takes, not the chip minimum.
    const reserve = destActive ? LEFT_MIN_WIDTH : left.getBoundingClientRect().width;
    const needed = right.getBoundingClientRect().width + reserve + gap + padX;
    if (needed > bar.clientWidth + 1) setCompact((c) => c + 1);
  }, [compact, barWidth, layoutKey, destActive]);

  // Undo/redo (and the overflow trigger) tighten to the small control size when
  // compact so the row keeps breathing room; full size on wider bars.
  const iconSize = compact >= 1 ? ("sm" as const) : ("md" as const);

  return (
    <>
      <div ref={barRef} className={styles.actionBar} data-compact={compact >= 1 ? "" : undefined}>
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
              icons on a wide bar; folded into the "More" overflow below when
              the bar can't fit every control at full size (`compact`). */}
          {compact < 1 ? (
            <>
              <IconButton
                label="Save the current message as a draft"
                onClick={() => setSaveOpen(true)}
              >
                <SaveIcon />
              </IconButton>
              <IconButton
                label="Message directory — saved messages, posted history, and templates"
                onClick={() => openGallery()}
              >
                <BookmarkIcon />
              </IconButton>
              <IconButton
                label="Restore a message your webhook previously posted"
                onClick={onRestore}
              >
                <HistoryIcon />
              </IconButton>
              <IconButton label="Share this message as a link" onClick={onShare}>
                <ShareIcon />
              </IconButton>
              {feedbackOn ? (
                <IconButton label="Send feedback" onClick={openFeedback}>
                  <SupportIcon />
                </IconButton>
              ) : null}
            </>
          ) : null}

          {/* The overflow menu: the long tail of occasional actions, plus —
              when compact — the utility icons folded in above them. */}
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
                {compact >= 1 ? (
                  <>
                    <MenuItem
                      icon={<SaveIcon />}
                      onSelect={() => {
                        close();
                        setSaveOpen(true);
                      }}
                    >
                      Save current message
                    </MenuItem>
                    <MenuItem
                      icon={<BookmarkIcon />}
                      onSelect={() => {
                        close();
                        openGallery();
                      }}
                    >
                      Message directory
                    </MenuItem>
                    <MenuItem
                      icon={<HistoryIcon />}
                      onSelect={() => {
                        close();
                        onRestore();
                      }}
                    >
                      Restore a message
                    </MenuItem>
                    <MenuItem
                      icon={<ShareIcon />}
                      onSelect={() => {
                        close();
                        onShare();
                      }}
                    >
                      Share link
                    </MenuItem>
                    {feedbackOn ? (
                      <MenuItem
                        icon={<SupportIcon />}
                        onSelect={() => {
                          close();
                          openFeedback();
                        }}
                      >
                        Send feedback
                      </MenuItem>
                    ) : null}
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
                  icon={<DownloadIcon />}
                  onSelect={() => {
                    close();
                    onExport();
                  }}
                >
                  Export JSON
                </MenuItem>
                <MenuItem
                  icon={<UploadIcon />}
                  onSelect={() => {
                    close();
                    onImport();
                  }}
                >
                  Import…
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
                {/* Dropped last — only once folding the utility icons still
                    isn't enough to keep the bar on one row (see `compact`). */}
                {compact >= 2 ? null : "Update"}
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
              {compact >= 2 ? null : "Send"}
            </Button>
          )}
        </div>
      </div>

      <SaveMessageDialog open={saveOpen} onClose={() => setSaveOpen(false)} />
    </>
  );
}
