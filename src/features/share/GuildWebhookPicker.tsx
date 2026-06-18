/**
 * Auto-detected webhook picker — the effortless path for Send and Restore.
 *
 * When the connected server's webhooks can be enumerated (the shared bot holds
 * Manage Webhooks and so does the signed-in user), this lists them so the user
 * picks one in a click instead of pasting a URL. In Send it also creates a fresh
 * webhook in any channel inline — no OAuth round-trip, no copying tokens.
 *
 * Pure presentation over {@link useGuildWebhooks}: selection and creation are
 * reported up through `onPick`; the host panel owns what happens next (filling
 * its URL field, remembering the webhook, sending).
 */

import { useMemo, useState } from "react";
import { useGuildStore } from "@/core/guild/guildStore";
import { useGuildWebhooks, useGuildWebhooksStore, webhookAvatarUrl } from "@/core/webhook";
import { createGuildWebhook, isAuthError, type GuildWebhook } from "@/core/guild/api";
import { botInviteUrl } from "@/core/guild/config";
import { useAuthStore } from "@/core/auth/authStore";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { TextInput } from "@/ui/TextInput";
import { CheckCircleIcon, HashIcon, PlusIcon, RefreshIcon, SearchIcon } from "@/ui/Icon";
import { pushToast } from "@/ui/Toast";
import { cn } from "@/lib/cn";
import styles from "./GuildWebhookPicker.module.css";

/** Channel types that can host a webhook: text, announcement, forum, media. */
const WEBHOOK_CHANNEL_TYPES = new Set([0, 5, 15, 16]);
/** Show the search box only once the list is long enough to need it. */
const SEARCH_THRESHOLD = 6;

/** Owner chip for a listed webhook, from its app id alone — no GET needed. */
function ownerChip(w: GuildWebhook, dweebAppId: string): { text: string; kind: string } {
  if (w.application_id && dweebAppId && w.application_id === dweebAppId) {
    return { text: "DWEEB", kind: "dweeb" };
  }
  if (w.application_id) return { text: "Bot", kind: "bot" };
  return { text: "User", kind: "user" };
}

