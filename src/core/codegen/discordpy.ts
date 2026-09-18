/**
 * discord.py (2.6+) `LayoutView` code for a Components V2 message.
 *
 * Verified the same way as the discord.js target: the generated module is run
 * against the published library and `view.to_components()` is compared with the
 * source payload (`scripts/verify-codegen.ts`).
 */

import { ButtonStyle, ComponentType, SeparatorSpacing } from "@/core/schema/types";
import { hasInteractiveComponents, type CodegenInput, type WireNode } from "./payload";
import { hexColor, indentLines, list, pyString, quote, raw, render, type Expr } from "./printer";

const UNIT = 4;
const SUPPRESS_NOTIFICATIONS = 1 << 12;

const BUTTON_STYLES: Record<number, string> = {
  [ButtonStyle.Primary]: "primary",
  [ButtonStyle.Secondary]: "secondary",
  [ButtonStyle.Success]: "success",
  [ButtonStyle.Danger]: "danger",
  [ButtonStyle.Link]: "link",
  [ButtonStyle.Premium]: "premium",
};

/** `discord.ChannelType` member names; the library has none for a directory (14). */
const CHANNEL_TYPES: Record<number, string> = {
  0: "text",
  1: "private",
  2: "voice",
  3: "group",
  4: "category",
  5: "news",
  10: "news_thread",
  11: "public_thread",
  12: "private_thread",
  13: "stage_voice",
  15: "forum",
  16: "media",
};

/** A snowflake as discord.py wants it — an int — or the raw text if it isn't one. */
const snowflake = (value: string): string => (/^\d+$/.test(value) ? value : quote(value));

const call = (callee: string, args: Expr[], kwargs: [string, Expr][] = []): Expr => ({
  kind: "call",
  callee,
  args,
  kwargs,
});

function idKwarg(node: WireNode): [string, Expr][] {
  return typeof node.id === "number" ? [["id", raw(String(node.id))]] : [];
}

function emoji(value: unknown): Expr | null {
  if (!value || typeof value !== "object") return null;
  const parsed = value as { id?: string | null; name?: string | null; animated?: boolean };
  if (parsed.id) {
    const kwargs: [string, Expr][] = [
      ["name", raw(quote(parsed.name ?? "emoji"))],
      ["id", raw(snowflake(parsed.id))],
    ];
    if (parsed.animated) kwargs.push(["animated", raw("True")]);
    return call("discord.PartialEmoji", [], kwargs);
  }
  return parsed.name ? raw(quote(parsed.name)) : null;
}

function mediaUrl(value: unknown): Expr {
  const url = value && typeof value === "object" ? (value as { url?: unknown }).url : undefined;
  return raw(quote(typeof url === "string" ? url : ""));
}

function button(node: WireNode): Expr {
  const style = typeof node.style === "number" ? node.style : ButtonStyle.Secondary;
  const kwargs: [string, Expr][] = [
    ["style", raw(`discord.ButtonStyle.${BUTTON_STYLES[style] ?? "secondary"}`)],
  ];
  if (typeof node.label === "string" && node.label) kwargs.push(["label", raw(quote(node.label))]);
  const parsedEmoji = emoji(node.emoji);
  if (parsedEmoji) kwargs.push(["emoji", parsedEmoji]);
  if (typeof node.url === "string") kwargs.push(["url", raw(quote(node.url))]);
  if (typeof node.custom_id === "string") kwargs.push(["custom_id", raw(quote(node.custom_id))]);
  if (typeof node.sku_id === "string") kwargs.push(["sku_id", raw(snowflake(node.sku_id))]);
  if (node.disabled === true) kwargs.push(["disabled", raw("True")]);
  return call("ui.Button", [], [...kwargs, ...idKwarg(node)]);
}

