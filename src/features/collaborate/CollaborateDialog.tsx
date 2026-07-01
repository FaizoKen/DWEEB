/**
 * "Collaborate in Discord" dialog.
 *
 * Real-time co-editing lives only in the embedded Discord Activity, and an
 * Activity is only *shared* when several people are in the same instance — which
 * happens when they're in the same **voice channel**. A bare
 * `discord.com/activities/{id}` launch drops a lone user into a solo call (a bot
 * DM), so there's no one to collaborate with. This dialog fixes that: it mints a
 * Discord **Activity invite** for a voice channel (proxy → bot →
 * `POST /channels/{id}/invites`), handing back a `discord.gg/…` link that launches
 * DWEEB *inside that channel*. Everyone who opens it lands in the same instance
 * and co-edits live.
 *
 * It operates on the connected server (like Send), reading its voice channels
 * straight from `guildStore`. Self-contained: it reads open/close state from
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
import { activityLaunchUrl } from "@/core/guild/config";
import {
  createActivityInvite,
  GuildApiError,
  isAuthError,
  type ActivityInvite,
} from "@/core/guild/api";
import { useCollaborateStore } from "./collaborateStore";
import styles from "./CollaborateDialog.module.css";

/** GUILD_VOICE — the only channel kind an Activity invite can target. */
const VOICE_CHANNEL_TYPE = 2;

export function CollaborateDialog() {
  const close = useCollaborateStore((s) => s.closeCollaborate);

  const authStatus = useAuthStore((s) => s.status);
  const login = useAuthStore((s) => s.login);
  const guilds = useAuthStore((s) => s.guilds);

  const connectedId = useGuildStore((s) => s.guildId);
  const guildData = useGuildStore((s) => s.data);
  const guildStatus = useGuildStore((s) => s.status);
  const guildName = guilds.find((g) => g.id === connectedId)?.name ?? null;

  const voiceChannels = useMemo(
    () =>
      (guildData?.channels ?? [])
        .filter((c) => c.type === VOICE_CHANNEL_TYPE)
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
    [guildData],
  );

  const [channelId, setChannelId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<ActivityInvite | null>(null);

  // Default to the first voice channel once the list resolves, and keep the
  // selection valid if the connected server (and its channels) changes.
  useEffect(() => {
    if (!voiceChannels.length) return;
    setChannelId((cur) => (voiceChannels.some((c) => c.id === cur) ? cur : voiceChannels[0]!.id));
  }, [voiceChannels]);

  const selectedChannel = voiceChannels.find((c) => c.id === channelId) ?? null;

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
  // Resolve which view (and footer) to show: sign-in, no server, no voice
  // channel, the picker, or the finished link.

  const resolvingAuth = authStatus === "unknown" || authStatus === "loading";
  const signedOut = authStatus === "anon";
  const loadingGuild = !guildData && guildStatus === "loading";
  const noServer = !resolvingAuth && !signedOut && !connectedId && !loadingGuild;
  const noVoice = Boolean(connectedId) && guildStatus !== "loading" && voiceChannels.length === 0;
  const canPick = voiceChannels.length > 0;

  const launcher = activityLaunchUrl();

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
        Live co-editing runs inside a Discord <strong>voice channel</strong>. Create a link below
        and everyone who opens it joins that channel with DWEEB launched — you build the message
        together in real time.
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
      ) : noVoice ? (
        <p className={styles.note}>
          {guildName ? <strong>{guildName}</strong> : "This server"} has no voice channels.
          Collaboration launches DWEEB inside one — create a voice channel in Discord, then try
          again.
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
                  <strong>🔊 {selectedChannel.name}</strong>
                </>
              ) : (
                " the voice channel"
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
            label="Voice channel"
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
                {voiceChannels.map((c) => (
                  <option key={c.id} value={c.id}>
                    🔊 {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {error ? <p className={styles.error}>{error}</p> : null}
        </>
      ) : null}

      {launcher && !invite ? (
        <p className={styles.fine}>
          Already sitting in a voice channel?{" "}
          <a href={launcher} target="_blank" rel="noopener noreferrer">
            Launch DWEEB there directly
          </a>
          .
        </p>
      ) : null}
    </Modal>
  );
}
