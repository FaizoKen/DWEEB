/**
 * Where the message being previewed is headed, so `{channel}` & co. render the
 * picked channel instead of their "this channel" sample.
 *
 * The web builder keeps that pick in `sendTargetStore` (the action bar's channel
 * chip), which the preview reads by default. The Activity keeps it in
 * `activityStore` instead — a module the web boot path must not pull in — so
 * the Activity shell provides its room target through this context, and the
 * preview prefers it whenever one is provided.
 */

import { createContext } from "react";

export interface PreviewDestination {
  guildId: string | null;
  channelId: string | null;
}

/** `undefined` = no provider, read the web builder's pick. */
export const PreviewDestinationContext = createContext<PreviewDestination | undefined>(undefined);
