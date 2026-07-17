/**
 * HTML for the static template pages: the per-template page, the `/templates`
 * index, and the shared (inlined) stylesheet.
 *
 * The content is pure pre-rendered HTML + inline CSS, so it is fast and fully
 * crawlable without JavaScript. The only script is the site's small deferred,
 * privacy-gated analytics loader; no application bundle ships on these pages.
 */

import { TEMPLATE_CATEGORIES } from "@/data/presets";
import { escapeHtml } from "./render-message";
import {
  CATEGORY_BLURB,
  SITE,
  TEMPLATES_LASTMOD,
  TEMPLATES_OG_INDEX,
  type FaqEntry,
  type ResolvedSeo,
} from "./content";
import type { ResolvedFeature } from "./features";

const TEMPLATES_INDEX_PATH = "/templates/";
const TEMPLATES_INDEX_URL = `${SITE.origin}${TEMPLATES_INDEX_PATH}`;

/** Escape for an HTML attribute value (double-quoted). */
export function attr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

/** Serialize a JSON-LD object, neutralising any `</script>` break-out. */
export function jsonLd(data: unknown): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}

/**
 * The site's publisher identity graph, emitted on every generated page.
 *
 * The template/feature pages reference `SITE.orgId` and `#website` as `publisher`
 * / `author` / `isPartOf`, but nothing here used to *define* those nodes — the
 * `@id`s dangled, so the only place they resolved was whatever Google inferred
 * from the URL. Defining them inline keeps the whole site pointing at one
 * consistent "DWEEB" entity that lives on dweeb.faizo.net, instead of letting the
 * resolution fall through to the parent domain (which redirects to GitHub — the
 * reason Search once printed "GitHub" as our site name). The canonical
 * WebApplication entity is fully defined once on `/`; page-level `about`
 * properties reference its stable @id instead of publishing a second,
 * conflicting offer graph on every URL.
 */
export function identityLd(): object[] {
  return [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "@id": SITE.websiteId,
      name: SITE.name,
      alternateName: ["DWEEB — Discord Webhook Embed Builder", "Discord Webhook Embed Builder"],
      url: `${SITE.origin}/`,
      inLanguage: "en",
      publisher: { "@id": SITE.orgId },
    },
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": SITE.orgId,
      name: SITE.name,
      url: `${SITE.origin}/`,
      logo: {
        "@type": "ImageObject",
        url: `${SITE.origin}/icon-512.png`,
        width: 512,
        height: 512,
      },
      founder: { "@id": SITE.personId },
    },
    {
      "@context": "https://schema.org",
      "@type": "Person",
      "@id": SITE.personId,
      name: "Faizo",
      url: `${SITE.origin}/`,
    },
  ];
}

const HOWTO_START = [
  {
    name: "Open it in DWEEB",
    text: "Click “Open in DWEEB” to load the template into the visual editor — no sign-up, no install.",
  },
  {
    name: "Make it yours",
    text: "Edit the text, colours, emoji, links and images to match your server. The live preview updates as you type.",
  },
];

function howToSteps(seo: ResolvedSeo): { name: string; text: string }[] {
  const destination =
    seo.deliveryMode === "app-owned"
      ? {
          name: "Connect an app-owned destination",
          text: `Follow DWEEB's guided setup for ${seo.pairsWith ?? "the matching plugin"}, then choose a connected server and channel. Discord rejects interactive components on person-created webhooks.`,
        }
      : seo.deliveryMode === "external-link"
        ? {
            name: "Finish the linked-service setup",
            text: `Configure ${seo.pairsWith ?? "the external integration"} for your server when DWEEB opens its setup step, then choose any Discord webhook as the destination.`,
          }
        : {
            name: "Paste your webhook URL",
            text: "In Discord, go to Server Settings → Integrations → Webhooks, copy a webhook URL, and paste it into DWEEB.",
          };
  return [
    ...HOWTO_START,
    destination,
    {
      name: "Send it",
      text: "Review the live preview, then hit Send. You can also save it, share it as a link, schedule it, or export the message JSON.",
    },
  ];
}

/**
 * Wrap a head/body in the shared document shell: meta, canonical, OG/Twitter,
 * favicons, CSP, and the inlined stylesheet.
 */
