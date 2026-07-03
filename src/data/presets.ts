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
  "Roles",
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
export interface TemplateInteractiveSlot {
  /** Discriminator; absent means this original, custom_id-bound kind. */
  kind?: "interactive";
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

/**
 * A Link button pre-wired to a URL-based link plugin (see `linkManifest.ts`).
 * The binding already ships inside the button's `url`, so there is nothing to
 * configure in DWEEB — the guided setup surfaces the plugin's per-server
 * `setupUrl` step instead (register the server with the external service so
 * the link actually does something). Resolved to the live component by URL
 * prefix, since a Link button carries no `custom_id`.
 */
export interface TemplateLinkSlot {
  kind: "link";
  /** Registry id of the link plugin the button carries. */
  pluginId: string;
}

export type TemplatePluginSlot = TemplateInteractiveSlot | TemplateLinkSlot;

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
            // Pre-wired to the Member Origin Role link plugin: the URL is the
            // binding (see linkManifest.ts), so the template ships already
            // attached — {server_id} resolves at send from the destination
            // webhook, and no bot or guided setup is needed.
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "Verify me",
              emoji: { name: "✅" },
              url: "https://plugin-rolelogic.faizo.net/member-origin-role/verify?guild={server_id}",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# 🛡️ Admins: review verified members in the [RoleLogic dashboard](https://plugin-rolelogic.faizo.net/member-origin-role/members/{server_id}).",
    },
  ],
};

// ════════════════════════════════════════════════════════════════════════════
// ROLES — RoleLogic link-plugin panels
//
// Each of these follows the Verification-gate pattern: the Link button ships
// pre-wired to a RoleLogic link plugin (the URL *is* the binding, see
// linkManifest.ts), {server_id} resolves at send from the destination webhook,
// and the admin footer links the plugin's per-server dashboard. No bot needed.
// ════════════════════════════════════════════════════════════════════════════

const TOPGG_VOTE_MESSAGE: WebhookMessage = {
  username: "Vote Rewards",
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
            "# 🗳️ Vote for us on Top.gg\nA vote takes ten seconds and helps new members find us — and it earns you the exclusive **Voter** role as thanks.",
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
            "The role expires after a while, so vote again whenever the cooldown resets to keep it. 💜",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            // The plugin binds to the whole top.gg URL space (its template is
            // `https://top.gg/{vote_page}`), so this ships the server-vote
            // page — top.gg keys it by guild id, so {server_id} makes it work
            // as-is. Rewarding votes for a *bot* instead? Paste its top.gg
            // vote link over the URL; the chip follows.
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "Vote on Top.gg",
              emoji: { name: "🗳️" },
              url: "https://top.gg/discord/servers/{server_id}/vote",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# 🛡️ Admins: connect your Top.gg vote webhook in the [RoleLogic dashboard](https://rolelogic.faizo.net/dashboard?plugin_select=https%3A%2F%2Fplugin-rolelogic.faizo.net%2Ftopgg-voter-role).",
    },
  ],
};

const GENSHIN_VERIFY_MESSAGE: WebhookMessage = {
  username: "Traveler Check-in",
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
            "# ⚔️ Verify your Genshin account\nLink your UID to unlock traveler roles — Adventure Rank, World Level, Spiral Abyss and region roles are granted automatically.",
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
            "Set your in-game profile to public first, then verify — it only takes a minute. ✨",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "Verify my UID",
              emoji: { name: "⚔️" },
              url: "https://plugin-rolelogic.faizo.net/genshin-player-role/verify?guild={server_id}",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# 🛡️ Admins: review verified players in the [RoleLogic dashboard](https://plugin-rolelogic.faizo.net/genshin-player-role/players/{server_id}).",
    },
  ],
};

const YOUTUBE_SUB_MESSAGE: WebhookMessage = {
  username: "Subscriber Perks",
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
            "# ▶️ Claim your Subscriber role\nSubscribed on YouTube? Link your account with one click and get the **Subscriber** role automatically.",
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
            "Sign-in uses Google OAuth — we never see your password, and you can unlink anytime.",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "Link YouTube",
              emoji: { name: "▶️" },
              url: "https://plugin-rolelogic.faizo.net/youtube-subscriber-role/verify?guild={server_id}",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# 🛡️ Admins: review linked subscribers in the [RoleLogic dashboard](https://plugin-rolelogic.faizo.net/youtube-subscriber-role/subscribers/{server_id}).",
    },
  ],
};

