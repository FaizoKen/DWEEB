// Brand tokens lifted straight from DWEEB's design system (src/styles/tokens.css)
// so the promo is pixel-true to the product.

export const COLORS = {
  // App shell
  bg: "#0e0f13",
  bgElevated: "#17191f",
  bgSubtle: "#1a1d23",
  bgInput: "#1e2128",
  bgHover: "#242833",
  bgActive: "#2c313d",
  border: "#2a2e38",
  borderStrong: "#3b4150",
  text: "#eceef3",
  textMuted: "#aab1bf",
  textSubtle: "#828a99",

  // Brand
  blurple: "#5865F2",
  blurpleHover: "#4752c4",
  green: "#57F287",
  greenDeep: "#23a559",
  danger: "#f04747",
  warning: "#f0b232",

  // Discord preview surface
  dBgPrimary: "#313338",
  dBgSecondary: "#2b2d31",
  dBgTertiary: "#1a1a1e",
  dText: "#efeff1",
  dTextMuted: "#abacb2",
  dLink: "#4d96ee",
  dButtonPrimary: "#5865f2",
  dButtonSecondary: "rgba(151,151,159,0.12)",
  dButtonSuccess: "#008545",
  dButtonDanger: "#d22d39",
  dMentionBg: "rgba(88,100,242,0.24)",
  dMentionText: "#a9bbff",
  dChannel: "#81828a",
  dInput: "rgba(0,0,0,0.12)",
  dDivider: "rgba(151,151,159,0.2)",
} as const;

export const FONT =
  '"Inter", "gg sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
export const MONO =
  'ui-monospace, "JetBrains Mono", "Fira Code", "SFMono-Regular", Menlo, Consolas, monospace';

export const FPS = 30;
