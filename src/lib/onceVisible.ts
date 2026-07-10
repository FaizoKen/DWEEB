/**
 * One shared IntersectionObserver for "do this once the element nears the
 * viewport" work — lazy-mounting gallery thumbnails, arming load-more
 * sentinels. A single observer instance serves every caller (per-element
 * observers get expensive at hundreds of cards); each element's callback fires
 * at most once, then the element is released.
 *
 * The 600px root margin starts the work well before the element scrolls in, so
 * lazily mounted content is usually ready by the time it's visible.
 */

const callbacks = new WeakMap<Element, () => void>();
let observer: IntersectionObserver | null = null;

function ensureObserver(): IntersectionObserver {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const cb = callbacks.get(entry.target);
        callbacks.delete(entry.target);
        observer?.unobserve(entry.target);
        cb?.();
      }
    },
    { rootMargin: "600px" },
  );
  return observer;
}

/**
 * Invoke `cb` once when `el` first comes within ~600px of the viewport.
 * Returns an unsubscribe for unmount. Environments without
 * IntersectionObserver fire immediately (eager = the old behavior).
 */
export function onceVisible(el: Element, cb: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    cb();
    return () => {};
  }
  callbacks.set(el, cb);
  ensureObserver().observe(el);
  return () => {
    callbacks.delete(el);
    observer?.unobserve(el);
  };
}
