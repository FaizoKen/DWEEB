/**
 * Code export — the current message as paste-ready code.
 *
 * The JSON tab already hands a developer the payload; what it cannot hand them
 * is the forty lines of `new ContainerBuilder().addTextDisplayComponents(…)`
 * their bot actually needs, or a webhook request with the two details that are
 * easy to get wrong. Each target here renders the same wire payload the JSON
 * export and the sender use, so a design checked in the preview is the design
 * the code produces.
 *
 * Pure and dependency-free on purpose: the app calls it from the Share dialog,
 * and the static-site generator calls it at build time so every code sample in
 * the guides and on the template pages is generated, never hand-copied.
 */

import type { WebhookMessage } from "@/core/schema/types";
import { generateDiscordJs } from "./discordjs";
import { generateDiscordPy } from "./discordpy";
import { prepareCodegenInput } from "./payload";
import { generateCurl, generateFetch, generatePythonRequests } from "./webhook";

export const CODE_TARGETS = [
  {
    id: "discordjs",
    label: "discord.js",
    language: "JavaScript",
    fileName: "message.js",
    kind: "bot",
    summary: "Builder classes for a discord.js v14 bot, sent with channel.send().",
  },
  {
    id: "discordpy",
    label: "discord.py",
    language: "Python",
    fileName: "message.py",
    kind: "bot",
    summary: "A LayoutView for a discord.py 2.6+ bot, sent with channel.send().",
  },
  {
    id: "python",
    label: "Python",
    language: "Python",
    fileName: "send_webhook.py",
    kind: "webhook",
    summary: "Posts to a webhook URL with the requests library. No bot needed.",
  },
  {
    id: "fetch",
    label: "JavaScript",
    language: "JavaScript",
    fileName: "send-webhook.mjs",
    kind: "webhook",
    summary: "Posts to a webhook URL with fetch — Node 18+, Deno, Bun or a Worker.",
  },
  {
    id: "curl",
    label: "cURL",
    language: "Shell",
    fileName: "send-webhook.sh",
    kind: "webhook",
    summary: "One command for a terminal, a CI job or a cron entry.",
  },
] as const;

export type CodeTarget = (typeof CODE_TARGETS)[number]["id"];
export type CodeTargetInfo = (typeof CODE_TARGETS)[number];

const GENERATORS: Record<CodeTarget, (input: ReturnType<typeof prepareCodegenInput>) => string> = {
  discordjs: generateDiscordJs,
  discordpy: generateDiscordPy,
  python: generatePythonRequests,
  fetch: generateFetch,
  curl: generateCurl,
};

export function isCodeTarget(value: unknown): value is CodeTarget {
  return typeof value === "string" && Object.hasOwn(GENERATORS, value);
}

export function codeTargetInfo(target: CodeTarget): CodeTargetInfo {
  return CODE_TARGETS.find((info) => info.id === target)!;
}

export function generateCode(message: WebhookMessage, target: CodeTarget): string {
  return GENERATORS[target](prepareCodegenInput(message));
}
