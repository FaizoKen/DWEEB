import { describe, expect, it } from "vitest";
import { decodeJson } from "@/core/serialization/encode";
import type { ActionRowComponent, SelectComponent } from "@/core/schema/types";
import { SelectRenderer } from "./SelectRenderer";
import { mediaKindFromName } from "./mediaKind";
import { mediaUrlText } from "./useResolvedMediaUrl";

/** The select a single-row payload imports to. */
function importSelect(select: unknown): SelectComponent {
  const res = decodeJson(JSON.stringify({ components: [{ type: 1, components: [select] }] }));
  if (!res.ok) throw new Error(res.error);
  return (res.message.components[0] as ActionRowComponent).components[0] as SelectComponent;
}

// The import boundary keeps whatever a payload carries, so the preview must
// read every field defensively: a renderer that throws takes the whole editor
// down to the error screen (and pages).
describe("the preview survives malformed imported fields", () => {
  it("renders a numeric snowflake in default_values", () => {
    const node = importSelect({
      type: 5,
      custom_id: "pick_user",
      default_values: [{ id: 123456789012345680, type: "user" }],
    });
    expect(() => SelectRenderer({ node })).not.toThrow();
  });

  it("renders default_values that isn't an array, and a null option", () => {
    const user = importSelect({ type: 5, custom_id: "u", default_values: { id: "1" } });
    expect(() => SelectRenderer({ node: user })).not.toThrow();
    const options = importSelect({ type: 3, custom_id: "s", options: [null] });
    expect(() => SelectRenderer({ node: options })).not.toThrow();
  });

  it("treats a non-string media url or content type as absent", () => {
    expect(mediaUrlText(42)).toBe("");
    expect(mediaUrlText(undefined)).toBe("");
    expect(mediaUrlText("https://x/y.png")).toBe("https://x/y.png");
    expect(mediaKindFromName("clip.mp4", 7)).toBe("video");
    expect(mediaKindFromName("clip.bin", "video/mp4")).toBe("video");
  });
});
