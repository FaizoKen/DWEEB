/**
 * Built-in message templates.
 *
 * Each template is a self-contained Components V2 message a user can drop into
 * the editor as a starting point. Applying one replaces the active message
 * wholesale. Templates carry no editor ids; the loader assigns fresh ones (see
 * `messageStore.bootstrap` / `replaceMessage`) so a template can be applied
 * repeatedly without colliding ids.
 *
 * The set is split across categories and surfaced in the full-screen Template
 * Gallery (see `features/templates/TemplateGallery.tsx`). Most templates are
 * **static** — layout, text, media, and link buttons only — so they post
 * cleanly through any webhook without a bot. A handful are **interactive**:
 * they include a clickable (custom_id) button or a select menu designed to pair
 * with a DWEEB plugin (Tickets, Self Role, Giveaway, Quick Replies…). Those are
 * tagged `requiresBot` because Discord only delivers component interactions to
 * the app that owns the webhook — the gallery surfaces that with a "Bot needed"
 * badge and a "Pairs with …" hint so a beginner knows what to wire up next.
 */

import {
  ButtonStyle,
  ComponentType,
  SeparatorSpacing,
  type WebhookMessage,
} from "@/core/schema/types";
import { newId } from "@/lib/id";
import { SHOWCASE_MESSAGE } from "./showcase";

const id = newId;

/** Brand-ish accent colors reused across templates and their gallery cards. */
const ACCENT = {
  blurple: 0x5865f2,
  green: 0x57f287,
  gold: 0xfee75c,
  red: 0xed4245,
  fuchsia: 0xeb459e,
  blue: 0x3498db,
  orange: 0xe67e22,
  purple: 0x9b59b6,
  teal: 0x1abc9c,
} as const;

/** Gallery sections, in display order. Every template names one of these. */
export const TEMPLATE_CATEGORIES = [
  "Featured",
  "Welcome",
  "Community",
  "Events",
  "Support",
  "Commerce",
  "Fun",
] as const;

export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/**
 * One interactive component a template ships that should be wired to a plugin,
 * identified by the placeholder `custom_id` it carries. A template can declare
 * several (one button → Tickets, one menu → Self Role…); the guided setup flow
 * walks them as a checklist. The placeholder id survives `replaceMessage` (only
 * `_id`s are reassigned), so it's a stable handle to the live component.
 */
export interface TemplatePluginSlot {
  /** The placeholder `custom_id` on the component this slot configures. */
  customId: string;
  /** Registry id of the plugin to wire it to (e.g. `"tickets"`). */
  pluginId: string;
  /**
   * Optional manifest preset id to pre-apply when the user sets this slot up, so
   * the plugin's config opens already matching the template's message (a Tickets
   * template can carry `"ticket-general"`, a Giveaway one `"gw-nitro"`). Must be a
   * preset the plugin declares for this component's target; an unknown id is
   * ignored and the config just opens blank. See {@link PluginPreset}.
   */
  preset?: string;
}

/** A named, pickable starting message shown in the Template Gallery. */
export interface MessageTemplate {
  /** Stable key — used as the React key and to address the template. */
  id: string;
  /** Short display name. */
  name: string;
  /** One-line description of the use case, shown under the name. */
  description: string;
  /** Leading glyph for the card / menu row. */
  emoji: string;
  /** Gallery section this template lives under. */
  category: TemplateCategory;
  /** Free-text keywords the gallery search matches against, beyond name/desc. */
  tags?: string[];
  /** Card chrome accent (0xRRGGBB) — usually mirrors the message's container. */
  accent?: number;
  /**
   * True when the message carries an interactive component (a custom_id button
   * or a select menu). Those only respond through a bot/app-owned webhook, so
   * the gallery flags them "Bot needed".
   */
  requiresBot?: boolean;
  /** Display name(s) of the DWEEB plugin(s) this template pairs with, shown on
   *  the gallery card (e.g. "Tickets", or "Tickets + Self Role"). */
  pairsWith?: string;
  /**
   * The interactive components this template ships that pair with a plugin, in
   * the order the guided setup should walk them. When non-empty, picking the
   * template launches `TemplateSetup`, which configures each one in place so the
   * user never has to hunt for the component or pick the plugin by hand. Keep in
   * sync with `pairsWith` (the display summary).
   */
  pluginSlots?: TemplatePluginSlot[];
  /** The message this template drops into the editor. */
  message: WebhookMessage;
}

