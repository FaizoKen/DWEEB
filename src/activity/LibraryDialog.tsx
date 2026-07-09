/**
 * "Message directory" dialog — the embedded surface's entry into the server's
 * message library.
 *
 * The web app has a full-screen gallery (templates + local saves + the shared
 * library); inside Discord the same shelf matters even more, because the
 * Activity has no browser-local history of its own — everything posted or
 * saved for this server lives on the proxy. This dialog lists that shelf:
 * pick an entry and it loads into the shared editor for the whole room, with
 * posted entries re-wired for update-in-place (see
 * `activityStore.loadLibraryEntry`). A "start blank" action rounds it out.
 */

import { useEffect } from "react";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { pushToast } from "@/ui/Toast";
import { PlusIcon } from "@/ui/Icon";
import { useActivityStore } from "@/core/activity/activityStore";
import { useMessageStore } from "@/core/state/messageStore";
import { useLibraryStore } from "@/core/library/libraryStore";
import type { LibraryEntryView } from "@/core/library/api";
import { ServerGlyph } from "./GuildPicker";
import styles from "./LibraryDialog.module.css";

/** Compact "2m ago" / "3d ago" stamp (input: unix seconds). */
function formatRelative(unixSecs: number): string {
  const minutes = Math.round((Date.now() - unixSecs * 1000) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(unixSecs * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function LibraryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const targetGuildId = useActivityStore((s) => s.targetGuildId);
  const targetGuildMeta = useActivityStore((s) => s.targetGuildMeta);
  const loadEntry = useActivityStore((s) => s.loadLibraryEntry);
  const clearAll = useMessageStore((s) => s.clearAll);

  const entries = useLibraryStore((s) => s.entries);
  const libGuild = useLibraryStore((s) => s.guildId);
  const loading = useLibraryStore((s) => s.loading);
  const loaded = useLibraryStore((s) => s.loaded);
  const posted = useLibraryStore((s) => s.posted);
  const drafts = useLibraryStore((s) => s.drafts);

  // (Re)load the target server's shelf each time the dialog opens — posts from
  // teammates or the web app should show up without a relaunch.
  useEffect(() => {
    if (open && targetGuildId) void useLibraryStore.getState().refresh(targetGuildId);
  }, [open, targetGuildId]);

  const ready = libGuild === targetGuildId && loaded;
  const items = libGuild === targetGuildId ? entries : [];

  const pick = (entry: LibraryEntryView) => {
    if (!loadEntry(entry)) {
      pushToast("This entry couldn't be read — it may predate a server key change.", "error");
      return;
    }
    onClose();
  };

  const startBlank = () => {
    clearAll();
    pushToast("Started a blank message", "info");
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Message directory"
      size="sm"
      footer={
        <>
          <span
            className={styles.meter}
            data-over={ready && drafts.quota != null && drafts.used > drafts.quota ? "" : undefined}
            title={
              ready && drafts.quota != null && drafts.used > drafts.quota
                ? "More saved messages than the plan allows — they stay readable, but their content can't be changed until the server deletes down to the limit or upgrades."
                : ready
                  ? "Posted messages sync automatically (the newest posts, oldest roll off); saved messages are kept until someone removes them."
                  : undefined
            }
          >
            {ready
              ? `Posted: last ${posted.used}${posted.quota != null ? ` of ${posted.quota}` : ""} · Saved: ${drafts.used}${
                  drafts.quota != null ? ` / ${drafts.quota}` : ""
                }${drafts.quota != null && drafts.used > drafts.quota ? " — over the plan limit" : ""}`
              : ""}
          </span>
          <Button variant="secondary" size="sm" leadingIcon={<PlusIcon />} onClick={startBlank}>
            Start blank
          </Button>
        </>
      }
    >
      {targetGuildMeta ? (
        <div
          className={styles.serverIdentity}
          title={`Message directory for ${targetGuildMeta.name}`}
        >
          <ServerGlyph guild={targetGuildMeta} size={28} />
          <span className={styles.serverIdentityText}>
            <span className={styles.serverIdentityLabel}>Discord server</span>
            <span className={styles.serverIdentityName}>{targetGuildMeta.name}</span>
          </span>
        </div>
      ) : null}
      <p className={styles.lead}>
        This server's latest posts sync here automatically and reload ready to{" "}
        <strong>update in place</strong>; saved messages load as a fresh start. Everyone who manages
        this server shares this list.
      </p>

      {!ready || (loading && items.length === 0) ? (
        <div className={styles.state}>Loading the server library…</div>
      ) : items.length === 0 ? (
        <div className={styles.state}>
          Nothing here yet. Post a message — it lands in the library automatically — or save a draft
          from DWEEB on the web.
        </div>
      ) : (
        <ul className={styles.list}>
          {items.map((entry) => (
            <li key={entry.id}>
              <button type="button" className={styles.row} onClick={() => pick(entry)}>
                <span className={styles.rowEmoji} aria-hidden>
                  {entry.label === "posted" ? "📤" : "🔖"}
                </span>
                <span className={styles.rowMain}>
                  <span className={styles.rowTitle}>
                    {entry.title?.trim() ||
                      entry.dest_label ||
                      (entry.label === "posted" ? "Posted message" : "Draft")}
                  </span>
                  <span className={styles.rowSub}>
                    {entry.label === "posted"
                      ? `Posted${entry.dest_label ? ` to ${entry.dest_label}` : ""}`
                      : "Draft"}
                    {" · "}
                    {formatRelative(entry.updated_at)}
                  </span>
                </span>
                <span className={styles.rowBadge} data-label={entry.label}>
                  {entry.label === "posted" ? "Posted" : "Draft"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
