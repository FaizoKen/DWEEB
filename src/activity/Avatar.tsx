/**
 * A round user avatar. Tries the user's real Discord picture first, then
 * Discord's default avatar image, and only drops to a stable coloured initial
 * if even that fails to load — so the slot always shows a real avatar for any
 * account with a picture, and a real *default* avatar for those without. CDN
 * media is CSP-allowed inside the Activity sandbox, so the image loads natively
 * (see `core/activity/avatar`).
 */

import { useState } from "react";
import { colorFor, defaultAvatarUrl, initial, userAvatarUrl } from "@/core/activity/avatar";
import styles from "./Avatar.module.css";

type Stage = "custom" | "default" | "initial";

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
  // Walk custom → default → initial as each source fails. Start at "default"
  // when there's no custom hash so we skip a request that's guaranteed to miss.
  const [stage, setStage] = useState<Stage>(avatar ? "custom" : "default");

  const url =
    stage === "custom"
      ? userAvatarUrl(id, avatar, 64)
      : stage === "default"
        ? defaultAvatarUrl(id)
        : null;

  if (url) {
    return (
      <img
        className={styles.avatar}
        src={url}
        alt=""
        width={size}
        height={size}
        draggable={false}
        onError={() => setStage((s) => (s === "custom" ? "default" : "initial"))}
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
