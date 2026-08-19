# SEO growth program

Last reviewed: 2026-08-20

## Search positioning

DWEEB leads with the product people search for and can use immediately: a visual **Discord Message
Builder** for rich webhook messages and embed-style Components V2 layouts. Templates, scheduling,
webhook management, conversion, and
interactive plugins support that promise. The Discord Activity is valuable, but it is not the
primary discovery story.

Core differentiators:

- A real visual Components V2 editor and live preview, not a gallery of disconnected snippets.
- Editable search examples that preserve intent when they open the builder.
- A conservative legacy embed-to-Components-V2 converter with an explicit loss report.
- One workflow for send, restore/update, scheduling, templates, JSON, and optional interactions.
- A local-by-default core editor with explicit boundaries for connected features.

## Search architecture

| Cluster      | Primary intent                                                     | Canonical page                                       |
| ------------ | ------------------------------------------------------------------ | ---------------------------------------------------- |
| Head product | Discord Message Builder                                            | `/` (working editor) + `/discord-message-builder/`\* |
| Delivery     | Discord webhook message builder; send, edit, restore, and schedule | `/discord-webhook-builder/`                          |
| Embed        | Discord embed builder; legacy embed conversion                     | `/discord-embed-builder/`                            |
| Reference    | Components V2 types, JSON, nesting, and limits                     | `/guides/discord-components-v2/`                     |
| Setup        | How to create and use a Discord webhook                            | `/guides/how-to-create-a-discord-webhook/`           |
| Migration    | Convert Discord embed JSON to Components V2                        | `/guides/discord-embed-to-components-v2/`            |
| Security     | Discord webhook URL leaks, storage, and rotation                   | `/guides/discord-webhook-security/`                  |
| Editing      | Edit/update a Discord webhook message after sending                | `/guides/edit-discord-webhook-message/`              |
| Templates    | Discord message and webhook templates                              | `/templates/` plus 36 intent pages                   |
| Features     | Scheduling, webhook management, forms, roles, tickets, and AI      | `/features/` plus 11 feature pages                   |

\* The pairing is deliberate: `/` is the immediately usable tool and carries existing domain
authority; `/discord-message-builder/` is the fast, explanatory page with visible product proof.
Watch Search Console query-to-page selection for swapping or diluted CTR before changing either.

Template pages cross-link by plugin, keyword, category, and component similarity, with a complete
detail-page link ring so no template is contextually orphaned. Interactive templates link back to
the feature that explains setup and permissions. Guides link to the exact builder surface they
describe.

Anchor text is measured, not assumed. Before 2026-08-20 the head-term landing had 135 inbound
internal links of which 126 were the identical nav/footer anchor "Message builder"; only nine were
contextual. Every template detail page now links it from its closing CTA sentence and every feature
page from a "Part of DWEEB" block, taking contextual exact-match anchors to 53, with 35 for the
embed landing (from templates that genuinely contain a Container) and descriptive workflow anchors
for the webhook landing. The audit counts links inside `<main>` separately from the sitewide
boilerplate and fails the build if a template or feature page loses its contextual link to
`/discord-message-builder/`. The sitewide nav anchor stays generic on purpose: a boilerplate anchor
plus contextual exact-match anchors is the natural shape, and 66 identical sitewide exact-match
links is the over-optimised one.

## Release baseline

The 2026-08-20 production build produces:

- 66 indexable URLs and 48,071 words of crawlable/rendered content under the release audit.
- 36 template pages, 11 feature pages, 9 long-form guides, 3 product landings, 3 section indexes, a
  first-hand author/testing methodology page, home, and two legal pages.
- A 1200×630 social card for every template, feature, guide, index, and product landing page, plus
  responsive 1280×680 (56.69 KB) and 768×408 (24.69 KB) WebP product screenshots on the primary
  landing.
- A matching image sitemap and 373 parseable JSON-LD blocks.
- Zero warnings or errors for sitemap targets, titles, canonicals, internal links, structured data,
  content depth, social assets, or metadata length.
- 112 distinct client-state CTA destinations but **zero crawlable query variants**: state now lives
  in URL fragments, while legacy query bookmarks remain supported by the app.
- 14 root boot requests totalling 550,526 raw / 167,526 gzip bytes and primary-landing HTML plus
  full-size product proof of 66,493 transferred bytes, all protected by build budgets.

Historical cold-mobile lab traces before the July performance work (390×844, 4× CPU slowdown,
150 ms RTT, 1.6 Mbps) measured 5.58 s FCP/LCP on `/`, 5.96–6.50 s LCP on the welcome deep link, and
unnecessary default showcase media on unrelated template deep links. Before the HTML-first root
shell, three repeat local Lighthouse traces produced a median Performance score of 83, 1.7 s FCP,
3.3 s LCP, 368 ms TBT, and zero CLS on `/`.

The final one-run mobile Edge smoke after the HTML-first shell scored 86 Performance and 100 for
Accessibility, Best Practices, and SEO on `/`, with 1.02 s FCP, 1.09 s LCP, 554 ms TBT, and zero
CLS. `/discord-message-builder/` scored 100 in all four categories, with 0.91 s FCP, 1.06 s LCP,
5 ms TBT, and zero CLS. CI now performs three runs per URL and asserts the median; the single-run
figures are a release smoke, not a substitute for that gate or field data. The root HTML is
20.82 KB/6.14 KB gzip; the primary landing is 34.87 KB/9.44 KB gzip plus a 56.69 KB desktop or
24.69 KB mobile product WebP. Use Search Console's 75th-percentile field data as the real experience
gate.

