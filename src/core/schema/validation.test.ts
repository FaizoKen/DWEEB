import { describe, expect, it } from "vitest";

import { validateMessage } from "./validation";
import {
  ButtonStyle,
  ComponentType,
  type AnyComponent,
  type TopLevelComponent,
  type WebhookMessage,
} from "./types";
import { FIXTURES } from "@/test/fixtures";

/** Build a message from top-level components, casting through the loose shapes
 *  the malformed-input tests deliberately construct. */
function msg(components: AnyComponent[], extra: Partial<WebhookMessage> = {}): WebhookMessage {
  return { components: components as unknown as TopLevelComponent[], ...extra };
}

/** Codes present at `error` severity for a message. */
function errorCodes(message: WebhookMessage): Set<string> {
  return new Set(
    validateMessage(message)
      .issues.filter((i) => i.severity === "error")
      .map((i) => i.code),
  );
}

function td(content: string, id = "t"): AnyComponent {
  return { _id: id, type: ComponentType.TextDisplay, content } as unknown as AnyComponent;
}

describe("validateMessage — valid inputs", () => {
  for (const [name, build] of Object.entries(FIXTURES)) {
    it(`accepts the "${name}" fixture`, () => {
      const result = validateMessage(build());
      expect(result.ok).toBe(true);
      expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
    });
  }
});

describe("validateMessage — message-level rules", () => {
  it("rejects an empty message", () => {
    expect(errorCodes(msg([]))).toContain("EMPTY_MESSAGE");
  });

  it("rejects more than the top-level component cap", () => {
    const many = Array.from({ length: 11 }, (_, i) => td(`t${i}`, `n${i}`));
    expect(errorCodes(msg(many))).toContain("TOP_LEVEL_LIMIT");
  });

  it("rejects exceeding the 4000-char message-wide budget", () => {
    const half = "a".repeat(2500);
    expect(errorCodes(msg([td(half, "a"), td(half, "b")]))).toContain("TOTAL_CHARACTER_LIMIT");
  });

  it("rejects a reserved webhook username", () => {
    expect(errorCodes(msg([td("hi")], { username: "Discord Updates" }))).toContain(
      "USERNAME_RESERVED",
    );
  });

  it("rejects an over-long webhook username", () => {
    expect(errorCodes(msg([td("hi")], { username: "u".repeat(81) }))).toContain(
      "USERNAME_TOO_LONG",
    );
  });

  it("rejects conflicting allowed_mentions (parse + explicit list)", () => {
    const m = msg([td("hi")], {
      allowed_mentions: { parse: ["roles"], roles: ["123456789012345678"] },
    });
    expect(errorCodes(m)).toContain("ALLOWED_MENTIONS_CONFLICT_ROLES");
  });

  it("rejects a malformed snowflake in allowed_mentions", () => {
    const m = msg([td("hi")], { allowed_mentions: { users: ["not-a-snowflake"] } });
    expect(errorCodes(m)).toContain("ALLOWED_MENTIONS_BAD_USER");
  });
});

describe("validateMessage — containers & sections", () => {
  it("rejects an empty container", () => {
    const container = {
      _id: "c",
      type: ComponentType.Container,
      components: [],
    } as unknown as AnyComponent;
    expect(errorCodes(msg([container]))).toContain("CONTAINER_EMPTY");
  });

  it("rejects an out-of-range accent colour", () => {
    const container = {
      _id: "c",
      type: ComponentType.Container,
      accent_color: 0x1000000,
      components: [td("hi")],
    } as unknown as AnyComponent;
    expect(errorCodes(msg([container]))).toContain("CONTAINER_ACCENT_RANGE");
  });

  it("rejects a section with the wrong number of text components", () => {
    const section = {
      _id: "s",
      type: ComponentType.Section,
      components: [],
      accessory: {
        _id: "th",
        type: ComponentType.Thumbnail,
        media: { url: "https://x.test/a.png" },
      },
    } as unknown as AnyComponent;
    expect(errorCodes(msg([section]))).toContain("SECTION_TEXT_COUNT");
  });
});

