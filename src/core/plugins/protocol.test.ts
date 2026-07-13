import { describe, expect, it } from "vitest";

import {
  isRequestMessage,
  negotiatePluginApiVersion,
  PLUGIN_MSG,
  sanitizeManagementToken,
} from "./protocol";

describe("plugin resource request validation", () => {
  const nonce = "session-nonce";

  it("accepts a bounded singular-resource request", () => {
    expect(
      isRequestMessage(
        {
          type: PLUGIN_MSG.request,
          nonce,
          requestId: "request-1",
          resource: "savedWebhook",
          resourceId: "webhook-1",
        },
        nonce,
      ),
    ).toBe(true);
  });

  it("rejects oversized identifiers before reflecting them in a response", () => {
    const base = {
      type: PLUGIN_MSG.request,
      nonce,
      requestId: "request-1",
      resource: "message",
    };
    expect(isRequestMessage({ ...base, requestId: "x".repeat(129) }, nonce)).toBe(false);
    expect(isRequestMessage({ ...base, resource: "x".repeat(65) }, nonce)).toBe(false);
    expect(isRequestMessage({ ...base, resourceId: "x".repeat(129) }, nonce)).toBe(false);
  });

  it("accepts only canonical edit credentials", () => {
    const token = "a".repeat(64);
    expect(sanitizeManagementToken(token)).toBe(token);
    expect(sanitizeManagementToken("A".repeat(64))).toBeUndefined();
    expect(sanitizeManagementToken("a".repeat(63))).toBeUndefined();
  });

  it("requires the iframe to meet its declared version before init", () => {
    expect(negotiatePluginApiVersion(2, 2, 2)).toBe(2);
    expect(negotiatePluginApiVersion(2, 1, 2)).toBe(1);
    expect(negotiatePluginApiVersion(2, 2, 1)).toBeNull();
    expect(negotiatePluginApiVersion(2, 3, 3)).toBeNull();
    expect(negotiatePluginApiVersion(2, 2, undefined)).toBeNull();
  });
});
