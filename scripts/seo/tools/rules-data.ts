/**
 * Rule list and composer for the Discord rules generator — shared by the build
 * (rules-generator.ts renders the default post into the page) and the bundled
 * client script, so the two can never disagree. Pure: no DOM, no build imports.
 */

export const RULES_GENERATOR_ENTRY = "guide:discord-server-rules";

export interface RuleOption {
  id: string;
  group: string;
  /** Bold lead-in, ending in a full stop. */
  title: string;
  text: string;
  /** Ticked when the page loads. */
  default?: boolean;
}

/** Wording follows the guide's own rule sets, so the generator and the templates agree. */
export const RULE_OPTIONS: readonly RuleOption[] = [
  {
    id: "respect",
    group: "Core",
    title: "Be respectful.",
    text: "No harassment, hate speech, slurs or personal attacks.",
    default: true,
  },
  {
    id: "civil",
    group: "Core",
    title: "Keep it civil.",
    text: "Disagree with ideas, not people. No flame wars.",
    default: true,
  },
  {
    id: "spam",
    group: "Core",
    title: "No spam.",
    text: "No flooding, mass mentions, copy-paste chains or wall-to-wall caps.",
    default: true,
  },
  {
    id: "topic",
    group: "Core",
    title: "Stay on topic.",
    text: "Use the right channel and read the channel description first.",
    default: true,
  },
  {
    id: "sfw",
    group: "Core",
    title: "Keep it safe for work.",
    text: "No NSFW, gore or shock content outside channels marked age-restricted.",
    default: true,
  },
  {
    id: "ads",
    group: "Core",
    title: "No advertising.",
    text: "No unsolicited invites, self-promotion or DM ads.",
    default: true,
  },
  {
    id: "privacy",
    group: "Core",
    title: "Protect privacy.",
    text: "Never share someone else's personal information.",
    default: true,
  },
  {
    id: "impersonation",
    group: "Core",
    title: "No impersonation.",
    text: "Do not pose as staff, other members or public figures.",
  },
  {
    id: "tos",
    group: "Core",
    title: "Follow Discord's rules.",
    text: "Discord's Terms of Service and Community Guidelines apply here too.",
    default: true,
  },
  {
    id: "staff",
    group: "Core",
    title: "Staff decisions are final.",
    text: "Take disputes to a ticket or a mod DM, not public chat.",
    default: true,
  },
  {
    id: "names",
    group: "Profiles",
    title: "Keep names and avatars clean.",
    text: "No offensive, sexual or impersonating usernames, avatars, bios or statuses.",
  },
  {
    id: "alts",
    group: "Profiles",
    title: "No alt accounts or ban evasion.",
    text: "One account per person; rejoining after a ban means another ban.",
  },
  {
    id: "language",
    group: "Profiles",
    title: "Use English in public channels.",
    text: "So moderators and everyone else can follow along.",
  },
  {
    id: "politics",
    group: "Chat",
    title: "No politics or religion debates.",
    text: "Take heated topics elsewhere.",
  },
  {
    id: "begging",
    group: "Chat",
    title: "No begging.",
    text: "Don't ask for Nitro, roles, money, follows or free stuff.",
  },
  {
    id: "spoilers",
    group: "Chat",
    title: "Mark spoilers.",
    text: "Use ||spoiler tags|| for story content from the last 30 days.",
  },
  {
    id: "dms",
    group: "Chat",
    title: "No unsolicited DMs.",
    text: "Ask before you DM someone, and never DM-advertise.",
  },
  {
    id: "links",
    group: "Safety",
    title: "No malicious links or files.",
    text: "No scams, phishing, IP grabbers, token loggers or cracked software.",
  },
  {
    id: "illegal",
    group: "Safety",
    title: "Nothing illegal.",
    text: "No piracy, leaks, or anything that breaks the law.",
  },
  {
    id: "voice-noise",
    group: "Voice",
    title: "Keep voice clean.",
    text: "No mic spam, soundboards, music or screaming; push-to-talk if you have background noise.",
  },
  {
    id: "voice-recording",
    group: "Voice",
    title: "No recording.",
    text: "Don't record voice channels or streams without everyone's consent.",
  },
  {
    id: "cheating",
    group: "Gaming",
    title: "No cheating or exploits.",
    text: "Discussing, sharing or selling cheats, hacks or exploits is an instant ban.",
  },
  {
    id: "trading",
    group: "Gaming",
    title: "No account trading.",
    text: "No buying, selling or sharing accounts, items or currency for real money.",
  },
  {
    id: "self-promo",
    group: "Creators",
    title: "Self-promo only where allowed.",
    text: "Share your own content in the self-promo channel, never in general or in DMs.",
  },
  {
    id: "leaks",
    group: "Creators",
    title: "Don't leak private content.",
    text: "No screenshots of members-only posts, streams or DMs outside this server.",
  },
];

export type NumberStyle = "bold" | "emoji" | "list";
export type ConsequenceStyle = "ladder" | "strict" | "none";

export interface RulesOptions {
  title: string;
  ruleIds: readonly string[];
  numbers: NumberStyle;
  consequences: ConsequenceStyle;
  contact: string;
  /** Unix seconds for the "last updated" timestamp, or null to leave the date out. */
  updated: number | null;
}

const KEYCAPS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

const CONSEQUENCES: Record<ConsequenceStyle, string> = {
  ladder:
    "> Breaking a rule can mean a warning, a timeout, a kick or a ban depending on severity. Repeat offences escalate.",
  strict: "> One warning, then a ban. Serious breaks skip the warning.",
  none: "",
};

/** One rule line in the chosen numbering style. */
function ruleLine(rule: RuleOption, index: number, numbers: NumberStyle): string {
  const n = index + 1;
  if (numbers === "list") return `${n}. **${rule.title}** ${rule.text}`;
  if (numbers === "emoji") {
    // 1-10 have their own keycaps; past ten, Discord servers spell the number
    // out in digit keycaps (1️⃣1️⃣) rather than switching style mid-list.
    const keycap =
      n <= KEYCAPS.length ? KEYCAPS[n - 1] : [...String(n)].map((digit) => `${digit}️⃣`).join("");
    return `${keycap} **${rule.title}** ${rule.text}`;
  }
  return `**${n}. ${rule.title}** ${rule.text}`;
}

/** Compose the rules post as Discord markdown. */
export function composeRules(options: RulesOptions): string {
  const chosen = RULE_OPTIONS.filter((rule) => options.ruleIds.includes(rule.id));
  const title = options.title.trim() || "📜 Server Rules";
  const lines = [`# ${title}`, "Being here means you agree to follow these.", ""];
  lines.push(...chosen.map((rule, i) => ruleLine(rule, i, options.numbers)));
  const consequence = CONSEQUENCES[options.consequences];
  if (consequence) lines.push("", consequence);
  const footer = [
    options.updated !== null ? `Last updated <t:${Math.trunc(options.updated)}:D>` : "",
    options.contact.trim(),
  ].filter(Boolean);
  if (footer.length) lines.push(`-# ${footer.join(" · ")}`);
  return lines.join("\n");
}

/** The page's starting point: the general template's ten core rules. */
export const DEFAULT_RULES_OPTIONS: RulesOptions = {
  title: "📜 Server Rules",
  ruleIds: RULE_OPTIONS.filter((rule) => rule.default).map((rule) => rule.id),
  numbers: "bold",
  consequences: "ladder",
  contact: "Questions? Open a ticket or ask a moderator.",
  updated: null,
};
