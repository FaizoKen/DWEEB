/** Search-led, editorial pages generated into `/guides/` at build time. */

import { LIMITS } from "@/core/schema/limits";
import { SITE } from "./content";

export const GUIDES_LASTMOD = "2026-07-15";

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
    modified: "2026-07-15",
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
    related: ["discord-embed-to-components-v2", "how-to-create-a-discord-webhook"],
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
    modified: "2026-07-15",
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
    related: ["discord-webhook-security", "discord-components-v2", "edit-discord-webhook-message"],
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
];

export const PRODUCT_LANDING = {
  path: "/discord-webhook-builder/",
  url: `${SITE.origin}/discord-webhook-builder/`,
  ogImage: `${SITE.origin}/landing-og/discord-webhook-builder.png`,
  title: "Visual Discord Webhook & Embed Builder | DWEEB",
  h1: "Visual Discord Webhook & Embed Builder",
  description:
    "Design Discord webhook, embed and Components V2 messages visually. Preview, import JSON, send, edit, schedule and share—free with no account required.",
  keywords: [
    "discord webhook builder",
    "discord embed builder",
    "discord message builder",
    "discord webhook generator",
    "discord components v2 builder",
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
  ] satisfies GuideSection[],
} as const;
