# SEO growth program

Last reviewed: 2026-07-15

## Search positioning

DWEEB leads with the product people can use immediately: a visual Discord webhook, embed, and
Components V2 message builder. Templates, scheduling, webhook management, conversion, and
interactive plugins support that promise. The Discord Activity is valuable, but it is not the
primary discovery story.

Core differentiators:

- A real visual Components V2 editor and live preview, not a gallery of disconnected snippets.
- Editable search examples that preserve intent when they open the builder.
- A conservative legacy embed-to-Components-V2 converter with an explicit loss report.
- One workflow for send, restore/update, scheduling, templates, JSON, and optional interactions.
- A local-by-default core editor with explicit boundaries for connected features.

## Search architecture

| Cluster   | Primary intent                                                          | Canonical page                             |
| --------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| Product   | Discord webhook builder; Discord embed builder; Discord message builder | `/discord-webhook-builder/`                |
| Platform  | Discord Components V2 builder                                           | `/`                                        |
| Reference | Components V2 types, JSON, nesting, and limits                          | `/guides/discord-components-v2/`           |
| Setup     | How to create and use a Discord webhook                                 | `/guides/how-to-create-a-discord-webhook/` |
| Migration | Convert Discord embed JSON to Components V2                             | `/guides/discord-embed-to-components-v2/`  |
| Security  | Discord webhook URL leaks, storage, and rotation                        | `/guides/discord-webhook-security/`        |
| Editing   | Edit/update a Discord webhook message after sending                     | `/guides/edit-discord-webhook-message/`    |
| Templates | Discord message and webhook templates                                   | `/templates/` plus 35 intent pages         |
| Features  | Scheduling, webhook management, forms, roles, tickets, replies, and AI  | `/features/` plus 10 feature pages         |

Template pages cross-link by plugin, keyword, category, and component similarity, with a complete
detail-page link ring so no template is contextually orphaned. Interactive templates link back to
the feature that explains setup and permissions. Guides link to the exact builder surface they
describe.

## Release baseline

The 2026-07-15 production build produces:

- 57 indexable URLs, up from 50 before this program.
- 37,000+ words of visible static content.
- 35 template pages, 10 feature pages, 5 long-form guides, 3 section indexes, one dedicated product
  landing page, home, and two legal pages.
- A 1200×630 social card for every template, feature, guide, index, and product landing page.
- A matching image sitemap and 323 parseable JSON-LD blocks.
- Zero missing sitemap targets, duplicate titles/canonicals, broken internal links, thin detail
  pages, orphaned templates, invalid JSON-LD blocks, or metadata-length warnings under the release
  audit.

Cold-mobile lab traces before the performance work (390×844, 4× CPU slowdown, 150 ms RTT, 1.6 Mbps)
measured 5.58 s FCP/LCP on `/`, 5.96–6.50 s LCP on the welcome deep link, and unnecessary default
showcase media on unrelated template deep links. Three repeat Lighthouse traces against the final
local production build produced a median Performance score of 83, 1.7 s FCP, 3.3 s LCP, 368 ms TBT,
and zero CLS on `/`: about a 41% LCP reduction from the cold baseline. The dedicated
`/discord-webhook-builder/` landing page scored 100 for Performance, Accessibility, and Best
Practices, with 0.9 s FCP/LCP in the same mobile profile. Root `index.html` also fell from
25.36 kB/6.92 kB gzip to 18.50 kB/5.66 kB gzip. These are directional lab results, not field Core
Web Vitals; capture the same trace after deployment, retain both artifacts with the release notes,
and use Search Console's 75th-percentile field data as the real experience gate.

The home-page `WebApplication` graph establishes one stable product entity and truthful
Free/Plus/Pro offers; it does not currently qualify for Google's SoftwareApplication enhancement.
That result type also requires genuine review/aggregate-rating data. Never fabricate ratings. If
real, independently attributable reviews become available, review the then-current eligibility
rules and model the free core as an explicit zero-price offer before pursuing that enhancement.

## Measurement model

Search Console is the source of truth for discovery; analytics explains what visitors do after the
click. Record the 28 days before deployment and compare equal 28-day windows, then use a rolling
90-day view to smooth query volatility.

