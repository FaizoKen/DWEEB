/**
 * Per-server "Webhooks" dialog, opened from the account menu — the Webhook
 * Manager. This is the feature the shared bot's **Manage Webhooks** permission
 * unlocks: enumerating every webhook in a server is the one Discord call that
 * hard-requires it, and the listing carries each incoming webhook's token and
 * its creator. From here an admin can:
 *
 *  - **Recover** a lost webhook URL (copy it, or drop it straight into Send),
 *  - **Create** a webhook in any channel with no OAuth round-trip,
 *  - **Rename / re-avatar / move** any webhook (not just ones they hold a token
 *    for),
 *  - **Rotate** a (possibly leaked) webhook — a fresh URL, old one deleted,
 *  - **Delete** webhooks, in bulk,
 *  - **Audit** hygiene (default names, third-party apps, duplicates, channels
 *    near Discord's 15-per-channel cap),
 *  - **Brand** a set of webhooks with one identity, and **export / import** the
 *    server's webhook inventory (names + channels; tokens never leave).
 *
 * Access is gated server-side on the signed-in user *also* holding Manage
 * Webhooks (mirroring Discord), so a 403 means either the user or the bot lacks
 * it — the message distinguishes them, and the bot case offers a re-invite.
 *
 * Only ever opened for the *connected* guild, so channel names/types come from
 * the guild store the rest of the dashboard already loaded.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuthStore } from "@/core/auth/authStore";
import { useGuildStore } from "@/core/guild/guildStore";
import {
  createGuildWebhook,
  deleteGuildWebhook,
  fetchCustomBots,
  fetchGuildWebhooks,
  isAuthError,
  modifyGuildWebhook,
  rotateGuildWebhook,
  type GuildWebhook,
} from "@/core/guild/api";
import { botInviteUrl } from "@/core/guild/config";
import type { GuildChannel } from "@/core/guild/types";
import { rememberWebhook, webhookAvatarUrl } from "@/core/webhook";
import { useWebhookHandoff } from "@/core/webhook/handoffStore";
import {
  auditWebhooks,
  canRotate,
  exportInventory,
  FLAG_COPY,
  isRecoverable,
  parseInventory,
  webhookOwnerCopy,
  WEBHOOK_CHANNEL_CAP,
  type AuditReport,
  type InventoryEntry,
  type WebhookFlag,
} from "@/core/webhook/manage";
import { copyText } from "@/core/serialization/clipboard";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { TextInput } from "@/ui/TextInput";
import { pushToast } from "@/ui/Toast";
import { cn } from "@/lib/cn";
import {
  AlertTriangleIcon,
  CopyIcon,
  DownloadIcon,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  SendIcon,
  TrashIcon,
  UploadIcon,
} from "@/ui/Icon";
import styles from "./WebhookManagerDialog.module.css";

/** Channel types that can host a webhook: text, announcement, forum, media. */
const WEBHOOK_CHANNEL_TYPES = new Set([0, 5, 15, 16]);
/** Cap the uploaded avatar so the base64 stays under the proxy's data-URI limit. */
const MAX_AVATAR_BYTES = 800_000;

type FetchState =
  | { kind: "loading" }
  | { kind: "ready"; webhooks: GuildWebhook[]; dweebAppId: string }
  | { kind: "denied"; message: string; canReinvite: boolean }
  | { kind: "error"; message: string };

/** Read an image File into a `data:` URI, rejecting oversize/non-images. */
function fileToDataUri(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) return Promise.reject(new Error("Choose an image file."));
  if (file.size > MAX_AVATAR_BYTES)
    return Promise.reject(new Error("Image is too large — keep it under 800 KB."));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Couldn't read that image."));
    reader.readAsDataURL(file);
  });
}

