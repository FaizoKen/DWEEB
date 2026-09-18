/**
 * discord.js (v14.19+) builder code for a Components V2 message.
 *
 * Every method name here was checked against the published package by running
 * the generated code and comparing each builder's `toJSON()` with the payload it
 * came from (`scripts/verify-codegen.ts`) — the builders validate eagerly, so a
 * wrong call is a thrown error there rather than a silent mistake here.
 */

import { ButtonStyle, ComponentType, SeparatorSpacing } from "@/core/schema/types";
import { hasInteractiveComponents, type CodegenInput, type WireNode } from "./payload";
import { assign, hexColor, jsString, quote, raw, type Expr } from "./printer";

const UNIT = 2;
const SUPPRESS_NOTIFICATIONS = 1 << 12;

const BUTTON_STYLES: Record<number, string> = {
  [ButtonStyle.Primary]: "Primary",
  [ButtonStyle.Secondary]: "Secondary",
  [ButtonStyle.Success]: "Success",
  [ButtonStyle.Danger]: "Danger",
  [ButtonStyle.Link]: "Link",
  [ButtonStyle.Premium]: "Premium",
};

/** discord-api-types names for the channel types a Channel Select can filter by. */
const CHANNEL_TYPES: Record<number, string> = {
  0: "GuildText",
  1: "DM",
  2: "GuildVoice",
  3: "GroupDM",
  4: "GuildCategory",
  5: "GuildAnnouncement",
  10: "AnnouncementThread",
  11: "PublicThread",
  12: "PrivateThread",
  13: "GuildStageVoice",
  14: "GuildDirectory",
  15: "GuildForum",
  16: "GuildMedia",
};

const TOP_LEVEL_NAMES: Record<number, string> = {
  [ComponentType.ActionRow]: "row",
  [ComponentType.Section]: "section",
  [ComponentType.TextDisplay]: "text",
  [ComponentType.MediaGallery]: "gallery",
  [ComponentType.File]: "file",
  [ComponentType.Separator]: "separator",
  [ComponentType.Container]: "container",
};

class Generator {
  /** Names destructured from `discord.js`, so the import lists only what is used. */
  readonly imports = new Set<string>();

  private use(name: string): string {
    this.imports.add(name);
    return name;
  }

  private chain(builder: string, node: WireNode, calls: { name: string; args: Expr[] }[]): Expr {
    const all =
      typeof node.id === "number"
        ? [{ name: "setId", args: [raw(String(node.id))] }, ...calls]
        : calls;
    return { kind: "chain", head: `new ${this.use(builder)}()`, calls: all };
  }

  private emoji(value: unknown): Expr | null {
    if (!value || typeof value !== "object") return null;
    const emoji = value as { id?: string | null; name?: string | null; animated?: boolean };
    if (emoji.id) {
      const fields = [`id: ${quote(emoji.id)}`];
      if (emoji.name) fields.push(`name: ${quote(emoji.name)}`);
      if (emoji.animated) fields.push("animated: true");
      return raw(`{ ${fields.join(", ")} }`);
    }
    return emoji.name ? raw(quote(emoji.name)) : null;
  }

  private mediaUrl(value: unknown): Expr {
    const url = value && typeof value === "object" ? (value as { url?: unknown }).url : undefined;
    return raw(quote(typeof url === "string" ? url : ""));
  }

  private button(node: WireNode): Expr {
    const style = typeof node.style === "number" ? node.style : ButtonStyle.Secondary;
    const calls = [
      {
        name: "setStyle",
        args: [raw(`${this.use("ButtonStyle")}.${BUTTON_STYLES[style] ?? "Secondary"}`)],
      },
    ];
    if (typeof node.label === "string" && node.label) {
      calls.push({ name: "setLabel", args: [raw(quote(node.label))] });
    }
    const emoji = this.emoji(node.emoji);
    if (emoji) calls.push({ name: "setEmoji", args: [emoji] });
    if (typeof node.url === "string") calls.push({ name: "setURL", args: [raw(quote(node.url))] });
    if (typeof node.custom_id === "string") {
      calls.push({ name: "setCustomId", args: [raw(quote(node.custom_id))] });
    }
    if (typeof node.sku_id === "string") {
      calls.push({ name: "setSKUId", args: [raw(quote(node.sku_id))] });
    }
    if (node.disabled === true) calls.push({ name: "setDisabled", args: [raw("true")] });
    return this.chain("ButtonBuilder", node, calls);
  }

