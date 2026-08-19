/** Render the long-form guide cluster and the core webhook-builder landing page. */

import { escapeHtml } from "./render-message";
import { SITE } from "./content";
import { GUIDES_LASTMOD, type GuidePage, type GuideSection, type LandingPage } from "./guides";
import { withClientParams } from "@/core/seo/clientParams";
import {
  attr,
  breadcrumbLd,
  breadcrumbNav,
  faqLd,
  faqSection,
  htmlDocument,
  jsonLd,
} from "./layout";

export const GUIDES_INDEX_PATH = "/guides/";
export const GUIDES_INDEX_URL = `${SITE.origin}${GUIDES_INDEX_PATH}`;
export const ABOUT_PATH = "/about/";
export const ABOUT_URL = `${SITE.origin}${ABOUT_PATH}`;
export const ABOUT_LASTMOD = "2026-08-20";

function trackedAppPath(path: string, type: "guide" | "landing", id: string): string {
  return withClientParams(path, { entry: `${type}:${id}` });
}

/**
 * Prose written for these pages is HTML-escaped, which used to make a
 * contextual internal link impossible — every landing and guide body could only
 * link through its nav, footer and card rings, so the pages that carry the most
 * on-topic copy passed no descriptive anchor text anywhere. This accepts one
 * markdown-style link form inside that copy.
 *
 * Escaping runs FIRST and is never relaxed: by the time this substitution sees
 * the string, any author-supplied `<`, `>`, `&` or quote is already an entity,
 * so nothing here can introduce markup. The href is additionally constrained to
 * a site-relative path from a conservative character class, so an external or
 * javascript: target cannot be expressed at all — an internal link is the only
 * thing this syntax can produce, which is also all the SEO audit will accept.
 */
const INLINE_LINK = /\[([^[\]]+)\]\((\/[A-Za-z0-9\-._~/]*)\)/g;

export function renderProse(text: string): string {
  return escapeHtml(text).replace(
    INLINE_LINK,
    (_match, label: string, href: string) => `<a href="${href}">${label}</a>`,
  );
}

