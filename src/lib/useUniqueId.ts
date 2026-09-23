import { useState } from "react";

let sequence = 0;

/**
 * An id that is unique across the whole document for as long as the calling
 * component stays mounted — for `htmlFor`, `aria-labelledby`,
 * `aria-describedby` and friends.
 *
 * Not `useId`: Preact derives those from a counter kept per render *root*, and
 * every portaled dialog (Modal) renders as its own root, so a dialog's ids
 * restart at the same values the editor behind it already uses. With the Send
 * dialog open over the builder, the Update tab's message-ID input shared its id
 * with the Username field, so its label and hint pointed at the editor's
 * controls instead of its own. A module-level sequence can't repeat, and this
 * app never renders on a server, so there is no hydration to match.
 */
export function useUniqueId(prefix = "uid"): string {
  const [id] = useState(() => `${prefix}-${++sequence}`);
  return id;
}
