import { describe, expect, it } from "vitest";

import { validateDestination, validateMessage } from "./validation";
import {
  ButtonStyle,
  ComponentType,
  type AnyComponent,
  type TopLevelComponent,
  type WebhookMessage,
} from "./types";
import {
  forgetAttachment,
  parseSessionUrl,
  registerAttachment,
} from "@/core/state/attachmentStore";
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

  /**
   * The import boundary refuses an accessory-less section outright, so this
   * only guards trees that reach the editor another way (a collab op from a
   * peer, a hand-mutated store). It must be *reported*, never crashed on:
   * validation walks the tree through `countCharacters`, which probes fields
   * with the `in` operator — and `in` throws on `undefined` instead of
   * answering false. That TypeError escaped a click handler in prod
   * (2026-07-26: "Cannot use 'in' operator to search for 'content' in
   * undefined") and paged the maintainer.
   */
  it("reports a section with no accessory rather than throwing", () => {
    const section = {
      _id: "s",
      type: ComponentType.Section,
      components: [td("hi")],
    } as unknown as AnyComponent;
    const message = msg([section]);
    expect(() => validateMessage(message)).not.toThrow();
    expect(errorCodes(message)).toContain("SECTION_ACCESSORY_MISSING");
  });

  /** Same shape as the accessory case: `content.trim()` on an absent field. */
  it("reports a text display with no `content` rather than throwing", () => {
    const text = { _id: "t", type: ComponentType.TextDisplay } as unknown as AnyComponent;
    const message = msg([text]);
    expect(() => validateMessage(message)).not.toThrow();
    expect(errorCodes(message)).toContain("TEXT_EMPTY");
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

  // Second layer behind `repairStructure`, which fills a missing `url` with
  // "". A tree that reaches the validator some other way (a peer's collab op,
  // a stale draft) must be *reported* — the deref used to throw a TypeError
  // out of the live validator, which runs on every keystroke.
  it("reports a link button with no `url` at all instead of throwing", () => {
    const btn = {
      _id: "b",
      type: ComponentType.Button,
      style: ButtonStyle.Link,
      label: "Open",
    } as unknown as AnyComponent;
    expect(() => validateMessage(msg([row([btn])]))).not.toThrow();
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

// Only the editor keeps components where Discord accepts them. An imported tree
// (JSON import, a share link, an AI reply, a peer's collab op) can hold a button
// at the top level or a thumbnail inside a container; that used to validate
// clean and then 400 at Discord on send.
describe("validateMessage — component placement", () => {
  const button = (id: string, over: Record<string, unknown> = {}): AnyComponent =>
    ({
      _id: id,
      type: ComponentType.Button,
      style: ButtonStyle.Primary,
      label: "Go",
      custom_id: `go-${id}`,
      ...over,
    }) as unknown as AnyComponent;
  const menu = (id: string): AnyComponent =>
    ({
      _id: id,
      type: ComponentType.StringSelect,
      custom_id: `pick-${id}`,
      options: [{ label: "One", value: "1" }],
    }) as unknown as AnyComponent;
  const thumb = (id: string): AnyComponent =>
    ({
      _id: id,
      type: ComponentType.Thumbnail,
      media: { url: "https://example.test/i.png" },
    }) as unknown as AnyComponent;
  const node = (id: string, type: number, fields: Record<string, unknown>): AnyComponent =>
    ({ _id: id, type, ...fields }) as unknown as AnyComponent;

  /** Every error as `code@nodeId`, so a test pins the component blamed too. */
  function blamed(message: WebhookMessage): string[] {
    return validateMessage(message)
      .issues.filter((i) => i.severity === "error")
      .map((i) => `${i.code}@${i.nodeId ?? ""}`)
      .sort();
  }

  it("rejects a button at the top level", () => {
    const result = validateMessage(msg([td("hi"), button("b")]));
    expect(result.ok).toBe(false);
    expect(blamed(msg([td("hi"), button("b")]))).toEqual(["BUTTON_OUTSIDE_ROW@b"]);
  });

  it("rejects a button placed directly in a container, and still checks its own fields", () => {
    const container = node("c", ComponentType.Container, {
      components: [td("hi"), button("b", { label: undefined })],
    });
    expect(blamed(msg([container]))).toEqual(["BUTTON_NO_LABEL@b", "BUTTON_OUTSIDE_ROW@b"]);
  });

  it("rejects a menu anywhere but an action row", () => {
    const section = node("s", ComponentType.Section, {
      components: [td("hi")],
      accessory: menu("m2"),
    });
    expect(blamed(msg([menu("m1"), section]))).toEqual([
      "SELECT_OUTSIDE_ROW@m1",
      "SELECT_OUTSIDE_ROW@m2",
    ]);
  });

  it("accepts a button or a thumbnail as a section's accessory", () => {
    const withButton = node("s1", ComponentType.Section, {
      components: [td("hi", "t1")],
      accessory: button("b"),
    });
    const withThumb = node("s2", ComponentType.Section, {
      components: [td("hi", "t2")],
      accessory: thumb("th"),
    });
    expect(blamed(msg([withButton, withThumb]))).toEqual([]);
  });

  it("rejects a thumbnail anywhere but a section's accessory", () => {
    const container = node("c", ComponentType.Container, { components: [thumb("th2")] });
    expect(blamed(msg([thumb("th1"), container]))).toEqual([
      "COMPONENT_MISPLACED@th1",
      "COMPONENT_MISPLACED@th2",
    ]);
  });

  it("rejects a nested container, and still checks what's inside it", () => {
    const inner = node("inner", ComponentType.Container, { components: [td("  ", "t-empty")] });
    const outer = node("outer", ComponentType.Container, { components: [inner] });
    expect(blamed(msg([outer]))).toEqual(["COMPONENT_MISPLACED@inner", "TEXT_EMPTY@t-empty"]);
  });

  // A row child that isn't a button used to be validated *as a button*, so a
  // text display in a row read "Button needs a custom ID" — about a button
  // that doesn't exist — and nothing said the row itself was wrong.
  it("rejects anything in a row that isn't a button or a menu, without treating it as a button", () => {
    const row = node("row", ComponentType.ActionRow, {
      components: [button("b"), td("hi", "t-row")],
    });
    expect(blamed(msg([row]))).toEqual(["COMPONENT_MISPLACED@t-row"]);
  });

  it("rejects anything but text in a section's text", () => {
    const section = node("s", ComponentType.Section, {
      components: [td("hi"), button("b")],
      accessory: thumb("th"),
    });
    expect(blamed(msg([section]))).toEqual(["BUTTON_OUTSIDE_ROW@b"]);
  });

  it("rejects anything but a button or a thumbnail as a section's accessory", () => {
    const section = node("s", ComponentType.Section, {
      components: [td("hi")],
      accessory: td("not an accessory", "t-acc"),
    });
    expect(blamed(msg([section]))).toEqual(["COMPONENT_MISPLACED@t-acc"]);
  });

  it("rejects a text input, which only works in a modal", () => {
    const input = node("in", ComponentType.TextInput, {
      custom_id: "name",
      style: 1,
      label: "Name",
    });
    const [issue] = validateMessage(msg([input])).issues;
    expect(issue?.code).toBe("COMPONENT_MISPLACED");
    expect(issue?.message).toMatch(/modal/);
  });

  // Discord adds component types; a type this schema doesn't know may be valid
  // where it sits, so it is left for Discord to judge rather than blocked here.
  it("leaves a component type it doesn't know to Discord", () => {
    expect(validateMessage(msg([td("hi"), node("new", 99, {})])).issues).toEqual([]);
  });

  it("names the component in the editor's words", () => {
    const messages = validateMessage(msg([thumb("th"), menu("m")])).issues.map((i) => i.message);
    expect(messages).toContain(
      "Thumbnail can't sit at the top level of a message — it can only be a section's accessory.",
    );
    expect(messages).toContain(
      "Options menu can't sit at the top level of a message — put it in an action row of its own.",
    );
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

describe("validateMessage — in-session uploads", () => {
  function fileComp(url: string): AnyComponent {
    return { _id: "f", type: ComponentType.File, file: { url } } as unknown as AnyComponent;
  }

  it("errors when a session:// upload's bytes aren't in this browser", () => {
    // A reference synced in from a collaborator, or a resumed room draft — the
    // URL parses fine, but no local blob backs it, so a send from here would
    // ship a dangling attachment:// reference Discord rejects.
    expect(errorCodes(msg([fileComp("session://nosuchblob/team-logo.png")]))).toContain(
      "ATTACHMENT_MISSING",
    );
  });

  it("accepts a session:// upload whose blob is registered locally", () => {
    const url = registerAttachment(new File(["x"], "logo.png", { type: "image/png" }));
    try {
      expect(errorCodes(msg([fileComp(url)]))).not.toContain("ATTACHMENT_MISSING");
    } finally {
      forgetAttachment(parseSessionUrl(url)!.blobId);
    }
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

describe("validateDestination — forum/media post titles", () => {
  it("requires a thread_name for forum (15) and media (16) destinations", () => {
    for (const type of [15, 16]) {
      const issues = validateDestination({}, type);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.code).toBe("THREAD_NAME_REQUIRED");
      expect(issues[0]!.severity).toBe("error");
      // Message-level: no node to point at — the meta banner shows it.
      expect(issues[0]!.nodeId).toBeUndefined();
    }
  });

  it("a blank/whitespace title still counts as missing", () => {
    expect(validateDestination({ thread_name: "   " }, 15)).toHaveLength(1);
  });

  it("passes once a title is set", () => {
    expect(validateDestination({ thread_name: "Release notes" }, 15)).toHaveLength(0);
    expect(validateDestination({ thread_name: "Release notes" }, 16)).toHaveLength(0);
  });

  it("validates nothing for non-thread-only or unknown destinations", () => {
    for (const type of [0, 2, 5, 13]) {
      expect(validateDestination({}, type)).toHaveLength(0);
    }
    // Unknown destination (web surfaces, or no channel picked yet) — no-op.
    expect(validateDestination({}, null)).toHaveLength(0);
    expect(validateDestination({}, undefined)).toHaveLength(0);
  });

  it("names the destination channel in the advice when known", () => {
    const [issue] = validateDestination({}, 15, "help-forum");
    expect(issue!.message).toContain("#help-forum");
  });
});

describe("validateDestination — title on a non-forum destination", () => {
  it("rejects a thread_name when the destination can't take one", () => {
    // Discord 400s a webhook execute carrying thread_name on anything that
    // isn't a forum/media channel — text, announcement, voice, stage alike.
    for (const type of [0, 2, 5, 13]) {
      const issues = validateDestination({ thread_name: "Release notes" }, type);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.code).toBe("THREAD_NAME_FORBIDDEN");
      expect(issues[0]!.severity).toBe("error");
      expect(issues[0]!.nodeId).toBeUndefined();
    }
  });

  it("a blank title doesn't trip the non-forum rejection", () => {
    expect(validateDestination({ thread_name: "   " }, 0)).toHaveLength(0);
    expect(validateDestination({}, 0)).toHaveLength(0);
  });

  it("stays quiet when the destination is unknown, even with a title set", () => {
    // The web app doesn't track a destination while editing — a title there
    // is covered by the send-time capability note, not a hard error.
    expect(validateDestination({ thread_name: "Release notes" }, null)).toHaveLength(0);
    expect(validateDestination({ thread_name: "Release notes" }, undefined)).toHaveLength(0);
  });

  it("names the destination channel in the advice when known", () => {
    const [issue] = validateDestination({ thread_name: "Release notes" }, 0, "general");
    expect(issue!.message).toContain("#general");
  });
});
