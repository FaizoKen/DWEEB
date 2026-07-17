import { IconName } from "./components/Icon";
import { COLORS } from "./theme";

/**
 * Film-facing product data — names/descriptions lifted from the real sources:
 * plugin cards ⇐ src/core/plugins/registry.json, templates ⇐ src/data/presets.ts,
 * feature chips ⇐ README / register-commands.mjs / SendPanel. Keep verbatim where
 * shown on screen.
 */

export const PLUGINS: {
  id: string;
  name: string;
  icon: IconName;
  color: string;
  desc: string;
  targets: string;
  presets: number;
}[] = [
  {
    id: "tickets",
    name: "Tickets",
    icon: "ticket",
    color: "#3ba55d",
    desc: "Private support tickets from a button or topic menu — per-ticket channel, optional intake form, staff claim, close with transcript.",
    targets: "Button · Select",
    presets: 5,
  },
  {
    id: "giveaway",
    name: "Giveaway",
    icon: "gift",
    color: "#f0b232",
    desc: "Run a giveaway from a button: live entrant count, entry requirements, a fair random draw of N winners, reroll, and cancel.",
    targets: "Button",
    presets: 5,
  },
  {
    id: "self-role",
    name: "Self Role",
    icon: "id",
    color: "#5865f2",
    desc: "Members self-assign roles from a button or select — toggle/give/take, a pick-limit (1 = swap), per-role emoji, a role gate, auto-expiring roles.",
    targets: "Button · Select",
    presets: 0,
  },
  {
    id: "modal-form",
    name: "Modal Form",
    icon: "form",
    color: "#eb459e",
    desc: "Pop up a form on click, forward the answers to a channel (named or anonymous), and reply privately.",
    targets: "Button",
    presets: 6,
  },
  {
    id: "quick-replies",
    name: "Quick Replies",
    icon: "reply",
    color: "#00a8fc",
    desc: "Canned replies on a button or topic menu — private or public, with {user}/{server} variables. No bot needed.",
    targets: "Button · Select",
    presets: 7,
  },
  {
    id: "picker",
    name: "Picker",
    icon: "users",
    color: "#9b84ee",
    desc: "User / Role / Mentionable / Channel selects — picks come back as mentions in a private confirmation. No bot needed.",
    targets: "4 select kinds",
    presets: 0,
  },
  {
    id: "ping-pong",
    name: "Latency Check",
    icon: "gauge",
    color: "#f23f43",
    desc: "Reply with a detailed latency report — click → server, dispatcher hop, handler time.",
    targets: "Button",
    presets: 0,
  },
];

/** Real template names from src/data/presets.ts (subset shown in the gallery). */
export const TEMPLATES: { name: string; emoji: string; cat: string; accent: string }[] = [
  { name: "Component showcase", emoji: "🧩", cat: "Featured", accent: COLORS.blurple },
  { name: "Welcome", emoji: "👋", cat: "Welcome", accent: "#23a559" },
  { name: "Server rules", emoji: "📜", cat: "Welcome", accent: "#f0b232" },
  { name: "Verification gate", emoji: "✅", cat: "Welcome", accent: "#23a559" },
  { name: "Announcement", emoji: "📢", cat: "Community", accent: COLORS.blurple },
  { name: "Patch notes", emoji: "🛠️", cat: "Community", accent: "#00a8fc" },
  { name: "Role menu", emoji: "🎭", cat: "Community", accent: "#9b84ee" },
  { name: "Event / RSVP", emoji: "🎟️", cat: "Events", accent: "#eb459e" },
  { name: "Poll", emoji: "📊", cat: "Events", accent: "#00a8fc" },
  { name: "Giveaway", emoji: "🎉", cat: "Events", accent: "#f0b232" },
  { name: "Help center", emoji: "🛟", cat: "Support", accent: "#00a8fc" },
  { name: "FAQ", emoji: "❓", cat: "Support", accent: "#00a8fc" },
  { name: "Product card", emoji: "✨", cat: "Commerce", accent: "#eb459e" },
  { name: "Pricing tiers", emoji: "💎", cat: "Commerce", accent: COLORS.blurple },
  { name: "Link hub", emoji: "🔗", cat: "Fun", accent: "#00a8fc" },
  { name: "Member spotlight", emoji: "🌟", cat: "Fun", accent: "#f0b232" },
];

/** Fictional cast (no real users). */
export const CAST = {
  aria: { name: "Aria", color: "#eb459e" },
  kai: { name: "Kai", color: "#00a8fc" },
  mo: { name: "Mo", color: "#f0b232" },
} as const;
