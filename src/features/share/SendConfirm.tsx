/**
 * Pre-send confirmation dialog.
 *
 * Posting/editing a webhook message is irreversible-ish (you can PATCH, but the
 * ping already fired), so the Send panel pops this summary before the actual
 * POST/PATCH. It restates the two things a user most often gets wrong:
 *   - *where* the message lands — which webhook, in which thread, and (for an
 *     edit) which message id is being overwritten; and
 *   - *who gets pinged* — computed from the message's mention tokens crossed
 *     with its `allowed_mentions` policy, so an `@everyone` that will actually
 *     ring the whole channel is impossible to miss.
 *
 * For messages with interactive components it is also the one place permanence
 * is decided (state owned by the Send panel): components expire after a
 * deployment-set TTL unless the message holds one of the server's permanent
 * slots. The switch claims a slot — or, when the update target already holds
 * one, starts on and releases it when turned off. The claim/release itself
 * runs right after the send succeeds — permanence is keyed to the message id,
 * which only exists once Discord accepts the message, so it can never happen
 * here. When every slot is taken by other messages the switch gives way to
 * a "Free a slot" button that hands off to the gallery's Posted tab, where
 * slots are freed on the messages' cards — closing this dialog and the Share
 * dialog around it (the pending send is abandoned, but the panel keeps its
 * inputs). The post-send dialog only *reports* the final state.
 *
 * The dialog is presentational: it owns no send logic. Confirming closes it and
 * hands back to the Send panel, which runs the existing verify + send flow
 * (including the ownership block) and surfaces status inline.
 *
 * It renders through `Modal`'s body portal, so stacking it above the Share
 * dialog's own modal is fine.
 */

import {
  OWNER_COPY,
  webhookAvatarUrl,
  type ComponentRouting,
  type WebhookOwnerKind,
} from "@/core/webhook";
import { handleDiscordLinkClick } from "@/lib/discordDeepLink";
import { useRoleInfo } from "@/core/guild/guildStore";
import type { PingSummary } from "@/core/schema/mentions";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { Switch } from "@/ui/Switch";
import { cn } from "@/lib/cn";
import styles from "./SendConfirm.module.css";

/** Owner-chip colour class, by kind — mirrors the recents list. */
const OWNER_BADGE_CLASS: Record<WebhookOwnerKind, string | undefined> = {
  bot: styles.ownerBot,
  user: styles.ownerUser,
  follower: styles.ownerFollower,
  unknown: undefined,
};

