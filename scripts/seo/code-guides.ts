/**
 * The developer guide cluster: sending a Components V2 message from code.
 *
 * Why it exists (Search Console + Analytics, 90 days to 2026-09-17): the one
 * query family DWEEB wins is "components v2 builder" — a developer's phrase —
 * and `/guides/discord-components-v2/` drew 1,227 impressions in 28 days at
 * position 8.8 with a 2% click-through, almost all of it behind queries too
 * rare for Search Console to name. Those are the long, specific searches people
 * type when they are writing a bot: a library, a class name, an error. The site
 * answered none of them, and the editor could only hand such a visitor JSON.
 *
 * Every code block here is produced at build time by `core/codegen`, the same
 * generator behind the app's Code tab, so a guide cannot show code the tool
 * would not export. The prose was checked against the libraries' own docs and
 * changelogs (linked as sources) and, where it describes behaviour, against the
 * published packages themselves.
 */

import { LIMITS } from "@/core/schema/limits";
import { REFERENCE_CARD, SECTION_CARD, sample } from "./code-samples";
import type { GuideInput } from "./guides";

const PUBLISHED = "2026-09-18";
const EXPORT_CTA_PATH = "/#template=showcase&intent=code";
const CHARACTERS = LIMITS.TOTAL_CHARACTERS.toLocaleString("en-US");

const DISCORD_COMPONENTS = {
  label: "Discord: Component reference",
  url: "https://docs.discord.com/developers/components/reference",
};
const DISCORD_WEBHOOK = {
  label: "Discord: Webhook resource (Execute Webhook)",
  url: "https://docs.discord.com/developers/resources/webhook",
};

