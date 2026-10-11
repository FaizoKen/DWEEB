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
 * "Not listed?", for anything the list can't show: private threads, older
 * closed ones, a webhook from a server this account can't read.
 *
 * Two layouts, matching the channel picker above it:
 *  - `summary` (Send, new post) leads with the decided thread as one card and
 *    folds the alternatives into a "Post in a different thread" disclosure —
 *    the same shape as the channel card and "Post to a different channel", and
 *    the thread is usually already decided in the toolbar's channel picker;
 *  - `list` (Update, or an inline section) shows the whole list up front.
 */

import { useEffect, useState, type ReactNode } from "react";
import type { ChannelThread } from "@/core/guild/api";
import { useChannelThreads } from "@/core/webhook/channelThreads";
import { threadIdFromInput } from "@/core/webhook/threadInput";
import { Field } from "@/ui/Field";
import { TextInput } from "@/ui/TextInput";
import {
  ChannelTypeIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  RefreshIcon,
  SearchIcon,
} from "@/ui/Icon";
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
  variant?: "list" | "summary";
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
  variant = "list",
}: ThreadPickerProps) {
  const listing = canList && guildId != null && channelId != null;
  const { entry, refresh } = useChannelThreads(guildId, channelId, listing);
  const channelType = localType ?? entry.channelType ?? undefined;
  const forum = isForumType(channelType);
  const noun = forum ? "post" : "thread";

  const [query, setQuery] = useState("");
  const [changeOpen, setChangeOpen] = useState(false);
  const threads = entry.threads;
  const selected = threads.find((t) => t.id === value);
  const ready = entry.status === "ready" || (entry.status === "loading" && threads.length > 0);
  // A thread id the list doesn't show (typed, from a restored message, or an
  // older/private thread) opens the ID field so the value is never hidden.
  const settled = entry.status !== "idle" && entry.status !== "loading";
  const unlisted = value !== "" && !(listing && (selected != null || !settled));
  const [manualOpen, setManualOpen] = useState(unlisted);
  useEffect(() => {
    if (unlisted) setManualOpen(true);
  }, [unlisted]);

  const visible = filterThreads(threads, query);
  const where = channelName ? `#${channelName}` : "this channel";
  const titleId = useUniqueId("thread-picker");
  const title = postTitle.trim();
  const needsTitle = forum && mode === "new" && value === "" && !title;
  // Like "Post to a different channel", the summary's folded list is the whole
  // list with the current pick highlighted; only the card's own "Add a post
  // title" link isn't repeated in it.
  const summary = variant === "summary";

  const manualField = (
    <Field
      label={forum ? "Post ID or link" : "Thread ID or link"}
      hint={
        <>
          In Discord, right-click the {noun} → <strong>Copy Link</strong> and paste it here. (With
          Developer Mode on, “Copy Thread ID” works too.)
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

  const refreshButton = (
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
  );

  const rootLabel = forum ? "New post" : `${where} itself`;
  const rootDetail = forum
    ? title
      ? `Starts a post titled “${title}”.`
      : "Needs a post title — add one in Message options."
    : "Not in a thread.";
  // An update edits a message that already lives somewhere; in a forum that is
  // always a post, so "New post" means nothing there.
  const showRoot = !(forum && mode === "update");

  const addTitleAction =
    needsTitle && onAddPostTitle ? (
      <button type="button" className={styles.inlineAction} onClick={onAddPostTitle}>
        Add a post title
      </button>
    ) : null;

  const rootRow = (card = false) => (
    <li>
      <OptionRow
        active={value === ""}
        card={card}
        icon={<ChannelTypeIcon type={channelType ?? 0} size={15} />}
        name={rootLabel}
        detail={rootDetail}
        warn={needsTitle}
        onPick={card ? () => setChangeOpen(true) : () => onChange("")}
      />
      {card || !summary ? addTitleAction : null}
    </li>
  );

  const unlistedRow = (card = false) => (
    <li>
      <OptionRow
        active
        card={card}
        icon={<ChannelTypeIcon type={11} size={15} />}
        name={`${forum ? "Post" : "Thread"} ${value}`}
        detail="Entered by ID — not in this list (private, older, or not loaded yet)."
        onPick={() => {
          setManualOpen(true);
          if (card) setChangeOpen(true);
        }}
      />
    </li>
  );

  // The full list: the channel-itself / new-post row, any unlisted pick, the
  // threads, then what the list leaves out and the ID field for it.
  const listBody = (
    <>
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
        {showRoot && !query.trim() ? rootRow() : null}
        {unlisted && !query.trim() ? unlistedRow() : null}
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
        <p className={styles.note}>Loading {noun}s…</p>
      ) : null}
      {ready && threads.length === 0 ? (
        <p className={styles.note}>
          No {noun}s in {where} yet.
        </p>
      ) : null}
      {ready && query.trim() && visible.length === 0 ? (
        <p className={styles.note}>Nothing matches that search.</p>
      ) : null}
      {entry.status === "ready" && entry.moreArchived ? (
        <p className={styles.note}>
          Only the most recently closed {noun}s are listed — for an older one, enter its ID or link
          below.
        </p>
      ) : null}
      {entry.status === "ready" && !entry.archivedListed ? (
        <p className={styles.note}>
          Closed {noun}s couldn't be listed here, so only open ones are shown.
        </p>
      ) : null}
      {entry.status === "error" || entry.status === "denied" ? (
        <p className={cn(styles.note, styles.noteError)} role="status">
          {entry.status === "denied"
            ? `Couldn't list ${noun}s: ${entry.error ?? "no access."}`
            : `Couldn't load ${noun}s. ${entry.error ?? ""}`}{" "}
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
          Not listed? Enter a {noun} ID or link
        </button>
      )}
    </>
  );

  if (summary) {
    // What is decided right now: a thread from the list, an id the list can't
    // show, a forum's new post — or, for a plain channel with no thread, the
    // channel card above already says it all, so there is no card here.
    const decided = selected ? (
      <ul className={cn(styles.list, styles.panel)}>
        <ThreadRow thread={selected} forum={forum} active card onPick={() => setChangeOpen(true)} />
      </ul>
    ) : unlisted ? (
      <ul className={cn(styles.list, styles.panel)}>{unlistedRow(true)}</ul>
    ) : value === "" && forum && mode === "new" ? (
      <ul className={cn(styles.list, styles.panel)}>{rootRow(true)}</ul>
    ) : null;

    const changeLabel =
      decided == null
        ? "Post inside a thread"
        : forum
          ? value === ""
            ? "Reply in an existing post"
            : "Choose a different post"
          : "Post in a different thread";

    return (
      <section className={styles.picker} aria-label={forum ? "Forum post" : "Thread"}>
        {decided ? (
          <div className={styles.head}>
            <span className={styles.title} id={titleId}>
              {forum ? `Post in ${where}` : `Thread in ${where}`}
            </span>
          </div>
        ) : null}
        {decided}
        <div className={styles.head}>
          <button
            type="button"
            className={styles.changeToggle}
            onClick={() => setChangeOpen((v) => !v)}
            aria-expanded={changeOpen}
            id={decided ? undefined : titleId}
          >
            {changeOpen ? (
              <ChevronDownIcon size={13} className={styles.changeChevron} />
            ) : (
              <ChevronRightIcon size={13} className={styles.changeChevron} />
            )}
            <span className={styles.changeLabel}>{changeLabel}</span>
            {threads.length > 0 ? (
              <span className={styles.changeCount}>{threads.length}</span>
            ) : null}
          </button>
          {changeOpen ? refreshButton : null}
        </div>
        {changeOpen ? (
          <>
            {listBody}
            <p className={styles.note}>
              The toolbar’s channel picker lists {noun}s too — a pick in either place is the same
              pick.
            </p>
          </>
        ) : null}
      </section>
    );
  }

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
        {refreshButton}
      </div>
      {listBody}
    </div>
  );
}

