import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadJetBrains } from "@remotion/google-fonts/JetBrainsMono";

export const { fontFamily: INTER } = loadInter("normal", {
  weights: ["400", "500", "600", "700", "800", "900"],
});

export const { fontFamily: JETBRAINS } = loadJetBrains("normal", {
  weights: ["400", "500", "700"],
});