export interface SendConfirmProps {
  open: boolean;
  mode: "new" | "update";
  /** Webhook display name when known (from a verify/save or a saved entry). */
  webhookName?: string;
  /** Owner kind when known; undefined means ownership is verified on confirm. */
  ownerKind?: WebhookOwnerKind;
  /** Webhook snowflake — used to resolve the avatar from Discord's CDN. */
  webhookId?: string;
  /** Avatar hash (from a saved entry); null/undefined falls back to the default. */
  webhookAvatar?: string | null;
  /** Guild the webhook posts to, when known (verified or from a saved entry). */
  guildId?: string;
  /** Channel the webhook posts to, when known (verified or from a saved entry). */
  channelId?: string;
  /** Resolved server name, when known — shown instead of the guild snowflake. */
  guildName?: string;
  /** Resolved channel name, when known — shown (as `#name`) instead of the id. */
  channelName?: string;
  /** Target thread id, when posting into a thread. */
  threadId?: string;
  /** Message id being overwritten, in update mode. */
  messageId?: string;
  /**
   * Present when confirming a SCHEDULED post rather than an immediate send:
   * carries the human-readable local fire time. Flips the dialog's title and
   * confirm button to schedule wording and adds a "When" row. Everything else
   * (webhook/destination facts, ping summary, the never-expire toggle) is shared
   * with the send confirm unchanged — so a scheduled interactive message decides
   * permanence in exactly the same place a sent one does.
   */
  schedule?: { at: string };
  /** Who the message will ping, after `allowed_mentions`. */
  pings: PingSummary;
  /**
   * Where this message's plugin-bound components will deliver their clicks,
   * when the message has any and the webhook's owner is known. "foreign"
   * renders a can't-miss warning (the components will post but never
   * respond); "unverified" a softer caution. Undefined — and the dweeb /
   * custom-bot verdicts, which need no flag here — render nothing.
   */
  componentRouting?: ComponentRouting;
  /** Names of the plugins whose components are affected, for the warning copy. */
  pluginNames?: string[];
  /**
   * A guild-scoped plugin binding (e.g. Self Role) configured for a *different*
   * server than this webhook posts to — the component is dead on arrival there.
   * Undefined when there's no such mismatch.
   */
  pluginGuildMismatch?: {
    pluginName: string;
    /** Display name (or id) of the server the binding was set up for. */
    configuredGuildName: string;
    /** Display name of the server this webhook posts to, when known. */
    webhookGuildName?: string;
  };
  /**
   * The preview resolves @mentions / #channels / custom emoji against the
   * *connected* server, but this message posts to a different one (or none is
   * connected) — so those names may render as placeholders here. Present only
   * when the message actually carries such a token and the servers differ;
   * undefined hides the notice. The post itself is unaffected (it carries the
   * raw ids regardless of what the preview can resolve).
   */
  previewMismatch?: {
    /** Whether any server is connected at all. */
    connected: boolean;
    /** The connected server's name, when known and one is connected. */
    connectedGuildName?: string;
    /** The destination server's name, when known. */
    destinationGuildName?: string;
  };
  /**
   * The signed-out counterpart to {@link permanentOption}: the message carries
   * interactive components that expire after a few days without use, the feature is
   * available, but the user is signed out so they can't claim a never-expire
   * slot from here. Surfaces the heads-up *before* the post (the advice is
   * "sign in before sending"); `onSignIn` starts the Discord login. Undefined
   * when there's nothing to expire, the feature is off, or the user is signed
   * in (they get the "Never expire" toggle instead).
   */
  expiryNudge?: {
    /** Days the components stay clickable — the deployment's `COMPONENT_TTL_DAYS`. */
    ttlDays: number;
    onSignIn: () => void;
  };
  /**
   * The "Make permanent" control for messages with interactive components.
   * Present only when the Send panel could read the slot state (signed in,
   * slots fetched, expiry on). Undefined hides the row entirely — the
   * post-send dialog then just shows a generic expiry note.
   */
  permanentOption?: {
    used: number;
    cap: number;
    /** The update target already holds a slot — the switch starts on, and
     *  turning it off releases the slot once the update succeeds. */
    alreadyPermanent: boolean;
    checked: boolean;
    onChange: (checked: boolean) => void;
    /**
     * Every slot is taken by *other* messages: the switch gives way to a
     * "Free a slot" button that hands off to the gallery's Posted tab, where
     * a slot can be freed on a message's card.
     */
    slotsFull: boolean;
    /**
     * The slots-full hand-off: closes the whole send stack (this dialog and
     * the Share dialog hosting it) and opens the gallery's Posted tab for the
     * webhook's server. Only meaningful — and only rendered — when
     * `slotsFull`.
     */
    onManageSlots?: () => void;
    /**
     * The slots-full *upgrade* path — the positive alternative to freeing a
     * slot: closes the send stack and opens the pricing modal for this server
     * (paid tiers raise the never-expire cap: Plus 25, Pro unlimited). Only
     * rendered when `slotsFull` *and* billing is available; undefined on
     * deployments without Stripe, where freeing a slot is the only option.
     */
    onUpgrade?: () => void;
  };
  /**
   * The confirmed send is in flight. The confirm button shows a spinner and is
   * disabled (so it can't be double-fired); the dialog stays open until the
   * panel resolves the outcome and closes it.
   */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Render a short, readable list of snowflake chips, with a "+N more" tail. */
function IdChips({ prefix, ids, max = 6 }: { prefix: string; ids: string[]; max?: number }) {
  const shown = ids.slice(0, max);
  const rest = ids.length - shown.length;
  return (
    <span className={styles.chips}>
      {shown.map((id) => (
        <code key={id} className={styles.chip}>
          {prefix}
          {id}
        </code>
      ))}
      {rest > 0 ? <span className={styles.chipMore}>+{rest} more</span> : null}
    </span>
  );
}

/**
 * A single role chip. Resolves `<@&id>` to `@role-name` against the connected
 * server (mirroring the preview's role mentions); falls back to the raw `@&id`
 * snowflake when no server is connected or the role is unknown.
 */
function RoleChip({ id }: { id: string }) {
  const role = useRoleInfo(id);
  return <code className={styles.chip}>{role ? `@${role.name}` : `@&${id}`}</code>;
}

/** Render a short list of role chips with a "+N more" tail, names resolved. */
function RoleChips({ ids, max = 6 }: { ids: string[]; max?: number }) {
  const shown = ids.slice(0, max);
  const rest = ids.length - shown.length;
  return (
    <span className={styles.chips}>
      {shown.map((id) => (
        <RoleChip key={id} id={id} />
      ))}
      {rest > 0 ? <span className={styles.chipMore}>+{rest} more</span> : null}
    </span>
  );
}

function PingSummaryView({ pings }: { pings: PingSummary }) {
  const { everyone, roleIds, userIds, suppressed } = pings;
  const hasSuppressed =
    suppressed.everyone || suppressed.roleIds.length > 0 || suppressed.userIds.length > 0;

  if (!pings.willPing) {
    return (
      <div className={styles.pingCalm} role="note">
        <strong>No one will be pinged.</strong>
        <p className={styles.pingDetail}>
          {pings.hasMentions
            ? "Mentions are written in the text, but allowed-mentions settings stop them resolving."
            : "This message contains no @everyone, role, or user mentions."}
        </p>
      </div>
    );
  }

  return (
    <div className={styles.pingAlert} role="alert">
      <strong>This will ping:</strong>
      <ul className={styles.pingList}>
        {everyone ? (
          <li>
            <span className={styles.pingEveryone}>@everyone / @here</span> — the whole channel.
          </li>
        ) : null}
        {roleIds.length > 0 ? (
          <li>
            {roleIds.length} role{roleIds.length === 1 ? "" : "s"}: <RoleChips ids={roleIds} />
          </li>
        ) : null}
        {userIds.length > 0 ? (
          <li>
            {userIds.length} user{userIds.length === 1 ? "" : "s"}:{" "}
            <IdChips prefix="@" ids={userIds} />
          </li>
        ) : null}
      </ul>
      {hasSuppressed ? (
        <p className={styles.pingDetail}>
          Other mentions in the text won’t ping (filtered by allowed-mentions).
        </p>
      ) : null}
      {pings.suppressNotifications ? (
        <p className={styles.pingDetail}>
          Silent send is on — recipients are mentioned but get no notification.
        </p>
      ) : null}
    </div>
  );
}

/** The "Make permanent" row: title + state sub-line + the switch. */
function PermanentOptIn({
  option,
  busy,
}: {
  option: NonNullable<SendConfirmProps["permanentOption"]>;
  busy: boolean;
}) {
  const { used, cap, alreadyPermanent, checked, onChange, slotsFull, onManageSlots, onUpgrade } =
    option;

  const sub = slotsFull
    ? onUpgrade
      ? `All ${cap} never-expire slots are in use — upgrade for more, or free one to use it here`
      : `All ${cap} never-expire slots are used by other messages — free one to use it here`
    : alreadyPermanent && !checked
      ? "Frees its slot — buttons & selects can expire again"
      : `Buttons & selects keep working · ${used}/${cap} slots used`;

  return (
    <div className={styles.permanentBox}>
      <div className={styles.permanentRow}>
        <span className={styles.permanentCopy} id="send-confirm-permanent">
          <span className={styles.permanentTitle}>Never expire</span>
          <span className={styles.permanentSub}>{sub}</span>
        </span>
        {!slotsFull ? (
          <Switch
            aria-labelledby="send-confirm-permanent"
            checked={checked}
            disabled={busy}
            onChange={(e) => onChange(e.currentTarget.checked)}
          />
        ) : null}
      </div>
      {slotsFull && (onUpgrade || onManageSlots) ? (
        <div className={styles.permanentAction}>
          {/* Upgrade is the primary, positive path (raises the cap for every
              future message); freeing a slot stays as the secondary escape for
              users who don't want to pay. */}
          {onUpgrade ? (
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              title="Plus lifts this to 25 never-expire messages; Pro makes it unlimited"
              onClick={onUpgrade}
            >
              Upgrade for more
            </Button>
          ) : null}
          {onManageSlots ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              title="Closes this dialog and opens the posted-messages gallery, where each card has a Free slot button — the send isn't lost, your message and webhook stay in the panel"
              onClick={onManageSlots}
            >
              Free a slot…
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The plugin-routing verdict, when it's bad news. "foreign" = the webhook's
 * owning app — not DWEEB, not a registered custom bot — receives every click,
 * so the plugin components will post but never respond. "unverified" = that
 * couldn't be ruled out.
 */
function RoutingNotice({
  routing,
  webhookName,
  pluginNames,
}: {
  routing: ComponentRouting;
  webhookName: string;
  pluginNames: string[];
}) {
  const what =
    pluginNames.length > 0 ? `${pluginNames.join(" / ")} components` : "plugin components";

  if (routing === "foreign") {
    return (
      <div className={styles.routingAlert} role="alert">
        <strong>The {what} here won’t respond.</strong>
        <p className={styles.pingDetail}>
          Clicks go to whichever app owns the webhook, and “{webhookName}” belongs to a different
          app — not DWEEB or one of this server’s custom bots. Post through a webhook created in
          DWEEB to make them work.
        </p>
      </div>
    );
  }
  if (routing === "unverified") {
    return (
      <div className={styles.routingNote} role="note">
        <strong>Couldn’t confirm the {what} reach DWEEB.</strong>
        <p className={styles.pingDetail}>
          “{webhookName}” is app-owned, but we couldn’t check whether that app sends clicks to
          DWEEB. If it isn’t DWEEB or one of this server’s custom bots, the components will post but
          never respond.
        </p>
      </div>
    );
  }
  return null;
}

/**
 * The preview resolves @mentions / #channels / custom emoji to names against
 * the *connected* server, but this message posts somewhere else (or no server
 * is connected) — so those names may render as placeholders in the preview.
 * Cosmetic only: the post carries the raw ids regardless of what's resolved.
 */
function PreviewMismatchNotice({
  connected,
  connectedGuildName,
  destinationGuildName,
}: NonNullable<SendConfirmProps["previewMismatch"]>) {
  return (
    <div className={styles.routingNote} role="note">
      <strong>Preview names may be placeholders.</strong>
      <p className={styles.pingDetail}>
        {connected ? (
          <>
            You’re connected to <strong>{connectedGuildName ?? "a different server"}</strong>, so
            the @mentions, #channels and custom emoji in the preview may not match{" "}
            {destinationGuildName ? <strong>{destinationGuildName}</strong> : "where this posts"}.
            What posts to Discord is unaffected.
          </>
        ) : (
          <>
            No server is connected, so the @mentions, #channels and custom emoji in the preview may
            show placeholder names. What posts to Discord is unaffected.
          </>
        )}
      </p>
    </div>
  );
}

/**
 * Signed-out expiry heads-up: this message's interactive components stop working
 * once they go unused for a few days, unless it claims a never-expire slot —
 * which needs a signed-in session. Shown *before* the post so the "sign in
 * before sending" advice is still actionable — the signed-in path gets the
 * {@link PermanentOptIn} toggle instead.
 */
function ExpiryNudge({ ttlDays, onSignIn }: NonNullable<SendConfirmProps["expiryNudge"]>) {
  return (
    <div className={styles.routingNote} role="note">
      <strong>
        Buttons &amp; selects stop working after {ttlDays} day{ttlDays === 1 ? "" : "s"} without
        use.
      </strong>
      <p className={styles.pingDetail}>
        Sign in before sending to make this message never expire and keep them clickable.
      </p>
      <div className={styles.permanentAction}>
        <Button size="sm" variant="secondary" onClick={onSignIn}>
          Sign in with Discord
        </Button>
      </div>
    </div>
  );
}

export function SendConfirm({
  open,
  mode,
  webhookName,
  ownerKind,
  webhookId,
  webhookAvatar,
  guildId,
  channelId,
  guildName,
  channelName,
  threadId,
  messageId,
  schedule,
  pings,
  componentRouting,
  pluginNames = [],
  pluginGuildMismatch,
  previewMismatch,
  expiryNudge,
  permanentOption,
  busy = false,
  onConfirm,
  onCancel,
}: SendConfirmProps) {
  const hasOwner = ownerKind != null && ownerKind !== "unknown";
  const targetName = webhookName?.trim() || "this webhook";

  return (
    <Modal
      open={open}
      onClose={onCancel}
      size="sm"
      title={
        schedule
          ? "Schedule this message?"
          : mode === "update"
            ? "Update this message?"
            : "Post this message?"
      }
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            disabled={busy}
            leadingIcon={busy ? <span className={styles.spinner} aria-hidden="true" /> : undefined}
          >
            {busy
              ? schedule
                ? "Scheduling…"
                : mode === "update"
                  ? "Updating…"
                  : "Posting…"
              : schedule
                ? "Schedule post"
                : mode === "update"
                  ? "Update message"
                  : "Post message"}
          </Button>
        </>
      }
    >
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>Action</dt>
          <dd>
            {schedule
              ? "Schedule this message to post later"
              : mode === "update"
                ? "Edit a message you already posted"
                : "Post a new message"}
          </dd>
        </div>
        {schedule ? (
          <div className={styles.fact}>
            <dt>When</dt>
            <dd>
              <span className={styles.destName}>{schedule.at}</span>
            </dd>
          </div>
        ) : null}
        <div className={styles.fact}>
          <dt>Webhook</dt>
          <dd>
            <div className={styles.webhook}>
              {webhookId ? (
                <img
                  className={styles.avatar}
                  src={webhookAvatarUrl(webhookId, webhookAvatar)}
                  alt=""
                  loading="lazy"
                  onError={(e) => {
                    const img = e.currentTarget;
                    const fallback = webhookAvatarUrl(webhookId, null);
                    if (img.src !== fallback) img.src = fallback;
                  }}
                />
              ) : null}
              <span className={styles.webhookName}>{targetName}</span>
              {hasOwner ? (
                <span
                  className={cn(styles.badge, OWNER_BADGE_CLASS[ownerKind!])}
                  title={OWNER_COPY[ownerKind!].label}
                >
                  {OWNER_COPY[ownerKind!].badge}
                </span>
              ) : null}
            </div>
            {!hasOwner ? (
              <div className={styles.muted}>Ownership is verified when you confirm.</div>
            ) : null}
          </dd>
        </div>
        {guildId || guildName ? (
          <div className={styles.fact}>
            <dt>Server</dt>
            <dd>
              {guildName ? (
                <span className={styles.destName} title={guildId}>
                  {guildName}
                </span>
              ) : (
                <code className={styles.chip}>{guildId}</code>
              )}
            </dd>
          </div>
        ) : null}
        {channelId || channelName ? (
          <div className={styles.fact}>
            <dt>Channel</dt>
            <dd>
              {channelName ? (
                <span className={styles.destName} title={channelId}>
                  #{channelName}
                </span>
              ) : (
                <code className={styles.chip}>{channelId}</code>
              )}
              {guildId && channelId ? (
                <a
                  className={styles.openChannel}
                  href={`https://discord.com/channels/${guildId}/${channelId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  // Plain click opens the desktop app (falls back to web);
                  // modified clicks keep their native open-in-new-tab behaviour.
                  onClick={(e) =>
                    handleDiscordLinkClick(
                      e,
                      `https://discord.com/channels/${guildId}/${channelId}`,
                    )
                  }
                >
                  Open ↗
                </a>
              ) : null}
            </dd>
          </div>
        ) : null}
        {threadId ? (
          <div className={styles.fact}>
            <dt>Thread</dt>
            <dd>
              <code className={styles.chip}>{threadId}</code>
            </dd>
          </div>
        ) : null}
        {mode === "update" && messageId ? (
          <div className={styles.fact}>
            <dt>Message</dt>
            <dd>
              <code className={styles.chip}>{messageId}</code>
            </dd>
          </div>
        ) : null}
      </dl>

      {previewMismatch ? <PreviewMismatchNotice {...previewMismatch} /> : null}

      {componentRouting ? (
        <RoutingNotice
          routing={componentRouting}
          webhookName={targetName}
          pluginNames={pluginNames}
        />
      ) : null}

      {pluginGuildMismatch ? (
        <div className={styles.routingAlert} role="alert">
          <strong>Wrong server for this {pluginGuildMismatch.pluginName} menu.</strong>
          <p className={styles.pingDetail}>
            It was set up for {pluginGuildMismatch.configuredGuildName}, but “{targetName}” posts to{" "}
            {pluginGuildMismatch.webhookGuildName ?? "another server"}. Clicks here would do
            nothing. Post through a webhook in {pluginGuildMismatch.configuredGuildName}, or set the
            menu up for this server.
          </p>
        </div>
      ) : null}

      {permanentOption ? <PermanentOptIn option={permanentOption} busy={busy} /> : null}

      {expiryNudge ? <ExpiryNudge {...expiryNudge} /> : null}

      <PingSummaryView pings={pings} />
    </Modal>
  );
}
