/**
 * Menu typeahead: which item a typed prefix lands on.
 *
 * The WAI-ARIA menu pattern: typing moves focus to the next item whose label
 * starts with what was typed. A single character — or the same one repeated,
 * "s", "ss" — cycles through the items starting with it, beginning after the
 * current one; a longer prefix ("ex", "exp") searches from the current item, so
 * a match it already sits on keeps focus while the word is still being typed.
 * Returns -1 when nothing matches, which leaves focus where it is.
 */
export function typeaheadIndex(labels: readonly string[], current: number, typed: string): number {
  const query = typed.toLowerCase();
  if (!query || labels.length === 0) return -1;
  const repeated = [...query].every((char) => char === query[0]);
  const needle = repeated ? query[0]! : query;
  const start = needle.length === 1 ? current + 1 : Math.max(current, 0);
  for (let step = 0; step < labels.length; step++) {
    const index = (start + step) % labels.length;
    if (labels[index]!.trim().toLowerCase().startsWith(needle)) return index;
  }
  return -1;
}
