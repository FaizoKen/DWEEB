/**
 * The web bar's Tools menu: what you can do with a message once it's built, and
 * what else DWEEB offers. It replaced a "…" overflow whose rows were a bare list
 * of names, so someone who did open it learned little about what they'd found.
 *
 * A row here says what it's for in a line of its own, and the rows are grouped
 * by the job. Features get a description; housekeeping (feedback, about, clear)
 * doesn't, which is what makes the features stand out. Keep the descriptions
 * true to what the feature's own dialog promises, and short enough for one line
 * at this width.
 *
 * Two columns on anything wider than a phone: at one, the whole list ran past
 * the fold of a 768px-tall laptop, and a feature you have to scroll a menu to
 * find is half hidden again. The rows stay one list to the keyboard, in reading
 * order, left column first.
 *
 * Above the groups go whatever bar controls the fit check folded away.
 */

import { type ComponentType } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { useFeedbackConfigured } from "@/core/feedback/submit";
import { activityLaunchUrl, isProxyConfigured } from "@/core/guild/config";
import { useMcpConfigured } from "@/core/mcp/availability";
import { trackAnalytics } from "@/core/telemetry/analytics";
import { toastWithUndo } from "@/features/builder/undoToast";
import { useCollaborateStore } from "@/features/collaborate/collaborateStore";
import { useFeedbackStore } from "@/features/feedback/feedbackStore";
import { useInstallStore } from "@/features/install/installStore";
import { useInstallState } from "@/features/install/useInstallState";
import { useMcpStore } from "@/features/mcp/mcpStore";
import { ToolsButton } from "@/features/tools/ToolsButton";
import { useToolsUnseen } from "@/features/tools/toolsSeen";
import { useWelcomeStore } from "@/features/welcome/welcomeStore";
import {
  BracesIcon,
  ClockIcon,
  CodeIcon,
  CompassIcon,
  ExternalLinkIcon,
  FilmIcon,
  InfoIcon,
  InstallIcon,
  ShareIcon,
  SparkleIcon,
  SupportIcon,
  TrashIcon,
  UsersIcon,
} from "@/ui/Icon";
import { Menu, MenuDivider, MenuItem, MenuLabel } from "@/ui/Menu";
import styles from "./ToolsMenu.module.css";

/** A bar control the fit check moved into this menu. */
export interface FoldedAction {
  key: string;
  icon: ComponentType<{ size?: number }>;
  menuLabel: string;
  run: () => void;
}

interface ToolsMenuProps {
  /** Whether the trigger keeps its word (the fit check's call). */
  labelled: boolean;
  /** Utility icons the bar has no room for. */
  folded: readonly FoldedAction[];
  /** Opens the linked message in Discord, once "View" has folded in here. */
  onViewPosted: (() => void) | null;
  onShare: () => void;
  onSchedule: () => void;
  onCode: () => void;
  onJson: () => void;
  onAbout: () => void;
}

