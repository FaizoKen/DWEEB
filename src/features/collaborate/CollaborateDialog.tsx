/**
 * "Collaborate in Discord" dialog.
 *
 * Real-time co-editing lives only in the embedded Discord Activity, and an
 * Activity is only *shared* when several people are in the same instance. A bare
 * `discord.com/activities/{id}` launch drops a lone user into a solo call (a bot
 * DM), so there's no one to collaborate with. This dialog fixes that: it mints a
 * Discord **Activity invite** for a channel (proxy → bot →
 * `POST /channels/{id}/invites`, `target_type=2`), handing back a `discord.gg/…`
 * link that launches DWEEB *inside that channel*. Everyone who opens it lands in
 * the same instance and co-edits live. Discord accepts these invites in both
 * **text and voice channels** (confirmed against the live API), so the picker
 * offers both — the proxy leaves the final say to Discord rather than hardcoding
 * a channel-type rule.
 *
 * It operates on the connected server (like Send), reading its channels straight
 * from `guildStore`. Self-contained: it reads open/close state from
 * `collaborateStore`, so any entry point just calls `openCollaborate()`.
 */

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { Select } from "@/ui/Select";
import { TextInput } from "@/ui/TextInput";
import { CheckCircleIcon, CopyIcon, ExternalLinkIcon, LogInIcon, UsersIcon } from "@/ui/Icon";
import { pushToast } from "@/ui/Toast";
import { copyText } from "@/core/serialization/clipboard";
import { useAuthStore } from "@/core/auth/authStore";
import { useGuildStore } from "@/core/guild/guildStore";
import {
  createActivityInvite,
  GuildApiError,
  isAuthError,
  type ActivityInvite,
} from "@/core/guild/api";
import { useCollaborateStore } from "./collaborateStore";
import styles from "./CollaborateDialog.module.css";

/** GUILD_VOICE — shown with a speaker glyph; everything else here is a text kind. */
const VOICE_TYPE = 2;
/** Channel kinds an Activity invite can launch in: GUILD_TEXT (0), GUILD_VOICE
 *  (2), GUILD_ANNOUNCEMENT (5). Confirmed text + voice against the live API; the
 *  proxy doesn't hard-restrict, so this is only which channels the picker offers. */
const ACTIVITY_CHANNEL_TYPES = new Set([0, VOICE_TYPE, 5]);

/** Discord's own glyph for a channel: 🔊 for voice, # for a text kind. */
function channelGlyph(type: number): string {
  return type === VOICE_TYPE ? "🔊" : "#";
}

