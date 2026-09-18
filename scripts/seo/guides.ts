/** Search-led, editorial pages generated into `/guides/` at build time. */

import { LIMITS } from "@/core/schema/limits";
import { SITE, type FaqEntry } from "./content";
import { CODE_GUIDE_INPUTS } from "./code-guides";

export const GUIDES_LASTMOD = "2026-09-18";

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

export type GuideInput = Omit<GuidePage, "path" | "url" | "ogImage">;

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
    title: "Discord Components V2 Guide: JSON Example & Limits | DWEEB",
    h1: "Discord Components V2: Complete Guide",
    description:
      "Every Discord Components V2 type with its numeric ID, nesting rules, a minimal webhook JSON example, current limits and an editable example you can open.",
    eyebrow: "Developer guide · Components V2",
    lede: "Components V2 turns a Discord message into a real layout tree: text, sections, thumbnails, media, separators, containers and interactive controls. This guide explains the model that Discord actually accepts and gives you an editable reference instead of a disconnected code fragment.",
    published: "2026-07-15",
    modified: "2026-09-16",
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
        heading: "Message component type IDs and placement",
        table: {
          headers: ["Component", "Use it for", "Important rule"],
          rows: [
            [
              "Text Display (10)",
              "Markdown text, headings, lists and mentions",
              "Counts toward the message-wide character budget",
            ],
            [
              "Section (9)",
              "One to three text blocks beside a thumbnail or button",
              "Its accessory is part of the Section",
            ],
            ["Thumbnail (11)", "Compact media beside Section text", "Used as a Section accessory"],
            [
              "Media Gallery (12)",
              "One or more large images or media items",
              `Up to ${LIMITS.GALLERY_ITEMS} items`,
            ],
            [
              "File (13)",
              "A downloadable attachment card",
              "Place at the top level or inside a Container",
            ],
            [
              "Separator (14)",
              "A divider or deliberate vertical space",
              "Can use small or large spacing",
            ],
            [
              "Container (17)",
              "An embed-like group with an optional accent colour",
              "Containers cannot be nested",
            ],
            [
              "Action Row (1)",
              "Buttons or one select menu",
              `Up to ${LIMITS.ACTION_ROW_BUTTONS} buttons`,
            ],
            [
              "Button (2)",
              "A link or an application-handled action",
              "Place in an Action Row or as a Section accessory",
            ],
            [
              "String Select (3)",
              "A dropdown with choices you define",
              "One per Action Row; requires an interaction handler",
            ],
            [
              "User / Role / Mentionable / Channel Select (5 / 6 / 7 / 8)",
              "A dropdown of Discord entities",
              "One per Action Row; Discord supplies its choices",
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
              "Use a documented raw-payload API, or call Discord's HTTP API directly",
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
          "If the API rejects a payload or drops a component, use the [webhook error guide](/guides/discord-webhook-errors/) to separate layout validation from delivery and app-ownership problems. For notification behavior, see [webhook mentions and allowed_mentions](/guides/discord-webhook-mentions/).",
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
    modified: "2026-09-16",
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
        heading: "Create a webhook on mobile",
        paragraphs: [
          "The mobile app exposes the same control. Open the server, tap its name to reach Server Settings, choose Integrations, then Webhooks, and create the webhook exactly as on desktop. Copying the URL on a phone is the risky step: the clipboard is shared with every app, so paste it straight into the tool that needs it and clear it afterwards rather than leaving it in a notes app or a chat draft.",
          "A channel-level shortcut also exists on desktop: open the channel's settings, choose Integrations and create the webhook there. It is the same object, already pointed at that channel.",
        ],
      },
      {
        heading: "What the webhook URL contains",
        paragraphs: [
          "A webhook URL has two parts after the fixed prefix: a numeric webhook id and a long token. The id is public information — it appears in API responses and identifies the webhook. The token is the secret: anyone who has the full URL can post as that webhook without being a member of the server, edit or delete the messages it sent, and change its name and avatar. There is no separate password, which is why the URL is treated as a credential throughout these guides.",
          "Discord does not offer a regenerate-token button. If the URL has leaked or you simply want to rotate it, delete the webhook and create a new one; messages it already posted stay in the channel and can still be restored from their message link by the new owner of that channel's webhooks.",
        ],
        code: `https://discord.com/api/webhooks/<webhook id>/<webhook token>
                                   public          secret`,
      },
      {
        heading: "What a webhook can and cannot do",
        table: {
          headers: ["A webhook can", "A webhook cannot"],
          rows: [
            [
              "Post to its channel with any display name and avatar, including Components V2 layouts, embeds and file attachments",
              "Read messages, react, or reply to anything in the channel",
            ],
            [
              "Edit and delete the messages it posted, using the message id and its own token",
              "Delete or edit messages posted by people or other webhooks",
            ],
            [
              "Post into an existing thread, or create a forum or media post, with the thread parameters",
              "Send direct messages, assign roles, or run slash commands",
            ],
            [
              "Carry link buttons that open a URL",
              "Own custom-ID buttons or select menus unless an application created it — those need an interaction handler",
            ],
          ],
        },
        paragraphs: [
          "That last row is the one that surprises most people. A webhook is a one-way door into one channel: perfect for announcements, rules, status posts and anything else that does not need a response. When members must click something and have a bot react, the destination has to be a webhook owned by an application that receives the click — DWEEB's plugins and the [interaction features](/features/) exist for exactly that case.",
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
        paragraphs: [
          "Keep the HTTP status, Discord's numeric error code and the field named in the response together. The [webhook troubleshooting guide](/guides/discord-webhook-errors/) maps those details to a fix; a 404 while restoring a message needs a different check from a 404 while sending a new one.",
          "A forum or media channel also needs a post destination. Follow the [forum and thread workflow](/guides/discord-webhook-forum-threads/) to create a titled post or send into an existing thread.",
        ],
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
    modified: "2026-09-11",
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
          "A message link contains server, channel and message identifiers. Messages in threads and forum or media posts can also require the thread channel identifier when the webhook request is made. Paste the complete Discord link when possible so DWEEB can classify the target rather than forcing you to split the IDs by hand. The [forum and thread guide](/guides/discord-webhook-forum-threads/) explains which ID belongs where and how creating a new post differs from updating one.",
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
    modified: "2026-09-16",
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
              "Multi-line; DWEEB preserves the language tag but its preview does not add syntax colours",
            ],
            ["> text", "Quote", ">>> quotes every following line"],
            ["# / ## / ### text", "Heading 1–3", "Must start the line"],
            ["-# text", "Subtext", "Small, muted line — good for captions and footnotes"],
            ["- text or 1. text", "Bullet / numbered list", "Indent two spaces for a nested level"],
            [
              "[label](https://…)",
              "Masked link",
              "Supported in regular chat, webhook text and embed descriptions",
            ],
          ],
        },
      },
      {
        heading: "Quirks Discord actually enforces",
        paragraphs: [
          "These are the rules that make a message render differently in Discord than in a generic markdown previewer. DWEEB's preview parser has regression tests based on live Discord checks. The preview still has documented differences such as native emoji artwork, font fallbacks and no code syntax highlighting; review the final message in its destination channel.",
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
          "A mention's appearance and its notification are separate. Use [allowed_mentions to control webhook pings](/guides/discord-webhook-mentions/), especially when importing text that contains user or role tokens.",
        ],
      },
      {
        heading: "Where each rule works",
        paragraphs: [
          "Regular user chat supports masked links as well as the core styles. Webhook and bot messages can use the same link syntax in plain content and Components V2 Text Displays. Legacy embed descriptions and fields support many inline styles and masked links, but a legacy embed's title, footer and other named fields have their own rendering rules; do not assume every field is a full chat message.",
          "Components V2 Text Displays are the most capable text surface: headings, subtext, lists, quotes, code, mentions and timestamps all render, and DWEEB counts every character against the message-wide budget as you type.",
          "The classic use of all of this at once is a pinned rules post — a heading, bold rule names, a quote block for consequences and a subtext footer. The [server rules templates](/guides/discord-server-rules/) are written in exactly that markdown and can be pasted as they are.",
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
    related: [
      "discord-timestamp-format",
      "discord-server-rules",
      "discord-components-v2",
      "discord-webhook-limits",
    ],
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
    title: "Discord Webhook Limits: Rate Limits, 429s & Caps | DWEEB",
    h1: "Discord Webhook Limits: Rate, Size and Components",
    description:
      "The limits every Discord webhook hits: rate limits and 429 handling, character caps, embed totals and Components V2 ceilings the editor enforces for you.",
    eyebrow: "Reference · Limits & rate limits",
    lede: "Webhook failures usually trace back to one of three separate ceilings: the size of a single message, the speed you call one webhook, and how fast one channel accepts webhook deliveries. Knowing which ceiling you hit turns a mystery 400 or 429 into a five-minute fix.",
    published: "2026-07-17",
    modified: "2026-09-16",
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
          "Discord applies route and global rate limits. Responses can include X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset-After and X-RateLimit-Bucket headers. An HTTP 429 response supplies Retry-After or retry_after in seconds. Read the values returned for your request instead of hardcoding a requests-per-second figure.",
          "A rate limit is a delivery problem, not a reason to shorten valid message text. In DWEEB, stop retrying while the send countdown is active. If another tool uses the same webhook, coordinate its sending too. Use the [webhook error guide](/guides/discord-webhook-errors/) when the failure has a different HTTP status or a field-specific validation error.",
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
  guide({
    slug: "discord-webhook-errors",
    title: "Discord Webhook Errors: Fix 400, 401, 403, 404 & 429 | DWEEB",
    h1: "Fix Discord Webhook Errors",
    description:
      "Diagnose Discord webhook errors by HTTP status, API code and field path. Fix invalid forms, unknown webhooks, missing components and failed updates.",
    eyebrow: "Troubleshooting · Discord webhooks",
    lede: "Start with the operation that failed, the HTTP status and Discord's numeric error code. A missing webhook, a missing message and an invalid Components V2 layout need different repairs. This guide turns the response into a next step without repeated test posts or unnecessary credential replacement.",
    published: "2026-09-11",
    modified: "2026-09-11",
    keywords: [
      "discord webhook not working",
      "discord webhook errors",
      "discord webhook invalid form body",
      "discord unknown webhook 10015",
      "discord webhook 400 401 403 404 429",
    ],
    sections: [
      {
        heading: "Find the status, code and failing field",
        paragraphs: [
          "First record whether you were sending a new post, restoring one, updating it or configuring a webhook. In DWEEB, the send error combines the response status with Discord's code and expands nested validation errors into readable paths. Keep those details together when diagnosing the failure.",
          "For example, components[0].components[1].url means the URL on the second child inside the first top-level component. Array positions start at zero. Select that component in the builder and correct that field before changing the rest of the design. The editor's own issue list may already point to the same problem.",
        ],
      },
      {
        heading: "Discord webhook error codes and next steps",
        table: {
          headers: ["Response", "What it identifies", "Next check"],
          rows: [
            [
              "400 / 50035",
              "Payload or Content-Type validation",
              "Read the nested field error; fix that field in the editor",
            ],
            [
              "401 / 50027",
              "Webhook token problem",
              "Copy the complete current URL from your webhook settings",
            ],
            [
              "403 / 50013",
              "Insufficient permissions",
              "Check the failed action and the app's access in that destination",
            ],
            ["404 / 10015", "Webhook not found", "Verify which saved webhook the send is using"],
            [
              "404 / 10008",
              "Message not found",
              "Verify the original webhook, message link and thread target",
            ],
            [
              "10003",
              "Channel not found",
              "Check that the thread belongs to the webhook's parent channel",
            ],
            ["429", "Rate limit", "Wait for the indicated retry delay before trying again"],
            [
              "220001 / 220002",
              "Missing or conflicting forum destination",
              "Choose a new post title OR an existing Thread ID",
            ],
          ],
        },
        paragraphs: [
          "HTTP status and JSON code are separate fields, not interchangeable numbers. The table lists useful combinations and individual API codes; the actual response is the evidence. A status alone cannot tell you which field or resource failed.",
        ],
      },
      {
        heading: "Fix 400 Invalid Form Body in a Components V2 message",
        bullets: [
          "Import the payload into the [Discord message builder](/discord-message-builder/) and resolve error-severity issues before another send.",
          "For a V2 design, place visible text inside Text Displays and remove legacy top-level content and embeds. Use the [embed converter](/guides/discord-embed-to-components-v2/) when the source is a legacy embed.",
          "Check that every Section has a button or thumbnail accessory, and inspect any empty media URLs, invalid link URLs or conflicting allowed-mentions settings named in the error.",
          "If your own code sends the export, use its JSON body as JSON. When uploading files with FormData, let the browser set the multipart Content-Type and boundary.",
        ],
        paragraphs: [
          "DWEEB's local validation catches supported layout and field constraints; Discord remains the final authority for current permissions, destination state and server-side rules. A clean local issue list narrows the investigation, but it cannot prove a remote post will succeed.",
        ],
      },
      {
        heading: "Why components disappear or buttons fail",
        paragraphs: [
          "When sending an exported design through your own webhook client, check the request URL as well as the payload. A person-created webhook needs with_components=true for Discord to respect its components. The JSON also needs the V2 flag. DWEEB's own send path supplies both; a script that copies only the components array can miss them.",
          "A link button and a custom-ID button have different delivery requirements. If a static message works but an interactive control fails, review its setup badge and app-owned destination. A visually correct button does not create the application handler that responds to its click. The [Components V2 guide](/guides/discord-components-v2/) explains the ownership boundary.",
        ],
      },
      {
        heading: "Diagnose restore and update separately from new sends",
        paragraphs: [
          "If sending a new message works but Restore fails, start with the message target. Copy its complete Discord link, select the webhook that originally posted it and inspect the optional Thread ID. Creating a new webhook does not transfer ownership of old posts. Follow the [restore and update workflow](/guides/edit-discord-webhook-message/) before deciding to repost.",
          "For forum and media channels, distinguish a new post title from an existing post's channel ID. In DWEEB, the Forum post fields create a post; the Send panel's Thread ID addresses an existing one. The [forum and thread guide](/guides/discord-webhook-forum-threads/) walks through both paths.",
        ],
      },
      {
        heading: "Handle rate limits, network failures and uncertain sends",
        paragraphs: [
          "On 429, wait for Discord's reported retry delay. DWEEB exposes that delay as a countdown. Stop other repeated sends using the same destination while you investigate, and consult the [webhook limits guide](/guides/discord-webhook-limits/) for automation design.",
          "A browser network error means DWEEB did not receive a readable response; it does not prove Discord rejected the message. Check the destination channel before sending again, then inspect connectivity and extensions that block discord.com. A lost response after a successful post can otherwise turn one intended announcement into duplicates.",
          "When asking for help, share the operation, status, code and a redacted field error. Remove webhook tokens, message content and private identifiers from screenshots and network logs. Keep a local draft of the design so the diagnostic process does not become a rebuild.",
        ],
      },
    ],
    sources: [
      {
        label: "Discord API: HTTP statuses and JSON error codes",
        url: "https://docs.discord.com/developers/topics/opcodes-and-status-codes",
      },
      {
        label: "Discord API: Execute and edit webhook messages",
        url: "https://docs.discord.com/developers/resources/webhook",
      },
      {
        label: "Discord API: Rate limit response handling",
        url: "https://docs.discord.com/developers/topics/rate-limits",
      },
    ],
    related: [
      "discord-webhook-limits",
      "edit-discord-webhook-message",
      "discord-webhook-forum-threads",
    ],
    ctaLabel: "Check a webhook message visually",
    ctaPath: "/",
  }),
  guide({
    slug: "discord-webhook-mentions",
    title: "Discord Webhook Mentions: Roles, Everyone & No Pings | DWEEB",
    h1: "Control Discord Webhook Mentions and Pings",
    description:
      "Use allowed_mentions to ping a Discord role or user, allow everyone, or suppress webhook pings. Includes Components V2 JSON and visual setup.",
    eyebrow: "Practical guide · Mentions and notifications",
    lede: "A visible @mention is only part of the setup. The message's allowed_mentions policy controls which written mentions can notify, and Discord still applies permissions and recipient settings. Set that policy explicitly when importing announcements, choosing a role audience or sending a test message.",
    published: "2026-09-11",
    modified: "2026-09-11",
    keywords: [
      "discord webhook mention role",
      "discord webhook ping everyone",
      "discord allowed_mentions",
      "discord webhook no ping",
      "discord webhook mentions not working",
    ],
    sections: [
      {
        heading: "Webhook defaults and explicit mention policies",
        paragraphs: [
          "Discord documents different defaults for ordinary messages and webhook or interaction messages: omitting allowed_mentions on a webhook parses user mentions only. Do not copy an ordinary-chat default into a webhook script. An explicit policy makes the intended audience visible in the exported JSON.",
        ],
        table: {
          headers: ["Intent", "allowed_mentions value", "Text required"],
          rows: [
            ["No mention pings", '{"parse":[]}', "Any mention text remains filtered"],
            ["One role", '{"parse":[],"roles":["ROLE_ID"]}', "<@&ROLE_ID>"],
            ["One user", '{"parse":[],"users":["USER_ID"]}', "<@USER_ID>"],
            ["Everyone or here", '{"parse":["everyone"]}', "@everyone or @here"],
          ],
        },
      },
      {
        heading: "A Components V2 message that mentions one role",
        paragraphs: [
          "Replace the example numeric ID in both places with your destination role's ID. Keep the ID as a JSON string. This example leaves user and everyone parsing disabled, so a later edit that adds a different mention does not automatically expand the configured audience.",
        ],
        code: `{
  "flags": 32768,
  "allowed_mentions": {
    "parse": [],
    "roles": ["123456789012345678"]
  },
  "components": [
    {
      "type": 10,
      "content": "## Event reminder\\n<@&123456789012345678> Our next session is ready."
    }
  ]
}`,
      },
      {
        heading: "Set the audience in DWEEB",
        bullets: [
          "Add the mention to a Text Display. Use the connected server's mention picker when available, or paste the correct user or role token.",
          "Open Notifications in the message options. Choose the classes of mentions you intend to allow.",
          "For a particular role or user, expand the additional options and fill Allowed role IDs or Allowed user IDs instead of enabling that whole class.",
          "Review the live issues. The editor flags invalid IDs and a whole-class setting combined with an explicit list for that same class.",
          "Open Send and review its mention summary together with the destination. A role selected from one server does not become the corresponding role in another server.",
        ],
        paragraphs: [
          "Use the [Discord message builder](/discord-message-builder/) to preview the text and inspect JSON before delivery. If you are comparing several policies, start with one short Text Display so decoration does not obscure the audience settings. Save the reusable draft only after the destination and policy are correct.",
        ],
      },
      {
        heading: "Suppress all pings with parse: []",
        paragraphs: [
          "Use an explicit empty parse array with no allowed role or user IDs for a no-ping test. Removing the allowed_mentions field is a different instruction: it restores the webhook default. This matters when JSON is cleaned up by a script that deletes empty arrays.",
          "For imported or model-written content, check both the Text Displays and the top-level policy. A message can look like a harmless documentation example while containing a real user token. In DWEEB, import the full payload through JSON rather than copying only its components if you also need its allowed_mentions settings.",
        ],
        code: `{
  "flags": 32768,
  "allowed_mentions": { "parse": [] },
  "components": [
    { "type": 10, "content": "Test only: @everyone <@123456789012345678>" }
  ]
}`,
      },
      {
        heading: "Silent send and no mentions solve different problems",
        paragraphs: [
          "SUPPRESS_NOTIFICATIONS disables push notifications while mentions can still create badges. Recipient notification settings also affect delivery, so an allowed mention is not a guarantee that a phone will alert. Suppressing mentions uses allowed_mentions; silent delivery uses the separate message flag.",
          "DWEEB exposes silent send alongside the audience controls. Choose it for an intentionally quiet announcement; use an explicit no-mentions policy when people should not be targeted at all. Review both settings when reusing a reminder template for an informational post.",
        ],
      },
      {
        heading: "Why a role mention is visible but does not notify",
        bullets: [
          "Check for the <@&ROLE_ID> token in a Text Display. Typing a role's display name or adding a role-select component is not the same as writing that token.",
          "Compare the role ID in the text with the Allowed role IDs field. Names can match across servers while their IDs differ.",
          "Review the server's role mentionability, the sending app's permissions and the recipient's notification settings.",
          "Check whether silent send or an explicit no-mentions policy came from the draft you reused.",
        ],
        paragraphs: [
          "When restoring an old message, review the policy again before Update. Discord reconstructs mentions using the edit request's policy; a missing policy does not inherit the original request's restrictions. Keep audience settings with the message design, and use the [editing guide](/guides/edit-discord-webhook-message/) for the complete restore workflow.",
        ],
      },
    ],
    sources: [
      {
        label: "Discord API: Allowed Mentions Object",
        url: "https://docs.discord.com/developers/resources/message#allowed-mentions-object",
      },
      {
        label: "Discord API: Message formatting tokens",
        url: "https://docs.discord.com/developers/reference#message-formatting",
      },
      {
        label: "Discord API: Editing webhook mentions",
        url: "https://docs.discord.com/developers/resources/webhook#edit-webhook-message",
      },
    ],
    related: [
      "discord-text-formatting",
      "edit-discord-webhook-message",
      "discord-webhook-security",
    ],
    ctaLabel: "Build a message with controlled mentions",
    ctaPath: "/",
  }),
  guide({
    slug: "discord-webhook-forum-threads",
    title: "Discord Webhooks in Forum Posts & Threads: Guide | DWEEB",
    h1: "Send Discord Webhooks to Forum Posts and Threads",
    description:
      "Create a Discord forum post with thread_name, send into an existing thread with thread_id, add tags and restore webhook messages for editing.",
    eyebrow: "Workflow guide · Forum posts and threads",
    lede: "A forum post is a thread inside its parent channel. Choose whether you are creating a new post or adding a message to one that already exists before you send. DWEEB has separate controls for those operations, and the difference explains many otherwise confusing webhook errors.",
    published: "2026-09-11",
    modified: "2026-09-11",
    keywords: [
      "discord webhook forum channel",
      "discord webhook thread_id",
      "discord webhook thread_name",
      "discord webhook forum post",
      "discord webhook error 220001",
    ],
    sections: [
      {
        heading: "Choose a new post or an existing thread",
        table: {
          headers: ["Your goal", "DWEEB control", "Request field"],
          rows: [
            [
              "Create a forum or media post",
              "Forum post → Thread name",
              "thread_name in the JSON body",
            ],
            [
              "Send into an existing post or thread",
              "Send → optional Thread ID",
              "thread_id in the request query",
            ],
            [
              "Change a message already posted",
              "Restore, then Update",
              "Original message ID and its thread target",
            ],
          ],
        },
        paragraphs: [
          "For a forum or media destination, Discord requires a new post title or an existing thread target. Use one path at a time. The webhook belongs to the parent channel; the thread ID identifies a child destination within it.",
          "Decide based on how members should find the information. Use a new post for a separate topic such as each release's notes. Use an existing thread for a follow-up on that topic. Use Update for a correction to the original message so readers do not have to reconstruct the current version from several posts.",
        ],
      },
      {
        heading: "Create a new forum post in DWEEB",
        bullets: [
          "Build the first message, then select the forum or media channel in the connected destination flow or supply that channel's webhook URL.",
          "Open Forum post in the builder's message options and enter Thread name. This title is separate from any heading written inside your Text Display.",
          "Add Applied tags if needed, using tag IDs from this destination's configured tags. DWEEB accepts comma- or space-separated IDs.",
          "Leave the Send panel's optional Thread ID empty, review the destination and confirm the new post.",
          "Keep the returned Discord message link. DWEEB records the new thread target after a successful send so an in-place update reaches the post you just created.",
        ],
        paragraphs: [
          `The editor limits Thread name to ${LIMITS.THREAD_NAME} characters and Applied tags to ${LIMITS.APPLIED_TAGS} IDs. When a known forum destination is missing a title, its validation issue leads back to the Forum post fields. A tag belongs to a particular channel's configuration; copying a template's text does not create matching tags in another server.`,
        ],
      },
      {
        heading: "JSON example for a new forum post",
        paragraphs: [
          "This is a complete small V2 design you can import into DWEEB. The top-level thread_name creates the forum title, while the Text Display contains the post body. The mention policy makes it suitable for a first connectivity test without mention pings.",
          "When sending from your own client, POST this JSON to the parent channel's webhook URL with with_components=true and wait=true. Keep the returned message ID and channel ID with your application record. Do not put a live webhook credential in a shared example or source file.",
        ],
        code: `{
  "flags": 32768,
  "thread_name": "Release notes: community update",
  "allowed_mentions": { "parse": [] },
  "components": [
    {
      "type": 10,
      "content": "## Community update\\nShare feedback and questions in this post."
    }
  ]
}`,
      },
      {
        heading: "Send into an existing thread or forum post",
        paragraphs: [
          "In Discord with Developer Mode enabled, copy the thread's Channel ID. Open DWEEB's Send panel, expand the optional thread or forum-post control and paste it into Thread ID. Use a webhook for the parent channel, clear Thread name and any create-only tag settings, then review the send destination.",
          "In your own code, thread_id belongs in the webhook URL's query string, not inside the components tree. Keep the normal exported V2 body, without thread_name. An ID from an unrelated text channel cannot be used to make the webhook post there; choose that channel's own destination instead.",
        ],
        code: "POST https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN?with_components=true&wait=true&thread_id=THREAD_ID",
      },
      {
        heading: "Restore and edit a message inside a forum post",
        paragraphs: [
          "Copy the complete message link from inside the post and open Restore. Keep the original webhook selected and supply the thread target if the workflow needs it. After the message loads, edit the design and choose Update. Changing Text Display content edits that message; the Forum post title field is for creating a new post.",
          "In the embedded Discord Activity, the collaboration room belongs to the server where the Activity launched. Restore can confirm a sibling-channel switch within that server. For a message in another server, open the draft on the web and choose the appropriate destination there. A server switch cannot travel with the original collaboration room.",
          "See [editing webhook messages](/guides/edit-discord-webhook-message/) for ownership requirements. A fresh webhook URL is not a substitute for the webhook that sent the original message.",
        ],
      },
      {
        heading: "Troubleshoot forum and thread delivery",
        table: {
          headers: ["Problem", "Check in your design or destination"],
          rows: [
            [
              "220001: no forum target",
              "Enter a Thread name for a new post or the existing Thread ID",
            ],
            [
              "220002: conflicting targets",
              "Clear the target for the operation you are not performing",
            ],
            [
              "10003: unknown channel",
              "Check the thread's parent against the selected webhook's channel",
            ],
            [
              "Repeated new posts",
              "A new send still has Thread name; use an existing Thread ID or Update",
            ],
            [
              "Missing or invalid tags",
              "Use tag IDs configured for this forum, not role IDs or visible tag names",
            ],
          ],
        },
        paragraphs: [
          "For an archived or locked thread, inspect its state and the access available to the posting app before retrying. A successful preview cannot determine whether the destination is currently writable. The [webhook troubleshooting guide](/guides/discord-webhook-errors/) covers the broader HTTP errors and how to read a field-specific response.",
        ],
      },
    ],
    sources: [
      {
        label: "Discord API: Webhook thread targets and forum parameters",
        url: "https://docs.discord.com/developers/resources/webhook#execute-webhook",
      },
      { label: "Discord API: Threads", url: "https://docs.discord.com/developers/topics/threads" },
      {
        label: "Discord API: Forum and thread error codes",
        url: "https://docs.discord.com/developers/topics/opcodes-and-status-codes",
      },
    ],
    related: [
      "how-to-create-a-discord-webhook",
      "edit-discord-webhook-message",
      "discord-webhook-errors",
    ],
    ctaLabel: "Build a forum post visually",
    ctaPath: "/",
  }),
  // Added 2026-09-16 from Search Console data: the server-rules template page
  // was earning ~1,000 impressions a quarter across "discord server rules
  // template", "discord rules copy and paste" and dozens of variants, but sat
  // at position 22-50 with a 0.5% CTR — searchers want rule TEXT they can paste,
  // which a short six-rule preview card never satisfied. This guide carries the
  // text; the template page carries the visual card, and they cross-link.
  guide({
    slug: "discord-server-rules",
    title: "Discord Server Rules Template: Copy & Paste Examples | DWEEB",
    h1: "Discord Server Rules Templates You Can Copy and Paste",
    description:
      "Copy-and-paste Discord server rules templates for general, gaming, creator and study servers, plus voice and age-restricted add-ons and formatting tips.",
    eyebrow: "Community guide · Server rules",
    lede: "Good rules are short, numbered and impossible to miss. This guide gives you complete rule sets you can paste into your #rules channel today — a general template, versions for gaming, creator and study servers, add-ons for voice chat and age-restricted channels — plus the formatting that makes them readable and a way to keep them editable after you post.",
    published: "2026-09-16",
    modified: "2026-09-16",
    keywords: [
      "discord server rules template",
      "discord rules template",
      "discord rules copy and paste",
      "discord server rules examples",
      "rules for discord server",
    ],
    sections: [
      {
        heading: "What a good rules message does",
        paragraphs: [
          "A rules post has one job: let a new member understand what is expected in under a minute, and give moderators something specific to point at later. Everything below is built around that, so each template keeps rules short, numbers them, states the consequences once, and names where to go with questions.",
          "Paste the block that fits your server, delete what does not apply, and change the wording to sound like your community. A rule nobody can picture breaking is dead weight — cut it.",
        ],
        bullets: [
          "One idea per rule, one line per rule. Long paragraphs get skimmed and forgotten.",
          'Number the rules so staff can say "rule 3" instead of quoting a paragraph.',
          "State consequences once, at the end, in a quote block — not after every rule.",
          "Say where to appeal or ask: a ticket, a mod DM, a channel.",
          "Date the post. A rules message with no date reads as abandoned.",
        ],
      },
      {
        heading: "General Discord server rules template (copy and paste)",
        paragraphs: [
          "This is the all-purpose set. It works for a friend group, a hobby community or a public server, and it is the same wording the [server rules template](/templates/discord-server-rules-template/) in DWEEB starts from, expanded to ten rules. Discord markdown is already applied: the heading, bold rule names, the quote for consequences and the small subtext line all render as-is.",
        ],
        code: `# 📜 Server Rules
Being here means you agree to follow these.

**1. Be respectful.** No harassment, hate speech, slurs or personal attacks.
**2. Keep it civil.** Disagree with ideas, not people. No flame wars.
**3. No spam.** No flooding, mass mentions, copy-paste chains or wall-to-wall caps.
**4. Stay on topic.** Use the right channel and read the channel description first.
**5. Keep it safe for work.** No NSFW, gore or shock content outside channels marked age-restricted.
**6. No advertising.** No unsolicited invites, self-promotion or DM ads.
**7. Protect privacy.** Never share someone else's personal information.
**8. No impersonation.** Do not pose as staff, other members or public figures.
**9. Follow Discord's rules.** Discord's Terms of Service and Community Guidelines apply here too.
**10. Staff decisions are final.** Take disputes to a ticket or a mod DM, not public chat.

> Breaking a rule can mean a warning, a timeout, a kick or a ban depending on severity. Repeat offences escalate.
-# Last updated September 2026 · Questions? Open a ticket or ask a moderator.`,
      },
      {
        heading: "Short rules template for a small server",
        paragraphs: [
          "A server with thirty people does not need ten rules. Five is enough to set the tone without reading like a legal notice.",
        ],
        code: `# Rules
**1.** Be kind. No harassment, hate or personal attacks.
**2.** No spam, mass pings or advertising.
**3.** Keep NSFW and shock content out.
**4.** Respect people's privacy — no doxxing, no leaking DMs.
**5.** If a mod asks you to stop, stop.

> Warnings first. Repeat it and you're out.`,
      },
      {
        heading: "Gaming server rules template",
        paragraphs: [
          "Gaming communities need the general rules plus a few that only come up around matches, voice chat and account trading. Keep the game-specific etiquette in its own block so casual members can skip it.",
        ],
        code: `# 🎮 Server Rules
**1. Respect everyone.** No harassment, slurs, hate speech or personal attacks — in text or in voice.
**2. Good sportsmanship.** No rage-quitting mid-match, griefing teammates or trash talk that crosses into abuse.
**3. No cheating or exploits.** Discussing, sharing or selling cheats, hacks or exploits is an instant ban.
**4. No account trading.** No buying, selling or sharing accounts, items or currency for real money.
**5. Use LFG channels for LFG.** Post team requests in #looking-for-group, not in general chat.
**6. Mark spoilers.** Use spoiler tags for story content from the last 30 days.
**7. Keep voice clean.** No mic spam, soundboards, music or screaming; push-to-talk if you have background noise.
**8. Stay on topic.** Clips go in #clips, memes in #memes, bugs and complaints in #feedback.
**9. No advertising.** No server invites, stream links or referral codes outside #self-promo.
**10. Follow Discord's rules and staff direction.** Discord's Terms and Community Guidelines apply; staff decisions are final.

> Timeout first, then a kick, then a ban. Cheating and account selling skip straight to a ban.`,
      },
      {
        heading: "Creator and community server rules template",
        paragraphs: [
          "A creator's server has two audiences — fans who want to hang out, and people who want something from the creator. The rules should protect the first group from the second without making the place feel policed.",
        ],
        code: `# ✨ Community Rules
**1. Be respectful to everyone,** including the creator, the mods and each other. No harassment, hate speech or drama.
**2. No begging or demanding.** Don't ask for follows, shout-outs, free stuff, DMs or replies.
**3. Self-promo only where allowed.** Share your own content in #self-promo, never in general or in DMs.
**4. Don't leak private content.** No screenshots of members-only posts, streams or DMs outside this server.
**5. No spam or mass pings.** One message, not five. Never @everyone.
**6. Keep it safe for work.** Nothing you wouldn't want on a stream.
**7. Respect the schedule.** Stream and upload times are posted in #announcements — please don't ask when the next one is.
**8. Stay on topic.** Use the channel names; #off-topic exists for everything else.
**9. Follow Discord's Terms and Community Guidelines.**
**10. Mods have the final say.** Questions and appeals go to a ticket.

> Rule breaks get a warning, then a timeout, then removal. Leaks and harassment are an immediate ban.`,
      },
      {
        heading: "Study, class or professional server rules template",
        paragraphs: [
          "Servers built around a course, a study group or a professional community need rules about honesty and shared material more than rules about memes.",
        ],
        code: `# 📚 Server Rules
**1. Be professional and respectful.** Disagree with arguments, not people.
**2. No academic dishonesty.** Don't ask for or share answers to graded work. Explaining a concept is fine; posting a solution is not.
**3. Respect copyright.** No pirated textbooks, paid course material or paywalled papers.
**4. Stay on topic.** Subject channels are for that subject; #lounge is for everything else.
**5. Search before you ask.** Check the pinned FAQ and use the search bar — repeat questions get redirected.
**6. No recording.** Do not record or screenshot voice sessions or study rooms without everyone's consent.
**7. Protect privacy.** No sharing of names, emails, grades or personal details that aren't yours.
**8. No advertising or recruiting** for paid services, tutoring or other servers without staff approval.
**9. Follow Discord's Terms and Community Guidelines.**
**10. Staff direction is final.** Appeals through a ticket.

> Warnings for minor issues; dishonesty, piracy and privacy violations are removed on the first offence.`,
      },
      {
        heading: "Add-on rules for voice chat and age-restricted channels",
        paragraphs: [
          "Two situations regularly need their own short block. Paste either one under the main rules, or pin it inside the channel it applies to.",
          "Age-restricted content on Discord may only be posted in channels marked age-restricted, and Discord's Community Guidelines still apply inside them. A server rule can be stricter than Discord's policy; it can never be looser.",
        ],
        code: `## 🎙️ Voice chat
**1.** No mic spam, soundboards, music bots in talk channels, or screaming.
**2.** Push-to-talk if your background is noisy.
**3.** No recording without asking the channel first.
**4.** Don't hop between channels to interrupt conversations.
**5.** AFK and sleep channels are for AFK and sleep — mute yourself.

## 🔞 Age-restricted channels
**1.** Only post here — never in general channels, avatars, statuses or nicknames.
**2.** Nothing illegal, nothing involving minors, nothing non-consensual. Zero tolerance.
**3.** Discord's Community Guidelines apply inside this channel too.
**4.** Mark anything shocking with a spoiler tag.`,
      },
      {
        heading: "Format the rules so people actually read them",
        paragraphs: [
          "Every template above uses the same five pieces of Discord markdown. They are the difference between a rules post that gets read and one that gets scrolled past. The [text formatting reference](/guides/discord-text-formatting/) covers every rule and the quirks around them.",
          'Bold numbers are used instead of Discord\'s list syntax on purpose. A "1." list renders, but Discord numbers the items itself and merges them into any bullet list sitting directly above, so the numbers you typed are not the numbers people see — bold text stays exactly as you wrote it.',
        ],
        table: {
          headers: ["Element", "Markdown", "Why it helps"],
          rows: [
            ["Heading", "# Server Rules", "Largest text on the page; the eye lands on it first."],
            [
              "Rule name",
              "**1. Be respectful.**",
              "The bold fragment is the part people remember.",
            ],
            [
              "Consequences",
              "> Breaking a rule can mean …",
              "A quote block sets it apart from the rules themselves.",
            ],
            ["Footnote", "-# Last updated …", "Subtext keeps dates and contacts out of the way."],
            ["Sub-heading", "## Voice chat", "Groups add-on rules without a second message."],
          ],
        },
      },
      {
        heading: "Post it as a pinned card, then keep it editable",
        paragraphs: [
          'Pasting the text into #rules as a normal message works, but it is tied to whoever posted it and it cannot carry an accent colour or dividers. Posting it through a webhook with the [server rules template](/templates/discord-server-rules-template/) gives you a card with a coloured stripe, separators between the header, the rules and the consequences, and a named sender such as "Server Rules" instead of a personal account. Open the template, paste your rules into the middle text block, check the preview and send.',
          "Rules change. Instead of deleting the post and losing the pin, [restore the message and update it in place](/guides/edit-discord-webhook-message/) — the message link stays the same, so nothing that points at it breaks. If the rules mention a role or a user, review [allowed mentions](/guides/discord-webhook-mentions/) first so an edit does not ping anyone.",
          "On a Community server, Discord's Rules Screening feature shows a short list of rules that new members must accept before they can talk. Keep that list to the essentials and keep the full text in #rules; the screening prompt is deliberately compact, and the channel is where people will actually look things up.",
        ],
      },
      {
        heading: "How many rules should a Discord server have?",
        paragraphs: [
          "Five to ten. Small servers do well with five; a large public server can justify ten plus a couple of add-on blocks. Past that, split the post with sub-headings or move channel-specific etiquette into the channels themselves — a twenty-rule wall is a signal that nobody expects members to read it.",
          'Cut any rule that is really a mood ("no drama"), any rule already covered by a more specific one, and any rule you would not actually enforce. If a situation comes up twice and no rule covers it, add one then.',
        ],
      },
      {
        heading: "The rules you must keep whatever you write",
        paragraphs: [
          "Discord's Terms of Service and Community Guidelines apply to every server on the platform. Your rules can be stricter than them and often should be, but a rule that permits something Discord forbids protects nobody, and Discord can act on the server regardless of what your #rules channel says. That is why every template above includes one line pointing at Discord's own rules.",
          "Two things are worth stating explicitly because they come up constantly: content that is not safe for work belongs only in channels marked age-restricted, and anything involving minors or non-consensual material is a platform-level violation, not a server-level one. Report it to Discord as well as removing it.",
        ],
      },
    ],
    sources: [
      { label: "Discord Community Guidelines", url: "https://discord.com/guidelines" },
      { label: "Discord Terms of Service", url: "https://discord.com/terms" },
      {
        label: "Discord support: Rules Screening FAQ",
        url: "https://support.discord.com/hc/en-us/articles/1500000466882-Rules-Screening-FAQ",
      },
      {
        label: "Discord support: Enabling your Community server",
        url: "https://support.discord.com/hc/en-us/articles/360047132851-Enabling-Your-Community-Server",
      },
      {
        label: "Discord support: Markdown Text 101",
        url: "https://support.discord.com/hc/en-us/articles/210298617-Markdown-Text-101-Chat-Formatting-Bold-Italic-Underline",
      },
    ],
    related: [
      "discord-text-formatting",
      "edit-discord-webhook-message",
      "discord-webhook-mentions",
      "how-to-create-a-discord-webhook",
    ],
    ctaLabel: "Open the rules template",
    ctaPath: "/#template=rules",
  }),
  // The developer cluster — sending a Components V2 message from code — lives
  // in its own file; every code block in it is generated at build time.
  ...CODE_GUIDE_INPUTS.map(guide),
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
  /**
   * Whether this landing carries the visible ratings block and the
   * `aggregateRating` schema (see `ratings.ts` / `layout.ts`).
   *
   * Exactly **one** page should set this. A rich-result rating is a claim about
   * the product, not about a page, so publishing it on all three landings would
   * put three of our own URLs in competition to be the one Google shows stars
   * against — and split the signal between them. It belongs on the page
   * targeting the head term, which is the result the stars are meant to win.
   *
   * Nothing renders until the aggregate clears `MIN_RATINGS_TO_PUBLISH`, so
   * this is safe to set before any ratings exist.
   */
  showsRatings?: boolean;
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
  // The head-term page is the one that carries the rating: it is the result
  // "Discord message builder" is meant to win, and stars beside it are worth
  // more than on any sibling. See `showsRatings` on the interface for why only
  // one page may set this.
  showsRatings: true,
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
