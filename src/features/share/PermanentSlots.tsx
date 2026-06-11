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
 * The send confirm dialog offers the same claim *before* posting (the panel
 * runs it once the message id exists). When that pre-send claim fails, the
 * error arrives here as `initialError` — this section already shows the live
 * slot state and its button is the natural retry.
 *
 * Renders nothing when the deployment doesn't run the feature (proxy answers
 * 501) or when components never expire there (`ttl_days` null). Signed-out
 * users get the expiry warning plus a sign-in prompt, since slot management
 * needs the Discord login the rest of the dashboard already uses.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useAuthStore } from "@/core/auth/authStore";
import {
  addPermanentMessage,
  fetchPermanentSlots,
  isAuthError,
  removePermanentMessage,
  type PermanentSlots,
} from "@/core/guild/api";
import { isProxyConfigured } from "@/core/guild/config";
import { cn } from "@/lib/cn";
import { Button } from "@/ui/Button";
import { AlertCircleIcon, CheckCircleIcon, ClockIcon } from "@/ui/Icon";
import styles from "./PermanentSlots.module.css";

export interface PermanentSlotsSectionProps {
  guildId: string;
  channelId: string;
  /** The just-sent message the section offers to keep alive. */
  messageId: string;
  /** Why the Send panel's pre-send "Make permanent" opt-in failed, when it
   *  did. Seeds the section's error line — its button is the retry. */
  initialError?: string;
}

type SlotsState =
  | { kind: "loading" }
  | { kind: "ready"; slots: PermanentSlots }
  | { kind: "unavailable" } // feature off on this deployment (501)
  | { kind: "error"; message: string };

/** One glanceable line: tinted status icon, short copy, action on the right.
 *  The tint alone signals state (amber = expiring, green = permanent) so the
 *  copy can stay to a title plus an optional muted sub-line. */
function Row({
  tone,
  icon,
  action,
  children,
}: {
  tone: "warning" | "success" | "danger" | "muted";
  icon: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.row}>
      <span className={cn(styles.badge, styles[tone])}>{icon}</span>
      <div className={styles.copy}>{children}</div>
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}

/** First millisecond of 2015 — the epoch Discord snowflakes count from. */
const DISCORD_EPOCH_MS = 1420070400000n;

/** When a message was sent, decoded from its snowflake id. Editing a message
 *  doesn't change its id, so this (plus the TTL) is the true expiry anchor —
 *  the same arithmetic the dispatcher applies server-side. */
function messageSentAt(messageId: string): Date | null {
  if (!/^\d{15,25}$/.test(messageId)) return null;
  return new Date(Number((BigInt(messageId) >> 22n) + DISCORD_EPOCH_MS));
}

export function PermanentSlotsSection({
  guildId,
  channelId,
  messageId,
  initialError,
}: PermanentSlotsSectionProps) {
  const authStatus = useAuthStore((s) => s.status);
  const login = useAuthStore((s) => s.login);
  const [state, setState] = useState<SlotsState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(initialError ?? null);

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
      <section className={styles.section} aria-label="Interactive components">
        <Row
          tone="warning"
          icon={<ClockIcon size={15} />}
          action={
            <Button size="sm" onClick={login}>
              Sign in
            </Button>
          }
        >
          <p className={styles.title}>Buttons & selects expire a few days after sending</p>
          <p className={styles.sub}>Sign in with Discord to keep this message alive</p>
        </Row>
      </section>
    );
  }

  if (state.kind === "unavailable") return null;
  if (state.kind === "loading") {
    return (
      <section className={styles.section} aria-label="Interactive components">
        <Row tone="muted" icon={<ClockIcon size={15} />}>
          <p className={styles.sub}>Checking permanent slots…</p>
        </Row>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <section className={styles.section} aria-label="Interactive components">
        <Row tone="danger" icon={<AlertCircleIcon size={15} />}>
          <p className={styles.titleError}>{state.message}</p>
        </Row>
      </section>
    );
  }

  const { slots } = state;
  // Components never expire on this deployment — nothing to manage.
  if (slots.ttl_days === null) return null;

  const isPermanent = slots.items.some((i) => i.message_id === messageId);
  const slotsFull = !isPermanent && slots.used >= slots.cap;

  // The exact moment this message's components stop working: its send time
  // (from the snowflake) plus the deployment's TTL. Editing doesn't move it.
  const sentAt = messageSentAt(messageId);
  const expiresAt = sentAt ? new Date(sentAt.getTime() + slots.ttl_days * 86_400_000) : null;
  const alreadyExpired = expiresAt !== null && expiresAt.getTime() <= Date.now();
  const expiryLabel = expiresAt?.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

  // Title for the two non-permanent states: a concrete date when the id
  // decodes (the normal case), the relative window as a fallback.
  const expiryTitle = expiryLabel ? (
    alreadyExpired ? (
      <>
        Buttons & selects <strong>expired {expiryLabel}</strong>
      </>
    ) : (
      <>
        Buttons & selects expire <strong>{expiryLabel}</strong>
      </>
    )
  ) : (
    <>
      Buttons & selects expire <strong>{slots.ttl_days} days</strong> after sending
    </>
  );

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
    <section className={styles.section} aria-label="Interactive components">
      {isPermanent ? (
        <Row
          tone="success"
          icon={<CheckCircleIcon size={15} />}
          action={
            <Button size="sm" disabled={busy} onClick={() => free(messageId)}>
              Make temporary
            </Button>
          }
        >
          <p className={styles.title}>This message is permanent</p>
          <p className={styles.sub}>
            Buttons never expire · {slots.used}/{slots.cap} slots used
          </p>
        </Row>
      ) : slotsFull ? (
        <>
          <Row tone="warning" icon={<ClockIcon size={15} />}>
            <p className={styles.title}>{expiryTitle}</p>
            <p className={styles.sub}>
              All {slots.cap} permanent slots are used — free one to keep this message
            </p>
          </Row>
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
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => free(item.message_id)}
                >
                  Free slot
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <Row
          tone="warning"
          icon={<ClockIcon size={15} />}
          action={
            <Button size="sm" variant="primary" disabled={busy} onClick={makePermanent}>
              Make permanent
            </Button>
          }
        >
          <p className={styles.title}>{expiryTitle}</p>
          <p className={styles.sub}>
            {alreadyExpired ? "Greyed-out components stay disabled · " : ""}
            {slots.used}/{slots.cap} permanent slots used
          </p>
        </Row>
      )}
      {actionError ? <p className={styles.textError}>{actionError}</p> : null}
    </section>
  );
}
