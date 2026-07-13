/**
 * SEO copy for the static feature pages (`/features/<slug>/`).
 *
 * The companion of `content.ts` (which owns the template pages). This is the one
 * place to edit per-feature marketing/SEO content — it's **build-only**, never
 * imported by the app, so the longform copy adds nothing to the shipped bundle.
 *
 * A "feature" is a thing DWEEB *does*: a plugin (Tickets, Self Role, Giveaway…)
 * or a core capability (scheduled posts, the webhook manager, the AI assistant).
 * Each entry is fully self-contained — unlike templates, features carry no
 * derived component inventory — so adding one is just: append an entry here, and
 * (optionally) point `previewTemplateId` at a template that showcases it so the
 * page renders a live preview and the CTA deep-links into the builder with it
 * pre-loaded.
 *
 * `pluginId`, when set, is the registry id (`src/core/plugins/registry.json`);
 * the page generator uses it to cross-link every template that pairs with the
 * plugin (templates ↔ features internal linking — the SEO multiplier).
 */

import { SITE, type FaqEntry } from "./content";

/** Display order of feature categories on the `/features` index. */
export const FEATURE_CATEGORIES = [
  "Onboarding & roles",
  "Support",
  "Forms & intake",
  "Engagement",
  "Publishing",
  "Utilities",
] as const;

export const FEATURE_CATEGORY_BLURB: Record<string, string> = {
  "Onboarding & roles": "Verify new members and let them pick their own roles.",
  Support: "Help desks, tickets and canned answers that cut repeat questions.",
  "Forms & intake": "Collect structured submissions — applications, reports, suggestions.",
  Engagement: "Giveaways and interactions that get your community clicking.",
  Publishing: "Send, schedule and manage what your server posts.",
  Utilities: "Smaller helpers that round out the builder.",
};

const ACCENT_BLURPLE = 0x5865f2;

/** Hand-written SEO + content for one feature. */
export interface FeatureSeo {
  /** Stable id — the plugin id for plugin-backed features, else a feature key. */
  id: string;
  /** URL slug — the page lives at `/features/<slug>/`. Keyword-led. */
  slug: string;
  emoji: string;
  category: (typeof FEATURE_CATEGORIES)[number];
  /** OG-card accent (hex int). */
  accent: number;
  /** `<title>` + `og:title`. Lead with the target keyword. */
  title: string;
  /** On-page `<h1>`. */
  h1: string;
  /** Short one-liner shown on the card and under the h1. */
  tagline: string;
  /** Meta description + `og:description` (~150–160 chars). */
  description: string;
  /** Opening paragraph — the unique, substantive copy that earns the page. */
  intro: string;
  /** "How it works" steps. */
  howItWorks: { name: string; text: string }[];
  /** "What you can set up" bullets. */
  configurable: string[];
  /** "When to use it" bullets. */
  whenToUse: string[];
  /** FAQ entries (a generic "is it free?" is appended by resolveFeature). */
  faq: FaqEntry[];
  /** Keywords (baseline DWEEB keywords are appended by resolveFeature). */
  keywords: string[];
  /** Registry id when this feature is a plugin — cross-links paired templates. */
  pluginId?: string;
  /** Whether the feature needs a Discord bot/app to respond to clicks. */
  requiresBot: boolean;
  /** Template id to render as a live preview + drive the "Open in DWEEB" CTA. */
  previewTemplateId?: string;
  /** Builder deep-link path. Defaults to `?template=<previewTemplateId>` or `/`. */
  appPath?: string;
}