const TWITCH_FOLLOWER_MESSAGE: WebhookMessage = {
  username: "Stream Crew",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: ACCENT.purple,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "# 📺 Link your Twitch\nFollowers and subs get their roles here — **Follower**, and **Tier 1 / 2 / 3** roles update in real time as your sub status changes.",
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
          content: "Link once and you're done — roles follow your Twitch status automatically. 💜",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "Link Twitch",
              emoji: { name: "📺" },
              url: "https://plugin-rolelogic.faizo.net/twitch-follower-role/verify?guild={server_id}",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# 🛡️ Admins: review linked viewers in the [RoleLogic dashboard](https://plugin-rolelogic.faizo.net/twitch-follower-role/users/{server_id}).",
    },
  ],
};

const STEAM_VERIFY_MESSAGE: WebhookMessage = {
  username: "Steam Check-in",
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
            "# 🎮 Verify your Steam profile\nSign in through Steam and get roles for the games you own, your playtime, achievements and Steam level — automatically.",
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
            "Verification uses Steam's own OpenID sign-in — set your profile to public so your stats can be read.",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "Link Steam",
              emoji: { name: "🎮" },
              url: "https://plugin-rolelogic.faizo.net/steam-player-role/verify?guild={server_id}",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# 🛡️ Admins: review verified players in the [RoleLogic dashboard](https://plugin-rolelogic.faizo.net/steam-player-role/players/{server_id}).",
    },
  ],
};

const REFERRAL_CODE_MESSAGE: WebhookMessage = {
  username: "Code Redemption",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: ACCENT.orange,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "# 🎟️ Got a code? Redeem it here\nEnter the code from your ticket, flyer, wristband or invite and the matching role lands on your account instantly.",
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
          content: "Codes are one-per-person and some are time-limited — redeem yours early!",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "Redeem a code",
              emoji: { name: "🎟️" },
              url: "https://plugin-rolelogic.faizo.net/referral-code-role/verify?guild={server_id}",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# 🛡️ Admins: create codes and QR batches in the [RoleLogic dashboard](https://plugin-rolelogic.faizo.net/referral-code-role/admin?guild_id={server_id}).",
    },
  ],
};

const ROBLOX_VERIFY_MESSAGE: WebhookMessage = {
  username: "Roblox Check-in",
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
            "# 🧱 Verify your Roblox account\nLink your Roblox account to unlock roles for account age, badges, gamepasses, group rank — even your in-game stats.",
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
            "Verification is through Roblox's official sign-in — no passwords, no follow-for-proof tricks.",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "Verify Roblox",
              emoji: { name: "🧱" },
              url: "https://plugin-rolelogic.faizo.net/roblox-player-role/verify?guild={server_id}",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# 🛡️ Admins: review verified players in the [RoleLogic dashboard](https://plugin-rolelogic.faizo.net/roblox-player-role/players/{server_id}).",
    },
  ],
};

const TIKTOK_CREATOR_MESSAGE: WebhookMessage = {
  username: "Creator Corner",
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
            "# 🎵 TikTok creator? Prove it\nLink your TikTok account and get creator roles based on your follower count, verified badge, videos and likes.",
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
            "Sign-in uses TikTok's official Login Kit — takes under a minute, unlink anytime.",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "Link TikTok",
              emoji: { name: "🎵" },
              url: "https://plugin-rolelogic.faizo.net/tiktok-creator-role/verify?guild={server_id}",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# 🛡️ Admins: manage creator tiers in the [RoleLogic dashboard](https://rolelogic.faizo.net/dashboard?plugin_select=https%3A%2F%2Fplugin-rolelogic.faizo.net%2Ftiktok-creator-role).",
    },
  ],
};

const FORM_ROLE_MESSAGE: WebhookMessage = {
  username: "Applications",
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
            "# 📝 Fill in the form\nAnswer a short form to get your role — applications, rules quizzes and surveys are graded automatically and the role lands instantly.",
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
          content: "One submission per person — take your time and answer honestly. ✅",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            // {form_id} is a fill-me slot: RoleLogic issues the id when the
            // admin builds the form, and they paste the finished link over the
            // button URL (the plugin follows the URL). Until it's replaced,
            // validation holds the send instead of letting a dead link post.
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "Open the form",
              emoji: { name: "📝" },
              url: "https://plugin-rolelogic.faizo.net/form-respondent-role/f/{form_id}",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# 🛡️ Admins: build your form in the [RoleLogic dashboard](https://rolelogic.faizo.net/dashboard?plugin_select=https%3A%2F%2Fplugin-rolelogic.faizo.net%2Fform-respondent-role), then paste its link over the button's URL.",
    },
  ],
};