function select(node: WireNode): Expr {
  const classes: Record<number, string> = {
    [ComponentType.StringSelect]: "ui.Select",
    [ComponentType.UserSelect]: "ui.UserSelect",
    [ComponentType.RoleSelect]: "ui.RoleSelect",
    [ComponentType.MentionableSelect]: "ui.MentionableSelect",
    [ComponentType.ChannelSelect]: "ui.ChannelSelect",
  };
  const kwargs: [string, Expr][] = [["custom_id", raw(quote(String(node.custom_id ?? "")))]];
  if (typeof node.placeholder === "string" && node.placeholder) {
    kwargs.push(["placeholder", raw(quote(node.placeholder))]);
  }
  if (typeof node.min_values === "number")
    kwargs.push(["min_values", raw(String(node.min_values))]);
  if (typeof node.max_values === "number")
    kwargs.push(["max_values", raw(String(node.max_values))]);
  if (node.disabled === true) kwargs.push(["disabled", raw("True")]);

  if (node.type === ComponentType.ChannelSelect && Array.isArray(node.channel_types)) {
    const types = (node.channel_types as unknown[]).filter(
      (value): value is number => typeof value === "number",
    );
    if (types.length) {
      kwargs.push([
        "channel_types",
        list(
          types.map((value) =>
            raw(
              CHANNEL_TYPES[value]
                ? `discord.ChannelType.${CHANNEL_TYPES[value]}`
                : `discord.enums.try_enum(discord.ChannelType, ${value})`,
            ),
          ),
        ),
      ]);
    }
  }

  if (node.type === ComponentType.StringSelect) {
    const options = Array.isArray(node.options) ? (node.options as WireNode[]) : [];
    kwargs.push([
      "options",
      list(
        options.map((option) => {
          const optionKwargs: [string, Expr][] = [
            ["label", raw(quote(String(option.label ?? "")))],
            ["value", raw(quote(String(option.value ?? "")))],
          ];
          if (typeof option.description === "string" && option.description) {
            optionKwargs.push(["description", raw(quote(option.description))]);
          }
          const parsedEmoji = emoji(option.emoji);
          if (parsedEmoji) optionKwargs.push(["emoji", parsedEmoji]);
          if (option.default === true) optionKwargs.push(["default", raw("True")]);
          return call("discord.SelectOption", [], optionKwargs);
        }),
      ),
    ]);
  } else {
    const defaults = Array.isArray(node.default_values)
      ? (node.default_values as { id?: unknown; type?: unknown }[])
      : [];
    const values = defaults
      .filter((value) => typeof value.id === "string" && typeof value.type === "string")
      .map((value) =>
        call(
          "discord.SelectDefaultValue",
          [],
          [
            ["id", raw(snowflake(value.id as string))],
            ["type", raw(`discord.SelectDefaultValueType.${value.type as string}`)],
          ],
        ),
      );
    if (values.length) kwargs.push(["default_values", list(values)]);
  }
  return call(classes[node.type as number] ?? "ui.Select", [], [...kwargs, ...idKwarg(node)]);
}

function actionRow(node: WireNode): Expr {
  const children = Array.isArray(node.components) ? (node.components as WireNode[]) : [];
  return call(
    "ui.ActionRow",
    children.map((child) => (child.type === ComponentType.Button ? button(child) : select(child))),
    idKwarg(node),
  );
}

function textDisplay(node: WireNode): Expr {
  return call("ui.TextDisplay", [pyString(String(node.content ?? ""))], idKwarg(node));
}

function thumbnail(node: WireNode): Expr {
  const kwargs: [string, Expr][] = [];
  if (typeof node.description === "string" && node.description) {
    kwargs.push(["description", raw(quote(node.description))]);
  }
  if (node.spoiler === true) kwargs.push(["spoiler", raw("True")]);
  return call("ui.Thumbnail", [mediaUrl(node.media)], [...kwargs, ...idKwarg(node)]);
}

function section(node: WireNode): Expr {
  const texts = Array.isArray(node.components) ? (node.components as WireNode[]) : [];
  const accessory = node.accessory as WireNode | undefined;
  const kwargs: [string, Expr][] = [];
  if (accessory?.type === ComponentType.Button) kwargs.push(["accessory", button(accessory)]);
  else if (accessory?.type === ComponentType.Thumbnail) {
    kwargs.push(["accessory", thumbnail(accessory)]);
  }
  return call("ui.Section", texts.map(textDisplay), [...kwargs, ...idKwarg(node)]);
}

function gallery(node: WireNode): Expr {
  const items = Array.isArray(node.items) ? (node.items as WireNode[]) : [];
  return call(
    "ui.MediaGallery",
    items.map((item) => {
      const kwargs: [string, Expr][] = [];
      if (typeof item.description === "string" && item.description) {
        kwargs.push(["description", raw(quote(item.description))]);
      }
      if (item.spoiler === true) kwargs.push(["spoiler", raw("True")]);
      return call("discord.MediaGalleryItem", [mediaUrl(item.media)], kwargs);
    }),
    idKwarg(node),
  );
}

function separator(node: WireNode): Expr {
  const kwargs: [string, Expr][] = [];
  if (typeof node.divider === "boolean")
    kwargs.push(["visible", raw(node.divider ? "True" : "False")]);
  if (typeof node.spacing === "number") {
    const size = node.spacing === SeparatorSpacing.Large ? "large" : "small";
    kwargs.push(["spacing", raw(`discord.SeparatorSpacing.${size}`)]);
  }
  return call("ui.Separator", [], [...kwargs, ...idKwarg(node)]);
}

function file(node: WireNode): Expr {
  const kwargs: [string, Expr][] = node.spoiler === true ? [["spoiler", raw("True")]] : [];
  return call("ui.File", [mediaUrl(node.file)], [...kwargs, ...idKwarg(node)]);
}