export const CODE_GUIDE_INPUTS: GuideInput[] = [
  {
    slug: "discord-js-components-v2",
    title: "discord.js Components V2: Builders, Flag & Example | DWEEB",
    h1: "Components V2 in discord.js",
    description:
      "Send Discord Components V2 messages with discord.js: every builder class, the IsComponentsV2 flag, a complete container example and the errors to expect.",
    eyebrow: "Developer guide · discord.js",
    lede: "Components V2 replaces content and embeds with a tree of layout components, and discord.js has a builder class for each one. This guide maps every component to its builder, shows complete working messages, and covers the rules that change once the V2 flag is set.",
    published: PUBLISHED,
    modified: PUBLISHED,
    keywords: [
      "discord.js components v2",
      "discord js components v2 example",
      "discord.js containerbuilder",
      "discord.js textdisplaybuilder",
      "iscomponentsv2 discord.js",
      "discord.js display components",
    ],
    sections: [
      {
        heading: "What discord.js needs for Components V2",
        paragraphs: [
          "Components V2 support arrived in discord.js 14.19.0. From that release the library ships a builder for every layout component and MessageFlags gains IsComponentsV2. How you send does not change: channel.send(), interaction.reply() and message.edit() take the new builders in the same components array that used to hold only action rows.",
          `The flag is what switches a message to the new layout system, and it changes the rules for that message. With it set, Discord rejects content, embeds, poll and stickers, so every piece of visible text has to live in a Text Display component. A message may hold ${LIMITS.TOTAL_COMPONENTS} components in total, nested ones included, and ${CHARACTERS} characters of text across all of them.`,
        ],
      },
      {
        heading: "Every component and its builder",
        table: {
          headers: ["Component (type)", "discord.js builder", "Where it goes"],
          rows: [
            [
              "Container (17)",
              "ContainerBuilder",
              "Top level only. Holds every kind below except another container",
            ],
            [
              "Text Display (10)",
              "TextDisplayBuilder",
              "Top level, inside a container, or inside a section",
            ],
            [
              "Section (9)",
              "SectionBuilder",
              "One to three text displays plus exactly one accessory",
            ],
            ["Thumbnail (11)", "ThumbnailBuilder", "A section's accessory"],
            [
              "Media Gallery (12)",
              "MediaGalleryBuilder with MediaGalleryItemBuilder",
              `One to ${LIMITS.GALLERY_ITEMS} images or videos`,
            ],
            [
              "Separator (14)",
              "SeparatorBuilder",
              "A divider line or plain spacing, sized with SeparatorSpacingSize",
            ],
            ["File (13)", "FileBuilder", "An uploaded file, referenced as attachment://name"],
            [
              "Action Row (1)",
              "ActionRowBuilder",
              `Up to ${LIMITS.ACTION_ROW_BUTTONS} buttons, or one select menu`,
            ],
            ["Button (2)", "ButtonBuilder", "In an action row, or as a section's accessory"],
            [
              "Select menus (3, 5–8)",
              "StringSelectMenuBuilder, UserSelectMenuBuilder, RoleSelectMenuBuilder, MentionableSelectMenuBuilder, ChannelSelectMenuBuilder",
              "One per action row",
            ],
          ],
        },
        paragraphs: [
          "A container takes its children through one typed method per kind — addTextDisplayComponents, addSectionComponents, addMediaGalleryComponents, addSeparatorComponents, addFileComponents and addActionRowComponents — and renders them in the order the calls are made. That is the detail most hand-written examples get wrong: two text blocks separated by a gallery need three calls, not two.",
        ],
      },
      {
        heading: "A complete container message",
        paragraphs: [
          "This is the embed-style card most bots start with: an accent-striped container holding a heading, a divider and a link button. It is the same message as the minimal JSON payload in the [Components V2 reference](/guides/discord-components-v2/), so you can compare the builder calls with the wire format line by line.",
        ],
        code: sample(REFERENCE_CARD, "discordjs"),
      },
      {
        heading: "A section with a thumbnail, and buttons that do something",
        paragraphs: [
          "A Section puts text beside one accessory — a thumbnail here, or a single button. It is the layout a legacy embed could not express, and the reason many bots move to Components V2 at all.",
          "The two buttons below carry a custom ID, so clicking one sends your bot an interaction and nothing else happens until you answer it. Listen for interactionCreate, check interaction.isButton(), and branch on interaction.customId. A link button needs none of that: Discord opens its URL itself.",
        ],
        code: sample(SECTION_CARD, "discordjs"),
      },
      {
        heading: "Replies, ephemeral messages and edits",
        bullets: [
          "interaction.reply() and interaction.followUp() take the same components array. Pass flags: MessageFlags.IsComponentsV2 there as well.",
          "For an ephemeral V2 reply, combine the flags with a bitwise OR: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral.",
          "message.edit({ components }) replaces the whole layout. The V2 flag stays on a message for good, so an edit cannot take it back to content and embeds.",
          "Uploaded files are not displayed on their own. Every attachment has to be referenced from a Thumbnail, Media Gallery or File component as attachment://filename, with the file passed in files under that same name.",
        ],
      },
      {
        heading: "Sending through a webhook instead of a bot",
        paragraphs: [
          "WebhookClient#send accepts the same builders and the same flag. A webhook that your application does not own also needs withComponents: true, which discord.js turns into the with_components=true query parameter. Leave it out and Discord accepts the request but drops the components, which looks exactly like a message that was sent empty.",
          "Such a webhook can carry layout components and link buttons. Buttons and menus with a custom ID need an application-owned webhook, because only an application can receive the interaction they produce. If you are not running a bot at all, [post to the webhook URL with fetch](/guides/discord-webhook-javascript/) instead.",
        ],
      },
      {
        heading: "Errors you are likely to meet",
        bullets: [
          "The flag is missing: Discord does not recognise a container or a text display on a message that was not marked as V2, and rejects the payload.",
          "content or embeds are still in the call: they are refused as soon as the flag is set. Move the text into a TextDisplayBuilder.",
          "A section has no accessory: one thumbnail or one button is required. If you only want text, use text displays without a section.",
          `More than ${LIMITS.TOTAL_COMPONENTS} components: nested children count, so a container with several sections reaches the ceiling sooner than the visible layout suggests.`,
          "An attachment:// URL that matches no uploaded file name: the message is rejected rather than shown with a broken image.",
        ],
        paragraphs: [
          "The builders validate eagerly, so a bad URL or an empty label throws in your own process with the field name, before any request is made. When Discord itself refuses a payload, the [webhook and API error guide](/guides/discord-webhook-errors/) explains how to read the field path in its response.",
        ],
      },
      {
        heading: "Design it visually, then export the code",
        paragraphs: [
          "Writing a layout as nested builder calls is slow to iterate on: you cannot see the result until the bot sends it. DWEEB's [code generator](/features/discord-code-generator/) works the other way round. Build the message in the visual editor against a live preview, then open the Code tab and copy it as discord.js — imports, builders, flag and send call included. Every sample on this page was produced that way.",
          "Any of the [ready-made templates](/templates/) can be the starting point, and each template page shows its own discord.js and discord.py code.",
        ],
      },
    ],
    sources: [
      {
        label: "discord.js guide: Display components",
        url: "https://discordjs.guide/legacy/popular-topics/display-components",
      },
      {
        label: "discord.js 14.19.0 release notes (Components v2 in v14)",
        url: "https://github.com/discordjs/discord.js/releases/tag/14.19.0",
      },
      DISCORD_COMPONENTS,
    ],
    related: ["discord-components-v2", "discord-py-components-v2", "discord-webhook-javascript"],
    ctaLabel: "Design a message and export discord.js code",
    ctaPath: EXPORT_CTA_PATH,
  },
  {
    slug: "discord-py-components-v2",
    title: "discord.py Components V2: LayoutView & Container Example | DWEEB",
    h1: "Components V2 in discord.py",
    description:
      "Build Discord Components V2 messages in discord.py with LayoutView: every ui class, a complete Container example, sections, buttons, files and webhooks.",
    eyebrow: "Developer guide · discord.py",
    lede: "discord.py sends Components V2 through a LayoutView instead of a View. This guide maps each Discord component to its ui class, shows complete working layouts, and covers what changes compared with the embeds and views you already know.",
    published: PUBLISHED,
    modified: PUBLISHED,
    keywords: [
      "discord.py components v2",
      "discord.py layoutview",
      "discord.py container example",
      "discord py components v2 example",
      "discord.py textdisplay",
      "discord.py section thumbnail",
    ],
    sections: [
      {
        heading: "LayoutView instead of View",
        paragraphs: [
          "discord.py added Components V2 in version 2.6 with a new class, discord.ui.LayoutView. It differs from the View you already use in one important way: a View arranges buttons and menus into rows for you, while a LayoutView holds the whole message layout and leaves the arrangement to you. Text, images, separators and containers all become items in the view.",
          `You send it the usual way — await channel.send(view=view) — and the library sets the Components V2 flag for you. The flag changes Discord's rules for that message: content, embeds, polls and stickers are not accepted alongside it, so visible text goes into TextDisplay items. A layout may hold ${LIMITS.TOTAL_COMPONENTS} components in total, nested ones included, and discord.py raises a ValueError as soon as you add one too many.`,
        ],
      },
      {
        heading: "Every component and its ui class",
        table: {
          headers: ["Component (type)", "discord.py class", "Notes"],
          rows: [
            [
              "Container (17)",
              "ui.Container",
              "Children are positional arguments; accent_colour and spoiler are keywords",
            ],
            ["Text Display (10)", "ui.TextDisplay", "Markdown text. The only place text can live"],
            [
              "Section (9)",
              "ui.Section",
              "One to three text items plus a required accessory= keyword",
            ],
            ["Thumbnail (11)", "ui.Thumbnail", "A section's accessory"],
            [
              "Media Gallery (12)",
              "ui.MediaGallery with discord.MediaGalleryItem",
              `One to ${LIMITS.GALLERY_ITEMS} items`,
            ],
            [
              "Separator (14)",
              "ui.Separator",
              "visible= draws the line; spacing= takes discord.SeparatorSpacing",
            ],
            ["File (13)", "ui.File", "An attachment://name reference to an uploaded discord.File"],
            [
              "Action Row (1)",
              "ui.ActionRow",
              `Up to ${LIMITS.ACTION_ROW_BUTTONS} buttons, or one select`,
            ],
            ["Button (2)", "ui.Button", "In an action row, or as a section's accessory"],
            [
              "Select menus (3, 5–8)",
              "ui.Select, ui.UserSelect, ui.RoleSelect, ui.MentionableSelect, ui.ChannelSelect",
              "One per action row",
            ],
          ],
        },
        paragraphs: [
          "Put buttons and menus inside a ui.ActionRow yourself. A LayoutView accepts a bare button without complaint, but it serialises as a top-level button, which Discord refuses — in a LayoutView the row is part of your layout, not something the library infers.",
        ],
      },
      {
        heading: "A complete Container message",
        paragraphs: [
          "An accent-striped container with a heading, a divider and a link button — the card most bots start with, and the same message as the minimal JSON payload in the [Components V2 reference](/guides/discord-components-v2/). Long text is written as adjacent string literals, which Python joins at compile time, so each line of the message stays on its own line of source.",
        ],
        code: sample(REFERENCE_CARD, "discordpy"),
      },
      {
        heading: "A section with a thumbnail, and buttons that do something",
        paragraphs: [
          "A Section places text beside one accessory: a thumbnail here, or a single button. The two buttons underneath carry a custom_id, so a click reaches your bot as an interaction and does nothing until you respond to it.",
          "The usual way to handle them is to subclass ui.LayoutView and attach callbacks to the items, as the library's own examples do; the generated function below builds the same tree with add_item so it can be dropped into any cog. For buttons that must keep working after a restart, keep timeout=None, give every interactive item a custom_id, and register the view with bot.add_view() at startup.",
        ],
        code: sample(SECTION_CARD, "discordpy"),
      },
      {
        heading: "Files, mentions and silent messages",
        bullets: [
          "An uploaded file is not shown on its own. Reference it from a Thumbnail, MediaGallery or File item as attachment://name and pass discord.File objects with that same filename in files=.",
          "allowed_mentions= works as it does everywhere else in discord.py. Pass discord.AllowedMentions.none() for a layout whose text mentions roles you do not want pinged.",
          "silent=True sends without a push notification, exactly as it does for an ordinary message.",
          "message.edit(view=new_view) replaces the layout. A message sent as Components V2 stays one: an edit cannot return it to content and embeds.",
        ],
      },
      {
        heading: "Sending through a webhook",
        paragraphs: [
          "discord.Webhook.send() and discord.SyncWebhook.send() both take view=. When you pass one, discord.py adds the with_components query parameter to the request for you — the detail that makes hand-written webhook requests fail silently, because without it Discord accepts the call and discards the components.",
          "A webhook your application does not own can carry layout items and link buttons only. Items with a custom_id need an application-owned webhook, since only an application can receive the interaction. If you are not running a bot at all, [post to the webhook URL with requests](/guides/discord-webhook-python/) instead.",
        ],
      },
      {
        heading: "Design it visually, then export the code",
        paragraphs: [
          "Nested ui calls are slow to iterate on: you cannot see the layout until the bot sends it. DWEEB's [code generator](/features/discord-code-generator/) works the other way round — build the message in the visual editor against a live preview, open the Code tab, and copy it as discord.py, with the imports, the view and the send call included. Both samples on this page were produced that way.",
          "Any of the [ready-made templates](/templates/) can be the starting point, and each template page shows its own discord.py and discord.js code. If Discord rejects a payload, the [error guide](/guides/discord-webhook-errors/) explains how to read the field path in its response.",
        ],
      },
    ],
    sources: [
      {
        label: "discord.py changelog: v2.6.0, Components v2 support",
        url: "https://discordpy.readthedocs.io/en/stable/whats_new.html",
      },
      {
        label: "discord.py API reference: Bot UI Kit (LayoutView and items)",
        url: "https://discordpy.readthedocs.io/en/stable/interactions/api.html",
      },
      DISCORD_COMPONENTS,
    ],
    related: ["discord-components-v2", "discord-js-components-v2", "discord-webhook-python"],
    ctaLabel: "Design a message and export discord.py code",
    ctaPath: EXPORT_CTA_PATH,
  },
  {
    slug: "discord-webhook-python",
    title: "Send a Discord Webhook Message with Python (requests) | DWEEB",
    h1: "Send a Discord Webhook with Python",
    description:
      "Post to a Discord webhook from Python with requests: a working Components V2 example, the with_components parameter, file uploads, rate limits and errors.",
    eyebrow: "Developer guide · Python",
    lede: "A Discord webhook is a URL that accepts an HTTP POST, so Python needs nothing more than the requests library to send a rich message — no bot, no gateway connection, no token. This guide gives you a working script and the three details that decide whether it works.",
    published: PUBLISHED,
    modified: PUBLISHED,
    keywords: [
      "discord webhook python",
      "python discord webhook",
      "send discord message python requests",
      "discord webhook python example",
      "discord webhook components v2 python",
    ],
    sections: [
      {
        heading: "A working script",
        paragraphs: [
          "Install requests, paste your webhook URL, and run it. The payload is an ordinary Python dictionary; json=payload serialises it and sets the Content-Type header for you. If you do not have a URL yet, the [webhook setup guide](/guides/how-to-create-a-discord-webhook/) takes about a minute.",
        ],
        code: sample(REFERENCE_CARD, "python"),
      },
      {
        heading: "The three details that decide whether it works",
        bullets: [
          "with_components=true in the query string. A webhook created in Server Settings ignores the components array unless the request opts in. Discord still answers with a success status, so the symptom is a message that arrives empty or not at all.",
          "flags: 32768 in the payload. That is the Components V2 flag, 1 << 15. With it set, content and embeds are not accepted in the same payload — visible text goes into type 10 Text Display components.",
          "wait=true if you want the message back. Without it Discord answers 204 with no body. With it you get the message object, including the id you need to [edit the message later](/guides/edit-discord-webhook-message/).",
        ],
        paragraphs: [
          "Treat the URL as a password: anyone who has it can post to your channel. Read it from an environment variable rather than committing it, and see the [webhook security guide](/guides/discord-webhook-security/) if one has already leaked.",
        ],
      },
      {
        heading: "Uploading a file with the message",
        paragraphs: [
          "To show a local image or attach a document, send a multipart request instead of JSON. The payload moves into a form field called payload_json, each file goes in a part named files[0], files[1] and so on, and an attachments array in the payload maps each part to the filename its component refers to with attachment://.",
          "Open a message that uses an uploaded image or a File component in DWEEB and the Code tab writes this variant for you, with one files entry per upload and the matching attachments index.",
        ],
      },
      {
        heading: "Rate limits and retries",
        paragraphs: [
          "Discord limits how fast one webhook may post. When you exceed it the response is HTTP 429 with a JSON body whose retry_after field says how many seconds to wait. response.raise_for_status() turns that into an exception; a script that posts in a loop should catch it, sleep for retry_after, and send the same request again rather than dropping the message.",
          "The exact numbers, and the size and component ceilings that apply to the payload itself, are in the [webhook limits guide](/guides/discord-webhook-limits/).",
        ],
      },
      {
        heading: "When the request is rejected",
        bullets: [
          "400 with a field path in the body: the payload broke one of Discord's rules. The path names the component, for example components.0.components.2. The [error guide](/guides/discord-webhook-errors/) explains how to read it.",
          "401 or 404: the URL is wrong, or the webhook was deleted. Create a new one.",
          "A success status but nothing in the channel: with_components=true is missing.",
          "Buttons with a custom_id are refused: only link buttons work on a webhook your own application does not own, because nothing could receive the click.",
        ],
      },
      {
        heading: "Writing a bot instead?",
        paragraphs: [
          "If the message is sent by a bot rather than a webhook URL, use the library's own classes: see [Components V2 in discord.py](/guides/discord-py-components-v2/). The component tree is identical; only the way it is sent differs.",
          "Either way, you do not have to write the payload by hand. Build the message in DWEEB's visual editor, check it in the live preview, and the [code generator](/features/discord-code-generator/) exports it as this exact script.",
        ],
      },
    ],
    sources: [
      DISCORD_WEBHOOK,
      DISCORD_COMPONENTS,
      {
        label: "Requests: Quickstart (JSON bodies and multipart uploads)",
        url: "https://requests.readthedocs.io/en/latest/user/quickstart/",
      },
    ],
    related: [
      "how-to-create-a-discord-webhook",
      "discord-webhook-javascript",
      "discord-webhook-curl",
      "discord-py-components-v2",
    ],
    ctaLabel: "Build the message and export the Python script",
    ctaPath: EXPORT_CTA_PATH,
  },
  {
    slug: "discord-webhook-javascript",
    title: "Send a Discord Webhook with JavaScript (fetch, Node.js) | DWEEB",
    h1: "Send a Discord Webhook with JavaScript",
    description:
      "Post to a Discord webhook from JavaScript with fetch in Node.js, Deno, Bun or a Worker: a working Components V2 example, file uploads, rate limits, errors.",
    eyebrow: "Developer guide · JavaScript",
    lede: "A Discord webhook is a URL that accepts an HTTP POST, and every modern JavaScript runtime already has fetch — so you can send a rich message without a bot, a library or a token. This guide gives you a working script and the details that decide whether it works.",
    published: PUBLISHED,
    modified: PUBLISHED,
    keywords: [
      "discord webhook javascript",
      "discord webhook node js",
      "discord webhook fetch",
      "send discord webhook javascript",
      "discord webhook components v2 javascript",
    ],
    sections: [
      {
        heading: "A working script",
        paragraphs: [
          "Save this as an .mjs file, paste your webhook URL and run it with Node 18 or newer; it also runs unchanged in Deno, Bun and a Cloudflare Worker. If you do not have a URL yet, the [webhook setup guide](/guides/how-to-create-a-discord-webhook/) takes about a minute.",
        ],
        code: sample(REFERENCE_CARD, "fetch"),
      },
      {
        heading: "The three details that decide whether it works",
        bullets: [
          "with_components=true in the query string. A webhook created in Server Settings ignores the components array unless the request opts in. Discord still answers with a success status, so the symptom is a message that arrives empty or not at all.",
          "flags: 32768 in the payload. That is the Components V2 flag, 1 << 15. With it set, content and embeds are not accepted in the same payload — visible text goes into type 10 Text Display components.",
          "wait=true if you want the message back. Without it Discord answers 204 with no body. With it you get the message object, including the id you need to [edit the message later](/guides/edit-discord-webhook-message/).",
        ],
      },
      {
        heading: "Never call a webhook from a web page",
        paragraphs: [
          "A webhook URL is a credential: anyone who can read it can post to your channel, and it cannot be scoped or rate-limited per caller. JavaScript that runs in a visitor's browser is readable by that visitor, so a URL placed there is public the moment the page loads. Call the webhook from a server, a serverless function or a Worker, and keep the URL in an environment variable. The [webhook security guide](/guides/discord-webhook-security/) covers what to do if one has leaked.",
        ],
      },
      {
        heading: "Uploading a file with the message",
        paragraphs: [
          "To show a local image or attach a document, send a FormData body instead of JSON. The payload goes into a field called payload_json, each file is appended as files[0], files[1] and so on, and an attachments array in the payload maps each part to the filename its component refers to with attachment://. Do not set the Content-Type header yourself — fetch has to add the multipart boundary.",
          "Open a message that uses an uploaded image or a File component in DWEEB and the Code tab writes this variant for you.",
        ],
      },
      {
        heading: "Rate limits and errors",
        bullets: [
          "429: you are posting too fast. The JSON body carries retry_after in seconds; wait that long and send the same request again. Details are in the [webhook limits guide](/guides/discord-webhook-limits/).",
          "400 with a field path such as components.0.components.2: the payload broke one of Discord's rules. The [error guide](/guides/discord-webhook-errors/) explains how to read it.",
          "401 or 404: the URL is wrong, or the webhook was deleted.",
          "A success status but nothing in the channel: with_components=true is missing.",
        ],
      },
      {
        heading: "Writing a bot instead?",
        paragraphs: [
          "If the message is sent by a discord.js bot, use its builder classes rather than raw JSON: see [Components V2 in discord.js](/guides/discord-js-components-v2/). The component tree is identical; only the way it is sent differs.",
          "Either way, you do not have to write the payload by hand. Build the message in DWEEB's visual editor, check it in the live preview, and the [code generator](/features/discord-code-generator/) exports it as this exact script.",
        ],
      },
    ],
    sources: [
      DISCORD_WEBHOOK,
      DISCORD_COMPONENTS,
      {
        label: "MDN: Using the Fetch API",
        url: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch",
      },
    ],
    related: [
      "how-to-create-a-discord-webhook",
      "discord-webhook-python",
      "discord-webhook-curl",
      "discord-js-components-v2",
    ],
    ctaLabel: "Build the message and export the JavaScript",
    ctaPath: EXPORT_CTA_PATH,
  },
  {
    slug: "discord-webhook-curl",
    title: "Send a Discord Webhook with cURL: Working Examples | DWEEB",
    h1: "Send a Discord Webhook with cURL",
    description:
      "Post to a Discord webhook with cURL from a terminal, CI job or cron entry: a working Components V2 command, safe quoting, file uploads and common errors.",
    eyebrow: "Developer guide · cURL",
    lede: "One cURL command is enough to post a rich Discord message from a terminal, a CI pipeline or a cron job. The command itself is short; what goes wrong is quoting and one missing query parameter. This guide gives you a command that avoids both.",
    published: PUBLISHED,
    modified: PUBLISHED,
    keywords: [
      "discord webhook curl",
      "curl discord webhook",
      "discord webhook command line",
      "discord webhook github actions",
      "discord webhook bash",
    ],
    sections: [
      {
        heading: "A working command",
        paragraphs: [
          "Replace the URL with your own and run it in bash or zsh. If you do not have a webhook URL yet, the [webhook setup guide](/guides/how-to-create-a-discord-webhook/) takes about a minute.",
        ],
        code: sample(REFERENCE_CARD, "curl"),
      },
      {
        heading: "Why the JSON is passed on standard input",
        paragraphs: [
          'Most examples put the payload in a single-quoted -d argument. That breaks on the first apostrophe in your message — "Don\'t miss it" ends the argument halfway through — and the usual fix of escaping quotes inside quotes is exactly where shell scripts go wrong.',
          "Here --data-binary @- reads the body from standard input, and the quoted heredoc marker <<'JSON' tells the shell to pass everything up to the closing JSON line through untouched: no variable expansion, no quote handling, no escaping. Whatever the message says, the bytes Discord receives are the bytes you wrote.",
        ],
      },
      {
        heading: "The two parameters in the URL",
        bullets: [
          "with_components=true is required for a webhook created in Server Settings. Without it Discord accepts the request, answers with a success status and discards the components array — the message arrives empty or not at all.",
          "wait=true makes Discord answer with the created message as JSON, which is how a script learns the message id it needs to [edit that message later](/guides/edit-discord-webhook-message/). Without it the answer is 204 with no body.",
        ],
        paragraphs: [
          "The payload also carries flags: 32768, the Components V2 flag. With it set, content and embeds are not accepted in the same payload; visible text lives in type 10 Text Display components.",
        ],
      },
      {
        heading: "In CI and cron",
        bullets: [
          "Store the URL as a secret and read it from an environment variable. A webhook URL is a credential: anyone who has it can post to your channel.",
          "Add --fail-with-body so a rejected request fails the job and still prints Discord's explanation. Plain --fail hides the response body, which is where the reason is.",
          "Add --retry 3 for transient network failures. For an HTTP 429, read retry_after from the JSON body and wait that long; the [webhook limits guide](/guides/discord-webhook-limits/) has the numbers.",
          "On Windows, run the command in Git Bash or WSL. PowerShell's curl is an alias with different quoting rules, and cmd.exe has no heredoc.",
        ],
      },
      {
        heading: "Uploading a file with the message",
        paragraphs: [
          "To show a local image or attach a document, switch from a JSON body to multipart form fields: -F 'payload_json=<-;type=application/json' still reads the payload from standard input, and each file is added with -F 'files[0]=@./report.pdf'. The payload gains an attachments array that maps each part to the filename a component refers to with attachment://.",
          "Open a message that uses an uploaded image or a File component in DWEEB and the Code tab writes this variant for you, with one -F line per upload.",
        ],
      },
      {
        heading: "When the request is rejected",
        bullets: [
          "400 with a field path such as components.0.components.2: the payload broke one of Discord's rules. The [error guide](/guides/discord-webhook-errors/) explains how to read it.",
          "401 or 404: the URL is wrong, or the webhook was deleted.",
          "A success status but nothing in the channel: with_components=true is missing.",
          "Buttons with a custom_id are refused on a webhook your own application does not own. Link buttons work everywhere.",
        ],
        paragraphs: [
          "You do not have to write the payload by hand. Build the message in DWEEB's visual editor, check it in the live preview, and the [code generator](/features/discord-code-generator/) exports it as this exact command. The same message is also available as a [Python script](/guides/discord-webhook-python/) or [JavaScript](/guides/discord-webhook-javascript/).",
        ],
      },
    ],
    sources: [
      DISCORD_WEBHOOK,
      DISCORD_COMPONENTS,
      { label: "curl manual: --data-binary and -F", url: "https://curl.se/docs/manpage.html" },
    ],
    related: [
      "how-to-create-a-discord-webhook",
      "discord-webhook-python",
      "discord-webhook-javascript",
      "discord-webhook-errors",
    ],
    ctaLabel: "Build the message and export the cURL command",
    ctaPath: EXPORT_CTA_PATH,
  },
];
