/**
 * Recent-webhooks list — shared by the Send and Restore panels.
 *
 * Renders the webhooks saved in this browser (see `core/webhook/history`) as
 * clickable rows. Clicking one fills the panel's webhook field via `onUse`.
 * The row whose id matches `activeId` — the webhook id parsed from whatever
 * URL is currently in that field — is highlighted, so it's clear which saved
 * entry the panel is acting on.
 *
 * History is owned by the parent panel (which also reads it — e.g. the Send
 * panel's ownership/name lookups) and passed in; the inline rename / forget
 * here mutate localStorage and then call `onChange` so the parent reloads its
 * copy and the list re-renders.
 */

import { useState } from "react";
import {
  forgetWebhook,
  OWNER_COPY,
  renameWebhook,
  webhookAvatarUrl,
  type WebhookHistoryEntry,
  type WebhookOwnerKind,
} from "@/core/webhook";
import { Button } from "@/ui/Button";
import { TextInput } from "@/ui/TextInput";
import { CloseIcon, PencilIcon, TrashIcon } from "@/ui/Icon";
import { IconButton } from "@/ui/IconButton";
import { pushToast } from "@/ui/Toast";
import { cn } from "@/lib/cn";
import styles from "./WebhookRecents.module.css";

/** CSS-module class for each owner chip, by kind. */
const OWNER_BADGE_CLASS: Record<WebhookOwnerKind, string | undefined> = {
  bot: styles.ownerBot,
  user: styles.ownerUser,
  follower: styles.ownerFollower,
  unknown: styles.ownerUnknown,
};

export function WebhookRecents({
  history,
  activeId,
  onUse,
  onChange,
}: {
  /** Saved entries to show, owned by the parent panel. */
  history: WebhookHistoryEntry[];
  /** Webhook id of the URL currently in the field — its row is highlighted. */
  activeId: string | null;
  /** Fill the panel's webhook field from the clicked entry. */
  onUse: (entry: WebhookHistoryEntry) => void;
  /** Called after a rename/forget so the parent can reload its history copy. */
  onChange: () => void;
}) {
  // Inline rename of a saved entry: which id is being edited + its draft.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");

  if (history.length === 0) return null;

  const handleForget = (entry: WebhookHistoryEntry) => {
    forgetWebhook(entry.id);
    onChange();
    pushToast("Webhook removed from this browser.", "info");
  };

  const startEditLabel = (entry: WebhookHistoryEntry) => {
    setEditingId(entry.id);
    setEditingLabel(entry.label);
  };

  const cancelEditLabel = () => {
    setEditingId(null);
    setEditingLabel("");
  };

  const commitEditLabel = (id: string) => {
    renameWebhook(id, editingLabel);
    onChange();
    setEditingId(null);
    setEditingLabel("");
  };

  return (
    <div className={styles.history}>
      <div className={styles.historyTitle}>Recent webhooks (this browser)</div>
      <ul className={styles.historyList}>
        {history.map((entry) =>
          editingId === entry.id ? (
            <li key={entry.id} className={styles.historyItem}>
              <form
                className={styles.historyEdit}
                onSubmit={(e) => {
                  e.preventDefault();
                  commitEditLabel(entry.id);
                }}
              >
                <TextInput
                  autoFocus
                  value={editingLabel}
                  onChange={(e) => setEditingLabel(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") cancelEditLabel();
                  }}
                  placeholder={entry.name || "Add a label"}
                  maxLength={60}
                  aria-label="Webhook label"
                />
                <Button size="sm" variant="primary" type="submit">
                  Save
                </Button>
                <IconButton size="sm" label="Cancel rename" onClick={cancelEditLabel}>
                  <CloseIcon size={12} />
                </IconButton>
              </form>
            </li>
          ) : (
            <li
              key={entry.id}
              className={cn(styles.historyItem, entry.id === activeId && styles.historyItemActive)}
            >
              <button
                type="button"
                className={styles.historyButton}
                onClick={() => onUse(entry)}
              >
                <span className={styles.historyLabel}>
                  <img
                    className={styles.historyAvatar}
                    src={webhookAvatarUrl(entry.id, entry.avatar)}
                    alt=""
                    loading="lazy"
                    onError={(e) => {
                      const img = e.currentTarget;
                      const fallback = webhookAvatarUrl(entry.id, null);
                      if (img.src !== fallback) img.src = fallback;
                    }}
                  />
                  <span className={styles.historyText}>
                    {entry.label || entry.name || "(unlabeled)"}
                  </span>
                  {entry.ownerKind && entry.ownerKind !== "unknown" ? (
                    <span
                      className={cn(
                        styles.ownerBadge,
                        styles.ownerBadgeSm,
                        OWNER_BADGE_CLASS[entry.ownerKind],
                      )}
                      title={OWNER_COPY[entry.ownerKind].label}
                    >
                      {OWNER_COPY[entry.ownerKind].badge}
                    </span>
                  ) : null}
                </span>
                <span className={styles.historyId}>id · {entry.id}</span>
              </button>
              <IconButton size="sm" label="Edit label" onClick={() => startEditLabel(entry)}>
                <PencilIcon size={12} />
              </IconButton>
              <IconButton
                size="sm"
                variant="danger"
                label="Forget this webhook"
                onClick={() => handleForget(entry)}
              >
                <TrashIcon size={12} />
              </IconButton>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