function container(node: WireNode): Expr {
  const children = Array.isArray(node.components) ? (node.components as WireNode[]) : [];
  const kwargs: [string, Expr][] = [];
  if (typeof node.accent_color === "number") {
    kwargs.push(["accent_colour", raw(hexColor(node.accent_color))]);
  }
  if (node.spoiler === true) kwargs.push(["spoiler", raw("True")]);
  return call(
    "ui.Container",
    children.map(component).filter((expr): expr is Expr => expr !== null),
    [...kwargs, ...idKwarg(node)],
  );
}

function component(node: WireNode): Expr | null {
  switch (node.type) {
    case ComponentType.ActionRow:
      return actionRow(node);
    case ComponentType.Section:
      return section(node);
    case ComponentType.TextDisplay:
      return textDisplay(node);
    case ComponentType.MediaGallery:
      return gallery(node);
    case ComponentType.File:
      return file(node);
    case ComponentType.Separator:
      return separator(node);
    case ComponentType.Container:
      return container(node);
    default:
      return null;
  }
}

function allowedMentions(
  mentions: NonNullable<CodegenInput["payload"]["allowed_mentions"]>,
): string {
  const parse = new Set(mentions.parse ?? []);
  const list = (ids: string[] | undefined) =>
    ids?.length
      ? `[${ids.map((id) => `discord.Object(id=${snowflake(id)})`).join(", ")}]`
      : "False";
  const fields = [
    `everyone=${parse.has("everyone") ? "True" : "False"}`,
    `users=${parse.has("users") ? "True" : list(mentions.users)}`,
    `roles=${parse.has("roles") ? "True" : list(mentions.roles)}`,
  ];
  if (typeof mentions.replied_user === "boolean") {
    fields.push(`replied_user=${mentions.replied_user ? "True" : "False"}`);
  }
  return `discord.AllowedMentions(${fields.join(", ")})`;
}

export function generateDiscordPy({ payload, attachments }: CodegenInput): string {
  // The view is built inside a function so the snippet can be pasted into a cog
  // or module as it stands: nothing runs at import time, and every send gets
  // its own view rather than sharing one mutable module-level instance.
  const body: string[] = ["view = ui.LayoutView(timeout=None)"];
  for (const node of payload.components) {
    const expr = component(node);
    if (!expr) continue;
    const lines = render(call("view.add_item", [expr]), UNIT, UNIT);
    body.push(...lines);
  }
  body.push("return view");

  const sendKwargs = ["view=build_view()"];
  if (payload.tts) sendKwargs.push("tts=True");
  if (payload.flags & SUPPRESS_NOTIFICATIONS) sendKwargs.push("silent=True");
  if (payload.allowed_mentions) {
    sendKwargs.push(`allowed_mentions=${allowedMentions(payload.allowed_mentions)}`);
  }
  if (attachments.length) {
    const files = attachments.map(
      (name) => `discord.File(${quote(`./${name}`)}, filename=${quote(name)})`,
    );
    sendKwargs.push(`files=[${files.join(", ")}]`);
  }
  const sendInline = `await channel.send(${sendKwargs.join(", ")})`;
  const send =
    sendInline.length <= 88
      ? [sendInline]
      : ["await channel.send(", ...sendKwargs.map((kwarg) => `    ${kwarg},`), ")"];

  const notes: string[] = [];
  if (attachments.length) {
    notes.push(
      "# attachment:// URLs resolve against the uploaded files below — keep each",
      "# filename identical to the one its component references.",
    );
  }
  if (hasInteractiveComponents(payload.components)) {
    notes.push(
      "# Buttons and menus with a custom_id do nothing until your bot handles them:",
      "# subclass ui.LayoutView with callbacks, or listen for on_interaction.",
    );
  }
  const webhookOnly = [
    payload.username ? `username ${quote(payload.username)}` : null,
    payload.avatar_url ? "a custom avatar" : null,
    payload.thread_name ? `thread name ${quote(payload.thread_name)}` : null,
  ].filter((value): value is string => value !== null);
  if (webhookOnly.length) {
    notes.push(
      `# The design also sets ${webhookOnly.join(", ")} — webhook-only options that`,
      "# channel.send() has no equivalent for. discord.Webhook.send accepts them.",
    );
  }

  return [
    "# Components V2 message — discord.py 2.6 or newer.",
    "# Designed in DWEEB (https://dweeb.faizo.net). Edit the text, then send.",
    "import discord",
    "from discord import ui",
    "",
    "",
    "def build_view() -> ui.LayoutView:",
    ...indentLines(body, UNIT),
    "",
    "",
    ...(notes.length ? [...notes, ""] : []),
    "# Send it from any coroutine: a command, an event listener, a task.",
    ...send,
    "",
  ].join("\n");
}