// ════════════════════════════════════════════════════════════════════════════
// FEATURED
// ════════════════════════════════════════════════════════════════════════════

// The first-run default ("Component showcase") lives in `showcase.ts` so the
// editor store can import it without dragging this whole catalog into the main
// bundle. It's imported above and re-used as TEMPLATES[0] below.

// ════════════════════════════════════════════════════════════════════════════
// WELCOME & ONBOARDING
// ════════════════════════════════════════════════════════════════════════════

const WELCOME_MESSAGE: WebhookMessage = {
  username: "Welcome",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: ACCENT.blurple,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "# 👋 Welcome to the server!\nWe're really glad you found us. Here's everything you need to settle in.",
        },
        {
          _id: id(),
          type: ComponentType.MediaGallery,
          items: [
            {
              _id: id(),
              media: { url: "https://picsum.photos/seed/wb-welcome/900/300" },
              description: "Welcome banner",
            },
          ],
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Large,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "**Get started in three steps**\n- 📜 Read the **#rules** so everyone stays on the same page\n- 🎭 Pick up your roles in **#get-roles**\n- 💬 Say hi and introduce yourself in **#general**",
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "Stuck on anything? A friendly mod is only a message away.",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "📖 Community guide",
              url: "https://example.com/guide",
            },
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "💬 Jump into chat",
              url: "https://discord.gg/2wB7rHRDg2",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content: "-# Glad to have you — enjoy your stay! 💜",
    },
  ],
};

const RULES_MESSAGE: WebhookMessage = {
  username: "Server Rules",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: ACCENT.green,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "# 📜 Server Rules\nWelcome! Being here means you agree to follow these.",
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Large,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "**1.** Be respectful — no harassment, hate speech, or discrimination.\n**2.** Keep it civil — no spam, flooding, or wall-to-wall caps.\n**3.** Use the right channels and stay on topic.\n**4.** No NSFW, gore, or illegal content.\n**5.** No unsolicited advertising or DM spam.\n**6.** Follow staff direction — their word is final.",
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Small,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "> Breaking the rules may lead to a warning, mute, kick, or ban depending on severity.",
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content: "-# Last updated June 2026 • Questions? Ask a moderator.",
    },
  ],
};

const CHANNEL_GUIDE_MESSAGE: WebhookMessage = {
  username: "Server Guide",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: ACCENT.teal,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "# 🧭 Find your way around\nA quick map of where everything lives.",
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Small,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "**🚪 Start here**\n**#welcome** — you are here\n**#rules** — the house rules\n**#announcements** — important updates",
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "**💬 Hang out**\n**#general** — everyday chatter\n**#introductions** — say hello\n**#media** — share your pics & clips",
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "**🛟 Need help?**\n**#support** — open a ticket\n**#faq** — answers to common questions",
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content: "-# Tip: long-press (or right-click) any channel to mute or favourite it.",
    },
  ],
};

const VERIFY_MESSAGE: WebhookMessage = {
  username: "Verification",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: ACCENT.green,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "# ✅ One last step\nClick the button below to verify you're human and unlock the rest of the server.",
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Small,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "By verifying you confirm you've read and agree to the **#rules**. Welcome aboard! 🎉",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Success,
              label: "Verify me",
              emoji: { name: "✅" },
              custom_id: "verify_me",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# Wire the button to the Self Role plugin in give-only mode — one click grants the verified role and unlocks the server.",
    },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// COMMUNITY
// ════════════════════════════════════════════════════════════════════════════

