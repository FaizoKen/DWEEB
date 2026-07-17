/** Search-led, editorial pages generated into `/guides/` at build time. */

import { LIMITS } from "@/core/schema/limits";
import { SITE } from "./content";

export const GUIDES_LASTMOD = "2026-07-17";

export interface GuideSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
  code?: string;
  table?: { headers: string[]; rows: string[][] };
}

export interface GuidePage {
  slug: string;
  title: string;
  h1: string;
  description: string;
  eyebrow: string;
  lede: string;
  published: string;
  modified: string;
  keywords: string[];
  sections: GuideSection[];
  sources: { label: string; url: string }[];
  related: string[];
  ctaLabel: string;
  ctaPath: string;
  path: string;
  url: string;
  ogImage: string;
}

type GuideInput = Omit<GuidePage, "path" | "url" | "ogImage">;

function guide(input: GuideInput): GuidePage {
  const path = `/guides/${input.slug}/`;
  return {
    ...input,
    path,
    url: `${SITE.origin}${path}`,
    ogImage: `${SITE.origin}/guides-og/${input.slug}.png`,
  };
}

export const GUIDES: GuidePage[] = [
  guide({
    slug: "discord-components-v2",
    title: "Discord Components V2 Guide: Types, JSON & Limits | DWEEB",
    h1: "Discord Components V2: Complete Guide",
    description:
      "Learn Discord Components V2 types, nesting rules, JSON, webhook behavior and current limits, with a working example you can edit visually.",
    eyebrow: "Developer guide · Components V2",
    lede: "Components V2 turns a Discord message into a real layout tree: text, sections, thumbnails, media, separators, containers and interactive controls. This guide explains the model that Discord actually accepts and gives you an editable reference instead of a disconnected code fragment.",
    published: "2026-07-15",
    modified: "2026-07-17",
    keywords: [
      "discord components v2",
      "discord components v2 example",
      "discord components v2 json",
      "discord component types",
      "discord components v2 limits",
    ],
    sections: [
      {
        heading: "What changed in Components V2",
        paragraphs: [
          "Legacy webhook messages split presentation between top-level content and embeds. Components V2 moves the visible message into one components array and adds layout primitives such as Container and Section. Once the IS_COMPONENTS_V2 message flag is set, top-level content and embeds are disabled; text belongs in Text Display components instead.",
          "The result is more composable than a legacy embed. A Container can hold formatted text, separators, media galleries, files and action rows behind one accent colour. A Section can place one to three text blocks beside a thumbnail or button accessory. You can mix several top-level blocks rather than forcing the whole design into one card.",
        ],
      },
      {
        heading: "The component types that matter",
        table: {
          headers: ["Component", "Use it for", "Important rule"],
          rows: [
            [
              "Text Display",
              "Markdown text, headings, lists and mentions",
              "Counts toward the message-wide character budget",
            ],
            [
              "Section",
              "One to three text blocks beside a thumbnail or button",
              "Its accessory is part of the Section",
            ],
            ["Thumbnail", "Compact media beside Section text", "Used as a Section accessory"],
            [
              "Media Gallery",
              "One or more large images or media items",
              `Up to ${LIMITS.GALLERY_ITEMS} items`,
            ],
            [
              "Separator",
              "A divider or deliberate vertical space",
              "Can use small or large spacing",
            ],
            [
              "Container",
              "An embed-like group with an optional accent colour",
              "Containers cannot be nested",
            ],
            [
              "Action Row",
              "Buttons or one select menu",
              `Up to ${LIMITS.ACTION_ROW_BUTTONS} buttons`,
            ],
          ],
        },
      },
      {
        heading: "A minimal Components V2 webhook payload",
        paragraphs: [
          "This payload creates a coloured container with a heading, supporting text, a separator and a link button. The numeric flag is 32768, or 1 << 15. DWEEB adds the V2 flag when it serializes and sends a visual design.",
        ],
        code: `{
  "flags": 32768,
  "components": [
    {
      "type": 17,
      "accent_color": 5793266,
      "components": [
        { "type": 10, "content": "# Server update\\nEverything you need in one place." },
        { "type": 14, "divider": true, "spacing": 1 },
        {
          "type": 1,
          "components": [
            { "type": 2, "style": 5, "label": "Read the guide", "url": "https://example.com/update" }
          ]
        }
      ]
    }
  ]
}`,
      },
      {
        heading: "Current message and nesting limits",
        paragraphs: [
          "DWEEB validates against the same limits before send, so the live issue list is also a practical limits calculator. Discord can change its API over time; the numbers below are generated from the constants used by the editor rather than copied into a second, drifting list.",
        ],
        bullets: [
          `${LIMITS.TOTAL_COMPONENTS} components total, including nested components`,
          `${LIMITS.TOP_LEVEL_COMPONENTS} top-level components`,
          `${LIMITS.TOTAL_CHARACTERS.toLocaleString("en-US")} characters across text-bearing component fields`,
          `${LIMITS.CONTAINER_CHILDREN} children in a Container when it is the only top-level component`,
          `${LIMITS.SECTION_TEXTS_MIN}–${LIMITS.SECTION_TEXTS_MAX} Text Display children in a Section`,
          `${LIMITS.GALLERY_ITEMS} Media Gallery items, ${LIMITS.ACTION_ROW_BUTTONS} buttons per Action Row and ${LIMITS.SELECT_OPTIONS} string-select options`,
        ],
      },
      {
        heading: "Webhooks, buttons and app ownership",
        paragraphs: [
          "A person-created incoming webhook can post non-interactive Components V2 when the request opts into components. Link buttons are safe because Discord opens a URL and no application has to receive a click. Buttons with custom IDs and select menus are different: an application must own the webhook and acknowledge the interaction.",
          "That distinction explains the setup badges in DWEEB. Static layouts work with any incoming webhook. DWEEB-hosted replies use a guided app-owned destination. Features that change roles, create channels or perform other privileged actions also require the relevant Discord app installation.",
        ],
      },
      {
        heading: "A reliable build workflow",
        bullets: [
          "Start with information hierarchy: one purpose, one first action and only then decoration.",
          "Use Containers for visual grouping, not as a wrapper around every isolated line.",
          "Prefer a Section when a thumbnail or single button belongs directly to a short block of text.",
          "Validate character, nesting and interaction ownership before you copy or send JSON.",
          "Test the final post in a real channel; a preview cannot reproduce every client width or permission failure.",
        ],
        paragraphs: [
          "The editable Components V2 showcase contains every major block and is a faster reference than assembling the numeric types by hand. Open it, select a component, and compare the visual tree with exported JSON.",
        ],
      },
    ],
    sources: [
      {
        label: "Discord: Components overview",
        url: "https://docs.discord.com/developers/components/overview",
      },
      {
        label: "Discord: Components reference",
        url: "https://docs.discord.com/developers/components/reference",
      },
      {
        label: "Discord: Using message components",
        url: "https://docs.discord.com/developers/components/using-message-components",
      },
    ],
    related: [
      "discord-embed-to-components-v2",
      "discord-text-formatting",
      "discord-webhook-limits",
    ],
    ctaLabel: "Open the editable Components V2 example",
    ctaPath: "/?template=showcase",
  }),
  guide({
    slug: "how-to-create-a-discord-webhook",
    title: "How to Create a Discord Webhook & Send a Message | DWEEB",
    h1: "How to Create and Use a Discord Webhook",
    description:
      "Create a Discord webhook URL, keep it secure, build a message visually and send it safely. Includes permissions and Components V2 caveats.",
    eyebrow: "Practical guide · Discord webhooks",
    lede: "A Discord incoming webhook is the shortest path from a tool or script into one channel. It can set a display name and avatar and post rich Components V2 layouts, but its URL is also a credential. Set it up once, handle it like a password, and test with a message you can recognize.",
    published: "2026-07-15",
    modified: "2026-07-17",
    keywords: [
      "how to create a discord webhook",
      "discord webhook url",
      "send discord webhook message",
      "discord webhook setup",
      "discord webhook builder",
    ],
    sections: [
      {
        heading: "Before you start",
        paragraphs: [
          "You need access to the target server and the Manage Webhooks permission in the channel. If the Webhooks control is missing or disabled, ask a server administrator to create it or adjust your role. Choose the destination channel carefully: an incoming webhook is tied to a channel until an authorized manager edits it.",
        ],
      },
      {
        heading: "Create the incoming webhook",
        bullets: [
          "Open the server's settings, choose Integrations, then open Webhooks.",
          "Choose New Webhook, give it a recognizable name and select the destination channel.",
          "Copy the webhook URL. Do not paste it into chat, tickets, screenshots, source control or analytics.",
          "Keep the settings page open until your test succeeds, so you can rotate or delete the webhook immediately if needed.",
        ],
        paragraphs: [
          "Discord's labels can move between clients, but the canonical control remains under the server's Integrations and Webhooks settings. On a managed server, role and channel overrides can both affect whether you can see or manage it.",
        ],
      },
      {
        heading: "Build and send the first message",
        bullets: [
          "Open DWEEB and choose a blank message or a template.",
          "Add Text Displays, Containers, Sections, buttons and media while watching the live Discord-style preview.",
          "Open Send, paste the webhook URL or connect the server and choose a channel.",
          "Review the resolved destination and validation warnings, then confirm the post.",
          "Keep the resulting message link if you intend to restore and edit that post later.",
        ],
        paragraphs: [
          "Nothing posts merely because a URL was pasted. DWEEB shows a confirmation before the request. For a normal person-created webhook, use static components and link buttons. Custom-ID buttons and select menus need an app-owned webhook because Discord must deliver their interactions to an application.",
        ],
      },
      {
        heading: "A small curl test",
        paragraphs: [
          "For a plain connectivity test, replace the placeholder with the real URL only in your local terminal. Avoid shell history on shared machines and never commit the command with a live token.",
        ],
        code: `curl -H "Content-Type: application/json" \\
  -d '{"content":"Webhook connected successfully."}' \\
  "https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN"`,
      },
      {
        heading: "Common failures",
        table: {
          headers: ["Symptom", "Likely cause", "What to check"],
          rows: [
            [
              "401 or invalid webhook token",
              "The URL is incomplete, rotated or deleted",
              "Copy it again from Integrations; do not reconstruct it",
            ],
            [
              "403 or missing access",
              "Permissions or a thread target block the request",
              "Manage Webhooks, channel access and thread state",
            ],
            [
              "400 invalid form body",
              "The payload breaks a field, component or nesting limit",
              "Use DWEEB's issue list before send",
            ],
            [
              "Interactive component rejected",
              "A person-created webhook cannot own interactions",
              "Use a guided app-owned destination or make the control a link",
            ],
          ],
        },
      },
      {
        heading: "What to do if the URL leaks",
        paragraphs: [
          "Delete or rotate the webhook immediately; removing a leaked post is not enough because the credential remains valid. Search repositories, build logs and team chat for copies, then create a fresh webhook and update only the systems that genuinely need it. Treat unexpected messages from a webhook as a credential incident.",
        ],
      },
    ],
    sources: [
      {
        label: "Discord support: Intro to Webhooks",
        url: "https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks",
      },
      {
        label: "Discord API: Webhook resource",
        url: "https://docs.discord.com/developers/resources/webhook",
      },
      {
        label: "Discord API: Execute Webhook",
        url: "https://docs.discord.com/developers/resources/webhook#execute-webhook",
      },
    ],
    related: [
      "discord-webhook-security",
      "discord-webhook-name-avatar",
      "discord-webhook-limits",
      "edit-discord-webhook-message",
    ],
    ctaLabel: "Build your first webhook message",
    ctaPath: "/",
  }),
  guide({
    slug: "discord-embed-to-components-v2",
    title: "Convert Discord Embed JSON to Components V2 | DWEEB",
    h1: "Convert Discord Embeds to Components V2",
    description:
      "Paste legacy Discord webhook JSON and convert content and embeds into editable Components V2, with a clear report for fields that cannot map exactly.",
    eyebrow: "Migration guide · Embed converter",
    lede: "A Components V2 migration is not a search-and-replace. Legacy content and embeds become a component tree, some visual conventions change, and a few old fields have no V2 equivalent. DWEEB's importer performs a conservative conversion and reports every compromise before you apply it.",
    published: "2026-07-15",
    modified: "2026-07-15",
    keywords: [
      "discord embed to components v2",
      "discord embed converter",
      "convert discord embed json",
      "discord components v2 converter",
      "discord embed json editor",
    ],
    sections: [
      {
        heading: "How the conversion maps fields",
        table: {
          headers: ["Legacy field", "Components V2 result", "Conversion note"],
          rows: [
            ["content", "Top-level Text Display", "Prepended before converted embeds"],
            [
              "embed title + URL",
              "Markdown heading or linked heading",
              "Preserves the visible title and link",
            ],
            ["embed description", "Text Display", "Preserves Discord markdown"],
            ["embed colour", "Container accent colour", "Keeps the card-like visual identity"],
            [
              "embed thumbnail",
              "Section thumbnail accessory",
              "Groups it with header and description",
            ],
            ["embed image", "Media Gallery", "Becomes full-width media"],
            ["embed fields", "Stacked Text Displays", "Inline grids do not exist in V2"],
            ["footer + timestamp", "Final Text Display", "Preserved as readable text"],
          ],
        },
      },
      {
        heading: "Fields that cannot map exactly",
        paragraphs: [
          "The importer does not hide lossy changes. Polls and stickers cannot accompany a V2 payload, so they are dropped with warnings. Embed video players and provider metadata have no equivalent. Author and footer names remain, but their inline icon URLs are omitted. Inline embed fields stack because Components V2 does not offer the old three-column field grid.",
          `A very large embed can also exceed the ${LIMITS.CONTAINER_CHILDREN}-child Container ceiling or the ${LIMITS.TOTAL_COMPONENTS}-component message ceiling. DWEEB truncates only when required and adds a conversion note so you can split the result deliberately.`,
        ],
      },
      {
        heading: "Convert a payload in DWEEB",
        bullets: [
          "Open the builder's JSON panel and paste the complete legacy webhook payload.",
          "Read the conversion preview. Informational notes explain layout changes; warnings identify data with no V2 equivalent.",
          "Apply the conversion, then inspect each Container, Section and media block in the visual editor.",
          "Resolve validation issues and compare the result at desktop and narrow preview widths.",
          "Export the new JSON or send it only after the migration report is understood.",
        ],
      },
      {
        heading: "Before-and-after shape",
        code: `// Legacy input
{
  "content": "Release notes",
  "embeds": [{
    "title": "Version 2.4",
    "description": "Faster search and a new dashboard.",
    "color": 5793266,
    "fields": [{ "name": "Fixed", "value": "Three permission bugs", "inline": true }]
  }]
}

// V2 shape (editor ids omitted)
{
  "flags": 32768,
  "components": [
    { "type": 10, "content": "Release notes" },
    { "type": 17, "accent_color": 5793266, "components": [
      { "type": 10, "content": "## Version 2.4" },
      { "type": 10, "content": "Faster search and a new dashboard." },
      { "type": 10, "content": "**Fixed**\\nThree permission bugs" }
    ]}
  ]
}`,
      },
      {
        heading: "Migration quality checklist",
        bullets: [
          "Confirm that links, mentions and markdown still mean what they meant in the old message.",
          "Rework former inline fields for a single-column mobile layout instead of trying to imitate the old grid.",
          "Check image URLs and alt descriptions, especially for attachments that lived beside the original payload.",
          "Replace dropped polls, stickers or video-provider UI with explicit links or a separate message.",
          "For interactive additions, decide whether the destination must be app-owned before you send.",
        ],
      },
    ],
    sources: [
      {
        label: "Discord: Components reference",
        url: "https://docs.discord.com/developers/components/reference",
      },
      {
        label: "Discord: Webhook resource",
        url: "https://docs.discord.com/developers/resources/webhook",
      },
    ],
    related: ["discord-components-v2", "edit-discord-webhook-message"],
    ctaLabel: "Open the JSON converter",
    ctaPath: "/?intent=json",
  }),
  guide({
    slug: "discord-webhook-security",
    title: "Discord Webhook Security: Leaks, Storage & Rotation | DWEEB",
    h1: "Discord Webhook Security Guide",
    description:
      "Protect Discord webhook URLs, respond to a leak, choose safe storage and understand what browsers, bots and webhook tools can access.",
    eyebrow: "Security guide · Webhook credentials",
    lede: "A Discord webhook URL contains both an identifier and a secret token. Anyone holding the complete URL can usually post as that webhook without signing into your server. Security therefore starts with a simple rule: treat the full URL as a password, not as a harmless endpoint.",
    published: "2026-07-15",
    modified: "2026-07-15",
    keywords: [
      "discord webhook security",
      "discord webhook leaked",
      "discord webhook token",
      "secure discord webhook",
      "rotate discord webhook url",
    ],
    sections: [
      {
        heading: "Where webhook URLs leak",
        bullets: [
          "Public Git repositories, copied configuration examples and CI logs",
          "Screenshots or screen recordings that expose a browser, terminal or settings page",
          "Support tickets and chat messages with broad retention or membership",
          "Client-side analytics, crash reports and URL-query logging",
          "Browser extensions or third-party tools with more access than their task requires",
        ],
        paragraphs: [
          "Obscuring the channel name or webhook ID is not enough; the token segment is the credential. Redacting only the middle of a screenshot can also leave enough context for another copy in logs or history to be found.",
        ],
      },
      {
        heading: "If a webhook URL is exposed",
        bullets: [
          "Delete or rotate the webhook from Server Settings → Integrations → Webhooks immediately.",
          "Remove unauthorized messages and inspect audit context, but do not mistake cleanup for credential revocation.",
          "Search repositories, build output, logs, tickets and team chat for every copy of the old URL.",
          "Create a fresh webhook and update only approved consumers through their secret store.",
          "Review who can manage webhooks and whether the destination channel needs tighter permissions.",
        ],
      },
      {
        heading: "Safe storage by use case",
        table: {
          headers: ["Use case", "Preferred storage", "Avoid"],
          rows: [
            [
              "Local one-off browser post",
              "Memory or explicit browser-local storage on a trusted device",
              "Analytics, query strings and shared profiles",
            ],
            [
              "Deployed application",
              "Host secret manager or encrypted environment secret",
              "Bundled frontend variables and committed .env files",
            ],
            [
              "CI automation",
              "Repository or organization secret scoped to the workflow",
              "Printing request URLs in logs",
            ],
            [
              "Team-managed publishing",
              "A server-side credential store with access control and rotation",
              "Sending the URL through ordinary team chat",
            ],
          ],
        },
      },
      {
        heading: "How DWEEB handles the boundary",
        paragraphs: [
          "The core editor is local by default. A direct webhook post is made only after you choose Send and confirm it. Optional server-backed features such as scheduling, a shared message library and collaborative Activity drafts necessarily process the data required for that feature; their disclosures and retention rules should guide whether they fit your server.",
          "Organic attribution and analytics must never contain a webhook URL, Discord identifiers, share payload hashes or message content. DWEEB normalizes short-link paths, drops hashes and rejects arbitrary query parameters before page measurement.",
        ],
      },
      {
        heading: "Webhook or bot?",
        paragraphs: [
          "Use an incoming webhook for scoped publishing into a channel. Use an application or bot when you need to receive custom-ID interactions, manage roles or channels, read events, or enforce permissions at action time. An app-owned webhook sits between those cases: it can carry interactive components because Discord knows which application receives the click.",
        ],
      },
    ],
    sources: [
      {
        label: "Discord API: Webhook resource",
        url: "https://docs.discord.com/developers/resources/webhook",
      },
      {
        label: "Discord: OAuth2 security",
        url: "https://docs.discord.com/developers/topics/oauth2",
      },
    ],
    related: ["how-to-create-a-discord-webhook", "edit-discord-webhook-message"],
    ctaLabel: "Open the local-first builder",
    ctaPath: "/",
  }),
  guide({
    slug: "edit-discord-webhook-message",
    title: "How to Edit a Discord Webhook Message After Sending | DWEEB",
    h1: "Edit a Discord Webhook Message After Sending",
    description:
      "Restore a message sent by a Discord webhook, edit its Components V2 layout and update the original post in place without reposting it.",
    eyebrow: "Workflow guide · Restore and update",
    lede: "A typo should not force you to delete and repost an announcement. If you still control the webhook that created a message, DWEEB can restore the post into the visual editor and update the original message in place.",
    published: "2026-07-15",
    modified: "2026-07-15",
    keywords: [
      "edit discord webhook message",
      "update discord webhook message",
      "discord webhook message id",
      "edit discord embed after sending",
      "restore discord webhook message",
    ],
    sections: [
      {
        heading: "What you need",
        bullets: [
          "The webhook URL for the webhook that originally posted the message",
          "The Discord message link or its message ID",
          "Access to the destination channel if you need to copy the message link",
        ],
        paragraphs: [
          "A different webhook cannot edit the post, even if it targets the same channel. Discord binds the edit authority to the original webhook token. Bot-authored and ordinary user messages follow different authorization rules and are outside this workflow.",
        ],
      },
      {
        heading: "Restore and update the post",
        bullets: [
          "In Discord, use Copy Message Link on the message you want to change.",
          "Open DWEEB's Restore tab and provide the original webhook plus the message link or ID.",
          "Confirm the resolved destination, then load the message into the editor.",
          "Change text, colours, links, media or component layout and resolve any validation issues.",
          "Open Update, review the target again and confirm the in-place edit.",
        ],
      },
      {
        heading: "Threads and forum posts",
        paragraphs: [
          "A message link contains server, channel and message identifiers. Messages in threads and forum or media posts can also require the thread channel identifier when the webhook request is made. Paste the complete Discord link when possible so DWEEB can classify the target rather than forcing you to split the IDs by hand.",
        ],
      },
      {
        heading: "Why an update can fail",
        table: {
          headers: ["Failure", "Explanation", "Next step"],
          rows: [
            [
              "Unknown message",
              "The message was deleted or the ID is wrong",
              "Copy the link again from Discord",
            ],
            [
              "Invalid webhook token",
              "The webhook was deleted or rotated",
              "A new webhook cannot inherit edit authority",
            ],
            [
              "Unknown channel",
              "A sibling channel was mistaken for a thread or the target moved",
              "Use the full message link and correct channel",
            ],
            [
              "Invalid form body",
              "The edited payload violates a current Components V2 rule",
              "Resolve the editor's error-severity issues",
            ],
          ],
        },
      },
      {
        heading: "Make future edits easier",
        paragraphs: [
          "Save the webhook only on a trusted device or connect the server through the managed channel flow. Keep a draft in the browser or optional server library, and retain the Discord message link alongside campaign notes. For scheduled or recurring announcements, name the draft and webhook so another maintainer can identify the correct edit path without exposing the credential.",
        ],
      },
    ],
    sources: [
      {
        label: "Discord API: Edit Webhook Message",
        url: "https://docs.discord.com/developers/resources/webhook#edit-webhook-message",
      },
      {
        label: "Discord API: Get Webhook Message",
        url: "https://docs.discord.com/developers/resources/webhook#get-webhook-message",
      },
    ],
    related: [
      "how-to-create-a-discord-webhook",
      "discord-webhook-security",
      "discord-components-v2",
    ],
    ctaLabel: "Restore a webhook message",
    ctaPath: "/?intent=restore",
  }),
  guide({
    slug: "discord-text-formatting",
    title: "Discord Text Formatting: Markdown, Headers & More | DWEEB",
    h1: "Discord Text Formatting & Markdown Guide",
    description:
      "Every Discord markdown rule that actually renders: bold, italics, headers, subtext, lists, spoilers, code blocks, masked links — plus the quirks that break them.",
    eyebrow: "Reference · Markdown & formatting",
    lede: "Discord's markdown looks familiar but behaves like no other dialect: italics care about spaces, ordered lists silently merge into bullet lists, and links trim their own punctuation. This reference covers the full syntax plus the edge cases DWEEB's preview parser is tested against real Discord clients for.",
    published: "2026-07-17",
    modified: "2026-07-17",
    keywords: [
      "discord text formatting",
      "discord markdown",
      "discord bold italic underline",
      "discord headers",
      "discord spoiler tag",
    ],
    sections: [
      {
        heading: "The complete formatting cheat sheet",
        table: {
          headers: ["Syntax", "Result", "Notes"],
          rows: [
            ["**text**", "Bold", "Also combines: ***bold italic***"],
            ["*text* or _text_", "Italic", "See the quirks below — they are not interchangeable"],
            ["__text__", "Underline", "Nest with italics: __*text*__"],
            ["~~text~~", "Strikethrough", "Works inline anywhere"],
            ["||text||", "Spoiler", "Hidden until the reader clicks it"],
            ["`code`", "Inline code", "Use ``double backticks`` to contain a backtick"],
            [
              "```lang```",
              "Code block",
              "Multi-line; the language tag is kept but webhook messages get no highlighting",
            ],
            ["> text", "Quote", ">>> quotes every following line"],
            ["# / ## / ### text", "Heading 1–3", "Must start the line"],
            ["-# text", "Subtext", "Small, muted line — good for captions and footnotes"],
            ["- text or 1. text", "Bullet / numbered list", "Indent two spaces for a nested level"],
            [
              "[label](https://…)",
              "Masked link",
              "Bot, webhook and embed text only — regular user chat posts it literally",
            ],
          ],
        },
      },
      {
        heading: "Quirks Discord actually enforces",
        paragraphs: [
          "These are the rules that make a message render differently in Discord than in a generic markdown previewer. DWEEB's preview parser is verified against the live Discord client for each of them, so what you see in the editor is what the channel gets.",
        ],
        bullets: [
          "*italics* needs a non-space character right after the opening asterisk: `* text*` stays literal, which keeps math like 3 * 4 * 5 intact.",
          "_underscore italics_ needs word boundaries — snake_case_names stay literal, while a space-padded _phrase_ formats.",
          "Inline styles keep going across a line break: an unclosed **bold can format the next line.",
          "Numbered items directly after a bullet list merge into that bullet list; separate them with a blank line to keep the numbers.",
          "Bare URLs auto-link, but Discord drops trailing punctuation like .,:;\"')] from the link.",
          "In Components V2 text, unicode emoji render slightly enlarged but never as jumbo emoji — an emoji-only message does not blow up the way it does in normal chat.",
        ],
      },
      {
        heading: "Mentions, emoji and other tokens",
        table: {
          headers: ["Token", "Renders as", "Where the ID comes from"],
          rows: [
            ["<@user_id>", "@user mention", "Copy ID with Developer Mode enabled"],
            ["<@&role_id>", "@role mention", "Server settings → Roles → Copy ID"],
            ["<#channel_id>", "#channel link", "Right-click the channel → Copy ID"],
            [
              "<:name:emoji_id>",
              "Custom emoji",
              "The bot/webhook needs no membership for unicode; custom emoji must resolve",
            ],
            [
              "<a:name:emoji_id>",
              "Animated custom emoji",
              "Same as custom emoji, with the a: prefix",
            ],
            [
              "<t:unix:style>",
              "Dynamic timestamp",
              "Shown in each reader's own timezone — see the timestamp guide",
            ],
          ],
        },
        paragraphs: [
          "A custom emoji whose ID does not resolve renders as plain :name: text, so test custom emoji in the destination server before a big announcement.",
        ],
      },
      {
        heading: "Where each rule works",
        paragraphs: [
          "Regular user chat supports the core styles but not masked links. Webhook and bot messages support everything above, including masked links, in plain content and in Components V2 Text Displays. Legacy embed descriptions and fields support most inline styles and masked links, but headings and subtext belong to the modern surfaces.",
          "Components V2 Text Displays are the most capable text surface: headings, subtext, lists, quotes, code, mentions and timestamps all render, and DWEEB counts every character against the message-wide budget as you type.",
        ],
      },
      {
        heading: "Escaping and plain text",
        paragraphs: [
          "Prefix a formatting character with a backslash to show it literally: \\*not italic\\*. For a block that must never format — a config sample, a token pattern, ASCII art — use a code block, which suppresses all markdown inside it.",
        ],
      },
    ],
    sources: [
      {
        label: "Discord support: Markdown Text 101",
        url: "https://support.discord.com/hc/en-us/articles/210298617-Markdown-Text-101-Chat-Formatting-Bold-Italic-Underline",
      },
      {
        label: "Discord API: Message formatting reference",
        url: "https://docs.discord.com/developers/reference#message-formatting",
      },
    ],
    related: ["discord-timestamp-format", "discord-components-v2", "discord-webhook-limits"],
    ctaLabel: "Try the formatting live",
    ctaPath: "/",
  }),
  guide({
    slug: "discord-timestamp-format",
    title: "Discord Timestamp Format: All Styles & How to Use | DWEEB",
    h1: "Discord Timestamps: Every Format Code Explained",
    description:
      "Use Discord's <t:unix:style> timestamps to show any date in each reader's own timezone. All seven style codes with examples, plus a visual picker.",
    eyebrow: "Reference · Dynamic timestamps",
    lede: 'A Discord timestamp token like <t:1767225600:F> renders as a real date in every reader\'s own timezone and language — no more "8 PM EST / 1 AM UTC" tables in event posts. There are seven display styles, and the only input you need is a unix timestamp in seconds.',
    published: "2026-07-17",
    modified: "2026-07-17",
    keywords: [
      "discord timestamp format",
      "discord timestamp",
      "discord dynamic timestamp",
      "discord timestamp generator",
      "discord relative time",
    ],
    sections: [
      {
        heading: "How Discord timestamps work",
        paragraphs: [
          "The token is <t:UNIX> or <t:UNIX:STYLE>, where UNIX is a count of seconds since 1970-01-01 UTC and STYLE is one of seven single-letter codes. Discord replaces the token at render time using the viewer's locale and timezone, so the same message reads correctly in Tokyo and Toronto. When you omit the style, Discord uses f (short date/time).",
          "Timestamps work in normal chat, webhook content, embed text and Components V2 Text Displays. Inside a code block the token is shown literally — that is the standard way to show someone the syntax itself.",
        ],
      },
      {
        heading: "All seven timestamp styles",
        paragraphs: [
          "Examples below use 1767225600 (2026-01-01 00:00 UTC) as seen by an en-US reader in UTC. Every reader sees their own language and timezone.",
        ],
        table: {
          headers: ["Style", "Name", "Example output"],
          rows: [
            ["<t:1767225600:t>", "Short time", "12:00 AM"],
            ["<t:1767225600:T>", "Long time", "12:00:00 AM"],
            ["<t:1767225600:f>", "Short date/time (default)", "January 1, 2026 12:00 AM"],
            ["<t:1767225600:F>", "Long date/time", "Thursday, January 1, 2026 12:00 AM"],
            ["<t:1767225600:d>", "Short date", "1/1/2026"],
            ["<t:1767225600:D>", "Long date", "January 1, 2026"],
            ["<t:1767225600:R>", "Relative", "“in 3 days” / “2 hours ago” — updates live"],
          ],
        },
      },
      {
        heading: "Get the unix timestamp",
        bullets: [
          "In DWEEB, use the clock button in the text toolbar: pick a date, time and style, preview each style live, and the token is inserted for you.",
          "Terminal: date +%s prints the current unix time.",
          "JavaScript: Math.floor(Date.now() / 1000).",
          "Python: int(time.time()).",
        ],
        paragraphs: [
          "DWEEB's picker previews every style with the same formatter its message preview uses, so the row you click is exactly what the channel will show.",
        ],
      },
      {
        heading: "A timestamp in a real webhook payload",
        code: `{
  "flags": 32768,
  "components": [
    {
      "type": 10,
      "content": "## Community game night\\nStarts <t:1767225600:F> — that's <t:1767225600:R>."
    }
  ]
}`,
      },
      {
        heading: "Common mistakes",
        table: {
          headers: ["Symptom", "Cause", "Fix"],
          rows: [
            [
              "A date in the year 57,000",
              "Milliseconds were pasted instead of seconds",
              "Divide by 1000 and round down",
            ],
            [
              "The literal <t:…> text shows in chat",
              "The token is inside a code block or inline code",
              "Move it out of the code span",
            ],
            [
              "Time is wrong for some readers",
              "A written timezone was added next to the token",
              "Let the token carry the time; drop the hardcoded zone",
            ],
            [
              '"2 years ago" in an evergreen post',
              "Relative style ages with the message",
              "Use an absolute style like F for rules and pinned posts",
            ],
          ],
        },
      },
    ],
    sources: [
      {
        label: "Discord API: Message formatting — timestamp styles",
        url: "https://docs.discord.com/developers/reference#message-formatting-timestamp-styles",
      },
    ],
    related: ["discord-text-formatting", "discord-components-v2"],
    ctaLabel: "Insert a timestamp with the visual picker",
    ctaPath: "/",
  }),
  guide({
    slug: "discord-webhook-limits",
    title: "Discord Webhook Rate Limits & Message Limits | DWEEB",
    h1: "Discord Webhook Limits: Rate, Size and Components",
    description:
      "The limits every Discord webhook hits: rate limits and 429 handling, character caps, embed totals and Components V2 ceilings the editor enforces for you.",
    eyebrow: "Reference · Limits & rate limits",
    lede: "Webhook failures usually trace back to one of three separate ceilings: the size of a single message, the speed you call one webhook, and how fast one channel accepts webhook deliveries. Knowing which ceiling you hit turns a mystery 400 or 429 into a five-minute fix.",
    published: "2026-07-17",
    modified: "2026-07-17",
    keywords: [
      "discord webhook rate limit",
      "discord character limit",
      "discord embed limits",
      "discord message limits",
      "discord 429 retry after",
    ],
    sections: [
      {
        heading: "Message size and component ceilings",
        paragraphs: [
          "The numbers below are the ones DWEEB validates against before send; the Components V2 rows are generated from the same constants the editor uses, so this table cannot drift from the product.",
        ],
        table: {
          headers: ["What", "Limit", "Applies to"],
          rows: [
            ["Plain message content", "2,000 characters", "content field (legacy messages)"],
            [
              "Combined embed text",
              "6,000 characters across all embeds",
              "Legacy embeds (max 10 per message, 25 fields each)",
            ],
            [
              "Components V2 text budget",
              `${LIMITS.TOTAL_CHARACTERS.toLocaleString("en-US")} characters across all text-bearing fields`,
              "Every Text Display, label and option together",
            ],
            [
              "Total components",
              `${LIMITS.TOTAL_COMPONENTS} (max ${LIMITS.TOP_LEVEL_COMPONENTS} top-level)`,
              "Includes every nested component",
            ],
            [
              "Buttons per Action Row",
              `${LIMITS.ACTION_ROW_BUTTONS}`,
              "A select menu takes the whole row",
            ],
            ["Select menu options", `${LIMITS.SELECT_OPTIONS}`, "String select options per menu"],
            ["Media Gallery items", `${LIMITS.GALLERY_ITEMS}`, "Images/media per gallery"],
            [
              "Button label",
              `${LIMITS.BUTTON_LABEL} characters`,
              "Longer labels are rejected, not truncated",
            ],
            [
              "Webhook username override",
              `${LIMITS.WEBHOOK_USERNAME} characters`,
              "Per-message username field",
            ],
          ],
        },
      },
      {
        heading: "Rate limits and HTTP 429",
        paragraphs: [
          "Discord rate-limits per route: every response carries X-RateLimit-Limit, X-RateLimit-Remaining and X-RateLimit-Reset-After headers describing the bucket you just spent from, and exceeding it returns HTTP 429 with a retry_after value. Those headers are the only contractual numbers — treat them, not any fixed figure, as the source of truth.",
          "In practice, executing one webhook is bucketed at roughly five requests per two seconds, and Discord has additionally described a delivery cap of around 30 webhook messages per minute into a single channel. Both can change without notice, which is exactly why well-behaved senders react to the headers instead of hardcoding a rate.",
        ],
        code: `HTTP/1.1 429 Too Many Requests
Retry-After: 1
X-RateLimit-Remaining: 0

{ "message": "You are being rate limited.", "retry_after": 0.529, "global": false }`,
      },
      {
        heading: "Staying under the limits",
        bullets: [
          "Send one rich Components V2 message instead of a burst of small ones — layout blocks replace the multi-message pattern.",
          "Queue sends to a single webhook serially and sleep for retry_after (seconds) on any 429 before retrying.",
          "Never fan a loop out over one webhook URL in parallel; the bucket is shared and every request after the first few will 429.",
          "Schedule non-urgent posts instead of firing them together at the top of the hour.",
          "Split genuinely long announcements by design (a follow-up message) rather than letting truncation decide.",
        ],
      },
      {
        heading: "How DWEEB enforces this before send",
        paragraphs: [
          "The editor tracks the character budget and component ceilings live, itemizes violations in the issue list, and blocks send on error-severity problems — so a 400 invalid form body for an oversized payload is caught before the request exists. The full nesting rules live in the Components V2 guide.",
        ],
      },
    ],
    sources: [
      {
        label: "Discord API: Rate limits",
        url: "https://docs.discord.com/developers/topics/rate-limits",
      },
      {
        label: "Discord API: Execute Webhook",
        url: "https://docs.discord.com/developers/resources/webhook#execute-webhook",
      },
      {
        label: "Discord API: Message resource limits",
        url: "https://docs.discord.com/developers/resources/message",
      },
    ],
    related: [
      "discord-components-v2",
      "how-to-create-a-discord-webhook",
      "discord-text-formatting",
    ],
    ctaLabel: "Validate a message against the limits",
    ctaPath: "/",
  }),
  guide({
    slug: "discord-webhook-name-avatar",
    title: "Discord Webhook Name & Avatar: Set or Override | DWEEB",
    h1: "Change a Discord Webhook's Name and Avatar",
    description:
      "Set a Discord webhook's default name and avatar, or override both per message with username and avatar_url. Rules, JSON examples and troubleshooting.",
    eyebrow: "Practical guide · Webhook identity",
    lede: "A webhook's name and avatar are what your members actually see, and Discord gives you two layers of control: a stored profile on the webhook itself, and per-message overrides in the payload. Use the stored profile for a stable identity and overrides when one webhook speaks as several personas.",
    published: "2026-07-17",
    modified: "2026-07-17",
    keywords: [
      "discord webhook avatar",
      "discord webhook name",
      "change discord webhook avatar",
      "discord webhook username override",
      "discord webhook identity",
    ],
    sections: [
      {
        heading: "Two layers of identity",
        paragraphs: [
          "The stored profile is set where the webhook was created — Server Settings → Integrations → Webhooks — or through the Modify Webhook API. It is what any plain payload posts as.",
          "Per-message overrides are the username and avatar_url fields on the execute-webhook payload. They change how that one message appears and nothing else: the stored webhook keeps its own name and avatar, and the next plain payload uses the stored profile again.",
        ],
      },
      {
        heading: "Override the identity per message",
        paragraphs: [
          "DWEEB exposes both override fields in the builder, validates their lengths and shows the result in the live preview before anything posts. The raw payload shape:",
        ],
        code: `{
  "username": "Release Notes",
  "avatar_url": "https://example.com/release-bot.png",
  "content": "Version 2.4 is live."
}`,
      },
      {
        heading: "The rules Discord applies",
        bullets: [
          `Usernames are 1–${LIMITS.WEBHOOK_USERNAME} characters; names containing the substrings "clyde" or "discord" (case-insensitive) are rejected.`,
          `avatar_url accepts up to ${LIMITS.WEBHOOK_AVATAR_URL} characters and must be a direct HTTPS image URL — a page that merely contains the image will not work.`,
          "Overrides apply at send time only. Editing an already-posted webhook message cannot change its name or avatar; the edit endpoint does not accept those fields.",
          "The avatar is served through Discord's CDN, so a changed image behind the same URL can stay cached for a while.",
        ],
      },
      {
        heading: "Troubleshooting",
        table: {
          headers: ["Symptom", "Likely cause", "Fix"],
          rows: [
            [
              "Avatar shows the default silhouette",
              "avatar_url is not a direct image, or the host blocks Discord's fetch",
              "Use a direct https://….png/jpg/webp URL you can open raw in a browser",
            ],
            [
              "400 error mentioning username",
              "The name breaks a substring or length rule",
              "Remove clyde/discord fragments and stay within the length cap",
            ],
            [
              "Old avatar keeps appearing",
              "CDN caching of the previous image at the same URL",
              "Publish the new image under a new URL (or add a version query)",
            ],
            [
              "Identity reverts on edit",
              "Edits cannot carry username/avatar_url",
              "Delete and repost only if the identity itself must change",
            ],
          ],
        },
      },
      {
        heading: "Pick the right layer",
        paragraphs: [
          "Give each long-lived purpose its own webhook with a stored profile — announcements, starboard, build alerts — so the identity survives any tool that posts through it. Reach for per-message overrides when a single pipeline legitimately speaks as multiple voices, such as one CI webhook reporting per-project names and icons.",
        ],
      },
    ],
    sources: [
      {
        label: "Discord API: Execute Webhook (username / avatar_url)",
        url: "https://docs.discord.com/developers/resources/webhook#execute-webhook",
      },
      {
        label: "Discord API: Modify Webhook",
        url: "https://docs.discord.com/developers/resources/webhook#modify-webhook",
      },
      {
        label: "Discord support: Intro to Webhooks",
        url: "https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks",
      },
    ],
    related: [
      "how-to-create-a-discord-webhook",
      "edit-discord-webhook-message",
      "discord-webhook-security",
    ],
    ctaLabel: "Set a webhook identity visually",
    ctaPath: "/",
  }),
];

