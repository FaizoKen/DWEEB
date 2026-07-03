/**
 * SEO copy for the static template pages.
 *
 * This is the one place to edit per-template marketing/SEO content. It's
 * **build-only** — never imported by the app — so the longform copy and FAQs
 * add nothing to the shipped bundle. Each entry is keyed by the template's
 * stable `id` (see `src/data/presets.ts`); `resolveSeo()` merges it with sensible
 * derived defaults (keywords from the template's tags, a "needs a bot?" FAQ from
 * its `requiresBot` flag, the component inventory from the message itself).
 *
 * Adding a template? Add its message + metadata in `presets.ts`, then add an
 * entry here. The generator THROWS if a template has no entry — that's
 * deliberate: it stops a thin, auto-stubbed page from shipping by accident.
 */

import { TEMPLATES, type MessageTemplate } from "@/data/presets";
import { collectComponentKinds } from "./render-message";

/** Production origin — keep in sync with `index.html` canonical / sitemap. */
export const SITE = {
  origin: "https://dweeb.faizo.net",
  name: "DWEEB",
  ogImage: "https://dweeb.faizo.net/og-image.png",
  orgId: "https://faizo.net/#organization",
  githubUrl: "https://github.com/FaizoKen/DWEEB",
} as const;

/**
 * Last time the template catalogue was reviewed, as an ISO date. Used for
 * sitemap `<lastmod>` on the template pages. Bump it when you add or
 * meaningfully revise templates — keeping it stable (rather than "now" on every
 * deploy) avoids signalling false freshness to search engines.
 */
export const TEMPLATES_LASTMOD = "2026-07-03";

export interface FaqEntry {
  q: string;
  a: string;
}

/** Hand-written SEO fields for one template. */
export interface TemplateSeoOverride {
  /** URL slug — the page lives at `/templates/<slug>/`. Keyword-led. */
  slug: string;
  /** `<title>` + `og:title`. Lead with the target keyword. */
  title: string;
  /** On-page `<h1>`. */
  h1: string;
  /** Meta description + `og:description` (~150–160 chars). */
  description: string;
  /** Opening paragraph(s) — the unique, substantive copy that earns the page. */
  intro: string;
  /** "When to use it" bullets. */
  whenToUse: string[];
  /** Optional extra tips, shown before the auto-generated ones. */
  tips?: string[];
  /** Optional extra FAQ entries, shown before the auto-generated ones. */
  faq?: FaqEntry[];
  /** Optional extra keywords, merged with the ones derived from tags. */
  keywords?: string[];
}

/** Per-category blurb for the `/templates` index page. */
export const CATEGORY_BLURB: Record<string, string> = {
  Featured: "Hand-picked starting points and a full tour of the editor.",
  Welcome: "Greet new members, lay down the rules, and gate access.",
  Community: "Announcements, changelogs, intros, role menus, suggestions and staff applications.",
  Events: "Events, polls and giveaways that drive engagement.",
  Support: "Help desks and FAQs that cut repeat questions.",
  Commerce: "Product cards and pricing tables for selling in your server.",
  Fun: "Link hubs and spotlights to round out your community.",
};