const ANNOUNCEMENT_MESSAGE: WebhookMessage = {
  username: "Announcements",
  components: [
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "# 📢 Announcement\n**A quick heads-up for everyone** — here's what's new and what it means for you.",
    },
    {
      _id: id(),
      type: ComponentType.MediaGallery,
      items: [
        {
          _id: id(),
          media: { url: "https://picsum.photos/seed/wb-banner/900/320" },
          description: "Announcement banner",
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "We just rolled out a big update — faster, cleaner, and packed with the features you asked for. Skim the highlights, then dive in:\n- 🚀 Noticeably faster across the board\n- 🎨 A fresh new look\n- 🛠️ Dozens of fixes and tweaks",
    },
    {
      _id: id(),
      type: ComponentType.Separator,
      divider: true,
      spacing: SeparatorSpacing.Small,
    },
    {
      _id: id(),
      type: ComponentType.ActionRow,
      components: [
        {
          _id: id(),
          type: ComponentType.Button,
          style: ButtonStyle.Link,
          label: "Read the full post",
          url: "https://example.com/announcement",
        },
        {
          _id: id(),
          type: ComponentType.Button,
          style: ButtonStyle.Link,
          label: "Join the discussion",
          url: "https://discord.gg/2wB7rHRDg2",
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content: "-# Posted by the team • Thanks for being part of the community 💜",
    },
  ],
};

const PATCH_NOTES_MESSAGE: WebhookMessage = {
  username: "Changelog",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: ACCENT.purple,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "# 🛠️ Patch Notes — v2.4\n-# Released June 16, 2026",
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Small,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "### ✨ New\n- Added dark-mode dashboards\n- You can now pin up to 10 favourites",
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "### 🔧 Improved\n- 30% faster load times\n- Cleaner mobile layout",
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "### 🐛 Fixed\n- Notifications no longer double-fire\n- Squashed a rare crash on export",
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.ActionRow,
      components: [
        {
          _id: id(),
          type: ComponentType.Button,
          style: ButtonStyle.Link,
          label: "Full changelog",
          url: "https://example.com/changelog",
        },
      ],
    },
  ],
};

const INTRODUCTIONS_MESSAGE: WebhookMessage = {
  username: "Introductions",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: ACCENT.fuchsia,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "# 🙋 Introduce yourself!\nNew here? Copy the template below and tell us about you.",
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Small,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "> **Name / nickname:**\n> **Where you're from:**\n> **What brought you here:**\n> **A hobby or fun fact:**\n> **Currently into:**",
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "Don't be shy — everyone started with their first message. 😊",
        },
      ],
    },
  ],
};

const REACTION_ROLES_MESSAGE: WebhookMessage = {
  username: "Roles",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: ACCENT.blurple,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "# 🎭 Pick your roles\nChoose what you're into — it unlocks channels and pings for the things you care about.",
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Small,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "Open the menu and select any that fit. Pick as many as you like.",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.StringSelect,
              custom_id: "reaction_roles",
              placeholder: "Choose your interests…",
              min_values: 0,
              max_values: 4,
              options: [
                {
                  label: "Gaming",
                  value: "gaming",
                  description: "Squad up and find players",
                  emoji: { name: "🎮" },
                },
                {
                  label: "Art & Design",
                  value: "art",
                  description: "Share and critique creative work",
                  emoji: { name: "🎨" },
                },
                {
                  label: "Music",
                  value: "music",
                  description: "Recommendations and listening parties",
                  emoji: { name: "🎵" },
                },
                {
                  label: "Movies & TV",
                  value: "movies",
                  description: "Watch parties and hot takes",
                  emoji: { name: "🍿" },
                },
              ],
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content: "-# Wire the menu to the Self Role plugin so picks instantly grant/remove roles.",
    },
  ],
};

// A single message that searches the whole server. It ships ALL FOUR
// auto-populated selects — channel, role, user, and mentionable — each wired to
// its own Picker instance, so one post becomes a directory: a member opens a
// menu, picks what they're after, and gets a private list of clickable mentions
// back. The four placeholder custom_ids are distinct so the guided setup walks
// them as four independent Picker slots (see `pluginSlots` below).
const SERVER_DIRECTORY_MESSAGE: WebhookMessage = {
  username: "Server Directory",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: ACCENT.teal,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "# 🗂️ Server Directory\nOne message to find anything in **{server}** — channels, roles, and members. Pick from a menu and your results come back **privately**, with clickable mentions to jump straight there.",
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Large,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "**🧭 Channels** — find a place to read, post, or hop into voice.",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.ChannelSelect,
              custom_id: "directory_channels",
              placeholder: "Search for a channel…",
              min_values: 1,
              max_values: 5,
            },
          ],
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Small,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "**🎭 Roles** — look up a role and who carries it.",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.RoleSelect,
              custom_id: "directory_roles",
              placeholder: "Browse roles…",
              min_values: 1,
              max_values: 5,
            },
          ],
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Small,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "**👋 Members** — search for a member or staffer.",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.UserSelect,
              custom_id: "directory_members",
              placeholder: "Look up a member…",
              min_values: 1,
              max_values: 5,
            },
          ],
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Small,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "**🔎 Find anything** — not sure what it is? Search members and roles together.",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.MentionableSelect,
              custom_id: "directory_anything",
              placeholder: "Find any member or role…",
              min_values: 1,
              max_values: 5,
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# Wire each menu to the Picker plugin — every result is private to whoever searched. Pick up to five at a time.",
    },
  ],
};