export const FEATURES: FeatureSeo[] = [
  // ── Onboarding & roles ────────────────────────────────────────────────────
  {
    id: "self-role",
    slug: "discord-self-roles",
    emoji: "🎭",
    category: "Onboarding & roles",
    accent: 0x5865f2,
    title: "Discord Self Roles & Reaction Roles — button & menu role bot | DWEEB",
    h1: "Discord Self Roles & Reaction Roles",
    tagline: "Let members give themselves roles from a button or menu.",
    description:
      "Add self-assignable Discord roles from a button or select menu — toggle, give or take, pick-limits, per-role emoji, a role gate and auto-expiring roles. The modern reaction-roles replacement.",
    intro:
      "Self Role lets members pick their own roles straight from a button or a dropdown menu — no emoji reactions, no clutter. It's the modern replacement for old reaction-role bots: a click toggles, grants or removes a role instantly, unlocking the channels and pings each member actually wants. Build the message visually in DWEEB, wire the button or menu to the Self Role plugin, and it just works.",
    howItWorks: [
      {
        name: "Design the message",
        text: "Build a roles menu or verify button in DWEEB — pick the colours, emoji and copy that fit your server.",
      },
      {
        name: "Attach Self Role",
        text: "Wire the button or select menu to the Self Role plugin and map each option to a role on your server.",
      },
      {
        name: "Members self-assign",
        text: "Clicking a button or picking a menu option grants or removes the role on the spot, with a private confirmation.",
      },
    ],
    configurable: [
      "Toggle, give-only or take-only behaviour per component",
      "A pick-limit — set it to 1 for a swap (choosing one role drops the others)",
      "Per-role emoji and short subtitles",
      "A 'who can use this' role gate so only certain members can self-assign",
      "Temporary, auto-expiring roles that lift themselves after a set time",
      "Optional audit logging to a channel via webhook",
    ],
    whenToUse: [
      "Letting members self-assign interest, pronoun or notification roles",
      "Replacing emoji reaction roles with a clean button or menu",
      "Gating your server behind a single verify button",
    ],
    faq: [
      {
        q: "Is this the same as reaction roles?",
        a: "It does the same job — members assign their own roles — but instead of reacting with an emoji, they click a button or pick from a select menu. It's tidier, supports far more roles, and won't break if someone removes the emoji.",
      },
      {
        q: "Do I need a bot for self roles?",
        a: "Yes. Granting a role is a privileged action, so an interactive button or menu needs a Discord bot or app to own the webhook. DWEEB detects this and walks you through pairing the message with the Self Role plugin.",
      },
      {
        q: "Can roles expire automatically?",
        a: "Yes. Self Role supports temporary roles — set a duration and the role lifts itself after that time, which is handy for event access or trial perks.",
      },
    ],
    keywords: [
      "discord self roles",
      "discord reaction roles",
      "discord reaction roles bot",
      "discord role menu",
      "discord role selector",
      "self assign roles discord",
      "discord button roles",
      "discord verify button",
    ],
    pluginId: "self-role",
    requiresBot: true,
    previewTemplateId: "reaction-roles",
  },

  // ── Support ───────────────────────────────────────────────────────────────
  {
    id: "tickets",
    slug: "discord-ticket-bot",
    emoji: "🎫",
    category: "Support",
    accent: 0x3ba55d,
    title: "Discord Ticket Bot — private support tickets from a button | DWEEB",
    h1: "Discord Ticket Bot",
    tagline: "Open a private support ticket from a button or topic menu.",
    description:
      "A Discord ticket system: members open a private support channel from a button or topic menu, with an optional intake form, staff claim and close-with-transcript. Build the panel in DWEEB.",
    intro:
      "Tickets turns a single button into a full support desk. When a member clicks, DWEEB's Tickets plugin spins up a private channel just for them and your staff — no public back-and-forth, no DMs. Add an intake form so people arrive with the details you need, let staff claim a ticket, and close it with a saved transcript. Design the panel visually, then attach the plugin.",
    howItWorks: [
      {
        name: "Build the panel",
        text: "Create a support panel in DWEEB — a button or a topic menu with one option per support category.",
      },
      {
        name: "Attach Tickets",
        text: "Wire it to the Tickets plugin and choose where ticket channels open, who staffs them, and what the intake form asks.",
      },
      {
        name: "Members open tickets",
        text: "A click opens a private channel for that member and your staff. Staff claim it, help, and close it with a transcript.",
      },
    ],
    configurable: [
      "A button panel or a topic menu with several support categories",
      "An optional intake form so members arrive with the details you need",
      "Where ticket channels are created and which staff roles can see them",
      "Staff claim, so it's clear who's handling each ticket",
      "Close with a saved transcript for your records",
    ],
    whenToUse: [
      "Running a support or help-desk channel",
      "Handling private requests without relying on DMs",
      "Organising staff support into per-member channels",
    ],
    faq: [
      {
        q: "Do I need a bot for a ticket system?",
        a: "Yes. Creating channels and managing permissions needs a Discord bot or app, so the button is wired to the Tickets plugin. DWEEB detects the interactive component and helps you pair it.",
      },
      {
        q: "Can members pick a ticket category?",
        a: "Yes. Use a topic menu instead of a single button and each option can open a different kind of ticket — general support, reports, billing and so on — each routed to the right staff.",
      },
      {
        q: "Is a transcript saved when a ticket closes?",
        a: "Yes. Tickets can close with a transcript so you keep a record of what was discussed after the channel is gone.",
      },
    ],
    keywords: [
      "discord ticket bot",
      "discord support tickets",
      "discord ticket system",
      "discord help desk",
      "discord support bot",
      "ticket panel discord",
    ],
    pluginId: "tickets",
    requiresBot: true,
    previewTemplateId: "help-center",
  },
  {
    id: "quick-replies",
    slug: "discord-auto-reply",
    emoji: "💬",
    category: "Support",
    accent: 0x00a8fc,
    title: "Discord Auto-Reply & Canned Responses — FAQ button bot | DWEEB",
    h1: "Discord Auto-Reply & Canned Responses",
    tagline: "Attach canned answers to a button or self-serve FAQ menu.",
    description:
      "Attach canned replies to a Discord button or topic menu — each one sends text, links and {user}/{server} variables, privately or publicly, with optional role-gating. No bot needed.",
    intro:
      "Quick Replies puts your most-repeated answers one click away. Attach a canned response to a button or a topic menu and DWEEB sends it back instantly — server rules, how to get roles, how to reach staff — privately to the person who asked or publicly to the channel. It supports {user} and {server} variables and optional role-gating, and because the replies are plain messages, no bot is required.",
    howItWorks: [
      {
        name: "Write the replies",
        text: "Build a button or a topic menu in DWEEB and write a canned reply for each one — text, links and variables.",
      },
      {
        name: "Attach Quick Replies",
        text: "Wire it to the Quick Replies plugin and choose whether each answer is private or public, and who can use it.",
      },
      {
        name: "Members self-serve",
        text: "A click sends the matching reply straight away — answering the question without anyone on staff lifting a finger.",
      },
    ],
    configurable: [
      "A single button reply or a topic menu of several answers",
      "Private (only the clicker sees it) or public replies",
      "{user} and {server} variables for a personal touch",
      "Optional role-gating so only certain members can trigger a reply",
      "Works with any webhook — no bot required",
    ],
    whenToUse: [
      "Building a self-serve FAQ menu in your support channel",
      "Answering the same questions without staff repeating themselves",
      "Pointing members at rules, roles or how to get help in one click",
    ],
    faq: [
      {
        q: "Do I need a bot for canned replies?",
        a: "No. Quick Replies sends plain messages, so it works through any webhook. A bot is only needed if you want to role-gate who can trigger a reply.",
      },
      {
        q: "Can replies be private?",
        a: "Yes. Each reply can be sent privately, so only the member who clicked sees it — keeping the channel clean.",
      },
    ],
    keywords: [
      "discord auto reply",
      "discord canned responses",
      "discord faq bot",
      "discord auto responder",
      "discord self serve support",
      "discord quick replies",
    ],
    pluginId: "quick-replies",
    requiresBot: false,
    previewTemplateId: "faq",
  },

  // ── Forms & intake ────────────────────────────────────────────────────────
  {
    id: "modal-form",
    slug: "discord-form-bot",
    emoji: "📋",
    category: "Forms & intake",
    accent: 0xf0b232,
    title: "Discord Form Bot — pop-up application & submission forms | DWEEB",
    h1: "Discord Form Bot",
    tagline: "Pop up a form on click and forward the answers to a channel.",
    description:
      "Pop up a Discord form on a button click — staff applications, suggestions, bug reports, ban appeals — and forward the answers to a channel, named or anonymous, with a private reply. One response per person, optionally.",
    intro:
      "Modal Form turns a button into a proper form. Click it and a pop-up modal appears; submit it and the answers are forwarded neatly to a channel of your choice — named or anonymous — while the member gets a private thank-you. It's perfect for staff applications, suggestion boxes, bug reports, member reports and ban appeals, with an optional one-response-per-person limit.",
    howItWorks: [
      {
        name: "Add a button",
        text: "Build a message with a button in DWEEB and write the call-to-action — Apply, Submit a suggestion, Report a bug.",
      },
      {
        name: "Attach Modal Form",
        text: "Wire it to the Modal Form plugin, define the questions, and pick the channel that should receive submissions.",
      },
      {
        name: "Collect submissions",
        text: "Clicking opens a pop-up form. Submissions land in your chosen channel and the member gets a private confirmation.",
      },
    ],
    configurable: [
      "Custom questions in a pop-up modal",
      "Forward answers to any channel — named or anonymous",
      "A private reply to the member who submitted",
      "Optional one-response-per-person limit",
      "Ready-made presets: staff application, suggestion box, bug report, member report, ban appeal, contact form",
    ],
    whenToUse: [
      "Recruiting moderators or staff with an application form",
      "Running a suggestion box or feedback intake",
      "Collecting bug reports, member reports or ban appeals",
    ],
    faq: [
      {
        q: "Do I need a bot for a form?",
        a: "Yes. Pop-up modals are an interactive component, so the button needs a Discord bot or app. DWEEB detects this and helps you pair it with the Modal Form plugin.",
      },
      {
        q: "Can submissions be anonymous?",
        a: "Yes. You choose whether forwarded answers show who submitted them or arrive anonymously — useful for sensitive reports.",
      },
      {
        q: "Can I limit it to one response per person?",
        a: "Yes. Turn on the one-response-per-person option — handy for applications and ban appeals.",
      },
    ],
    keywords: [
      "discord form bot",
      "discord application form",
      "discord modal form",
      "discord staff application bot",
      "discord suggestion box",
      "discord submission form",
    ],
    pluginId: "modal-form",
    requiresBot: true,
  },

  // ── Engagement ────────────────────────────────────────────────────────────
  {
    id: "giveaway",
    slug: "discord-giveaway-bot",
    emoji: "🎉",
    category: "Engagement",
    accent: 0xeb459e,
    title: "Discord Giveaway Bot — one-click button entry & auto draw | DWEEB",
    h1: "Discord Giveaway Bot",
    tagline: "Run a giveaway from a button with a live count and fair draw.",
    description:
      "Run a Discord giveaway from a button: one-click entry, a live entrant count, entry requirements, a fair random draw of N winners, reroll and cancel. Build the giveaway message in DWEEB.",
    intro:
      "Giveaway turns a button into a complete raffle. Members enter in a single tap, the entrant count updates live, and when time's up the plugin draws a fair random winner — or several — automatically. No reactions to tally, no manual picking. Set entry requirements, reroll if you need to, and cancel any time. Design the giveaway message in DWEEB and attach the plugin.",
    howItWorks: [
      {
        name: "Design the giveaway",
        text: "Build a giveaway message in DWEEB — prize, end time and an Enter button. The entrant count and winners fill themselves in.",
      },
      {
        name: "Attach Giveaway",
        text: "Wire the button to the Giveaway plugin and set the prize, number of winners and any entry requirements.",
      },
      {
        name: "Draw a winner",
        text: "Members enter in one click. When the timer ends, a fair winner is drawn automatically — reroll or cancel if you need to.",
      },
    ],
    configurable: [
      "One-click button entry with a live entrant count",
      "Entry requirements — a required role, minimum account age, one entry per person",
      "Any number of winners, drawn fairly at random",
      "Reroll to pick a fresh winner",
      "Cancel a giveaway before it ends",
    ],
    whenToUse: [
      "Hosting a prize giveaway or raffle",
      "Boosting engagement with one-click entry",
      "Drawing a fair winner without counting reactions",
    ],
    faq: [
      {
        q: "Do I need a bot for a giveaway?",
        a: "Yes. Tracking entries and drawing a winner needs a Discord bot or app, so the Enter button is wired to the Giveaway plugin. DWEEB detects the interactive button and helps you pair it.",
      },
      {
        q: "Can I require a role to enter?",
        a: "Yes. Set entry requirements such as a required role, a minimum account age, or one entry per person to keep it fair.",
      },
      {
        q: "Can I draw more than one winner?",
        a: "Yes. Choose how many winners to draw, and reroll if you need to replace one.",
      },
    ],
    keywords: [
      "discord giveaway bot",
      "discord giveaway",
      "discord raffle bot",
      "discord prize draw",
      "giveaway message discord",
      "discord giveaway button",
    ],
    pluginId: "giveaway",
    requiresBot: true,
    previewTemplateId: "giveaway-button",
  },

  // ── Utilities ─────────────────────────────────────────────────────────────
  {
    id: "picker",
    slug: "discord-select-menu",
    emoji: "🔎",
    category: "Utilities",
    accent: 0x5865f2,
    title: "Discord Select Menus — user, role, channel pickers & directory | DWEEB",
    h1: "Discord Select-Menu Picker",
    tagline: "Turn user, role, mentionable and channel selects into a directory.",
    description:
      "Attach to a Discord User, Role, Mentionable or Channel select menu and a member's picks come back as clickable mentions in a private confirmation — the basis of a searchable server directory. No bot needed.",
    intro:
      "Picker brings Discord's auto-populated select menus to life. Attach it to a User, Role, Mentionable or Channel select and whatever a member picks comes straight back as clickable mentions in a private reply — the building block for a searchable server directory. All four native select types work together in one message, and because the result is a plain reply, no bot is required.",
    howItWorks: [
      {
        name: "Add a select menu",
        text: "Drop a User, Role, Mentionable or Channel select into your message in DWEEB.",
      },
      {
        name: "Attach Picker",
        text: "Wire the select to the Picker plugin — there's nothing to configure, it just confirms the picks.",
      },
      {
        name: "Members look things up",
        text: "A member's selection comes back as private, clickable mentions — a self-serve way to find channels, roles or people.",
      },
    ],
    configurable: [
      "Works with all four auto-populated selects: User, Role, Mentionable, Channel",
      "Picks come back as clickable mentions",
      "Private confirmation, visible only to whoever selected",
      "No configuration and no bot needed",
    ],
    whenToUse: [
      "Giving a big server a single 'find anything' directory",
      "Helping members locate channels, roles or people",
      "Showcasing every Discord select-menu type in one message",
    ],
    faq: [
      {
        q: "Do I need a bot for select menus?",
        a: "No. Picker replies with a plain confirmation message, so it works through any webhook. The auto-populated selects are filled by Discord itself.",
      },
      {
        q: "Which select types are supported?",
        a: "All four that Discord auto-populates: User, Role, Mentionable and Channel selects.",
      },
    ],
    keywords: [
      "discord select menu",
      "discord channel picker",
      "discord role picker",
      "discord user select",
      "discord server directory",
      "discord dropdown menu",
    ],
    pluginId: "picker",
    requiresBot: false,
    previewTemplateId: "server-directory",
  },
  {
    id: "ping-pong",
    slug: "discord-latency-check",
    emoji: "📡",
    category: "Utilities",
    accent: 0x949ba4,
    title: "Discord Latency Check — measure bot response time | DWEEB",
    h1: "Discord Latency Check",
    tagline: "A button that reports round-trip latency in detail.",
    description:
      "A Discord latency-check button: click it for a detailed response-time report — click to server, dispatcher hop and handler time. A simple way to confirm your interactions stack is healthy.",
    intro:
      "Latency Check is a diagnostic button. Click it and it replies with a detailed breakdown of how long each hop took — from the click reaching the server, through the dispatcher, to the handler responding. It's a quick, honest way to confirm your DWEEB interactions stack is wired up and healthy.",
    howItWorks: [
      {
        name: "Add a button",
        text: "Drop a button into a message in DWEEB and label it something like 'Check latency'.",
      },
      {
        name: "Attach Latency Check",
        text: "Wire the button to the Latency Check plugin — there's nothing to configure.",
      },
      {
        name: "Read the report",
        text: "Clicking replies with a per-hop latency breakdown so you can confirm everything's responding.",
      },
    ],
    configurable: [
      "A per-hop latency breakdown (click → server, dispatcher, handler)",
      "Nothing to configure — attach and go",
    ],
    whenToUse: [
      "Confirming your interactions stack is wired up correctly",
      "Spot-checking response time after a deploy",
    ],
    faq: [
      {
        q: "Do I need a bot for this?",
        a: "Yes. Measuring handler time requires a Discord bot or app to receive the click, so the button is wired to the Latency Check plugin.",
      },
    ],
    keywords: [
      "discord latency check",
      "discord bot ping",
      "discord response time",
      "discord interaction latency",
    ],
    pluginId: "ping-pong",
    requiresBot: true,
  },

  // ── Publishing (core features, not plugins) ───────────────────────────────
  {
    id: "scheduled-posts",
    slug: "schedule-discord-messages",
    emoji: "🗓️",
    category: "Publishing",
    accent: 0x3ba55d,
    title: "Schedule Discord Messages — post a webhook message later | DWEEB",
    h1: "Schedule Discord Messages",
    tagline: "Build a message now and have DWEEB post it later.",
    description:
      "Schedule a Discord webhook message to post later. Build it visually in DWEEB, pick a time, and it sends itself — with a per-server list of upcoming posts you can manage. No bot or always-on host needed.",
    intro:
      "Build your announcement, event or reminder now and let DWEEB post it at the right moment. The Send panel has a 'Send now / Schedule' toggle: pick a future time and the message is queued and delivered for you, even with your browser closed. Each server gets a list of its upcoming scheduled posts so you can see and manage what's coming — all without running a bot or hosting anything yourself.",
    howItWorks: [
      {
        name: "Build the message",
        text: "Design your message in DWEEB exactly as you want it to go out — text, components and all.",
      },
      {
        name: "Pick a time",
        text: "In the Send panel, switch to Schedule and choose when it should post. The Send button becomes 'Schedule post'.",
      },
      {
        name: "DWEEB sends it",
        text: "The message is delivered at the time you picked, even with your browser closed. Manage upcoming posts from the per-server list.",
      },
    ],
    configurable: [
      "A 'Send now / Schedule' toggle right in the Send panel",
      "A per-server list of upcoming scheduled posts",
      "Edit or cancel a scheduled post before it fires",
      "Optionally make a scheduled post never-expire when it sends",
      "Drafts are sealed at rest — your content stays private until it posts",
    ],
    whenToUse: [
      "Lining up an announcement for a specific time or timezone",
      "Scheduling event reminders ahead of time",
      "Posting while you're away, without an always-on bot",
    ],
    faq: [
      {
        q: "Do I need a bot to schedule a message?",
        a: "No. DWEEB queues and sends the message for you through your webhook — there's no bot to run and nothing to keep online on your end.",
      },
      {
        q: "Will it send if my browser is closed?",
        a: "Yes. Once a post is scheduled, DWEEB delivers it at the chosen time regardless of whether your browser is open.",
      },
      {
        q: "Can I edit or cancel a scheduled post?",
        a: "Yes. Each server has a list of its upcoming posts where you can change the time, edit the message, or cancel it before it fires.",
      },
    ],
    keywords: [
      "schedule discord message",
      "discord scheduled messages",
      "discord scheduled posts",
      "schedule discord webhook",
      "discord message scheduler",
      "post discord message later",
    ],
    requiresBot: false,
    previewTemplateId: "announcement",
    appPath: "/?template=announcement",
  },
  {
    id: "webhook-manager",
    slug: "discord-webhook-manager",
    emoji: "🪝",
    category: "Publishing",
    accent: 0x00a8fc,
    title: "Discord Webhook Manager — create, reuse & manage webhooks | DWEEB",
    h1: "Discord Webhook Manager",
    tagline: "Pick a channel and DWEEB finds or creates the webhook for you.",
    description:
      "Manage your Discord webhooks from DWEEB: pick a channel and it reuses or creates the right webhook automatically, then list, edit, delete or purge them — all gated on your own Manage Webhooks permission.",
    intro:
      "Stop hunting through Server Settings for webhook URLs. DWEEB's webhook manager is channel-first: pick a channel and it automatically reuses an existing webhook or creates a fresh one for you, deduplicated so you don't pile up copies. From there you can list, edit, delete or purge webhooks behind a clear disclosure. Everything is gated on your own Manage Webhooks permission, so you only ever touch what you're allowed to.",
    howItWorks: [
      {
        name: "Connect your server",
        text: "Sign in with Discord and pick the server you want to post to.",
      },
      {
        name: "Pick a channel",
        text: "Choose a channel and DWEEB reuses an existing webhook or creates one automatically — no copy-pasting URLs.",
      },
      {
        name: "Manage as needed",
        text: "List, rename, delete or purge webhooks from a disclosure, all scoped to your own Manage Webhooks permission.",
      },
    ],
    configurable: [
      "Channel-first sending — DWEEB reuses or creates the webhook for you",
      "Automatic de-duplication so you don't accumulate copies",
      "List, rename, delete and purge webhooks",
      "Restore a message a webhook previously posted and edit it in place",
      "Gated on your own Manage Webhooks permission",
    ],
    whenToUse: [
      "Posting to a channel without digging for a webhook URL",
      "Cleaning up duplicate or stale webhooks",
      "Managing webhooks across a busy server",
    ],
    faq: [
      {
        q: "Does DWEEB create the webhook for me?",
        a: "Yes. Pick a channel and DWEEB reuses a matching webhook or creates one automatically, so you never have to copy a URL out of Server Settings.",
      },
      {
        q: "What permission do I need?",
        a: "The webhook manager is gated on your own Manage Webhooks permission for the server, so you can only act on channels you're allowed to.",
      },
    ],
    keywords: [
      "discord webhook manager",
      "manage discord webhooks",
      "create discord webhook",
      "discord webhook tool",
      "discord webhook url",
      "delete discord webhook",
    ],
    requiresBot: false,
    appPath: "/",
  },
  {
    id: "ai-assistant",
    slug: "ai-discord-message-writer",
    emoji: "✨",
    category: "Publishing",
    accent: 0xc9659a,
    title: "AI Discord Message Writer — generate Components V2 messages | DWEEB",
    h1: "AI Discord Message Writer",
    tagline: "Describe what you want and let the assistant draft it.",
    description:
      "Describe the Discord message you want and DWEEB's AI assistant drafts it as Components V2 — containers, sections, buttons and media — ready to refine in the visual editor and send through a webhook.",
    intro:
      "Not sure where to start? Tell DWEEB's AI assistant what you're after — 'a welcome message with a banner and three get-started steps', 'an event announcement with RSVP buttons' — and it drafts a complete Components V2 message for you. The result drops straight into the visual editor, where you tweak the wording, colours and links before sending. It's the fastest way from idea to a polished message.",
    howItWorks: [
      {
        name: "Describe it",
        text: "Open the AI assistant and describe the message you want in plain language.",
      },
      {
        name: "Get a draft",
        text: "The assistant builds it as a Components V2 message — containers, sections, buttons and media — in the editor.",
      },
      {
        name: "Refine and send",
        text: "Adjust the copy, colours and links in the visual editor, then send it through your webhook.",
      },
    ],
    configurable: [
      "Generate a full Components V2 message from a plain-language prompt",
      "Drafts land in the visual editor for you to refine",
      "Iterate by asking for changes",
      "Everything stays editable — nothing is locked",
    ],
    whenToUse: [
      "Starting a message from a blank canvas",
      "Drafting an announcement or welcome quickly",
      "Exploring layouts before committing",
    ],
    faq: [
      {
        q: "Does the AI send anything to Discord by itself?",
        a: "No. The assistant only drafts the message into the editor. Nothing is posted until you review it and hit Send through your webhook.",
      },
      {
        q: "Can I edit what the AI produces?",
        a: "Yes. Everything the assistant makes is a normal DWEEB message — every word, colour and link stays fully editable.",
      },
    ],
    keywords: [
      "ai discord message",
      "discord message generator",
      "ai discord embed generator",
      "discord components v2 generator",
      "generate discord message",
    ],
    requiresBot: false,
    appPath: "/",
  },
];