export const TEMPLATE_SEO: Record<string, TemplateSeoOverride> = {
  showcase: {
    slug: "discord-components-v2-example",
    title: "Discord Components V2 Example — every block in one message | DWEEB",
    h1: "Discord Components V2 Example Message",
    description:
      "A free Discord Components V2 example showing every building block — containers, sections, buttons, media galleries and more. Open it in DWEEB and customize.",
    intro:
      "This Components V2 showcase packs every block DWEEB gives you into one message — containers, sections, formatted text, buttons, a media gallery and separators — so you can see exactly how Discord's new layout system fits together. It's the fastest way to learn the editor: open it, click any block, and watch the live preview update.",
    whenToUse: [
      "You're new to Discord's Components V2 and want a working reference",
      "You want a starting canvas with every block already wired up",
      "You're deciding which components to use for a richer message",
    ],
  },
  welcome: {
    slug: "discord-welcome-message",
    title: "Discord Welcome Message Template — free, no bot needed | DWEEB",
    h1: "Discord Welcome Message Template",
    description:
      "A clean Discord welcome message template with a banner and a 3-step get-started guide. Free, no bot required — customize it and send through any webhook.",
    intro:
      "Greet every new member with a polished welcome message instead of a wall of text. This template leads with a banner image, then points newcomers straight to your rules, roles and general chat in three quick steps — everything they need to settle in fast.",
    whenToUse: [
      "Posting a warm intro in your #welcome channel",
      "Onboarding new members with a clear first action",
      "Replacing a plain-text greeting with a branded card",
    ],
  },
  rules: {
    slug: "discord-server-rules-template",
    title: "Discord Server Rules Template — clean & numbered | DWEEB",
    h1: "Discord Server Rules Template",
    description:
      "A clear, numbered Discord rules template with a consequences note. Free and no bot needed — edit the rules, preview live, and post through any webhook.",
    intro:
      "Lay out your community's rules so they actually get read. This template gives you a clean, numbered rulebook inside an accent container, with a short note on what happens when the rules are broken — easy to scan, easy to enforce, easy to pin.",
    whenToUse: [
      "Pinning the rules in your #rules channel",
      "Standardizing conduct before members get access",
      "Refreshing an old rules post into something readable",
    ],
  },
  "channel-guide": {
    slug: "discord-channel-guide-template",
    title: "Discord Channel Guide Template — map your server | DWEEB",
    h1: "Discord Channel Guide Template",
    description:
      "A Discord channel guide template that maps where everything lives so newcomers don't get lost. Free, no bot — customize the channels and post via webhook.",
    intro:
      "Help new members find their way around with a quick map of your server. This guide groups your channels by purpose — start here, hang out, get help — so people know exactly where to go instead of guessing or asking.",
    whenToUse: [
      "Orienting new members right after they join",
      "Cutting down on 'where do I post this?' questions",
      "Pairing with your welcome and rules messages",
    ],
  },
  verify: {
    slug: "discord-verification-message",
    title: "Discord Verification Message — one-click verify button | DWEEB",
    h1: "Discord Verification Gate Template",
    description:
      "A one-click Discord verification message: members tap a button to confirm they're human and unlock the server. Pairs with the Self Role plugin.",
    intro:
      "Gate your server behind a single verify button. New members tap it to confirm they've read the rules and unlock the rest of the channels — a simple, friendly check that keeps bots and drive-by trolls out without the friction of a captcha.",
    whenToUse: [
      "Adding a human check before granting access",
      "Confirming members have read the rules",
      "Running a lightweight alternative to a captcha bot",
    ],
  },
  announcement: {
    slug: "discord-announcement-template",
    title: "Discord Announcement Template — bold image banner | DWEEB",
    h1: "Discord Announcement Template",
    description:
      "A bold, image-led Discord announcement template for big news and updates. Free, no bot needed — customize the banner and links and post through any webhook.",
    intro:
      "Make important news impossible to miss. This borderless announcement leads with a banner image, sums up what's new in a few highlights, and gives readers buttons to read the full post or jump into the discussion — built to stand out in a busy channel.",
    whenToUse: [
      "Announcing updates, launches or events",
      "Posting a broadcast that needs to stand out",
      "Sharing news with a clear call-to-action link",
    ],
  },
  "patch-notes": {
    slug: "discord-changelog-template",
    title: "Discord Changelog & Patch Notes Template | DWEEB",
    h1: "Discord Patch Notes Template",
    description:
      "A tidy Discord changelog template with New / Improved / Fixed sections. Free, no bot — edit your release notes, preview live, and post through any webhook.",
    intro:
      "Ship release notes your community can actually skim. This patch-notes template splits changes into New, Improved and Fixed sections inside a clean container, with a link to the full changelog — perfect for game updates, bot releases or product news.",
    whenToUse: [
      "Posting version updates or release notes",
      "Sharing a changelog for a bot, game or app",
      "Keeping members informed of what changed",
    ],
  },
  introductions: {
    slug: "discord-introductions-template",
    title: "Discord Introductions Template — one-tap intro form | DWEEB",
    h1: "Discord Introductions Template",
    description:
      "A Discord introductions template with a button that pops an intro form and posts each new member's answers to the channel. Pairs with the Modal Form plugin.",
    intro:
      "Turn a quiet #introductions channel into a lively one. Instead of asking newcomers to copy and fill in a wall of text, this template gives them one button: tap it, fill in a short pop-up form — name, where they're from, what brought them here — and their intro posts straight to the channel so everyone can say hi. Less friction means more people actually introduce themselves, and every intro reads in the same tidy format.",
    whenToUse: [
      "Encouraging new members to say hello",
      "Setting a consistent format for intros",
      "Breaking the ice in a growing community",
    ],
    keywords: ["introduction form", "member intro", "icebreaker", "modal form"],
  },
  "reaction-roles": {
    slug: "discord-reaction-roles-menu",
    title: "Discord Reaction Roles Menu — self-assign roles | DWEEB",
    h1: "Discord Reaction Roles Menu Template",
    description:
      "A Discord reaction roles menu: members self-assign roles by interest from a dropdown. Pairs with the Self Role plugin — customize the options and post.",
    intro:
      "Let members pick their own roles from a clean dropdown menu. Choosing an option instantly grants the matching role, unlocking the channels and pings they care about — the modern button-and-menu replacement for old emoji reaction roles.",
    whenToUse: [
      "Letting members self-assign interest or pronoun roles",
      "Replacing emoji reaction roles with a tidy menu",
      "Unlocking channels and pings by choice",
    ],
    keywords: ["self roles", "role selector", "role picker", "self assign roles"],
  },
  "server-directory": {
    slug: "discord-server-directory-template",
    title: "Discord Server Directory — find any channel, role or member | DWEEB",
    h1: "Discord Server Directory Template",
    description:
      "A Discord server directory in one message: search channels, roles and members from select menus and get private, clickable results. Pairs with the Picker plugin.",
    intro:
      "Turn one message into a searchable directory for your whole server. Members open a menu to look up any channel, role or member and get a private list of clickable mentions back — all four auto-populated Discord select types working together in a single post.",
    whenToUse: [
      "Giving a big server a single 'find anything' hub",
      "Helping members locate channels, roles and people",
      "Showcasing every Discord select-menu type at once",
    ],
  },
  suggestions: {
    slug: "discord-suggestion-box-template",
    title: "Discord Suggestion Box Template — pop-up idea form | DWEEB",
    h1: "Discord Suggestion Box Template",
    description:
      "A Discord suggestion box with a share-an-idea button that opens a pop-up form and forwards each idea to your team. Pairs with the Modal Form plugin.",
    intro:
      "Collect ideas without the chaos of an open #suggestions channel. Members tap one button, fill in a short pop-up form — what the idea is and why it helps — and the structured submission lands in the channel you choose, while they get a private thank-you. No half-written ideas, no drive-by spam, no digging through replies.",
    whenToUse: [
      "Replacing a messy #suggestions channel with structured submissions",
      "Collecting feature requests for your community, game or product",
      "Routing member ideas privately to a staff review channel",
    ],
    keywords: ["suggestion form", "feedback form", "idea box", "modal form"],
  },
  "staff-apps": {
    slug: "discord-staff-application-template",
    title: "Discord Staff Application Template — pop-up form, one per person | DWEEB",
    h1: "Discord Staff Application Template",
    description:
      "A Discord staff application template: a recruitment panel whose Apply button opens a pop-up questionnaire, limited to one application per person. Pairs with Modal Form.",
    intro:
      "Recruit moderators the organised way. This panel pitches the role — what you look for, what applicants get — and its Apply button opens a full pop-up questionnaire: name, timezone, availability, experience and motivation. Submissions arrive in your review channel, and each member can only apply once, so there's no application channel to police.",
    whenToUse: [
      "Recruiting moderators, helpers or event staff",
      "Collecting structured applications instead of DMs",
      "Limiting applications to one per member automatically",
    ],
    keywords: ["mod application", "staff recruitment", "application form", "apply button"],
  },
  event: {
    slug: "discord-event-announcement-template",
    title: "Discord Event Announcement Template — one-tap RSVP | DWEEB",
    h1: "Discord Event Announcement Template",
    description:
      "A dated Discord event template with cover art, details and a working one-tap RSVP button that grants an Attendee role. Pairs with the Self Role plugin.",
    intro:
      "Promote your next event with a card that has everything at a glance: cover art, date and time, where it's happening and what you'll be doing. The RSVP button actually works — one tap grants an Attendee role so you can ping everyone who's coming (and tapping again bows out), with add-to-calendar and details links alongside. Set a role expiry and the list even cleans itself up after the event.",
    whenToUse: [
      "Announcing game nights, streams or meetups",
      "Counting attendees with a one-tap RSVP role",
      "Pinging confirmed attendees when the event starts",
    ],
    keywords: ["rsvp button", "attendee role", "event signup"],
  },
  poll: {
    slug: "discord-poll-template",
    title: "Discord Poll Template — reaction voting options | DWEEB",
    h1: "Discord Poll Template",
    description:
      "A ready-to-vote Discord poll template with lettered options for reaction voting. Free, no bot needed — customize the question and post through any webhook.",
    intro:
      "Ask your community and let them vote. This poll lays out lettered options ready for reaction voting, with a clear question and a closing time — great for picking the next event, gathering feedback, or settling a friendly debate.",
    whenToUse: [
      "Collecting quick community votes with reactions",
      "Letting members choose the next event or topic",
      "Gathering lightweight feedback",
    ],
  },
  "giveaway-button": {
    slug: "discord-giveaway-template",
    title: "Discord Giveaway Template — one-click button entry | DWEEB",
    h1: "Discord Giveaway Template",
    description:
      "A Discord giveaway template with one-click button entry, a live entrant count and an automatic winner draw. Pairs with the Giveaway plugin.",
    intro:
      "Run a giveaway your members can enter in one tap. The prize, live entrant count and winners fill themselves in, and a fair winner is drawn automatically — no reactions to count and no manual picking when it's time to choose.",
    whenToUse: [
      "Hosting a prize giveaway or raffle",
      "Boosting engagement with one-click entry",
      "Drawing a fair winner automatically",
    ],
    keywords: ["discord giveaway bot", "giveaway message", "raffle", "prize draw"],
  },
  "help-center": {
    slug: "discord-help-center-template",
    title: "Discord Help Center Template — instant FAQ + topic tickets | DWEEB",
    h1: "Discord Help Center Template",
    description:
      "A complete Discord help center in one message: a self-serve FAQ menu answers common questions instantly, and a topic menu opens private tickets. Two plugins, one panel.",
    intro:
      "Turn one message into your server's entire support desk. The first menu answers the questions you get every day on the spot — privately, instantly, no staff needed. The second opens a private ticket on the member's chosen topic for everything the FAQ can't solve. Members self-serve first and escalate second, so your team only sees the tickets that actually need a human.",
    whenToUse: [
      "Building a full support hub for a busy server",
      "Deflecting repeat questions before they become tickets",
      "Combining self-serve FAQ answers with private staff tickets",
    ],
    keywords: ["support hub", "help desk", "self-serve support", "faq menu", "ticket menu"],
  },
  faq: {
    slug: "discord-faq-template",
    title: "Discord FAQ Template — answer common questions | DWEEB",
    h1: "Discord FAQ Template",
    description:
      "A Discord FAQ template that answers common questions up front to cut repeat pings. Free, no bot needed — customize the Q&As and post through any webhook.",
    intro:
      "Answer the questions you get asked over and over, all in one place. This FAQ lays out common questions and clear answers inside a tidy container — pin it and watch the repeat pings in your support channel drop off.",
    whenToUse: [
      "Heading off frequently asked questions",
      "Reducing repeat questions in support",
      "Pinning quick answers for new members",
    ],
  },
  product: {
    slug: "discord-product-card-template",
    title: "Discord Product Card Template — shop listing | DWEEB",
    h1: "Discord Product Card Template",
    description:
      "A Discord product card template with a thumbnail, price, rating and buy link. Free, no bot needed — customize the listing and post through any webhook.",
    intro:
      "Show off a product with a clean listing card: a thumbnail, price, rating and a buy button, all in one tidy section. Ideal for merch drops, digital goods or affiliate picks shared straight into your server.",
    whenToUse: [
      "Promoting merch, products or digital goods",
      "Sharing a shop listing with a buy link",
      "Featuring a product drop in your community",
    ],
  },
  pricing: {
    slug: "discord-pricing-table-template",
    title: "Discord Pricing Table Template — membership tiers | DWEEB",
    h1: "Discord Pricing Tiers Template",
    description:
      "A Discord pricing template with three side-by-side membership tiers and an upgrade button. Free, no bot needed — customize the plans and post via webhook.",
    intro:
      "Lay out your membership tiers so the choice is obvious. This template stacks Free, Plus and Pro plans with their perks and an upgrade call-to-action — perfect for server subscriptions, Patreon-style perks or paid roles.",
    whenToUse: [
      "Presenting membership or subscription tiers",
      "Explaining paid perks and roles",
      "Driving upgrades with a clear call-to-action",
    ],
  },
  links: {
    slug: "discord-social-links-template",
    title: "Discord Social Links Template — link hub buttons | DWEEB",
    h1: "Discord Link Hub Template",
    description:
      "A Discord link hub template with all your social links as tidy button rows. Free, no bot needed — customize the links and post through any webhook.",
    intro:
      "Put all your links in one place — a clean hub of buttons for your website, socials and support page. It's a Linktree-style card that lives right in your server, so members can follow you everywhere in a tap.",
    whenToUse: [
      "Collecting all your social links in one post",
      "Building a Linktree-style hub inside Discord",
      "Helping members follow you across platforms",
    ],
    keywords: ["linktree", "social links", "link in bio"],
  },
  spotlight: {
    slug: "discord-member-spotlight-template",
    title: "Discord Member Spotlight Template — feature community work | DWEEB",
    h1: "Discord Member Spotlight Template",
    description:
      "A Discord member spotlight template with a borderless gallery to feature community work. Free, no bot needed — customize it and post through any webhook.",
    intro:
      "Celebrate your community by putting their work front and centre. This spotlight pairs a borderless image gallery with a shout-out — perfect for featuring member art, builds or highlights, and for nudging others to get involved.",
    whenToUse: [
      "Featuring member art, builds or content",
      "Running a weekly community spotlight",
      "Encouraging submissions with recognition",
    ],
  },
};

