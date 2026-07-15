import { describe, expect, it } from "vitest";
import { isSpaNavigationPath } from "./navigationRoutes";

describe("PWA navigation fallback", () => {
  it.each([
    "/",
    "/?template=welcome",
    "/?entry=guide%3Adiscord-components-v2",
    "/s/abc1",
    "/s/A9zX20/",
    "/s/A9zX20?mode=edit",
  ])("serves the app shell for %s", (path) => {
    expect(isSpaNavigationPath(path)).toBe(true);
  });

  it.each([
    "/templates",
    "/templates/discord-welcome-message/",
    "/features/discord-ticket-bot/",
    "/guides/discord-components-v2/",
    "/discord-webhook-builder/",
    "/privacy",
    "/sitemap.xml",
    "/s/abc",
    "/s/this-id-is-far-too-long",
  ])("leaves the real static/network response in control for %s", (path) => {
    expect(isSpaNavigationPath(path)).toBe(false);
  });
});