// Suggestion box powered by Modal Form: the button pops a form, the answers
// are forwarded to a channel of the owner's choosing, and the member gets a
// private thank-you — structured ideas instead of a drive-by #suggestions mess.
const SUGGESTIONS_MESSAGE: WebhookMessage = {
  username: "Suggestions",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: ACCENT.gold,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "# 💡 Suggestion Box\nGot an idea to make **{server}** better? We want to hear it — big or small.",
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Small,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "**What makes a great suggestion**\n- 🎯 One idea per submission\n- 📝 Say what problem it solves\n- 🔍 Check it hasn't been suggested already",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Primary,
              label: "Share an idea",
              emoji: { name: "💡" },
              custom_id: "suggest_idea",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# The button opens a pop-up form — your idea goes straight to the team, and you get a private confirmation.",
    },
  ],
};

// Staff recruitment panel powered by Modal Form's one-per-person application
// form: what we look for, what you get, and an Apply button that pops the
// full questionnaire — no application channel spam.
const STAFF_APPS_MESSAGE: WebhookMessage = {
  username: "Staff Team",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: ACCENT.red,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "# 🛡️ Join the team\n**{server}** is growing and we're looking for moderators and helpers to keep it awesome.",
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Small,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "**What we look for**\n- 🕒 Active a few hours a week\n- 🤝 Calm, fair, and friendly under pressure\n- 🧠 Knows the rules inside out",
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "**What you get**\n- 🛡️ The staff role and badge\n- 🔧 Access to staff channels and tools\n- 💜 A real say in where the server goes",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Primary,
              label: "Apply now",
              emoji: { name: "📋" },
              custom_id: "staff_apply",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# Applying opens a pop-up questionnaire that goes straight to the review team — one application per person.",
    },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// EVENTS & ENGAGEMENT
// ════════════════════════════════════════════════════════════════════════════

const EVENT_MESSAGE: WebhookMessage = {
  username: "Events",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: ACCENT.orange,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "# 🎟️ Community Game Night",
        },
        {
          _id: id(),
          type: ComponentType.Section,
          components: [
            {
              _id: id(),
              type: ComponentType.TextDisplay,
              content:
                "### Friday, June 20 · 8:00 PM ET\nJump into voice for a relaxed evening of party games. All skill levels welcome — bring a friend!",
            },
          ],
          accessory: {
            _id: id(),
            type: ComponentType.Thumbnail,
            media: { url: "https://picsum.photos/seed/wb-event/256/256" },
            description: "Event cover",
          },
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Small,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "**📍 Where:** Game Night voice channel\n**🎮 Playing:** Jackbox, Gartic Phone & more\n**👥 Spots:** Unlimited",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Success,
              label: "RSVP — I'm in!",
              emoji: { name: "🎟️" },
              custom_id: "event_rsvp",
            },
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "Add to calendar",
              url: "https://example.com/event.ics",
            },
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "Event details",
              url: "https://example.com/event",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# RSVP grants the Attendee role so we can ping everyone who's coming — tap again to bow out. Set a role expiry and it cleans itself up after the event.",
    },
  ],
};

const POLL_MESSAGE: WebhookMessage = {
  username: "Polls",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: ACCENT.blue,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "# 📊 Community Poll\n**What should we host next month?**",
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Small,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "🇦 — Movie night\n🇧 — Game tournament\n🇨 — Art jam\n🇩 — Q&A with the team",
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "> React with the option you want. Voting closes in 48 hours!",
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content: "-# One vote per person, please — let's keep it fair. 🙏",
    },
  ],
};