/** Absolute URL of the index card (`/templates`). */
export const TEMPLATES_OG_INDEX = `${SITE.origin}/templates-og/templates.png`;

/** Fully resolved, render-ready SEO data for one template. */
export interface ResolvedSeo {
  id: string;
  slug: string;
  path: string;
  url: string;
  appUrl: string;
  /** Per-template OG card (see scripts/gen-template-og.ts). */
  ogImage: string;
  title: string;
  h1: string;
  description: string;
  intro: string;
  whenToUse: string[];
  tips: string[];
  faq: FaqEntry[];
  keywords: string[];
  category: string;
  emoji: string;
  requiresBot: boolean;
  pairsWith?: string;
  componentKinds: string[];
}

/** De-duplicate while preserving order. */
function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/**
 * Merge a template's hand-written overrides with derived defaults (keywords,
 * the "needs a bot?" / "how do I use it?" / "is it free?" FAQ, the component
 * inventory). Throws if a template has no override entry — see file header.
 */
export function resolveSeo(template: MessageTemplate): ResolvedSeo {
  const o = TEMPLATE_SEO[template.id];
  if (!o) {
    throw new Error(
      `No SEO copy for template "${template.id}". Add an entry to scripts/seo/content.ts ` +
        `(TEMPLATE_SEO) before shipping — every template page must have unique copy.`,
    );
  }

  const path = `/templates/${o.slug}/`;
  const componentKinds = collectComponentKinds(template.message);

  const keywords = uniq(
    [
      o.h1,
      `discord ${template.name.toLowerCase()}`,
      ...(template.tags ?? []),
      ...(o.keywords ?? []),
      "discord template",
      "discord components v2",
      "discord webhook",
      "discord message builder",
    ].map((k) => k.toLowerCase()),
  );

  // Bot/webhook framing reused in tips + FAQ.
  const botNote = template.requiresBot
    ? `This template includes interactive components, so the ${template.pairsWith ? `${template.pairsWith} ` : ""}button or menu needs a Discord bot or app to own the webhook — a plain webhook can post the message, but clicks won't respond until it's wired up. DWEEB walks you through pairing it with the ${template.pairsWith ?? "matching"} plugin.`
    : "It posts through any Discord webhook — no bot, app or account required.";

  const tips = uniq([
    ...(o.tips ?? []),
    "Every piece of text, colour, emoji and link is editable — open it in DWEEB and make it yours.",
    botNote,
    "Use the live preview to check it renders exactly as Discord will show it before you send.",
  ]);

  const faq: FaqEntry[] = [
    ...(o.faq ?? []),
    {
      q: "Do I need a bot to use this template?",
      a: template.requiresBot
        ? `Posting the message works with any webhook, but its interactive parts (the ${template.pairsWith ? `${template.pairsWith} ` : ""}button or menu) only respond when a Discord bot or app owns the webhook. DWEEB detects this and helps you wire it to the ${template.pairsWith ?? "matching"} plugin.`
        : "No. This template uses only layout, text, media and link buttons, so it posts through any Discord webhook — no bot, app or account needed.",
    },
    {
      q: `How do I use this ${template.name} template?`,
      a: "Click “Open in DWEEB” to load it into the visual editor, change the text, colours and links to fit your server, then paste your Discord webhook URL and hit Send. You can also share it as a single link or export the message JSON.",
    },
    {
      q: "Is DWEEB free?",
      a: "Yes. DWEEB is free and runs entirely in your browser — no account, no JSON to write, and nothing uploaded to a server.",
    },
  ];

  return {
    id: template.id,
    slug: o.slug,
    path,
    url: `${SITE.origin}${path}`,
    appUrl: `${SITE.origin}/?template=${encodeURIComponent(template.id)}`,
    ogImage: `${SITE.origin}/templates-og/${o.slug}.png`,
    title: o.title,
    h1: o.h1,
    description: o.description,
    intro: o.intro,
    whenToUse: o.whenToUse,
    tips,
    faq,
    keywords,
    category: template.category,
    emoji: template.emoji,
    requiresBot: !!template.requiresBot,
    pairsWith: template.pairsWith,
    componentKinds,
  };
}

/** Resolve every template, in catalogue order. */
export function resolveAll(): ResolvedSeo[] {
  return TEMPLATES.map(resolveSeo);
}
