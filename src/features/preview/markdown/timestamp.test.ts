import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMESTAMP_STYLE,
  formatTimestamp,
  isTimestampStyle,
  parseTimestampInput,
  TIMESTAMP_STYLES,
  timestampToken,
} from "./timestamp";

// 2026-01-01T00:00:00Z — the example the timestamp guide uses throughout.
const NEW_YEAR = 1767225600;

describe("TIMESTAMP_STYLES", () => {
  it("lists Discord's nine styles in its reference order", () => {
    expect(TIMESTAMP_STYLES.map((style) => style.code).join("")).toBe("tTdDfFsSR");
  });

  it("defaults to f, the style Discord uses for a bare <t:unix>", () => {
    expect(DEFAULT_TIMESTAMP_STYLE).toBe("f");
    expect(isTimestampStyle(DEFAULT_TIMESTAMP_STYLE)).toBe(true);
  });

  it("is case-sensitive about style letters", () => {
    expect(isTimestampStyle("s")).toBe(true);
    expect(isTimestampStyle("S")).toBe(true);
    expect(isTimestampStyle("r")).toBe(false);
    expect(isTimestampStyle("x")).toBe(false);
  });
});

describe("formatTimestamp", () => {
  const at = new Date(NEW_YEAR * 1000);
  // Locale- and zone-independent: the expectation uses the same runtime
  // defaults the formatter does, so this pins which Intl fields each style
  // asks for rather than one machine's rendering of them.
  const expected = (options: Intl.DateTimeFormatOptions) => at.toLocaleString([], options);

  it("renders t and T as Intl's short and medium time — the time f ends with", () => {
    expect(formatTimestamp(NEW_YEAR, "t")).toBe(at.toLocaleTimeString([], { timeStyle: "short" }));
    expect(formatTimestamp(NEW_YEAR, "T")).toBe(at.toLocaleTimeString([], { timeStyle: "medium" }));
    expect(formatTimestamp(NEW_YEAR, "f")).toContain(formatTimestamp(NEW_YEAR, "t"));
  });

  it("renders s as a numeric date with a short time", () => {
    expect(formatTimestamp(NEW_YEAR, "s")).toBe(
      expected({
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    );
  });

  it("renders S like s plus seconds", () => {
    expect(formatTimestamp(NEW_YEAR, "S")).toBe(
      expected({
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      }),
    );
  });

  it("gives every listed style its own rendering", () => {
    const outputs = TIMESTAMP_STYLES.filter((style) => style.code !== "R").map((style) =>
      formatTimestamp(NEW_YEAR, style.code),
    );
    expect(new Set(outputs).size).toBe(outputs.length);
    for (const output of outputs) expect(output).not.toMatch(/invalid/i);
  });

  it("words the relative style from now", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(formatTimestamp(now + 3 * 86_400, "R")).toBe(
      new Intl.RelativeTimeFormat(undefined, { numeric: "always" }).format(3, "day"),
    );
    expect(formatTimestamp(now - 2 * 3600, "R")).toBe(
      new Intl.RelativeTimeFormat(undefined, { numeric: "always" }).format(-2, "hour"),
    );
  });
});

describe("timestampToken", () => {
  it("builds the token Discord replaces", () => {
    expect(timestampToken(NEW_YEAR, "F")).toBe("<t:1767225600:F>");
    expect(timestampToken(NEW_YEAR + 0.9, "R")).toBe("<t:1767225600:R>");
  });
});

describe("parseTimestampInput", () => {
  it("reads a full token, a bracketless one and one without a style", () => {
    expect(parseTimestampInput("<t:1767225600:R>")).toEqual({ unix: NEW_YEAR, style: "R" });
    expect(parseTimestampInput("t:1767225600:S")).toEqual({ unix: NEW_YEAR, style: "S" });
    expect(parseTimestampInput("  <t:1767225600>  ")).toEqual({ unix: NEW_YEAR });
  });

  it("reads seconds, and treats 13+ digits as milliseconds", () => {
    expect(parseTimestampInput("1767225600")).toEqual({ unix: NEW_YEAR });
    expect(parseTimestampInput("1767225600123")).toEqual({
      unix: NEW_YEAR,
      fromMilliseconds: true,
    });
  });

  it("accepts dates before 1970", () => {
    expect(parseTimestampInput("-86400")).toEqual({ unix: -86_400 });
  });

  it("refuses what it cannot read instead of guessing", () => {
    for (const raw of ["", "   ", "tomorrow", "<t:abc:R>", "<t:1767225600:x>", "12.5", "1e9"]) {
      expect(parseTimestampInput(raw)).toBeNull();
    }
  });

  it("refuses a value Date cannot represent", () => {
    expect(parseTimestampInput("<t:9999999999999999:F>")).toBeNull();
  });
});
