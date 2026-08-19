import { GUIDES, LANDINGS } from "./guides";
import { ogCardSvg } from "./og-card";

export const OG_CARD_WIDTH = 1200;
export const OG_CARD_HEIGHT = 630;

const ACCENT_BLURPLE = 0x5865f2;

export interface OgCardSource {
  /** Site-root path, which also maps directly below `public/`. */
  assetPath: string;
  sourceSvg: string;
}

/**
 * Exact guide/landing SVG inputs, kept independent of Sharp so the SEO audit
 * can prove that committed cards still match their current page content.
 */
export function guideLandingOgSources(): OgCardSource[] {
  const sources: OgCardSource[] = GUIDES.map((guide) => ({
    assetPath: `/guides-og/${guide.slug}.png`,
    sourceSvg: ogCardSvg({
      title: guide.h1,
      category: guide.eyebrow.replace(" · ", " — "),
      accent: ACCENT_BLURPLE,
      kicker: "Fact-checked Discord guide · Editable examples in DWEEB",
    }),
  }));

  sources.push({
    assetPath: "/guides-og/guides.png",
    sourceSvg: ogCardSvg({
      title: "Discord Webhook Guides",
      category: `${GUIDES.length} practical guides`,
      accent: ACCENT_BLURPLE,
      kicker: "Components V2 · Setup · Conversion · Security · Editing",
    }),
  });

  for (const landing of LANDINGS) {
    sources.push({
      assetPath: `/landing-og/${landing.slug}.png`,
      sourceSvg: ogCardSvg({
        title: landing.h1,
        category: landing.ogCategory,
        accent: ACCENT_BLURPLE,
        kicker: landing.ogKicker,
      }),
    });
  }

  return sources;
}
