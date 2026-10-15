/**
 * "Open in DWEEB" for the guide tools: a builder link whose share token carries
 * the visitor's text, so what they wrote on the guide is what the editor opens.
 *
 * Built by hand rather than through `encodeShare` because the tools bundle has
 * no editor tree to strip — a Text Display inside a Container is all it sends.
 * The token format is the share link's own (`<version>.<lz-string>`, read by
 * `decodeShare`), and the acquisition `entry` rides beside it in the fragment so
 * the open still counts as this guide's builder visit.
 */

import { compressToEncodedURIComponent } from "lz-string";
import { CURRENT_VERSION } from "@/core/serialization/version";
import { withClientParams } from "@/core/seo/clientParams";

/** DWEEB's blurple, the default accent for a card opened from a guide. */
const ACCENT = 0x5865f2;

/** Builder URL that opens `content` as one accent-striped Text Display card. */
export function openInDweebHref(content: string, entry: string): string {
  const wire = {
    flags: 32768,
    components: [{ type: 17, accent_color: ACCENT, components: [{ type: 10, content }] }],
  };
  const token = `${CURRENT_VERSION}.${compressToEncodedURIComponent(JSON.stringify(wire))}`;
  return withClientParams(`/#s=${token}`, { entry });
}