export function CollaborateDialog() {
  const close = useCollaborateStore((s) => s.closeCollaborate);

  const authStatus = useAuthStore((s) => s.status);
  const login = useAuthStore((s) => s.login);
  const guilds = useAuthStore((s) => s.guilds);

  const connectedId = useGuildStore((s) => s.guildId);
  const guildData = useGuildStore((s) => s.data);
  const guildStatus = useGuildStore((s) => s.status);
  const guildName = guilds.find((g) => g.id === connectedId)?.name ?? null;

  const channels = useMemo(
    () =>
      (guildData?.channels ?? [])
        .filter((c) => ACTIVITY_CHANNEL_TYPES.has(c.type))
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
    [guildData],
  );

  const [channelId, setChannelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<ActivityInvite | null>(null);

  // Default to the first channel once the list resolves, and keep the selection
  // valid if the connected server (and its channels) changes.
  useEffect(() => {
    if (!channels.length) return;
    setChannelId((cur) => (channels.some((c) => c.id === cur) ? cur : channels[0]!.id));
  }, [channels]);

  const selectedChannel = channels.find((c) => c.id === channelId) ?? null;

  const pickChannel = (id: string) => {
    setChannelId(id);
    // The old link was for a different channel — drop it so the button reads
    // "Create link" again for the new pick.
    setInvite(null);
    setError(null);
  };

  const create = async () => {
    if (!connectedId || !channelId || busy) return;
    setError(null);
    setBusy(true);
    try {
      setInvite(await createActivityInvite(connectedId, channelId));
    } catch (e) {
      if (isAuthError(e)) {
        setError("Your Discord session expired — sign in again, then retry.");
      } else {
        setError(
          e instanceof GuildApiError
            ? e.message
            : "Couldn't create a collaboration link. Try again.",
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!invite) return;
    if (await copyText(invite.url)) pushToast("Collaboration link copied", "success");
    else pushToast("Copy failed — your browser blocked the clipboard.", "error");
  };

  // ── State branches ─────────────────────────────────────────────────────────
  // Resolve which view (and footer) to show: sign-in, no server, no channel, the
  // picker, or the finished link.

  const resolvingAuth = authStatus === "unknown" || authStatus === "loading";
  const signedOut = authStatus === "anon";
  const loadingGuild = !guildData && guildStatus === "loading";
  const noServer = !resolvingAuth && !signedOut && !connectedId && !loadingGuild;
  const noChannels = Boolean(connectedId) && guildStatus !== "loading" && channels.length === 0;
  const canPick = channels.length > 0;

  let footer: React.ReactNode;
  if (signedOut) {
    footer = (
      <>
        <Button variant="secondary" onClick={close}>
          Close
        </Button>
        <Button variant="primary" leadingIcon={<LogInIcon />} onClick={login}>
          Sign in with Discord
        </Button>
      </>
    );
  } else if (invite) {
    footer = (
      <>
        <Button variant="secondary" onClick={close}>
          Done
        </Button>
        <Button variant="primary" leadingIcon={<CopyIcon />} onClick={() => void copy()}>
          Copy link
        </Button>
      </>
    );
  } else if (canPick) {
    footer = (
      <>
        <Button variant="secondary" onClick={close}>
          Close
        </Button>
        <Button
          variant="primary"
          leadingIcon={<UsersIcon />}
          onClick={() => void create()}
          disabled={!channelId || busy}
        >
          {busy ? "Creating…" : "Create link"}
        </Button>
      </>
    );
  } else {
    footer = (
      <Button variant="secondary" onClick={close}>
        Close
      </Button>
    );
  }

  return (
    <Modal open onClose={close} title="Collaborate in Discord" footer={footer}>
      <p className={styles.lead}>
        Pick a channel and create a link that launches DWEEB <strong>inside</strong> it. Everyone
        who opens the link joins the same instance and builds the message together, live. A voice
        channel works too (no need to actually talk — it’s just the shared room).
      </p>

      {resolvingAuth ? (
        <p className={styles.note}>Checking your Discord session…</p>
      ) : signedOut ? (
        <p className={styles.note}>
          Sign in with Discord to create a collaboration link for one of your servers.
        </p>
      ) : loadingGuild ? (
        <p className={styles.note}>Loading your server…</p>
      ) : noServer ? (
        <p className={styles.note}>
          Connect a server first — open the account menu (top-left) and pick one the DWEEB bot is
          in.
        </p>
      ) : noChannels ? (
        <p className={styles.note}>
          {guildName ? <strong>{guildName}</strong> : "This server"} has no channels DWEEB can
          launch in. Add a text or voice channel in Discord, then try again.
        </p>
      ) : invite ? (
        <div className={styles.result}>
          <div className={styles.banner} role="status">
            <span className={styles.check} aria-hidden="true">
              <CheckCircleIcon size={20} />
            </span>
            <p className={styles.bannerText}>
              Your collaboration link is ready. Share it with your team — everyone who opens it
              joins
              {selectedChannel ? (
                <>
                  {" "}
                  <strong>
                    {channelGlyph(selectedChannel.type)} {selectedChannel.name}
                  </strong>
                </>
              ) : (
                " the channel"
              )}{" "}
              and co-edits live.
            </p>
          </div>

          <Field label="Collaboration link">
            {(id) => (
              <div className={styles.linkRow}>
                <TextInput id={id} value={invite.url} readOnly onFocus={(e) => e.target.select()} />
                <Button
                  variant="secondary"
                  leadingIcon={<ExternalLinkIcon />}
                  onClick={() => window.open(invite.url, "_blank", "noopener,noreferrer")}
                >
                  Open
                </Button>
              </div>
            )}
          </Field>

          <p className={styles.fine}>
            The link expires in about 7 days. The current draft isn’t carried into the room (it
            starts fresh) — use <strong>Share link</strong> to hand off what you’ve built.
          </p>
        </div>
      ) : canPick ? (
        <>
          <Field
            label="Channel"
            hint={
              guildName
                ? `In ${guildName}. Switch servers in the account menu (top-left).`
                : "Switch servers in the account menu (top-left)."
            }
          >
            {(id) => (
              <Select
                id={id}
                value={channelId}
                onChange={(e) => pickChannel(e.currentTarget.value)}
              >
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {channelGlyph(c.type)} {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {error ? <p className={styles.error}>{error}</p> : null}
        </>
      ) : null}

      {canPick && !invite ? (
        <p className={styles.fine}>
          Prefer to launch it yourself? In Discord, open a channel and pick DWEEB from the{" "}
          <strong>+ (Apps)</strong> menu — that launches it right in that channel, not a DM.
        </p>
      ) : null}
    </Modal>
  );
}
