/**
 * HTML for the static template pages: the per-template page, the `/templates`
 * index, and the shared (inlined) stylesheet.
 *
 * The pages are script-free by design — pure HTML + inline CSS — so they're
 * fast, fully crawlable without JS, and carry a strict CSP. The only
 * interactivity is the "Open in DWEEB" link, which deep-links into the SPA
 * (`/?template=<id>`, handled by `useTemplateDeepLink`).
 */

import { TEMPLATE_CATEGORIES } from "@/data/presets";
import { escapeHtml } from "./render-message";
import {
  CATEGORY_BLURB,
  SITE,
  TEMPLATES_OG_INDEX,
  type FaqEntry,
  type ResolvedSeo,
} from "./content";

const TEMPLATES_INDEX_PATH = "/templates/";
const TEMPLATES_INDEX_URL = `${SITE.origin}${TEMPLATES_INDEX_PATH}`;

/** Escape for an HTML attribute value (double-quoted). */
function attr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

/** Serialize a JSON-LD object, neutralising any `</script>` break-out. */
function jsonLd(data: unknown): string {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}

const HOWTO_STEPS = [
  {
    name: "Open it in DWEEB",
    text: "Click “Open in DWEEB” to load the template into the visual editor — no sign-up, no install.",
  },
  {
    name: "Make it yours",
    text: "Edit the text, colours, emoji, links and images to match your server. The live preview updates as you type.",
  },
  {
    name: "Paste your webhook URL",
    text: "In Discord, go to Server Settings → Integrations → Webhooks, copy a webhook URL, and paste it into DWEEB.",
  },
  {
    name: "Send it",
    text: "Hit Send and the message posts straight to your channel. You can also share it as a link or export the JSON.",
  },
];

/**
 * Wrap a head/body in the shared document shell: meta, canonical, OG/Twitter,
 * favicons, CSP, and the inlined stylesheet.
 */