describe("validateMessage — buttons", () => {
  const row = (buttons: AnyComponent[]): AnyComponent =>
    ({ _id: "row", type: ComponentType.ActionRow, components: buttons }) as unknown as AnyComponent;

  it("rejects a link button with an invalid URL", () => {
    const btn = {
      _id: "b",
      type: ComponentType.Button,
      style: ButtonStyle.Link,
      label: "Open",
      url: "not a url",
    } as unknown as AnyComponent;
    expect(errorCodes(msg([row([btn])]))).toContain("BUTTON_URL_INVALID");
  });

  it("exempts a link button whose URL is an unresolved {placeholder}", () => {
    const btn = {
      _id: "b",
      type: ComponentType.Button,
      style: ButtonStyle.Link,
      label: "Open",
      url: "{server_icon}",
    } as unknown as AnyComponent;
    expect(errorCodes(msg([row([btn])]))).not.toContain("BUTTON_URL_INVALID");
  });

  it("rejects an interactive button with no custom_id", () => {
    const btn = {
      _id: "b",
      type: ComponentType.Button,
      style: ButtonStyle.Primary,
      label: "Go",
      custom_id: "",
    } as unknown as AnyComponent;
    expect(errorCodes(msg([row([btn])]))).toContain("BUTTON_CUSTOM_ID_MISSING");
  });

  it("rejects a button with neither label nor emoji", () => {
    const btn = {
      _id: "b",
      type: ComponentType.Button,
      style: ButtonStyle.Primary,
      custom_id: "go",
    } as unknown as AnyComponent;
    expect(errorCodes(msg([row([btn])]))).toContain("BUTTON_NO_LABEL");
  });

  it("rejects a row with more than five buttons", () => {
    const buttons = Array.from({ length: 6 }, (_, i) => ({
      _id: `b${i}`,
      type: ComponentType.Button,
      style: ButtonStyle.Primary,
      label: `B${i}`,
      custom_id: `c${i}`,
    })) as unknown as AnyComponent[];
    expect(errorCodes(msg([row(buttons)]))).toContain("ROW_LIMIT");
  });

  it("rejects buttons that share a custom_id", () => {
    const buttons = [
      {
        _id: "b1",
        type: ComponentType.Button,
        style: ButtonStyle.Primary,
        label: "A",
        custom_id: "dup",
      },
      {
        _id: "b2",
        type: ComponentType.Button,
        style: ButtonStyle.Primary,
        label: "B",
        custom_id: "dup",
      },
    ] as unknown as AnyComponent[];
    expect(errorCodes(msg([row(buttons)]))).toContain("CUSTOM_ID_DUPLICATE");
  });
});

describe("validateMessage — selects", () => {
  const selectRow = (select: Record<string, unknown>): AnyComponent =>
    ({
      _id: "row",
      type: ComponentType.ActionRow,
      components: [select],
    }) as unknown as AnyComponent;

  const stringSelect = (over: Record<string, unknown>) => ({
    _id: "sel",
    type: ComponentType.StringSelect,
    custom_id: "s",
    options: [
      { label: "A", value: "a" },
      { label: "B", value: "b" },
    ],
    ...over,
  });

  it("rejects a string select with no options", () => {
    expect(errorCodes(msg([selectRow(stringSelect({ options: [] }))]))).toContain(
      "SELECT_NO_OPTIONS",
    );
  });

  it("rejects duplicate option values", () => {
    const opts = [
      { label: "A", value: "same" },
      { label: "B", value: "same" },
    ];
    expect(errorCodes(msg([selectRow(stringSelect({ options: opts }))]))).toContain(
      "OPTION_VALUE_DUP",
    );
  });

  it("rejects max_values exceeding the option count", () => {
    expect(errorCodes(msg([selectRow(stringSelect({ max_values: 3 }))]))).toContain(
      "SELECT_MAX_OVER_OPTIONS",
    );
  });

  it("rejects min_values greater than max_values", () => {
    const sel = stringSelect({ min_values: 2, max_values: 1 });
    expect(errorCodes(msg([selectRow(sel)]))).toContain("SELECT_MIN_GT_MAX");
  });

  it("rejects mixing a select and a button in one row", () => {
    const mixedRow = {
      _id: "row",
      type: ComponentType.ActionRow,
      components: [
        {
          _id: "b",
          type: ComponentType.Button,
          style: ButtonStyle.Primary,
          label: "X",
          custom_id: "x",
        },
        stringSelect({ custom_id: "s2" }),
      ],
    } as unknown as AnyComponent;
    expect(errorCodes(msg([mixedRow]))).toContain("ROW_SELECT_MIXED");
  });
});

describe("validateMessage — media & files", () => {
  it("rejects media with neither URL nor attachment_id", () => {
    const section = {
      _id: "s",
      type: ComponentType.Section,
      components: [td("hi")],
      accessory: { _id: "th", type: ComponentType.Thumbnail, media: {} },
    } as unknown as AnyComponent;
    expect(errorCodes(msg([section]))).toContain("MEDIA_REQUIRED");
  });

  it("rejects a File pointing at an external URL rather than an attachment", () => {
    const file = {
      _id: "f",
      type: ComponentType.File,
      file: { url: "https://example.com/report.pdf" },
    } as unknown as AnyComponent;
    expect(errorCodes(msg([file]))).toContain("FILE_URL_NOT_ATTACHMENT");
  });
});

describe("validateMessage — duplicate component ids", () => {
  it("rejects two components sharing a numeric id", () => {
    const a = { _id: "a", type: ComponentType.TextDisplay, content: "a", id: 5 };
    const b = { _id: "b", type: ComponentType.TextDisplay, content: "b", id: 5 };
    expect(errorCodes(msg([a as unknown as AnyComponent, b as unknown as AnyComponent]))).toContain(
      "COMPONENT_ID_DUPLICATE",
    );
  });
});
