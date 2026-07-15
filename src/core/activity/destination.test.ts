/**
 * The Activity's post destination — where a post goes, and what the collaboration
 * room is told about it.
 *
 * The room is keyed to the server the Activity launched in, and its shared
 * destination frame carries a channel id and nothing else. So the destination
 * *server* is fixed for the whole session: a post aimed at another server couldn't
 * be shared with the people you're editing with — they may not even be members of
 * it, and a channel id from it would mean nothing to them (or, worse, name one of
 * *their* channels). Only the channel moves, and it moves for everyone. These
 * tests pin that boundary: the launching guild can't be swapped, a channel change
 * reaches the room, and the only launch kind that picks a server is a DM (which has
 * no room destination to share in the first place).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { broadcastTargetMock, connectMock } = vi.hoisted(() => ({
  broadcastTargetMock: vi.fn(),
  connectMock: vi.fn(),
}));

vi.mock("./collab", () => ({
  startCollab: vi.fn(),
  stopCollab: vi.fn(),
  broadcastTarget: broadcastTargetMock,
}));
vi.mock("@/core/guild/guildStore", () => ({
  useGuildStore: { getState: () => ({ connect: connectMock }) },
}));
// Inert stand-ins for the modules the store only touches during a real launch —
// they reach for the Discord SDK / proxy, which no destination change goes near.
vi.mock("./sdk", () => ({
  configureUrlMappings: vi.fn(),
  getSdk: vi.fn(),
  openExternalLink: vi.fn(),
  openInviteDialog: vi.fn(),
  shareActivityLink: vi.fn(),
  setActivityPresence: vi.fn(),
  subscribeLayoutMode: vi.fn(),
  LAYOUT_MODE_PIP: "pip",
}));
vi.mock("./api", () => ({
  editPostedMessage: vi.fn(),
  exchangeCode: vi.fn(),
  publishToChannel: vi.fn(),
  restorePostedMessage: vi.fn(),
  schedulePostToChannel: vi.fn(),
}));
vi.mock("@/ui/Toast", () => ({ pushToast: vi.fn() }));

import { useActivityStore } from "./activityStore";
import { restorePostedMessage } from "./api";
import type { PickerGuild } from "@/core/guild/api";

const LAUNCH_GUILD = "111111111111111111";
const OTHER_GUILD = "222222222222222222";
const LAUNCH_CHANNEL = "900000000000000001";
const ROOM_CHANNEL = "900000000000000002";
const OTHER_CHANNEL = "900000000000000003";

/** The launching server as the bar's badge sees it: postable (bot in, can post). */
const launchGuild: PickerGuild = {
  id: LAUNCH_GUILD,
  name: "Launch server",
  icon: null,
  bot_present: true,
  can_manage_webhooks: true,
};
/** Another server the user can post to — the destination a DM launch picks. */
const otherGuild: PickerGuild = {
  id: OTHER_GUILD,
  name: "Other server",
  icon: null,
  bot_present: true,
  can_manage_webhooks: true,
};

/** A settled server launch: posting into the launching server's channel.
 *  `overrides` bend it into the state under test. */
function seedServerLaunch(overrides: Parameters<typeof useActivityStore.setState>[0] = {}) {
  useActivityStore.setState({
    context: { guildId: LAUNCH_GUILD, channelId: LAUNCH_CHANNEL, instanceId: "inst" },
    targetGuildId: LAUNCH_GUILD,
    targetChannelId: LAUNCH_CHANNEL,
    targetGuildMeta: launchGuild,
    // A server launch has a fixed destination, so it never loads a server list.
    guilds: [],
    botMissing: false,
    canPostToTarget: true,
    ...overrides,
  });
}

/** A DM / group-DM launch: no guild of its own, so a destination server must be
 *  picked from the postable list before anything can be posted. */
function seedDmLaunch() {
  useActivityStore.setState({
    context: { guildId: null, channelId: "dm", instanceId: "inst" },
    targetGuildId: null,
    targetChannelId: null,
    targetGuildMeta: null,
    guilds: [otherGuild],
    botMissing: false,
    canPostToTarget: null,
  });
}

