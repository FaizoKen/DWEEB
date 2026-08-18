import { describe, expect, it } from "vitest";

import { validateAgainstSchema, withDefaults, type JsonSchema } from "./jsonschema";

const SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 8 },
    count: { type: "integer", minimum: 1, maximum: 5 },
    mode: { type: "string", enum: ["a", "b"], default: "a" },
    message: { type: ["object", "string"] },
    tags: { type: "array", items: { type: "string" }, maxItems: 2 },
  },
  required: ["name"],
  additionalProperties: false,
};

describe("validateAgainstSchema", () => {
  it("accepts a well-formed value", () => {
    expect(validateAgainstSchema({ name: "hi", count: 3, mode: "b", tags: ["x"] }, SCHEMA)).toEqual(
      [],
    );
  });

  it("names the missing required argument", () => {
    expect(validateAgainstSchema({}, SCHEMA)).toEqual(["name is required."]);
  });

  it("reports the wrong type with both the expectation and what arrived", () => {
    expect(validateAgainstSchema({ name: 5 }, SCHEMA)).toEqual([
      "name must be string (got integer).",
    ]);
  });

  // A tool argument the caller invented is nearly always a misremembered name,
  // and silently ignoring it produces a confusing "why did nothing change".
  it("rejects an argument the tool does not declare, listing the ones it does", () => {
    const errors = validateAgainstSchema({ name: "hi", nmae: "typo" }, SCHEMA);
    expect(errors[0]).toContain("nmae is not a recognised argument");
    expect(errors[0]).toContain("count");
  });

  it("accepts either branch of a union type", () => {
    expect(validateAgainstSchema({ name: "hi", message: "{}" }, SCHEMA)).toEqual([]);
    expect(validateAgainstSchema({ name: "hi", message: {} }, SCHEMA)).toEqual([]);
    expect(validateAgainstSchema({ name: "hi", message: 4 }, SCHEMA)).toEqual([
      "message must be object or string (got integer).",
    ]);
  });

  it("enforces enums, bounds, lengths, and item counts", () => {
    expect(validateAgainstSchema({ name: "hi", mode: "c" }, SCHEMA)[0]).toContain("must be one of");
    expect(validateAgainstSchema({ name: "hi", count: 9 }, SCHEMA)[0]).toContain("<= 5");
    expect(validateAgainstSchema({ name: "" }, SCHEMA)[0]).toContain("at least 1 characters");
    expect(validateAgainstSchema({ name: "hi", tags: ["a", "b", "c"] }, SCHEMA)[0]).toContain(
      "at most 2 item(s)",
    );
  });

  it("addresses a bad array element by index", () => {
    expect(validateAgainstSchema({ name: "hi", tags: [1] }, SCHEMA)).toEqual([
      "tags[0] must be string (got integer).",
    ]);
  });

  it("treats an integer as an acceptable number", () => {
    expect(validateAgainstSchema(3, { type: "number" })).toEqual([]);
    expect(validateAgainstSchema(3.5, { type: "integer" })).toEqual([
      "value must be integer (got number).",
    ]);
  });

  it("collects every problem rather than stopping at the first", () => {
    expect(validateAgainstSchema({ count: 0, mode: "z" }, SCHEMA)).toHaveLength(3);
  });

  it("does not chase the other keywords once the type is already wrong", () => {
    expect(validateAgainstSchema("nope", SCHEMA)).toEqual(["value must be object (got string)."]);
  });
});

describe("withDefaults", () => {
  it("fills a declared default so it is a real default, not documentation", () => {
    expect(withDefaults({ name: "hi" }, SCHEMA)).toEqual({ name: "hi", mode: "a" });
  });

  it("never overwrites a value the caller supplied", () => {
    expect(withDefaults({ name: "hi", mode: "b" }, SCHEMA).mode).toBe("b");
  });
});