/** Fully resolved, render-ready SEO data for one feature. */
export interface ResolvedFeature extends FeatureSeo {
  path: string;
  url: string;
  appUrl: string;
  ogImage: string;
  /** Keywords merged with baseline DWEEB keywords. */
  resolvedKeywords: string[];
  /** FAQ with the generic "is it free?" appended. */
  resolvedFaq: FaqEntry[];
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function resolveFeature(f: FeatureSeo): ResolvedFeature {
  const path = `/features/${f.slug}/`;
  const appUrl = `${SITE.origin}${
    f.appPath ?? (f.previewTemplateId ? `/?template=${encodeURIComponent(f.previewTemplateId)}` : "/")
  }`;

  const resolvedKeywords = uniq(
    [
      ...f.keywords,
      f.h1,
      "discord",
      "discord webhook",
      "discord components v2",
      "dweeb",
    ].map((k) => k.toLowerCase()),
  );

  const resolvedFaq: FaqEntry[] = [
    ...f.faq,
    {
      q: "Is DWEEB free?",
      a: "Yes. DWEEB's visual builder is free and needs no account. Build your message, attach the feature, and send it through a webhook; optional connected services process the data required by the feature.",
    },
  ];

  return {
    ...f,
    path,
    url: `${SITE.origin}${path}`,
    appUrl,
    ogImage: `${SITE.origin}/features-og/${f.slug}.png`,
    resolvedKeywords,
    resolvedFaq,
  };
}

/** Resolve every feature, in declared order. */
export function resolveAllFeatures(): ResolvedFeature[] {
  return FEATURES.map(resolveFeature);
}

/** Last time the feature catalogue was reviewed — used for sitemap `<lastmod>`. */
export const FEATURES_LASTMOD = "2026-06-26";

export { ACCENT_BLURPLE };