function OptionRow({
  active,
  icon,
  name,
  detail,
  warn = false,
  card = false,
  onPick,
}: {
  active: boolean;
  icon: ReactNode;
  name: ReactNode;
  detail?: string;
  warn?: boolean;
  card?: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(styles.row, card && styles.rowCard, active && styles.rowActive)}
      aria-pressed={active}
      onClick={onPick}
    >
      <span className={cn(styles.icon, card && styles.iconCard)} aria-hidden>
        {icon}
      </span>
      <span className={styles.text}>
        <span className={styles.name}>{name}</span>
        {detail ? (
          <span className={cn(styles.detail, warn && styles.detailWarn)}>{detail}</span>
        ) : null}
      </span>
      {active ? <CheckCircleIcon size={16} className={styles.check} /> : null}
    </button>
  );
}

function ThreadRow({
  thread,
  forum,
  active,
  card = false,
  onPick,
}: {
  thread: ChannelThread;
  forum: boolean;
  active: boolean;
  card?: boolean;
  onPick: () => void;
}) {
  const tags = threadTags(thread, forum);
  return (
    <li
      title={
        thread.locked
          ? "Locked — Discord may refuse new posts here unless a moderator unlocks it."
          : thread.archived
            ? "Closed — posting here reopens it."
            : undefined
      }
    >
      <OptionRow
        active={active}
        card={card}
        icon={<ChannelTypeIcon type={thread.type} size={15} />}
        name={
          <>
            <span className={styles.nameText}>{thread.name || `Thread ${thread.id}`}</span>
            {tags.map((tag) => (
              <span key={tag} className={cn(styles.tag, tag === "Pinned" && styles.tagPinned)}>
                {tag}
              </span>
            ))}
          </>
        }
        onPick={onPick}
      />
    </li>
  );
}
