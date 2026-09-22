/**
 * The Share dialog mounts one panel per tab and the Modal unmounts the rest, so
 * a webhook URL typed by hand used to die on the next tab click. This store is
 * what carries it — and, because it carries a credential, what must be empty
 * again the moment the dialog closes (`ShareDialog` calls `resetWebhookDraft`
 * from the cleanup of an `open`-keyed effect, which runs both when `open` goes
 * false and when the dialog unmounts).
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  readWebhookDraft,
  resetWebhookDraft,
  setWebhookDraftOpen,
  setWebhookDraftUrl,
  useWebhookDraftStore,
} from "./webhookDraft";

const URL_A = "https://discord.com/api/webhooks/123/abc";

describe("webhook draft", () => {
  beforeEach(() => resetWebhookDraft());

  it("starts empty and collapsed", () => {
    expect(readWebhookDraft()).toEqual({ url: "", open: false });
  });

  it("carries the field's contents and its open/committed state", () => {
    setWebhookDraftOpen(true);
    setWebhookDraftUrl(URL_A);
    expect(readWebhookDraft()).toEqual({ url: URL_A, open: true });

    // "Done — use this webhook" collapses the field but keeps the URL: a panel
    // mounting after a tab switch must read that as committed, not as a
    // half-typed value it should re-open the credential field for.
    setWebhookDraftOpen(false);
    expect(readWebhookDraft()).toEqual({ url: URL_A, open: false });
  });

  it("keeps the raw text, so a half-typed URL survives a tab switch too", () => {
    setWebhookDraftUrl("https://discord.com/api/web");
    expect(readWebhookDraft().url).toBe("https://discord.com/api/web");
  });

  it("drops the URL when a pick supersedes it", () => {
    setWebhookDraftUrl(URL_A);
    // The picker / recents path clears the draft rather than writing to it —
    // otherwise a stale typed URL would win back on the next mount.
    setWebhookDraftUrl("");
    expect(readWebhookDraft().url).toBe("");
  });

  it("resets when the dialog closes, so nothing leaks into the next open", () => {
    setWebhookDraftOpen(true);
    setWebhookDraftUrl(URL_A);

    resetWebhookDraft();

    expect(readWebhookDraft()).toEqual({ url: "", open: false });
    // And through the store itself, which is what components subscribe to.
    expect(useWebhookDraftStore.getState().url).toBe("");
    expect(useWebhookDraftStore.getState().open).toBe(false);
  });

  it("is safe to reset when it was never used", () => {
    resetWebhookDraft();
    resetWebhookDraft();
    expect(readWebhookDraft()).toEqual({ url: "", open: false });
  });
});