const GIVEAWAY_BUTTON_MESSAGE: WebhookMessage = {
  username: "Giveaways",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: ACCENT.gold,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "# 🎉 GIVEAWAY 🎉",
        },
        {
          _id: id(),
          type: ComponentType.Section,
          components: [
            {
              _id: id(),
              type: ComponentType.TextDisplay,
              content:
                "### 🎁 {prize}\nTap **Enter** below — the count ticks up live and a fair winner is drawn on its own.",
            },
          ],
          accessory: {
            _id: id(),
            type: ComponentType.Thumbnail,
            media: { url: "https://picsum.photos/seed/wb-nitro/256/256" },
            description: "Prize",
          },
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Small,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "**🏆 Winners:** {winner_count} • **👥 Entered:** {entries} • **✨ Status:** {status}\n**🎊 Winner(s):** {winners}",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Success,
              label: "Enter Giveaway",
              emoji: { name: "🎉" },
              custom_id: "giveaway_enter",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# 🍀 Open to everyone in {server} • one entry per person • winners drawn at random",
    },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// SUPPORT
// ════════════════════════════════════════════════════════════════════════════

const SUPPORT_MESSAGE: WebhookMessage = {
  username: "Support",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: ACCENT.blue,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "# 🛟 Need a hand?\nOpen a private ticket and a staff member will be right with you.",
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Small,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "**Before you open a ticket**\n- 📚 Check **#faq** — it covers the common stuff\n- 📝 Have your details ready so we can help faster\n- 🤝 One ticket per issue, please",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Primary,
              label: "Open a ticket",
              emoji: { name: "🎫" },
              custom_id: "ticket_open",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content: "-# Wire the button to the Tickets plugin to spin up a private channel per request.",
    },
  ],
};

// The flagship multi-plugin support panel: a Quick Replies FAQ menu answers
// the common stuff instantly (privately, no staff needed), and a Tickets topic
// menu opens a private channel for everything else. Two plugins, one message —
// the guided setup walks both slots. Both plugins own their menu's options, so
// the option lists below are just the preview until each slot is wired.
const HELP_CENTER_MESSAGE: WebhookMessage = {
  username: "Help Center",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: ACCENT.blue,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "# 🛟 Help Center\nEverything in one place — grab an instant answer, or open a private ticket with the team.",
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Large,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "**⚡ Instant answers** — the questions we get every day, answered on the spot.",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.StringSelect,
              custom_id: "help_faq",
              placeholder: "Browse common questions…",
              min_values: 1,
              max_values: 1,
              options: [
                {
                  label: "How do I get roles?",
                  value: "faq_roles",
                  description: "Pick them up yourself in seconds",
                  emoji: { name: "🙋" },
                },
                {
                  label: "How do I report someone?",
                  value: "faq_report",
                  description: "The right way to flag rule-breaking",
                  emoji: { name: "🚨" },
                },
                {
                  label: "Where are the invite & socials?",
                  value: "faq_links",
                  description: "Share the server or follow us",
                  emoji: { name: "🔗" },
                },
                {
                  label: "Something's broken",
                  value: "faq_bug",
                  description: "Where to send bug reports",
                  emoji: { name: "🐛" },
                },
              ],
            },
          ],
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Small,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "**🎫 Talk to the team** — pick a topic and a private ticket opens just for you.",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.StringSelect,
              custom_id: "help_topics",
              placeholder: "Open a ticket…",
              min_values: 1,
              max_values: 1,
              options: [
                {
                  label: "General help",
                  value: "topic_general",
                  description: "Questions and general support",
                  emoji: { name: "❓" },
                },
                {
                  label: "Report a player",
                  value: "topic_report",
                  description: "Report rule-breaking privately",
                  emoji: { name: "🚨" },
                },
                {
                  label: "Billing / store",
                  value: "topic_billing",
                  description: "Purchases and payments",
                  emoji: { name: "🛒" },
                },
                {
                  label: "Something else",
                  value: "topic_other",
                  description: "Anything not listed",
                  emoji: { name: "💬" },
                },
              ],
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# Answers arrive privately — only you see them. Tickets open a private channel with staff.",
    },
  ],
};

const FAQ_MESSAGE: WebhookMessage = {
  username: "FAQ",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: ACCENT.teal,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "# ❓ Frequently Asked Questions",
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Small,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "**How do I get roles?**\nHead to **#get-roles** and pick from the menu — they apply instantly.",
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "**How do I report someone?**\nOpen a ticket in **#support** or DM a moderator with details.",
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "**Can I promote my own stuff?**\nOnly in **#self-promo**, and please keep it occasional.",
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "**I found a bug — where do I post it?**\nDrop it in **#feedback** with steps to reproduce. Thank you! 🙏",
        },
      ],
    },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// COMMERCE & SHOWCASE
// ════════════════════════════════════════════════════════════════════════════