function renderSections(sections: readonly GuideSection[]): string {
  return sections
    .map((section) => {
      const paragraphs = (section.paragraphs ?? [])
        .map((paragraph) => `<p>${renderProse(paragraph)}</p>`)
        .join("");
      const bullets = section.bullets?.length
        ? `<ul class="ticks">${section.bullets.map((item) => `<li>${renderProse(item)}</li>`).join("")}</ul>`
        : "";
      const code = section.code
        ? `<pre class="code-block"><code>${escapeHtml(section.code)}</code></pre>`
        : "";
      const table = section.table
        ? `<div class="table-scroll"><table><caption class="sr-only">${escapeHtml(section.heading)}</caption><thead><tr>${section.table.headers
            .map((cell) => `<th scope="col">${escapeHtml(cell)}</th>`)
            .join("")}</tr></thead><tbody>${section.table.rows
            .map((row) => `<tr>${row.map((cell) => `<td>${renderProse(cell)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table></div>`
        : "";
      return `<section class="block prose"><h2>${escapeHtml(section.heading)}</h2>${paragraphs}${bullets}${table}${code}</section>`;
    })
    .join("");
}

function productContext(guide: GuidePage): string {
  const embedGuide = guide.slug === "discord-embed-to-components-v2";
  const broadGuide = [
    "discord-components-v2",
    "discord-text-formatting",
    "discord-timestamp-format",
  ].includes(guide.slug);
  const href = embedGuide
    ? "/discord-embed-builder/"
    : broadGuide
      ? "/discord-message-builder/"
      : "/discord-webhook-builder/";
  const label = embedGuide
    ? "Discord embed builder"
    : broadGuide
      ? "Discord message builder"
      : "Discord webhook message builder";
  const detail = embedGuide
    ? "Paste legacy embed JSON, review the conversion report and adjust the Components V2 result."
    : broadGuide
      ? "Apply the reference in the visual editor and check the result in the live preview."
      : "Open the delivery workflow with validation, restore, update and scheduling available when relevant.";
  return `<aside class="callout callout-setup"><strong>Build this instead of translating it by hand.</strong> Use the <a href="${href}">${label}</a>. ${detail}</aside>`;
}

export function renderGuidePage(guide: GuidePage, all: GuidePage[]): string {
  const related = guide.related
    .map((slug) => all.find((candidate) => candidate.slug === slug))
    .filter((candidate): candidate is GuidePage => !!candidate);
  const cta = trackedAppPath(guide.ctaPath, "guide", guide.slug);
  const sources = `<section class="block sources"><h2>Primary sources</h2><ul>${guide.sources
    .map(
      (source) =>
        `<li><a href="${attr(source.url)}" rel="noopener noreferrer" target="_blank">${escapeHtml(source.label)}</a></li>`,
    )
    .join("")}</ul></section>`;
  const relatedHtml = related.length
    ? `<section class="block"><h2>Keep learning</h2><div class="card-grid">${related
        .map(
          (item) =>
            `<a class="mini-card" href="${attr(item.path)}"><span class="mini-emoji" aria-hidden="true">📘</span><span class="mini-body"><span class="mini-name">${escapeHtml(item.h1)}</span><span class="mini-cat">${escapeHtml(item.eyebrow)}</span></span></a>`,
        )
        .join("")}</div></section>`
    : "";

  const body = `<main id="main-content" class="wrap">
    ${breadcrumbNav([
      { name: "Home", url: "/" },
      { name: "Guides", url: GUIDES_INDEX_PATH },
      { name: guide.h1 },
    ])}
    <article>
      <header class="hero">
        <span class="chip">${escapeHtml(guide.eyebrow)}</span>
        <h1>${escapeHtml(guide.h1)}</h1>
        <p class="lede">${escapeHtml(guide.lede)}</p>
        <p class="byline">By <a href="${ABOUT_PATH}">Faizo</a> · Published ${guide.published} · Updated ${guide.modified} · Reviewed against primary Discord documentation</p>
        <div class="cta-row">
          <a class="btn btn-primary" href="${attr(cta)}" data-analytics="guide" data-analytics-id="${attr(guide.slug)}" data-analytics-location="hero">${escapeHtml(guide.ctaLabel)} →</a>
          <a class="btn btn-ghost" href="${GUIDES_INDEX_PATH}">All guides</a>
        </div>
      </header>
      ${renderSections(guide.sections)}
      ${productContext(guide)}
      <section class="cta-band">
        <h2>Put the guide into practice</h2>
        <p>Open the exact workflow in DWEEB. Nothing posts until you review and confirm it.</p>
        <a class="btn btn-primary btn-lg" href="${attr(cta)}" data-analytics="guide" data-analytics-id="${attr(guide.slug)}" data-analytics-location="body">${escapeHtml(guide.ctaLabel)} →</a>
      </section>
      ${sources}
      ${relatedHtml}
    </article>
  </main>`;

  const article = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    "@id": `${guide.url}#article`,
    headline: guide.h1,
    name: guide.title,
    description: guide.description,
    url: guide.url,
    mainEntityOfPage: { "@type": "WebPage", "@id": `${guide.url}#webpage` },
    image: { "@type": "ImageObject", url: guide.ogImage, width: 1200, height: 630 },
    datePublished: guide.published,
    dateModified: guide.modified,
    inLanguage: "en",
    keywords: guide.keywords.join(", "),
    author: { "@id": SITE.personId },
    publisher: { "@id": SITE.orgId },
    about: { "@id": SITE.appId },
    citation: guide.sources.map((source) => source.url),
  };

  return htmlDocument({
    title: guide.title,
    description: guide.description,
    canonical: guide.url,
    ogImage: guide.ogImage,
    imageAlt: `${guide.h1} — a practical DWEEB guide`,
    ogType: "article",
    pageType: "guide",
    pageId: guide.slug,
    publishedTime: guide.published,
    modifiedTime: guide.modified,
    section: "Discord webhook guides",
    jsonLd: [
      jsonLd(
        breadcrumbLd([
          { name: "Home", url: `${SITE.origin}/` },
          { name: "Guides", url: GUIDES_INDEX_URL },
          { name: guide.h1, url: guide.url },
        ]),
      ),
      jsonLd(article),
    ],
    body,
  });
}

export function renderGuidesIndexPage(all: GuidePage[]): string {
  const title = "Discord Webhook & Components V2 Guides | DWEEB";
  const description =
    "Practical Discord webhook guides: Components V2 JSON and limits, webhook setup and security, embed conversion, restoring and editing messages.";
  const cards = all
    .map(
      (guide) => `<a class="tpl-card" href="${attr(guide.path)}">
        <span class="tpl-emoji" aria-hidden="true">📘</span>
        <span class="tpl-name">${escapeHtml(guide.h1)}</span>
        <span class="tpl-desc">${escapeHtml(guide.description)}</span>
      </a>`,
    )
    .join("");
  const body = `<main id="main-content" class="wrap">
    ${breadcrumbNav([{ name: "Home", url: "/" }, { name: "Guides" }])}
    <header class="hero">
      <span class="chip">📘 Guides</span>
      <h1>Discord Webhook &amp; Components V2 Guides</h1>
      <p class="lede">Fact-checked, practical references built around the workflows DWEEB actually supports. Learn the current Discord model, see exact limits and payloads, then open the relevant example in the <a href="/discord-message-builder/">visual Discord message builder</a>.</p>
      <div class="cta-row"><a class="btn btn-primary" href="${attr(withClientParams("/", { entry: "guide:index" }))}" data-analytics="guide" data-analytics-id="index" data-analytics-location="hero">Open the builder →</a></div>
    </header>
    <section class="cat-block"><h2 class="cat-title">Start here</h2><div class="card-grid">${cards}</div></section>
    <section class="block prose"><h2>From reference to a real Discord post</h2><p>Every guide separates static incoming-webhook behavior from app-owned interactions and privileged bot actions. That distinction prevents the most common failure: designing a custom button for a destination that Discord will not allow to receive it.</p><p>Examples link into a matching builder state, so you can inspect the component tree, export JSON and test the result instead of translating an article by hand.</p></section>
  </main>`;
  const collection = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "@id": `${GUIDES_INDEX_URL}#webpage`,
    name: "Discord Webhook & Components V2 Guides",
    description,
    url: GUIDES_INDEX_URL,
    dateModified: GUIDES_LASTMOD,
    isPartOf: { "@id": SITE.websiteId },
    about: { "@id": SITE.appId },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: all.length,
      itemListElement: all.map((guide, index) => ({
        "@type": "ListItem",
        position: index + 1,
        url: guide.url,
        name: guide.h1,
      })),
    },
  };
  return htmlDocument({
    title,
    description,
    canonical: GUIDES_INDEX_URL,
    ogImage: `${SITE.origin}/guides-og/guides.png`,
    imageAlt: "DWEEB Discord webhook and Components V2 guide library",
    ogType: "website",
    pageType: "guide",
    pageId: "index",
    modifiedTime: GUIDES_LASTMOD,
    jsonLd: [
      jsonLd(
        breadcrumbLd([
          { name: "Home", url: `${SITE.origin}/` },
          { name: "Guides", url: GUIDES_INDEX_URL },
        ]),
      ),
      jsonLd(collection),
    ],
    body,
  });
}

