import { describe, expect, it } from "vitest";

import { TEMPLATES } from "@/data/presets";
import { attachEditorFields } from "@/core/serialization/normalize";
import { buildSessionUrl } from "@/core/state/attachmentStore";
import { CODE_TARGETS, generateCode, isCodeTarget } from "./index";
import { prepareCodegenInput } from "./payload";
import { quote } from "./printer";

/**
 * These tests pin what the generators print. That the printed code is *correct*
 * — that discord.js and discord.py really rebuild the source payload from it, and
 * that the HTTP senders really put it on the wire — is proven by running it, in
 * `scripts/verify-codegen.ts`. Keep the two in step: change a generator, run both.
 */

const CARD = attachEditorFields({
  components: [
    {
      type: 17,
      accent_color: 0x5865f2,
      components: [
        { type: 10, content: "# Server update\nEverything you need in one place." },
        { type: 14, divider: true, spacing: 1 },
        {
          type: 1,
          components: [
            { type: 2, style: 5, label: "Read the guide", url: "https://example.com/update" },
          ],
        },
      ],
    },
  ],
});

describe("discord.js target", () => {
  it("prints builders for a container card", () => {
    expect(generateCode(CARD, "discordjs")).toBe(
      [
        "// Components V2 message — discord.js v14.19 or newer.",
        "// Designed in DWEEB (https://dweeb.faizo.net). Edit the text, then send.",
        "const {",
        "  ActionRowBuilder,",
        "  ButtonBuilder,",
        "  ButtonStyle,",
        "  ContainerBuilder,",
        "  MessageFlags,",
        "  SeparatorBuilder,",
        "  SeparatorSpacingSize,",
        "  TextDisplayBuilder,",
        '} = require("discord.js");',
        "",
        "const container = new ContainerBuilder()",
        "  .setAccentColor(0x5865f2)",
        "  .addTextDisplayComponents(",
        "    new TextDisplayBuilder().setContent(",
        "      [",
        '        "# Server update",',
        '        "Everything you need in one place.",',
        '      ].join("\\n"),',
        "    ),",
        "  )",
        "  .addSeparatorComponents(",
        "    new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),",
        "  )",
        "  .addActionRowComponents(",
        "    new ActionRowBuilder().addComponents(",
        "      new ButtonBuilder()",
        "        .setStyle(ButtonStyle.Link)",
        '        .setLabel("Read the guide")',
        '        .setURL("https://example.com/update"),',
        "    ),",
        "  );",
        "",
        "// Send it from any async context: a command handler, an event, a script.",
        "await channel.send({",
        "  components: [container],",
        "  flags: MessageFlags.IsComponentsV2,",
        "});",
        "",
      ].join("\n"),
    );
  });

  it("imports exactly the names the code uses", () => {
    for (const template of TEMPLATES) {
      const code = generateCode(template.message, "discordjs");
      const imported = /const \{([\s\S]*?)\} = require\("discord\.js"\);/
        .exec(code)![1]!
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      const body = code.slice(code.indexOf('require("discord.js");'));
      for (const name of imported) {
        expect(body, `${template.id}: ${name} is imported but unused`).toMatch(
          new RegExp(`\\b${name}\\b`),
        );
      }
      for (const used of body.matchAll(/new (\w+)\(/g)) {
        expect(imported, `${template.id}: ${used[1]} is used but not imported`).toContain(used[1]);
      }
    }
  });

  it("numbers top-level components only when a kind repeats", () => {
    const message = attachEditorFields({
      components: [
        { type: 10, content: "one" },
        { type: 17, components: [{ type: 10, content: "inside" }] },
        { type: 10, content: "two" },
      ],
    });
    expect(generateCode(message, "discordjs")).toContain("components: [text1, container, text2],");
  });

  it("carries silent sends, mentions and tts into the send options", () => {
    const message = attachEditorFields({
      flags: (1 << 15) | (1 << 12),
      tts: true,
      allowed_mentions: { parse: [], roles: ["123"], replied_user: false },
      components: [{ type: 10, content: "hi" }],
    });
    const code = generateCode(message, "discordjs");
    expect(code).toContain(
      "flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications,",
    );
    expect(code).toContain("tts: true,");
    expect(code).toContain('allowedMentions: { parse: [], roles: ["123"], repliedUser: false },');
  });
});

describe("discord.py target", () => {
  it("prints a LayoutView for a container card", () => {
    expect(generateCode(CARD, "discordpy")).toBe(
      [
        "# Components V2 message — discord.py 2.6 or newer.",
        "# Designed in DWEEB (https://dweeb.faizo.net). Edit the text, then send.",
        "import discord",
        "from discord import ui",
        "",
        "",
        "def build_view() -> ui.LayoutView:",
        "    view = ui.LayoutView(timeout=None)",
        "    view.add_item(",
        "        ui.Container(",
        "            ui.TextDisplay(",
        '                "# Server update\\n"',
        '                "Everything you need in one place.",',
        "            ),",
        "            ui.Separator(visible=True, spacing=discord.SeparatorSpacing.small),",
        "            ui.ActionRow(",
        "                ui.Button(",
        "                    style=discord.ButtonStyle.link,",
        '                    label="Read the guide",',
        '                    url="https://example.com/update",',
        "                ),",
        "            ),",
        "            accent_colour=0x5865f2,",
        "        ),",
        "    )",
        "    return view",
        "",
        "",
        "# Send it from any coroutine: a command, an event listener, a task.",
        "await channel.send(view=build_view())",
        "",
      ].join("\n"),
    );
  });

  it("maps an allowed_mentions policy onto discord.AllowedMentions", () => {
    const message = attachEditorFields({
      allowed_mentions: { parse: ["users"], roles: ["123456789012345678"] },
      components: [{ type: 10, content: "hi" }],
    });
    expect(generateCode(message, "discordpy")).toContain(
      "allowed_mentions=discord.AllowedMentions(everyone=False, users=True, roles=[discord.Object(id=123456789012345678)])",
    );
  });

  it("writes snowflakes as ints and leaves a non-numeric id visibly quoted", () => {
    const message = attachEditorFields({
      components: [
        {
          type: 1,
          components: [
            {
              type: 5,
              custom_id: "u",
              default_values: [{ id: "323456789012345678", type: "user" }],
            },
          ],
        },
        {
          type: 1,
          components: [{ type: 2, style: 2, custom_id: "b", emoji: { id: "{emoji}", name: "x" } }],
        },
      ],
    });
    const code = generateCode(message, "discordpy");
    expect(code).toContain("id=323456789012345678,");
    expect(code).toContain("type=discord.SelectDefaultValueType.user,");
    expect(code).toContain('discord.PartialEmoji(name="x", id="{emoji}")');
  });
});

describe("plain-HTTP targets", () => {
  it("never omits with_components — without it Discord drops the components silently", () => {
    for (const target of ["curl", "fetch", "python"] as const) {
      for (const template of TEMPLATES) {
        expect(generateCode(template.message, target), `${target} ${template.id}`).toMatch(
          /with_components(=|": ")true/,
        );
      }
    }
  });

  it("posts the same payload the JSON tab exports", () => {
    const code = generateCode(CARD, "fetch");
    const literal = /const payload = (\{[\s\S]*?\n\});/.exec(code)![1]!;
    expect(JSON.parse(literal)).toEqual(prepareCodegenInput(CARD).payload);
  });

  it("feeds cURL its JSON through a quoted heredoc, so an apostrophe cannot end the argument", () => {
    const message = attachEditorFields({ components: [{ type: 10, content: "Don't panic" }] });
    const code = generateCode(message, "curl");
    expect(code).toContain("--data-binary @- <<'JSON'");
    expect(code).toContain('"content": "Don\'t panic"');
  });

  it("renders Python literals, not JSON ones", () => {
    const message = attachEditorFields({
      components: [{ type: 14, divider: false }],
      allowed_mentions: { parse: [] },
    });
    const code = generateCode(message, "python");
    expect(code).toContain('"divider": False,');
    expect(code).toContain('"parse": [],');
    // Only the literal: the request line below legitimately says "true".
    const literal = code.slice(code.indexOf("payload = "), code.indexOf("# with_components"));
    expect(literal).not.toMatch(/\b(true|false|null)\b/);
  });
});

describe("uploads", () => {
  const upload = buildSessionUrl("blob-1", "banner.png");
  const message = attachEditorFields({
    components: [
      { type: 12, items: [{ media: { url: upload } }, { media: { url: upload } }] },
      { type: 13, file: { url: "attachment://report.pdf" } },
    ],
  });

  it("turns an in-session upload into the attachment:// reference the code can satisfy", () => {
    const input = prepareCodegenInput(message);
    expect(input.attachments).toEqual(["banner.png", "report.pdf"]);
    expect(JSON.stringify(input.payload)).not.toContain("session://");
    expect(JSON.stringify(input.payload)).toContain("attachment://banner.png");
  });

  it("gives two different uploads that share a filename distinct names", () => {
    const clash = attachEditorFields({
      components: [
        {
          type: 12,
          items: [
            { media: { url: buildSessionUrl("blob-1", "shot.png") } },
            { media: { url: buildSessionUrl("blob-2", "shot.png") } },
          ],
        },
      ],
    });
    expect(prepareCodegenInput(clash).attachments).toEqual(["shot.png", "shot_2.png"]);
  });

  it("emits the upload in every target", () => {
    expect(generateCode(message, "discordjs")).toContain(
      'new AttachmentBuilder("./banner.png", { name: "banner.png" }),',
    );
    expect(generateCode(message, "discordpy")).toContain(
      'discord.File("./banner.png", filename="banner.png")',
    );
    expect(generateCode(message, "python")).toContain(
      '"files[1]": ("report.pdf", open("./report.pdf", "rb")),',
    );
    expect(generateCode(message, "fetch")).toContain(
      'form.append("payload_json", JSON.stringify(payload));',
    );
    const curl = generateCode(message, "curl");
    expect(curl).toContain("-F 'payload_json=<-;type=application/json'");
    expect(curl).toContain('-F "files[0]=@./banner.png"');
    // Discord maps each multipart part to its reference through this index.
    expect(curl).toContain('"attachments": [');
  });

  it("drops the fields Discord stamps on a restored media item", () => {
    const restored = attachEditorFields({
      components: [
        {
          type: 12,
          items: [
            {
              media: {
                url: "https://cdn.discordapp.com/x.png",
                proxy_url: "https://media.discordapp.net/x.png",
                width: 10,
                height: 10,
                content_type: "image/png",
                attachment_id: "1",
              },
            },
          ],
        },
      ],
    });
    const media = (
      prepareCodegenInput(restored).payload.components[0] as { items: { media: object }[] }
    ).items[0]!.media;
    expect(media).toEqual({ url: "https://cdn.discordapp.com/x.png" });
  });
});

describe("every target, every template", () => {
  it("generates without throwing and keeps its brackets balanced", () => {
    for (const { id: target } of CODE_TARGETS) {
      for (const template of TEMPLATES) {
        const code = generateCode(template.message, target);
        // String contents can hold any bracket, so compare the code with its
        // double-quoted literals removed.
        const bare = code.replace(/"(?:[^"\\]|\\.)*"/g, '""');
        for (const [open, close] of ["()", "[]", "{}"]) {
          expect(bare.split(open!).length, `${target} ${template.id} ${open}${close}`).toBe(
            bare.split(close!).length,
          );
        }
      }
    }
  });

  it("says when a design relies on something the target cannot express", () => {
    const welcome = TEMPLATES.find((template) => template.id === "welcome")!;
    expect(generateCode(welcome.message, "discordjs")).toContain("webhook-only options");
    const roles = TEMPLATES.find((template) => template.id === "reaction-roles")!;
    expect(generateCode(roles.message, "discordpy")).toContain("custom_id do nothing until");
    expect(generateCode(CARD, "discordjs")).not.toContain("webhook-only");
    expect(generateCode(CARD, "discordjs")).not.toContain("custom ID");
  });
});

describe("string literals", () => {
  it("escapes the two separators an older JavaScript parser treats as a line end", () => {
    const separators = String.fromCharCode(0x2028) + String.fromCharCode(0x2029);
    expect(quote(`a${separators}b`)).toBe('"a\\u2028\\u2029b"');
  });

  it("recognises only real targets", () => {
    expect(isCodeTarget("discordjs")).toBe(true);
    expect(isCodeTarget("toString")).toBe(false);
    expect(isCodeTarget(undefined)).toBe(false);
  });
});