const PRODUCT_MESSAGE: WebhookMessage = {
  username: "Shop",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: ACCENT.fuchsia,
      components: [
        {
          _id: id(),
          type: ComponentType.Section,
          components: [
            {
              _id: id(),
              type: ComponentType.TextDisplay,
              content:
                "# ✨ Aurora Hoodie\n**$48.00** · Free shipping over $50\n\nUltra-soft brushed fleece in three colourways. Runs true to size.",
            },
          ],
          accessory: {
            _id: id(),
            type: ComponentType.Thumbnail,
            media: { url: "https://picsum.photos/seed/wb-product/256/256" },
            description: "Aurora Hoodie",
          },
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Small,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "⭐ **4.8/5** from 320+ reviews · 🚚 Ships in 1–2 business days",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "Buy now",
              url: "https://example.com/product",
            },
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "View sizing",
              url: "https://example.com/sizing",
            },
          ],
        },
      ],
    },
  ],
};

const PRICING_MESSAGE: WebhookMessage = {
  username: "Pricing",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: ACCENT.green,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "# 💎 Membership Tiers\nPick the plan that fits — upgrade or cancel any time.",
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Small,
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "### 🌱 Free — $0\n- Access to public channels\n- Community events\n- Basic role",
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "### ⭐ Plus — $5/mo\n- Everything in Free\n- Members-only channels\n- Custom colour role\n- Priority support",
        },
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "### 🚀 Pro — $12/mo\n- Everything in Plus\n- Early access drops\n- Monthly AMA seat\n- Shiny Pro badge",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "Upgrade now",
              url: "https://example.com/upgrade",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content: "-# Prices in USD • Cancel anytime • 7-day money-back guarantee",
    },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// FUN & MISC
// ════════════════════════════════════════════════════════════════════════════

const LINK_HUB_MESSAGE: WebhookMessage = {
  username: "Links",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: ACCENT.purple,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content: "# 🔗 Find us everywhere\nFollow along and never miss a thing.",
        },
        {
          _id: id(),
          type: ComponentType.Separator,
          divider: true,
          spacing: SeparatorSpacing.Small,
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "🌐 Website",
              url: "https://example.com",
            },
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "🐦 Twitter / X",
              url: "https://twitter.com",
            },
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "📺 YouTube",
              url: "https://youtube.com",
            },
          ],
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "📸 Instagram",
              url: "https://instagram.com",
            },
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "🎵 TikTok",
              url: "https://tiktok.com",
            },
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "💜 Support us",
              url: "https://example.com/donate",
            },
          ],
        },
      ],
    },
  ],
};

