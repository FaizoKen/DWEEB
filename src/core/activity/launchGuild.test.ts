/**
 * The Activity's guild data belongs to the server it launched in. The guild
 * store hydrates the last-connected server from localStorage at module load —
 * the web app's "pick up where you left off" — and inside Discord nothing used to
 * reset it: on a launch where the bot is missing (or a DM launch before a server
 * is picked) `connect()` never runs, so a previous session's server kept serving
 * the editor its roles, channels and emoji, and a plugin config's `"guild"`
 * resource named the wrong server.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GuildData } from "@/core/guild/types";

const LAUNCH_GUILD = "111111111111111111";
const CACHED_OTHER_GUILD = "222222222222222222";

const sdk = vi.hoisted(() => ({
  ready: vi.fn(async () => {}),
  platform: "desktop",
  guildId: "111111111111111111" as string | null,
  channelId: "900000000000000001",
  instanceId: "i-abc-gc-111111111111111111-900000000000000001",
  commands: {
    authorize: vi.fn(async () => ({ code: "code" })),
    authenticate: vi.fn(async () => ({
      user: { id: "u1", username: "me", global_name: "Me", avatar: null },
    })),
  },
}));
const userGuilds = vi.hoisted(() => ({
  botPresent: false,
}));

vi.mock("./sdk", () => ({
  configureUrlMappings: vi.fn(),
  getSdk: () => sdk,
  openExternalLink: vi.fn(),
  openInviteDialog: vi.fn(),
  shareActivityLink: vi.fn(),
  setActivityPresence: vi.fn(async () => {}),
  subscribeLayoutMode: vi.fn(),
  LAYOUT_MODE_PIP: 2,
}));
vi.mock("./api", () => ({
  editPostedMessage: vi.fn(),
  exchangeCode: vi.fn(async () => "token"),
  publishToChannel: vi.fn(),
  restorePostedMessage: vi.fn(),
  schedulePostToChannel: vi.fn(),
  mintRoomTicket: vi.fn(async () => "ticket"),
}));
vi.mock("./collab", () => ({
  startCollab: vi.fn(),
  stopCollab: vi.fn(),
  broadcastTarget: vi.fn(),
}));
vi.mock("@/core/guild/api", async (orig) => ({
  ...(await orig<typeof import("@/core/guild/api")>()),
  fetchUserGuilds: vi.fn(async () => [
    {
      id: "111111111111111111",
      name: "Launch",
      icon: null,
      bot_present: userGuilds.botPresent,
      can_manage_webhooks: true,
    },
  ]),
  // A present bot bootstraps the launching server; keep it from reaching a proxy.
  fetchBootstrap: vi.fn(() => new Promise(() => {})),
}));
vi.mock("@/ui/Toast", () => ({ pushToast: vi.fn() }));

/**
 * Each test re-imports the Activity store's whole module graph after
 * `vi.resetModules()` (~3 s alone, longer under a loaded full-suite run), so the
 * default 5 s timeout made them flaky without anything actually hanging.
 */
const FRESH_IMPORT_TIMEOUT_MS = 30_000;

/** Fresh store modules per test — `init()` runs once per page. */
async function freshStores() {
  vi.resetModules();
  const { useGuildStore } = await import("@/core/guild/guildStore");
  const { useActivityStore } = await import("./activityStore");
  return { useGuildStore, useActivityStore };
}

function cachedGuild(guildId: string): GuildData {
  const role = { id: `r-${guildId}`, name: "Mods", color: 0, position: 1, mentionable: true };
  return {
    guildId,
    roles: [role],
    channels: [],
    emojis: [],
    roleById: { [role.id]: role },
    channelById: {},
    emojiById: {},
    fetchedAt: Date.now(),
  };
}

describe("the Activity's guild data across launches", () => {
  beforeEach(() => {
    // `init()` reads the launch query (dev override check) and stamps the
    // platform on <html>; give it the minimum DOM it touches.
    vi.stubGlobal("window", {
      location: { search: "?frame_id=f" },
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
  });

  it(
    "never serves another server's cached data in a launch where the bot is missing",
    async () => {
      const { useGuildStore, useActivityStore } = await freshStores();
      userGuilds.botPresent = false;
      useGuildStore.setState({
        guildId: CACHED_OTHER_GUILD,
        status: "ready",
        error: null,
        data: cachedGuild(CACHED_OTHER_GUILD),
      });
      await useActivityStore.getState().init();
      await vi.waitFor(() =>
        expect(useActivityStore.getState().targetGuildMetaLoading).toBe(false),
      );

      expect(useActivityStore.getState().botMissing).toBe(true);
      expect(useGuildStore.getState().data).toBeNull();
      expect(useGuildStore.getState().guildId).toBe("");
    },
    FRESH_IMPORT_TIMEOUT_MS,
  );

  it(
    "keeps the launching server's own cache to show while it refreshes",
    async () => {
      const { useGuildStore, useActivityStore } = await freshStores();
      userGuilds.botPresent = true;
      useGuildStore.setState({
        guildId: LAUNCH_GUILD,
        status: "ready",
        error: null,
        data: cachedGuild(LAUNCH_GUILD),
      });
      await useActivityStore.getState().init();
      await vi.waitFor(() =>
        expect(useActivityStore.getState().targetGuildMetaLoading).toBe(false),
      );

      expect(useGuildStore.getState().guildId).toBe(LAUNCH_GUILD);
      expect(useGuildStore.getState().data?.guildId).toBe(LAUNCH_GUILD);
    },
    FRESH_IMPORT_TIMEOUT_MS,
  );
});