  private select(node: WireNode): Expr {
    const builders: Record<number, string> = {
      [ComponentType.StringSelect]: "StringSelectMenuBuilder",
      [ComponentType.UserSelect]: "UserSelectMenuBuilder",
      [ComponentType.RoleSelect]: "RoleSelectMenuBuilder",
      [ComponentType.MentionableSelect]: "MentionableSelectMenuBuilder",
      [ComponentType.ChannelSelect]: "ChannelSelectMenuBuilder",
    };
    const calls: { name: string; args: Expr[] }[] = [
      { name: "setCustomId", args: [raw(quote(String(node.custom_id ?? "")))] },
    ];
    if (typeof node.placeholder === "string" && node.placeholder) {
      calls.push({ name: "setPlaceholder", args: [raw(quote(node.placeholder))] });
    }
    if (typeof node.min_values === "number") {
      calls.push({ name: "setMinValues", args: [raw(String(node.min_values))] });
    }
    if (typeof node.max_values === "number") {
      calls.push({ name: "setMaxValues", args: [raw(String(node.max_values))] });
    }
    if (node.disabled === true) calls.push({ name: "setDisabled", args: [raw("true")] });

    if (node.type === ComponentType.ChannelSelect && Array.isArray(node.channel_types)) {
      const types = (node.channel_types as unknown[]).filter(
        (value): value is number => typeof value === "number",
      );
      if (types.length) {
        calls.push({
          name: "setChannelTypes",
          args: types.map((value) =>
            raw(
              CHANNEL_TYPES[value]
                ? `${this.use("ChannelType")}.${CHANNEL_TYPES[value]}`
                : String(value),
            ),
          ),
        });
      }
    }

    if (node.type === ComponentType.StringSelect) {
      const options = Array.isArray(node.options) ? (node.options as WireNode[]) : [];
      if (options.length) {
        calls.push({
          name: "addOptions",
          args: options.map((option) => {
            const optionCalls: { name: string; args: Expr[] }[] = [
              { name: "setLabel", args: [raw(quote(String(option.label ?? "")))] },
              { name: "setValue", args: [raw(quote(String(option.value ?? "")))] },
            ];
            if (typeof option.description === "string" && option.description) {
              optionCalls.push({ name: "setDescription", args: [raw(quote(option.description))] });
            }
            const emoji = this.emoji(option.emoji);
            if (emoji) optionCalls.push({ name: "setEmoji", args: [emoji] });
            if (option.default === true)
              optionCalls.push({ name: "setDefault", args: [raw("true")] });
            return {
              kind: "chain",
              head: `new ${this.use("StringSelectMenuOptionBuilder")}()`,
              calls: optionCalls,
            } satisfies Expr;
          }),
        });
      }
    } else {
      const defaults = Array.isArray(node.default_values)
        ? (node.default_values as { id?: unknown; type?: unknown }[])
        : [];
      const idsOf = (type: string) =>
        defaults
          .filter((value) => value.type === type && typeof value.id === "string")
          .map((value) => raw(quote(value.id as string)));
      const groups: [string, Expr[]][] = [
        ["addDefaultUsers", idsOf("user")],
        ["addDefaultRoles", idsOf("role")],
        ["addDefaultChannels", idsOf("channel")],
      ];
      for (const [name, args] of groups) if (args.length) calls.push({ name, args });
    }
    return this.chain(builders[node.type as number] ?? "StringSelectMenuBuilder", node, calls);
  }

  private actionRow(node: WireNode): Expr {
    const children = Array.isArray(node.components) ? (node.components as WireNode[]) : [];
    return this.chain("ActionRowBuilder", node, [
      {
        name: "addComponents",
        args: children.map((child) =>
          child.type === ComponentType.Button ? this.button(child) : this.select(child),
        ),
      },
    ]);
  }

  private textDisplay(node: WireNode): Expr {
    return this.chain("TextDisplayBuilder", node, [
      { name: "setContent", args: [jsString(String(node.content ?? ""))] },
    ]);
  }

  private thumbnail(node: WireNode): Expr {
    const calls = [{ name: "setURL", args: [this.mediaUrl(node.media)] }];
    if (typeof node.description === "string" && node.description) {
      calls.push({ name: "setDescription", args: [raw(quote(node.description))] });
    }
    if (node.spoiler === true) calls.push({ name: "setSpoiler", args: [raw("true")] });
    return this.chain("ThumbnailBuilder", node, calls);
  }

