/**
 * Copy decisions for the Send / Update panel.
 *
 * These live outside `SendPanel.tsx` because each one is a *claim about state*
 * that used to be wrong in at least one state the user can reach, and a claim
 * is worth pinning with a test:
 *
 *  - The lead paragraph told a signed-out visitor to "pick a channel below"
 *    when a signed-out visitor has no channel list at all (they get the create
 *    cards plus "Paste it instead").
 *  - The collapsed destination line said "All set" for a URL nothing had
 *    checked — `parseWebhookUrl` is a regex over the string, so "All set" was
 *    claiming a webhook exists on the strength of its shape.
 *  - The primary button is disabled with no destination and nothing on screen
 *    said why (the "Enter a valid Discord webhook URL." error is set by the
 *    click handler, which a disabled button never runs).
 *  - A 404 from a webhook PATCH rendered as Discord's raw
 *    "Discord (404, code 10008): Unknown Message", though the Restore panel has
 *    long explained the same status in English.
 */

export type SendMode = "new" | "update";

const LEAD_UPDATE =
  "Your edit goes straight from this browser to Discord — we never see or store it.";
const LEAD_SIGNED_OUT =
  "Sign in to pick a channel, or paste a webhook URL below — your message goes straight from this browser to Discord. We never see or store it.";
const LEAD_DESTINATION_PICKED =
  "Check the channel below and hit send — your message goes straight from this browser to Discord. We never see or store it.";
const LEAD_EDIT_SCHEDULE =
  "Your changes go into the post that's already scheduled — it keeps its channel and posts at the time below.";
const LEAD_PICK_CHANNEL =
  "Pick a channel below and hit send — your message goes straight from this browser to Discord. We never see or store it.";

/**
 * The panel's lead paragraph. Signed-out users are told what they can actually
 * do here; every signed-in variant is unchanged.
 */
export function sendLeadCopy(input: {
  mode: SendMode;
  /** The connected server's channel picker is available (signed-in manager). */
  pickerActive: boolean;
  /** The action bar already named a channel, so the picker leads with it. */
  destinationPicked: boolean;
  /** Definitively signed out, on a deployment where signing in is possible. */
  signedOut: boolean;
  /** Schedule mode is saving into a scheduled post loaded from the directory. */
  editingSchedule?: boolean;
}): string {
  if (input.mode === "update") return LEAD_UPDATE;
  if (input.editingSchedule) return LEAD_EDIT_SCHEDULE;
  if (input.signedOut && !input.pickerActive) return LEAD_SIGNED_OUT;
  if (input.pickerActive && input.destinationPicked) return LEAD_DESTINATION_PICKED;
  return LEAD_PICK_CHANNEL;
}

/** What the collapsed destination line may claim about the chosen webhook. */
export type SendDestinationCopy =
  /** Nothing has contacted Discord — the URL only *parses*. */
  | { kind: "unchecked"; text: string }
  /** A verify GET succeeded, or this browser has the webhook saved. */
  | { kind: "known"; channelName?: string; guildName?: string };

export const UNCHECKED_DESTINATION_TEXT = "Ready to send — we'll check this webhook when you post.";

export function sendDestinationCopy(input: {
  /**
   * True when a verify GET succeeded for this URL in this session, or it is a
   * webhook this browser saved (recents / picker / a previous send) — i.e.
   * something more than the shape of the string is known about it.
   */
  known: boolean;
  channelName?: string;
  guildName?: string;
}): SendDestinationCopy {
  if (!input.known) return { kind: "unchecked", text: UNCHECKED_DESTINATION_TEXT };
  return { kind: "known", channelName: input.channelName, guildName: input.guildName };
}

export const PICK_DESTINATION_HINT = "Pick a channel or paste a webhook URL first.";
/** The Update tab lists webhooks, not channels — there is no channel to pick. */
export const PICK_UPDATE_WEBHOOK_HINT =
  "Pick the webhook that posted this message, or paste its URL.";

/**
 * Why the primary button is disabled, when nothing else on screen says so.
 * Returns null while the panel is busy (the button reads "Sending…"), while a
 * destination *is* chosen (every remaining blocker renders its own callout,
 * and all of them need a parsed URL to be computed at all), while the
 * validation callout is already explaining it, and while the primary isn't a
 * send at all — a signed-out schedule turns it into "Sign in to schedule",
 * which is enabled and speaks for itself.
 */
export function sendDisabledHint(input: {
  mode: SendMode;
  /** A webhook URL that at least parses is in the field. */
  hasDestination: boolean;
  /** The "Fix before sending:" callout is on screen. */
  hasBlockingIssues: boolean;
  /** A send / schedule / verify is in flight. */
  busy: boolean;
  /** The primary button is the scheduling sign-in, not send/schedule. */
  primaryIsSignIn?: boolean;
}): string | null {
  if (input.busy || input.hasDestination || input.hasBlockingIssues) return null;
  if (input.primaryIsSignIn) return null;
  return input.mode === "update" ? PICK_UPDATE_WEBHOOK_HINT : PICK_DESTINATION_HINT;
}

export const UPDATE_TARGET_GONE_TEXT =
  "That message is gone, or it wasn't posted by this webhook — only messages this same webhook posted can be updated.";

/** Discord: the webhook itself is unknown (deleted / token reset). */
const UNKNOWN_WEBHOOK_CODE = 10015;

/**
 * The message an update failure shows. A webhook PATCH 404s for the one reason
 * users actually hit — the message was deleted, or it belongs to a different
 * webhook — so say that instead of relaying "Unknown Message". A 404 that names
 * the *webhook* keeps Discord's own wording, which is already accurate and
 * points at a different fix.
 */
export function updateFailureMessage(result: {
  status: number;
  error: string;
  body?: unknown;
}): string {
  if (result.status !== 404) return result.error;
  if (discordErrorCode(result.body) === UNKNOWN_WEBHOOK_CODE) return result.error;
  return UPDATE_TARGET_GONE_TEXT;
}

function discordErrorCode(body: unknown): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const code = (body as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}
