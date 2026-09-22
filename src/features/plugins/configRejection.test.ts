/**
 * A plugin config iframe's `save` that the host refuses must say so.
 *
 * Both hosts render none of the plugin's form, so the user's whole experience
 * of a refusal is whatever DWEEB puts on screen. Until this shipped, a `save`
 * that failed validation was dropped with a DEV-only `console.warn` and a bare
 * `return` — in a production build the user clicked the plugin's own Save
 * button and *nothing happened at all*, with no error anywhere and no way to
 * tell a broken plugin from a broken app.
 *
 * The refusal *rules* were already right and are not being relaxed here: a
 * `custom_id` outside the plugin's prefix routes nowhere, and a URL outside the
 * manifest's template prefix repoints the button at a foreign destination.
 * What these tests pin is that each rule now yields a visible reason (naming
 * the plugin, and pointing at the manual escape hatch that plugin kind has)
 * rather than silence — and that the valid case still yields none, since a
 * spurious error would be its own failure.
 *
 * The decision is tested through the exported pure helpers rather than the
 * hooks themselves: the suite runs without a DOM (see `vitest.config.ts`), so a
 * hook that only ever reaches this branch from inside a `message` listener
 * cannot be mounted here.
 */

import { describe, expect, it } from "vitest";
import { PLUGIN_MANIFEST_SCHEMA_VERSION, type PluginManifest } from "@/core/plugins/manifest";
import { LINK_PLUGIN_KIND, type LinkPluginManifest } from "@/core/plugins/linkManifest";
import { LIMITS } from "@/core/schema/limits";
import {
  PLUGIN_FRAME_READY_TIMEOUT_MS,
  pluginFrameTimeoutMessage,
  pluginSaveRejectedMessage,
  pluginSaveRejection,
} from "./usePluginConfig";
import {
  linkFrameTimeoutMessage,
  linkSaveRejectedMessage,
  linkSaveRejection,
} from "./useLinkPluginConfig";

const MANIFEST: PluginManifest = {
  schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
  id: "poll",
  name: "Poll",
  description: "Live polls.",
  version: "1.0.0",
  targets: ["button"],
  configUrl: "https://poll.example/config",
  customIdPrefix: "poll:",
};

const LINK_MANIFEST: LinkPluginManifest = {
  schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
  kind: LINK_PLUGIN_KIND,
  id: "form-role",
  name: "Form Respondent Role",
  description: "Opens a form.",
  version: "1.0.0",
  url: "https://forms.example/f/{form_id}",
};

describe("interactive plugin save rejection", () => {
  it("adopts a custom_id carrying the plugin's own prefix", () => {
    expect(pluginSaveRejection(MANIFEST, "poll:abc123")).toBeNull();
  });

  it("names the plugin and the manual escape hatch when the prefix is foreign", () => {
    expect(pluginSaveRejection(MANIFEST, "giveaway:abc123")).toBe(
      "Poll sent back an action ID DWEEB can't use. Try again, or close this and set the ID manually.",
    );
  });

  it("refuses an over-long custom_id visibly rather than silently", () => {
    const tooLong = `poll:${"a".repeat(LIMITS.BUTTON_CUSTOM_ID)}`;

    expect(pluginSaveRejection(MANIFEST, tooLong)).toBe(pluginSaveRejectedMessage(MANIFEST.name));
    // The one at the cap is fine — the message is about the rule, not the copy.
    expect(pluginSaveRejection(MANIFEST, tooLong.slice(0, LIMITS.BUTTON_CUSTOM_ID))).toBeNull();
  });

  it("refuses an empty custom_id", () => {
    expect(pluginSaveRejection(MANIFEST, "")).toBe(pluginSaveRejectedMessage(MANIFEST.name));
  });
});

describe("link plugin save rejection", () => {
  it("adopts a URL under the manifest's own template prefix", () => {
    expect(linkSaveRejection(LINK_MANIFEST, "https://forms.example/f/42")).toBeNull();
  });

  it("names the plugin and the manual escape hatch for a foreign destination", () => {
    expect(linkSaveRejection(LINK_MANIFEST, "https://evil.example/f/42")).toBe(
      "Form Respondent Role sent back a link DWEEB can't use. Try again, or paste the URL yourself.",
    );
  });

  it("refuses a URL that is still a template", () => {
    // An unfilled fill-me slot would post as a dead link.
    expect(linkSaveRejection(LINK_MANIFEST, "https://forms.example/f/{form_id}")).toBe(
      linkSaveRejectedMessage(LINK_MANIFEST.name),
    );
  });

  it("refuses an over-long URL", () => {
    const tooLong = `https://forms.example/f/${"a".repeat(LIMITS.BUTTON_URL)}`;

    expect(linkSaveRejection(LINK_MANIFEST, tooLong)).toBe(
      linkSaveRejectedMessage(LINK_MANIFEST.name),
    );
  });
});

describe("unreachable config frame", () => {
  it("offers a retry and the plugin kind's own manual fallback", () => {
    expect(pluginFrameTimeoutMessage(MANIFEST.name)).toBe(
      "Poll didn't respond. Retry, or close this and set the action ID manually.",
    );
    expect(linkFrameTimeoutMessage(LINK_MANIFEST.name)).toBe(
      "Form Respondent Role didn't respond. Retry, or paste the URL yourself.",
    );
  });

  it("waits long enough that a merely slow plugin is not called dead", () => {
    // Both surfaces share the constant so they cannot drift to different
    // patiences. Generous on purpose — a false "didn't respond" over a frame
    // that was about to load is worse than a few more seconds of "Loading…".
    expect(PLUGIN_FRAME_READY_TIMEOUT_MS).toBe(8000);
  });
});