  private section(node: WireNode): Expr {
    const texts = Array.isArray(node.components) ? (node.components as WireNode[]) : [];
    const calls: { name: string; args: Expr[] }[] = [
      { name: "addTextDisplayComponents", args: texts.map((text) => this.textDisplay(text)) },
    ];
    const accessory = node.accessory as WireNode | undefined;
    if (accessory?.type === ComponentType.Button) {
      calls.push({ name: "setButtonAccessory", args: [this.button(accessory)] });
    } else if (accessory?.type === ComponentType.Thumbnail) {
      calls.push({ name: "setThumbnailAccessory", args: [this.thumbnail(accessory)] });
    }
    return this.chain("SectionBuilder", node, calls);
  }

  private gallery(node: WireNode): Expr {
    const items = Array.isArray(node.items) ? (node.items as WireNode[]) : [];
    return this.chain("MediaGalleryBuilder", node, [
      {
        name: "addItems",
        args: items.map((item) => {
          const calls = [{ name: "setURL", args: [this.mediaUrl(item.media)] }];
          if (typeof item.description === "string" && item.description) {
            calls.push({ name: "setDescription", args: [raw(quote(item.description))] });
          }
          if (item.spoiler === true) calls.push({ name: "setSpoiler", args: [raw("true")] });
          return {
            kind: "chain",
            head: `new ${this.use("MediaGalleryItemBuilder")}()`,
            calls,
          } satisfies Expr;
        }),
      },
    ]);
  }

  private separator(node: WireNode): Expr {
    const calls: { name: string; args: Expr[] }[] = [];
    if (typeof node.divider === "boolean") {
      calls.push({ name: "setDivider", args: [raw(String(node.divider))] });
    }
    if (typeof node.spacing === "number") {
      const size = node.spacing === SeparatorSpacing.Large ? "Large" : "Small";
      calls.push({
        name: "setSpacing",
        args: [raw(`${this.use("SeparatorSpacingSize")}.${size}`)],
      });
    }
    return this.chain("SeparatorBuilder", node, calls);
  }

  private file(node: WireNode): Expr {
    const calls = [{ name: "setURL", args: [this.mediaUrl(node.file)] }];
    if (node.spoiler === true) calls.push({ name: "setSpoiler", args: [raw("true")] });
    return this.chain("FileBuilder", node, calls);
  }

  private container(node: WireNode): Expr {
    const calls: { name: string; args: Expr[] }[] = [];
    if (typeof node.accent_color === "number") {
      calls.push({ name: "setAccentColor", args: [raw(hexColor(node.accent_color))] });
    }
    if (node.spoiler === true) calls.push({ name: "setSpoiler", args: [raw("true")] });
    const adders: Record<number, [string, (child: WireNode) => Expr]> = {
      [ComponentType.ActionRow]: ["addActionRowComponents", (child) => this.actionRow(child)],
      [ComponentType.TextDisplay]: ["addTextDisplayComponents", (child) => this.textDisplay(child)],
      [ComponentType.Section]: ["addSectionComponents", (child) => this.section(child)],
      [ComponentType.MediaGallery]: ["addMediaGalleryComponents", (child) => this.gallery(child)],
      [ComponentType.Separator]: ["addSeparatorComponents", (child) => this.separator(child)],
      [ComponentType.File]: ["addFileComponents", (child) => this.file(child)],
    };
    const children = Array.isArray(node.components) ? (node.components as WireNode[]) : [];
    for (const child of children) {
      const adder = adders[child.type as number];
      if (!adder) continue;
      // Consecutive children of one kind share a call, as they would by hand.
      const last = calls.at(-1);
      if (last?.name === adder[0]) last.args.push(adder[1](child));
      else calls.push({ name: adder[0], args: [adder[1](child)] });
    }
    return this.chain("ContainerBuilder", node, calls);
  }

  topLevel(node: WireNode): Expr | null {
    switch (node.type) {
      case ComponentType.ActionRow:
        return this.actionRow(node);
      case ComponentType.Section:
        return this.section(node);
      case ComponentType.TextDisplay:
        return this.textDisplay(node);
      case ComponentType.MediaGallery:
        return this.gallery(node);
      case ComponentType.File:
        return this.file(node);
      case ComponentType.Separator:
        return this.separator(node);
      case ComponentType.Container:
        return this.container(node);
      default:
        return null;
    }
  }