/** A commercial-intent product landing page generated at the site root. */
export interface LandingPage {
  slug: string;
  path: string;
  url: string;
  ogImage: string;
  title: string;
  h1: string;
  /** Breadcrumb + JSON-LD name for the page. */
  breadcrumb: string;
  /** Hero chip label. */
  chip: string;
  /** Hero lede paragraph. */
  lede: string;
  description: string;
  keywords: string[];
  ctaLabel: string;
  /** OG-card kicker/category lines (build-time image generation). */
  ogCategory: string;
  ogKicker: string;
  imageAlt: string;
  sections: GuideSection[];
  /** "Learn more" mini-cards — internal links only. */
  learn: { href: string; emoji: string; name: string; desc: string }[];
}

type LandingInput = Omit<LandingPage, "path" | "url" | "ogImage">;

function landing(input: LandingInput): LandingPage {
  const path = `/${input.slug}/`;
  return {
    ...input,
    path,
    url: `${SITE.origin}${path}`,
    ogImage: `${SITE.origin}/landing-og/${input.slug}.png`,
  };
}

const WEBHOOK_BUILDER_LANDING = landing({
  slug: "discord-webhook-builder",
  title: "Visual Discord Webhook & Embed Builder | DWEEB",
  h1: "Visual Discord Webhook & Embed Builder",
  breadcrumb: "Discord Webhook Builder",
  chip: "🛠️ Visual builder",
  lede: "Design, preview and send modern Discord messages from one visual editor—including Containers, Sections, buttons, media and legacy-embed conversion.",
  description:
    "Design Discord webhook, embed and Components V2 messages visually. Preview, import JSON, send, edit, schedule and share—free with no account required.",
  keywords: [
    "discord webhook builder",
    "discord embed builder",
    "discord message builder",
    "discord webhook generator",
    "discord components v2 builder",
  ],
  ctaLabel: "Build a Discord message free",
  ogCategory: "Visual editor · Free core builder",
  ogKicker: "Build · Preview · Send · Edit · Schedule",
  imageAlt: "DWEEB visual Discord webhook and Components V2 message builder",
  learn: [
    {
      href: "/guides/discord-components-v2/",
      emoji: "📘",
      name: "Components V2 guide",
      desc: "Types, JSON, limits and ownership",
    },
    {
      href: "/discord-embed-builder/",
      emoji: "🎨",
      name: "Discord embed builder",
      desc: "Design embed-style cards and convert embed JSON",
    },
    {
      href: "/templates/",
      emoji: "📋",
      name: "Discord message templates",
      desc: "Editable starting points",
    },
    {
      href: "/features/",
      emoji: "⚙️",
      name: "Webhook tools and features",
      desc: "Schedule, manage and add interactions",
    },
  ],
  sections: [
    {
      heading: "Build the message Discord will actually receive",
      paragraphs: [
        "DWEEB is a browser-based visual editor for Discord webhook and Components V2 messages. Add Containers, Sections, Text Displays, buttons, select menus, media galleries, thumbnails, files and separators from a component tree, then inspect the result in a Discord-style live preview. The core editor works without an account and keeps the working draft in your browser by default.",
        "Start from a blank message, a production-ready template, pasted Components V2 JSON or an older content-and-embeds payload. The importer converts legacy embeds into editable V2 Containers and tells you when an old field has no exact modern equivalent.",
      ],
    },
    {
      heading: "One editor from draft to delivery",
      bullets: [
        "Preview responsive Components V2 layouts while you edit",
        "Import and export webhook JSON with schema validation",
        "Send through a pasted incoming webhook or a connected server and channel",
        "Restore a webhook message and update the original post in place",
        "Schedule a post for later and manage upcoming server posts",
        "Save browser drafts, share a compressed link or use an optional server library",
        "Attach guided interactive plugins for roles, tickets, forms, giveaways and replies",
      ],
    },
    {
      heading: "Static webhooks, app-owned interactions and bots",
      paragraphs: [
        "A standard incoming webhook is enough for text, layout, media and link buttons. Discord requires an application-owned webhook when a custom button or select menu must deliver a click to software. Actions such as assigning roles or creating private ticket channels also require an installed app with the relevant permissions. DWEEB labels each template and feature with the real delivery mode before you commit to it.",
      ],
    },
    {
      heading: "Built for practical server publishing",
      paragraphs: [
        "Use DWEEB for welcome and rules panels, announcements, patch notes, event cards, support hubs, forms, product cards, role menus and server directories. The template library is editable rather than a gallery of screenshots: a search landing page opens the exact source message in the same builder used for final delivery.",
        "Free, Plus and Pro plans raise per-server quotas for optional hosted capacity. They do not lock editor features. You can always design, preview, import and export in the core builder without creating an account.",
      ],
    },
    {
      heading: "Privacy and control",
      paragraphs: [
        "Nothing posts until you review and confirm it. Direct browser-to-Discord sending uses the webhook only for the chosen request. Optional scheduling, libraries, collaboration and connected-server workflows process the data they require and disclose that boundary separately. Search analytics is sanitized to exclude URL hashes, webhook credentials, Discord IDs and message content.",
      ],
    },
  ],
});

