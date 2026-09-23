/**
 * The room-connection notices: one "lost" and one "restored" per real outage,
 * nothing for a blip a reconnect heals at once, no storm from a flapping
 * socket, and silence once collab has stopped for good.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOST_AFTER_MS,
  RESTORED_AFTER_MS,
  createConnectionNotifier,
  type ConnectionNotifier,
} from "./connectionNotice";

describe("createConnectionNotifier", () => {
  let onLost: ReturnType<typeof vi.fn>;
  let onRestored: ReturnType<typeof vi.fn>;
  let notifier: ConnectionNotifier;

  beforeEach(() => {
    vi.useFakeTimers();
    onLost = vi.fn();
    onRestored = vi.fn();
    notifier = createConnectionNotifier({ onLost, onRestored });
  });
  afterEach(() => vi.useRealTimers());

  it("says nothing about the first connect, or a launch that hasn't connected yet", () => {
    notifier.update(false);
    vi.advanceTimersByTime(LOST_AFTER_MS * 3);
    notifier.update(true);
    vi.advanceTimersByTime(RESTORED_AFTER_MS * 3);
    expect(onLost).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
  });

  it("announces a drop once it lasts, then the recovery once it holds", () => {
    notifier.update(true);
    notifier.update(false);
    vi.advanceTimersByTime(LOST_AFTER_MS - 1);
    expect(onLost).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLost).toHaveBeenCalledTimes(1);

    notifier.update(true);
    vi.advanceTimersByTime(RESTORED_AFTER_MS);
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  it("stays silent for a blip that heals before the grace runs out", () => {
    notifier.update(true);
    notifier.update(false);
    vi.advanceTimersByTime(LOST_AFTER_MS / 2);
    notifier.update(true);
    vi.advanceTimersByTime(LOST_AFTER_MS * 3);
    expect(onLost).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
  });

  it("doesn't let repeated down edges stretch the grace", () => {
    notifier.update(true);
    notifier.update(false);
    vi.advanceTimersByTime(LOST_AFTER_MS / 2);
    notifier.update(false);
    vi.advanceTimersByTime(LOST_AFTER_MS / 2);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it("turns a flapping socket into one pair of notices", () => {
    notifier.update(true);
    notifier.update(false);
    vi.advanceTimersByTime(LOST_AFTER_MS);
    expect(onLost).toHaveBeenCalledTimes(1);

    // Up and down faster than a recovery can hold, many times over.
    for (let i = 0; i < 10; i++) {
      notifier.update(true);
      vi.advanceTimersByTime(RESTORED_AFTER_MS / 2);
      notifier.update(false);
      vi.advanceTimersByTime(LOST_AFTER_MS * 2);
    }
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onRestored).not.toHaveBeenCalled();

    notifier.update(true);
    vi.advanceTimersByTime(RESTORED_AFTER_MS);
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it("goes quiet for good once collab stops (room full, session expired)", () => {
    notifier.update(true);
    notifier.update(false);
    notifier.halt();
    vi.advanceTimersByTime(LOST_AFTER_MS * 3);
    notifier.update(true);
    notifier.update(false);
    vi.advanceTimersByTime(LOST_AFTER_MS * 3);
    expect(onLost).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
  });

  it("cancels an owed recovery notice when halted", () => {
    notifier.update(true);
    notifier.update(false);
    vi.advanceTimersByTime(LOST_AFTER_MS);
    notifier.update(true);
    notifier.halt();
    vi.advanceTimersByTime(RESTORED_AFTER_MS * 2);
    expect(onRestored).not.toHaveBeenCalled();
  });
});