  useImport(name: string): string {
    return this.use(name);
  }
}

/** `row`, or `row1`/`row2` when a message has several of one kind. */
export function nameTopLevel(nodes: readonly WireNode[], names: Record<number, string>): string[] {
  const totals = new Map<string, number>();
  for (const node of nodes) {
    const base = names[node.type as number] ?? "component";
    totals.set(base, (totals.get(base) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return nodes.map((node) => {
    const base = names[node.type as number] ?? "component";
    if (totals.get(base) === 1) return base;
    const next = (seen.get(base) ?? 0) + 1;
    seen.set(base, next);
    return `${base}${next}`;
  });
}

export function generateDiscordJs({ payload, attachments }: CodegenInput): string {
  const generator = new Generator();
  const known = payload.components.filter((node) => TOP_LEVEL_NAMES[node.type as number]);
  const names = nameTopLevel(known, TOP_LEVEL_NAMES);

  const declarations: string[] = [];
  known.forEach((node, index) => {
    const expr = generator.topLevel(node);
    if (!expr) return;
    declarations.push(...assign(`const ${names[index]} = `, expr, ";", UNIT), "");
  });

  const flags = [`${generator.useImport("MessageFlags")}.IsComponentsV2`];
  if (payload.flags & SUPPRESS_NOTIFICATIONS) flags.push("MessageFlags.SuppressNotifications");

  const send = [
    "await channel.send({",
    `  components: [${names.join(", ")}],`,
    `  flags: ${flags.join(" | ")},`,
  ];
  if (payload.tts) send.push("  tts: true,");
  if (payload.allowed_mentions) {
    const mentions = payload.allowed_mentions;
    const fields: string[] = [];
    if (mentions.parse) fields.push(`parse: [${mentions.parse.map(quote).join(", ")}]`);
    if (mentions.roles?.length) fields.push(`roles: [${mentions.roles.map(quote).join(", ")}]`);
    if (mentions.users?.length) fields.push(`users: [${mentions.users.map(quote).join(", ")}]`);
    if (typeof mentions.replied_user === "boolean")
      fields.push(`repliedUser: ${mentions.replied_user}`);
    send.push(`  allowedMentions: { ${fields.join(", ")} },`);
  }
  if (attachments.length) {
    send.push("  files: [");
    for (const name of attachments) {
      send.push(
        `    new ${generator.useImport("AttachmentBuilder")}(${quote(`./${name}`)}, { name: ${quote(name)} }),`,
      );
    }
    send.push("  ],");
  }
  send.push("});");

  const notes: string[] = [];
  if (attachments.length) {
    notes.push(
      "// attachment:// URLs resolve against the uploaded files below — keep each",
      "// file's `name` identical to the one its component references.",
    );
  }
  if (hasInteractiveComponents(payload.components)) {
    notes.push(
      "// Buttons and menus with a custom ID do nothing until your bot handles the",
      '// interaction: client.on("interactionCreate", …) and match on customId.',
    );
  }
  const webhookOnly = [
    payload.username ? `username ${quote(payload.username)}` : null,
    payload.avatar_url ? "a custom avatar" : null,
    payload.thread_name ? `thread name ${quote(payload.thread_name)}` : null,
  ].filter((value): value is string => value !== null);
  if (webhookOnly.length) {
    notes.push(
      `// The design also sets ${webhookOnly.join(", ")} — webhook-only options that`,
      "// channel.send() has no equivalent for. WebhookClient#send accepts them.",
    );
  }

  const imports = [...generator.imports].sort();
  const header =
    imports.length > 3
      ? ["const {", ...imports.map((name) => `  ${name},`), '} = require("discord.js");']
      : [`const { ${imports.join(", ")} } = require("discord.js");`];

  return [
    "// Components V2 message — discord.js v14.19 or newer.",
    "// Designed in DWEEB (https://dweeb.faizo.net). Edit the text, then send.",
    ...header,
    "",
    ...declarations,
    ...(notes.length ? [...notes, ""] : []),
    "// Send it from any async context: a command handler, an event, a script.",
    ...send,
    "",
  ].join("\n");
}
