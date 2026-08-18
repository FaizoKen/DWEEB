/**
 * Prompts — the workflows this server is good at, offered as one-click starts.
 *
 * An MCP prompt is user-invoked, not model-invoked: it fills the next turn with
 * text the user chose. So these are written as instructions *to the assistant*,
 * naming the tools in the order that actually works — build, validate, preview,
 * hand the human a link, and only then post. That ordering is the whole point:
 * a message is cheap to fix before it is posted and awkward afterwards.
 */

import { TEMPLATE_CATEGORIES } from "@/data/presets";

export interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptDescriptor {
  name: string;
  title: string;
  description: string;
  arguments: PromptArgument[];
}

export interface PromptMessage {
  role: "user";
  content: { type: "text"; text: string };
}

export interface PromptResult {
  description: string;
  messages: PromptMessage[];
}

type Builder = (args: Record<string, string>) => PromptResult;

interface Prompt {
  descriptor: PromptDescriptor;
  build: Builder;
}

const user = (text: string): PromptMessage => ({ role: "user", content: { type: "text", text } });

const PROMPTS: Prompt[] = [
  {
    descriptor: {
      name: "build_message",
      title: "Build a Discord message",
      description:
        "Design a Components V2 message from a description, check it, and hand back a DWEEB link to review before anything is posted.",
      arguments: [
        {
          name: "brief",
          description: "What the message is for, in your own words.",
          required: true,
        },
        {
          name: "template",
          description: `Optional starting template id, or a category to browse (${TEMPLATE_CATEGORIES.join(", ")}).`,
          required: false,
        },
      ],
    },
    build: (args) => {
      const start = args.template
        ? `Start from the built-in template or category "${args.template}" — use list_templates / get_template to pull it in.`
        : "Check list_templates first; starting from a built-in template is usually faster than writing one from scratch.";
      return {
        description: "Build a Discord Components V2 message and hand back a review link.",
        messages: [
          user(
            [
              `Build a Discord message for this: ${args.brief}`,
              "",
              start,
              "",
              "Then, in order:",
              "1. Read describe_schema if you are unsure about any component's shape.",
              "2. Call validate_message and fix everything it reports as an error.",
              "3. Call preview_message and check the layout reads the way it should.",
              "4. Call create_share_link and give me the link so I can see it in DWEEB.",
              "",
              "Do not post anything until I have seen the link and said to go ahead.",
            ].join("\n"),
          ),
        ],
      };
    },
  },
  {
    descriptor: {
      name: "revise_message",
      title: "Revise an existing message",
      description:
        "Take a DWEEB share link or a posted message and rework it, showing the change as a new link before replacing anything.",
      arguments: [
        {
          name: "source",
          description:
            "A DWEEB share link, a share token, or the id of a message this server posted.",
          required: true,
        },
        {
          name: "direction",
          description: "What should change — tone, structure, content, length.",
          required: true,
        },
      ],
    },
    build: (args) => ({
      description: "Revise an existing Discord message and show the result before replacing it.",
      messages: [
        user(
          [
            `Revise this message: ${args.source}`,
            `What to change: ${args.direction}`,
            "",
            "1. Load it — read_share_link for a DWEEB link or token, fetch_message for a posted message id.",
            "2. Make the change, keeping everything I did not ask you to touch.",
            "3. Call validate_message, then preview_message.",
            "4. Call create_share_link and show me the result.",
            "",
            "Only call update_message once I have confirmed. Remember it replaces the whole message.",
          ].join("\n"),
        ),
      ],
    }),
  },
  {
    descriptor: {
      name: "audit_message",
      title: "Audit a message before posting",
      description:
        "Review a message for anything Discord would reject, anything it would silently ignore, and anything the destination cannot deliver.",
      arguments: [
        {
          name: "source",
          description: "A DWEEB share link, a share token, or the message payload itself.",
          required: true,
        },
        {
          name: "webhook",
          description: "Optional destination name to check the message against.",
          required: false,
        },
      ],
    },
    build: (args) => {
      const lines = [
        `Audit this Discord message before it goes out: ${args.source}`,
        "",
        "1. Load it and call validate_message.",
        "2. Call preview_message and read the layout as a member of the server would.",
      ];
      if (args.webhook) {
        lines.push(
          `3. Call inspect_webhook for "${args.webhook}" and tell me whether that destination can actually deliver what this message needs — interactive components only respond on an application-owned webhook.`,
        );
      } else {
        lines.push(
          "3. Call list_webhooks and inspect_webhook for the intended destination — interactive components only respond on an application-owned webhook.",
        );
      }
      lines.push(
        "",
        "Report what would break, what would be silently ignored, and what you would change. Do not post or modify anything.",
      );
      return {
        description:
          "Audit a Discord message for rejections, silent failures, and destination fit.",
        messages: [user(lines.join("\n"))],
      };
    },
  },
];

export const PROMPT_DESCRIPTORS: PromptDescriptor[] = PROMPTS.map((p) => p.descriptor);

export type PromptError = { error: string };

/** Build a prompt's messages. Returns an error object for an unknown name or a
 *  missing required argument, which the protocol layer reports as invalid params. */
export function buildPrompt(
  name: string,
  args: Record<string, unknown> | undefined,
): PromptResult | PromptError {
  const prompt = PROMPTS.find((p) => p.descriptor.name === name);
  if (!prompt) {
    return { error: `No prompt named ${JSON.stringify(name)}.` };
  }
  const supplied: Record<string, string> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (typeof value === "string") supplied[key] = value;
  }
  const missing = prompt.descriptor.arguments
    .filter((a) => a.required && !supplied[a.name]?.trim())
    .map((a) => a.name);
  if (missing.length > 0) {
    return { error: `Prompt ${name} needs: ${missing.join(", ")}.` };
  }
  return prompt.build(supplied);
}
