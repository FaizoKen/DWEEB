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
  /** Whether the feature needs a server bot install beyond an app-owned webhook. */
  requiresBot: boolean;
  /** Optional prerequisite shown prominently beside the delivery-mode setup. */
  setupNote?: { badge: string; title: string; text: string };
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
    title: "Discord Self Roles: Button & Dropdown Role Menu | DWEEB",
    h1: "Discord Self Roles & Reaction Roles",
    tagline: "Let members give themselves roles from a button or menu.",
    description:
      "Build a Discord self-role button or dropdown with pick limits, role gates and expiring roles—a modern, visual replacement for reaction roles.",
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
    title: "Discord Ticket Bot: Private Support Panels | DWEEB",
    h1: "Discord Ticket Bot",
    tagline: "Open a private support ticket from a button or topic menu.",
    description:
      "Build a Discord ticket panel that opens private support channels with intake forms, staff claiming and close-with-transcript workflows.",
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
    title: "Discord FAQ Button & Canned Reply Tool | DWEEB",
    h1: "Discord Auto-Reply & Canned Responses",
    tagline: "Attach canned answers to a button or self-serve FAQ menu.",
    description:
      "Build a self-serve Discord FAQ button or menu with private or public canned replies, variables and optional role gating—no bot hosting required.",
    intro:
      "Quick Replies puts your most-repeated answers one click away. Attach a canned response to a button or topic menu and DWEEB returns it instantly—server rules, how to get roles, or how to reach staff—privately or publicly. DWEEB's hosted app handles the click through an app-owned webhook, so you install no server bot and host no code yourself.",
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
      "DWEEB-hosted interaction handling—no bot installation or hosting",
    ],
    whenToUse: [
      "Building a self-serve FAQ menu in your support channel",
      "Answering the same questions without staff repeating themselves",
      "Pointing members at rules, roles or how to get help in one click",
    ],
    faq: [
      {
        q: "Do I need a bot for canned replies?",
        a: "You do not install or host a bot. Discord still requires an app-owned webhook for an interactive button; DWEEB creates the compatible destination and hosts the reply handler for you.",
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
    previewTemplateId: "help-center",
  },

  // ── Forms & intake ────────────────────────────────────────────────────────
  {
    id: "modal-form",
    slug: "discord-form-bot",
    emoji: "📋",
    category: "Forms & intake",
    accent: 0xf0b232,
    title: "Discord Form Bot for Applications & Suggestions | DWEEB",
    h1: "Discord Form Bot",
    tagline: "Pop up a form on click and forward the answers to a channel.",
    description:
      "Create Discord pop-up forms for applications, suggestions and reports, then forward named or anonymous submissions to a channel.",
    intro:
      "Modal Form turns a button into a proper form. Click it and a pop-up modal appears; submit it and the answers are forwarded neatly to a channel of your choice — named or anonymous — while the member gets a private thank-you. DWEEB's hosted app handles the interaction through an app-owned webhook, so you do not install or host a server bot.",
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
        a: "You do not install or host a server bot. Discord requires an app-owned webhook for the interactive button; DWEEB creates that destination and its hosted Modal Form plugin handles the modal and submissions.",
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
    requiresBot: false,
    previewTemplateId: "staff-apps",
  },

  // ── Engagement ────────────────────────────────────────────────────────────
  {
    id: "giveaway",
    slug: "discord-giveaway-bot",
    emoji: "🎉",
    category: "Engagement",
    accent: 0xeb459e,
    title: "Discord Giveaway Bot with Button Entry | DWEEB",
    h1: "Discord Giveaway Bot",
    tagline: "Run a giveaway from a button with a live count and fair draw.",
    description:
      "Build a Discord giveaway with one-click button entry, live counts, eligibility rules, automatic winner draws, rerolls and cancellation.",
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
        a: "The core entry, count and draw flow needs no server bot install or self-hosting. DWEEB's hosted Giveaway plugin handles the button through an app-owned webhook. Optional role-based eligibility depends on the guided server integration being available.",
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
    requiresBot: false,
    previewTemplateId: "giveaway-button",
  },

  // ── Utilities ─────────────────────────────────────────────────────────────
  {
    id: "picker",
    slug: "discord-select-menu",
    emoji: "🔎",
    category: "Utilities",
    accent: 0x5865f2,
    title: "Discord Select Menu Builder & Server Directory | DWEEB",
    h1: "Discord Select-Menu Picker",
    tagline: "Turn user, role, mentionable and channel selects into a directory.",
    description:
      "Build Discord user, role, mentionable and channel select menus that return private clickable results—a visual server-directory foundation.",
    intro:
      "Picker brings Discord's auto-populated select menus to life. Attach it to a User, Role, Mentionable or Channel select and a member's choice comes back as clickable mentions in a private reply—the building block for a searchable server directory. DWEEB's hosted app handles the interaction through an app-owned webhook, with no server bot install or code to host.",
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
      "No configuration, server bot install or self-hosting",
    ],
    whenToUse: [
      "Giving a big server a single 'find anything' directory",
      "Helping members locate channels, roles or people",
      "Showcasing every Discord select-menu type in one message",
    ],
    faq: [
      {
        q: "Do I need a bot for select menus?",
        a: "You do not install or host a bot. Discord fills the menu, while DWEEB's hosted app receives the interaction through an app-owned webhook and returns the private confirmation.",
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
    title: "Discord Bot Latency Check & Response Timer | DWEEB",
    h1: "Discord Latency Check",
    tagline: "A button that reports round-trip latency in detail.",
    description:
      "Add a Discord latency-check button that reports click-to-server, dispatcher and handler timing so you can verify an interaction stack.",
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
        a: "You do not install or host a server bot. DWEEB's hosted app receives the click through an app-owned webhook and the Latency Check plugin returns the timing report.",
      },
    ],
    keywords: [
      "discord latency check",
      "discord bot ping",
      "discord response time",
      "discord interaction latency",
    ],
    pluginId: "ping-pong",
    requiresBot: false,
  },

  // ── Publishing (core features, not plugins) ───────────────────────────────
  {
    id: "scheduled-posts",
    slug: "schedule-discord-messages",
    emoji: "🗓️",
    category: "Publishing",
    accent: 0x3ba55d,
    title: "Schedule Discord Messages by Webhook | DWEEB",
    h1: "Schedule Discord Messages",
    tagline: "Build a message now and have DWEEB post it later.",
    description:
      "Schedule a Discord webhook message for later. Build it visually, choose a time, and manage upcoming posts—no always-on bot or browser required.",
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
    appPath: "/?template=announcement&intent=schedule",
  },
  {
    id: "webhook-manager",
    slug: "discord-webhook-manager",
    emoji: "🪝",
    category: "Publishing",
    accent: 0x00a8fc,
    title: "Discord Webhook Manager: Create, Edit & Delete | DWEEB",
    h1: "Discord Webhook Manager",
    tagline: "Pick a channel and DWEEB finds or creates the webhook for you.",
    description:
      "Create, reuse, rename and delete Discord webhooks by channel in DWEEB, gated by your own Manage Webhooks permission.",
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
    appPath: "/?intent=manage-webhooks",
  },
  {
    id: "ai-assistant",
    slug: "ai-discord-message-writer",
    emoji: "✨",
    category: "Publishing",
    accent: 0xc9659a,
    title: "AI Discord Message Generator for Components V2 | DWEEB",
    h1: "AI Discord Message Writer",
    tagline: "Describe what you want and let the assistant draft it.",
    description:
      "Use your own AI provider or Ollama endpoint to draft editable Discord Components V2 messages directly in DWEEB's visual editor.",
    intro:
      "Not sure where to start? Connect your own AI provider or local Ollama endpoint, then tell DWEEB's assistant what you're after — 'a welcome message with a banner and three get-started steps' or 'an event announcement with RSVP buttons'. The draft drops into the visual editor, where every word, colour and link stays editable before sending.",
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
        q: "What do I need to use the AI writer?",
        a: "Bring an API key for Groq, OpenAI, Anthropic, Google Gemini or OpenRouter, or connect an OpenAI-compatible endpoint. A local Ollama endpoint can be used without a key. The key stays in your browser and requests go directly to the provider you choose.",
      },
      {
        q: "Does the AI send anything to Discord by itself?",
        a: "No. The assistant only drafts the message into the editor. Nothing is posted until you review it and hit Send through your webhook.",
      },
      {
        q: "Can I edit what the AI produces?",
        a: "Yes. Everything the assistant makes is a normal DWEEB message — every word, colour and link stays fully editable.",
      },
    ],
    setupNote: {
      badge: "Bring your own AI provider",
      title: "Connect a provider before generating.",
      text: "Choose Groq, OpenAI, Anthropic, Google Gemini, OpenRouter, an OpenAI-compatible endpoint or local Ollama. Most need your own API key; Ollama can be keyless. DWEEB stores the setting only in this browser and sends prompts directly to that provider.",
    },
    keywords: [
      "ai discord message",
      "discord message generator",
      "ai discord embed generator",
      "discord components v2 generator",
      "generate discord message",
    ],
    requiresBot: false,
    appPath: "/?intent=ai",
  },
];

