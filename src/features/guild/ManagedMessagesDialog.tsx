/**
 * Per-server "Managed messages" dialog, opened from the account menu — the
 * messages holding one of the guild's permanent slots. Slots are *claimed* in
 * the Send flow — the pre-send confirm offers a "Make permanent" switch — but
 * freed here, which is the only way to reclaim a slot held by a message that
 * was deleted on Discord; without it the slot would leak forever.
 *
 * Expiring messages are deliberately NOT listed: posts go straight from the
 * browser to Discord, so DWEEB's database only ever holds the permanent
 * slots. Nothing is "deleted on expiry" server-side — there's nothing stored
 * to delete; the first click on an expired message just disables the
 * component on the message itself. An earlier iteration kept a browser-local
 * list of sends (localStorage) so the dialog could show concrete expiry
 * dates, but that quietly accumulated a send history in the browser —
 * against DWEEB's nothing-stored ethos — and was misleading anyway, since
 * sends from any other device never appeared. The "Where this data lives"
 * disclosure carries the explanation instead, since users reasonably assume
 * a database row exists somewhere.
 *
 * The dialog is scoped to the connected server (slots are per-guild) and is
 * only reachable signed-in, since the account menu's panel requires a session.
 * When the deployment doesn't run the expiry feature (proxy answers 501, or
 * `ttl_days` is null) it shows an explanatory note instead of the list.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useAuthStore } from "@/core/auth/authStore";
import {
  fetchPermanentSlots,
  isAuthError,
  removePermanentMessage,
  type PermanentSlots,
} from "@/core/guild/api";
import { handleDiscordLinkClick } from "@/lib/discordDeepLink";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import styles from "./ManagedMessagesDialog.module.css";

type SlotsState =
  | { kind: "loading" }
  | { kind: "ready"; slots: PermanentSlots }
  | { kind: "unavailable" } // feature off on this deployment (501)
  | { kind: "error"; message: string };

export function ManagedMessagesDialog({
  guildId,
  guildName,
  onClose,
}: {
  guildId: string;
  /** Resolved server name, when known — falls back to a generic label. */
  guildName?: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<SlotsState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Bumped by "Retry" to re-run the fetch effect after an error.
  const [fetchKey, setFetchKey] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    setState({ kind: "loading" });
    setActionError(null);
    fetchPermanentSlots(guildId, ac.signal)
      .then((slots) => setState({ kind: "ready", slots }))
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (isAuthError(e)) {
          // Session died — the menu entry disappears with it; just close.
          useAuthStore.getState().markSignedOut();
          onClose();
        } else if (
          e instanceof Error &&
          "status" in e &&
          (e as { status: number }).status === 501
        ) {
          setState({ kind: "unavailable" });
        } else {
          setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        }
      });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildId, fetchKey]);

  const handleFree = async (messageId: string) => {
    setBusy(true);
    setActionError(null);
    try {
      setState({ kind: "ready", slots: await removePermanentMessage(guildId, messageId) });
    } catch (e) {
      if (isAuthError(e)) {
        useAuthStore.getState().markSignedOut();
        onClose();
      } else {
        setActionError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  let body: ReactNode;
  if (state.kind === "loading") {
    body = <p className={styles.note}>Checking this server’s managed messages…</p>;
  } else if (state.kind === "unavailable") {
    body = (
      <p className={styles.note}>
        This deployment doesn’t expire interactive components, so there’s nothing to manage here.
      </p>
    );
  } else if (state.kind === "error") {
    body = (
      <>
        <p className={styles.error}>{state.message}</p>
        <Button size="sm" onClick={() => setFetchKey((k) => k + 1)}>
          Retry
        </Button>
      </>
    );
  } else if (state.slots.ttl_days === null) {
    body = (
      <p className={styles.note}>
        Buttons &amp; selects never expire on this deployment — there’s nothing to manage.
      </p>
    );
  } else {
    const { slots } = state;
    // Read through the narrowed path — the destructured alias would widen
    // back to `number | null` despite the null check above.
    const ttlDays = state.slots.ttl_days;

    body = (
      <>
        <p className={styles.lead}>
          Buttons &amp; selects stop working <strong>{ttlDays} days</strong> after sending — unless
          the message is one of {guildName ?? "this server"}’s {slots.cap} set to never expire.
        </p>

        <div className={styles.sectionHead}>
          <h3 className={styles.sectionTitle}>Never expire</h3>
          <span className={styles.usage}>
            {slots.used}/{slots.cap} used
          </span>
        </div>
        {slots.items.length === 0 ? (
          <p className={styles.note}>None yet — turn on Never expire when posting.</p>
        ) : (
          <ul className={styles.slotList}>
            {slots.items.map((item, i) => {
              const url = `https://discord.com/channels/${guildId}/${item.channel_id}/${item.message_id}`;
              return (
                <li key={item.message_id} className={styles.slotItem}>
                  <a
                    className={styles.slotLink}
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    // Plain click opens the desktop app (falls back to web);
                    // modified clicks keep their native open-in-new-tab behaviour.
                    onClick={(ev) => handleDiscordLinkClick(ev, url)}
                  >
                    Message {i + 1} ↗
                  </a>
                  <span className={styles.slotMeta}>
                    added {new Date(item.added_at).toLocaleDateString([], { dateStyle: "medium" })}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    title="Puts the message back on the expiry clock, counted from its send date — older messages may expire right away"
                    onClick={() => void handleFree(item.message_id)}
                  >
                    Free slot
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {/* The storage model, behind a disclosure — users reasonably assume
            expiring messages live in a database that needs cleaning up. */}
        <details className={styles.storage}>
          <summary>Where this data lives</summary>
          <p>
            DWEEB’s database stores only the never-expire slots. Expiring messages are never stored
            anywhere — not on a server, not in this browser. Expiry is computed from the message’s
            send date, and the first click afterwards just disables the buttons on the message
            itself. The time limit exists so a message can’t keep generating button traffic forever;
            never-expire slots are the deliberate exceptions.
          </p>
        </details>

        {actionError ? <p className={styles.error}>{actionError}</p> : null}
      </>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Managed messages"
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
