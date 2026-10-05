/**
 * Order snowflake ids oldest first. A snowflake is a creation timestamp shifted
 * left, so a shorter id is an older one and equal lengths order as strings.
 * `localeCompare` alone put the 19-digit (newer, post-2022) id before the
 * 18-digit one, so "keep the oldest" duplicate kept the newer webhook and
 * deleted the one older posts need for Update.
 */
export function compareSnowflakes(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}
