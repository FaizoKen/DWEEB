/** A compact agent navigation reference, derived from the public page catalogues. */
import { SITE, type ResolvedSeo } from "./content";
import type { ResolvedFeature } from "./features";
import { GUIDES, LANDINGS } from "./guides";

export function renderDiscoveryReference(
  templates: ResolvedSeo[],
  features: ResolvedFeature[],
): string {
  const link = (title: string, url: string, description: string) =>
    `- [${title}](${url}): ${description}`;
  return `# DWEEB

> DWEEB is a browser-based visual Discord message builder for webhook messages and embed-style Components V2 layouts. The core editor, live preview and JSON import/export need no account. Connected features include scheduling, server message libraries, interactive plugins, an AI assistant, and collaboration inside Discord.

The public HTML pages below contain the complete explanations and primary-source references. This file is a navigation aid, not a separate version of the documentation.

## Product facts

- DWEEB builds Components V2 payloads. Legacy embed JSON can be imported and converted with a loss report; it is not a legacy-embed-only editor.
- Ordinary incoming webhooks can send static layouts and link buttons. Interactive buttons and select menus need an application-owned webhook and an interaction handler; some hosted plugins also need a server bot installation and permissions.
- Templates are editable starting points. Their downloadable JSON contains example text, media, links and, where applicable, unconfigured plugin IDs. Importing JSON does not provision a plugin.
- Browser drafts are local by default. A fragment share link contains its message: anyone with the link can open it. Optional short links store the shared payload on the server. Do not put credentials or confidential text in public links.
- The free plan includes all feature categories. Optional per-server plans raise quotas; connected services have their own limits and setup requirements.
- The source is available under the PolyForm Noncommercial License 1.0.0. DWEEB is an independent project, not affiliated with Discord.

## Product and setup

${LANDINGS.map((page) => link(page.h1, page.url, page.description)).join("\n")}
${link("About DWEEB and its preview methodology", SITE.authorUrl, "Maintainer, first-hand testing and known preview limitations")}
${link("Message templates", `${SITE.origin}/templates/`, `${templates.length} designs with rendered previews, editable builder links and downloadable Components V2 JSON`)}
${link("Feature directory", `${SITE.origin}/features/`, "Delivery requirements and guided setup for connected workflows")}

## Guides

${GUIDES.map((page) => link(page.h1, page.url, page.description)).join("\n")}

## Features and AI tools

${features.map((feature) => link(feature.h1, feature.url, feature.description)).join("\n")}

The MCP feature page explains the remote connector and its authentication. A connector acts with the signed-in user's Discord permissions; a public template JSON URL does not grant posting authority. For a self-hosted deployment, obtain the connector address and availability from that deployment's “Connect an AI client” dialog.

## Template examples

${templates.map((page) => link(page.h1, page.url, `${page.description} JSON: ${page.url}message.json`)).join("\n")}

## Optional

${link("Privacy policy", `${SITE.origin}/privacy`, "Local storage, connected features and shared data")}
${link("Terms of service", `${SITE.origin}/terms`, "Service and usage terms")}
${link("Source code", SITE.githubUrl, "Implementation and noncommercial license")}
${link("Support community", SITE.communityUrl, "DWEEB support on Discord")}
`;
}
