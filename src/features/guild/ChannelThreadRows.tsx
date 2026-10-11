/**
 * The parts of the toolbar's channel picker that deal with threads, loaded on
 * demand (see `ChannelPicker`): a channel's thread / forum-post rows, and a
 * resolver that names a picked thread which arrived without one.
 */

import { useEffect, useState } from "react";
import type { GuildChannel } from "@/core/guild/types";
import type { ChannelThread } from "@/core/guild/api";
import { useChannelThreads } from "@/core/webhook/channelThreads";
import { ChannelTypeIcon, CheckCircleIcon, ThreadIcon } from "@/ui/Icon";
import styles from "./ChannelPicker.module.css";

/** Forum and media channels: every message lives in a post. */
const FORUM_TYPES = new Set([15, 16]);
/** Threads shown under a channel before "Show more". */
const THREAD_PAGE = 15;

/** Looks up a picked thread's name in its channel's list and reports it once
 *  found. Renders nothing. */
export function ThreadNameResolver({
  guildId,
  channelId,
  threadId,
  onName,
}: {
  guildId: string;
  channelId: string;
  threadId: string;
  onName: (name: string) => void;
}) {
  const { entry } = useChannelThreads(guildId, channelId, true);
  const name = entry.threads.find((t) => t.id === threadId)?.name;
  useEffect(() => {
    if (name) onName(name);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- report each name once; onName is a fresh closure per render
  }, [name]);
  return null;
}

/**
 * One channel's threads, nested under it in the picker. A forum leads with
 * "New post" (the channel itself — the message's post title starts a post).
 * `selectedThreadId`: the picked thread when this is the selected channel
 * (null = the channel itself), undefined for any other channel.
 */
export function ChannelThreadRows({
  guildId,
  channel,
  selectedThreadId,
  query,
  onPick,
}: {
  guildId: string;
  channel: GuildChannel;
  selectedThreadId: string | null | undefined;
  query: string;
  onPick: (thread: ChannelThread | null) => void;
}) {
  const { entry } = useChannelThreads(guildId, channel.id, true);
  const [limit, setLimit] = useState(THREAD_PAGE);
  const forum = FORUM_TYPES.has(channel.type);
  const noun = forum ? "posts" : "threads";
  // Searching by the channel's own name shows all its threads; otherwise the
  // query narrows the threads themselves.
  const list =
    query && !channel.name.toLowerCase().includes(query)
      ? entry.threads.filter((t) => t.name.toLowerCase().includes(query))
      : entry.threads;
  const shown = list.slice(0, limit);

  return (
    <ul className={styles.threads}>
      {forum && !query ? (
        <li>
          <button
            type="button"
            role="option"
            aria-selected={selectedThreadId === null}
            className={`${styles.row} ${styles.threadRow}`}
            data-active={selectedThreadId === null ? "" : undefined}
            onClick={() => onPick(null)}
          >
            <ChannelTypeIcon type={channel.type} size={14} className={styles.rowHash} />
            <span className={styles.rowName}>New post</span>
            {selectedThreadId === null ? (
              <CheckCircleIcon size={14} className={styles.check} />
            ) : null}
          </button>
        </li>
      ) : null}
      {shown.map((t) => {
        const active = t.id === selectedThreadId;
        return (
          <li key={t.id}>
            <button
              type="button"
              role="option"
              aria-selected={active}
              className={`${styles.row} ${styles.threadRow}`}
              data-active={active ? "" : undefined}
              onClick={() => onPick(t)}
              title={
                t.locked
                  ? "Locked — Discord may refuse new posts here."
                  : t.archived
                    ? "Closed — posting here reopens it."
                    : undefined
              }
            >
              <ThreadIcon size={14} className={styles.rowHash} />
              <span className={styles.rowName}>{t.name || `Thread ${t.id}`}</span>
              {t.pinned ? <span className={styles.threadTag}>Pinned</span> : null}
              {t.locked ? (
                <span className={styles.threadTag}>Locked</span>
              ) : t.archived ? (
                <span className={styles.threadTag}>{forum ? "Closed" : "Archived"}</span>
              ) : null}
              {active ? <CheckCircleIcon size={14} className={styles.check} /> : null}
            </button>
          </li>
        );
      })}
      {list.length > shown.length ? (
        <li>
          <button
            type="button"
            className={styles.threadMore}
            onClick={() => setLimit((n) => n + THREAD_PAGE * 4)}
          >
            Show {list.length - shown.length} more
          </button>
        </li>
      ) : null}
      {entry.status === "loading" && entry.threads.length === 0 ? (
        <li className={styles.threadNote}>Loading {noun}…</li>
      ) : null}
      {entry.status === "ready" && entry.threads.length === 0 ? (
        <li className={styles.threadNote}>No {noun} yet.</li>
      ) : null}
      {entry.status === "ready" && entry.threads.length > 0 && query && list.length === 0 ? (
        <li className={styles.threadNote}>No {noun} match.</li>
      ) : null}
      {entry.status === "error" || entry.status === "denied" ? (
        <li className={styles.threadNote}>Couldn't load {noun}.</li>
      ) : null}
    </ul>
  );
}
