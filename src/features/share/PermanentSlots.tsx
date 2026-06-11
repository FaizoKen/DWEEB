/**
 * "Keep components alive" section of the post-send success dialog.
 *
 * Plugin buttons/selects stop working a set number of days after the message
 * is sent (the interactions dispatcher disables them on the first expired
 * click). Each server gets a small number of *permanent slots* — messages
 * exempt from that expiry — and this section manages them right where the
 * user just learned their message is live:
 *
 *  - free slot available → one click marks the just-sent message permanent;
 *  - this message already permanent → one click hands the slot back;
 *  - all slots taken → the occupying messages are listed (with Discord links)
 *    and can be freed inline, which matters because a deleted message can't
 *    be reached any other way — without this a slot could leak forever.
 *
 * Renders nothing when the deployment doesn't run the feature (proxy answers
 * 501) or when components never expire there (`ttl_days` null). Signed-out
 * users get the expiry warning plus a sign-in prompt, since slot management
 * needs the Discord login the rest of the dashboard already uses.
 */

import { useEffect, useState } from "react";
import { useAuthStore } from "@/core/auth/authStore";
import {
  addPermanentMessage,
  fetchPermanentSlots,
  isAuthError,
  removePermanentMessage,
  type PermanentSlots,
} from "@/core/guild/api";
import { isProxyConfigured } from "@/core/guild/config";
import { Button } from "@/ui/Button";
import styles from "./PermanentSlots.module.css";

export interface PermanentSlotsSectionProps {
  guildId: string;
  channelId: string;
  /** The just-sent message the section offers to keep alive. */
  messageId: string;
}

type SlotsState =
  | { kind: "loading" }
  | { kind: "ready"; slots: PermanentSlots }
  | { kind: "unavailable" } // feature off on this deployment (501)
  | { kind: "error"; message: string };

export function PermanentSlotsSection({
  guildId,
  channelId,
  messageId,
}: PermanentSlotsSectionProps) {
  const authStatus = useAuthStore((s) => s.status);
  const login = useAuthStore((s) => s.login);
  const [state, setState] = useState<SlotsState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (authStatus !== "authed") return;
    let cancelled = false;
    const ac = new AbortController();
    setState({ kind: "loading" });
    fetchPermanentSlots(guildId, ac.signal)
      .then((slots) => {
        if (!cancelled) setState({ kind: "ready", slots });
      })
      .catch((e) => {
        if (cancelled || (e instanceof DOMException && e.name === "AbortError")) return;
        if (e instanceof Error && "status" in e && (e as { status: number }).status === 501) {
          setState({ kind: "unavailable" });
        } else {
          setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        }
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [authStatus, guildId]);

  // No proxy → no login, no slots; stay out of the dialog entirely.
  if (!isProxyConfigured()) return null;

  if (authStatus !== "authed") {
    return (
      <section className={styles.section}>
        <h3 className={styles.heading}>Interactive components</h3>
        <p className={styles.text}>
          Buttons and selects on this message stop working a few days after sending. Sign in with
          Discord to keep this message alive permanently.
        </p>
        <div className={styles.actions}>
          <Button size="sm" onClick={login}>
            Sign in with Discord
          </Button>
        </div>
      </section>
    );
  }

  if (state.kind === "unavailable") return null;
  if (state.kind === "loading") {
    return (
      <section className={styles.section}>
        <h3 className={styles.heading}>Interactive components</h3>
        <p className={styles.text}>Checking this server’s permanent slots…</p>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section className={styles.section}>
        <h3 className={styles.heading}>Interactive components</h3>
        <p className={styles.textError}>{state.message}</p>
      </section>
    );
  }

  const { slots } = state;
  // Components never expire on this deployment — nothing to manage.
  if (slots.ttl_days === null) return null;

  const isPermanent = slots.items.some((i) => i.message_id === messageId);
  const slotsFull = !isPermanent && slots.used >= slots.cap;

  const run = async (action: () => Promise<PermanentSlots>) => {
    setBusy(true);
    setActionError(null);
    try {
      setState({ kind: "ready", slots: await action() });
    } catch (e) {
      if (isAuthError(e)) {
        useAuthStore.getState().markSignedOut();
      } else {
        setActionError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const makePermanent = () =>
    run(async () => {
      const result = await addPermanentMessage(guildId, messageId, channelId);
      // `full` flips the section into the freeing view below — the refreshed
      // slot list it carries is exactly the state to render.
      return result.slots;
    });

  const free = (id: string) => run(() => removePermanentMessage(guildId, id));

  return (
    <section className={styles.section}>
      <h3 className={styles.heading}>Interactive components</h3>
      {isPermanent ? (
        <>
          <p className={styles.text}>
            ♾️ This message is <strong>permanent</strong> — its buttons and selects never expire.{" "}
            {slots.used}/{slots.cap} slots used.
          </p>
          <div className={styles.actions}>
            <Button size="sm" disabled={busy} onClick={() => free(messageId)}>
              Make temporary again
            </Button>
          </div>
        </>
      ) : slotsFull ? (
        <>
          <p className={styles.text}>
            Buttons and selects stop working <strong>{slots.ttl_days} days</strong> after sending,
            and all {slots.cap} of this server’s permanent slots are in use. Free one to keep this
            message instead:
          </p>
          <ul className={styles.slotList}>
            {slots.items.map((item, i) => (
              <li key={item.message_id} className={styles.slotItem}>
                <a
                  className={styles.slotLink}
                  href={`https://discord.com/channels/${guildId}/${item.channel_id}/${item.message_id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Permanent message {i + 1} ↗
                </a>
                <Button size="sm" disabled={busy} onClick={() => free(item.message_id)}>
                  Free slot
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <p className={styles.text}>
            Buttons and selects stop working <strong>{slots.ttl_days} days</strong> after sending.
            Use one of this server’s permanent slots ({slots.used}/{slots.cap} used) to keep them
            alive forever.
          </p>
          <div className={styles.actions}>
            <Button size="sm" variant="primary" disabled={busy} onClick={makePermanent}>
              Keep alive forever
            </Button>
          </div>
        </>
      )}
      {actionError ? <p className={styles.textError}>{actionError}</p> : null}
    </section>
  );
}
