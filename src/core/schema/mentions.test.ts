import { describe, expect, it } from "vitest";
import { mergeAllowedMentions, summarizePings, webhookMentionParse } from "./mentions";
import { ComponentType, type AllowedMentions, type WebhookMessage } from "./types";

const ROLE = "123456789012345678";
const USER = "234567890123456789";
const OTHER_USER = "345678901234567890";

function message(allowed_mentions?: AllowedMentions): WebhookMessage {
  return {
    allowed_mentions,
    components: [
      {
        _id: "mention-text",
        type: ComponentType.TextDisplay,
        content: `@everyone @here <@&${ROLE}> <@${USER}> <@!${OTHER_USER}>`,
      },
    ],
  };
}

describe("webhook mention policy", () => {
  it("reports only users as eligible under Discord's omitted webhook policy", () => {
    expect(webhookMentionParse(undefined)).toEqual(["users"]);
    expect(summarizePings(message())).toMatchObject({
      willPing: true,
      everyone: false,
      roleIds: [],
      userIds: [USER, OTHER_USER],
      suppressed: { everyone: true, roleIds: [ROLE], userIds: [] },
    });
  });

  it("keeps all mentions suppressed when the last enabled chip is switched off", () => {
    const policy = mergeAllowedMentions(undefined, { parse: [] });

    expect(policy).toEqual({ parse: [] });
    expect(webhookMentionParse(policy)).toEqual([]);
    expect(summarizePings(message(policy))).toMatchObject({
      willPing: false,
      hasMentions: true,
      suppressed: { everyone: true, roleIds: [ROLE], userIds: [USER, OTHER_USER] },
    });
  });

  it("requires an explicit whitelist for everyone and role mentions", () => {
    expect(summarizePings(message({ parse: ["everyone", "roles"] }))).toMatchObject({
      everyone: true,
      roleIds: [ROLE],
      userIds: [],
    });
  });

  it("allows only named ids when automatic parsing is disabled", () => {
    const policy = mergeAllowedMentions({ parse: [] }, { roles: [ROLE], users: [USER] });

    expect(summarizePings(message(policy))).toMatchObject({
      everyone: false,
      roleIds: [ROLE],
      userIds: [USER],
      suppressed: { everyone: true, roleIds: [], userIds: [OTHER_USER] },
    });
  });

  it("does not re-enable automatic user parsing when the last allowed id is cleared", () => {
    const original: AllowedMentions = { users: [USER] };
    const policy = mergeAllowedMentions(original, { users: undefined });

    expect(policy).toEqual({ parse: [] });
    expect(summarizePings(message(policy)).willPing).toBe(false);
    expect(original).toEqual({ users: [USER] });
  });

  it("preserves the current default when adding an explicit role whitelist", () => {
    const policy = mergeAllowedMentions(undefined, { roles: [ROLE] });

    expect(policy).toEqual({ parse: ["users"], roles: [ROLE] });
    expect(summarizePings(message(policy))).toMatchObject({
      everyone: false,
      roleIds: [ROLE],
      userIds: [USER, OTHER_USER],
    });
  });
});
