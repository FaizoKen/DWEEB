/**
 * The welcome overlay: DWEEB's intro film in a cinematic dialog.
 *
 * Opened explicitly from More ▸ "Watch the intro" (or the one-time offer
 * toast's button). The film (rendered from `video/`, web cuts made by
 * `npm run deliver:web` into `public/media/`) tells the whole product story in
 * under a minute, with editorial captions burned in so it still lands silently.
 *
 * Playback: the viewer just asked for the film, so it first tries to play WITH
 * sound. Where a browser refuses that (Safari loses the click's user
 * activation across the lazy chunk load), it falls back to muted playback plus
 * one obvious "Tap for sound" pill; if even muted autoplay is refused (iOS Low
 * Power Mode), the poster stays up and the pill reads "Play with sound" — its
 * tap is a real gesture, so it starts the film audibly. Under
 * `prefers-reduced-motion` the film waits for an explicit play.
 *
 * Layout picks the cut for the screen it's on: the landscape 16:9 master on
 * desktop, the dedicated vertical 9:16 cut on portrait phones. Each cut ships
 * as AV1 (sharper at the same size) with an H.264 fallback, listed as codec-
 * tagged <source>s so the browser picks the first it can decode; on a portrait
 * phone AV1 is offered only when MediaCapabilities says decoding it is power
 * efficient (a software AV1 decode of a 1080×1920 film would cost battery).
 * The narration is also available as an English captions track (off by
 * default — the burned-in captions already carry the story), for deaf and
 * hard-of-hearing viewers and anyone watching muted.
 *
 * Native controls handle scrubbing/fullscreen/captions; the only custom chrome
 * is the sound pill and a footer CTA. Closing is never more than one tap away —
 * X, Esc, backdrop, or "Get started" — and the title's tooltip names the replay
 * path so closing early isn't a one-way door.
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

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { Button } from "@/ui/Button";
import { CloseIcon } from "@/ui/Icon";
import { Modal } from "@/ui/Modal";
import { useWelcomeStore } from "./welcomeStore";
import styles from "./WelcomeVideo.module.css";

type Source = { src: string; type: string };
type Cut = { portrait: boolean; poster: string; sources: Source[] };

/** AV1 Main, level 4.0 (1080p30 either way round). */
const AV1_VIDEO = "av01.0.08M.08";
const av1 = (src: string): Source => ({ src, type: `video/mp4; codecs="${AV1_VIDEO}, mp4a.40.2"` });

/** Web cuts, copied verbatim from `public/` at build time (never precached). */
const LANDSCAPE: Cut = {
  portrait: false,
  poster: "/media/intro-poster.jpg",
  sources: [
    av1("/media/intro.av1.mp4"),
    // H.264 High, level 4.0 (1920×1080).
    { src: "/media/intro.mp4", type: 'video/mp4; codecs="avc1.640028, mp4a.40.2"' },
  ],
};
const VERTICAL: Cut = {
  portrait: true,
  poster: "/media/intro-poster-vertical.jpg",
  sources: [
    av1("/media/intro-vertical.av1.mp4"),
    // H.264 High, level 3.1 (720×1280).
    { src: "/media/intro-vertical.mp4", type: 'video/mp4; codecs="avc1.64001f, mp4a.40.2"' },
  ],
};
const CAPTIONS = "/media/intro.en.vtt";

/**
 * The sources to offer: everything on desktop; on a portrait phone, AV1 only
 * when the device can decode it efficiently (any failure to ask → H.264).
 */
async function sourcesFor(cut: Cut): Promise<Source[]> {
  if (!cut.portrait) return cut.sources;
  const h264 = cut.sources.filter((s) => !s.type.includes("av01"));
  try {
    const info = await navigator.mediaCapabilities?.decodingInfo({
      type: "file",
      video: {
        contentType: `video/mp4; codecs="${AV1_VIDEO}"`,
        width: 1080,
        height: 1920,
        bitrate: 600_000,
        framerate: 30,
      },
    });
    return info?.supported && info.powerEfficient ? cut.sources : h264;
  } catch {
    return h264;
  }
}

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

  // Decided before the <video> mounts: swapping <source>s later would restart
  // the download. Desktop needs no async answer, so it renders immediately.
  const [sources, setSources] = useState<Source[] | null>(() =>
    cut.portrait ? null : cut.sources,
  );
  useEffect(() => {
    if (sources) return;
    let live = true;
    void sourcesFor(cut).then((s) => live && setSources(s));
    return () => {
      live = false;
    };
  }, [cut, sources]);

  // `muted` drives the pill: it turns on only when audible playback was
  // refused, and off the moment the video is unmuted from anywhere (pill or
  // native controls). `playing` picks the pill's words.
  const [muted, setMuted] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !autoPlay || !sources) return;
    el.muted = false;
    el.play().catch(() => {
      el.muted = true;
      setMuted(true);
      // Even muted autoplay can be refused: the poster and the pill remain.
      el.play().catch(() => {});
    });
  }, [autoPlay, sources]);

  const unmute = () => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = false;
    el.volume = 1;
    setMuted(false);
    // A refused autoplay leaves the film paused; this tap is a real gesture.
    if (el.paused) el.play().catch(() => {});
  };

  return (
    <Modal
      open
      onClose={close}
      bare
      title="DWEEB introduction"
      ariaLabel="DWEEB introduction"
      className={cn(styles.panel, cut.portrait && styles.portrait)}
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
        {sources ? (
          <video
            ref={videoRef}
            className={styles.video}
            poster={cut.poster}
            muted={muted}
            controls
            playsInline
            preload="metadata"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
          >
            {sources.map((s) => (
              <source key={s.src} src={s.src} type={s.type} />
            ))}
            <track kind="captions" src={CAPTIONS} srcLang="en" label="English" />
          </video>
        ) : (
          <img className={styles.video} src={cut.poster} alt="" />
        )}
        {muted ? (
          <button type="button" className={styles.soundPill} onClick={unmute}>
            {playing ? "🔊 Tap for sound" : "▶ Play with sound"}
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
