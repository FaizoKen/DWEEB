/**
 * The Activity's post destination — what changes when the bar's server picker
 * moves it, and (crucially) what the collaboration room is told about it.
 *
 * The room is keyed to the server the Activity launched in, and its shared
 * destination frame carries a channel id and nothing else. So a channel is only
 * meaningful to peers while the destination is still that launching server: once a
 * composer re-points at another server, their destination is personal and must NOT
 * be broadcast — a channel id from a server the others may not even be members of
 * would silently move *their* post. These tests pin that boundary, plus the state
 * that rides along with a switch (bot presence, the post gate, the channel).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { broadcastTargetMock, roomTargetMock, connectMock } = vi.hoisted(() => ({
  broadcastTargetMock: vi.fn(),
  roomTargetMock: vi.fn<() => string | null>(),
  connectMock: vi.fn(),
}));

vi.mock("./collab", () => ({
  startCollab: vi.fn(),
  stopCollab: vi.fn(),
  broadcastTarget: broadcastTargetMock,
  roomTarget: roomTargetMock,
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
import { useAuthStore } from "@/core/auth/authStore";
import type { PickerGuild } from "@/core/guild/api";

const LAUNCH_GUILD = "111111111111111111";
const OTHER_GUILD = "222222222222222222";
const LAUNCH_CHANNEL = "900000000000000001";
const ROOM_CHANNEL = "900000000000000002";
const OTHER_CHANNEL = "900000000000000003";

/** The launching server as the picker sees it: postable (bot in, can post). */
const launchGuild: PickerGuild = {
  id: LAUNCH_GUILD,
  name: "Launch server",
  icon: null,
  bot_present: true,
  can_manage_webhooks: true,
};
/** Another server the user can post to — what a switch targets. */
const otherGuild: PickerGuild = {
  id: OTHER_GUILD,
  name: "Other server",
  icon: null,
  bot_present: true,
  can_manage_webhooks: true,
};

/** A settled server launch: posting into the launching server's channel, with the
 *  postable list loaded. `overrides` bend it into the state under test; `all` is
 *  the user's FULL guild list, which every launch seeds into the auth store and
 *  which is where a switch back to a *non*-postable launching server reads its
 *  meta from. */
function seedServerLaunch(
  overrides: Parameters<typeof useActivityStore.setState>[0] = {},
  all: PickerGuild[] = [launchGuild, otherGuild],
) {
  useAuthStore.setState({ guilds: all, guildsStatus: "ready", guildsError: null });
  useActivityStore.setState({
    context: { guildId: LAUNCH_GUILD, channelId: LAUNCH_CHANNEL, instanceId: "inst" },
    targetGuildId: LAUNCH_GUILD,
    targetChannelId: LAUNCH_CHANNEL,
    targetGuildMeta: launchGuild,
    guilds: [launchGuild, otherGuild],
    botMissing: false,
    canPostToTarget: true,
    ...overrides,
  });
}

describe("activity post destination", () => {
  beforeEach(() => {
    broadcastTargetMock.mockReset();
    connectMock.mockReset();
    roomTargetMock.mockReset();
    roomTargetMock.mockReturnValue(null);
  });

  it("shares a channel change with the room while the destination is the launching server", () => {
    seedServerLaunch();
    useActivityStore.getState().setTargetChannel(ROOM_CHANNEL);
    expect(useActivityStore.getState().targetChannelId).toBe(ROOM_CHANNEL);
    expect(broadcastTargetMock).toHaveBeenCalledWith(ROOM_CHANNEL);
  });

  it("keeps the destination off the room once it moves to another server", () => {
    seedServerLaunch();
    useActivityStore.getState().setTargetGuild(OTHER_GUILD);

    const s = useActivityStore.getState();
    expect(s.targetGuildId).toBe(OTHER_GUILD);
    expect(s.targetGuildMeta).toEqual(otherGuild);
    // The old channel belongs to the old server — it must not carry across.
    expect(s.targetChannelId).toBeNull();
    // The new server's channels/emoji load for the picker and preview.
    expect(connectMock).toHaveBeenCalledWith(OTHER_GUILD);

    // Picking a channel THERE is this composer's business alone: peers aren't in
    // that server, and the room keeps its own destination.
    useActivityStore.getState().setTargetChannel(OTHER_CHANNEL);
    expect(useActivityStore.getState().targetChannelId).toBe(OTHER_CHANNEL);
    expect(broadcastTargetMock).not.toHaveBeenCalled();
  });

  it("re-adopts the room's channel on returning to the launching server", () => {
    seedServerLaunch();
    // Meanwhile the room has moved its shared destination.
    roomTargetMock.mockReturnValue(ROOM_CHANNEL);

    useActivityStore.getState().setTargetGuild(OTHER_GUILD);
    useActivityStore.getState().setTargetGuild(LAUNCH_GUILD);

    const s = useActivityStore.getState();
    expect(s.targetGuildId).toBe(LAUNCH_GUILD);
    expect(s.targetChannelId).toBe(ROOM_CHANNEL);
    expect(s.canPostToTarget).toBe(true);
    // Back on the room's server, changes are shared again.
    useActivityStore.getState().setTargetChannel(OTHER_CHANNEL);
    expect(broadcastTargetMock).toHaveBeenCalledWith(OTHER_CHANNEL);
  });

  it("falls back to the launching channel when the room never moved", () => {
    seedServerLaunch();
    useActivityStore.getState().setTargetGuild(OTHER_GUILD);
    useActivityStore.getState().setTargetGuild(LAUNCH_GUILD);
    expect(useActivityStore.getState().targetChannelId).toBe(LAUNCH_CHANNEL);
  });

  it("switching to a server with the bot clears the Add-DWEEB state", () => {
    // Launched in a server that never had the bot: nothing to post into, so the
    // bar shows "Add DWEEB" and the postable list excludes it — though the user's
    // full guild list still knows the server (that's where its meta comes from).
    const botless: PickerGuild = { ...launchGuild, bot_present: false, can_manage_webhooks: false };
    seedServerLaunch(
      {
        targetGuildMeta: botless,
        guilds: [otherGuild],
        targetChannelId: null,
        botMissing: true,
        canPostToTarget: false,
      },
      [botless, otherGuild],
    );

    useActivityStore.getState().setTargetGuild(OTHER_GUILD);
    expect(useActivityStore.getState().botMissing).toBe(false);
    expect(useActivityStore.getState().canPostToTarget).toBe(true);
    expect(connectMock).toHaveBeenCalledWith(OTHER_GUILD);

    // Picking the bot-less launching server back restores its CTA — and doesn't
    // fetch its data (that call would just 404).
    connectMock.mockClear();
    useActivityStore.getState().setTargetGuild(LAUNCH_GUILD);
    const s = useActivityStore.getState();
    expect(s.botMissing).toBe(true);
    expect(s.canPostToTarget).toBe(false);
    expect(s.targetGuildMeta?.id).toBe(LAUNCH_GUILD);
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

  it("a DM launch has no room destination to share", () => {
    useActivityStore.setState({
      context: { guildId: null, channelId: "dm", instanceId: "inst" },
      targetGuildId: OTHER_GUILD,
      targetChannelId: null,
      targetGuildMeta: otherGuild,
      guilds: [otherGuild],
      botMissing: false,
      canPostToTarget: true,
    });
    useActivityStore.getState().setTargetChannel(OTHER_CHANNEL);
    expect(useActivityStore.getState().targetChannelId).toBe(OTHER_CHANNEL);
    expect(broadcastTargetMock).not.toHaveBeenCalled();
  });
});
