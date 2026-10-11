/**
 * Where inside the destination channel a post goes: the channel itself, an
 * existing thread / forum post, or (in a forum) a brand-new post.
 *
 * Until this, posting into a thread meant pasting its ID — copied from
 * Discord's "Copy Thread ID", which only shows with Developer Mode on — and a
 * forum channel's existing posts were invisible in DWEEB. Now, whenever the
 * webhook's channel is known and the signed-in user manages that server's
 * webhooks, its threads are listed (open ones first, then recently closed
 * ones) and picking one is a click. The ID field stays, folded behind
 * "Enter a thread ID or link", for anything the list can't show: private
 * threads, older closed ones, a webhook from a server this account can't read.
 */

import { useEffect, useState } from "react";
import type { ChannelThread } from "@/core/guild/api";
import { useChannelThreads } from "@/core/webhook/channelThreads";
import { threadIdFromInput } from "@/core/webhook/threadInput";
import { Field } from "@/ui/Field";
import { TextInput } from "@/ui/TextInput";
import { ChannelTypeIcon, CheckCircleIcon, RefreshIcon, SearchIcon } from "@/ui/Icon";
import { cn } from "@/lib/cn";
import { useUniqueId } from "@/lib/useUniqueId";
import { THREAD_SEARCH_THRESHOLD, filterThreads, isForumType, threadTags } from "./threadSelection";
import styles from "./ThreadPicker.module.css";

export interface ThreadPickerProps {
  /** Server + channel the webhook posts in; the list loads only with both. */
  guildId: string | null;
  channelId: string | null;
  channelName?: string;
  /** The channel's type when already known locally (the connected server's
   *  channel list); the proxy's answer fills it in otherwise. */
  channelType?: number;
  /** Whether this account may list the channel's threads (signed in, manages
   *  the server's webhooks). False keeps just the ID field. */
  canList: boolean;
  mode: "new" | "update";
  value: string;
  onChange: (threadId: string) => void;
  /** The message's forum post title (`thread_name`), for the "New post" row. */
  postTitle: string;
  /** Take the user to the post-title field (closes the dialog). */
  onAddPostTitle?: () => void;
}

