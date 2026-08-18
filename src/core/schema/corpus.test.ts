import { describe, expect, it } from "vitest";

import corpus from "../../../server/src/mcp/validation-corpus.json";
import { validateMessage, type IssueSeverity } from "./validation";
import { buildPathIndex } from "./traversal";
import type { WebhookMessage } from "./types";

/**
 * The shared validator corpus, checked against the implementation that
 * generated it.
 *
 * `server/src/mcp/validation-corpus.json` records, for a hundred-odd messages,
 * the exact issue codes this validator produces — and the Rust MCP server's own
 * validator is tested against the same file (`server/src/mcp/components.rs`).
 * That corpus is the only thing standing between two implementations of the
 * same seventy rules and silent divergence, so it has to be authoritative on
 * *both* sides: if it only pinned Rust, a rule changed here would be "fixed" by
 * regenerating the corpus, and Rust would quietly keep the old behaviour.
 *
 * So this test asserts the corpus still describes this validator. Change a rule
 * and it fails until `bun run gen:mcp` is re-run — which is also what makes the
 * Rust suite fail, which is the signal to port the change.
 *
 * The generator refuses to write a corpus that does not exercise every code the
 * validator can emit, so "the corpus is stale" and "a rule is untested" cannot
 * both hide behind a green run.
 */

interface CorpusIssue {
  code: string;
  path: string | null;
}

interface CorpusCase {
  name: string;
  message: unknown;
  errors: CorpusIssue[];
  warnings: CorpusIssue[];
}

/**
 * Re-attach editor ids without going through `attachEditorFields`.
 *
 * The corpus stores each message in its **wire** form, already carrying the
 * repairs that boundary applies (a missing `content` is recorded as `""`), so
 * stamping ids reproduces the exact tree the codes were recorded from. Using
 * the real boundary here would be worse, not better: it throws on the
 * deliberately accessory-less Section that pins `SECTION_ACCESSORY_MISSING`.
 */
function stampIds(value: unknown, counter = { n: 0 }): unknown {
  if (Array.isArray(value)) return value.map((v) => stampIds(v, counter));
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(object)) out[key] = stampIds(child, counter);
  if (typeof object.type === "number" || "media" in object) out._id = `n${counter.n++}`;
  return out;
}

/** The issues of one severity as `(code, path)` pairs, ordered the same way the
 *  generator orders them so a comparison is about content, not traversal order. */
function issuesOf(message: WebhookMessage, severity: IssueSeverity): CorpusIssue[] {
  const paths = buildPathIndex(message);
  const seen = new Map<string, CorpusIssue>();
  for (const issue of validateMessage(message).issues) {
    if (issue.severity !== severity) continue;
    const path = (issue.nodeId ? paths.get(issue.nodeId) : undefined) ?? null;
    const key = `${issue.code}@${path ?? ""}`;
    if (!seen.has(key)) seen.set(key, { code: issue.code, path });
  }
  return [...seen.values()].sort((a, b) => {
    // Compare field by field, in code-point order. NOT `localeCompare`:
    // collation is locale- and ICU-version-dependent, so a corpus sorted that
    // way records an order the Rust side (which compares byte-wise) cannot
    // reproduce, and which could differ between two machines running this.
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    const left = a.path ?? "";
    const right = b.path ?? "";
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

const cases = corpus.cases as CorpusCase[];

describe("shared validator corpus", () => {
  it("is big enough to be worth trusting", () => {
    // A corpus that shrank is a corpus someone deleted cases from.
    expect(cases.length).toBeGreaterThanOrEqual(100);
  });

  it("names every case uniquely, so a Rust failure points at one case", () => {
    const names = cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, testCase) => {
    const message = stampIds(testCase.message) as WebhookMessage;
    expect(issuesOf(message, "error")).toEqual(testCase.errors);
    expect(issuesOf(message, "warning")).toEqual(testCase.warnings);
  });
});
