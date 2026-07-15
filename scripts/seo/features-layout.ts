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
  FEATURES_LASTMOD,
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
  const ctaLabels: Record<string, string> = {
    "self-role": "Create a self-role menu",
    tickets: "Build a ticket panel",
    "quick-replies": "Build an FAQ button",
    "modal-form": "Create a Discord form",
    giveaway: "Create a giveaway",
    picker: "Build a select menu",
    "ping-pong": "Choose a message to start",
    "scheduled-posts": "Schedule a message",
    "webhook-manager": "Manage webhooks",
    "ai-assistant": "Draft with AI",
  };
  const ctaLabel = ctaLabels[feature.id] ?? "Build this in DWEEB";
  const deliveryBadge =
    feature.deliveryMode === "bot-install"
      ? `<span class="badge badge-bot" title="Installs a Discord app for privileged actions">Bot install required</span>`
      : feature.deliveryMode === "app-owned"
        ? `<span class="badge badge-setup" title="DWEEB hosts the interaction through an app-owned webhook">App-owned webhook</span>`
        : `<span class="badge badge-ok">No bot needed</span>`;
  const setupBadge = feature.setupNote
    ? `<span class="badge badge-setup">${escapeHtml(feature.setupNote.badge)}</span>`
    : "";
  const botBadge = `${deliveryBadge}${setupBadge}`;

  const deliveryCallout =
    feature.deliveryMode === "bot-install"
      ? `<aside class="callout">
        <strong>This feature is interactive.</strong>
        Its privileged actions require a Discord app installation and an app-owned webhook. DWEEB detects the component and walks you through pairing it with the <strong>${escapeHtml(feature.h1)}</strong> plugin.
      </aside>`
      : feature.deliveryMode === "app-owned"
        ? `<aside class="callout callout-setup">
        <strong>DWEEB hosts the click handler.</strong>
        Discord requires interactive components to use an app-owned webhook. DWEEB creates the compatible destination during setup; you do not install a server bot or host code yourself.
      </aside>`
        : "";
  const prerequisiteCallout = feature.setupNote
    ? `<aside class="callout callout-setup">
        <strong>${escapeHtml(feature.setupNote.title)}</strong>
        ${escapeHtml(feature.setupNote.text)}
      </aside>`
    : "";
  const botCallout = `${deliveryCallout}${prerequisiteCallout}`;

  const howItWorks = `<section class="block"><h2>How it works</h2>
    <ol class="steps">${feature.howItWorks
      .map((s) => `<li><strong>${escapeHtml(s.name)}.</strong> ${escapeHtml(s.text)}</li>`)
      .join("")}</ol></section>`;

  const configurable = `<section class="block"><h2>What you can set up</h2>
    <ul class="ticks">${feature.configurable.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul></section>`;

  const whenToUse = `<section class="block"><h2>When to use it</h2>
    <ul class="ticks">${feature.whenToUse.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul></section>`;

  const ctaInstructions = feature.previewTemplateId
    ? `Build it visually in DWEEB${feature.deliveryMode !== "plain" ? ", complete the guided interaction setup," : ""} and send it to your server in minutes.`
    : feature.pluginId
      ? "Choose a starting message, add a compatible control, then attach the hosted plugin from its Action panel."
      : feature.setupNote
        ? "Open the visual editor, connect your chosen provider, and generate an editable draft."
        : "Open the visual editor and continue directly into this workflow.";

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

  const body = `<main id="main-content" class="wrap">
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
          <a class="btn btn-primary" href="${attr(feature.appUrl)}" data-analytics="feature" data-analytics-id="${attr(feature.slug)}" data-analytics-location="hero">${escapeHtml(ctaLabel)} →</a>
          <a class="btn btn-ghost" href="${FEATURES_INDEX_PATH}">All features</a>
        </div>
        <p class="cta-note">Nothing is posted until you review the message and confirm it.</p>
      </header>

      ${botCallout}
      ${preview}

      ${howItWorks}
      ${configurable}
      ${whenToUse}

      <section class="cta-band">
        <h2>Try ${escapeHtml(feature.h1)}</h2>
        <p>${escapeHtml(ctaInstructions)}</p>
        <a class="btn btn-primary btn-lg" href="${attr(feature.appUrl)}" data-analytics="feature" data-analytics-id="${attr(feature.slug)}" data-analytics-location="body">${escapeHtml(ctaLabel)} →</a>
      </section>

      ${faqSection(feature.resolvedFaq)}
      ${relatedSection}
    </article>
  </main>`;

  const webPage = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${feature.url}#webpage`,
    name: feature.title,
    headline: feature.h1,
    description: feature.description,
    url: feature.url,
    primaryImageOfPage: {
      "@type": "ImageObject",
      url: feature.ogImage,
      width: 1200,
      height: 630,
    },
    dateModified: FEATURES_LASTMOD,
    inLanguage: "en",
    keywords: feature.resolvedKeywords.join(", "),
    isPartOf: { "@type": "WebSite", "@id": SITE.websiteId },
    about: { "@id": SITE.appId },
  };

  return htmlDocument({
    title: feature.title,
    description: feature.description,
    canonical: feature.url,
    ogImage: feature.ogImage,
    imageAlt: `${feature.h1} configured visually in DWEEB for Discord`,
    ogType: "article",
    pageType: "feature",
    pageId: feature.slug,
    modifiedTime: FEATURES_LASTMOD,
    section: feature.category,
    jsonLd: [
      jsonLd(
        breadcrumbLd([
          { name: "Home", url: `${SITE.origin}/` },
          { name: "Features", url: FEATURES_INDEX_URL },
          { name: feature.h1, url: feature.url },
        ]),
      ),
      jsonLd(webPage),
      jsonLd(faqLd(feature.resolvedFaq)),
    ],
    body,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// /features index
// ────────────────────────────────────────────────────────────────────────────

export function renderFeaturesIndexPage(all: ResolvedFeature[]): string {
  const title = `Discord Webhook Tools — Bots, Forms & Scheduling | DWEEB`;
  const description = `Add self roles, tickets, giveaways, forms, replies, scheduling and webhook management to messages you design visually in DWEEB.`;

  const groups = FEATURE_CATEGORIES.map((cat) => ({
    cat,
    blurb: FEATURE_CATEGORY_BLURB[cat] ?? "",
    items: all.filter((f) => f.category === cat),
  })).filter((g) => g.items.length > 0);
  const ordered = groups.flatMap((group) => group.items);

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
                ${
                  f.setupNote
                    ? `<span class="badge badge-setup">${escapeHtml(f.setupNote.badge)}</span>`
                    : f.deliveryMode === "bot-install"
                      ? `<span class="badge badge-bot">Bot install</span>`
                      : f.deliveryMode === "app-owned"
                        ? `<span class="badge badge-setup">App-owned webhook</span>`
                        : `<span class="badge badge-ok">No bot</span>`
                }
              </a>`,
          )
          .join("")}</div>
      </section>`,
    )
    .join("");

  const body = `<main id="main-content" class="wrap">
    ${breadcrumbNav([{ name: "Home", url: "/" }, { name: "Features" }])}
    <header class="hero">
      <span class="chip">⚙️ Features</span>
      <h1>Discord Webhook Tools &amp; Features</h1>
      <p class="lede">DWEEB is more than a message builder. Add self-assignable roles, private support tickets, one-click giveaways, pop-up application forms, hosted replies, scheduled posts and a built-in webhook manager. Every page identifies whether it uses a normal webhook, an app-owned destination or an installed app.</p>
      <div class="cta-row">
        <a class="btn btn-primary" href="/?entry=feature%3Aindex" data-analytics="feature" data-analytics-id="index" data-analytics-location="hero">Open the builder →</a>
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
      itemListElement: ordered.map((f, i) => ({
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
    imageAlt: `${all.length} Discord webhook tools and interactive message features in DWEEB`,
    ogType: "website",
    pageType: "feature",
    pageId: "index",
    modifiedTime: FEATURES_LASTMOD,
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
