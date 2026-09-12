import { describe, expect, it } from "vitest";

import { bootNoticeCopy, bootShell, UPDATING_COPY } from "./bootFailure";

describe("bootNoticeCopy", () => {
  it("says 'probably' about an update — an offline tab produces the same chunk error", () => {
    const web = bootNoticeCopy("stale-chunk", "web");
    expect(web.body).toMatch(/probably been updated/);
    expect(web.action).toBe("Refresh now"); // one voice with ChunkErrorBoundary
    expect(web.detail).toBeUndefined();
    const activity = bootNoticeCopy("stale-chunk", "activity");
    expect(activity.body).toMatch(/probably been updated/);
    expect(activity.action).toBe("Try again"); // one voice with the Activity splash
  });

  it("does not promise a device-saved draft inside Discord", () => {
    expect(bootNoticeCopy("stale-chunk", "web").body).toMatch(/saved on this device/);
    for (const reason of ["stale-chunk", "offline", "error"] as const) {
      expect(bootNoticeCopy(reason, "activity").body).not.toMatch(/this device/);
    }
  });

  it("names the network when the browser says it is offline", () => {
    expect(bootNoticeCopy("offline", "web").body).toMatch(/offline/);
    expect(bootNoticeCopy("offline", "web").action).toBe("Reload");
    expect(bootNoticeCopy("offline", "activity").body).toMatch(/offline/);
  });

  it("carries the error message as a detail line only for a genuine boot bug", () => {
    const message = "Cannot destructure property 'App' of undefined";
    expect(bootNoticeCopy("error", "web", message).detail).toBe(message);
    expect(bootNoticeCopy("error", "activity", message).detail).toBe(message);
    expect(bootNoticeCopy("error", "web").lead).toMatch(/couldn’t start/);
    // A chunk failure never surfaces the raw wording — the notice explains it.
    expect(bootNoticeCopy("stale-chunk", "web", message).detail).toBeUndefined();
  });

  it("keeps the updating line honest about what is happening", () => {
    expect(UPDATING_COPY).toMatch(/Updating DWEEB/);
  });
});

describe("bootShell", () => {
  it("is null without a document — the caller still reports the failure", () => {
    expect(bootShell()).toBe(null);
  });
});
