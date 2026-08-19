/** Search-led, editorial pages generated into `/guides/` at build time. */

import { LIMITS } from "@/core/schema/limits";
import { SITE, type FaqEntry } from "./content";

export const GUIDES_LASTMOD = "2026-08-20";

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
    modified: "2026-08-20",
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
        // The Components V2 reference stopped at the payload, so a developer
        // who had the JSON still had to work out where it goes in their own
        // stack. That question is a large share of the search traffic this
        // guide sits in, and answering it is what makes the visual editor
        // useful to someone who was never going to press Send here.
        heading: "Sending the payload from a bot or your own code",
        paragraphs: [
          "The same components array works wherever the message is sent from, so a design checked visually does not have to be rebuilt in code. Only the transport and the flag handling differ.",
        ],
        table: {
          headers: ["Where you send it from", "What to pass", "What to watch"],
          rows: [
            [
              "A webhook URL, directly over HTTPS",
              "POST the JSON to the webhook URL with the components array and the V2 flag",
              "Add ?with_components=true to the URL, or components are silently dropped",
            ],
            [
              "A bot library such as discord.js",
              "Pass the same object through the library's message payload, or use its builder classes",
              "Set the IS_COMPONENTS_V2 flag; content and embeds are rejected once it is set",
            ],
            [
              "A library without Components V2 helpers",
              "Send the raw object — every library accepts a plain payload somewhere",
              "Numeric type values are the contract; helper classes are convenience only",
            ],
            [
              "An AI client, through DWEEB's MCP connector",
              "Ask for the message; the connector validates and previews before anything posts",
              "It acts as your Discord account, so it reaches only what you can",
            ],
          ],
        },
        bullets: [
          "Export from the [visual builder](/discord-message-builder/) once the preview looks right, then paste the payload into your project",
          "Import a payload your code already sends to adjust it visually instead of editing braces",
          "Keep the numeric component types as the source of truth; builder classes in any library are wrappers over them",
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
    ctaPath: "/#template=showcase",
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
    ctaPath: "/#intent=json",
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
    ctaPath: "/#intent=restore",
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
  /**
   * ISO date this page's visible copy last changed. Landings carry their own
   * date rather than sharing GUIDES_LASTMOD: they are revised independently of
   * the guide cluster, and the audit cross-checks JSON-LD dateModified against
   * the sitemap lastmod, so one shared constant would either lie about an
   * untouched page or under-report a revised one.
   */
  modified: string;
  ctaLabel: string;
  /** OG-card kicker/category lines (build-time image generation). */
  ogCategory: string;
  ogKicker: string;
  imageAlt: string;
  /** Optional real product UI shown near the hero with fixed dimensions. */
  productImage?: {
    src: string;
    srcSet?: string;
    sizes?: string;
    width: number;
    height: number;
    alt: string;
    caption: string;
  };
  sections: GuideSection[];
  /**
   * Visible Q&A rendered at the foot of the page and mirrored as FAQPage
   * JSON-LD. Every competitor ranking for the head terms answers the
   * definitional questions on-page; the schema must only ever describe text a
   * reader can actually see, so this is one field driving both.
   */
  faq?: FaqEntry[];
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
  title: "Discord Webhook Message Builder — Live Preview | DWEEB",
  h1: "Discord Webhook Message Builder",
  breadcrumb: "Discord Webhook Message Builder",
  chip: "🛠️ Visual builder",
  lede: "Use a visual Discord webhook message builder to design, preview, send, restore and schedule Components V2 messages from one editor.",
  description:
    "Build Discord webhook messages visually. Preview, import JSON, send, restore and edit with no account; sign in to schedule.",
  keywords: [
    "discord webhook message builder",
    "discord webhook builder",
    "discord webhook generator",
    "discord components v2 builder",
  ],
  modified: "2026-08-20",
  ctaLabel: "Open the webhook message builder",
  ogCategory: "Visual editor · Free core builder",
  ogKicker: "Build · Preview · Send · Edit · Schedule",
  imageAlt: "DWEEB Discord webhook message builder with Components V2 live preview",
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
        "DWEEB is a browser-based Discord webhook message builder for Components V2. Add Containers, Sections, Text Displays, buttons, select menus, media galleries, thumbnails, files and separators from a component tree, then inspect the result in a Discord-style live preview. The core editor works without an account and keeps the working draft in your browser by default.",
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
  faq: [
    {
      q: "How do I get a Discord webhook URL?",
      a: "In Discord, open Server Settings → Integrations → Webhooks, create a webhook on the channel you want to post to, and copy its URL. You need the Manage Webhooks permission on that channel. The full walkthrough, including how to keep the URL out of a public repository, is in the webhook setup guide.",
    },
    {
      q: "Is the webhook builder free?",
      a: "Yes. Designing, previewing, importing, exporting and sending are free for noncommercial use and need no account. Per-server Plus and Pro plans raise quotas on hosted extras such as scheduled posts and saved messages; they do not lock any editor feature.",
    },
    {
      q: "What can a plain webhook send without a bot?",
      a: "Formatted text, headings, lists, mentions and timestamps, coloured containers, sections with thumbnails, media galleries, file attachments, separators and link buttons — plus a custom display name and avatar for the post. Only components that must react to a click need an application-owned webhook.",
    },
    {
      q: "Can I schedule a webhook message for later?",
      a: "Yes. Switch the send step from Send now to Schedule, pick a time, and the post is delivered from DWEEB's server at that moment. Upcoming posts for a connected server are listed together so you can review or cancel them before they fire.",
    },
    {
      q: "Can I edit a webhook message after it has been posted?",
      a: "Yes. Restore the message from its link or from your server library, change it in the builder, and update the original in place through the same webhook rather than posting a correction underneath it.",
    },
    {
      q: "Why does Discord reject a message that looks fine?",
      a: "Almost always a limit: the message-wide character budget, the component count, or a media URL Discord cannot fetch. The builder enforces those ceilings while you type and marks the offending block, so the check happens before the send rather than after it.",
    },
  ],
});

