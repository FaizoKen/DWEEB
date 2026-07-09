/**
 * Per-server "Managed messages" dialog, opened from the account menu — now the
 * home of the server's *scheduled posts*.
 *
 * The never-expire slot list used to live here too, but managing slots next to
 * an opaque "Message 1 / Message 2" list was hard to use: you couldn't see
 * which message a slot actually held. That management moved to the message
 * cards themselves — **Start a message → Posted** — where every posted message
 * shows a live thumbnail with an assign/free control right on it (and the tab
 * lists slots whose message left the history, the leak-recovery path this
 * dialog used to own). This dialog keeps a hand-off note so old muscle memory
 * still finds the way.
 *
 * The deployment's component TTL is still fetched here (fail-soft) — it drives
 * the hand-off copy and the "Expired" badges on posted schedules below.
 *
 * The dialog is scoped to the connected server and is only reachable
 * signed-in, since the account menu's panel requires a session.
 */

import { useEffect, useState } from "react";
import { useAuthStore } from "@/core/auth/authStore";
import { fetchPermanentSlots, isAuthError } from "@/core/guild/api";
import { alignConnectedGuild } from "@/core/guild/originGuild";
import { isScheduleConfigured } from "@/core/schedule/api";
import { usePlanStore } from "@/core/plan/planStore";
import { useTemplateGalleryStore } from "@/features/templates/templateGalleryStore";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { ScheduledList, type ScheduleStats } from "./ScheduledList";
import styles from "./ManagedMessagesDialog.module.css";

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
  // Counts + per-server quota, reported up by the list for the header counter.
  const [scheduleStats, setScheduleStats] = useState<ScheduleStats | null>(null);
  // The deployment's component TTL, from the slots endpoint. Fail-soft on
  // every axis — 501 (feature off), 403, network — since it only feeds the
  // hand-off copy and the schedule list's "Expired" badges. An expired session
  // is the one error acted on: the menu entry disappears with it, so close.
  const [ttlDays, setTtlDays] = useState<number | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    setTtlDays(null);
    fetchPermanentSlots(guildId, ac.signal)
      .then((slots) => setTtlDays(slots.ttl_days))
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (isAuthError(e)) {
          useAuthStore.getState().markSignedOut();
          onClose();
        }
      });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildId]);

  // The hand-off to the never-expire manager: connect to this server (no-op
  // when already connected) so the gallery's Posted tab shows *its* history.
  const openPostedTab = () => {
    onClose();
    alignConnectedGuild(guildId);
    useTemplateGalleryStore.getState().openGallery("Posted");
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title="Managed messages"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {ttlDays != null ? (
        <>
          <p className={styles.lead}>
            Buttons &amp; selects stop working <strong>{ttlDays} days</strong> after sending —
            unless the message is marked never-expire.
          </p>
          <p className={styles.note}>
            Never-expire messages are managed on the messages themselves now: open{" "}
            {guildName ?? "this server"}’s posted history and assign or free a slot right on a
            message’s card.
          </p>
          <div className={styles.handoff}>
            <Button size="sm" variant="secondary" onClick={openPostedTab}>
              Open posted messages…
            </Button>
          </div>
        </>
      ) : null}

      {/* Scheduled posts for this server — lists this server's one-time
          scheduled posts (the user's, plus everyone's if they manage the
          server); load one back into the editor or cancel it. */}
      {isScheduleConfigured() ? (
        <section className={ttlDays != null ? styles.scheduledSection : undefined}>
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>Scheduled posts</h3>
            {scheduleStats && scheduleStats.total > 0 ? (
              <span className={styles.usage}>
                {scheduleStats.quota != null
                  ? `${scheduleStats.active}/${scheduleStats.quota} used`
                  : scheduleStats.total}
                {scheduleStats.quota != null && scheduleStats.active >= scheduleStats.quota ? (
                  <button
                    type="button"
                    className={styles.upgradeLink}
                    onClick={() => {
                      onClose();
                      usePlanStore.getState().openPricing(guildId);
                    }}
                  >
                    Upgrade for more
                  </button>
                ) : null}
              </span>
            ) : null}
          </div>
          <ScheduledList
            guildId={guildId}
            reloadToken={0}
            ttlDays={ttlDays}
            onLoaded={onClose}
            onStats={setScheduleStats}
          />
        </section>
      ) : (
        <p className={styles.note}>Scheduled posts aren’t enabled on this deployment.</p>
      )}
    </Modal>
  );
}
