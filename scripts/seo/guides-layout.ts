/** Render the long-form guide cluster and the core webhook-builder landing page. */

import { escapeHtml } from "./render-message";
import { SITE } from "./content";
import { GUIDES_LASTMOD, type GuidePage, type GuideSection, type LandingPage } from "./guides";
import { attr, breadcrumbLd, breadcrumbNav, htmlDocument, jsonLd } from "./layout";

export const GUIDES_INDEX_PATH = "/guides/";
export const GUIDES_INDEX_URL = `${SITE.origin}${GUIDES_INDEX_PATH}`;

function trackedAppPath(path: string, type: "guide" | "landing", id: string): string {
  const url = new URL(path, SITE.origin);
  if (!url.searchParams.has("entry")) url.searchParams.set("entry", `${type}:${id}`);
  return url.pathname + url.search + url.hash;
}

function renderSections(sections: readonly GuideSection[]): string {
  return sections
    .map((section) => {
      const paragraphs = (section.paragraphs ?? [])
        .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
        .join("");
      const bullets = section.bullets?.length
        ? `<ul class="ticks">${section.bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
        : "";
      const code = section.code
        ? `<pre class="code-block"><code>${escapeHtml(section.code)}</code></pre>`
        : "";
      const table = section.table
        ? `<div class="table-scroll"><table><thead><tr>${section.table.headers
            .map((cell) => `<th scope="col">${escapeHtml(cell)}</th>`)
            .join("")}</tr></thead><tbody>${section.table.rows
            .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table></div>`
        : "";
      return `<section class="block prose"><h2>${escapeHtml(section.heading)}</h2>${paragraphs}${bullets}${table}${code}</section>`;
    })
    .join("");
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
        <p class="byline">Published ${guide.published} · Updated ${guide.modified} · Reviewed against primary Discord documentation</p>
        <div class="cta-row">
          <a class="btn btn-primary" href="${attr(cta)}" data-analytics="guide" data-analytics-id="${attr(guide.slug)}" data-analytics-location="hero">${escapeHtml(guide.ctaLabel)} →</a>
          <a class="btn btn-ghost" href="${GUIDES_INDEX_PATH}">All guides</a>
        </div>
      </header>
      ${renderSections(guide.sections)}
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
      <p class="lede">Fact-checked, practical references built around the workflows DWEEB actually supports. Learn the current Discord model, see exact limits and payloads, then open the relevant example in the visual editor.</p>
      <div class="cta-row"><a class="btn btn-primary" href="/?entry=guide%3Aindex" data-analytics="guide" data-analytics-id="index" data-analytics-location="hero">Open the builder →</a></div>
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
  const learnCards = page.learn
    .map(
      (card) =>
        `<a class="mini-card" href="${attr(card.href)}"><span class="mini-emoji">${escapeHtml(card.emoji)}</span><span class="mini-body"><span class="mini-name">${escapeHtml(card.name)}</span><span class="mini-cat">${escapeHtml(card.desc)}</span></span></a>`,
    )
    .join("\n        ");
  const body = `<main id="main-content" class="wrap">
    ${breadcrumbNav([{ name: "Home", url: "/" }, { name: page.breadcrumb }])}
    <article>
      <header class="hero product-hero">
        <span class="chip">${escapeHtml(page.chip)}</span>
        <h1>${escapeHtml(page.h1)}</h1>
        <p class="lede">${escapeHtml(page.lede)}</p>
        <div class="cta-row">
          <a class="btn btn-primary btn-lg" href="${attr(cta)}" data-analytics="landing" data-analytics-id="${attr(page.slug)}" data-analytics-location="hero">${escapeHtml(page.ctaLabel)} →</a>
          <a class="btn btn-ghost" href="/templates/">Browse templates</a>
        </div>
        <p class="cta-note">No account required for the core builder. Nothing posts until you confirm it.</p>
      </header>
      ${renderSections(page.sections)}
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
    dateModified: GUIDES_LASTMOD,
    inLanguage: "en",
    keywords: page.keywords.join(", "),
    isPartOf: { "@id": SITE.websiteId },
    mainEntity: { "@id": SITE.appId },
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
    modifiedTime: GUIDES_LASTMOD,
    jsonLd: [
      jsonLd(
        breadcrumbLd([
          { name: "Home", url: `${SITE.origin}/` },
          { name: page.breadcrumb, url: page.url },
        ]),
      ),
      jsonLd(webPage),
    ],
    body,
  });
}
