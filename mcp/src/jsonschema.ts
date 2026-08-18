/**
 * A very small JSON Schema checker — enough for tool arguments, and no more.
 *
 * MCP tools publish an `inputSchema`, and a well-behaved client validates
 * against it before calling. Not every client does, and none of them are our
 * trust boundary anyway: the arguments arrive over a pipe from a model. So the
 * server checks them itself.
 *
 * The point of doing it *from the published schema* rather than with hand-written
 * `typeof` guards is that the two can then never drift: whatever the tool
 * advertises is exactly what it enforces, and a schema edit changes both at once.
 * The same checker validates each tool's `structuredContent` against its
 * declared `outputSchema` in the tests, which is what keeps that promise honest.
 *
 * Only the keywords the tool schemas actually use are implemented, and an
 * unknown keyword is ignored rather than guessed at — a checker that silently
 * accepts what it doesn't understand is fine here (the handler still has to
 * cope), but one that invents rules would reject valid calls.
 */

export type JsonType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export interface JsonSchema {
  type?: JsonType | JsonType[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: Array<string | number | boolean | null>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
  examples?: unknown[];
}

function typeOf(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value as JsonType;
}

function matchesType(value: unknown, expected: JsonType): boolean {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  return actual === expected;
}

function at(path: string, key: string | number): string {
  return typeof key === "number" ? `${path}[${key}]` : path ? `${path}.${key}` : key;
}

/**
 * Collect every violation of `schema` in `value`. An empty array means valid.
 * Messages name the offending path so a model can fix the call rather than
 * guess which argument was wrong.
 */
export function validateAgainstSchema(value: unknown, schema: JsonSchema, path = ""): string[] {
  const errors: string[] = [];
  const where = path || "value";

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((t) => matchesType(value, t))) {
      errors.push(`${where} must be ${allowed.join(" or ")} (got ${typeOf(value)}).`);
      // Every remaining keyword assumes the type matched.
      return errors;
    }
  }

  if (schema.enum && !schema.enum.some((option) => option === value)) {
    errors.push(`${where} must be one of ${schema.enum.map((o) => JSON.stringify(o)).join(", ")}.`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${where} must be at least ${schema.minLength} characters.`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${where} must be at most ${schema.maxLength} characters.`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${where} must be >= ${schema.minimum}.`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${where} must be <= ${schema.maximum}.`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${where} must have at least ${schema.minItems} item(s).`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${where} must have at most ${schema.maxItems} item(s).`);
    }
    if (schema.items) {
      value.forEach((item, i) => {
        errors.push(...validateAgainstSchema(item, schema.items!, at(path, i)));
      });
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (object[key] === undefined) errors.push(`${at(path, key)} is required.`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (object[key] !== undefined) {
        errors.push(...validateAgainstSchema(object[key], child, at(path, key)));
      }
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(object)) {
        if (!known.has(key)) {
          errors.push(
            `${at(path, key)} is not a recognised argument (expected ${[...known].join(", ") || "none"}).`,
          );
        }
      }
    } else if (typeof schema.additionalProperties === "object") {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const [key, child] of Object.entries(object)) {
        if (!known.has(key)) {
          errors.push(...validateAgainstSchema(child, schema.additionalProperties, at(path, key)));
        }
      }
    }
  }

  return errors;
}

/** Fill in the `default` of every absent top-level property. Applied before
 *  validation so a declared default is a real default, not documentation. */
export function withDefaults(
  args: Record<string, unknown>,
  schema: JsonSchema,
): Record<string, unknown> {
  const out = { ...args };
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    if (out[key] === undefined && child.default !== undefined) out[key] = child.default;
  }
  return out;
}
