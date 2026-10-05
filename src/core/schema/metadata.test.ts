import { describe, expect, it } from "vitest";
import { decodeJson } from "@/core/serialization/encode";
import { COMPONENT_META, componentMeta } from "./metadata";
import { ComponentType } from "./types";

describe("componentMeta", () => {
  it("returns the catalogue entry for every known type", () => {
    expect(componentMeta(ComponentType.Container)).toBe(COMPONENT_META[ComponentType.Container]);
    expect(componentMeta(ComponentType.StringSelect).label).toBe("Options menu");
  });

  it("names a type the schema doesn't know instead of throwing", () => {
    // The import boundary keeps unknown types on purpose (a newer Discord
    // component, another tool's) — the tree and preview read their label
    // from here, and a raw COMPONENT_META lookup returned undefined.
    const res = decodeJson(JSON.stringify({ components: [{ type: 18, label: "x" }] }));
    if (!res.ok) throw new Error(res.error);
    const meta = componentMeta(res.message.components[0]!.type);
    expect(meta.label).toBe("Unknown component (type 18)");
    expect(meta.glyph).toBe("?");
  });
});
