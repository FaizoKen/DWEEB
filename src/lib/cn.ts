/** Compact className joiner. Skips falsy values so call sites stay tidy. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  let out = "";
  for (const p of parts) {
    if (!p) continue;
    out = out.length === 0 ? p : `${out} ${p}`;
  }
  return out;
}
