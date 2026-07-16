/**
 * Centered glyph for media that failed to load, mirroring Discord's
 * `brokenImageIcon` (a 32px torn-picture pictogram on a dark box).
 */
export function BrokenImageIcon() {
  return (
    <svg viewBox="0 0 24 24" width="32" height="32" fill="none" aria-hidden="true">
      <path
        d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8.5l-3.2-3.2a1 1 0 0 0-1.42 0L13 13.68l-2.88-2.88a1 1 0 0 0-1.41 0L3 16.5V5Z"
        fill="currentColor"
        opacity="0.55"
      />
      <path
        d="M21 16.06V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-.06l6.41-6.4L12.3 15.4a1 1 0 0 0 1.41 0l3.38-3.37L21 16.06Z"
        fill="currentColor"
        opacity="0.35"
      />
      <circle cx="8.5" cy="7.5" r="1.75" fill="currentColor" opacity="0.8" />
    </svg>
  );
}