/** Trigger a client-side download of `data` as pretty JSON. */
function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function WebhookManagerDialog({
  guildId,
  guildName,
  onClose,
}: {
  guildId: string;
  guildName?: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<FetchState>({ kind: "loading" });
  const [customBotIds, setCustomBotIds] = useState<ReadonlySet<string>>(new Set());
  const [reloadKey, setReloadKey] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  // Mutually-exclusive panels (create / import / bulk-identity) open below the
  // toolbar; a per-row `editingId` / `confirm` handle the inline row actions.
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; kind: "delete" | "rotate" } | null>(null);
  // Row-level / bulk busy guards so buttons disable while a call is in flight.
  const [actingId, setActingId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const guildData = useGuildStore((s) => s.data);
  const channelsLoaded = guildData?.guildId === guildId;
  const channels: GuildChannel[] = channelsLoaded ? guildData.channels : [];
  const channelById: Record<string, GuildChannel> = channelsLoaded ? guildData.channelById : {};
  const channelName = (id: string | null): string | undefined =>
    id ? channelById[id]?.name : undefined;

  const handoff = useWebhookHandoff((s) => s.send);

  // Fetch the webhook list (+ registered custom bots, for the audit's
  // third-party detection — best-effort, never blocks the list).
  useEffect(() => {
    const ac = new AbortController();
    setState({ kind: "loading" });
    setActionError(null);
    fetchGuildWebhooks(guildId, ac.signal)
      .then((res) =>
        setState({ kind: "ready", webhooks: res.webhooks, dweebAppId: res.dweeb_application_id }),
      )
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (isAuthError(e)) {
          useAuthStore.getState().markSignedOut();
          onClose();
          return;
        }
        const status =
          e && typeof e === "object" && "status" in e ? (e as { status: number }).status : 0;
        const message = e instanceof Error ? e.message : String(e);
        if (status === 403) {
          setState({ kind: "denied", message, canReinvite: /re-?add the bot/i.test(message) });
        } else {
          setState({ kind: "error", message });
        }
      });
    fetchCustomBots(guildId, ac.signal)
      .then((bots) => setCustomBotIds(new Set(bots.items.map((i) => i.application_id))))
      .catch(() => {
        /* best-effort: no custom-bot info just means the audit can't whitelist them */
      });
    return () => ac.abort();
  }, [guildId, reloadKey, onClose]);

  const webhooks = state.kind === "ready" ? state.webhooks : [];

  // In-place list update after a write, so the UI reflects a single mutation
  // without a full refetch (Refresh still pulls live data on demand).
  const updateList = (fn: (list: GuildWebhook[]) => GuildWebhook[]) =>
    setState((s) => (s.kind === "ready" ? { ...s, webhooks: fn(s.webhooks) } : s));

  const audit: AuditReport = useMemo(
    () =>
      auditWebhooks({
        webhooks,
        knownChannelIds: new Set(channels.map((c) => c.id)),
        dweebApplicationId: state.kind === "ready" ? state.dweebAppId : "",
        customBotIds,
      }),
    [webhooks, channels, state, customBotIds],
  );

  // Search + "flagged only" filter, then group by channel for display.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return webhooks.filter((w) => {
      if (flaggedOnly && !audit.byWebhook.has(w.id)) return false;
      if (!q) return true;
      const cn = channelName(w.channel_id)?.toLowerCase() ?? "";
      return (
        (w.name ?? "").toLowerCase().includes(q) ||
        cn.includes(q) ||
        (w.channel_id ?? "").includes(q)
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webhooks, query, flaggedOnly, audit, channelById]);

  const groups = useMemo(() => groupByChannel(filtered, channelById), [filtered, channelById]);

  const fail = (e: unknown) => {
    if (isAuthError(e)) {
      useAuthStore.getState().markSignedOut();
      onClose();
    } else {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleSelect = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const clearSelection = () => {
    setSelected(new Set());
    setBulkOpen(false);
  };

  const onCopyUrl = async (w: GuildWebhook) => {
    if (!w.url) return;
    if (await copyText(w.url))
      pushToast("Webhook URL copied — treat it like a password.", "success");
  };

  // Recover a webhook into the builder: remember it (so it's labelled in
  // recents) and hand it to the Send panel through the App-shell bridge.
  const onUseInBuilder = (w: GuildWebhook) => {
    if (!w.url) return;
    const gName = guildName;
    const cName = channelName(w.channel_id);
    rememberWebhook(w.url, {
      name: w.name ?? undefined,
      ownerKind: w.application_id ? "bot" : "user",
      applicationId: w.application_id ?? undefined,
      avatar: w.avatar,
      channelId: w.channel_id ?? undefined,
      guildId: w.guild_id ?? undefined,
      channelName: cName,
      guildName: gName,
    });
    handoff({ url: w.url, channelName: cName, guildName: gName });
    pushToast("Opening it in the Send panel…", "success");
    onClose();
  };

  const onDelete = async (id: string) => {
    setActingId(id);
    setActionError(null);
    try {
      await deleteGuildWebhook(guildId, id);
      updateList((l) => l.filter((w) => w.id !== id));
      setSelected((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
      setConfirm(null);
      pushToast("Webhook deleted.", "success");
    } catch (e) {
      fail(e);
    } finally {
      setActingId(null);
    }
  };

  const onRotate = async (id: string) => {
    setActingId(id);
    setActionError(null);
    try {
      const fresh = await rotateGuildWebhook(guildId, id);
      // The fresh webhook has a new id; drop the old, add the new in its place.
      updateList((l) => [fresh, ...l.filter((w) => w.id !== id)]);
      setConfirm(null);
      pushToast(
        fresh.rotate_warning ?? "Rotated — the old URL no longer works. Copy the new one.",
        fresh.rotate_warning ? "info" : "success",
      );
    } catch (e) {
      fail(e);
    } finally {
      setActingId(null);
    }
  };

  const onSaveEdit = async (
    id: string,
    changes: { name?: string; avatar?: string | null; channelId?: string },
  ) => {
    setActingId(id);
    setActionError(null);
    try {
      const updated = await modifyGuildWebhook(guildId, id, changes);
      updateList((l) => l.map((w) => (w.id === id ? updated : w)));
      setEditingId(null);
      pushToast("Webhook updated.", "success");
    } catch (e) {
      fail(e);
    } finally {
      setActingId(null);
    }
  };

  const onCreate = async (channelId: string, name: string, avatar?: string) => {
    setBulkBusy(true);
    setActionError(null);
    try {
      const created = await createGuildWebhook(guildId, channelId, name, avatar);
      updateList((l) => [created, ...l]);
      setCreating(false);
      pushToast(`Created “${created.name ?? name}”.`, "success");
    } catch (e) {
      fail(e);
    } finally {
      setBulkBusy(false);
    }
  };

  // Apply one identity (name and/or avatar) to every selected webhook.
  const onBulkIdentity = async (name: string, avatar: string | null | undefined) => {
    const ids = [...selected];
    setBulkBusy(true);
    setActionError(null);
    let ok = 0;
    for (const id of ids) {
      try {
        const changes: { name?: string; avatar?: string | null } = {};
        if (name) changes.name = name;
        if (avatar !== undefined) changes.avatar = avatar;
        const updated = await modifyGuildWebhook(guildId, id, changes);
        updateList((l) => l.map((w) => (w.id === id ? updated : w)));
        ok++;
      } catch (e) {
        if (isAuthError(e)) {
          fail(e);
          break;
        }
        // Keep going; report the count at the end.
      }
    }
    setBulkBusy(false);
    setBulkOpen(false);
    clearSelection();
    pushToast(
      ok === ids.length
        ? `Updated ${ok} webhook${ok === 1 ? "" : "s"}.`
        : `Updated ${ok}/${ids.length}.`,
      ok === ids.length ? "success" : "info",
    );
  };

  const onBulkDelete = async () => {
    const ids = [...selected];
    setBulkBusy(true);
    setActionError(null);
    let ok = 0;
    for (const id of ids) {
      try {
        await deleteGuildWebhook(guildId, id);
        ok++;
      } catch (e) {
        if (isAuthError(e)) {
          fail(e);
          break;
        }
      }
    }
    updateList((l) => l.filter((w) => !ids.includes(w.id)));
    setBulkBusy(false);
    clearSelection();
    pushToast(`Deleted ${ok}/${ids.length}.`, ok === ids.length ? "success" : "info");
  };

  const onExport = () => {
    const file = exportInventory(webhooks, (id) => channelName(id), guildId);
    const stamp = new Date().toISOString().slice(0, 10);
    const safe = (guildName ?? guildId).replace(/[^\w-]+/g, "-").slice(0, 40);
    downloadJson(`dweeb-webhooks-${safe}-${stamp}.json`, file);
    pushToast(
      `Exported ${file.webhooks.length} webhook${file.webhooks.length === 1 ? "" : "s"}.`,
      "success",
    );
  };

  const onImportEntries = async (entries: InventoryEntry[]) => {
    setBulkBusy(true);
    setActionError(null);
    let ok = 0;
    for (const e of entries) {
      // Only recreate into channels that exist in THIS server.
      if (channelsLoaded && !channelById[e.channel_id]) continue;
      try {
        const created = await createGuildWebhook(guildId, e.channel_id, e.name);
        updateList((l) => [created, ...l]);
        ok++;
      } catch (err) {
        if (isAuthError(err)) {
          fail(err);
          break;
        }
      }
    }
    setBulkBusy(false);
    setImporting(false);
    pushToast(
      `Imported ${ok}/${entries.length} webhook${entries.length === 1 ? "" : "s"}.`,
      ok ? "success" : "info",
    );
  };

  let body: ReactNode;
  if (state.kind === "loading") {
    body = <p className={styles.note}>Loading this server’s webhooks…</p>;
  } else if (state.kind === "denied") {
    body = (
      <div className={styles.denied}>
        <p className={styles.error}>{state.message}</p>
        {state.canReinvite ? (
          <a
            className={styles.reinvite}
            href={botInviteUrl()}
            target="_blank"
            rel="noopener noreferrer"
          >
            Re-add the DWEEB bot ↗
          </a>
        ) : null}
      </div>
    );
  } else if (state.kind === "error") {
    body = (
      <>
        <p className={styles.error}>{state.message}</p>
        <Button size="sm" onClick={() => setReloadKey((k) => k + 1)}>
          Retry
        </Button>
      </>
    );
  } else {
    const selCount = selected.size;
    body = (
      <>
        <p className={styles.lead}>
          Every webhook in {guildName ?? "this server"} — recover a lost URL, create one in any
          channel, tidy up, or rebrand a batch. Webhook URLs are credentials; only you (and the
          server’s admins) can see them here.
        </p>

        {/* Toolbar */}
        <div className={styles.toolbar}>
          <div className={styles.search}>
            <SearchIcon size={15} className={styles.searchIcon} />
            <input
              className={styles.searchInput}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or channel…"
              aria-label="Search webhooks"
            />
          </div>
          <div className={styles.toolButtons}>
            <Button
              size="sm"
              leadingIcon={<PlusIcon size={14} />}
              onClick={() => {
                setCreating((v) => !v);
                setImporting(false);
              }}
            >
              New
            </Button>
            <Button
              size="sm"
              variant="ghost"
              leadingIcon={<RefreshIcon size={14} />}
              onClick={() => setReloadKey((k) => k + 1)}
              title="Reload from Discord"
            >
              Refresh
            </Button>
            <Button
              size="sm"
              variant="ghost"
              leadingIcon={<DownloadIcon size={14} />}
              onClick={onExport}
              title="Download names + channels (no tokens)"
            >
              Export
            </Button>
            <Button
              size="sm"
              variant="ghost"
              leadingIcon={<UploadIcon size={14} />}
              onClick={() => {
                setImporting((v) => !v);
                setCreating(false);
              }}
            >
              Import
            </Button>
          </div>
        </div>

        {/* Audit summary */}
        {audit.flaggedCount > 0 || audit.channels.length > 0 ? (
          <AuditBanner
            audit={audit}
            channelName={channelName}
            flaggedOnly={flaggedOnly}
            onToggleFlagged={() => setFlaggedOnly((v) => !v)}
          />
        ) : null}

        {creating ? (
          <CreateForm
            channels={channels.filter((c) => WEBHOOK_CHANNEL_TYPES.has(c.type))}
            busy={bulkBusy}
            atCapChannelIds={new Set(audit.channels.filter((c) => c.full).map((c) => c.channelId))}
            onCancel={() => setCreating(false)}
            onCreate={onCreate}
          />
        ) : null}

        {importing ? (
          <ImportPanel
            busy={bulkBusy}
            channelsLoaded={channelsLoaded}
            onCancel={() => setImporting(false)}
            onImport={onImportEntries}
          />
        ) : null}

        {/* Bulk action bar */}
        {selCount > 0 ? (
          <div className={styles.bulkBar}>
            <span className={styles.bulkCount}>{selCount} selected</span>
            <div className={styles.bulkActions}>
              <Button
                size="sm"
                variant="ghost"
                leadingIcon={<PencilIcon size={13} />}
                onClick={() => setBulkOpen((v) => !v)}
              >
                Apply identity
              </Button>
              <Button
                size="sm"
                variant="ghost"
                leadingIcon={<TrashIcon size={13} />}
                disabled={bulkBusy}
                onClick={() => void onBulkDelete()}
              >
                Delete
              </Button>
              <button type="button" className={styles.linkBtn} onClick={clearSelection}>
                Clear
              </button>
            </div>
          </div>
        ) : null}

        {bulkOpen && selCount > 0 ? (
          <IdentityForm
            title={`Apply to ${selCount} webhook${selCount === 1 ? "" : "s"}`}
            allowClearAvatar
            busy={bulkBusy}
            onCancel={() => setBulkOpen(false)}
            onSubmit={(name, avatar) => void onBulkIdentity(name, avatar)}
            submitLabel="Apply"
            requireName={false}
          />
        ) : null}

        {actionError ? <p className={styles.error}>{actionError}</p> : null}

        {/* Grouped list */}
        {webhooks.length === 0 ? (
          <p className={styles.note}>No webhooks in this server yet. Create one above.</p>
        ) : filtered.length === 0 ? (
          <p className={styles.note}>Nothing matches that filter.</p>
        ) : (
          <ul className={styles.groupList}>
            {groups.map((g) => {
              const chAudit = audit.channels.find((c) => c.channelId === g.channelId);
              return (
                <li key={g.channelId} className={styles.group}>
                  <div className={styles.groupHead}>
                    <span className={styles.groupName}>#{g.name}</span>
                    <span className={cn(styles.groupCount, chAudit?.full && styles.groupCountFull)}>
                      {g.webhooks.length}
                      {chAudit ? ` / ${WEBHOOK_CHANNEL_CAP}` : ""}
                    </span>
                  </div>
                  <ul className={styles.rowList}>
                    {g.webhooks.map((w) => (
                      <WebhookRow
                        key={w.id}
                        webhook={w}
                        flags={audit.byWebhook.get(w.id) ?? []}
                        selected={selected.has(w.id)}
                        busy={actingId === w.id}
                        editing={editingId === w.id}
                        confirm={confirm?.id === w.id ? confirm.kind : null}
                        channels={channels.filter((c) => WEBHOOK_CHANNEL_TYPES.has(c.type))}
                        onToggleSelect={() => toggleSelect(w.id)}
                        onCopyUrl={() => void onCopyUrl(w)}
                        onUseInBuilder={() => onUseInBuilder(w)}
                        onStartEdit={() => {
                          setEditingId(w.id);
                          setConfirm(null);
                        }}
                        onCancelEdit={() => setEditingId(null)}
                        onSaveEdit={(changes) => void onSaveEdit(w.id, changes)}
                        onAskConfirm={(kind) => setConfirm({ id: w.id, kind })}
                        onCancelConfirm={() => setConfirm(null)}
                        onDelete={() => void onDelete(w.id)}
                        onRotate={() => void onRotate(w.id)}
                      />
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Webhooks${guildName ? ` — ${guildName}` : ""}`}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {body}
    </Modal>
  );
}

/* ─── Row ─────────────────────────────────────────────────────────────────── */

function WebhookRow({
  webhook: w,
  flags,
  selected,
  busy,
  editing,
  confirm,
  channels,
  onToggleSelect,
  onCopyUrl,
  onUseInBuilder,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onAskConfirm,
  onCancelConfirm,
  onDelete,
  onRotate,
}: {
  webhook: GuildWebhook;
  flags: readonly WebhookFlag[];
  selected: boolean;
  busy: boolean;
  editing: boolean;
  confirm: "delete" | "rotate" | null;
  channels: { id: string; name: string; type: number }[];
  onToggleSelect: () => void;
  onCopyUrl: () => void;
  onUseInBuilder: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (changes: { name?: string; avatar?: string | null; channelId?: string }) => void;
  onAskConfirm: (kind: "delete" | "rotate") => void;
  onCancelConfirm: () => void;
  onDelete: () => void;
  onRotate: () => void;
}) {
  const owner = webhookOwnerCopy(w);
  const recoverable = isRecoverable(w);

  return (
    <li className={cn(styles.row, selected && styles.rowSelected)}>
      <div className={styles.rowMain}>
        <input
          type="checkbox"
          className={styles.check}
          checked={selected}
          onChange={onToggleSelect}
          aria-label={`Select ${w.name ?? "webhook"}`}
        />
        <img
          className={styles.avatar}
          src={webhookAvatarUrl(w.id, w.avatar, 40)}
          alt=""
          width={36}
          height={36}
        />
        <div className={styles.rowText}>
          <div className={styles.rowNameLine}>
            <span className={styles.rowName}>{w.name || "(unnamed)"}</span>
            <span className={styles.ownerBadge} title={owner.label}>
              {owner.badge}
            </span>
            {flags.map((f) => (
              <span
                key={f}
                className={cn(styles.flag, FLAG_COPY[f].tone === "warn" && styles.flagWarn)}
                title={FLAG_COPY[f].hint}
              >
                {FLAG_COPY[f].label}
              </span>
            ))}
          </div>
          <div className={styles.rowMeta}>
            {w.creator?.name ? `by ${w.creator.name}` : "creator unknown"}
            {!recoverable ? " · no recoverable URL" : ""}
          </div>
        </div>
      </div>

      <div className={styles.rowActions}>
        {recoverable ? (
          <>
            <IconBtn title="Copy the webhook URL" onClick={onCopyUrl}>
              <CopyIcon size={15} />
            </IconBtn>
            <IconBtn title="Use this webhook in the builder" onClick={onUseInBuilder}>
              <SendIcon size={15} />
            </IconBtn>
          </>
        ) : null}
        <IconBtn title="Rename, change avatar, or move" onClick={onStartEdit} disabled={busy}>
          <PencilIcon size={15} />
        </IconBtn>
        {canRotate(w) ? (
          <IconBtn
            title="Rotate — new URL, old one deleted"
            onClick={() => onAskConfirm("rotate")}
            disabled={busy}
          >
            <RefreshIcon size={15} />
          </IconBtn>
        ) : null}
        <IconBtn
          title="Delete this webhook"
          onClick={() => onAskConfirm("delete")}
          disabled={busy}
          danger
        >
          <TrashIcon size={15} />
        </IconBtn>
      </div>

      {confirm ? (
        <div className={styles.confirm}>
          <span className={styles.confirmText}>
            {confirm === "delete"
              ? "Delete this webhook? Anything posting through its URL stops working — this can't be undone."
              : "Rotate this webhook? It gets a brand-new URL and the old one is deleted (its avatar isn't carried over)."}
          </span>
          <div className={styles.confirmActions}>
            <Button
              size="sm"
              variant={confirm === "delete" ? "danger" : "primary"}
              disabled={busy}
              onClick={confirm === "delete" ? onDelete : onRotate}
            >
              {busy ? "Working…" : confirm === "delete" ? "Delete" : "Rotate"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onCancelConfirm}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {editing ? (
        <EditRowForm
          webhook={w}
          channels={channels}
          busy={busy}
          onCancel={onCancelEdit}
          onSave={onSaveEdit}
        />
      ) : null}
    </li>
  );
}

/* ─── Edit form (inline, per row) ─────────────────────────────────────────── */

function EditRowForm({
  webhook: w,
  channels,
  busy,
  onCancel,
  onSave,
}: {
  webhook: GuildWebhook;
  channels: { id: string; name: string; type: number }[];
  busy: boolean;
  onCancel: () => void;
  onSave: (changes: { name?: string; avatar?: string | null; channelId?: string }) => void;
}) {
  const [name, setName] = useState(w.name ?? "");
  // undefined = leave, null = clear, string = new data URI.
  const [avatar, setAvatar] = useState<string | null | undefined>(undefined);
  const [channelId, setChannelId] = useState(w.channel_id ?? "");

  const submit = () => {
    const changes: { name?: string; avatar?: string | null; channelId?: string } = {};
    const trimmed = name.trim();
    if (trimmed && trimmed !== (w.name ?? "")) changes.name = trimmed;
    if (avatar !== undefined) changes.avatar = avatar;
    if (channelId && channelId !== (w.channel_id ?? "")) changes.channelId = channelId;
    if (Object.keys(changes).length === 0) {
      onCancel();
      return;
    }
    onSave(changes);
  };

  return (
    <div className={styles.editForm}>
      <div className={styles.editGrid}>
        <Field label="Name" className={styles.colWide}>
          {(id) => (
            <TextInput
              id={id}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Webhook name"
            />
          )}
        </Field>
        <Field label="Channel" className={styles.colWide}>
          {(id) => (
            <select
              id={id}
              className={styles.select}
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
            >
              {!channels.some((c) => c.id === channelId) ? (
                <option value={channelId}>(current channel)</option>
              ) : null}
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <AvatarField
        draft={avatar}
        setDraft={setAvatar}
        currentUrl={webhookAvatarUrl(w.id, w.avatar, 64)}
        allowClear
      />
      <div className={styles.formActions}>
        <Button size="sm" disabled={busy} onClick={submit}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ─── Create form ─────────────────────────────────────────────────────────── */

function CreateForm({
  channels,
  atCapChannelIds,
  busy,
  onCancel,
  onCreate,
}: {
  channels: { id: string; name: string; type: number }[];
  atCapChannelIds: ReadonlySet<string>;
  busy: boolean;
  onCancel: () => void;
  onCreate: (channelId: string, name: string, avatar?: string) => void;
}) {
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<string | null | undefined>(undefined);
  const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return setError("Give the webhook a name.");
    if (!channelId) return setError("Pick a channel.");
    if (atCapChannelIds.has(channelId))
      return setError("That channel is already at Discord's 15-webhook limit.");
    setError(null);
    onCreate(channelId, trimmed, typeof avatar === "string" ? avatar : undefined);
  };

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <h3 className={styles.panelTitle}>New webhook</h3>
      </div>
      <div className={styles.editGrid}>
        <Field label="Name" className={styles.colWide}>
          {(id) => (
            <TextInput
              id={id}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Announcements"
            />
          )}
        </Field>
        <Field label="Channel" className={styles.colWide}>
          {(id) =>
            channels.length === 0 ? (
              <p className={styles.note}>No webhook-capable channels loaded.</p>
            ) : (
              <select
                id={id}
                className={styles.select}
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
              >
                {channels.map((c) => (
                  <option key={c.id} value={c.id} disabled={atCapChannelIds.has(c.id)}>
                    #{c.name}
                    {atCapChannelIds.has(c.id) ? " (full)" : ""}
                  </option>
                ))}
              </select>
            )
          }
        </Field>
      </div>
      <AvatarField draft={avatar} setDraft={setAvatar} currentUrl={null} allowClear={false} />
      {error ? <p className={styles.error}>{error}</p> : null}
      <div className={styles.formActions}>
        <Button size="sm" disabled={busy || channels.length === 0} onClick={submit}>
          {busy ? "Creating…" : "Create webhook"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ─── Shared identity form (bulk brand kit) ───────────────────────────────── */

function IdentityForm({
  title,
  busy,
  allowClearAvatar,
  requireName,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  title: string;
  busy: boolean;
  allowClearAvatar: boolean;
  requireName: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (name: string, avatar: string | null | undefined) => void;
}) {
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = name.trim();
    if (requireName && !trimmed) return setError("Enter a name.");
    if (!trimmed && avatar === undefined) return setError("Set a name or an avatar to apply.");
    setError(null);
    onSubmit(trimmed, avatar);
  };

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <h3 className={styles.panelTitle}>{title}</h3>
      </div>
      <Field label="Name (leave blank to keep each name)" className={styles.colWide}>
        {(id) => (
          <TextInput
            id={id}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Shared name"
          />
        )}
      </Field>
      <AvatarField
        draft={avatar}
        setDraft={setAvatar}
        currentUrl={null}
        allowClear={allowClearAvatar}
      />
      {error ? <p className={styles.error}>{error}</p> : null}
      <div className={styles.formActions}>
        <Button size="sm" disabled={busy} onClick={submit}>
          {busy ? "Applying…" : submitLabel}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ─── Avatar picker ───────────────────────────────────────────────────────── */

function AvatarField({
  draft,
  setDraft,
  currentUrl,
  allowClear,
}: {
  draft: string | null | undefined;
  setDraft: (v: string | null | undefined) => void;
  currentUrl: string | null;
  allowClear: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  // Preview: a freshly-picked image, the "default" picture when cleared, or the
  // current avatar / nothing when left untouched.
  const preview =
    typeof draft === "string" ? draft : draft === null ? webhookAvatarUrl("0", null) : currentUrl;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      setDraft(await fileToDataUri(file));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't read that image.");
    }
  };

  return (
    <div className={styles.avatarField}>
      {preview ? (
        <img className={styles.avatarPreview} src={preview} alt="" width={40} height={40} />
      ) : (
        <span className={styles.avatarPreviewEmpty} aria-hidden="true" />
      )}
      <div className={styles.avatarBtns}>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          hidden
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <button type="button" className={styles.linkBtn} onClick={() => inputRef.current?.click()}>
          {typeof draft === "string" ? "Change image" : "Upload image"}
        </button>
        {typeof draft === "string" ? (
          <button type="button" className={styles.linkBtn} onClick={() => setDraft(undefined)}>
            Undo
          </button>
        ) : allowClear && draft !== null ? (
          <button type="button" className={styles.linkBtn} onClick={() => setDraft(null)}>
            Remove picture
          </button>
        ) : draft === null ? (
          <button type="button" className={styles.linkBtn} onClick={() => setDraft(undefined)}>
            Keep current
          </button>
        ) : null}
      </div>
      {error ? <span className={styles.avatarError}>{error}</span> : null}
    </div>
  );
}

/* ─── Audit banner ────────────────────────────────────────────────────────── */

function AuditBanner({
  audit,
  channelName,
  flaggedOnly,
  onToggleFlagged,
}: {
  audit: AuditReport;
  channelName: (id: string | null) => string | undefined;
  flaggedOnly: boolean;
  onToggleFlagged: () => void;
}) {
  return (
    <div className={styles.audit}>
      <div className={styles.auditHead}>
        <AlertTriangleIcon size={15} className={styles.auditIcon} />
        <span className={styles.auditSummary}>
          {audit.flaggedCount > 0
            ? `${audit.flaggedCount} webhook${audit.flaggedCount === 1 ? "" : "s"} to review`
            : "Channel limits"}
          {audit.channels.length > 0
            ? ` · ${audit.channels.length} channel${audit.channels.length === 1 ? "" : "s"} near the cap`
            : ""}
        </span>
        {audit.flaggedCount > 0 ? (
          <button type="button" className={styles.linkBtn} onClick={onToggleFlagged}>
            {flaggedOnly ? "Show all" : "Show flagged only"}
          </button>
        ) : null}
      </div>
      {audit.channels.length > 0 ? (
        <ul className={styles.auditChannels}>
          {audit.channels.map((c) => (
            <li
              key={c.channelId}
              className={cn(styles.auditChannel, c.full && styles.auditChannelFull)}
            >
              #{channelName(c.channelId) ?? c.channelId}: {c.count}/{WEBHOOK_CHANNEL_CAP}
              {c.full ? " — full" : " — near limit"}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ─── Import panel ────────────────────────────────────────────────────────── */

function ImportPanel({
  busy,
  channelsLoaded,
  onCancel,
  onImport,
}: {
  busy: boolean;
  channelsLoaded: boolean;
  onCancel: () => void;
  onImport: (entries: InventoryEntry[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [entries, setEntries] = useState<InventoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setEntries(null);
    try {
      const text = await file.text();
      const parsed = parseInventory(text);
      if (!parsed.ok) {
        setError(parsed.error);
        return;
      }
      setEntries(parsed.file.webhooks);
    } catch {
      setError("Couldn't read that file.");
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <h3 className={styles.panelTitle}>Import webhooks</h3>
      </div>
      <p className={styles.note}>
        Recreate webhooks from a DWEEB inventory file (names + channels). Fresh webhooks are created
        with new URLs; tokens are never imported. Entries for channels not in this server are
        skipped.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <div className={styles.formActions}>
        <Button
          size="sm"
          variant="ghost"
          leadingIcon={<UploadIcon size={14} />}
          onClick={() => inputRef.current?.click()}
        >
          Choose file
        </Button>
        {entries ? (
          <Button size="sm" disabled={busy || !channelsLoaded} onClick={() => onImport(entries)}>
            {busy ? "Creating…" : `Create ${entries.length}`}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {!channelsLoaded ? (
        <p className={styles.note}>Connect to this server first so its channels are loaded.</p>
      ) : null}
      {entries ? (
        <p className={styles.note}>{entries.length} webhook(s) found in the file.</p>
      ) : null}
      {error ? <p className={styles.error}>{error}</p> : null}
    </div>
  );
}

/* ─── Bits ────────────────────────────────────────────────────────────────── */

function IconBtn({
  title,
  onClick,
  disabled,
  danger,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(styles.iconBtn, danger && styles.iconBtnDanger)}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Group webhooks by channel, ordered by the channel's position then id. Hidden
 *  channels (not in the map) sort last under their id. */
function groupByChannel(
  webhooks: GuildWebhook[],
  channelById: Record<string, { name: string; position: number }>,
): { channelId: string; name: string; webhooks: GuildWebhook[] }[] {
  const map = new Map<string, GuildWebhook[]>();
  for (const w of webhooks) {
    const key = w.channel_id ?? "—";
    (map.get(key) ?? map.set(key, []).get(key)!).push(w);
  }
  return [...map.entries()]
    .map(([channelId, list]) => ({
      channelId,
      name:
        channelById[channelId]?.name ?? (channelId === "—" ? "no channel" : `channel ${channelId}`),
      position: channelById[channelId]?.position ?? Number.MAX_SAFE_INTEGER,
      webhooks: list,
    }))
    .sort((a, b) => a.position - b.position || a.channelId.localeCompare(b.channelId))
    .map(({ channelId, name, webhooks }) => ({ channelId, name, webhooks }));
}