describe("activity post destination", () => {
  beforeEach(() => {
    broadcastTargetMock.mockReset();
    connectMock.mockReset();
  });

  it("shares a channel change with the room", () => {
    seedServerLaunch();
    useActivityStore.getState().setTargetChannel(ROOM_CHANNEL);
    expect(useActivityStore.getState().targetChannelId).toBe(ROOM_CHANNEL);
    expect(broadcastTargetMock).toHaveBeenCalledWith(ROOM_CHANNEL);
  });

  it("restoring from a sibling channel moves the room there — on success", async () => {
    seedServerLaunch();
    // The restored message really is in the other channel (a different channel in
    // the *same* server, which the dialog confirmed switching to).
    vi.mocked(restorePostedMessage).mockResolvedValueOnce({
      message: { components: [] },
      message_id: "700000000000000001",
      channel_id: OTHER_CHANNEL,
      guild_id: LAUNCH_GUILD,
      url: null,
      webhook_id: "hook",
      application_id: null,
      thread_id: null,
    });

    await useActivityStore
      .getState()
      .restore(`https://discord.com/channels/${LAUNCH_GUILD}/${OTHER_CHANNEL}/700000000000000001`, {
        switchToChannelId: OTHER_CHANNEL,
      });

    const s = useActivityStore.getState();
    // Read from the sibling channel, not the room's original one…
    expect(restorePostedMessage).toHaveBeenCalledWith(
      LAUNCH_GUILD,
      OTHER_CHANNEL,
      "700000000000000001",
      null,
    );
    // …and now the room follows to it (shared, so the move reaches everyone), with
    // the toolbar wired to update the restored message in place.
    expect(s.targetChannelId).toBe(OTHER_CHANNEL);
    expect(broadcastTargetMock).toHaveBeenCalledWith(OTHER_CHANNEL);
    expect(s.lastPost?.channel_id).toBe(OTHER_CHANNEL);
  });

  it("a failed sibling-channel restore leaves the room where it was", async () => {
    seedServerLaunch();
    vi.mocked(restorePostedMessage).mockRejectedValueOnce(new Error("not found"));

    await expect(
      useActivityStore
        .getState()
        .restore(
          `https://discord.com/channels/${LAUNCH_GUILD}/${OTHER_CHANNEL}/700000000000000001`,
          {
            switchToChannelId: OTHER_CHANNEL,
          },
        ),
    ).rejects.toThrow("not found");

    // The room never moved — a miss must not strand it on a channel it never
    // posted in (the switch only commits once Discord confirms the message).
    const s = useActivityStore.getState();
    expect(s.targetChannelId).toBe(LAUNCH_CHANNEL);
    expect(broadcastTargetMock).not.toHaveBeenCalled();
  });

  it("keeps the destination server fixed to the launching guild", () => {
    seedServerLaunch();
    // Nothing in the bar offers this on a guild launch (the server is a static
    // badge), and the store refuses it too: the room could not follow the post to
    // another server, so the two must never come apart.
    useActivityStore.getState().setTargetGuild(OTHER_GUILD);

    const s = useActivityStore.getState();
    expect(s.targetGuildId).toBe(LAUNCH_GUILD);
    expect(s.targetChannelId).toBe(LAUNCH_CHANNEL);
    expect(s.targetGuildMeta).toEqual(launchGuild);
    // No other server's channels/emoji are loaded — the preview stays resolved
    // against the server everyone in the room is actually in.
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("keeps the destination server fixed even when the launching guild lacks the bot", () => {
    // The "Add DWEEB" state: nothing to post into yet. The way out is adding the
    // bot (the bar's CTA), never re-pointing the post at a server that has it.
    const botless: PickerGuild = { ...launchGuild, bot_present: false, can_manage_webhooks: false };
    seedServerLaunch({
      targetGuildMeta: botless,
      targetChannelId: null,
      botMissing: true,
      canPostToTarget: false,
    });

    useActivityStore.getState().setTargetGuild(OTHER_GUILD);

    const s = useActivityStore.getState();
    expect(s.targetGuildId).toBe(LAUNCH_GUILD);
    expect(s.botMissing).toBe(true);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("an edit-only collaborator never moves the room's destination", () => {
    // No Manage Webhooks in the launching server: they can edit, not post — so
    // even a channel change (the picker is read-only for them; this is the store's
    // own guard) stays off the wire.
    seedServerLaunch({ canPostToTarget: false });
    useActivityStore.getState().setTargetChannel(ROOM_CHANNEL);
    expect(broadcastTargetMock).not.toHaveBeenCalled();
  });

  it("a DM launch picks its destination server — the one launch kind that does", () => {
    seedDmLaunch();
    useActivityStore.getState().setTargetGuild(OTHER_GUILD);

    const s = useActivityStore.getState();
    expect(s.targetGuildId).toBe(OTHER_GUILD);
    expect(s.targetGuildMeta).toEqual(otherGuild);
    // The picked server's channels are a fresh set — no channel until one's chosen.
    expect(s.targetChannelId).toBeNull();
    // `guilds` is pre-filtered to servers the user can post to.
    expect(s.canPostToTarget).toBe(true);
    // Its channels/emoji load for the picker and preview.
    expect(connectMock).toHaveBeenCalledWith(OTHER_GUILD);

    useActivityStore.getState().setTargetChannel(OTHER_CHANNEL);
    expect(useActivityStore.getState().targetChannelId).toBe(OTHER_CHANNEL);
    // Nothing reaches the room: a DM's peers share no postable server, so there's
    // no destination to agree on. (That no-op is collab's — `broadcastTarget`
    // needs a room guild to send into — which is mocked out here.)
  });
});
