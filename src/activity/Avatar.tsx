/**
 * A round user avatar: the real Discord picture when there is one, falling back
 * to a stable coloured initial when there isn't (or when the image fails to
 * load). CDN media is CSP-allowed inside the Activity sandbox, so the image
 * loads natively — see `core/activity/avatar`.
 */

import { useState } from "react";
import { colorFor, initial, userAvatarUrl } from "@/core/activity/avatar";
import styles from "./Avatar.module.css";

export function Avatar({
  id,
  name,
  avatar,
  size = 24,
}: {
  id: string;
  name: string;
  avatar: string | null;
  size?: number;
}) {
  // Drop to the initial fallback if the CDN image 404s / fails to decode.
  const [failed, setFailed] = useState(false);
  const url = failed ? null : userAvatarUrl(id, avatar, size * 2);

  if (url) {
    return (
      <img
        className={styles.avatar}
        src={url}
        alt=""
        width={size}
        height={size}
        draggable={false}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span
      className={styles.avatar}
      style={{ width: size, height: size, background: colorFor(id) }}
      aria-hidden="true"
    >
      {initial(name)}
    </span>
  );
}