const EMBED_BUILDER_LANDING = landing({
  slug: "discord-embed-builder",
  title: "Discord Embed Builder — Live Preview & V2 Converter | DWEEB",
  h1: "Discord Embed Builder",
  breadcrumb: "Discord Embed Builder",
  chip: "🎨 Embed builder",
  lede: "Design embed-style Components V2 messages visually, or paste a webhook payload containing legacy embeds and convert it — with a measured, high-fidelity preview and webhook delivery built in.",
  description:
    "Free visual Discord embed builder: design embed-style cards, paste legacy embed JSON, convert it to Components V2, preview live and send through your webhook.",
  keywords: [
    "discord embed builder",
    "discord embed generator",
    "discord embed creator",
    "discord embed maker",
    "discord embed json",
  ],
  modified: "2026-08-20",
  ctaLabel: "Build an embed-style message free",
  ogCategory: "Embed converter · Components V2",
  ogKicker: "Import · Convert · Preview · Send",
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
          ["Accent color stripe", "Container accent color", "Familiar stripe, same hex value"],
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
        "Import a webhook payload containing an embeds array",
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
  faq: [
    {
      q: "What is a Discord embed?",
      a: "An embed is the coloured card Discord renders instead of plain text: an accent stripe down the left, a title, a description, an optional thumbnail and large image, a grid of fields and a footer. Only webhooks and apps can send one — the normal message box cannot.",
    },
    {
      q: "Does this builder produce embed JSON or Components V2?",
      a: "It does not export a native classic-embed payload. It builds the embed's visual identity with Components V2 and sends that. A webhook payload containing an embeds array can be pasted and converted, and the resulting V2 message can be exported as JSON at any point.",
    },
    {
      q: "What happens to my old embed JSON when I import it?",
      a: "The accent colour, title, description, thumbnail, image and footer text carry across into editable Components V2 blocks. Anything with no exact modern equivalent — inline field grids, polls, stickers, provider video — is named in a conversion report rather than silently dropped, so you can decide what to do with it before applying.",
    },
    {
      q: "Do I need a bot to send an embed?",
      a: "No. Any incoming webhook URL will post an embed-style card, including its images and link buttons. A bot or application-owned webhook is only needed once a button or select menu has to respond to a click.",
    },
    {
      q: "Can I put buttons inside an embed?",
      a: "Not in a classic embed — Discord attaches components beside a legacy embed rather than inside it. In Components V2 the buttons and select menus sit in the same container as the text and media, which is one of the main reasons to build the card this way.",
    },
    {
      q: "How much text fits in one message?",
      a: "Classic embeds share a 6,000-character budget across all embeds in a message. A Components V2 message has a 4,000-character budget across every text field, and the builder counts against it live so you know before you send rather than after Discord refuses it.",
    },
  ],
});

