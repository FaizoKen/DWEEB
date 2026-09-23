/**
 * Post / update refuse a draft that references uploads this browser doesn't
 * hold — a teammate's, or one from before a relaunch — with a message naming
 * the way out, instead of shipping a dangling `attachment://` reference for
 * Discord to reject with a raw error. Uploads made here still post.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./collab", () => ({
  startCollab: vi.fn(),
  stopCollab: vi.fn(),
  broadcastTarget: vi.fn(),
}));
vi.mock("@/core/guild/guildStore", () => ({
  useGuildStore: { getState: () => ({ connect: vi.fn(), data: null }) },
}));
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

import { ComponentType, type WebhookMessage } from "@/core/schema/types";
import { buildSessionUrl, registerAttachment } from "@/core/state/attachmentStore";
import { useMessageStore } from "@/core/state/messageStore";
import { pushToast } from "@/ui/Toast";
import { useActivityStore } from "./activityStore";
import { editPostedMessage, publishToChannel, type ActivityPostResult } from "./api";
import { missingUploadsMessage } from "./uploads";

const GUILD = "111111111111111111";
const CHANNEL = "900000000000000001";

/** A postable draft: some text and a gallery showing `url`. */
function draftWith(url: string): WebhookMessage {
  return {
    components: [
      { _id: "t", type: ComponentType.TextDisplay, content: "Look at this" },
      { _id: "g", type: ComponentType.MediaGallery, items: [{ _id: "i", media: { url } }] },
    ],
  } as unknown as WebhookMessage;
}

const posted: ActivityPostResult = {
  message_id: "700000000000000001",
  channel_id: CHANNEL,
  guild_id: GUILD,
  url: null,
  webhook_id: "hook",
};

describe("post / update with uploads that aren't in this browser", () => {
  beforeEach(() => {
    vi.mocked(pushToast).mockReset();
    vi.mocked(publishToChannel).mockReset();
    vi.mocked(editPostedMessage).mockReset();
    useActivityStore.setState({
      context: { guildId: GUILD, channelId: CHANNEL, instanceId: "inst" },
      targetGuildId: GUILD,
      targetChannelId: CHANNEL,
      botMissing: false,
      canPostToTarget: true,
      publishing: false,
      lastPost: null,
    });
  });

  it("refuses to post and says why", async () => {
    useMessageStore.setState({ message: draftWith(buildSessionUrl("teammates", "photo.png")) });
    await expect(useActivityStore.getState().publish()).resolves.toBeNull();
    expect(publishToChannel).not.toHaveBeenCalled();
    expect(pushToast).toHaveBeenCalledWith(missingUploadsMessage(1), "error", expect.anything());
  });

  it("refuses to update the posted message too", async () => {
    useActivityStore.setState({ lastPost: posted });
    useMessageStore.setState({ message: draftWith(buildSessionUrl("teammates", "photo.png")) });
    await expect(useActivityStore.getState().update()).resolves.toBeNull();
    expect(editPostedMessage).not.toHaveBeenCalled();
    expect(pushToast).toHaveBeenCalledWith(missingUploadsMessage(1), "error", expect.anything());
  });

  it("still posts an upload made in this browser", async () => {
    const mine = registerAttachment(new File(["png"], "mine.png", { type: "image/png" }));
    useMessageStore.setState({ message: draftWith(mine) });
    vi.mocked(publishToChannel).mockResolvedValueOnce(posted);
    await expect(useActivityStore.getState().publish()).resolves.toEqual(posted);
    const files = vi.mocked(publishToChannel).mock.calls[0]?.[5];
    expect(files?.map((f) => f.filename)).toEqual(["mine.png"]);
  });
});