The home-page `WebApplication` graph establishes one stable product entity and models the free core
as an explicit zero-price `Offer`. It still does not qualify for Google's SoftwareApplication
enhancement because there is no genuine review or aggregate-rating data. Never fabricate ratings.
If independently attributable reviews become available, review the then-current eligibility rules
before pursuing the enhancement.

Visible FAQs remain useful for people and other consumers, but Google removed FAQ rich results in
June 2026. Google also ignores `meta keywords` and says `llms.txt` has no positive or negative
effect on Google visibility. Neither is treated as a ranking lever; query terms belong naturally in
titles, headings, useful copy, anchors, and image descriptions.

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
| Landing    | Search Console organic clicks as the denominator; bridged `seo_cta_click`, `seo_builder_open`, and actual `seo_builder_ready` by public content type, slug, and CTA placement                            |
| Activation | `seo_builder_ready`, `builder_ready`, `template_applied`, `send_dialog_opened`                                                                                                                           |
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

Deployment and recrawl loop:

1. Record pre-deploy Search Console query/page data for `Discord Message Builder`, `Discord webhook
message builder`, `Discord embed builder`, and `Discord Components V2 builder`.
2. Deploy, verify live HTML/canonical/sitemap for `/`, the three product landings, and `/about/`,
   then request inspection of only those key URLs. IndexNow assists Bing; it does not replace Google
   Search Console submission.
3. Compare 7-day diagnostics and equal 28-day windows for impressions, CTR, position, selected URL,
   and `seo_builder_ready`. Do not churn titles before recrawl and enough impressions.
4. If `/` and `/discord-message-builder/` alternate for the same query with weaker CTR/position,
   use the query-to-page evidence to refine intent separation or consolidate. Do not guess.

Initial targets after deployment:

- 66/66 sitemap URLs valid and indexable.
- Mobile Core Web Vitals at the good threshold (LCP ≤2.5 s, INP ≤200 ms, CLS ≤0.1) at the 75th
  percentile once field volume is sufficient.
- At least 8% organic landing-to-builder rate: matched `seo_builder_ready` events divided by Search
  Console organic clicks for template, feature, guide, landing, and about URLs over the same period.
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
- Inconsistent definitions of the canonical WebSite identity.
- Broken or unsitemapped internal links and contextually orphaned templates.
- Client-only builder state leaking into crawlable query strings.
- Missing or incorrectly sized social images, OG/image-sitemap mismatches, or stale source/PNG
  fingerprints for generated social cards.
- Charset declarations outside the first 1024 bytes.
- Obsolete meta keywords, forbidden positioning/plan claims, or excessively long snippets.
- Thin template, feature, or guide pages.
- Loss of either HTML-first or rendered product H1, preview content emitting document H1s, or
  critical request/transfer budgets exceeding the reviewed baseline.

The Pages workflow includes SEO generator changes in its path filters, runs three medianed
Lighthouse traces on `/` and `/discord-message-builder/`, and submits the deployed sitemap to
IndexNow on successful releases. Service-worker navigation fallback is allowlisted to only the app
shell and valid short-link routes, so static discovery pages keep their own HTML, title, schema,
and canonical.

## Current SERP and competitor opportunity

A 2026-08-19 search sample (not a neutral rank tracker) showed the deployed root around result 10
for the exact head term while Google still displayed the old “Discord Components V2 Builder” title.
The new exact-match landing pages were not yet indexed, and DWEEB did not appear in the returned top
set for the webhook or embed secondary terms. Deployment and recrawl are therefore the first
measurement step; local code cannot change a stale indexed snippet.

Observed tool competitors commonly win with exact title/H1/URL alignment, an immediately visible
editor or preview, free/no-sign-up language, a short how-to, FAQs, and contextual guides. The most
useful benchmarks were discord-webhook.com for content breadth, QuickWebTools and Betsy for exact
tool intent, discord.builders for Components V2, and Discohook for community recall. DWEEB should
not copy their breadth mechanically. Its defensible gaps are measured preview methodology, complete
Components V2 coverage, honest plain-versus-app-owned webhook guidance, local-by-default boundaries,
editable templates, restore/update, scheduling, and collaboration.

A second sample on 2026-08-20 (again a search sample, not a rank tracker) returned a **mixed-intent**
result set for the head term: discord.js's `MessageBuilder` and `ComponentBuilder` class references
alongside visual tools (whumple.com/studio, discord.builders, guildbase.gg, discord-webhook.com,
discordmessageplannerbot.com). Two things follow, both now implemented:

1. The developer half of the query was addressed nowhere on the site. The landing gained a "Visual
   builder or raw JSON" section and a FAQ that says plainly what `MessageBuilder` is and that DWEEB
   exports the same payload; `/guides/discord-components-v2/` gained a table for sending that payload
   from a webhook URL, a bot library, a library without V2 helpers, or the MCP connector. The JSON
   export is real, so this is disambiguation rather than a competitor mention — and it is the honest
   reason a developer arriving on that query would stay.
2. Competitor titles use **generator**, **creator** and **maker** where DWEEB only says _builder_.
   Rather than stuffing synonyms, one FAQ answers whether a message builder is the same as an embed
   generator, and the answer is a real product distinction: a legacy embed is one fixed card with
   named slots, a Components V2 message is an arrangeable layout. Revisit with Search Console query
   data before dedicating a URL to any of those variants.

DWEEB still did not appear in the returned top set. Local code cannot change that on its own —
deployment, recrawl and Search Console measurement remain the next step, exactly as recorded above.

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
