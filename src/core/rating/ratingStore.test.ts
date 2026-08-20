/**
 * The rating prompt's whole job is to appear once and never again. These tests
 * pin that: an editor is a workspace, and this project has deliberately kept
 * the intro film opt-in and suppressed the welcome tour for SEO arrivals for
 * the same reason. A prompt that reappears is worse than one that never shows.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  available: vi.fn<() => Promise<boolean>>(),
  fetchMine: vi.fn<() => Promise<{ state: string; score?: number }>>(),
  submit: vi.fn<(score: number) => Promise<boolean>>(),
}));

vi.mock("./availability", () => ({ ensureRatingsAvailable: mocks.available }));
vi.mock("./ratingApi", async () => {
  const actual = await vi.importActual<typeof import("./ratingApi")>("./ratingApi");
  return { ...actual, fetchMyRating: mocks.fetchMine, submitRating: mocks.submit };
});

const { useRatingStore, armRatingPrompt, __resetRatingPromptGuards } =
  await import("./ratingStore");

/** Let the arm timer fire and its two awaited checks settle. */
async function settleArm() {
  await vi.advanceTimersByTimeAsync(1000);
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * The suite runs in Node, which has no `localStorage`. The store guards its own
 * access (a missing global throws a ReferenceError its try/catch swallows), but
 * the persistent half of "ask once" only exists when storage does — so the
 * dismissal tests need a real one.
 */
function installStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
  });
  return backing;
}

let storage: Map<string, string>;

beforeEach(() => {
  vi.useFakeTimers();
  storage = installStorage();
  vi.clearAllMocks();
  __resetRatingPromptGuards();
  mocks.available.mockResolvedValue(true);
  mocks.fetchMine.mockResolvedValue({ state: "unrated" });
  mocks.submit.mockResolvedValue(true);
});

describe("arming", () => {
  it("shows the prompt after a successful send", async () => {
    armRatingPrompt();
    expect(useRatingStore.getState().phase).toBe("idle");
    await settleArm();
    expect(useRatingStore.getState().phase).toBe("asking");
  });

  it("never shows twice in one session, however many messages are sent", async () => {
    armRatingPrompt();
    await settleArm();
    useRatingStore.getState().dismiss(false);

    armRatingPrompt();
    await settleArm();
    expect(useRatingStore.getState().phase).toBe("idle");
  });

  it("stays silent for someone who already rated on another device", async () => {
    // The answer comes from the server precisely so rating on a phone settles
    // it on a laptop; a device-local memory would re-ask the same person.
    mocks.fetchMine.mockResolvedValue({ state: "rated", score: 4 });
    armRatingPrompt();
    await settleArm();
    expect(useRatingStore.getState().phase).toBe("idle");
  });

  it("stays silent once dismissed, across sessions", async () => {
    armRatingPrompt();
    await settleArm();
    useRatingStore.getState().dismiss(true);
    expect(storage.size).toBeGreaterThan(0);

    // A fresh tab: the in-memory session guards reset, but storage remembers.
    __resetRatingPromptGuards();
    const callsBefore = mocks.available.mock.calls.length;
    armRatingPrompt();
    await settleArm();
    expect(useRatingStore.getState().phase).toBe("idle");
    // The stored dismissal short-circuits before any network work — the answer
    // is already known, so the second arm must cost nothing.
    expect(mocks.available.mock.calls.length).toBe(callsBefore);
  });

  it("asks again in a new tab when nothing was ever dismissed or rated", async () => {
    // The mirror of the test above: without this, "stays silent" would pass
    // just as well for a prompt that is permanently broken.
    armRatingPrompt();
    await settleArm();
    expect(useRatingStore.getState().phase).toBe("asking");

    __resetRatingPromptGuards();
    armRatingPrompt();
    await settleArm();
    expect(useRatingStore.getState().phase).toBe("asking");
  });

  it("stays silent where the deployment does not run ratings", async () => {
    mocks.available.mockResolvedValue(false);
    armRatingPrompt();
    await settleArm();
    expect(useRatingStore.getState().phase).toBe("idle");
    // And it must not have asked the server about a feature that is off.
    expect(mocks.fetchMine).not.toHaveBeenCalled();
  });

  it("stays silent rather than surfacing an error when the check fails", async () => {
    mocks.fetchMine.mockRejectedValue(new Error("offline"));
    armRatingPrompt();
    await settleArm();
    expect(useRatingStore.getState().phase).toBe("idle");
  });

  it("stays silent for a signed-out visitor", async () => {
    // `/api/rating/me` is identity-gated and answers 401 when signed out, which
    // the API layer reports as `unknown`. Reading that as "hasn't rated" would
    // spend the one prompt on someone whose tap the server must then refuse.
    mocks.fetchMine.mockResolvedValue({ state: "unknown" });
    armRatingPrompt();
    await settleArm();
    expect(useRatingStore.getState().phase).toBe("idle");
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});

describe("choosing a score", () => {
  it("records the score and thanks the rater", async () => {
    armRatingPrompt();
    await settleArm();
    await useRatingStore.getState().choose(5);
    expect(mocks.submit).toHaveBeenCalledWith(5);
    expect(useRatingStore.getState().phase).toBe("thanks");
    expect(useRatingStore.getState().score).toBe(5);
  });

  it("records a low score exactly as readily as a high one", async () => {
    // No review gating: the site publishes this average, so steering unhappy
    // raters away from it would corrupt the number at its source.
    armRatingPrompt();
    await settleArm();
    await useRatingStore.getState().choose(1);
    expect(mocks.submit).toHaveBeenCalledWith(1);
    expect(useRatingStore.getState().phase).toBe("thanks");
  });

  it("still thanks — and never re-asks — when the submit fails", async () => {
    mocks.submit.mockResolvedValue(false);
    armRatingPrompt();
    await settleArm();
    await useRatingStore.getState().choose(4);
    expect(useRatingStore.getState().phase).toBe("thanks");
    // The rating is lost, but the person did what was asked; a retry prompt
    // over a favour would cost them more than the data point costs us.
    expect(useRatingStore.getState().score).toBeNull();
  });

  it("cannot be double-submitted from a fast second tap", async () => {
    armRatingPrompt();
    await settleArm();
    let release: (v: boolean) => void = () => {};
    mocks.submit.mockReturnValue(
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
    );
    const first = useRatingStore.getState().choose(5);
    await useRatingStore.getState().choose(3);
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    release(true);
    await first;
  });
});