function htmlDocument(opts: {
  title: string;
  description: string;
  canonical: string;
  ogImage: string;
  keywords?: string[];
  ogType: "article" | "website";
  jsonLd: string[];
  body: string;
}): string {
  const csp = [
    "default-src 'self'",
    "img-src 'self' https: data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${attr(csp)}" />
    <meta name="referrer" content="strict-origin-when-cross-origin" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#1e1f22" />
    <meta name="color-scheme" content="dark" />

    <title>${escapeHtml(opts.title)}</title>
    <meta name="description" content="${attr(opts.description)}" />
    ${opts.keywords && opts.keywords.length ? `<meta name="keywords" content="${attr(opts.keywords.join(", "))}" />` : ""}
    <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
    <link rel="canonical" href="${attr(opts.canonical)}" />

    <meta property="og:type" content="${opts.ogType}" />
    <meta property="og:site_name" content="${SITE.name}" />
    <meta property="og:title" content="${attr(opts.title)}" />
    <meta property="og:description" content="${attr(opts.description)}" />
    <meta property="og:url" content="${attr(opts.canonical)}" />
    <meta property="og:image" content="${attr(opts.ogImage)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${attr(opts.title)}" />
    <meta name="twitter:description" content="${attr(opts.description)}" />
    <meta name="twitter:image" content="${attr(opts.ogImage)}" />

    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />

    ${opts.jsonLd.join("\n    ")}
    <style>${PAGE_CSS}</style>
  </head>
  <body>
    <header class="site">
      <a class="brand" href="/" aria-label="DWEEB home">DWEEB</a>
      <nav class="site-nav">
        <a href="${TEMPLATES_INDEX_PATH}">All templates</a>
        <a class="nav-cta" href="/">Open the builder</a>
      </nav>
    </header>
    ${opts.body}
    <footer class="site-footer">
      <p>
        <strong>DWEEB</strong> — the free visual Discord webhook &amp; embed builder for Components V2.
        Build, preview and send rich messages in your browser. No JSON, no account, nothing uploaded.
      </p>
      <p class="muted">
        <a href="/">Open the builder</a> ·
        <a href="${TEMPLATES_INDEX_PATH}">All templates</a> ·
        <a href="/privacy">Privacy</a> ·
        <a href="/terms">Terms</a> ·
        <a href="${SITE.githubUrl}" rel="noopener" target="_blank">GitHub</a>
      </p>
    </footer>
  </body>
</html>`;
}

function breadcrumbLd(trail: { name: string; url: string }[]): object {
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

function breadcrumbNav(trail: { name: string; url?: string }[]): string {
  const parts = trail.map((t, i) => {
    const last = i === trail.length - 1;
    const label = escapeHtml(t.name);
    const node = last || !t.url ? `<span aria-current="page">${label}</span>` : `<a href="${attr(t.url)}">${label}</a>`;
    return node;
  });
  return `<nav class="crumbs" aria-label="Breadcrumb">${parts.join('<span class="crumb-sep" aria-hidden="true">›</span>')}</nav>`;
}

function faqSection(faq: FaqEntry[]): string {
  const items = faq
    .map(
      (f) =>
        `<details class="faq-item"><summary>${escapeHtml(f.q)}</summary><div class="faq-a"><p>${escapeHtml(f.a)}</p></div></details>`,
    )
    .join("");
  return `<section class="block"><h2>Frequently asked questions</h2>${items}</section>`;
}

function faqLd(faq: FaqEntry[]): object {
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
): string {
  const botBadge = seo.requiresBot
    ? `<span class="badge badge-bot" title="Includes interactive components">Interactive · needs a bot</span>`
    : `<span class="badge badge-ok">Works with any webhook</span>`;

  const botCallout = seo.requiresBot
    ? `<aside class="callout">
        <strong>Heads up — this one's interactive.</strong>
        It includes a clickable ${seo.pairsWith ? `${escapeHtml(seo.pairsWith)} ` : ""}component, so a Discord bot or app must own the webhook for clicks to respond.
        DWEEB detects this and walks you through pairing it with the ${seo.pairsWith ? `<strong>${escapeHtml(seo.pairsWith)}</strong>` : "matching"} plugin.
      </aside>`
    : "";

  const whenToUse = `<section class="block"><h2>When to use it</h2><ul class="ticks">${seo.whenToUse
    .map((w) => `<li>${escapeHtml(w)}</li>`)
    .join("")}</ul></section>`;

  const whatsInside = `<section class="block"><h2>What's inside</h2>
    <p>Built with Discord's Components V2 layout system:</p>
    <ul class="chips">${seo.componentKinds.map((k) => `<li>${escapeHtml(k)}</li>`).join("")}</ul></section>`;

  const tips = `<section class="block"><h2>Tips</h2><ul class="ticks">${seo.tips
    .map((t) => `<li>${escapeHtml(t)}</li>`)
    .join("")}</ul></section>`;

  const howto = `<section class="block"><h2>How to use this template</h2>
    <ol class="steps">${HOWTO_STEPS.map((s) => `<li><strong>${escapeHtml(s.name)}.</strong> ${escapeHtml(s.text)}</li>`).join("")}</ol></section>`;

  const relatedSection = related.length
    ? `<section class="block"><h2>Related templates</h2><div class="card-grid">${related
        .map(
          (r) =>
            `<a class="mini-card" href="${attr(r.path)}"><span class="mini-emoji" aria-hidden="true">${escapeHtml(r.emoji)}</span><span class="mini-body"><span class="mini-name">${escapeHtml(r.h1.replace(/ Template$/, ""))}</span><span class="mini-cat">${escapeHtml(r.category)}</span></span></a>`,
        )
        .join("")}</div></section>`
    : "";

  const body = `<main class="wrap">
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
          <a class="btn btn-primary" href="${attr(seo.appUrl)}">Open in DWEEB →</a>
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
        <a class="btn btn-primary btn-lg" href="${attr(seo.appUrl)}">Open “${escapeHtml(seo.h1.replace(/ Template$/, ""))}” in DWEEB →</a>
      </section>

      ${faqSection(seo.faq)}
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
    inLanguage: "en",
    keywords: seo.keywords.join(", "),
    isAccessibleForFree: true,
    about: "Discord Components V2 message template",
    isPartOf: { "@type": "WebSite", "@id": `${SITE.origin}/#website` },
    author: { "@id": SITE.orgId },
    publisher: { "@id": SITE.orgId },
  };

  const howtoLd = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: `How to use the ${seo.h1} in Discord`,
    description: `Open the ${seo.h1} in DWEEB, customize it, and send it to your Discord server through a webhook.`,
    image: seo.ogImage,
    totalTime: "PT2M",
    step: HOWTO_STEPS.map((s, i) => ({
      "@type": "HowToStep",
      position: i + 1,
      name: s.name,
      text: s.text,
    })),
  };

  return htmlDocument({
    title: seo.title,
    description: seo.description,
    canonical: seo.url,
    ogImage: seo.ogImage,
    keywords: seo.keywords,
    ogType: "article",
    jsonLd: [
      jsonLd(
        breadcrumbLd([
          { name: "Home", url: `${SITE.origin}/` },
          { name: "Templates", url: TEMPLATES_INDEX_URL },
          { name: seo.h1, url: seo.url },
        ]),
      ),
      jsonLd(creativeWork),
      jsonLd(howtoLd),
      jsonLd(faqLd(seo.faq)),
    ],
    body,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// /templates index
// ────────────────────────────────────────────────────────────────────────────

export function renderIndexPage(all: ResolvedSeo[]): string {
  const title = `Discord Message Templates — ${all.length} free Components V2 templates | DWEEB`;
  const description = `${all.length} free, customizable Discord message templates — welcome messages, rules, announcements, reaction roles, giveaways, tickets and more. Open any one in DWEEB, edit it, and post through a webhook.`;

  const groups = TEMPLATE_CATEGORIES.map((cat) => ({
    cat,
    blurb: CATEGORY_BLURB[cat] ?? "",
    items: all.filter((t) => t.category === cat),
  })).filter((g) => g.items.length > 0);

  const groupsHtml = groups
    .map(
      (g) => `<section class="cat-block">
        <h2 class="cat-title">${escapeHtml(g.cat)}</h2>
        ${g.blurb ? `<p class="cat-blurb">${escapeHtml(g.blurb)}</p>` : ""}
        <div class="card-grid">${g.items
          .map(
            (t) =>
              `<a class="tpl-card" href="${attr(t.path)}">
                <span class="tpl-emoji" aria-hidden="true">${escapeHtml(t.emoji)}</span>
                <span class="tpl-name">${escapeHtml(t.h1.replace(/ Template$/, ""))}</span>
                <span class="tpl-desc">${escapeHtml(t.description)}</span>
                ${t.requiresBot ? `<span class="badge badge-bot">Interactive</span>` : ""}
              </a>`,
          )
          .join("")}</div>
      </section>`,
    )
    .join("");

  const body = `<main class="wrap">
    ${breadcrumbNav([{ name: "Home", url: "/" }, { name: "Templates" }])}
    <header class="hero">
      <span class="chip">📋 Templates</span>
      <h1>Discord Message Templates</h1>
      <p class="lede">A growing library of free, ready-to-use Discord message templates built with Components V2 — welcome messages, server rules, announcements, reaction-role menus, giveaways, support tickets and more. Open any template in DWEEB, customize every word, colour and link, then post it through a webhook. No JSON, no bot for the static ones, no account.</p>
      <div class="cta-row">
        <a class="btn btn-primary" href="/">Open the builder →</a>
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
      itemListElement: all.map((t, i) => ({
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
    ogType: "website",
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
.badge-ok{background:#13321f;color:#3ba55d;border:1px solid #1d4a2e}
h1{font-size:clamp(28px,5vw,40px);margin:6px 0 14px;letter-spacing:-.5px}
.lede{font-size:18px;color:var(--muted);margin:0 0 22px;max-width:62ch}

.cta-row{display:flex;flex-wrap:wrap;gap:12px}
.btn{display:inline-block;padding:12px 20px;border-radius:10px;font-weight:600;font-size:15px;border:1px solid transparent;cursor:pointer}
.btn:hover{text-decoration:none}
.btn-primary{background:var(--accent);color:#fff!important}
.btn-primary:hover{filter:brightness(1.08)}
.btn-ghost{background:transparent;border-color:var(--border);color:var(--text)!important}
.btn-ghost:hover{background:var(--panel)}
.btn-lg{padding:14px 26px;font-size:16px}

.callout{background:#2b2412;border:1px solid #5a4418;border-radius:var(--radius);padding:14px 18px;margin:0 0 26px;color:#f5e3bf;font-size:15px}
.callout strong{color:#fbe6b8}

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
.tpl-card .badge-bot{position:absolute;top:14px;right:14px}

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

@media(max-width:560px){
  .site{padding:14px 16px}
  .wrap{padding:20px 16px 8px}
  .lede{font-size:16px}
  .dwx-msg{gap:10px}
}
`;