export function GuildWebhookPicker({
  mode,
  activeId,
  onPick,
  matchChannelId,
}: {
  /** Send shows the create affordance; Restore is select-only. */
  mode: "send" | "restore";
  /** Webhook id of the URL currently in the host field — its row is highlighted. */
  activeId: string | null;
  /** A webhook was chosen (existing row or freshly created). */
  onPick: (webhook: GuildWebhook) => void;
  /** Restore: channel parsed from a pasted message link — its webhooks float to
   *  the top and are tagged, so the right one is obvious. */
  matchChannelId?: string | null;
}) {
  const { active, connectedId, status, webhooks, dweebAppId, error, canReinvite, reload } =
    useGuildWebhooks();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  const guildData = useGuildStore((s) => s.data);
  const channelsLoaded = guildData?.guildId === connectedId;
  const channelName = (id: string | null): string | undefined =>
    id && channelsLoaded ? guildData?.channelById[id]?.name : undefined;

  // Only webhooks we can actually post through (incoming, token recoverable).
  const usable = useMemo(() => webhooks.filter((w) => w.type === 1 && !!w.url), [webhooks]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = usable.filter((w) => {
      if (!q) return true;
      const cn = channelName(w.channel_id)?.toLowerCase() ?? "";
      return (w.name ?? "").toLowerCase().includes(q) || cn.includes(q);
    });
    // Channel-matched webhooks (a pasted message link) first, then by channel
    // name, then webhook name — a stable, scannable order.
    return list.sort((a, b) => {
      if (matchChannelId) {
        const am = a.channel_id === matchChannelId ? 0 : 1;
        const bm = b.channel_id === matchChannelId ? 0 : 1;
        if (am !== bm) return am - bm;
      }
      const ca = channelName(a.channel_id) ?? "";
      const cb = channelName(b.channel_id) ?? "";
      return ca.localeCompare(cb) || (a.name ?? "").localeCompare(b.name ?? "");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usable, query, matchChannelId, guildData]);

  if (!active) return null;

  // Header is shown across every non-idle state so Refresh stays reachable.
  const header = (
    <div className={styles.head}>
      <span className={styles.title}>
        Your server’s webhooks
        {status === "ready" && usable.length > 0 ? (
          <span className={styles.count}> · {usable.length}</span>
        ) : null}
      </span>
      <button
        type="button"
        className={styles.refresh}
        onClick={reload}
        disabled={status === "loading"}
        title="Reload from Discord"
      >
        <RefreshIcon size={13} />
      </button>
    </div>
  );

  if (status === "loading" && usable.length === 0) {
    return (
      <section className={styles.picker} aria-label="Server webhooks">
        {header}
        <p className={styles.note}>Finding webhooks in this server…</p>
      </section>
    );
  }

  if (status === "denied") {
    // The user-permission case isn't worth a banner — just stand down silently
    // so the manual path is all that shows. The bot-permission case is fixable,
    // so surface the re-invite.
    if (!canReinvite) return null;
    return (
      <section className={styles.picker} aria-label="Server webhooks">
        {header}
        <p className={styles.note}>
          The DWEEB bot needs the <strong>Manage Webhooks</strong> permission to auto-detect this
          server’s webhooks.{" "}
          <a
            className={styles.link}
            href={botInviteUrl()}
            target="_blank"
            rel="noopener noreferrer"
          >
            Re-add the bot ↗
          </a>
        </p>
      </section>
    );
  }

  if (status === "error") {
    return (
      <section className={styles.picker} aria-label="Server webhooks">
        {header}
        <p className={styles.note}>{error ?? "Couldn’t load this server’s webhooks."}</p>
      </section>
    );
  }

  return (
    <section className={styles.picker} aria-label="Server webhooks">
      {header}

      {usable.length === 0 && !creating ? (
        <p className={styles.note}>
          {mode === "send"
            ? "No webhooks here yet — create one below and you’re ready to post."
            : "No webhooks in this server to restore from."}
        </p>
      ) : null}

      {usable.length > SEARCH_THRESHOLD ? (
        <div className={styles.search}>
          <SearchIcon size={14} className={styles.searchIcon} />
          <input
            className={styles.searchInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or channel…"
            aria-label="Search webhooks"
          />
        </div>
      ) : null}

      {filtered.length > 0 ? (
        <ul className={styles.list}>
          {filtered.map((w) => {
            const chip = ownerChip(w, dweebAppId);
            const cn2 = channelName(w.channel_id);
            const matched = matchChannelId != null && w.channel_id === matchChannelId;
            return (
              <li key={w.id}>
                <button
                  type="button"
                  className={cn(styles.row, w.id === activeId && styles.rowActive)}
                  onClick={() => onPick(w)}
                >
                  <img
                    className={styles.avatar}
                    src={webhookAvatarUrl(w.id, w.avatar, 40)}
                    alt=""
                    width={32}
                    height={32}
                    loading="lazy"
                  />
                  <span className={styles.rowText}>
                    <span className={styles.rowName}>
                      {w.name || "(unnamed)"}
                      <span className={cn(styles.chip, styles[`chip_${chip.kind}`])}>
                        {chip.text}
                      </span>
                      {matched ? <span className={styles.matchChip}>this channel</span> : null}
                    </span>
                    <span className={styles.rowDest}>
                      <HashIcon size={11} />
                      {cn2 ?? w.channel_id ?? "unknown channel"}
                    </span>
                  </span>
                  {w.id === activeId ? (
                    <CheckCircleIcon size={16} className={styles.check} />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : usable.length > 0 ? (
        <p className={styles.note}>Nothing matches that search.</p>
      ) : null}

      {mode === "send" ? (
        creating ? (
          <CreateInline
            guildId={connectedId}
            channels={(channelsLoaded ? guildData!.channels : []).filter((c) =>
              WEBHOOK_CHANNEL_TYPES.has(c.type),
            )}
            onCancel={() => setCreating(false)}
            onCreated={(w) => {
              setCreating(false);
              onPick(w);
            }}
          />
        ) : (
          <button type="button" className={styles.createToggle} onClick={() => setCreating(true)}>
            <span className={styles.createIcon} aria-hidden>
              <PlusIcon size={14} />
            </span>
            Create a new webhook
          </button>
        )
      ) : null}
    </section>
  );
}

/* ── Inline create (Send only) ──────────────────────────────────────────── */

function CreateInline({
  guildId,
  channels,
  onCancel,
  onCreated,
}: {
  guildId: string;
  channels: { id: string; name: string; type: number }[];
  onCancel: () => void;
  onCreated: (webhook: GuildWebhook) => void;
}) {
  const [name, setName] = useState("DWEEB");
  const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return setError("Give the webhook a name.");
    if (!channelId) return setError("Pick a channel.");
    setBusy(true);
    setError(null);
    try {
      const created = await createGuildWebhook(guildId, channelId, trimmed);
      useGuildWebhooksStore.getState().upsertLocal(created);
      pushToast(`Created “${created.name ?? trimmed}” — ready to post.`, "success");
      onCreated(created);
    } catch (e) {
      if (isAuthError(e)) {
        useAuthStore.getState().markSignedOut();
        onCancel();
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.createForm}>
      <div className={styles.createGrid}>
        <Field label="Name">
          {(id) => (
            <TextInput
              id={id}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="e.g. Announcements"
            />
          )}
        </Field>
        <Field label="Channel">
          {(id) =>
            channels.length === 0 ? (
              <p className={styles.note}>Connect to this server so its channels load.</p>
            ) : (
              <select
                id={id}
                className={styles.select}
                value={channelId}
                onChange={(e) => setChannelId(e.currentTarget.value)}
              >
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name}
                  </option>
                ))}
              </select>
            )
          }
        </Field>
      </div>
      {error ? <p className={styles.error}>{error}</p> : null}
      <div className={styles.createActions}>
        <Button size="sm" disabled={busy || channels.length === 0} onClick={() => void submit()}>
          {busy ? "Creating…" : "Create & use"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
