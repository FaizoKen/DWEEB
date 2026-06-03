/**
 * Manage-on-Discord dialog for a saved webhook.
 *
 * Everything here syncs to Discord using the webhook's own token — no Manage
 * Webhooks permission and no bot in the server required (same trust model as the
 * verify GET). It can:
 *   - rename the webhook (its real Discord name, shown as the default username),
 *   - change or remove its avatar, and
 *   - permanently delete it.
 *
 * The token PATCH can't move a webhook to another channel, so there's no channel
 * control here — that's the one thing that genuinely needs Manage Webhooks.
 *
 * On success we fold the change back into the saved entry (`refreshWebhook`) or
 * drop it (`forgetWebhook` after a delete) and call `onChange` so the parent
 * panel reloads its copy.
 */

import { useRef, useState } from "react";
import {
  deleteWebhook,
  forgetWebhook,
  modifyWebhook,
  parseWebhookUrl,
  refreshWebhook,
  webhookAvatarHash,
  webhookAvatarUrl,
  type WebhookHistoryEntry,
} from "@/core/webhook";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { TextInput } from "@/ui/TextInput";
import { UploadIcon, TrashIcon } from "@/ui/Icon";
import { pushToast } from "@/ui/Toast";
import styles from "./WebhookManageDialog.module.css";

/** Discord rejects avatars over ~10 MiB; guard a bit under so the error is ours,
 *  not a confusing network failure on a huge upload. */
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
const ACCEPTED_IMAGE = "image/png,image/jpeg,image/gif,image/webp";

/** Read a picked image File into a base64 data URI for Discord's `avatar` field. */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image."));
    reader.readAsDataURL(file);
  });
}

export function WebhookManageDialog({
  entry,
  onClose,
  onChange,
}: {
  entry: WebhookHistoryEntry;
  onClose: () => void;
  /** Called after a successful rename/avatar/delete so the parent reloads history. */
  onChange: () => void;
}) {
  const parsed = parseWebhookUrl(entry.url);

  const [name, setName] = useState(entry.name);
  // The pending avatar change: `undefined` = leave as-is, `string` = a new data
  // URI to upload, `null` = remove the current picture.
  const [avatar, setAvatar] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState<null | "save" | "delete">(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // What the avatar preview should show: a pending pick, an explicit removal, or
  // (untouched) the webhook's current picture from Discord's CDN.
  const previewSrc =
    avatar === undefined
      ? webhookAvatarUrl(entry.id, entry.avatar, 80)
      : avatar === null
        ? webhookAvatarUrl(entry.id, null, 80)
        : avatar;

  const trimmedName = name.trim();
  const nameChanged = trimmedName.length > 0 && trimmedName !== entry.name;
  const avatarChanged = avatar !== undefined;
  const dirty = nameChanged || avatarChanged;

  const pickFile = async (file: File) => {
    if (file.size > MAX_AVATAR_BYTES) {
      pushToast("That image is too large — pick one under 8 MB.", "error");
      return;
    }
    try {
      setAvatar(await fileToDataUrl(file));
    } catch {
      pushToast("Couldn't read that image.", "error");
    }
  };

  const save = async () => {
    if (!parsed || !dirty || busy) return;
    setBusy("save");
    const res = await modifyWebhook(parsed, {
      name: nameChanged ? trimmedName : undefined,
      avatar: avatarChanged ? avatar : undefined,
    });
    setBusy(null);
    if (!res.ok) {
      pushToast(res.error, "error");
      return;
    }
    // Reflect Discord's authoritative values back into the saved entry.
    refreshWebhook(entry.id, {
      name: typeof res.webhook.name === "string" ? res.webhook.name : undefined,
      avatar: webhookAvatarHash(res.webhook),
    });
    onChange();
    pushToast("Webhook updated on Discord.", "success");
    onClose();
  };

  const remove = async () => {
    if (!parsed || busy) return;
    setBusy("delete");
    const res = await deleteWebhook(parsed);
    setBusy(null);
    // 404/401 means it's already gone — treat as done and clean up locally.
    if (res.ok || res.status === 404 || res.status === 401) {
      forgetWebhook(entry.id);
      onChange();
      pushToast(
        res.ok ? "Webhook deleted on Discord." : "Webhook was already gone — removed.",
        "info",
      );
      onClose();
      return;
    }
    pushToast(res.error, "error");
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Manage webhook on Discord"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy !== null}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!dirty || busy !== null}>
            {busy === "save" ? "Saving…" : "Save changes"}
          </Button>
        </>
      }
    >
      {!parsed ? (
        <p className={styles.note}>
          This saved entry's URL can't be parsed, so it can't be managed.
        </p>
      ) : (
        <>
          <div className={styles.avatarRow}>
            <img
              className={styles.avatar}
              src={previewSrc}
              alt=""
              onError={(e) => {
                const img = e.currentTarget;
                const fallback = webhookAvatarUrl(entry.id, null, 80);
                if (img.src !== fallback) img.src = fallback;
              }}
            />
            <div className={styles.avatarActions}>
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPTED_IMAGE}
                className={styles.fileInput}
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0];
                  if (file) void pickFile(file);
                  e.currentTarget.value = ""; // allow re-picking the same file
                }}
              />
              <Button
                size="sm"
                leadingIcon={<UploadIcon size={13} />}
                onClick={() => fileRef.current?.click()}
                disabled={busy !== null}
              >
                Upload image
              </Button>
              {/* Offer "remove" only when there's a picture to remove, and "reset"
                  only once a pending change exists. */}
              {avatar !== null && (entry.avatar || avatar) ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setAvatar(null)}
                  disabled={busy !== null}
                >
                  Remove
                </Button>
              ) : null}
              {avatarChanged ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setAvatar(undefined)}
                  disabled={busy !== null}
                >
                  Reset
                </Button>
              ) : null}
            </div>
          </div>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Name on Discord</span>
            <TextInput
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              maxLength={80}
              placeholder="Webhook name"
              aria-label="Webhook name on Discord"
            />
            <span className={styles.hint}>
              The webhook's real name — shown as the default username on messages it sends.
            </span>
          </label>

          <div
            className={`${styles.danger}${confirmDelete ? ` ${styles.dangerConfirming}` : ""}`}
          >
            <div className={styles.dangerText}>
              <strong>Delete this webhook</strong>
              <span className={styles.hint}>
                Permanent. Any message scheduled to this URL will stop working.
              </span>
            </div>
            {confirmDelete ? (
              <div className={styles.dangerConfirm}>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmDelete(false)}
                  disabled={busy !== null}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  leadingIcon={<TrashIcon size={13} />}
                  onClick={remove}
                  disabled={busy !== null}
                >
                  {busy === "delete" ? "Deleting…" : "Delete for real"}
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="danger"
                leadingIcon={<TrashIcon size={13} />}
                onClick={() => setConfirmDelete(true)}
                disabled={busy !== null}
              >
                Delete
              </Button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
