import { useState } from "react";
import { ClockIcon } from "@/ui/Icon";
import { formatTimestamp, TIMESTAMP_STYLES } from "@/features/preview/markdown/timestamp";
import styles from "./TimestampPicker.module.css";

/** Zero-pad to two digits. */
const p2 = (n: number) => String(n).padStart(2, "0");

/** A `Date`, as the `value` strings the native date/time inputs expect (local). */
const toDateValue = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const toTimeValue = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;

interface TimestampPanelProps {
  /** Receives the ready-to-insert token, e.g. `<t:1717500000:F>`. */
  onInsert: (snippet: string) => void;
}

/**
 * Date + time + style picker for Discord `<t:unix:style>` timestamps. Every
 * style row previews the chosen moment with the *same* formatter the message
 * preview uses, so the list is a faithful what-you-see-is-what-you-get of how
 * each style will render. Picking one inserts the token (the menu closes via
 * the `onInsert` wiring in the toolbar).
 */
export function TimestampPanel({ onInsert }: TimestampPanelProps) {
  const [date, setDate] = useState(() => toDateValue(new Date()));
  const [time, setTime] = useState(() => toTimeValue(new Date()));

  // Parsed as local wall-clock time (no trailing `Z`) — the moment the user
  // means in their own zone. A cleared field falls back to "now".
  const parsed = new Date(`${date}T${time || "00:00:00"}`);
  const ms = Number.isNaN(parsed.getTime()) ? Date.now() : parsed.getTime();
  const unix = Math.floor(ms / 1000);

  const setNow = () => {
    const now = new Date();
    setDate(toDateValue(now));
    setTime(toTimeValue(now));
  };

  return (
    <div className={styles.panel}>
      <div className={styles.fields}>
        <label className={styles.field} data-grow>
          <span className={styles.fieldLabel}>Date</span>
          <input
            type="date"
            className={styles.input}
            value={date}
            onChange={(e) => setDate(e.currentTarget.value)}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Time</span>
          <input
            type="time"
            step={1}
            className={styles.input}
            value={time}
            onChange={(e) => setTime(e.currentTarget.value)}
          />
        </label>
      </div>

      <button type="button" className={styles.now} onClick={setNow}>
        <ClockIcon size={13} />
        Set to now
      </button>

      <div className={styles.styleList} role="menu" aria-label="Timestamp style">
        {TIMESTAMP_STYLES.map((s) => (
          <button
            key={s.code}
            type="button"
            role="menuitem"
            title={s.label}
            className={styles.styleRow}
            onClick={() => onInsert(`<t:${unix}:${s.code}>`)}
          >
            <span className={styles.preview}>{formatTimestamp(unix, s.code)}</span>
            <span className={styles.code}>{s.code}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