const KICK_CHANNEL_MESSAGE: WebhookMessage = {
  username: "Kick Crew",
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
            "# 🎥 Link your Kick account\nFollowers, subs, VIPs, mods and OGs — link once and your channel roles arrive in real time, gift subs and tenure included.",
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
          content: "Sign-in uses Kick's official OAuth — no passwords shared, unlink anytime. 💚",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "Link Kick",
              emoji: { name: "🎥" },
              url: "https://plugin-rolelogic.faizo.net/kick-channel-role/verify?guild={server_id}",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# 🛡️ Admins: review linked viewers in the [RoleLogic dashboard](https://plugin-rolelogic.faizo.net/kick-channel-role/users/{server_id}).",
    },
  ],
};

const BIRTHDAY_ROLE_MESSAGE: WebhookMessage = {
  username: "Birthdays",
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
            "# 🎂 Tell us your birthday\nSet it once and the magic happens on the day: a shiny **Birthday** role, plus zodiac and birth-month roles all year round.",
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
            "Timezone-aware, so your role shows up on *your* midnight. The year is optional if you'd rather not share your age.",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "Set my birthday",
              emoji: { name: "🎂" },
              url: "https://plugin-rolelogic.faizo.net/birthday-role/verify?guild={server_id}",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# 🛡️ Admins: see upcoming birthdays in the [RoleLogic dashboard](https://plugin-rolelogic.faizo.net/birthday-role/users/{server_id}).",
    },
  ],
};

const OSU_VERIFY_MESSAGE: WebhookMessage = {
  username: "osu! Check-in",
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
            "# 🎯 Verify your osu! account\nLink your account and earn roles for global rank, PP, play count and accuracy — per game mode, supporter and BN/GMT/NAT included.",
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
          content: "Sign-in is osu!'s own OAuth — one click and your rank roles are live. 🩷",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "Link osu!",
              emoji: { name: "🎯" },
              url: "https://plugin-rolelogic.faizo.net/osu-player-role/verify?guild={server_id}",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# 🛡️ Admins: review verified players in the [RoleLogic dashboard](https://plugin-rolelogic.faizo.net/osu-player-role/users/{server_id}).",
    },
  ],
};

const BLUESKY_ROLE_MESSAGE: WebhookMessage = {
  username: "Bluesky Link",
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
            "# 🦋 Link your Bluesky\nFollowers, mutuals, starter-pack and list members — link your Bluesky account and the matching roles are granted automatically.",
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
            "Account-age, follower-count and custom-domain roles work too — one link covers them all.",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "Link Bluesky",
              emoji: { name: "🦋" },
              url: "https://plugin-rolelogic.faizo.net/bluesky-account-role/verify?guild={server_id}",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# 🛡️ Admins: review linked accounts in the [RoleLogic dashboard](https://plugin-rolelogic.faizo.net/bluesky-account-role/users/{server_id}).",
    },
  ],
};

