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

/**
 * Production origin — keep in sync with `index.html` canonical / sitemap.
 *
 * `orgId`/`personId`/`websiteId` must stay anchored on **dweeb.faizo.net**, never
 * on bare `faizo.net` and never on github.com. We're a subdomain, and Google
 * falls back to the domain-level site name when a subdomain's identity is weak —
 * `faizo.net` 301s to github.com/faizoken, so anchoring the publisher there made
 * Google print "GitHub" as the site name above our results. See the long comment
 * in `index.html`'s JSON-LD.
 */
export const SITE = {
  origin: "https://dweeb.faizo.net",
  name: "DWEEB",
  ogImage: "https://dweeb.faizo.net/og-image.png",
  websiteId: "https://dweeb.faizo.net/#website",
  orgId: "https://dweeb.faizo.net/#organization",
  personId: "https://dweeb.faizo.net/#faizo",
  githubUrl: "https://github.com/FaizoKen/DWEEB",
} as const;

/**
 * Last time the template catalogue was reviewed, as an ISO date. Used for
 * sitemap `<lastmod>` on the template pages. Bump it when you add or
 * meaningfully revise templates — keeping it stable (rather than "now" on every
 * deploy) avoids signalling false freshness to search engines.
 */
export const TEMPLATES_LASTMOD = "2026-07-04";

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
  Roles:
    "Verify accounts and hand out roles automatically — Genshin, Steam, YouTube, Twitch, birthdays and more, powered by RoleLogic link plugins.",
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
      "A one-click Discord verification message: members tap a verify button, RoleLogic checks where they joined from and grants the matching role. No bot needed on the webhook.",
    intro:
      "Gate your server behind a single verify button, powered by the RoleLogic Member Origin Role service. New members tap it, verify in the browser, and get their origin role automatically — while admins track who verified from a dashboard linked right in the message. The button is a plain link, so it posts through any webhook and never expires.",
    whenToUse: [
      "Adding a human check before granting access",
      "Granting roles based on where members joined from",
      "Running a lightweight alternative to a captcha bot",
    ],
  },
  "topgg-vote": {
    slug: "discord-topgg-vote-rewards",
    title: "Discord Top.gg Vote Rewards — voter role panel | DWEEB",
    h1: "Top.gg Vote Rewards Template",
    description:
      "A vote-for-us Discord panel that rewards Top.gg voters with a temporary role via RoleLogic. Plain link button — posts through any webhook, no bot needed.",
    intro:
      "Turn Top.gg votes into a perk members actually chase. This panel links straight to your server's (or bot's) Top.gg vote page, and the RoleLogic Top.gg Voter Role service grants a temporary Voter role when the vote lands — expiring on a timer you pick, from an hour to a week, so members come back and vote again.",
    whenToUse: [
      "Growing your server's Top.gg ranking with a standing vote reminder",
      "Rewarding bot voters with a cosmetic or perk role",
      "Running vote-gated perks that expire between vote cooldowns",
    ],
  },
  "genshin-verify": {
    slug: "discord-genshin-verification",
    title: "Discord Genshin Impact Verification — UID roles | DWEEB",
    h1: "Genshin Impact Verification Template",
    description:
      "A Genshin Impact verification panel for Discord: players link their UID and get Adventure Rank, World Level and Spiral Abyss roles automatically via RoleLogic.",
    intro:
      "Give your Genshin community roles that mean something. Players tap the verify button, enter their UID on RoleLogic, and roles for Adventure Rank, World Level, Spiral Abyss progress, achievements and server region are granted automatically — with an admin dashboard linked right in the message.",
    whenToUse: [
      "Verifying Genshin players before opening co-op or LFG channels",
      "Granting AR / World Level / Abyss roles without manual screenshots",
      "Splitting members by game region for event pings",
    ],
  },
  "youtube-sub-role": {
    slug: "discord-youtube-subscriber-role",
    title: "Discord YouTube Subscriber Role — auto-verify subs | DWEEB",
    h1: "YouTube Subscriber Role Template",
    description:
      "A claim-your-role panel for YouTube communities: members link YouTube with one-click Google OAuth and RoleLogic grants the subscriber role automatically.",
    intro:
      "Stop verifying subscribers by screenshot. This panel sends members through YouTube's official Google sign-in; RoleLogic checks the subscription and hands out the Subscriber role automatically — no mod queue, no fakeable proof, and an admin dashboard to review who linked.",
    whenToUse: [
      "Rewarding YouTube subscribers with an exclusive Discord role",
      "Gating subscriber-only channels behind a real check",
      "Replacing screenshot-proof verification with OAuth",
    ],
  },
  "twitch-follower": {
    slug: "discord-twitch-follower-role",
    title: "Discord Twitch Follower & Sub Roles — real-time | DWEEB",
    h1: "Twitch Follower Role Template",
    description:
      "A link-your-Twitch panel that grants follower and Tier 1/2/3 subscriber roles in real time via RoleLogic and Twitch EventSub. No bot on the webhook.",
    intro:
      "Give your stream community live-updating roles. Members link Twitch once and RoleLogic keeps their Discord roles in sync through EventSub — follows and Tier 1/2/3 subs land in real time, and roles update automatically when a sub lapses or upgrades.",
    whenToUse: [
      "Syncing Twitch sub tiers to Discord perk roles",
      "Rewarding followers with access to stream-crew channels",
      "Keeping sub roles accurate without nightly re-checks",
    ],
  },
  "steam-verify": {
    slug: "discord-steam-verification",
    title: "Discord Steam Verification — playtime & game roles | DWEEB",
    h1: "Steam Verification Template",
    description:
      "A Steam verification panel for Discord: players sign in via Steam OpenID and RoleLogic grants roles by games owned, playtime, achievements and Steam level.",
    intro:
      "Know who actually plays. This panel sends members through Steam's own OpenID sign-in; RoleLogic reads their public profile and grants roles for the games they own, hours played, achievements, Steam level, group membership and more — perfect for game-specific servers and clans.",
    whenToUse: [
      "Gating game channels to members who own the game",
      "Granting veteran roles by playtime or achievements",
      "Verifying clan members' Steam accounts at the door",
    ],
  },
  "referral-code": {
    slug: "discord-referral-code-role",
    title: "Discord Referral Code Role — redeem codes & QR | DWEEB",
    h1: "Referral Code Role Template",
    description:
      "A redeem-a-code Discord panel: members enter a referral code (or scan a QR) and RoleLogic grants the matching role — time-limited batches supported.",
    intro:
      "Hand out roles with codes instead of mod work. Print QR codes on event wristbands, drop codes in a podcast or Kickstarter update, and members redeem them here for the matching role — RoleLogic supports time-limited batches and six-figure redemption counts, with an admin dashboard for minting codes.",
    whenToUse: [
      "Granting attendee roles at IRL events via QR codes",
      "Rewarding backers or podcast listeners with a code",
      "Running limited-time promo roles that expire",
    ],
  },
  "roblox-verify": {
    slug: "discord-roblox-verification",
    title: "Discord Roblox Verification — gamepass & group roles | DWEEB",
    h1: "Roblox Verification Template",
    description:
      "A Roblox verification panel for Discord: players link via Roblox OAuth and get roles by account age, badges, gamepasses, group rank and in-game stats.",
    intro:
      "Verify Roblox players the official way. Members sign in through Roblox's own OAuth — no follow-for-proof tricks — and RoleLogic grants roles from account age, verified badge, gamepasses, group rank, and even custom per-game stats wired up through Open Cloud.",
    whenToUse: [
      "Verifying Roblox accounts before giving game-server access",
      "Granting VIP roles to gamepass owners automatically",
      "Mirroring Roblox group ranks into Discord roles",
    ],
  },
  "tiktok-creator": {
    slug: "discord-tiktok-creator-role",
    title: "Discord TikTok Creator Role — follower-tier roles | DWEEB",
    h1: "TikTok Creator Role Template",
    description:
      "A TikTok verification panel for Discord: creators link via TikTok's Login Kit and RoleLogic grants roles by follower count, verified badge, videos and likes.",
    intro:
      "Give real creators a badge that can't be faked. Members link their TikTok through the official Login Kit and RoleLogic grants creator roles based on follower count, verification status, video count and total likes — great for creator hubs, collab servers and talent communities.",
    whenToUse: [
      "Verifying creators in a collab or networking server",
      "Granting tiered roles by TikTok follower count",
      "Reserving creator-only channels for verified accounts",
    ],
  },
  "form-role": {
    slug: "discord-form-role-quiz",
    title: "Discord Application Form & Quiz Role Template | DWEEB",
    h1: "Form & Quiz Role Template",
    description:
      "A fill-in-the-form Discord panel: applications, rules quizzes and surveys built in RoleLogic auto-grade answers and grant the role instantly. No bot needed.",
    intro:
      "Let the form hand out the role. Build an application, rules quiz, poll or survey in RoleLogic, point this panel's button at it, and submissions are auto-graded — grant on a passing score, on specific answers, or on simple submission, with one response per person to keep it fair.",
    whenToUse: [
      "Running a rules quiz that unlocks the server on a pass",
      "Collecting applications that grant a role automatically",
      "Screening members with a survey before opening access",
    ],
  },
  "kick-channel": {
    slug: "discord-kick-follower-role",
    title: "Discord Kick Follower & Sub Roles — real-time | DWEEB",
    h1: "Kick Channel Role Template",
    description:
      "A link-your-Kick panel that grants follower, subscriber, VIP, mod and OG roles in real time via RoleLogic — gated on sub tenure, gifts and account age.",
    intro:
      "Bring your Kick.com channel crew into Discord with roles that keep themselves up to date. Members link Kick once through its official OAuth and RoleLogic grants follower, subscriber, VIP, moderator and OG roles in real time — with gates for sub tenure, gift counts, account age and live status.",
    whenToUse: [
      "Syncing Kick subs and VIPs into Discord perk roles",
      "Rewarding long-tenured subscribers with veteran roles",
      "Giving your mod team matching roles across platforms",
    ],
  },
  birthdays: {
    slug: "discord-birthday-role",
    title: "Discord Birthday Role — auto birthday-of-the-day | DWEEB",
    h1: "Birthday Role Template",
    description:
      "A set-your-birthday Discord panel: members save their date once and RoleLogic grants timezone-aware birthday, zodiac, birth-month and age roles automatically.",
    intro:
      "Never miss a member's birthday again. Members set their date once — no extra account needed — and RoleLogic handles the rest: a birthday-of-the-day role that lands at their local midnight, plus zodiac, birth-month and optional age roles the whole year round.",
    whenToUse: [
      "Celebrating members with an automatic birthday role",
      "Powering a birthday-ping channel without a dedicated bot",
      "Adding zodiac and birth-month flair roles",
    ],
  },
  "osu-verify": {
    slug: "discord-osu-verification",
    title: "Discord osu! Verification — rank & PP roles | DWEEB",
    h1: "osu! Verification Template",
    description:
      "An osu! verification panel for Discord: players link via osu! OAuth and RoleLogic grants roles by global rank, PP, play count and accuracy — per game mode.",
    intro:
      "Rank roles your osu! community can trust. Players link their account through osu!'s own OAuth and RoleLogic grants roles from global rank, PP, play count and accuracy — per game mode, including taiko and mania — plus supporter status and official BN/GMT/NAT groups.",
    whenToUse: [
      "Granting digit roles (1k, 10k, 100k) from real rank data",
      "Verifying players before tournament sign-ups",
      "Highlighting supporters and official group members",
    ],
  },
  "bluesky-role": {
    slug: "discord-bluesky-role",
    title: "Discord Bluesky Roles — followers, mutuals & lists | DWEEB",
    h1: "Bluesky Account Role Template",
    description:
      "A link-your-Bluesky Discord panel: RoleLogic grants roles for followers, mutuals, starter-pack and list members, account age and follower count.",
    intro:
      "Connect your Bluesky following to your Discord. Members link their Bluesky account and RoleLogic grants roles for following you, being a mutual, sitting in a starter pack or list, post engagement, and account properties like age, follower count or a custom domain handle.",
    whenToUse: [
      "Rewarding your Bluesky followers with a Discord role",
      "Granting roles to starter-pack or curated-list members",
      "Verifying custom-domain handles for a trusted-member role",
    ],
  },
  "github-contributor": {
    slug: "discord-github-contributor-role",
    title: "Discord GitHub Contributor Roles — commits, PRs & issues | DWEEB",
    h1: "GitHub Contributor Role Template",
    description:
      "A link-your-GitHub Discord panel: RoleLogic grants roles for commits, pull requests, merged PRs and issues on any public repository.",
    intro:
      "Give contributors the recognition they've earned. Members link their GitHub account through GitHub's own OAuth and RoleLogic grants roles from real contribution data — commits, opened and merged pull requests, and issues on any public repository you choose.",
    whenToUse: [
      "Rewarding open-source contributors with a Discord role",
      "Gating a contributors-only channel on merged PRs",
      "Ranking hackathon or dev-community members by activity",
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
      a: "Yes. DWEEB's full visual builder is free and needs no account. Working drafts and browser saves are local by default; optional connected features such as schedules, server libraries, AI, and plugins use the data required to work.",
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