Weekly scorecard:

| Layer      | Metrics                                                                                                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coverage   | Valid indexed URLs, submitted/discovered URLs, crawl errors, canonical mismatches                                                                                                                        |
| Demand     | Non-brand impressions and clicks by cluster, new ranking queries, top-10/top-20 query count                                                                                                              |
| Snippet    | Organic CTR by page/query, title rewrites, rich-result/merchant warnings where relevant                                                                                                                  |
| Landing    | Search Console organic clicks as the denominator; bridged `seo_cta_click` and `seo_builder_open` by public content type, slug and CTA placement                                                          |
| Activation | `builder_ready`, `template_applied`, `send_dialog_opened`                                                                                                                                                |
| Outcome    | `message_posted`, `message_scheduled`                                                                                                                                                                    |
| Experience | Search Console Core Web Vitals/CrUX mobile LCP, INP and CLS; repeatable lab traces for static render and app boot; GA `app_surface_ready.boot_ms` split by builder/directory for directional boot trends |

No event may contain message text, webhook URLs or tokens, share hashes, OAuth/billing values,
Discord guild/app/channel/message/user IDs, or free-form user input. GA receives only each page's
controlled canonical URL and the referring site's origin; the exact acquisition-token catalog and
event-field allowlists reject arbitrary values. CTA placement is held briefly in same-tab
`sessionStorage`, revalidated, emitted after navigation, and immediately consumed so fast clicks are
not lost while analytics is deliberately delayed.

GA property release checklist: keep Enhanced Measurement disabled for this data stream, especially
outbound clicks (`link_url`), site search (`search_term`), and history-change pageviews. Those
automatic events can inspect dynamic app URLs outside the repository's field allowlists. Review the
setting after any analytics-property or tag migration; DWEEB's canonical pageview and bounded custom
funnel events are the intended collection surface.

Initial targets after deployment:

- 57/57 sitemap URLs valid and indexable.
- Mobile Core Web Vitals at the good threshold (LCP ≤2.5 s, INP ≤200 ms, CLS ≤0.1) at the 75th
  percentile once field volume is sufficient.
- At least 8% organic landing-to-builder rate: matched `seo_builder_open` events divided by Search
  Console organic clicks for template, feature and guide URLs over the same period.
- Improve non-brand organic clicks and the count of top-20 non-brand queries over the first 90 days;
  use the first 28-day post-deploy window to set a query-informed numeric growth target rather than
  inventing a traffic baseline.

## Automated release gates

`bun run build` generates all discovery pages and then runs `scripts/seo/audit.ts`. The build fails
for:

- Missing sitemap targets, invalid/future freshness dates, wrong-origin URLs, or duplicate page URLs.
- Indexable HTML omitted from the sitemap or an accidental `noindex` on a submitted page.
- Missing/duplicate titles, descriptions, same-origin canonicals, or H1s.
- Invalid JSON-LD.
- Broken or unsitemapped internal links and contextually orphaned templates.
- Missing or incorrectly sized social images and OG/image-sitemap mismatches.
- Charset declarations outside the first 1024 bytes.
- Obsolete meta keywords, forbidden positioning/plan claims, or excessively long snippets.
- Thin template, feature, or guide pages.

The Pages workflow includes SEO generator changes in its path filters and submits the deployed
sitemap to IndexNow on successful releases. Service-worker navigation fallback is allowlisted to
only the app shell and valid short-link routes, so static discovery pages keep their own HTML,
title, schema, and canonical.

## Next query-led expansion

Do not add pages merely to increase URL count. Use Search Console impressions, support questions,
and successful on-site searches to choose the next work:

1. A truthful Free/Plus/Pro quota comparison page when pricing search demand is visible.
2. Focused pages for creating webhooks on each current Discord client only when screenshots and
   ongoing UI-review ownership are available.
3. Fair comparison/migration pages for established webhook tools, reviewed against their current
   product before every update.
4. Template upgrades for the six highest-impression intents: unique variants, exact component
   counts, copyable JSON, compatibility notes, and query-specific troubleshooting.
5. Case studies with measured publishing outcomes and permission/setup detail; do not invent
   testimonials, ratings, review schema, or usage claims.
