/**
 * What the Send panel's Thread ID field keeps from what was typed or pasted.
 *
 * A thread or forum post's own link (`…/channels/<server>/<thread>`, what
 * Discord's "Copy Link" gives — no Developer Mode needed) and a message link
 * inside one (`…/channels/<server>/<thread>/<message>`) both carry the thread's
 * id as their second segment, so a link yields that. Anything else keeps only
 * its digits, as the field always has — stripping every non-digit from a link
 * would glue the server, thread and message ids into one meaningless number.
 */
export function threadIdFromInput(input: string): string {
  const m = /discord(?:app)?\.com\/channels\/(?:\d+|@me)\/(\d{15,25})/i.exec(input);
  if (m?.[1]) return m[1];
  return input.replace(/[^\d]/g, "");
}