const EMBED_BUILDER_LANDING = landing({
  slug: "discord-embed-builder",
  title: "Discord Embed Builder — Create & Convert Embeds | DWEEB",
  h1: "Discord Embed Builder",
  breadcrumb: "Discord Embed Builder",
  chip: "🎨 Embed builder",
  lede: "Design embed-style Discord messages visually, or paste existing embed JSON and convert it to Components V2 — with a pixel-accurate live preview and webhook delivery built in.",
  description:
    "Free visual Discord embed builder: design embed-style cards, paste legacy embed JSON, convert it to Components V2, preview live and send through your webhook.",
  keywords: [
    "discord embed builder",
    "discord embed generator",
    "discord embed creator",
    "discord embed maker",
    "discord embed json",
  ],
  ctaLabel: "Build a Discord embed free",
  ogCategory: "Visual editor · Embeds & Components V2",
  ogKicker: "Design · Convert · Preview · Send",
  imageAlt: "DWEEB visual Discord embed builder with live preview and JSON conversion",
  learn: [
    {
      href: "/guides/discord-embed-to-components-v2/",
      emoji: "🔄",
      name: "Embed to V2 converter guide",
      desc: "How every legacy field maps, and what can't",
    },
    {
      href: "/guides/discord-components-v2/",
      emoji: "📘",
      name: "Components V2 guide",
      desc: "The layout system behind modern embeds",
    },
    {
      href: "/templates/",
      emoji: "📋",
      name: "Discord message templates",
      desc: "Embed-style cards ready to customize",
    },
    {
      href: "/discord-webhook-builder/",
      emoji: "🛠️",
      name: "Discord webhook builder",
      desc: "The full send, edit and schedule workflow",
    },
  ],
  sections: [
    {
      heading: "The embed look, built on Discord's current layout system",
      paragraphs: [
        "A classic Discord embed is a colored card: accent stripe, title, description, thumbnail, image, fields and footer. DWEEB builds that same visual identity with Discord's Components V2 — a Container carries the accent color, Sections pair text with a thumbnail, Media Galleries hold the artwork — and shows the result in a live preview measured against the real Discord client.",
        "The difference is what you gain: real headings and subtext, multiple media blocks, separators, and buttons or select menus in the same card. You design the message visually; DWEEB produces the JSON Discord actually accepts and sends it through your webhook when you confirm.",
      ],
    },
    {
      heading: "Everything an embed did, and where it goes now",
      table: {
        headers: ["Classic embed part", "Modern equivalent in the builder", "What improves"],
        rows: [
          ["Accent color stripe", "Container accent color", "Identical look, same hex value"],
          ["Title + URL", "Heading text (optionally linked)", "Three heading sizes instead of one"],
          ["Description", "Text Display", "Full markdown including subtext and lists"],
          ["Thumbnail", "Section with a thumbnail accessory", "Text wraps beside it deliberately"],
          ["Large image", "Media Gallery", "Up to 10 items with spoiler support"],
          ["Fields grid", "Stacked Text Displays", "Readable on mobile instead of a cramped grid"],
          [
            "Footer + timestamp",
            "Subtext line or dynamic timestamp token",
            "Timestamps render in each reader's timezone",
          ],
          [
            "— (not possible)",
            "Buttons and select menus in the card",
            "Link buttons work on any webhook",
          ],
        ],
      },
    },
    {
      heading: "Already have embed JSON? Paste it",
      paragraphs: [
        "The JSON panel accepts a legacy content-plus-embeds payload and converts it into editable Components V2, with a conversion report that names every field that cannot map exactly — polls, stickers, inline field grids, provider video. Nothing is silently dropped, and you can adjust the converted layout visually before sending.",
      ],
      bullets: [
        "Import a full webhook payload or a bare embed object",
        "Keep the accent color, title, description, thumbnail, image and footer text",
        "Get warnings for anything with no modern equivalent before you apply",
        "Export the converted JSON, or send it directly through a webhook",
      ],
    },
    {
      heading: "Embed limits vs Components V2 limits",
      table: {
        headers: ["Constraint", "Classic embeds", "Components V2 in DWEEB"],
        rows: [
          [
            "Text budget",
            "6,000 characters across all embeds",
            "4,000 characters across all text fields",
          ],
          ["Structure cap", "10 embeds, 25 fields each", "40 components, 10 top-level blocks"],
          [
            "Interactive controls",
            "None on the embed itself",
            "Buttons and selects in the same card",
          ],
          ["Validation in DWEEB", "Checked on import", "Enforced live while you edit"],
        ],
      },
      paragraphs: [
        "The editor tracks both budgets for you: imports are validated as embeds, and everything you build afterwards is validated against the Components V2 ceilings before send.",
      ],
    },
    {
      heading: "Free, local by default, no account for the core builder",
      paragraphs: [
        "The embed builder is the same core DWEEB editor: free for noncommercial use, no account required, and your working draft stays in the browser by default. Send through any pasted incoming webhook or a connected server and channel — nothing posts until you review and confirm it. Interactive components need an app-owned destination, and the builder labels that requirement before you commit to it.",
      ],
    },
  ],
});

/** Every generated product landing page, in nav order. */
export const LANDINGS: LandingPage[] = [WEBHOOK_BUILDER_LANDING, EMBED_BUILDER_LANDING];
