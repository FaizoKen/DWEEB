import { describe, expect, it } from "vitest";

import { SHARED_BOT_PERMISSIONS } from "./config";

describe("SHARED_BOT_PERMISSIONS", () => {
  // Discord's invite *replaces* the bot's permissions, so every invite for the
  // shared bot — this app's and each plugin's — must request the same union.
  // The same literal is pinned by `SHARED_BOT_PERMISSIONS`' tripwire test in
  // every plugin's `src/config.rs`; this one fails if the app drifts from them.
  it("is the union every plugin's invite requests", () => {
    // Create Instant Invite | Manage Channels | Manage Roles | Manage Webhooks
    // | Manage Threads | Create Private Threads | Send Messages in Threads.
    expect(SHARED_BOT_PERMISSIONS).toBe("361582559249");
  });
});