export function ToolsMenu({
  labelled,
  folded,
  onViewPosted,
  onShare,
  onSchedule,
  onCode,
  onJson,
  onAbout,
}: ToolsMenuProps) {
  const clearAll = useMessageStore((s) => s.clearAll);
  const openFeedback = useFeedbackStore((s) => s.openFeedback);
  const feedbackOn = useFeedbackConfigured();
  const openCollaborate = useCollaborateStore((s) => s.openCollaborate);
  const openInstall = useInstallStore((s) => s.openInstall);
  const openMcp = useMcpStore((s) => s.openMcp);
  // The connector is per-deployment (the endpoint is off by default), so its row
  // only appears once the proxy confirms it serves one: offering a URL that
  // answers 501 would send someone through a setup that cannot work.
  const mcpOn = useMcpConfigured();
  // Nothing left to install once we're running as the installed app. Every other
  // browser keeps the row: the dialog replays the native prompt or shows steps.
  const { installed } = useInstallState();
  // Real-time co-editing lives only in the embedded Discord Activity, so this
  // row needs a backend and an app id. Empty string ⇒ hidden.
  const collaborateUrl = isProxyConfigured() ? activityLaunchUrl() : "";

  const [unseen, markSeen] = useToolsUnseen();

  return (
    <Menu
      align="end"
      className={styles.panel}
      onOpen={() => {
        markSeen();
        trackAnalytics("tools_opened");
      }}
      trigger={
        <ToolsButton
          labelled={labelled}
          unseen={unseen}
          hint="Tools: share, schedule, export and more"
        />
      }
    >
      {(close) => {
        // `tool` is a fixed slug, so the menu's use can be read per row without
        // anything about the message leaving the page.
        const pick = (tool: string, run: () => void) => () => {
          close();
          trackAnalytics("tools_used", { tool });
          run();
        };
        return (
          <>
            {onViewPosted || folded.length > 0 ? (
              <>
                {/* The update state's "View" comes first, above the folded
                    utility icons: the tightest bars keep only the destination,
                    undo/redo and the primary action inline. */}
                <div className={styles.folded}>
                  {onViewPosted ? (
                    <MenuItem
                      icon={<ExternalLinkIcon />}
                      onSelect={() => {
                        close();
                        onViewPosted();
                      }}
                    >
                      View posted message
                    </MenuItem>
                  ) : null}
                  {folded.map((action) => (
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
                </div>
                <MenuDivider />
              </>
            ) : null}

            <div className={styles.columns}>
              <div className={styles.column}>
                <MenuLabel>Share &amp; publish</MenuLabel>
                <MenuItem
                  icon={<ShareIcon />}
                  description="Send anyone an editable copy"
                  onSelect={pick("share_link", onShare)}
                >
                  Share link
                </MenuItem>
                {collaborateUrl ? (
                  <MenuItem
                    icon={<UsersIcon />}
                    description="Build this message together, live"
                    // Mints a Discord Activity invite for a channel so the whole
                    // group lands in one shared instance. A bare launcher link
                    // only ever opens a solo call (see CollaborateDialog).
                    onSelect={pick("collaborate", openCollaborate)}
                  >
                    Collaborate in Discord
                  </MenuItem>
                ) : null}
                <MenuItem
                  icon={<ClockIcon />}
                  description="Post at a set time, once or on repeat"
                  onSelect={pick("schedule", onSchedule)}
                >
                  Schedule a post
                </MenuItem>

                <MenuLabel>For developers</MenuLabel>
                <MenuItem
                  icon={<CodeIcon />}
                  description="discord.js, discord.py, cURL, fetch, Python"
                  onSelect={pick("code", onCode)}
                >
                  Export as code
                </MenuItem>
                <MenuItem
                  icon={<BracesIcon />}
                  description="Copy the payload, or paste one in"
                  onSelect={pick("json", onJson)}
                >
                  Import / export JSON
                </MenuItem>
              </div>

              <div className={styles.column}>
                <MenuLabel>Get more from DWEEB</MenuLabel>
                {mcpOn ? (
                  <MenuItem
                    icon={<SparkleIcon />}
                    description="Have Claude build and post for you"
                    // Hands over the hosted connector URL and the steps that add
                    // it to an AI client (see ConnectAiDialog).
                    onSelect={pick("ai_client", openMcp)}
                  >
                    Connect an AI client
                  </MenuItem>
                ) : null}
                {installed ? null : (
                  <MenuItem
                    icon={<InstallIcon />}
                    description="Add DWEEB to your desktop or phone"
                    // Replays the captured native PWA prompt on Chromium, or shows
                    // per-platform steps elsewhere (see InstallDialog).
                    onSelect={pick("install", openInstall)}
                  >
                    Install app
                  </MenuItem>
                )}
                <MenuItem
                  icon={<FilmIcon />}
                  description="See how DWEEB works in a minute"
                  // Always available, so closing the film on a first visit is
                  // never a one-way door.
                  onSelect={pick("intro", () => useWelcomeStore.getState().openWelcome())}
                >
                  Watch the intro
                </MenuItem>
                <MenuItem
                  icon={<CompassIcon />}
                  description="Plugins, polls, tickets and more"
                  trailing={<ExternalLinkIcon size={13} />}
                  // These rows are what a menu can reach; plugins live on the
                  // buttons they power, so the catalogue is what introduces them.
                  // A new tab, since the editor may hold unsent work.
                  onSelect={pick("all_features", () => {
                    window.open("/features/", "_blank", "noopener");
                  })}
                >
                  See all features
                </MenuItem>

                <MenuDivider />
                {feedbackOn ? (
                  <MenuItem icon={<SupportIcon />} onSelect={pick("feedback", openFeedback)}>
                    Send feedback
                  </MenuItem>
                ) : null}
                <MenuItem icon={<InfoIcon />} onSelect={pick("about", onAbout)}>
                  About
                </MenuItem>
              </div>
            </div>

            {/* The one destructive row sits in a group of its own, last, so it's
                never a slip away from an export or from "Send feedback". */}
            <MenuDivider />
            <MenuItem
              icon={<TrashIcon />}
              onSelect={pick("clear", () => {
                // One click wipes the draft and every message-level option; the
                // toast's Undo is the acknowledgement that it's recoverable.
                const before = useMessageStore.getState().message;
                clearAll();
                toastWithUndo("Message cleared", before);
              })}
            >
              Clear current message
            </MenuItem>
          </>
        );
      }}
    </Menu>
  );
}
