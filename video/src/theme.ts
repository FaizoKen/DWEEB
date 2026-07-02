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
  dBgTertiary: "#1e1f22",
  dText: "#dbdee1",
  dTextMuted: "#949ba4",
  dLink: "#00a8fc",
  dButtonPrimary: "#5865f2",
  dButtonSecondary: "#4e5058",
  dButtonSuccess: "#248046",
  dButtonDanger: "#da373c",
  dMentionBg: "rgba(88,101,242,0.3)",
  dMentionText: "#c9cdfb",
  dChannel: "#80848e",
  dInput: "#383a40",
  dDivider: "#3f4147",
} as const;

export const FONT =
  '"Inter", "gg sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
export const MONO =
  'ui-monospace, "JetBrains Mono", "Fira Code", "SFMono-Regular", Menlo, Consolas, monospace';

export const FPS = 30;