export function htmlDocument(opts: {
  title: string;
  description: string;
  canonical: string;
  ogImage: string;
  imageAlt: string;
  ogType: "article" | "website";
  pageType: "template" | "feature" | "guide" | "landing";
  pageId: string;
  publishedTime?: string;
  modifiedTime?: string;
  section?: string;
  jsonLd: string[];
  body: string;
}): string {
  const csp = [
    "default-src 'self'",
    "img-src 'self' https: data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' https://www.googletagmanager.com",
    "connect-src https://www.google-analytics.com https://analytics.google.com https://region1.google-analytics.com",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
  const entry = encodeURIComponent(`${opts.pageType}:${opts.pageId}`);
  const builderUrl = `/?entry=${entry}`;

  return `<!doctype html>
<html lang="en" data-page-type="${attr(opts.pageType)}" data-page-id="${attr(opts.pageId)}">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${attr(csp)}" />
    <meta name="referrer" content="strict-origin-when-cross-origin" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#1e1f22" />
    <meta name="color-scheme" content="dark" />

    <title>${escapeHtml(opts.title)}</title>
    <meta name="description" content="${attr(opts.description)}" />
    <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" />
    <link rel="canonical" href="${attr(opts.canonical)}" />
    <link rel="alternate" hreflang="en" href="${attr(opts.canonical)}" />
    <link rel="alternate" hreflang="x-default" href="${attr(opts.canonical)}" />

    <meta property="og:type" content="${opts.ogType}" />
    <meta property="og:site_name" content="${SITE.name}" />
    <meta property="og:locale" content="en_US" />
    <meta property="og:title" content="${attr(opts.title)}" />
    <meta property="og:description" content="${attr(opts.description)}" />
    <meta property="og:url" content="${attr(opts.canonical)}" />
    <meta property="og:image" content="${attr(opts.ogImage)}" />
    <meta property="og:image:secure_url" content="${attr(opts.ogImage)}" />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="${attr(opts.imageAlt)}" />
    ${opts.ogType === "article" && opts.publishedTime ? `<meta property="article:published_time" content="${attr(opts.publishedTime)}" />` : ""}
    ${opts.ogType === "article" && opts.modifiedTime ? `<meta property="article:modified_time" content="${attr(opts.modifiedTime)}" />` : ""}
    ${opts.ogType === "article" && opts.section ? `<meta property="article:section" content="${attr(opts.section)}" />` : ""}
    ${opts.ogType === "website" && opts.modifiedTime ? `<meta property="og:updated_time" content="${attr(opts.modifiedTime)}" />` : ""}
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${attr(opts.title)}" />
    <meta name="twitter:description" content="${attr(opts.description)}" />
    <meta name="twitter:image" content="${attr(opts.ogImage)}" />
    <meta name="twitter:image:alt" content="${attr(opts.imageAlt)}" />

    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
    <script defer src="/gtag-init.js"></script>

    ${[...identityLd().map(jsonLd), ...opts.jsonLd].join("\n    ")}
    <style>${PAGE_CSS}</style>
  </head>
  <body>
    <a class="skip-link" href="#main-content">Skip to content</a>
    <header class="site">
      <a class="brand" href="/" aria-label="DWEEB home">DWEEB</a>
      <nav class="site-nav">
        <a href="/discord-webhook-builder/">Builder</a>
        <a href="/features/">Features</a>
        <a href="${TEMPLATES_INDEX_PATH}">Templates</a>
        <a href="/guides/">Guides</a>
        <a class="nav-cta" href="${builderUrl}" data-analytics="${attr(opts.pageType)}" data-analytics-id="${attr(opts.pageId)}" data-analytics-location="nav">Open the builder</a>
      </nav>
    </header>
    ${opts.body}
    <footer class="site-footer">
      <p>
        <strong>DWEEB</strong> — the free visual Discord webhook &amp; embed builder for Components V2.
        Build, preview and send rich messages in a local-by-default editor. No account is required for the core builder.
      </p>
      <p class="muted">
        <a href="${builderUrl}" data-analytics="${attr(opts.pageType)}" data-analytics-id="${attr(opts.pageId)}" data-analytics-location="footer">Open the builder</a> ·
        <a href="/discord-webhook-builder/">Webhook builder</a> ·
        <a href="/discord-embed-builder/">Embed builder</a> ·
        <a href="/features/">Features</a> ·
        <a href="${TEMPLATES_INDEX_PATH}">All templates</a> ·
        <a href="/guides/">Guides</a> ·
        <a href="/privacy">Privacy</a> ·
        <a href="/terms">Terms</a> ·
        <a href="${SITE.githubUrl}" rel="noopener" target="_blank">GitHub</a>
      </p>
    </footer>
  </body>
</html>`;
}

export function breadcrumbLd(trail: { name: string; url: string }[]): object {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((t, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: t.name,
      item: t.url,
    })),
  };
}