export function ThreadPicker({
  guildId,
  channelId,
  channelName,
  channelType: localType,
  canList,
  mode,
  value,
  onChange,
  postTitle,
  onAddPostTitle,
}: ThreadPickerProps) {
  const listing = canList && guildId != null && channelId != null;
  const { entry, refresh } = useChannelThreads(guildId, channelId, listing);
  const channelType = localType ?? entry.channelType ?? undefined;
  const forum = isForumType(channelType);

  const [query, setQuery] = useState("");
  const threads = entry.threads;
  const listed = threads.some((t) => t.id === value);
  const ready = entry.status === "ready" || (entry.status === "loading" && threads.length > 0);
  // A thread id the list doesn't show (typed, from a restored message, or an
  // older/private thread) opens the ID field so the value is never hidden.
  const settled = entry.status !== "idle" && entry.status !== "loading";
  const unlisted = value !== "" && !(listing && (listed || !settled));
  const [manualOpen, setManualOpen] = useState(unlisted);
  useEffect(() => {
    if (unlisted) setManualOpen(true);
  }, [unlisted]);

  const visible = filterThreads(threads, query);
  const where = channelName ? `#${channelName}` : "this channel";
  const titleId = useUniqueId("thread-picker");

  const manualField = (
    <Field
      label={forum ? "Post ID or link" : "Thread ID or link"}
      hint={
        <>
          In Discord, right-click the {forum ? "post" : "thread"} → <strong>Copy Link</strong> and
          paste it here. (With Developer Mode on, “Copy Thread ID” works too.)
        </>
      }
    >
      {(id) => (
        <TextInput
          id={id}
          value={value}
          onChange={(e) => onChange(threadIdFromInput(e.currentTarget.value))}
          placeholder="e.g. 1185234567890123456  ·  or  https://discord.com/channels/…"
          inputMode="url"
          spellCheck={false}
        />
      )}
    </Field>
  );

  if (!listing) return manualField;

  const rootLabel = forum ? "New post" : `${where} itself`;
  const rootDetail = forum
    ? postTitle.trim()
      ? `Starts a post titled “${postTitle.trim()}”.`
      : "Needs a post title — add one in Message options."
    : "Not in a thread.";
  // An update edits a message that already lives somewhere; in a forum that is
  // always a post, so "New post" means nothing there.
  const showRoot = !(forum && mode === "update");

  return (
    <div className={styles.picker}>
      <div className={styles.head}>
        <span className={styles.title} id={titleId}>
          {mode === "update"
            ? forum
              ? "The post the message is in"
              : "Where the message is"
            : forum
              ? `Post in ${where}`
              : `Post in ${where} or a thread`}
          {threads.length > 0 ? <span className={styles.count}> · {threads.length}</span> : null}
        </span>
        <button
          type="button"
          className={styles.refresh}
          onClick={refresh}
          disabled={entry.status === "loading"}
          aria-label={forum ? "Reload posts" : "Reload threads"}
          title={forum ? "Reload posts" : "Reload threads"}
        >
          <RefreshIcon size={13} />
        </button>
      </div>

      {threads.length >= THREAD_SEARCH_THRESHOLD ? (
        <div className={styles.search}>
          <SearchIcon size={14} className={styles.searchIcon} />
          <input
            className={styles.searchInput}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder={forum ? "Search posts…" : "Search threads…"}
            aria-label={forum ? "Search posts" : "Search threads"}
          />
        </div>
      ) : null}

      <ul className={styles.list} aria-labelledby={titleId}>
        {showRoot && !query.trim() ? (
          <li>
            <button
              type="button"
              className={cn(styles.row, value === "" && styles.rowActive)}
              aria-pressed={value === ""}
              onClick={() => onChange("")}
            >
              <span className={styles.icon} aria-hidden>
                <ChannelTypeIcon type={channelType ?? 0} size={15} />
              </span>
              <span className={styles.text}>
                <span className={styles.name}>{rootLabel}</span>
                <span
                  className={cn(
                    styles.detail,
                    forum && !postTitle.trim() && value === "" && styles.detailWarn,
                  )}
                >
                  {rootDetail}
                </span>
              </span>
              {value === "" ? <CheckCircleIcon size={16} className={styles.check} /> : null}
            </button>
            {forum && !postTitle.trim() && value === "" && onAddPostTitle ? (
              <button type="button" className={styles.inlineAction} onClick={onAddPostTitle}>
                Add a post title
              </button>
            ) : null}
          </li>
        ) : null}
        {unlisted && !query.trim() ? (
          <li>
            <button
              type="button"
              className={cn(styles.row, styles.rowActive)}
              aria-pressed
              onClick={() => setManualOpen(true)}
            >
              <span className={styles.icon} aria-hidden>
                <ChannelTypeIcon type={11} size={15} />
              </span>
              <span className={styles.text}>
                <span className={styles.name}>
                  {forum ? "Post" : "Thread"} {value}
                </span>
                <span className={styles.detail}>
                  Entered by ID — not in this list (private, older, or not loaded yet).
                </span>
              </span>
              <CheckCircleIcon size={16} className={styles.check} />
            </button>
          </li>
        ) : null}
        {visible.map((t) => (
          <ThreadRow
            key={t.id}
            thread={t}
            forum={forum}
            active={t.id === value}
            onPick={() => onChange(t.id)}
          />
        ))}
      </ul>

      {entry.status === "loading" && threads.length === 0 ? (
        <p className={styles.note}>Loading {forum ? "posts" : "threads"}…</p>
      ) : null}
      {ready && threads.length === 0 ? (
        <p className={styles.note}>
          {forum ? `No posts in ${where} yet.` : `No threads in ${where} yet.`}
        </p>
      ) : null}
      {ready && query.trim() && visible.length === 0 ? (
        <p className={styles.note}>Nothing matches that search.</p>
      ) : null}
      {entry.status === "ready" && entry.moreArchived ? (
        <p className={styles.note}>
          Only the most recently closed {forum ? "posts" : "threads"} are listed — for an older one,
          enter its ID or link below.
        </p>
      ) : null}
      {entry.status === "ready" && !entry.archivedListed ? (
        <p className={styles.note}>
          Closed {forum ? "posts" : "threads"} couldn't be listed here, so only open ones are shown.
        </p>
      ) : null}
      {entry.status === "error" || entry.status === "denied" ? (
        <p className={cn(styles.note, styles.noteError)} role="status">
          {entry.status === "denied"
            ? `Couldn't list ${forum ? "posts" : "threads"}: ${entry.error ?? "no access."}`
            : `Couldn't load ${forum ? "posts" : "threads"}. ${entry.error ?? ""}`}{" "}
          {entry.status === "error" ? (
            <button type="button" className={styles.linkBtn} onClick={refresh}>
              Try again
            </button>
          ) : null}
        </p>
      ) : null}

      {manualOpen ? (
        manualField
      ) : (
        <button type="button" className={styles.linkBtn} onClick={() => setManualOpen(true)}>
          Not listed? Enter a {forum ? "post" : "thread"} ID or link
        </button>
      )}
    </div>
  );
}

function ThreadRow({
  thread,
  forum,
  active,
  onPick,
}: {
  thread: ChannelThread;
  forum: boolean;
  active: boolean;
  onPick: () => void;
}) {
  const tags = threadTags(thread, forum);
  return (
    <li>
      <button
        type="button"
        className={cn(styles.row, active && styles.rowActive)}
        aria-pressed={active}
        onClick={onPick}
        title={
          thread.locked
            ? "Locked — Discord may refuse new posts here unless a moderator unlocks it."
            : thread.archived
              ? "Closed — posting here reopens it."
              : undefined
        }
      >
        <span className={styles.icon} aria-hidden>
          <ChannelTypeIcon type={thread.type} size={15} />
        </span>
        <span className={styles.text}>
          <span className={styles.name}>
            <span className={styles.nameText}>{thread.name || `Thread ${thread.id}`}</span>
            {tags.map((tag) => (
              <span key={tag} className={cn(styles.tag, tag === "Pinned" && styles.tagPinned)}>
                {tag}
              </span>
            ))}
          </span>
        </span>
        {active ? <CheckCircleIcon size={16} className={styles.check} /> : null}
      </button>
    </li>
  );
}
