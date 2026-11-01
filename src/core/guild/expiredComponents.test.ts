import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/ui/Toast", () => ({ pushToast: vi.fn() }));

import { ButtonStyle, ComponentType, type WebhookMessage } from "@/core/schema";
import { useMessageStore } from "@/core/state/messageStore";
import { pushToast } from "@/ui/Toast";
import { offerToEnableExpired, possiblyExpiredIds } from "./expiredComponents";

const DAY_MS = 86_400_000;
const DISCORD_EPOCH_MS = 1_420_070_400_000;
const NOW = 1_793_000_000_000;

/** A message id minted at `sentMs` (Unix milliseconds). */
const idSentAt = (sentMs: number) => (BigInt(sentMs - DISCORD_EPOCH_MS) << 22n).toString();
const OLD = idSentAt(NOW - 30 * DAY_MS);
const FRESH = idSentAt(NOW - DAY_MS);

const button = (id: string, disabled: boolean, customId = `p:${id}`) => ({
  _id: id,
  type: ComponentType.Button,
  style: ButtonStyle.Primary,
  label: id,
  custom_id: customId,
  disabled,
});

function message(...components: unknown[]): WebhookMessage {
  return {
    components: [{ _id: "row", type: ComponentType.ActionRow, components }],
  } as unknown as WebhookMessage;
}

describe("possiblyExpiredIds", () => {
  it("names what's disabled on a message old enough to have expired", () => {
    const m = message(button("a", true), button("b", false), button("c", true));
    expect(possiblyExpiredIds(m, OLD, NOW, 7)).toEqual(["a", "c"]);
  });

  it("finds a disabled menu as well as a button", () => {
    const menu = {
      _id: "menu",
      type: ComponentType.StringSelect,
      custom_id: "p:menu",
      options: [],
      disabled: true,
    };
    expect(possiblyExpiredIds(message(menu), OLD, NOW, 7)).toEqual(["menu"]);
  });

  it("says nothing about a message too young to have expired: its author did that", () => {
    expect(possiblyExpiredIds(message(button("a", true)), FRESH, NOW, 7)).toEqual([]);
  });

  it("follows the deployment's TTL", () => {
    const m = message(button("a", true));
    expect(possiblyExpiredIds(m, idSentAt(NOW - 2 * DAY_MS), NOW, 1)).toEqual(["a"]);
    expect(possiblyExpiredIds(m, idSentAt(NOW - 7 * DAY_MS), NOW, 7)).toEqual(["a"]);
    expect(possiblyExpiredIds(m, idSentAt(NOW - 7 * DAY_MS + 1), NOW, 7)).toEqual([]);
  });

  it("says nothing where components never expire", () => {
    expect(possiblyExpiredIds(message(button("a", true)), OLD, NOW, null)).toEqual([]);
  });

  it("ignores what no click can reach", () => {
    // A link button has no custom_id, so the dispatcher never sees it.
    const link = { ...button("a", true, ""), style: ButtonStyle.Link, url: "https://x.test" };
    expect(possiblyExpiredIds(message(link), OLD, NOW, 7)).toEqual([]);
  });

  it("says nothing about an id it can't read", () => {
    expect(possiblyExpiredIds(message(button("a", true)), "nope", NOW, 7)).toEqual([]);
  });
});

describe("offerToEnableExpired", () => {
  const toast = vi.mocked(pushToast);

  function seed(m: WebhookMessage) {
    useMessageStore.setState({ message: m, past: [], future: [], restoredFrom: null });
  }

  const disabledIds = () =>
    (
      useMessageStore.getState().message.components[0] as unknown as {
        components: { _id: string; disabled: boolean }[];
      }
    ).components
      .filter((c) => c.disabled)
      .map((c) => c._id);

  beforeEach(() => {
    toast.mockClear();
  });

  it("changes nothing until asked", () => {
    seed(message(button("a", true)));
    offerToEnableExpired(idSentAt(Date.now() - 30 * DAY_MS));
    expect(toast).toHaveBeenCalledOnce();
    expect(disabledIds()).toEqual(["a"]);
  });

  it("turns them all on as one undo step, keeping the Update target", () => {
    const origin = { webhookUrl: "https://discord.test/w", messageId: OLD };
    seed(message(button("a", true), button("b", true), button("c", false)));
    useMessageStore.setState({ restoredFrom: origin });
    offerToEnableExpired(idSentAt(Date.now() - 30 * DAY_MS));

    toast.mock.calls[0]?.[2]?.action?.onClick();

    expect(disabledIds()).toEqual([]);
    const state = useMessageStore.getState();
    expect(state.past).toHaveLength(1);
    expect(state.restoredFrom).toEqual(origin);
    state.undo();
    expect(disabledIds()).toEqual(["a", "b"]);
  });

  it("stays quiet when there's nothing to offer", () => {
    seed(message(button("a", false)));
    offerToEnableExpired(idSentAt(Date.now() - 30 * DAY_MS));
    seed(message(button("a", true)));
    offerToEnableExpired(idSentAt(Date.now() - DAY_MS));
    expect(toast).not.toHaveBeenCalled();
  });
});