export function breadcrumbNav(trail: { name: string; url?: string }[]): string {
  const parts = trail.map((t, i) => {
    const last = i === trail.length - 1;
    const label = escapeHtml(t.name);
    const node =
      last || !t.url
        ? `<span aria-current="page">${label}</span>`
        : `<a href="${attr(t.url)}">${label}</a>`;
    return node;
  });
  return `<nav class="crumbs" aria-label="Breadcrumb">${parts.join('<span class="crumb-sep" aria-hidden="true">›</span>')}</nav>`;
}

export function faqSection(faq: FaqEntry[]): string {
  const items = faq
    .map(
      (f) =>
        `<details class="faq-item"><summary>${escapeHtml(f.q)}</summary><div class="faq-a"><p>${escapeHtml(f.a)}</p></div></details>`,
    )
    .join("");
  return `<section class="block"><h2>Frequently asked questions</h2>${items}</section>`;
}

export function faqLd(faq: FaqEntry[]): object {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Per-template page
// ────────────────────────────────────────────────────────────────────────────

export function renderTemplatePage(
  seo: ResolvedSeo,
  messageHtml: string,
  related: ResolvedSeo[],
  relatedFeatures: ResolvedFeature[],
): string {
  const botBadge =
    seo.deliveryMode === "app-owned"
      ? `<span class="badge badge-bot" title="Discord requires an application-owned webhook">App-owned webhook required</span>`
      : seo.deliveryMode === "external-link"
        ? `<span class="badge badge-setup">${escapeHtml(seo.pairsWith ?? "Integration")} setup required</span>`
        : `<span class="badge badge-ok">Works with any webhook</span>`;

  const botCallout =
    seo.deliveryMode === "app-owned"
      ? `<aside class="callout">
        <strong>This message needs an application-owned webhook.</strong>
        It contains an interactive ${seo.pairsWith ? `${escapeHtml(seo.pairsWith)} ` : ""}button or menu. Discord rejects interactive components on a person-created webhook; DWEEB walks you through connecting a compatible destination and configuring the ${seo.pairsWith ? `<strong>${escapeHtml(seo.pairsWith)}</strong>` : "matching"} plugin before send.
      </aside>`
      : seo.deliveryMode === "external-link"
        ? `<aside class="callout callout-setup">
        <strong>Set up ${escapeHtml(seo.pairsWith ?? "the linked service")} first.</strong>
        The message itself works with any Discord webhook, but the linked action depends on an external integration. DWEEB opens the required server setup when you choose this template.
      </aside>`
        : "";

  const whenToUse = `<section class="block"><h2>When to use it</h2><ul class="ticks">${seo.whenToUse
    .map((w) => `<li>${escapeHtml(w)}</li>`)
    .join("")}</ul></section>`;

  const whatsInside = `<section class="block"><h2>What's inside</h2>
    <p>Built with Discord's <a href="/guides/discord-components-v2/">Components V2 layout system</a>:</p>
    <ul class="chips">${seo.componentKinds.map((k) => `<li>${escapeHtml(k)}</li>`).join("")}</ul></section>`;

  const tips = `<section class="block"><h2>Tips</h2><ul class="ticks">${seo.tips
    .map((t) => `<li>${escapeHtml(t)}</li>`)
    .join("")}</ul></section>`;

  const steps = howToSteps(seo);
  const howto = `<section class="block"><h2>How to use this template</h2>
    <ol class="steps">${steps.map((s) => `<li><strong>${escapeHtml(s.name)}.</strong> ${escapeHtml(s.text)}</li>`).join("")}</ol></section>`;

  const relatedSection = related.length
    ? `<section class="block"><h2>Related templates</h2><div class="card-grid">${related
        .map(
          (r) =>
            `<a class="mini-card" href="${attr(r.path)}"><span class="mini-emoji" aria-hidden="true">${escapeHtml(r.emoji)}</span><span class="mini-body"><span class="mini-name">${escapeHtml(r.h1.replace(/ Template$/, ""))}</span><span class="mini-cat">${escapeHtml(r.category)}</span></span></a>`,
        )
        .join("")}</div></section>`
    : "";
  const featureSection = relatedFeatures.length
    ? `<section class="block"><h2>Set up the interaction</h2><p>This template is already paired with the matching DWEEB workflow:</p><div class="card-grid">${relatedFeatures
        .map(
          (feature) =>
            `<a class="mini-card" href="${attr(feature.path)}"><span class="mini-emoji" aria-hidden="true">${escapeHtml(feature.emoji)}</span><span class="mini-body"><span class="mini-name">${escapeHtml(feature.h1)}</span><span class="mini-cat">Setup, permissions and working example</span></span></a>`,
        )
        .join("")}</div></section>`
    : "";

  const body = `<main id="main-content" class="wrap">
    ${breadcrumbNav([
      { name: "Home", url: "/" },
      { name: "Templates", url: TEMPLATES_INDEX_PATH },
      { name: seo.h1 },
    ])}
    <article>
      <header class="hero">
        <div class="hero-meta">
          <span class="chip">${escapeHtml(seo.emoji)} ${escapeHtml(seo.category)}</span>
          ${botBadge}
        </div>
        <h1>${escapeHtml(seo.h1)}</h1>
        <p class="lede">${escapeHtml(seo.intro)}</p>
        <div class="cta-row">
          <a class="btn btn-primary" href="${attr(seo.appUrl)}" data-analytics="template" data-analytics-id="${attr(seo.slug)}" data-analytics-location="hero">Use this template free →</a>
          <a class="btn btn-ghost" href="${TEMPLATES_INDEX_PATH}">Browse all templates</a>
        </div>
      </header>

      ${botCallout}

      <section class="preview-block" aria-label="Template preview">
        <div class="preview-head">Preview</div>
        <div class="discord-frame">${messageHtml}</div>
      </section>

      ${whenToUse}
      ${whatsInside}
      ${tips}
      ${howto}

      <section class="cta-band">
        <h2>Ready to use this template?</h2>
        <p>Open it in DWEEB, customize it for your server, and send it in under a minute.</p>
        <a class="btn btn-primary btn-lg" href="${attr(seo.appUrl)}" data-analytics="template" data-analytics-id="${attr(seo.slug)}" data-analytics-location="body">Use “${escapeHtml(seo.h1.replace(/ Template$/, ""))}” →</a>
      </section>

      ${faqSection(seo.faq)}
      ${featureSection}
      ${relatedSection}
    </article>
  </main>`;

  const creativeWork = {
    "@context": "https://schema.org",
    "@type": "CreativeWork",
    name: seo.h1,
    headline: seo.title,
    description: seo.description,
    url: seo.url,
    image: seo.ogImage,
    thumbnailUrl: seo.ogImage,
    dateModified: TEMPLATES_LASTMOD,
    mainEntityOfPage: { "@type": "WebPage", "@id": `${seo.url}#webpage` },
    inLanguage: "en",
    keywords: seo.keywords.join(", "),
    isAccessibleForFree: true,
    about: "Discord Components V2 message template",
    isPartOf: { "@type": "WebSite", "@id": SITE.websiteId },
    author: { "@id": SITE.orgId },
    publisher: { "@id": SITE.orgId },
  };

  return htmlDocument({
    title: seo.title,
    description: seo.description,
    canonical: seo.url,
    ogImage: seo.ogImage,
    imageAlt: `${seo.h1} preview in the DWEEB Discord message builder`,
    ogType: "article",
    pageType: "template",
    pageId: seo.slug,
    modifiedTime: TEMPLATES_LASTMOD,
    section: seo.category,
    jsonLd: [
      jsonLd(
        breadcrumbLd([
          { name: "Home", url: `${SITE.origin}/` },
          { name: "Templates", url: TEMPLATES_INDEX_URL },
          { name: seo.h1, url: seo.url },
        ]),
      ),
      jsonLd(creativeWork),
      jsonLd(faqLd(seo.faq)),
    ],
    body,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// /templates index
// ────────────────────────────────────────────────────────────────────────────

export function renderIndexPage(all: ResolvedSeo[]): string {
  const title = `Discord Message Templates — ${all.length} Free Designs | DWEEB`;
  const description = `Browse ${all.length} free Discord message templates for welcomes, rules, announcements, roles, giveaways, tickets and more. Customize one and send it by webhook.`;

  const groups = TEMPLATE_CATEGORIES.map((cat) => ({
    cat,
    blurb: CATEGORY_BLURB[cat] ?? "",
    items: all.filter((t) => t.category === cat),
  })).filter((g) => g.items.length > 0);
  const ordered = groups.flatMap((group) => group.items);

  const groupsHtml = groups
    .map(
      (g) => `<section class="cat-block">
        <h2 class="cat-title">${escapeHtml(g.cat === "Roles" ? "Role integrations" : g.cat)}</h2>
        ${g.blurb ? `<p class="cat-blurb">${escapeHtml(g.blurb)}</p>` : ""}
        <div class="card-grid">${g.items
          .map(
            (t) =>
              `<a class="tpl-card" href="${attr(t.path)}">
                <span class="tpl-emoji" aria-hidden="true">${escapeHtml(t.emoji)}</span>
                <span class="tpl-name">${escapeHtml(t.h1.replace(/ Template$/, ""))}</span>
                <span class="tpl-desc">${escapeHtml(t.description)}</span>
                ${
                  t.deliveryMode === "app-owned"
                    ? `<span class="badge badge-bot">App-owned webhook</span>`
                    : t.deliveryMode === "external-link"
                      ? `<span class="badge badge-setup">Setup required</span>`
                      : `<span class="badge badge-ok">Any webhook</span>`
                }
              </a>`,
          )
          .join("")}</div>
      </section>`,
    )
    .join("");

  const body = `<main id="main-content" class="wrap">
    ${breadcrumbNav([{ name: "Home", url: "/" }, { name: "Templates" }])}
    <header class="hero">
      <span class="chip">📋 Templates</span>
      <h1>Discord Message Templates</h1>
      <p class="lede">A growing library of free, ready-to-use Discord message templates built with Components V2 — welcome messages, server rules, announcements, role menus, giveaways, support tickets and more. Open any template in DWEEB, customize every word, colour and link, then send it to Discord. Each card makes its webhook and integration requirements clear.</p>
      <div class="cta-row">
        <a class="btn btn-primary" href="/?entry=template%3Aindex" data-analytics="template" data-analytics-id="index" data-analytics-location="hero">Build a Discord message →</a>
      </div>
    </header>
    ${groupsHtml}
  </main>`;

  const itemList = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Discord Message Templates",
    description,
    url: TEMPLATES_INDEX_URL,
    image: TEMPLATES_OG_INDEX,
    isPartOf: { "@type": "WebSite", "@id": `${SITE.origin}/#website` },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: all.length,
      itemListElement: ordered.map((t, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: t.url,
        name: t.h1,
      })),
    },
  };

  return htmlDocument({
    title,
    description,
    canonical: TEMPLATES_INDEX_URL,
    ogImage: TEMPLATES_OG_INDEX,
    imageAlt: `A gallery of ${all.length} customizable Discord message templates in DWEEB`,
    ogType: "website",
    pageType: "template",
    pageId: "index",
    modifiedTime: TEMPLATES_LASTMOD,
    jsonLd: [
      jsonLd(
        breadcrumbLd([
          { name: "Home", url: `${SITE.origin}/` },
          { name: "Templates", url: TEMPLATES_INDEX_URL },
        ]),
      ),
      jsonLd(itemList),
    ],
    body,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Stylesheet (inlined into every page)
// ────────────────────────────────────────────────────────────────────────────

export const PAGE_CSS = `
:root{
  --bg:#1a1b1e; --panel:#232428; --msg:#313338; --container:#2b2d31;
  --text:#dbdee1; --muted:#b5bac1; --dim:#949ba4; --accent:#5865f2; --green:#3ba55d;
  --border:#3a3c42; --radius:14px;
  --font:system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);line-height:1.6;font-size:16px}
a{color:#00a8fc;text-decoration:none}
a:hover{text-decoration:underline}
h1,h2,h3{line-height:1.25;color:#f2f3f5}
img{max-width:100%}

.site{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 22px;border-bottom:1px solid var(--border);position:sticky;top:0;background:rgba(26,27,30,.86);backdrop-filter:blur(8px);z-index:5}
.brand{font-weight:800;letter-spacing:1.5px;color:#fff;font-size:18px}
.brand:hover{text-decoration:none}
.site-nav{display:flex;align-items:center;gap:18px;font-size:14px}
.site-nav a{color:var(--muted)}
.nav-cta{background:var(--accent);color:#fff!important;padding:7px 14px;border-radius:8px;font-weight:600}
.nav-cta:hover{filter:brightness(1.08);text-decoration:none}

.wrap{max-width:880px;margin:0 auto;padding:26px 20px 10px}
.crumbs{font-size:13px;color:var(--dim);margin-bottom:18px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.crumbs a{color:var(--muted)}
.crumb-sep{color:var(--border)}

.hero{margin-bottom:26px}
.hero-meta{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px}
.chip{display:inline-block;background:var(--panel);border:1px solid var(--border);color:var(--muted);font-size:13px;padding:5px 12px;border-radius:999px;font-weight:600}
.badge{display:inline-block;font-size:12px;padding:5px 11px;border-radius:999px;font-weight:600}
.badge-bot{background:#3a2d12;color:#f0b232;border:1px solid #5a4418}
.badge-setup{background:#2d2342;color:#c9a7ff;border:1px solid #4d3a70}
.badge-ok{background:#13321f;color:#49c96c;border:1px solid #1d4a2e}
h1{font-size:clamp(28px,5vw,40px);margin:6px 0 14px;letter-spacing:-.5px}
.lede{font-size:18px;color:var(--muted);margin:0 0 22px;max-width:62ch}
.byline{margin:-10px 0 20px;color:var(--dim);font-size:13px}

.cta-row{display:flex;flex-wrap:wrap;gap:12px}
.cta-note{margin:10px 0 0;color:var(--dim);font-size:13px}
.btn{display:inline-block;padding:12px 20px;border-radius:10px;font-weight:600;font-size:15px;border:1px solid transparent;cursor:pointer}
.btn:hover{text-decoration:none}
.btn-primary{background:var(--accent);color:#fff!important}
.btn-primary:hover{filter:brightness(1.08)}
.btn-ghost{background:transparent;border-color:var(--border);color:var(--text)!important}
.btn-ghost:hover{background:var(--panel)}
.btn-lg{padding:14px 26px;font-size:16px}

.callout{background:#2b2412;border:1px solid #5a4418;border-radius:var(--radius);padding:14px 18px;margin:0 0 26px;color:#f5e3bf;font-size:15px}
.callout strong{color:#fbe6b8}
.callout-setup{background:#251f33;border-color:#4d3a70;color:#ded2f2}
.callout-setup strong{color:#e7d9ff}

.block{margin:30px 0;padding-top:6px}
.block h2{font-size:22px;margin:0 0 14px}
.ticks{list-style:none;padding:0;margin:0;display:grid;gap:10px}
.ticks li{position:relative;padding-left:30px;color:var(--text)}
.ticks li::before{content:"✓";position:absolute;left:0;top:0;color:var(--green);font-weight:800}
.chips{list-style:none;padding:0;margin:12px 0 0;display:flex;flex-wrap:wrap;gap:9px}
.chips li{background:var(--panel);border:1px solid var(--border);color:var(--muted);font-size:13px;padding:6px 12px;border-radius:8px}
.steps{margin:0;padding-left:22px;display:grid;gap:11px}
.steps li{padding-left:4px}
.steps strong{color:#f2f3f5}
.prose p{color:var(--muted);max-width:74ch;margin:0 0 14px}
.prose p+p{margin-top:12px}
.table-scroll{overflow-x:auto;margin:16px 0 20px;border:1px solid var(--border);border-radius:12px}
table{width:100%;border-collapse:collapse;min-width:620px;background:var(--panel);font-size:14px}
th,td{text-align:left;vertical-align:top;padding:11px 13px;border-bottom:1px solid var(--border)}
th{color:#f2f3f5;background:#292b30}
td{color:var(--muted)}
tbody tr:last-child td{border-bottom:0}
.code-block{overflow:auto;margin:16px 0 20px;padding:18px;background:#111214;border:1px solid var(--border);border-radius:12px;color:#e3e5e8;line-height:1.55;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;tab-size:2}
.sources ul{margin:0;padding-left:22px;display:grid;gap:8px}

.preview-block{margin:8px 0 30px;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;background:var(--panel)}
.preview-head{font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--dim);padding:10px 16px;border-bottom:1px solid var(--border);font-weight:700}
.discord-frame{background:var(--msg);padding:18px 16px;overflow-x:auto}

.cta-band{margin:38px 0;padding:28px 24px;text-align:center;background:linear-gradient(160deg,#2b2d55,#232428);border:1px solid var(--border);border-radius:var(--radius)}
.cta-band h2{margin:0 0 8px}
.cta-band p{color:var(--muted);margin:0 0 18px}

.faq-item{border:1px solid var(--border);border-radius:10px;margin-bottom:10px;background:var(--panel);overflow:hidden}
.faq-item summary{cursor:pointer;padding:14px 18px;font-weight:600;color:#f2f3f5;list-style:none}
.faq-item summary::-webkit-details-marker{display:none}
.faq-item summary::after{content:"+";float:right;color:var(--dim);font-weight:700}
.faq-item[open] summary::after{content:"–"}
.faq-a{padding:0 18px 16px;color:var(--muted)}
.faq-a p{margin:0}

.card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin-top:14px}
.mini-card{display:flex;align-items:center;gap:12px;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:13px 15px;color:var(--text)!important}
.mini-card:hover{border-color:var(--accent);text-decoration:none}
.mini-emoji{font-size:22px}
.mini-body{display:flex;flex-direction:column}
.mini-name{font-weight:600;color:#f2f3f5}
.mini-cat{font-size:12px;color:var(--dim)}

.tpl-card{display:flex;flex-direction:column;gap:6px;background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:18px;color:var(--text)!important;position:relative}
.tpl-card:hover{border-color:var(--accent);transform:translateY(-2px);text-decoration:none;transition:.15s}
.tpl-emoji{font-size:26px}
.tpl-name{font-weight:700;color:#f2f3f5;font-size:16px}
.tpl-desc{font-size:13px;color:var(--muted)}
.tpl-card>.badge{position:absolute;top:14px;right:14px}

.skip-link{position:fixed;left:12px;top:10px;z-index:20;transform:translateY(-160%);background:#fff;color:#111;padding:8px 12px;border-radius:8px;font-weight:700}
.skip-link:focus{transform:none}

.cat-block{margin:34px 0}
.cat-title{font-size:24px;margin:0 0 4px}
.cat-blurb{color:var(--muted);margin:0 0 6px}

.site-footer{max-width:880px;margin:30px auto 0;padding:24px 20px 40px;border-top:1px solid var(--border);color:var(--muted);font-size:14px}
.site-footer p{margin:0 0 8px;max-width:70ch}
.site-footer .muted{color:var(--dim)}
.site-footer a{color:#00a8fc}

/* ── Discord-style message preview (.dwx-*) ───────────────────────────── */
.dwx-msg{display:flex;gap:14px;align-items:flex-start;max-width:560px}
.dwx-avatar{flex:0 0 40px;width:40px;height:40px;border-radius:50%;background:var(--accent);color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:17px}
.dwx-msg-main{min-width:0;flex:1}
.dwx-author{font-weight:600;color:#f2f3f5;display:flex;align-items:center;gap:8px;margin-bottom:3px}
.dwx-tag{background:var(--accent);color:#fff;font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;letter-spacing:.3px}
.dwx-content{font-size:15px}
.dwx-content>*+*{margin-top:8px}

.dwx-container{background:var(--container);border-radius:8px;padding:14px 16px}
.dwx-container>*+*{margin-top:8px}
.dwx-container-accent{border-left:4px solid var(--dwx-accent,var(--accent))}

.dwx-text>*:first-child{margin-top:0}
.dwx-text>*:last-child{margin-top:0}
.dwx-text>*+*{margin-top:6px}
.dwx-p{margin:0}
.dwx-sub{margin:0;font-size:12px;color:var(--dim)}
.dwx-h{margin:0;color:#f2f3f5;font-weight:700}
.dwx-h1{font-size:20px}
.dwx-h2{font-size:17px}
.dwx-h3{font-size:15px}
.dwx-ul{margin:4px 0;padding-left:22px}
.dwx-ul li{margin:2px 0}
.dwx-quote{margin:2px 0;padding:2px 0 2px 12px;border-left:4px solid var(--border);color:var(--muted)}
.dwx-content code{background:#1e1f22;border-radius:4px;padding:1px 5px;font-size:13px;font-family:ui-monospace,Menlo,Consolas,monospace}
.dwx-content a{color:#00a8fc}
.dwx-spoiler{background:#1e1f22;color:transparent;border-radius:4px;padding:0 3px}

.dwx-section{display:flex;gap:12px;align-items:flex-start;justify-content:space-between}
.dwx-section-text{min-width:0;flex:1}
.dwx-section-text>*+*{margin-top:6px}
.dwx-section-accessory{flex:0 0 auto}
.dwx-thumb{width:74px;height:74px;border-radius:8px;background:#1e1f22;display:flex;align-items:center;justify-content:center;font-size:26px}
.dwx-section-action .dwx-btn{white-space:nowrap}

.dwx-gallery{display:grid;grid-template-columns:repeat(2,1fr);gap:6px;margin:2px 0}
.dwx-gallery[data-count="1"]{grid-template-columns:1fr}
.dwx-media{margin:0;background:#1e1f22;border-radius:8px;min-height:120px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:14px;text-align:center}
.dwx-media-glyph{font-size:30px;opacity:.85}
.dwx-media figcaption{font-size:12px;color:var(--dim)}
.dwx-media-spoiler{filter:blur(2px)}

.dwx-sep{border:none;border-top:1px solid var(--border);margin:10px 0}
.dwx-sep-lg{margin:14px 0}
.dwx-spacer{height:8px}
.dwx-sep-lg.dwx-spacer{height:14px}

.dwx-row{display:flex;flex-wrap:wrap;gap:8px;margin:2px 0}
.dwx-btn{display:inline-flex;align-items:center;gap:6px;font-size:14px;font-weight:500;padding:8px 14px;border-radius:8px;background:#4e5058;color:#fff;cursor:default}
.dwx-btn-primary{background:var(--accent)}
.dwx-btn-success{background:#248046}
.dwx-btn-danger{background:#da373c}
.dwx-btn-secondary{background:#4e5058}
.dwx-btn-link{background:#4e5058}
.dwx-btn-premium{background:#c9659a}
.dwx-btn-ext{opacity:.7;font-size:12px}

.dwx-select{margin:2px 0}
.dwx-select-box{display:flex;align-items:center;justify-content:space-between;gap:10px;background:#1e1f22;border:1px solid var(--border);border-radius:8px;padding:9px 13px;color:var(--muted);font-size:14px;max-width:380px}
.dwx-caret{color:var(--dim)}
.dwx-select-kind{margin:6px 0 0;font-size:12px;color:var(--dim)}
.dwx-options{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:4px;max-width:380px}
.dwx-opt{background:#1e1f22;border-radius:6px;padding:7px 11px}
.dwx-opt-label{display:block;color:var(--text);font-size:14px}
.dwx-opt-desc{display:block;color:var(--dim);font-size:12px}

.dwx-file{display:flex;align-items:center;gap:10px;background:#1e1f22;border:1px solid var(--border);border-radius:8px;padding:10px 13px;color:var(--muted);font-size:14px}

@media(max-width:700px){
  .site-nav>a:not(.nav-cta){display:none}
  .site{backdrop-filter:none}
}
@media(max-width:560px){
  .site{padding:14px 16px}
  .wrap{padding:20px 16px 8px}
  .lede{font-size:16px}
  .dwx-msg{gap:10px}
}
`;