/** Fully resolved, render-ready SEO data for one feature. */
export interface ResolvedFeature extends FeatureSeo {
  path: string;
  url: string;
  appUrl: string;
  ogImage: string;
  /** What Discord destination/handler the feature actually needs. */
  deliveryMode: "plain" | "app-owned" | "bot-install";
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
  const baseAppPath =
    f.appPath ??
    (f.previewTemplateId ? `/?template=${encodeURIComponent(f.previewTemplateId)}` : "/");
  const appPath =
    f.pluginId && f.previewTemplateId
      ? `${baseAppPath}${baseAppPath.includes("?") ? "&" : "?"}setup=${encodeURIComponent(f.pluginId)}`
      : baseAppPath;
  const separator = appPath.includes("?") ? "&" : "?";
  const appUrl = `${SITE.origin}${appPath}${separator}entry=${encodeURIComponent(`feature:${f.slug}`)}`;

  const resolvedKeywords = uniq(
    [...f.keywords, f.h1, "discord", "discord webhook", "discord components v2", "dweeb"].map((k) =>
      k.toLowerCase(),
    ),
  );

  const deliveryMode = f.requiresBot ? "bot-install" : f.pluginId ? "app-owned" : "plain";
  const freeAnswer =
    deliveryMode === "bot-install"
      ? "Yes. Build the message for free, then follow the guided app installation and plugin setup. Plans only raise per-server quotas; they do not lock this feature."
      : deliveryMode === "app-owned"
        ? "Yes. Build the message for free and let DWEEB create a compatible app-owned destination for the hosted interaction. No server bot install or self-hosting is required."
        : "Yes. DWEEB's visual builder is free and needs no account. Optional connected services and plans only add server-backed capacity; they do not lock the feature.";

  const resolvedFaq: FaqEntry[] = [
    ...f.faq,
    {
      q: "Is DWEEB free?",
      a: freeAnswer,
    },
  ];

  return {
    ...f,
    path,
    url: `${SITE.origin}${path}`,
    appUrl,
    ogImage: `${SITE.origin}/features-og/${f.slug}.png`,
    deliveryMode,
    resolvedKeywords,
    resolvedFaq,
  };
}

/** Resolve every feature, in declared order. */
export function resolveAllFeatures(): ResolvedFeature[] {
  return FEATURES.map(resolveFeature);
}

/** Last time the feature catalogue was reviewed — used for sitemap `<lastmod>`. */
export const FEATURES_LASTMOD = "2026-07-15";

export { ACCENT_BLURPLE };
