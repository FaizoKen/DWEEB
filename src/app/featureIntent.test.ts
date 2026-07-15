import { describe, expect, it } from "vitest";
import { readFeatureIntent, stripFeatureIntent } from "./featureIntent";

describe("feature CTA intents", () => {
  it("accepts only supported non-mutating UI actions", () => {
    expect(readFeatureIntent("?intent=ai")).toBe("ai");
    expect(readFeatureIntent("?intent=schedule")).toBe("schedule");
    expect(readFeatureIntent("?intent=restore")).toBe("restore");
    expect(readFeatureIntent("?intent=post-now")).toBeNull();
    expect(readFeatureIntent("?intent=ai%0Asecret")).toBeNull();
  });

  it("removes only intent and preserves attribution/template/hash", () => {
    expect(
      stripFeatureIntent(
        "https://dweeb.faizo.net/?template=announcement&intent=schedule&entry=feature%3Aschedule#x",
      ),
    ).toBe("/?template=announcement&entry=feature%3Aschedule#x");
  });
});
