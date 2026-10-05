/** An image's measured aspect ratio, bound to the source it was measured on. */
export interface MeasuredAspect {
  src: string;
  ratio: number;
}

/**
 * The next measured-aspect state — the *previous object itself* when it
 * already records this source and ratio. The gallery reads a cached image's
 * size from a ref callback that runs on every render, and Preact re-renders
 * whenever a state update hands it a different value: returning a fresh
 * `{ src, ratio }` each time looped the renderer forever (the whole page froze
 * the moment a gallery with an already-loaded image appeared — the template
 * directory on a first visit). An update that returns the same object is
 * skipped, so the loop can't start.
 */
export function nextAspect(
  prev: MeasuredAspect | null,
  src: string,
  ratio: number,
): MeasuredAspect {
  return prev && prev.src === src && prev.ratio === ratio ? prev : { src, ratio };
}