const GITHUB_CONTRIBUTOR_MESSAGE: WebhookMessage = {
  username: "GitHub Link",
  components: [
    {
      _id: id(),
      type: ComponentType.Container,
      accent_color: ACCENT.purple,
      components: [
        {
          _id: id(),
          type: ComponentType.TextDisplay,
          content:
            "# 🐙 Link your GitHub\nCommits, pull requests, merged PRs and issues — link your GitHub account and the roles you've earned as a contributor are granted automatically.",
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
            "Works with any public repository — perfect for open-source projects, hackathons and dev communities.",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Link,
              label: "Link GitHub",
              emoji: { name: "🐙" },
              url: "https://plugin-rolelogic.faizo.net/github-contributor-role/verify?guild={server_id}",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# 🛡️ Admins: choose repos and contribution tiers in the [RoleLogic dashboard](https://rolelogic.faizo.net/dashboard?plugin_select=https%3A%2F%2Fplugin-rolelogic.faizo.net%2Fgithub-contributor-role).",
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

// Introductions powered by Modal Form: instead of asking newcomers to copy and
// fill a plain-text template, the button pops a short form and posts their
// answers to the channel — no blank-page friction, and every intro reads the
// same. The Modal Form plugin owns the form fields (seeded by the
// `introduction` preset); the message just pitches it.
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
            "# 🙋 Introduce yourself!\nNew here? Tap the button below, fill in a quick form, and your intro posts right here so everyone can say hi.",
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
            "**We'd love to know**\n- 🙂 Your name or nickname\n- 🌍 Where you're from\n- ✨ What brought you here\n- 🎯 A hobby or what you're currently into",
        },
        {
          _id: id(),
          type: ComponentType.ActionRow,
          components: [
            {
              _id: id(),
              type: ComponentType.Button,
              style: ButtonStyle.Primary,
              label: "Introduce yourself",
              emoji: { name: "🙋" },
              custom_id: "introduce_self",
            },
          ],
        },
      ],
    },
    {
      _id: id(),
      type: ComponentType.TextDisplay,
      content:
        "-# The button opens a quick pop-up form — don't be shy, everyone started with their first message. 😊",
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
    tags: ["verify", "gate", "human", "captcha", "role", "button", "origin", "rolelogic"],
    accent: ACCENT.green,
    // The verify button is a *link* plugin (Member Origin Role) — the binding
    // ships inside the button URL, so there's no bot requirement and nothing to
    // configure in DWEEB. The link slot exists so the guided setup still runs:
    // its one step is registering the server with RoleLogic (the setupUrl).
    pairsWith: "Member Origin Role",
    pluginSlots: [{ kind: "link", pluginId: "rolelogic-member-origin-role" }],
    message: VERIFY_MESSAGE,
  },
  {
    id: "topgg-vote",
    name: "Top.gg vote rewards",
    description: "A vote-for-us button that pays voters back with a temporary role.",
    emoji: "🗳️",
    category: "Roles",
    tags: ["topgg", "top.gg", "vote", "voter", "upvote", "reward", "role", "rolelogic"],
    accent: ACCENT.fuchsia,
    pairsWith: "Top.gg Voter Role",
    pluginSlots: [{ kind: "link", pluginId: "rolelogic-topgg-voter-role" }],
    message: TOPGG_VOTE_MESSAGE,
  },
  {
    id: "genshin-verify",
    name: "Genshin verification",
    description: "Players link their UID and get AR, World Level and Abyss roles.",
    emoji: "⚔️",
    category: "Roles",
    tags: ["genshin", "genshin impact", "uid", "adventure rank", "verify", "role", "rolelogic"],
    accent: ACCENT.teal,
    pairsWith: "Genshin Player Role",
    pluginSlots: [{ kind: "link", pluginId: "rolelogic-genshin-player-role" }],
    message: GENSHIN_VERIFY_MESSAGE,
  },
  {
    id: "youtube-sub-role",
    name: "YouTube subscriber role",
    description: "Subscribers link YouTube with one click and get their role.",
    emoji: "▶️",
    category: "Roles",
    tags: ["youtube", "subscriber", "creator", "oauth", "verify", "role", "rolelogic"],
    accent: ACCENT.red,
    pairsWith: "YouTube Subscriber Role",
    pluginSlots: [{ kind: "link", pluginId: "rolelogic-youtube-subscriber-role" }],
    message: YOUTUBE_SUB_MESSAGE,
  },
  {
    id: "twitch-follower",
    name: "Twitch follower role",
    description: "Followers and Tier 1/2/3 subs get live-updating channel roles.",
    emoji: "📺",
    category: "Roles",
    tags: ["twitch", "follower", "subscriber", "tier", "stream", "verify", "role", "rolelogic"],
    accent: ACCENT.purple,
    pairsWith: "Twitch Follower Role",
    pluginSlots: [{ kind: "link", pluginId: "rolelogic-twitch-follower-role" }],
    message: TWITCH_FOLLOWER_MESSAGE,
  },
  {
    id: "steam-verify",
    name: "Steam verification",
    description: "Players sign in via Steam and get roles for games and playtime.",
    emoji: "🎮",
    category: "Roles",
    tags: ["steam", "openid", "playtime", "games", "achievements", "verify", "role", "rolelogic"],
    accent: ACCENT.blue,
    pairsWith: "Steam Player Role",
    pluginSlots: [{ kind: "link", pluginId: "rolelogic-steam-player-role" }],
    message: STEAM_VERIFY_MESSAGE,
  },
  {
    id: "referral-code",
    name: "Code redemption",
    description: "Members redeem a referral code or QR and get the matching role.",
    emoji: "🎟️",
    category: "Roles",
    tags: ["referral", "code", "redeem", "qr", "event", "giveaway", "role", "rolelogic"],
    accent: ACCENT.orange,
    pairsWith: "Referral Code Role",
    pluginSlots: [{ kind: "link", pluginId: "rolelogic-referral-code-role" }],
    message: REFERRAL_CODE_MESSAGE,
  },
  {
    id: "roblox-verify",
    name: "Roblox verification",
    description: "Players verify their Roblox account and get stat-based roles.",
    emoji: "🧱",
    category: "Roles",
    tags: ["roblox", "gamepass", "group rank", "badges", "verify", "role", "rolelogic"],
    accent: ACCENT.red,
    pairsWith: "Roblox Player Role",
    pluginSlots: [{ kind: "link", pluginId: "rolelogic-roblox-player-role" }],
    message: ROBLOX_VERIFY_MESSAGE,
  },
  {
    id: "tiktok-creator",
    name: "TikTok creator role",
    description: "Creators link TikTok and get follower- and badge-based roles.",
    emoji: "🎵",
    category: "Roles",
    tags: ["tiktok", "creator", "follower", "verified", "verify", "role", "rolelogic"],
    accent: ACCENT.fuchsia,
    pairsWith: "TikTok Creator Role",
    pluginSlots: [{ kind: "link", pluginId: "rolelogic-tiktok-creator-role" }],
    message: TIKTOK_CREATOR_MESSAGE,
  },
  {
    id: "form-role",
    name: "Form & quiz role",
    description: "An application form or rules quiz that grants the role itself.",
    emoji: "📝",
    category: "Roles",
    tags: ["form", "quiz", "application", "survey", "onboarding", "role", "rolelogic"],
    accent: ACCENT.blurple,
    pairsWith: "Form Respondent Role",
    pluginSlots: [{ kind: "link", pluginId: "rolelogic-form-respondent-role" }],
    message: FORM_ROLE_MESSAGE,
  },
  {
    id: "kick-channel",
    name: "Kick channel role",
    description: "Kick followers, subs, VIPs, mods and OGs get live channel roles.",
    emoji: "🎥",
    category: "Roles",
    tags: ["kick", "kick.com", "follower", "subscriber", "vip", "stream", "role", "rolelogic"],
    accent: ACCENT.green,
    pairsWith: "Kick Channel Role",
    pluginSlots: [{ kind: "link", pluginId: "rolelogic-kick-channel-role" }],
    message: KICK_CHANNEL_MESSAGE,
  },
  {
    id: "birthdays",
    name: "Birthday roles",
    description: "Members set their birthday once and get the role on the day.",
    emoji: "🎂",
    category: "Roles",
    tags: ["birthday", "bday", "zodiac", "celebration", "timezone", "role", "rolelogic"],
    accent: ACCENT.gold,
    pairsWith: "Birthday Role",
    pluginSlots: [{ kind: "link", pluginId: "rolelogic-birthday-role" }],
    message: BIRTHDAY_ROLE_MESSAGE,
  },
  {
    id: "osu-verify",
    name: "osu! verification",
    description: "Players link osu! and get rank, PP and accuracy roles per mode.",
    emoji: "🎯",
    category: "Roles",
    tags: ["osu", "osu!", "rank", "pp", "rhythm game", "verify", "role", "rolelogic"],
    accent: ACCENT.fuchsia,
    pairsWith: "osu! Player Role",
    pluginSlots: [{ kind: "link", pluginId: "rolelogic-osu-player-role" }],
    message: OSU_VERIFY_MESSAGE,
  },
  {
    id: "bluesky-role",
    name: "Bluesky roles",
    description: "Followers, mutuals and list members get roles for linking Bluesky.",
    emoji: "🦋",
    category: "Roles",
    tags: ["bluesky", "bsky", "atproto", "follower", "mutual", "social", "role", "rolelogic"],
    accent: ACCENT.blue,
    pairsWith: "Bluesky Account Role",
    pluginSlots: [{ kind: "link", pluginId: "rolelogic-bluesky-account-role" }],
    message: BLUESKY_ROLE_MESSAGE,
  },
  {
    id: "github-contributor",
    name: "GitHub contributor role",
    description: "Contributors link GitHub and get roles for commits, PRs and issues.",
    emoji: "🐙",
    category: "Roles",
    tags: [
      "github",
      "contributor",
      "commits",
      "pull requests",
      "open source",
      "developer",
      "role",
      "rolelogic",
    ],
    accent: ACCENT.purple,
    pairsWith: "GitHub Contributor Role",
    pluginSlots: [{ kind: "link", pluginId: "rolelogic-github-contributor-role" }],
    message: GITHUB_CONTRIBUTOR_MESSAGE,
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
    description: "A one-tap form that gets new members introducing themselves — no copy-paste.",
    emoji: "🙋",
    category: "Community",
    tags: ["intro", "icebreaker", "about", "prompt", "form", "modal"],
    accent: ACCENT.fuchsia,
    requiresBot: true,
    pairsWith: "Modal Form",
    pluginSlots: [{ customId: "introduce_self", pluginId: "modal-form", preset: "introduction" }],
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
