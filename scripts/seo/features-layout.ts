/**
 * HTML for the static feature pages: the per-feature page and the `/features`
 * index. Mirrors `layout.ts` (templates) and reuses its document shell, CSS,
 * breadcrumb and FAQ helpers, so the two sections look identical and ship the
 * same strict, script-free, inline-CSS pages.
 */

import { escapeHtml } from "./render-message";
import { SITE, type ResolvedSeo } from "./content";
import {
  attr,
  jsonLd,
  htmlDocument,
  breadcrumbLd,
  breadcrumbNav,
  faqSection,
  faqLd,
} from "./layout";
import {
  FEATURE_CATEGORIES,
  FEATURE_CATEGORY_BLURB,
  type ResolvedFeature,
} from "./features";

const FEATURES_INDEX_PATH = "/features/";
const FEATURES_INDEX_URL = `${SITE.origin}${FEATURES_INDEX_PATH}`;
const FEATURES_OG_INDEX = `${SITE.origin}/features-og/features.png`;

// ────────────────────────────────────────────────────────────────────────────
// Per-feature page
// ────────────────────────────────────────────────────────────────────────────

export function renderFeaturePage(
  feature: ResolvedFeature,
  previewHtml: string | null,
  relatedTemplates: ResolvedSeo[],
): string {
  const botBadge = feature.requiresBot
    ? `<span class="badge badge-bot" title="Needs a Discord bot or app">Needs a bot</span>`
    : `<span class="badge badge-ok">No bot needed</span>`;

  const botCallout = feature.requiresBot
    ? `<aside class="callout">
        <strong>This feature is interactive.</strong>
        Because it responds to clicks, a Discord bot or app must own the webhook. DWEEB detects this and walks you through pairing the message with the <strong>${escapeHtml(feature.h1)}</strong> plugin.
      </aside>`
    : "";

  const howItWorks = `<section class="block"><h2>How it works</h2>
    <ol class="steps">${feature.howItWorks
      .map((s) => `<li><strong>${escapeHtml(s.name)}.</strong> ${escapeHtml(s.text)}</li>`)
      .join("")}</ol></section>`;

  const configurable = `<section class="block"><h2>What you can set up</h2>
    <ul class="ticks">${feature.configurable.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul></section>`;

  const whenToUse = `<section class="block"><h2>When to use it</h2>
    <ul class="ticks">${feature.whenToUse.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul></section>`;

  const preview = previewHtml
    ? `<section class="preview-block" aria-label="Example message">
        <div class="preview-head">Example message</div>
        <div class="discord-frame">${previewHtml}</div>
      </section>`
    : "";

  const relatedSection = relatedTemplates.length
    ? `<section class="block"><h2>Templates that use this</h2>
        <p>Ready-made messages wired for ${escapeHtml(feature.h1)} — open one and customize it.</p>
        <div class="card-grid">${relatedTemplates
          .map(
            (r) =>
              `<a class="mini-card" href="${attr(r.path)}"><span class="mini-emoji" aria-hidden="true">${escapeHtml(r.emoji)}</span><span class="mini-body"><span class="mini-name">${escapeHtml(r.h1.replace(/ Template$/, ""))}</span><span class="mini-cat">${escapeHtml(r.category)}</span></span></a>`,
          )
          .join("")}</div></section>`
    : "";

  const body = `<main class="wrap">
    ${breadcrumbNav([
      { name: "Home", url: "/" },
      { name: "Features", url: FEATURES_INDEX_PATH },
      { name: feature.h1 },
    ])}
    <article>
      <header class="hero">
        <div class="hero-meta">
          <span class="chip">${escapeHtml(feature.emoji)} ${escapeHtml(feature.category)}</span>
          ${botBadge}
        </div>
        <h1>${escapeHtml(feature.h1)}</h1>
        <p class="lede">${escapeHtml(feature.tagline)} ${escapeHtml(feature.intro)}</p>
        <div class="cta-row">
          <a class="btn btn-primary" href="${attr(feature.appUrl)}">Open in DWEEB →</a>
          <a class="btn btn-ghost" href="${FEATURES_INDEX_PATH}">All features</a>
        </div>
      </header>

      ${botCallout}
      ${preview}

      ${howItWorks}
      ${configurable}
      ${whenToUse}

      <section class="cta-band">
        <h2>Try ${escapeHtml(feature.h1)}</h2>
        <p>Build it visually in DWEEB${feature.requiresBot ? ", attach the plugin," : ""} and send it to your server in minutes.</p>
        <a class="btn btn-primary btn-lg" href="${attr(feature.appUrl)}">Open DWEEB →</a>
      </section>

      ${faqSection(feature.resolvedFaq)}
      ${relatedSection}
    </article>
  </main>`;

  const softwareApp = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: `${feature.h1} — DWEEB`,
    description: feature.description,
    url: feature.url,
    image: feature.ogImage,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    inLanguage: "en",
    isAccessibleForFree: true,
    keywords: feature.resolvedKeywords.join(", "),
    isPartOf: { "@type": "WebSite", "@id": `${SITE.origin}/#website` },
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    author: { "@id": SITE.orgId },
    publisher: { "@id": SITE.orgId },
  };

  const howtoLd = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: `How to set up ${feature.h1} in Discord with DWEEB`,
    description: feature.description,
    image: feature.ogImage,
    totalTime: "PT5M",
    step: feature.howItWorks.map((s, i) => ({
      "@type": "HowToStep",
      position: i + 1,
      name: s.name,
      text: s.text,
    })),
  };

  return htmlDocument({
    title: feature.title,
    description: feature.description,
    canonical: feature.url,
    ogImage: feature.ogImage,
    keywords: feature.resolvedKeywords,
    ogType: "article",
    jsonLd: [
      jsonLd(
        breadcrumbLd([
          { name: "Home", url: `${SITE.origin}/` },
          { name: "Features", url: FEATURES_INDEX_URL },
          { name: feature.h1, url: feature.url },
        ]),
      ),
      jsonLd(softwareApp),
      jsonLd(howtoLd),
      jsonLd(faqLd(feature.resolvedFaq)),
    ],
    body,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// /features index
// ────────────────────────────────────────────────────────────────────────────

export function renderFeaturesIndexPage(all: ResolvedFeature[]): string {
  const title = `DWEEB Features — ${all.length} ways to do more in Discord | DWEEB`;
  const description = `Everything DWEEB can do beyond building a message: self roles, ticket support, giveaways, forms, auto-replies, scheduled posts, a webhook manager and more — all from the visual builder.`;

  const groups = FEATURE_CATEGORIES.map((cat) => ({
    cat,
    blurb: FEATURE_CATEGORY_BLURB[cat] ?? "",
    items: all.filter((f) => f.category === cat),
  })).filter((g) => g.items.length > 0);

  const groupsHtml = groups
    .map(
      (g) => `<section class="cat-block">
        <h2 class="cat-title">${escapeHtml(g.cat)}</h2>
        ${g.blurb ? `<p class="cat-blurb">${escapeHtml(g.blurb)}</p>` : ""}
        <div class="card-grid">${g.items
          .map(
            (f) =>
              `<a class="tpl-card" href="${attr(f.path)}">
                <span class="tpl-emoji" aria-hidden="true">${escapeHtml(f.emoji)}</span>
                <span class="tpl-name">${escapeHtml(f.h1)}</span>
                <span class="tpl-desc">${escapeHtml(f.tagline)}</span>
                ${f.requiresBot ? `<span class="badge badge-bot">Needs a bot</span>` : `<span class="badge badge-ok">No bot</span>`}
              </a>`,
          )
          .join("")}</div>
      </section>`,
    )
    .join("");

  const body = `<main class="wrap">
    ${breadcrumbNav([{ name: "Home", url: "/" }, { name: "Features" }])}
    <header class="hero">
      <span class="chip">⚙️ Features</span>
      <h1>DWEEB Features</h1>
      <p class="lede">DWEEB is more than a message builder. Add self-assignable roles, private support tickets, one-click giveaways, pop-up application forms, canned replies, scheduled posts and a built-in webhook manager — each one designed visually and attached to your message in a few clicks. Many need no bot at all.</p>
      <div class="cta-row">
        <a class="btn btn-primary" href="/">Open the builder →</a>
        <a class="btn btn-ghost" href="/templates/">Browse templates</a>
      </div>
    </header>
    ${groupsHtml}
  </main>`;

  const itemList = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "DWEEB Features",
    description,
    url: FEATURES_INDEX_URL,
    image: FEATURES_OG_INDEX,
    isPartOf: { "@type": "WebSite", "@id": `${SITE.origin}/#website` },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: all.length,
      itemListElement: all.map((f, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: f.url,
        name: f.h1,
      })),
    },
  };

  return htmlDocument({
    title,
    description,
    canonical: FEATURES_INDEX_URL,
    ogImage: FEATURES_OG_INDEX,
    ogType: "website",
    jsonLd: [
      jsonLd(
        breadcrumbLd([
          { name: "Home", url: `${SITE.origin}/` },
          { name: "Features", url: FEATURES_INDEX_URL },
        ]),
      ),
      jsonLd(itemList),
    ],
    body,
  });
}
