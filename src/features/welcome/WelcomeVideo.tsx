/**
 * The welcome overlay: DWEEB's intro film in a cinematic dialog.
 *
 * Opened explicitly from More ▸ "Watch the intro". The
 * film (rendered from `video/`, compressed web cuts in `public/media/`) tells
 * the whole product story in under a minute with kinetic captions burned in — so
 * it starts muted (autoplay policy) and still lands, with one tap for sound.
 *
 * Layout picks the cut for the screen it's on: the landscape 16:9 master on
 * desktop, the dedicated vertical 9:16 cut on portrait phones. Native controls
 * handle scrubbing/fullscreen; the only custom chrome is the "Tap for sound"
 * pill (hidden the moment the video is unmuted from anywhere) and a footer CTA.
 * Closing is never more than one tap away — X, Esc, backdrop, or "Get started"
 * — and a footer hint names the replay path so closing early isn't a one-way
 * door. Under `prefers-reduced-motion` the film waits for an explicit play.
 *
 * Mounted lazily by `App` only while open, so neither the modal code nor a
 * byte of video ever loads before it's wanted; unmounting tears the <video>
 * down, which also stops playback on close.
 *
 * It renders through `ui/Modal` in its `bare` form — the film keeps its own
 * chrome, and gets the modal behaviour it used to hand-roll only in part: a
 * focus trap and an inert background (Tab used to walk out into the editor
 * behind the film), Escape for the top layer only, and focus handed back to
 * whatever opened it.
 */

import { useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { Button } from "@/ui/Button";
import { CloseIcon } from "@/ui/Icon";
import { Modal } from "@/ui/Modal";
import { useWelcomeStore } from "./welcomeStore";
import styles from "./WelcomeVideo.module.css";

/** Compressed web cuts, copied verbatim from `public/` at build time. */
const LANDSCAPE = { src: "/media/intro.mp4", poster: "/media/intro-poster.jpg" };
const VERTICAL = { src: "/media/intro-vertical.mp4", poster: "/media/intro-poster-vertical.jpg" };

export function WelcomeVideo() {
  const close = useWelcomeStore((s) => s.closeWelcome);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Pick the cut once per open (the component mounts fresh each time): the
  // vertical cut on portrait screens, the landscape master everywhere else.
  const [cut] = useState(() =>
    window.matchMedia("(orientation: portrait)").matches ? VERTICAL : LANDSCAPE,
  );
  // Respect reduced motion by waiting for an explicit play instead of
  // autoplaying; the poster + native controls carry the affordance.
  const [autoPlay] = useState(() => !window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  // The film autoplays muted (browser policy); its captions are burned in, so
  // it works silently — but surface one obvious tap for sound. The pill hides
  // the moment the video is unmuted from anywhere (pill or native controls).
  const [muted, setMuted] = useState(autoPlay);

  const unmute = () => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = false;
    el.volume = 1;
    setMuted(false);
  };

  return (
    <Modal
      open
      onClose={close}
      bare
      title="DWEEB introduction"
      ariaLabel="DWEEB introduction"
      className={cn(styles.panel, cut === VERTICAL && styles.portrait)}
      // A theatre rather than a dialog: a deeper scrim, and above the Message
      // directory's overlay (`--app-z-tooltip`), which can still be open beneath.
      backdropStyle={{
        zIndex: "calc(var(--app-z-tooltip) + 20)",
        background: "rgba(3, 4, 8, 0.88)",
      }}
    >
      {/* No header chrome — the film runs edge-to-edge and the footer carries
          the title + CTA. Closing stays one tap away: the floating ✕ on the
          video corner, Esc, the backdrop, or "Get started". */}
      <div className={styles.stage}>
        <video
          ref={videoRef}
          className={styles.video}
          src={cut.src}
          poster={cut.poster}
          autoPlay={autoPlay}
          muted={muted}
          controls
          playsInline
          preload="metadata"
          onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
        />
        {muted ? (
          <button type="button" className={styles.soundPill} onClick={unmute}>
            🔊 Tap for sound
          </button>
        ) : null}
        <button
          type="button"
          className={styles.closeFloat}
          onClick={close}
          aria-label="Close intro"
        >
          <CloseIcon size={18} />
        </button>
      </div>

      <footer className={styles.footer}>
        {/* One slim row: title left, CTA right. The replay path lives on the
            title's hover tooltip instead of a second line of copy. */}
        <h2 className={styles.title} title="Replay any time from More ▸ “Watch the intro”">
          DWEEB introduction
        </h2>
        <Button variant="primary" size="sm" onClick={close}>
          Get started
        </Button>
      </footer>
    </Modal>
  );
}