export function renderLandingPage(page: LandingPage): string {
  const cta = trackedAppPath("/", "landing", page.slug);
  const productProof = page.productImage
    ? `<figure class="product-shot">
        <a href="${attr(cta)}" data-analytics="landing" data-analytics-id="${attr(page.slug)}" data-analytics-location="body" aria-label="Open the ${escapeHtml(page.h1)}">
          <img src="${attr(page.productImage.src)}"${page.productImage.srcSet ? ` srcset="${attr(page.productImage.srcSet)}"` : ""}${page.productImage.sizes ? ` sizes="${attr(page.productImage.sizes)}"` : ""} width="${page.productImage.width}" height="${page.productImage.height}" alt="${attr(page.productImage.alt)}" loading="eager" decoding="async" fetchpriority="high" />
        </a>
        <figcaption>${escapeHtml(page.productImage.caption)} <a href="${ABOUT_PATH}">See how preview fidelity is measured.</a></figcaption>
      </figure>`
    : "";
  const learnCards = page.learn
    .map(
      (card) =>
        `<a class="mini-card" href="${attr(card.href)}"><span class="mini-emoji" aria-hidden="true">${escapeHtml(card.emoji)}</span><span class="mini-body"><span class="mini-name">${escapeHtml(card.name)}</span><span class="mini-cat">${escapeHtml(card.desc)}</span></span></a>`,
    )
    .join("\n        ");
  const body = `<main id="main-content" class="wrap">
    ${breadcrumbNav([{ name: "Home", url: "/" }, { name: page.breadcrumb }])}
    <article>
      <header class="hero product-hero">
        <span class="chip">${escapeHtml(page.chip)}</span>
        <h1>${escapeHtml(page.h1)}</h1>
        <p class="lede">${escapeHtml(page.lede)}</p>
        <p class="byline">Built and maintained by <a href="${ABOUT_PATH}">Faizo</a> · Updated ${page.modified}</p>
        <div class="cta-row">
          <a class="btn btn-primary btn-lg" href="${attr(cta)}" data-analytics="landing" data-analytics-id="${attr(page.slug)}" data-analytics-location="hero">${escapeHtml(page.ctaLabel)} →</a>
          <a class="btn btn-ghost" href="/templates/">Browse templates</a>
        </div>
        <p class="cta-note">No account required for the core builder. Nothing posts until you confirm it.</p>
      </header>
      ${productProof}
      ${renderSections(page.sections)}
      ${page.faq?.length ? faqSection(page.faq) : ""}
      <section class="block sources"><h2>Documentation and testing</h2><ul>
        <li><a href="https://docs.discord.com/developers/components/reference" rel="noopener noreferrer" target="_blank">Discord message components reference</a></li>
        <li><a href="https://docs.discord.com/developers/resources/webhook" rel="noopener noreferrer" target="_blank">Discord webhook resource documentation</a></li>
        <li><a href="${ABOUT_PATH}">DWEEB preview and review methodology</a></li>
      </ul></section>
      <section class="block"><h2>Learn or start from a proven design</h2><div class="card-grid">
        ${learnCards}
      </div></section>
      <section class="cta-band"><h2>Build the message now</h2><p>Use the visual editor free, or start from an editable Components V2 template.</p><a class="btn btn-primary btn-lg" href="${attr(cta)}" data-analytics="landing" data-analytics-id="${attr(page.slug)}" data-analytics-location="body">Open DWEEB →</a></section>
    </article>
  </main>`;
  const webPage = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${page.url}#webpage`,
    name: page.title,
    headline: page.h1,
    description: page.description,
    url: page.url,
    dateModified: page.modified,
    inLanguage: "en",
    keywords: page.keywords.join(", "),
    isPartOf: { "@id": SITE.websiteId },
    mainEntity: { "@id": SITE.appId },
    author: { "@id": SITE.personId },
    publisher: { "@id": SITE.orgId },
    citation: [
      "https://docs.discord.com/developers/components/reference",
      "https://docs.discord.com/developers/resources/webhook",
      ABOUT_URL,
    ],
    ...(page.productImage
      ? {
          primaryImageOfPage: {
            "@type": "ImageObject",
            url: `${SITE.origin}${page.productImage.src}`,
            width: page.productImage.width,
            height: page.productImage.height,
            caption: page.productImage.caption,
          },
        }
      : {}),
  };
  return htmlDocument({
    title: page.title,
    description: page.description,
    canonical: page.url,
    ogImage: page.ogImage,
    imageAlt: page.imageAlt,
    ogType: "website",
    pageType: "landing",
    pageId: page.slug,
    modifiedTime: page.modified,
    jsonLd: [
      jsonLd(
        breadcrumbLd([
          { name: "Home", url: `${SITE.origin}/` },
          { name: page.breadcrumb, url: page.url },
        ]),
      ),
      jsonLd(webPage),
      ...(page.faq?.length ? [jsonLd(faqLd(page.faq))] : []),
    ],
    body,
  });
}