const SPOTLIGHT_MESSAGE: WebhookMessage = {
  username: "Spotlight",
  components: [
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content: "# 🌟 Member Spotlight",
    },
    {
      _id: id(),
      type: ComponentType.MediaGallery,
      items: [
        {
          _id: id(),
          media: { url: "https://picsum.photos/seed/wb-sp1/500/500" },
          description: "Featured work 1",
        },
        {
          _id: id(),
          media: { url: "https://picsum.photos/seed/wb-sp2/500/500" },
          description: "Featured work 2",
        },
        {
          _id: id(),
          media: { url: "https://picsum.photos/seed/wb-sp3/500/500" },
          description: "Featured work 3",
        },
        {
          _id: id(),
          media: { url: "https://picsum.photos/seed/wb-sp4/500/500" },
          description: "Featured work 4",
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "This week we're celebrating **@artist** for their incredible series above. Drop a 💜 to show some love, and tag us to be featured next!",
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content: "-# Want the spotlight? Post in #showcase with the tag #feature-me.",
    },
  ],
};

/**
 * Ordered template list shown in the Template Gallery (and the Saved menu's
 * quick picks). The first entry is the component showcase that doubles as the
 * first-run default message.
 */
export const TEMPLATES: MessageTemplate[] = [
  {
    id: "showcase",
    name: "Component showcase",
    description: "A guided tour of every block — the best place to learn the editor.",
    emoji: "🧩",
    category: "Featured",
    tags: ["tour", "demo", "kit", "learn", "example"],
    accent: ACCENT.blurple,
    message: SHOWCASE_MESSAGE,
  },
  {
    id: "welcome",
    name: "Welcome",
    description: "Greet new members and point them to the essentials.",
    emoji: "👋",
    category: "Welcome",
    tags: ["onboarding", "intro", "greeting", "new members", "banner"],
    accent: ACCENT.blurple,
    message: WELCOME_MESSAGE,
  },
  {
    id: "rules",
    name: "Server rules",
    description: "A clean, numbered rulebook with a consequences note.",
    emoji: "📜",
    category: "Welcome",
    tags: ["guidelines", "moderation", "terms", "conduct"],
    accent: ACCENT.green,
    message: RULES_MESSAGE,
  },
  {
    id: "channel-guide",
    name: "Channel guide",
    description: "Map out where everything lives so newcomers don't get lost.",
    emoji: "🧭",
    category: "Welcome",
    tags: ["onboarding", "navigation", "channels", "map", "directory"],
    accent: ACCENT.teal,
    message: CHANNEL_GUIDE_MESSAGE,
  },
  {
    id: "verify",
    name: "Verification gate",
    description: "A one-click verify button to unlock the server.",
    emoji: "✅",
    category: "Welcome",
    tags: ["verify", "gate", "human", "captcha", "role", "button"],
    accent: ACCENT.green,
    requiresBot: true,
    pairsWith: "Self Role",
    pluginSlots: [{ customId: "verify_me", pluginId: "self-role" }],
    message: VERIFY_MESSAGE,
  },
  {
    id: "announcement",
    name: "Announcement",
    description: "A borderless, image-led banner for big news.",
    emoji: "📢",
    category: "Community",
    tags: ["news", "update", "broadcast", "banner"],
    accent: ACCENT.blurple,
    message: ANNOUNCEMENT_MESSAGE,
  },
  {
    id: "patch-notes",
    name: "Patch notes",
    description: "Tidy New / Improved / Fixed changelog sections.",
    emoji: "🛠️",
    category: "Community",
    tags: ["changelog", "release", "update", "version", "notes"],
    accent: ACCENT.purple,
    message: PATCH_NOTES_MESSAGE,
  },
  {
    id: "introductions",
    name: "Introductions",
    description: "A copy-and-fill prompt that gets new members talking.",
    emoji: "🙋",
    category: "Community",
    tags: ["intro", "icebreaker", "about", "prompt"],
    accent: ACCENT.fuchsia,
    message: INTRODUCTIONS_MESSAGE,
  },
  {
    id: "reaction-roles",
    name: "Role menu",
    description: "A select menu members use to self-assign roles by interest.",
    emoji: "🎭",
    category: "Community",
    tags: ["self role", "reaction roles", "menu", "select", "interests", "pings"],
    accent: ACCENT.blurple,
    requiresBot: true,
    pairsWith: "Self Role",
    pluginSlots: [{ customId: "reaction_roles", pluginId: "self-role" }],
    message: REACTION_ROLES_MESSAGE,
  },
  {
    id: "server-directory",
    name: "Server directory",
    description: "One message that finds any channel, role, or member — all select types in one.",
    emoji: "🗂️",
    category: "Community",
    tags: [
      "directory",
      "search",
      "find",
      "lookup",
      "channels",
      "roles",
      "members",
      "select",
      "menu",
      "picker",
      "resources",
    ],
    accent: ACCENT.teal,
    requiresBot: true,
    pairsWith: "Picker",
    pluginSlots: [
      { customId: "directory_channels", pluginId: "picker" },
      { customId: "directory_roles", pluginId: "picker" },
      { customId: "directory_members", pluginId: "picker" },
      { customId: "directory_anything", pluginId: "picker" },
    ],
    message: SERVER_DIRECTORY_MESSAGE,
  },
  {
    id: "suggestions",
    name: "Suggestion box",
    description: "A share-an-idea button that pops a form and forwards ideas to the team.",
    emoji: "💡",
    category: "Community",
    tags: ["suggestions", "ideas", "feedback", "form", "modal", "button"],
    accent: ACCENT.gold,
    requiresBot: true,
    pairsWith: "Modal Form",
    pluginSlots: [{ customId: "suggest_idea", pluginId: "modal-form", preset: "suggestion" }],
    message: SUGGESTIONS_MESSAGE,
  },
  {
    id: "staff-apps",
    name: "Staff applications",
    description: "A recruitment panel with a pop-up application form — one entry per person.",
    emoji: "🛡️",
    category: "Community",
    tags: ["staff", "moderator", "application", "recruit", "apply", "form", "modal"],
    accent: ACCENT.red,
    requiresBot: true,
    pairsWith: "Modal Form",
    pluginSlots: [{ customId: "staff_apply", pluginId: "modal-form", preset: "staff-application" }],
    message: STAFF_APPS_MESSAGE,
  },
  {
    id: "event",
    name: "Event / RSVP",
    description: "A dated event card with cover art and a working one-tap RSVP button.",
    emoji: "🎟️",
    category: "Events",
    tags: ["event", "rsvp", "calendar", "meetup", "schedule", "attendee", "button"],
    accent: ACCENT.orange,
    requiresBot: true,
    pairsWith: "Self Role",
    pluginSlots: [{ customId: "event_rsvp", pluginId: "self-role" }],
    message: EVENT_MESSAGE,
  },
  {
    id: "poll",
    name: "Poll",
    description: "Lettered options ready for reaction voting.",
    emoji: "📊",
    category: "Events",
    tags: ["vote", "survey", "question", "reactions"],
    accent: ACCENT.blue,
    message: POLL_MESSAGE,
  },
  {
    id: "giveaway-button",
    name: "Giveaway",
    description: "One-click entry — the prize, live entrant count, and winners fill themselves in.",
    emoji: "🎉",
    category: "Events",
    tags: ["prize", "raffle", "contest", "button", "enter", "winner"],
    accent: ACCENT.gold,
    requiresBot: true,
    pairsWith: "Giveaway",
    pluginSlots: [{ customId: "giveaway_enter", pluginId: "giveaway", preset: "gw-nitro" }],
    message: GIVEAWAY_BUTTON_MESSAGE,
  },
  {
    id: "support",
    name: "Support desk",
    description: "An open-a-ticket button for private help.",
    emoji: "🛟",
    category: "Support",
    tags: ["tickets", "help", "support", "staff", "button"],
    accent: ACCENT.blue,
    requiresBot: true,
    pairsWith: "Tickets",
    pluginSlots: [{ customId: "ticket_open", pluginId: "tickets", preset: "ticket-general" }],
    message: SUPPORT_MESSAGE,
  },
  {
    id: "help-center",
    name: "Help center",
    description: "Instant FAQ answers plus topic tickets — two plugins working in one panel.",
    emoji: "🛟",
    category: "Support",
    tags: ["help", "support", "faq", "tickets", "menu", "select", "self-serve", "hub"],
    accent: ACCENT.blue,
    requiresBot: true,
    pairsWith: "Quick Replies + Tickets",
    pluginSlots: [
      { customId: "help_faq", pluginId: "quick-replies", preset: "qr-faq" },
      { customId: "help_topics", pluginId: "tickets", preset: "ticket-support-menu" },
    ],
    message: HELP_CENTER_MESSAGE,
  },
  {
    id: "faq",
    name: "FAQ",
    description: "Common questions answered up front to cut repeat pings.",
    emoji: "❓",
    category: "Support",
    tags: ["help", "questions", "answers", "support"],
    accent: ACCENT.teal,
    message: FAQ_MESSAGE,
  },
  {
    id: "product",
    name: "Product card",
    description: "A shop listing with thumbnail, rating, and buy link.",
    emoji: "✨",
    category: "Commerce",
    tags: ["shop", "store", "product", "sell", "buy"],
    accent: ACCENT.fuchsia,
    message: PRODUCT_MESSAGE,
  },
  {
    id: "pricing",
    name: "Pricing tiers",
    description: "Three side-by-side plans with an upgrade call-to-action.",
    emoji: "💎",
    category: "Commerce",
    tags: ["plans", "membership", "subscription", "tiers", "pricing"],
    accent: ACCENT.green,
    message: PRICING_MESSAGE,
  },
  {
    id: "links",
    name: "Link hub",
    description: "All your social links as tidy rows of buttons.",
    emoji: "🔗",
    category: "Fun",
    tags: ["social", "links", "linktree", "follow", "buttons"],
    accent: ACCENT.purple,
    message: LINK_HUB_MESSAGE,
  },
  {
    id: "spotlight",
    name: "Member spotlight",
    description: "A borderless gallery to feature community work.",
    emoji: "🌟",
    category: "Fun",
    tags: ["feature", "gallery", "showcase", "highlight", "art"],
    accent: ACCENT.gold,
    message: SPOTLIGHT_MESSAGE,
  },
];