/**
 * The head-term page. "Discord message builder" is the broadest way people
 * describe what this product is, and the home page can only answer it so far:
 * `/` renders the editor itself, so its crawlable body is a UI rather than
 * prose. This page carries the depth — what a message builder is, which message
 * types exist, and where each one can be delivered. The two sibling landings
 * stay narrower on purpose (webhook workflow, embed conversion) so the three do
 * not compete for one query.
 */
const MESSAGE_BUILDER_LANDING = landing({
  slug: "discord-message-builder",
  title: "Free Discord Message Builder with Live Preview | DWEEB",
  h1: "Discord Message Builder",
  breadcrumb: "Discord Message Builder",
  chip: "💬 Visual message builder",
  lede: "Build rich Discord webhook messages visually — formatted text, embed-style cards, media, buttons and select menus — against a live preview measured off the real Discord client.",
  description:
    "Build rich Discord webhook messages visually: text, embed-style cards, media, buttons and menus. Live preview, free, and no account for the core builder.",
  keywords: [
    "discord message builder",
    "discord webhook message builder",
    "discord message creator",
    "discord message maker",
    "discord embed builder",
    "discord components v2 builder",
  ],
  modified: "2026-08-20",
  ctaLabel: "Build a Discord message free",
  ogCategory: "Message builder · Free core editor",
  ogKicker: "Text · Embeds · Media · Buttons · Menus",
  imageAlt:
    "DWEEB — a visual Discord message builder showing a live preview of the finished message",
  productImage: {
    src: "/builder-preview.webp",
    srcSet: "/builder-preview-768.webp 768w, /builder-preview.webp 1280w",
    sizes: "(max-width: 700px) calc(100vw - 32px), 880px",
    width: 1280,
    height: 680,
    alt: "DWEEB Discord message builder with a component tree beside a live Discord message preview",
    caption:
      "The working editor: arrange Components V2 on the left and inspect the measured Discord preview on the right.",
  },
  learn: [
    {
      href: "/discord-webhook-builder/",
      emoji: "🛠️",
      name: "Discord webhook builder",
      desc: "The full send, edit and schedule workflow",
    },
    {
      href: "/discord-embed-builder/",
      emoji: "🎨",
      name: "Discord embed builder",
      desc: "Embed-style cards and legacy embed JSON",
    },
    {
      href: "/templates/",
      emoji: "📋",
      name: "Discord message templates",
      desc: "Editable starting points for every channel",
    },
    {
      href: "/guides/discord-components-v2/",
      emoji: "📘",
      name: "Components V2 guide",
      desc: "The layout system behind modern messages",
    },
  ],
  sections: [
    {
      heading: "What a Discord message builder does",
      paragraphs: [
        "Discord's composer handles everyday chat, formatting, attachments and polls. A structured coloured card, text beside a thumbnail, or controls laid out with the message must instead arrive as a webhook or app payload. A message builder is the visual layer over that payload: you arrange the message the way you want people to read it, and the builder produces the JSON Discord accepts.",
        "DWEEB is that layer and works as a Discord webhook message builder from first draft to delivery. Add blocks from a component tree, type straight into them, and watch a high-fidelity preview whose colours, spacing and image geometry are measured against the live Discord client. [The test method](/about/) and known font, emoji and client-version differences are documented. Discord's character and structure limits are enforced while you type, so a message is checked as you build instead of failing at the API.",
      ],
    },
    {
      heading: "Rich Discord webhook layouts, in one builder",
      table: {
        headers: ["What you want to post", "How you build it", "What it needs"],
        rows: [
          [
            "Announcements and formatted text",
            "Text Displays with [Discord markdown](/guides/discord-text-formatting/), headings, lists, mentions and [timestamps](/guides/discord-timestamp-format/)",
            "Any webhook",
          ],
          [
            "An [embed-style card](/discord-embed-builder/)",
            "A Container with an accent colour, text and media inside it",
            "Any webhook",
          ],
          [
            "A banner or an image gallery",
            `A Media Gallery of up to ${LIMITS.GALLERY_ITEMS} images, with optional spoilers`,
            "Any webhook",
          ],
          ["Text beside a small image", "A Section with a thumbnail accessory", "Any webhook"],
          [
            "Links to your site, docs or store",
            `An Action Row of up to ${LIMITS.ACTION_ROW_BUTTONS} link buttons`,
            "Any webhook",
          ],
          [
            "Buttons and menus that act on a click",
            "Interactive buttons or [select menus](/features/discord-select-menu/) paired with a built-in feature",
            "An app-owned webhook",
          ],
          [
            "Roles, tickets, forms or giveaways",
            "The same message, with a guided [plugin](/features/) attached to the control",
            "An installed app",
          ],
        ],
      },
      paragraphs: [
        `One message can mix all of these. Up to ${LIMITS.TOP_LEVEL_COMPONENTS} top-level blocks stack in whatever order you arrange them, which is what separates a [Components V2](/guides/discord-components-v2/) layout from a classic embed's fixed slots.`,
      ],
    },
    {
      heading: "From blank canvas to posted message",
      bullets: [
        "Start blank, from an [editable template](/templates/), or by pasting webhook JSON you already have",
        "Rearrange blocks in a component tree and edit each one in place",
        "Check the measured, high-fidelity preview at desktop and mobile widths",
        "Set the display name and avatar the message is posted under",
        "Send to a pasted webhook URL, or pick a connected server and channel",
        "Restore a message the webhook already posted and update it in place",
        "[Schedule the post](/features/schedule-discord-messages/) for later, or hand the draft to someone else as one link",
        "Export the finished message as JSON whenever you want the payload itself",
      ],
    },
    {
      heading: "Where the message is delivered",
      paragraphs: [
        "A standard incoming webhook — [the kind anyone with Manage Webhooks can create](/guides/how-to-create-a-discord-webhook/) in channel settings — carries text, layout, colour, media and link buttons. That covers most of what a server posts.",
        "Discord only routes a click back to software when the message was posted by an application-owned webhook, so custom buttons and select menus need one. Actions that change the server, such as assigning a role or opening a private ticket channel, additionally need an app installed with the relevant permissions.",
        "The builder labels which of the three a design needs before you commit to it, so you find out while you are still editing rather than at the send step.",
      ],
    },
    {
      heading: "Built for servers that post regularly",
      paragraphs: [
        "One-off builders stop at the send button. DWEEB keeps the message afterwards: a per-server library of what you posted and what is still a draft, scheduled posts with an upcoming queue, [in-place editing](/guides/edit-discord-webhook-message/) of anything the webhook sent, and a [webhook manager](/features/discord-webhook-manager/) for the channels you publish to.",
        "For teams, the builder also runs inside Discord as an embedded Activity so several people can edit one draft together, and an [AI assistant](/features/ai-discord-message-writer/) can draft or restructure a message from a plain-English description. Plus and Pro plans raise per-server quotas on those hosted extras; they never lock an editor feature.",
      ],
    },
    {
      // The SERP for "Discord message builder" is split: half of it is
      // discord.js's `MessageBuilder` class reference. A visitor arriving from
      // that half needs to know within one screen whether this is the same
      // thing, and the honest answer — same payload, different layer — is also
      // the answer that keeps them here, because the JSON export feeds exactly
      // the code they were about to write. Saying nothing sent them straight
      // back to the results page.
      heading: "Visual builder or raw JSON — the same message either way",
      paragraphs: [
        "Every message here has two forms: the layout you arrange on screen, and the components payload Discord accepts. DWEEB keeps both in sync and hands you either one. Export the finished message as JSON at any point, paste it into your own project, and send it from discord.js, discord.py, or a plain HTTPS POST to the webhook URL — the payload is the same one the send button uses.",
        "Import works the other way too. Paste a payload you already have — including a legacy embeds array — and it opens as an editable design rather than a wall of braces, which is usually the fastest way to adjust a message some code is already sending.",
        "If you were looking for a builder class in a bot library, such as discord.js's MessageBuilder, that is the code-side way to assemble the same payload. This page is the visual layer over it, and the two coexist: design and check the message here, export the JSON, and let your bot send it. The [Components V2 guide](/guides/discord-components-v2/) documents the payload shape, every component type and the limits each one enforces.",
        "An AI client can drive the same builder directly through DWEEB's [MCP connector](/features/discord-mcp-server/), which exposes the templates, validation and preview as tools rather than asking a model to guess at the JSON.",
      ],
    },
    {
      heading: "Free, local by default, no account for the core builder",
      paragraphs: [
        "The editor is free for noncommercial use and source-available. Your working draft, browser saves, recent webhook URLs and attachments stay on your device, and a default share link carries its message in the URL fragment, which browsers never send to a server. Optional features — short links, schedules, server libraries, collaboration, AI and billing — process only what they need to work, and the Privacy Policy itemises each one.",
        "Nothing is posted until you review the preview and confirm it.",
      ],
    },
  ],
  faq: [
    {
      q: "What is a Discord message builder?",
      a: "It is a visual editor for the rich messages Discord's own composer cannot send. You lay the message out on screen — text, colours, images, buttons, menus — and the builder generates the webhook payload Discord accepts, so the JSON is produced for you rather than written by hand.",
    },
    {
      q: "Is DWEEB's Discord message builder free?",
      a: "Yes. The full editor is free for noncommercial use, needs no account, and runs in the browser. Optional per-server Plus and Pro plans only raise quotas on hosted extras such as scheduled posts and saved messages — no editor feature is locked behind a plan.",
    },
    {
      q: "Do I need a Discord bot to use it?",
      a: "No. Any incoming webhook URL is enough for text, layout, media and link buttons. A bot or application-owned webhook is only required when a button or select menu has to respond to a click, and the builder tells you when a design has crossed that line.",
    },
    {
      q: "Is this the same as discord.js's MessageBuilder?",
      a: "No, and they are not alternatives. MessageBuilder is a class in the discord.js library that assembles the message payload in code. DWEEB is a visual editor that produces the same payload without code, and exports it as JSON — so you can design and check a message here and still send it from your own bot.",
    },
    {
      q: "Can I export the message as JSON?",
      a: "Yes. Any message can be exported as the exact webhook payload Discord accepts, and pasting a payload back in reopens it as an editable design. Nothing is locked to DWEEB.",
    },
    {
      q: "Can I build Discord embeds with it?",
      a: "Yes. The classic embed look — accent stripe, title, description, thumbnail, image, footer — is built from a Container with sections and media, and you can paste a webhook payload containing an embeds array to convert it. The embed builder page explains how each legacy field maps across.",
    },
    {
      q: "Can I edit a Discord message after I have sent it?",
      a: "Yes. Paste the message link or pick the post from your server library, edit it in the builder, and update the original in place through the same webhook, so it keeps its position in the channel.",
    },
    {
      // "Embed generator", "embed creator" and "message maker" are separate
      // searches for this same tool, and the honest answer to whether they are
      // the same thing is a real product distinction rather than a synonym
      // list: the legacy embed and the Components V2 layout are different
      // objects, and which one you get is the thing worth knowing.
      q: "Is a message builder the same as an embed generator?",
      a: "In everyday use, yes — embed generator, embed creator and message maker all describe a visual editor for rich Discord messages. The distinction that matters is what comes out. A legacy embed is one fixed card with named slots; a Components V2 message is a layout you arrange, which can hold several blocks, media and controls. DWEEB builds the second and imports the first, so an existing embed payload opens as an editable design.",
    },
    {
      q: "Does it work on a phone?",
      a: "Yes. The builder is responsive, and the preview opens as a sheet over the editor on small screens so you can check the result without leaving the block you are editing.",
    },
    {
      q: "Where does my message go while I am building it?",
      a: "The working draft stays in your browser. It reaches Discord only when you press send, through the webhook you chose, and reaches DWEEB's own services only for the optional features you turn on, such as scheduling or a server library.",
    },
  ],
});

/** Every generated product landing page, in nav order. */
export const LANDINGS: LandingPage[] = [
  MESSAGE_BUILDER_LANDING,
  WEBHOOK_BUILDER_LANDING,
  EMBED_BUILDER_LANDING,
];