/** Crawlable authorship and first-hand testing evidence for every guide/product claim. */
export function renderAboutPage(): string {
  const cta = withClientParams("/", { entry: "about:index" });
  const title = "About DWEEB & Discord Preview Methodology | DWEEB";
  const description =
    "Meet the maintainer of DWEEB and see how its Discord message preview, payload validation, documentation and privacy claims are tested and reviewed.";
  const body = `<main id="main-content" class="wrap">
    ${breadcrumbNav([{ name: "Home", url: "/" }, { name: "About DWEEB" }])}
    <article>
      <header class="hero">
        <span class="chip">About · Testing methodology</span>
        <h1>About DWEEB and how it is tested</h1>
        <p class="lede">DWEEB is built and maintained by Faizo as a source-available visual Discord message builder. This page documents the hands-on checks behind its preview, validation and publishing guidance.</p>
        <p class="byline">By <strong>Faizo</strong> · Methodology last reviewed ${ABOUT_LASTMOD}</p>
        <div class="cta-row">
          <a class="btn btn-primary" href="${attr(cta)}" data-analytics="about" data-analytics-id="index" data-analytics-location="hero">Open the Discord message builder →</a>
          <a class="btn btn-ghost" href="${SITE.githubUrl}" rel="noopener noreferrer" target="_blank">Inspect the source</a>
        </div>
      </header>

      <section class="block prose">
        <h2>Who makes DWEEB</h2>
        <p>Faizo designs, develops and maintains the editor, its Discord Activity, the delivery service and the public guides. Product claims are tied to workflows that exist in the shipped application. The repository exposes the implementation, issue history and automated tests so technical statements can be checked rather than taken on trust.</p>
        <p>DWEEB is an independent project and is not affiliated with Discord Inc. Discord is the authority for API behavior; the editor translates that behavior into a visual workflow and links to primary Discord documentation where a guide depends on it.</p>
      </section>

      <section class="block prose">
        <h2>How preview fidelity is measured</h2>
        <p>The preview is calibrated against the live Discord web client, not styled from memory. A representative Components V2 payload is built in DWEEB, posted to a private test channel, and compared with the same message in the editor. Colors, spacing, typography, button geometry, containers and media-gallery layouts are checked from Discord's rendered DOM and computed styles.</p>
        <ol class="steps">
          <li><strong>Use the same payload.</strong> Build representative text, container, section, media, button and select-menu cases.</li>
          <li><strong>Render it in Discord.</strong> Send the payload through the documented webhook API and inspect the current desktop and narrow layouts.</li>
          <li><strong>Measure, then implement.</strong> Record computed values and image geometry before updating preview tokens or layout rules.</li>
          <li><strong>Protect known behavior.</strong> Regression tests cover Discord-specific markdown, payload normalization, limits, conversion and component validation.</li>
        </ol>
        <p>A browser preview can still differ in native emoji artwork, fonts installed on the device and changes Discord rolls out after the latest review. Those boundaries are treated as limitations to re-test, not reasons to claim perfect equivalence without evidence.</p>
      </section>

      <section class="block prose">
        <h2>How product and guide claims are reviewed</h2>
        <p>Guides begin with Discord's developer documentation and are checked against the editor's actual import, validation, send, restore and update paths. Dates on a page change only after a substantive content review. Security and privacy copy distinguishes local browser data from optional connected services, and the <a href="/privacy">Privacy Policy</a> lists those boundaries.</p>
        <p>Errors and edge cases are tested before release through TypeScript checks, unit tests, generated validation corpora shared with the server, a production build and a post-generation SEO audit. The audit checks canonical URLs, sitemap coverage, metadata, structured data, internal links, content depth and social assets across every indexable page.</p>
      </section>

      <section class="block sources">
        <h2>Verify the work</h2>
        <ul>
          <li><a href="https://docs.discord.com/developers/components/reference" rel="noopener noreferrer" target="_blank">Discord message components reference</a></li>
          <li><a href="https://docs.discord.com/developers/resources/webhook" rel="noopener noreferrer" target="_blank">Discord webhook resource documentation</a></li>
          <li><a href="${SITE.githubUrl}" rel="noopener noreferrer" target="_blank">DWEEB source and test history on GitHub</a></li>
          <li><a href="/guides/">DWEEB's reviewed Discord guides</a></li>
        </ul>
      </section>

      <section class="cta-band">
        <h2>Try the measured workflow</h2>
        <p>Build a real message, inspect the live preview and keep the JSON or send only when you confirm.</p>
        <a class="btn btn-primary btn-lg" href="${attr(cta)}" data-analytics="about" data-analytics-id="index" data-analytics-location="body">Open DWEEB →</a>
      </section>
    </article>
  </main>`;
  const profile = {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    "@id": `${ABOUT_URL}#webpage`,
    name: "About DWEEB and how it is tested",
    description,
    url: ABOUT_URL,
    dateModified: ABOUT_LASTMOD,
    inLanguage: "en",
    isPartOf: { "@id": SITE.websiteId },
    mainEntity: { "@id": SITE.personId },
    about: { "@id": SITE.appId },
  };
  return htmlDocument({
    title,
    description,
    canonical: ABOUT_URL,
    ogImage: SITE.ogImage,
    imageAlt: "DWEEB visual Discord message builder",
    ogType: "website",
    pageType: "about",
    pageId: "index",
    modifiedTime: ABOUT_LASTMOD,
    jsonLd: [
      jsonLd(
        breadcrumbLd([
          { name: "Home", url: `${SITE.origin}/` },
          { name: "About DWEEB", url: ABOUT_URL },
        ]),
      ),
      jsonLd(profile),
    ],
    body,
  });
}
