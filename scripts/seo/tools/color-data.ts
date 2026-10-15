/**
 * The color lists on `/guides/discord-color-codes/`, each from its source as
 * of 2026-10-16 — client-safe, so the guide's tables and its converter's
 * swatches come from one list:
 *
 * - Brand: discord.com/branding (Blurple, Light Blurple, Black).
 * - The 2021 palette Discord retired from that page but discord.js
 *   (`Colors`) and discord.py (`Colour.brand_*`, `fuchsia`, `yellow`) still name.
 * - Role presets: the 20 swatches in Discord's role color picker, read from the
 *   web client's bundle, plus #99AAB5, the color a role with none shows.
 * - Library names: discord.js `packages/discord.js/src/util/Colors.js` and
 *   discord.py `discord/colour.py` on their main branches.
 */

export interface NamedColor {
  name: string;
  value: number;
}

export const BRAND_COLORS: readonly NamedColor[] = [
  { name: "Blurple", value: 0x5865f2 },
  { name: "Light Blurple", value: 0xe0e3ff },
  { name: "Black", value: 0x000000 },
];

export const PALETTE_2021: readonly NamedColor[] = [
  { name: "Green", value: 0x57f287 },
  { name: "Yellow", value: 0xfee75c },
  { name: "Fuchsia", value: 0xeb459e },
  { name: "Red", value: 0xed4245 },
];

/** Discord's role color picker, in its order: ten colors, then their darker shades. */
export const ROLE_PRESETS: readonly NamedColor[] = [
  { name: "Teal", value: 0x1abc9c },
  { name: "Green", value: 0x2ecc71 },
  { name: "Blue", value: 0x3498db },
  { name: "Purple", value: 0x9b59b6 },
  { name: "Magenta", value: 0xe91e63 },
  { name: "Gold", value: 0xf1c40f },
  { name: "Orange", value: 0xe67e22 },
  { name: "Red", value: 0xe74c3c },
  { name: "Light grey", value: 0x95a5a6 },
  { name: "Blue grey", value: 0x607d8b },
  { name: "Dark teal", value: 0x11806a },
  { name: "Dark green", value: 0x1f8b4c },
  { name: "Dark blue", value: 0x206694 },
  { name: "Dark purple", value: 0x71368a },
  { name: "Dark magenta", value: 0xad1457 },
  { name: "Dark gold", value: 0xc27c0e },
  { name: "Dark orange", value: 0xa84300 },
  { name: "Dark red", value: 0x992d22 },
  { name: "Grey", value: 0x979c9f },
  { name: "Dark blue grey", value: 0x546e7a },
];

/** The color a role with no color of its own (stored as 0) shows. */
export const DEFAULT_ROLE_COLOR = 0x99aab5;

/**
 * Every named color in discord.js and discord.py, joined on the value. The two
 * libraries disagree on several names — discord.js `Green` is the 2021 brand
 * green while discord.py `green()` is the role-picker green, and each library's
 * "grey" names point at different shades — which is why this is one table.
 */
export const LIBRARY_COLORS: readonly { value: number; js?: string; py?: string }[] = [
  { value: 0x5865f2, js: "Blurple", py: "blurple()" },
  { value: 0x7289da, py: "og_blurple()" },
  { value: 0x57f287, js: "Green", py: "brand_green()" },
  { value: 0xed4245, js: "Red", py: "brand_red()" },
  { value: 0xfee75c, js: "Yellow", py: "yellow()" },
  { value: 0xeb459e, js: "Fuchsia", py: "fuchsia()" },
  { value: 0xeb459f, py: "pink()" },
  { value: 0x1abc9c, js: "Aqua", py: "teal()" },
  { value: 0x11806a, js: "DarkAqua", py: "dark_teal()" },
  { value: 0x2ecc71, py: "green()" },
  { value: 0x1f8b4c, js: "DarkGreen", py: "dark_green()" },
  { value: 0x3498db, js: "Blue", py: "blue()" },
  { value: 0x206694, js: "DarkBlue", py: "dark_blue()" },
  { value: 0x9b59b6, js: "Purple", py: "purple()" },
  { value: 0x71368a, js: "DarkPurple", py: "dark_purple()" },
  { value: 0xe91e63, js: "LuminousVividPink", py: "magenta()" },
  { value: 0xad1457, js: "DarkVividPink", py: "dark_magenta()" },
  { value: 0xf1c40f, js: "Gold", py: "gold()" },
  { value: 0xc27c0e, js: "DarkGold", py: "dark_gold()" },
  { value: 0xe67e22, js: "Orange", py: "orange()" },
  { value: 0xa84300, js: "DarkOrange", py: "dark_orange()" },
  { value: 0xe74c3c, py: "red()" },
  { value: 0x992d22, js: "DarkRed", py: "dark_red()" },
  { value: 0x95a5a6, js: "Grey", py: "lighter_grey()" },
  { value: 0x979c9f, js: "DarkGrey", py: "light_grey()" },
  { value: 0x607d8b, py: "dark_grey()" },
  { value: 0x546e7a, py: "darker_grey()" },
  { value: 0x7f8c8d, js: "DarkerGrey" },
  { value: 0xbcc0c0, js: "LightGrey" },
  { value: 0x99aab5, js: "Greyple", py: "greyple()" },
  { value: 0x34495e, js: "Navy" },
  { value: 0x2c3e50, js: "DarkNavy" },
  { value: 0x2c2f33, js: "DarkButNotBlack" },
  { value: 0x23272a, js: "NotQuiteBlack" },
  { value: 0xffffff, js: "White" },
  { value: 0x000000, js: "Default", py: "default()" },
];
