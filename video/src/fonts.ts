import { cancelRender, continueRender, delayRender, staticFile } from "remotion";

/**
 * Self-hosted fonts: renders never touch the network, and every frame waits
 * (delayRender) until the faces are loaded. The delayRender below runs at
 * module level, which is only safe because src/index.ts imports
 * `remotion/no-react` first — read the note there before moving either.
 *
 * The files in public/fonts are byte-for-byte the gstatic files that
 * @remotion/google-fonts loaded before (Inter v18, JetBrains Mono v20), and
 * the faces are declared exactly as it declared them: one FontFace per weight,
 * each with a single `weight` value, all pointing at the same variable file,
 * with Google's unicode-range per subset. That keeps rendering identical to
 * the approved v5 frames — including one quirk worth knowing: with
 * single-weight faces, weights between the declared ones SNAP to a declared
 * face (750 renders as 800, 850 as 900; see eng-fonts-01), so prefer weights
 * that are multiples of 100 in new code.
 *
 * Only the latin and latin-ext subsets are shipped: every character the film
 * sets in Inter lies in them (— … “ ” ’ · are in latin's U+2000–206F /
 * U+0000–00FF), and the other subsets (cyrillic, greek, vietnamese) cover no
 * character the film uses. Symbols outside every Inter subset — ↗ ✓ ✕ ✦ ▾ and
 * the emoji — fall back to the system font exactly as they did before; draw
 * them as SVG where cross-machine identity matters.
 *
 * Provenance (sha256):
 *   inter-v18-latin.woff2             fonts.gstatic.com/s/inter/v18/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2
 *                                     f052ee44c3728dfd23aba8a4567150bc314d23903026fbb6ad089422c2df56af
 *   inter-v18-latin-ext.woff2         fonts.gstatic.com/s/inter/v18/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa25L7SUc.woff2
 *                                     48f540fb71166bf65a0fe187a71fad500c43143d3e2e42038f527e38c786e90f
 *   jetbrains-mono-v20-latin.woff2    fonts.gstatic.com/s/jetbrainsmono/v20/tDbV2o-flEEny0FZhsfKu5WU4xD7OwE.woff2
 *                                     18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e
 *   jetbrains-mono-v20-latin-ext.woff2 fonts.gstatic.com/s/jetbrainsmono/v20/tDbV2o-flEEny0FZhsfKu5WU4xD1OwG_TA.woff2
 *                                     79bfdab9ba467e26eea4122e6f2567e188dd8a09a8c730d501fc487c4ab99c6e
 * Both families are SIL Open Font License 1.1 (notice embedded in the files).
 * Do not swap in rsms' InterVariable.woff2: it is a different build whose
 * metrics would move text, cursor targets and hold cuts.
 */

/** Google Fonts' unicode ranges for the two subsets we ship (identical for both families). */
const LATIN =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";
const LATIN_EXT =
  "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF";

type Subset = { url: string; unicodeRange: string };

const loading: Promise<void>[] = [];

/**
 * Register `family` as one FontFace per weight × subset, and hold rendering
 * until all of them have loaded. Returns the family name for `fontFamily`.
 */
const loadFamily = (family: string, weights: string[], subsets: Subset[]): string => {
  if (typeof FontFace === "undefined" || typeof document === "undefined") return family;
  const handle = delayRender(`Loading font ${family}`);
  const faces = weights.flatMap((weight) =>
    subsets.map(
      (s) =>
        new FontFace(family, `url(${s.url}) format('woff2')`, {
          weight,
          style: "normal",
          unicodeRange: s.unicodeRange,
        }),
    ),
  );
  loading.push(
    Promise.all(faces.map((face) => face.load()))
      .then(() => {
        for (const face of faces) document.fonts.add(face);
        continueRender(handle);
      })
      .catch((err) => cancelRender(err)),
  );
  return family;
};

export const INTER = loadFamily(
  "Inter",
  ["400", "500", "600", "700", "800", "900"],
  [
    { url: staticFile("fonts/inter-v18-latin-ext.woff2"), unicodeRange: LATIN_EXT },
    { url: staticFile("fonts/inter-v18-latin.woff2"), unicodeRange: LATIN },
  ],
);

export const JETBRAINS = loadFamily(
  "JetBrains Mono",
  ["400", "500", "700"],
  [
    { url: staticFile("fonts/jetbrains-mono-v20-latin-ext.woff2"), unicodeRange: LATIN_EXT },
    { url: staticFile("fonts/jetbrains-mono-v20-latin.woff2"), unicodeRange: LATIN },
  ],
);

/**
 * Settles once every face above is loaded and added to the document — for
 * code that MEASURES text (the caption track), which must not read the
 * fallback font's metrics. (Rendering itself already waits via delayRender.)
 */
export const FONTS_READY: Promise<void> = Promise.all(loading).then(() => undefined);
