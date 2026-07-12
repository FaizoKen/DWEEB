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

import { useLayoutEffect, useRef, useState } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { useGuildStore } from "@/core/guild/guildStore";
import { useAuthStore } from "@/core/auth/authStore";
import { usePlanStore } from "@/core/plan/planStore";
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
import { PlanBadge } from "@/features/plan/PlanBadge";
import { activityLaunchUrl, isProxyConfigured } from "@/core/guild/config";
import { isFeedbackConfigured } from "@/core/feedback/submit";
import { useFeedbackStore } from "@/features/feedback/feedbackStore";
import { useCollaborateStore } from "@/features/collaborate/collaborateStore";
import { useInstallStore } from "@/features/install/installStore";
import { useInstallState } from "@/features/install/useInstallState";
import { useWelcomeStore } from "@/features/welcome/welcomeStore";
import styles from "./Builder.module.css";

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
  // A restore origin is set after restoring a message, or after a successful
  // send re-targets the form at the now-live message. The primary action then
  // reads "Update" and opens the dedicated Update tab (edit in place), with a
  // secondary "New" alongside for posting a separate copy — mirroring the
  // Activity bar's New/Update pair. With no origin the primary is "Send".
  const isUpdate = useMessageStore((s) => s.restoredFrom != null);

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

  // The save dialog behind the bar's save icon (see SaveMessageDialog).
  const [saveOpen, setSaveOpen] = useState(false);

  // Real-time co-editing lives only in the embedded Discord Activity; offer a
  // hand-off to it when a backend + app id are configured (both are required for
  // the Activity to function). Empty string ⇒ the entry point is hidden.
  const collaborateUrl = isProxyConfigured() ? activityLaunchUrl() : "";

  const barRef = useRef<HTMLDivElement>(null);
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
  // flip (Send↔Update revealing New, the plan pill appearing, feedback
  // toggling) re-runs the fit measurement below — not just a raw width change.
  const layoutKey = `${isUpdate}|${planVisible}|${feedbackOn}`;

  // On every width or content change, optimistically restore the full row…
  useLayoutEffect(() => {
    setCompact(0);
  }, [barWidth, layoutKey]);

  // …then collapse one stage at a time until the two control groups fit side by
  // side on one row. Each group keeps its natural width, so summing them (plus
  // the gap between and the bar's padding) tells us what a single row needs —
  // more reliable than `scrollWidth`, which `justify-content: space-between`
  // leaves unchanged when items overflow. Each pass runs before paint, so the
  // staged collapse never flashes.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || compact >= 2) return;
    const cs = getComputedStyle(bar);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const gap = parseFloat(cs.columnGap) || 0;
    const groups = Array.from(bar.children) as HTMLElement[];
    const needed =
      groups.reduce((sum, g) => sum + g.getBoundingClientRect().width, 0) +
      gap * Math.max(0, groups.length - 1) +
      padX;
    if (needed > bar.clientWidth + 1) setCompact((c) => c + 1);
  }, [compact, barWidth, layoutKey]);

  // Undo/redo (and the overflow trigger) tighten to the small control size when
  // compact so the row keeps breathing room; full size on wider bars.
  const iconSize = compact >= 1 ? ("sm" as const) : ("md" as const);

  return (
    <>
      <div ref={barRef} className={styles.actionBar} data-compact={compact >= 1 ? "" : undefined}>
        {/* Left corner — who you are and which server is connected (the web's
            counterpart of the Activity bar's destination cluster). The actual
            post destination is chosen in the Send dialog, where webhooks and
            identities live. */}
        <div className={styles.actionGroup}>{isProxyConfigured() ? <AccountMenu /> : null}</div>

        <div className={styles.actionGroup}>
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
