/**
 * Schema validation.
 *
 * Validation runs in two situations:
 *  1. Live in the editor, to flag problems inline without blocking *editing*
 *     (you can keep typing through an error; only sending is gated).
 *  2. Before export, to refuse payloads Discord would reject.
 *
 * Both call sites use `validateMessage`. The `severity` field on each issue
 * controls UI treatment, and the line is drawn by Discord's own behaviour:
 *   - `error`   — Discord would *reject* the message (empty required field,
 *                 over a hard limit, duplicate id). Blocks export/send.
 *   - `warning` — Discord *accepts* it but silently ignores or degrades the
 *                 result (e.g. applied_tags with no thread_name, a malformed
 *                 avatar_url that falls back to the default). Informational.
 */

import {
  isActionRow,
  isButton,
  isChannelSelect,
  isContainer,
  isFile,
  isMediaGallery,
  isMentionableSelect,
  isRoleSelect,
  isSection,
  isSelect,
  isStringSelect,
  isTextDisplay,
  isThumbnail,
  isUserSelect,
} from "./guards";
import { LIMITS } from "./limits";
import { COMPONENT_META } from "./metadata";
import { countCharacters, countComponents, walk } from "./traversal";
import {
  ButtonStyle,
  ComponentType,
  type AnyComponent,
  type ButtonComponent,
  type ComponentTypeValue,
  type EditorId,
  type SelectComponent,
  type UnfurledMediaItem,
  type WebhookMessage,
} from "./types";
import { getAttachmentFile, parseSessionUrl } from "@/core/state/attachmentStore";
import { containsPlaceholder } from "@/core/plugins/placeholders";
import { matchLinkPlugin, unfilledLinkTokens } from "@/core/plugins/linkManifest";
import { LINK_PLUGINS } from "@/core/plugins/registry";

export type IssueSeverity = "error" | "warning";

export interface ValidationIssue {
  /** Editor id of the offending component, when applicable. */
  nodeId?: EditorId;
  severity: IssueSeverity;
  code: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

const SNOWFLAKE_RE = /^\d{15,25}$/;

/**
 * Discord rejects a webhook username that contains "clyde" or "discord"
 * (case-insensitive, anywhere in the string) to prevent impersonation — so
 * "Discord Alerts" or "Clyde Bot" bounce, not just exact matches.
 */
const RESERVED_USERNAME_RE = /clyde|discord/i;

/** Discord channel `type`s that only accept posts which start a new thread:
 *  forum (15) and media (16). Executing a webhook there without a
 *  `thread_name` always 400s. */
export const THREAD_ONLY_CHANNEL_TYPES: ReadonlySet<number> = new Set([15, 16]);

/**
 * Destination-aware validation, split from {@link validateMessage} (which is
 * pure and destination-agnostic, shared by every surface). The `thread_name`
 * rule cuts both ways at Discord:
 *
 *  - a forum/media destination starts a new post, so the message MUST carry a
 *    `thread_name` (its title) — a post without one 400s;
 *  - every other channel kind REJECTS a post that carries one (`thread_name`
 *    is only valid on forum/media webhook executes).
 *
 * Pass the destination channel's Discord `type` when it's known —
 * null/undefined (no destination picked, or a surface that doesn't track one)
 * validates nothing. Surfaced live in the editor via `useDestinationIssues`
 * (inline on the Thread name field), and re-checked at post time by the
 * Activity store and the proxy.
 */
export function validateDestination(
  message: Pick<WebhookMessage, "thread_name">,
  channelType: number | null | undefined,
  channelName?: string | null,
): ValidationIssue[] {
  if (channelType == null) return [];
  const hasTitle = (message.thread_name ?? "").trim().length > 0;
  if (THREAD_ONLY_CHANNEL_TYPES.has(channelType)) {
    if (hasTitle) return [];
    const kind = channelType === 16 ? "media" : "forum";
    const dest = channelName ? `#${channelName}` : `this ${kind} channel`;
    return [
      {
        severity: "error",
        code: "THREAD_NAME_REQUIRED",
        message: `Posting to ${dest} starts a new ${kind} post, which needs a thread name (Message options → Forum post).`,
      },
    ];
  }
  if (!hasTitle) return [];
  const dest = channelName ? `#${channelName}` : "this channel";
  return [
    {
      severity: "error",
      code: "THREAD_NAME_FORBIDDEN",
      message: `Discord rejects a post to ${dest} while a thread name is set — clear it (Message options → Forum post), or pick a forum or media channel.`,
    },
  ];
}

export function validateMessage(message: WebhookMessage): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (message.components.length === 0) {
    issues.push({
      severity: "error",
      code: "EMPTY_MESSAGE",
      message: "A message must contain at least one component.",
    });
  }

  if (message.components.length > LIMITS.TOP_LEVEL_COMPONENTS) {
    issues.push({
      severity: "error",
      code: "TOP_LEVEL_LIMIT",
      message: `A message can have at most ${LIMITS.TOP_LEVEL_COMPONENTS} top-level components.`,
    });
  }

  const total = countComponents(message);
  if (total > LIMITS.TOTAL_COMPONENTS) {
    issues.push({
      severity: "error",
      code: "TOTAL_COMPONENT_LIMIT",
      message: `A message can have at most ${LIMITS.TOTAL_COMPONENTS} components in total (currently ${total}).`,
    });
  }

  const chars = countCharacters(message);
  if (chars > LIMITS.TOTAL_CHARACTERS) {
    issues.push({
      severity: "error",
      code: "TOTAL_CHARACTER_LIMIT",
      message: `Total text length is ${chars}, exceeding the ${LIMITS.TOTAL_CHARACTERS}-character cap.`,
    });
  }

  if (message.username && message.username.length > LIMITS.WEBHOOK_USERNAME) {
    issues.push({
      severity: "error",
      code: "USERNAME_TOO_LONG",
      message: `Username can be at most ${LIMITS.WEBHOOK_USERNAME} characters.`,
    });
  }

  if (message.username && RESERVED_USERNAME_RE.test(message.username)) {
    issues.push({
      severity: "error",
      code: "USERNAME_RESERVED",
      message: "Username can’t contain “clyde” or “discord” — Discord rejects those names.",
    });
  }

  validateMessageLevel(message, issues);

  for (const top of message.components) validateNode(top, issues, "top");

  validateUniqueIds(message, issues);

  return { ok: issues.every((i) => i.severity !== "error"), issues };
}

/**
 * Discord rejects a message when two components share the same numeric `id`
 * (Components V2), or when two interactive components (buttons / selects)
 * share the same `custom_id`. Flag every offending node so the UI can
 * highlight all of them, not just the second occurrence.
 */
function validateUniqueIds(message: WebhookMessage, issues: ValidationIssue[]): void {
  const byNumericId = new Map<number, EditorId[]>();
  const byCustomId = new Map<string, EditorId[]>();

  for (const node of walk(message)) {
    if (typeof node.id === "number" && Number.isInteger(node.id)) {
      const seen = byNumericId.get(node.id);
      if (seen) seen.push(node._id);
      else byNumericId.set(node.id, [node._id]);
    }
    if ((isButton(node) || isSelect(node)) && "custom_id" in node && node.custom_id) {
      const seen = byCustomId.get(node.custom_id);
      if (seen) seen.push(node._id);
      else byCustomId.set(node.custom_id, [node._id]);
    }
  }

  for (const [id, nodeIds] of byNumericId) {
    if (nodeIds.length < 2) continue;
    for (const nodeId of nodeIds) {
      issues.push({
        nodeId,
        severity: "error",
        code: "COMPONENT_ID_DUPLICATE",
        message: `Component id ${id} is used by ${nodeIds.length} components — each id must be unique within a message.`,
      });
    }
  }

  for (const [customId, nodeIds] of byCustomId) {
    if (nodeIds.length < 2) continue;
    for (const nodeId of nodeIds) {
      issues.push({
        nodeId,
        severity: "error",
        code: "CUSTOM_ID_DUPLICATE",
        message: `Custom ID “${customId}” is used by ${nodeIds.length} components — give each one its own.`,
      });
    }
  }
}

function validateMessageLevel(message: WebhookMessage, issues: ValidationIssue[]): void {
  const am = message.allowed_mentions;
  if (am) {
    if (am.parse?.includes("roles") && am.roles && am.roles.length > 0) {
      issues.push({
        severity: "error",
        code: "ALLOWED_MENTIONS_CONFLICT_ROLES",
        message:
          "Use either the @role chip (any role can be pinged) or allowed role IDs (only those can) — Discord rejects both at once.",
      });
    }
    if (am.parse?.includes("users") && am.users && am.users.length > 0) {
      issues.push({
        severity: "error",
        code: "ALLOWED_MENTIONS_CONFLICT_USERS",
        message:
          "Use either the @user chip (anyone can be pinged) or allowed user IDs (only those can) — Discord rejects both at once.",
      });
    }
    for (const id of am.roles ?? []) {
      if (!SNOWFLAKE_RE.test(id)) {
        issues.push({
          severity: "error",
          code: "ALLOWED_MENTIONS_BAD_ROLE",
          message: `Allowed role IDs: “${id}” isn’t a valid Discord ID.`,
        });
      }
    }
    for (const id of am.users ?? []) {
      if (!SNOWFLAKE_RE.test(id)) {
        issues.push({
          severity: "error",
          code: "ALLOWED_MENTIONS_BAD_USER",
          message: `Allowed user IDs: “${id}” isn’t a valid Discord ID.`,
        });
      }
    }
  }

  // message_reference is intentionally not validated here — the webhook
  // execute endpoint does not accept it, so the wire encoder strips it.
  // Preserving the field on the editor type is enough for round-trip safety.

  if (message.thread_name && message.thread_name.length > LIMITS.THREAD_NAME) {
    issues.push({
      severity: "error",
      code: "THREAD_NAME_LONG",
      message: `Thread name can be at most ${LIMITS.THREAD_NAME} characters.`,
    });
  }

  if (message.applied_tags) {
    if (message.applied_tags.length > LIMITS.APPLIED_TAGS) {
      issues.push({
        severity: "error",
        code: "APPLIED_TAGS_LIMIT",
        message: `Forum posts accept at most ${LIMITS.APPLIED_TAGS} applied tags.`,
      });
    }
    for (const id of message.applied_tags) {
      if (!SNOWFLAKE_RE.test(id)) {
        issues.push({
          severity: "error",
          code: "APPLIED_TAG_BAD",
          message: `Applied tags: “${id}” isn’t a valid Discord ID.`,
        });
      }
    }
    if (message.applied_tags.length > 0 && !message.thread_name) {
      issues.push({
        severity: "warning",
        code: "APPLIED_TAGS_NO_THREAD",
        message: "Applied tags only take effect on a new forum post — add a thread name too.",
      });
    }
  }

  if (message.avatar_url && message.avatar_url.length > LIMITS.WEBHOOK_AVATAR_URL) {
    issues.push({
      severity: "error",
      code: "AVATAR_URL_TOO_LONG",
      message: `Avatar URL can be at most ${LIMITS.WEBHOOK_AVATAR_URL} characters.`,
    });
  }
  if (
    message.avatar_url &&
    !containsPlaceholder(message.avatar_url) &&
    !isValidUrl(message.avatar_url)
  ) {
    // A `{server_icon}` avatar resolves to a real URL only at send, so don't
    // flag its raw token form here.
    issues.push({
      severity: "warning",
      code: "AVATAR_URL_INVALID",
      message: "Avatar URL doesn't look like a valid http(s) URL.",
    });
  }
}

/**
 * Where a component sits, for {@link placementIssue}. Action-row children are
 * checked inline by the row itself (the `"row"` case), so they never reach
 * `validateNode`.
 */
type Slot = "top" | "container" | "section-text" | "accessory";

/**
 * Every component type this schema knows. Placement is only judged for these:
 * a type from outside the set may be one Discord added later, and this can't
 * know where Discord accepts it, so flagging it would block a send Discord
 * might well take. Unknown types are left to Discord, as before.
 */
const KNOWN_TYPES: ReadonlySet<number> = new Set(Object.values(ComponentType));

/**
 * What Discord accepts in each place (Components V2 — the only kind of message
 * DWEEB sends): a button or menu only ever sits in an action row (a button may
 * also be a section's accessory), a thumbnail only as an accessory, a container
 * never inside another. The editor can't build anything else, but the import
 * boundary takes any tree — JSON import, share links, an AI reply, a peer's
 * collab op, the MCP server's payloads — and a misplaced component used to pass
 * validation and then 400 at Discord on send.
 */
const ALLOWED_IN: Record<Slot, ReadonlySet<number>> = {
  top: new Set([
    ComponentType.ActionRow,
    ComponentType.Section,
    ComponentType.TextDisplay,
    ComponentType.MediaGallery,
    ComponentType.File,
    ComponentType.Separator,
    ComponentType.Container,
  ]),
  container: new Set([
    ComponentType.ActionRow,
    ComponentType.Section,
    ComponentType.TextDisplay,
    ComponentType.MediaGallery,
    ComponentType.File,
    ComponentType.Separator,
  ]),
  "section-text": new Set([ComponentType.TextDisplay]),
  accessory: new Set([ComponentType.Button, ComponentType.Thumbnail]),
};

const SLOT_WHERE: Record<Slot | "row", string> = {
  top: "at the top level of a message",
  container: "directly inside a container",
  "section-text": "in a section's text",
  accessory: "as a section's accessory",
  row: "in an action row",
};

/** What to do about a misplaced component that is neither a button nor a menu. */
function misplacedHint(type: number, slot: Slot | "row"): string | null {
  if (type === ComponentType.Thumbnail) return "it can only be a section's accessory.";
  if (type === ComponentType.TextInput) return "text inputs only work in modals.";
  if (type === ComponentType.Container && slot === "container") {
    return "containers can't be nested.";
  }
  if (slot === "row") return "a row holds buttons, or one menu.";
  if (slot === "section-text") return "a section's text holds Text components only.";
  if (slot === "accessory") return "the accessory is a thumbnail or a button.";
  return null;
}

/**
 * Why a component can't sit where it is, or null when Discord accepts it there
 * (or when it's a type this schema doesn't know — see {@link KNOWN_TYPES}).
 * Named in the tree's own words (`COMPONENT_META`), like the rest of the
 * validator's messages.
 */
function placementIssue(
  node: AnyComponent,
  slot: Slot | "row",
): { code: string; message: string } | null {
  // Widened on purpose: the types say only known components are here, but an
  // imported tree isn't bound by them — that is the whole point of this check.
  const type: number = node.type;
  if (!KNOWN_TYPES.has(type)) return null;
  if (slot === "row" ? isButton(node) || isSelect(node) : ALLOWED_IN[slot].has(type)) return null;
  const name = COMPONENT_META[type as ComponentTypeValue].label;
  const where = SLOT_WHERE[slot];
  if (isButton(node)) {
    return {
      code: "BUTTON_OUTSIDE_ROW",
      message: `${name} can't sit ${where} — put it in an action row, or make it a section's accessory.`,
    };
  }
  if (isSelect(node)) {
    return {
      code: "SELECT_OUTSIDE_ROW",
      message: `${name} can't sit ${where} — put it in an action row of its own.`,
    };
  }
  const hint = misplacedHint(type, slot);
  return {
    code: "COMPONENT_MISPLACED",
    message: `${name} can't sit ${where}${hint ? ` — ${hint}` : "."}`,
  };
}

function validateNode(node: AnyComponent, issues: ValidationIssue[], slot: Slot): void {
  if (node.id !== undefined && !Number.isInteger(node.id)) {
    issues.push({
      nodeId: node._id,
      severity: "error",
      code: "COMPONENT_ID_NOT_INTEGER",
      message: "Component id must be a whole number.",
    });
  }

  // Placement first, then the component's own fields as usual: a misplaced
  // button with no label should be told both, not fixed twice.
  const misplaced = placementIssue(node, slot);
  if (misplaced) issues.push({ nodeId: node._id, severity: "error", ...misplaced });

  // Buttons and selects are usually validated inside their action row, but a
  // Button can also appear as a Section *accessory* — which only reaches this
  // function via `validateNode(section.accessory)`. Without this dispatch an
  // accessory button's missing URL / custom_id / label would go unchecked and
  // Discord would reject the message on send. (Row children never recurse
  // through here, so this never double-validates them.) A misplaced one lands
  // here too, and gets the same checks.
  if (isButton(node)) {
    validateButton(node, issues);
    return;
  }
  if (isSelect(node)) {
    validateSelect(node, issues);
    return;
  }

  if (isContainer(node)) {
    if (node.components.length === 0) {
      issues.push({
        nodeId: node._id,
        severity: "error",
        code: "CONTAINER_EMPTY",
        message: "Container must contain at least one component.",
      });
    }
    if (node.components.length > LIMITS.CONTAINER_CHILDREN) {
      issues.push({
        nodeId: node._id,
        severity: "error",
        code: "CONTAINER_CHILDREN_LIMIT",
        message: `Container can hold at most ${LIMITS.CONTAINER_CHILDREN} children.`,
      });
    }
    if (
      node.accent_color !== undefined &&
      node.accent_color !== null &&
      (node.accent_color < 0 ||
        node.accent_color > LIMITS.COLOR_MAX ||
        !Number.isInteger(node.accent_color))
    ) {
      issues.push({
        nodeId: node._id,
        severity: "error",
        code: "CONTAINER_ACCENT_RANGE",
        message: `Container accent color must be a whole number from 0 to ${LIMITS.COLOR_MAX} (0xFFFFFF).`,
      });
    }
    for (const child of node.components) validateNode(child, issues, "container");
    return;
  }

  if (isSection(node)) {
    const n = node.components.length;
    if (n < LIMITS.SECTION_TEXTS_MIN || n > LIMITS.SECTION_TEXTS_MAX) {
      issues.push({
        nodeId: node._id,
        severity: "error",
        code: "SECTION_TEXT_COUNT",
        message: `Section must contain ${LIMITS.SECTION_TEXTS_MIN}–${LIMITS.SECTION_TEXTS_MAX} text components.`,
      });
    }
    for (const t of node.components) validateNode(t, issues, "section-text");
    // Guarded because a malformed tree must be *reported*, not crashed on (the
    // deref used to throw an uncaught TypeError). The import boundary refuses a
    // payload whose section has no accessory, so this only fires if such a tree
    // reaches the editor another way — and then it blocks send, which is right:
    // Discord rejects an accessory-less section.
    if (node.accessory) {
      validateNode(node.accessory, issues, "accessory");
    } else {
      issues.push({
        nodeId: node._id,
        severity: "error",
        code: "SECTION_ACCESSORY_MISSING",
        message: "Section needs an accessory — either a thumbnail or a button.",
      });
    }
    return;
  }

  if (isMediaGallery(node)) {
    if (node.items.length === 0) {
      issues.push({
        nodeId: node._id,
        severity: "error",
        code: "GALLERY_EMPTY",
        message: "Media gallery must contain at least one item.",
      });
    }
    if (node.items.length > LIMITS.GALLERY_ITEMS) {
      issues.push({
        nodeId: node._id,
        severity: "error",
        code: "GALLERY_LIMIT",
        message: `Media gallery can hold at most ${LIMITS.GALLERY_ITEMS} items.`,
      });
    }
    // Attach each item's issues to the *item's* editor id (not the gallery's)
    // so the editor can flag the exact broken media row and its inspector.
    node.items.forEach((item, i) => {
      validateMediaItem(item.media, item._id, issues, `Gallery item ${i + 1}`);
      if (item.description && item.description.length > LIMITS.MEDIA_DESCRIPTION) {
        issues.push({
          nodeId: item._id,
          severity: "error",
          code: "GALLERY_DESC_LONG",
          message: `Gallery item ${i + 1}: alt text can be at most ${LIMITS.MEDIA_DESCRIPTION} characters.`,
        });
      }
    });
    return;
  }

  if (isFile(node)) {
    validateMediaItem(node.file, node._id, issues, "File", { requireAttachment: true });
  }

  if (isThumbnail(node)) {
    validateMediaItem(node.media, node._id, issues, "Thumbnail");
    if (node.description && node.description.length > LIMITS.MEDIA_DESCRIPTION) {
      issues.push({
        nodeId: node._id,
        severity: "error",
        code: "THUMB_DESC_LONG",
        message: `Thumbnail alt text can be at most ${LIMITS.MEDIA_DESCRIPTION} characters.`,
      });
    }
  }

  if (isActionRow(node)) {
    if (node.components.length === 0) {
      issues.push({
        nodeId: node._id,
        severity: "error",
        code: "ROW_EMPTY",
        message: "Action row must contain at least one button or a select.",
      });
    }

    const firstChild = node.components[0];
    if (firstChild && isSelect(firstChild)) {
      if (node.components.length !== 1) {
        issues.push({
          nodeId: node._id,
          severity: "error",
          code: "ROW_SELECT_MIXED",
          message: "An action row with a select must contain exactly one component.",
        });
      }
      validateSelect(firstChild, issues);
    } else {
      if (node.components.length > LIMITS.ACTION_ROW_BUTTONS) {
        issues.push({
          nodeId: node._id,
          severity: "error",
          code: "ROW_LIMIT",
          message: `Action row can hold at most ${LIMITS.ACTION_ROW_BUTTONS} buttons.`,
        });
      }
      for (const child of node.components as AnyComponent[]) {
        if (isSelect(child)) {
          issues.push({
            nodeId: node._id,
            severity: "error",
            code: "ROW_SELECT_MIXED",
            message: "Buttons and selects cannot share the same action row.",
          });
        } else if (isButton(child)) {
          validateButton(child, issues);
        } else {
          // Anything else in a row (a text display, a thumbnail, a text input…)
          // used to be validated *as a button*; Discord rejects the row.
          const misplaced = placementIssue(child, "row");
          if (misplaced) issues.push({ nodeId: child._id, severity: "error", ...misplaced });
        }
      }
    }
    return;
  }

  if (isTextDisplay(node)) {
    // Second layer, same reasoning as the section accessory above: the import
    // boundary fills a missing `content` with `""`, and this deref must report
    // rather than throw for a tree that arrived some other way.
    const content = typeof node.content === "string" ? node.content : "";
    if (content.trim().length === 0) {
      // `content` is a required field (1–4000 chars) — Discord rejects a Text
      // Display with empty/whitespace-only content, so this blocks send.
      issues.push({
        nodeId: node._id,
        severity: "error",
        code: "TEXT_EMPTY",
        message: "Text display can't be empty — Discord requires content here.",
      });
    }
    if (content.length > LIMITS.TEXT_DISPLAY_CONTENT) {
      issues.push({
        nodeId: node._id,
        severity: "error",
        code: "TEXT_TOO_LONG",
        message: `Text can be at most ${LIMITS.TEXT_DISPLAY_CONTENT} characters.`,
      });
    }
  }
}

function validateButton(btn: ButtonComponent, issues: ValidationIssue[]): void {
  if (btn.style === ButtonStyle.Link) {
    // Second layer, same reasoning as the section accessory above: the import
    // boundary fills a missing `url` with `""`, and `containsPlaceholder` reads
    // `.indexOf` off whatever it is handed — so an absent URL must arrive here
    // as an empty string that gets reported, not as a TypeError thrown out of
    // the live validator.
    const url = typeof btn.url === "string" ? btn.url : "";
    // A URL holding a `{token}` resolves to a real https link only at send, so
    // skip the format check on its raw form — the length cap still applies.
    if (!containsPlaceholder(url) && !isValidHttpsUrl(url)) {
      issues.push({
        nodeId: btn._id,
        severity: "error",
        code: "BUTTON_URL_INVALID",
        message: "Link button needs a valid https:// URL.",
      });
    } else if (url.length > LIMITS.BUTTON_URL) {
      issues.push({
        nodeId: btn._id,
        severity: "error",
        code: "BUTTON_URL_LONG",
        message: `Link button URL can be at most ${LIMITS.BUTTON_URL} characters.`,
      });
    }
    // A link-plugin URL may still carry a fill-me slot — a non-core `{token}`
    // (e.g. `{form_id}`) the admin must replace with their own value, usually
    // by pasting the finished link from the service. Its raw form sails past
    // the placeholder exemption above but nothing ever substitutes it, so the
    // posted button would open a dead link — flag it here, where it blocks
    // send. One rule for every link plugin; no per-plugin machinery.
    const linkPlugin = matchLinkPlugin(LINK_PLUGINS, url);
    if (linkPlugin) {
      for (const token of unfilledLinkTokens(url)) {
        issues.push({
          nodeId: btn._id,
          severity: "error",
          code: "BUTTON_LINK_URL_UNFINISHED",
          message: `${linkPlugin.name}: the URL still has a {${token}} placeholder — paste your finished link over it (this button's Action panel says where to get it).`,
        });
      }
    }
  } else if (btn.style === ButtonStyle.Premium) {
    if (!btn.sku_id) {
      issues.push({
        nodeId: btn._id,
        severity: "error",
        code: "BUTTON_SKU_MISSING",
        message: "Premium button needs a SKU ID.",
      });
    } else if (!containsPlaceholder(btn.sku_id) && !SNOWFLAKE_RE.test(btn.sku_id)) {
      issues.push({
        nodeId: btn._id,
        severity: "error",
        code: "BUTTON_SKU_INVALID",
        message: "Premium button: the SKU ID isn’t a valid Discord ID.",
      });
    }
  } else {
    if (!btn.custom_id) {
      issues.push({
        nodeId: btn._id,
        severity: "error",
        code: "BUTTON_CUSTOM_ID_MISSING",
        message: "Button needs a custom ID — it’s how your bot tells its clicks apart.",
      });
    }
    if (btn.custom_id && btn.custom_id.length > LIMITS.BUTTON_CUSTOM_ID) {
      issues.push({
        nodeId: btn._id,
        severity: "error",
        code: "BUTTON_CUSTOM_ID_LONG",
        message: `Custom ID can be at most ${LIMITS.BUTTON_CUSTOM_ID} characters.`,
      });
    }
  }

  const hasLabel = "label" in btn && btn.label && btn.label.length > 0;
  const hasEmoji = "emoji" in btn && btn.emoji && (btn.emoji.id || btn.emoji.name);
  // Discord rejects a non-premium button that carries neither a label nor an
  // emoji, so this blocks send rather than merely warning. (Premium buttons
  // draw their label from the SKU, so they're exempt.)
  if (btn.style !== ButtonStyle.Premium && !hasLabel && !hasEmoji) {
    issues.push({
      nodeId: btn._id,
      severity: "error",
      code: "BUTTON_NO_LABEL",
      message: "Button needs a label or an emoji — Discord rejects a button with neither.",
    });
  }
  if ("label" in btn && btn.label && btn.label.length > LIMITS.BUTTON_LABEL) {
    issues.push({
      nodeId: btn._id,
      severity: "error",
      code: "BUTTON_LABEL_LONG",
      message: `Button label can be at most ${LIMITS.BUTTON_LABEL} characters.`,
    });
  }

  // Custom emoji needs both `id` and a non-empty `name` (the alias). Unicode
  // emoji needs only `name` — Discord rejects an `id` without a `name`.
  if ("emoji" in btn && btn.emoji?.id && !btn.emoji.name) {
    issues.push({
      nodeId: btn._id,
      severity: "error",
      code: "EMOJI_NAME_MISSING",
      message: "Custom emoji needs its name as well as its ID.",
    });
  }
}

function validateSelect(sel: SelectComponent, issues: ValidationIssue[]): void {
  if (!sel.custom_id) {
    issues.push({
      nodeId: sel._id,
      severity: "error",
      code: "SELECT_CUSTOM_ID_MISSING",
      message: "Menu needs a custom ID — it’s how your bot tells its picks apart.",
    });
  } else if (sel.custom_id.length > LIMITS.SELECT_CUSTOM_ID) {
    issues.push({
      nodeId: sel._id,
      severity: "error",
      code: "SELECT_CUSTOM_ID_LONG",
      message: `Custom ID can be at most ${LIMITS.SELECT_CUSTOM_ID} characters.`,
    });
  }
  if (sel.placeholder && sel.placeholder.length > LIMITS.SELECT_PLACEHOLDER) {
    issues.push({
      nodeId: sel._id,
      severity: "error",
      code: "SELECT_PLACEHOLDER_LONG",
      message: `Placeholder can be at most ${LIMITS.SELECT_PLACEHOLDER} characters.`,
    });
  }

  const min = sel.min_values ?? 1;
  const max = sel.max_values ?? 1;
  if (min < LIMITS.SELECT_MIN_VALUES || min > LIMITS.SELECT_MAX_VALUES) {
    issues.push({
      nodeId: sel._id,
      severity: "error",
      code: "SELECT_MIN_RANGE",
      message: `Min selections must be between ${LIMITS.SELECT_MIN_VALUES} and ${LIMITS.SELECT_MAX_VALUES}.`,
    });
  }
  if (max < 1 || max > LIMITS.SELECT_MAX_VALUES) {
    issues.push({
      nodeId: sel._id,
      severity: "error",
      code: "SELECT_MAX_RANGE",
      message: `Max selections must be between 1 and ${LIMITS.SELECT_MAX_VALUES}.`,
    });
  }
  if (min > max) {
    issues.push({
      nodeId: sel._id,
      severity: "error",
      code: "SELECT_MIN_GT_MAX",
      message: "Min selections can’t be more than max selections.",
    });
  }

  if (isStringSelect(sel)) {
    if (sel.options.length === 0) {
      issues.push({
        nodeId: sel._id,
        severity: "error",
        code: "SELECT_NO_OPTIONS",
        message: "Options menu needs at least one option.",
      });
    }
    if (sel.options.length > LIMITS.SELECT_OPTIONS) {
      issues.push({
        nodeId: sel._id,
        severity: "error",
        code: "SELECT_OPTIONS_LIMIT",
        message: `Options menu can hold at most ${LIMITS.SELECT_OPTIONS} options.`,
      });
    }
    const seenValues = new Set<string>();
    let defaults = 0;
    for (const [i, opt] of sel.options.entries()) {
      const where = `Option ${i + 1}`;
      if (!opt.label) {
        issues.push({
          nodeId: sel._id,
          severity: "error",
          code: "OPTION_LABEL_MISSING",
          message: `${where} needs a label.`,
        });
      } else if (opt.label.length > LIMITS.SELECT_OPTION_LABEL) {
        issues.push({
          nodeId: sel._id,
          severity: "error",
          code: "OPTION_LABEL_LONG",
          message: `${where}: label can be at most ${LIMITS.SELECT_OPTION_LABEL} characters.`,
        });
      }
      if (!opt.value) {
        issues.push({
          nodeId: sel._id,
          severity: "error",
          code: "OPTION_VALUE_MISSING",
          message: `${where} needs a value.`,
        });
      } else {
        if (opt.value.length > LIMITS.SELECT_OPTION_VALUE) {
          issues.push({
            nodeId: sel._id,
            severity: "error",
            code: "OPTION_VALUE_LONG",
            message: `${where}: value can be at most ${LIMITS.SELECT_OPTION_VALUE} characters.`,
          });
        }
        if (seenValues.has(opt.value)) {
          issues.push({
            nodeId: sel._id,
            severity: "error",
            code: "OPTION_VALUE_DUP",
            message: `${where}: value “${opt.value}” is already used by another option.`,
          });
        } else {
          seenValues.add(opt.value);
        }
      }
      if (opt.description && opt.description.length > LIMITS.SELECT_OPTION_DESCRIPTION) {
        issues.push({
          nodeId: sel._id,
          severity: "error",
          code: "OPTION_DESC_LONG",
          message: `${where}: description can be at most ${LIMITS.SELECT_OPTION_DESCRIPTION} characters.`,
        });
      }
      if (opt.emoji?.id && !opt.emoji.name) {
        issues.push({
          nodeId: sel._id,
          severity: "error",
          code: "OPTION_EMOJI_NAME",
          message: `${where}: custom emoji needs its name as well as its ID.`,
        });
      }
      if (opt.default) defaults++;
    }
    if (defaults > max) {
      issues.push({
        nodeId: sel._id,
        severity: "error",
        code: "OPTION_DEFAULT_OVER_MAX",
        message: "More options are selected by default than max selections allows.",
      });
    }
    // You can't allow choosing more items than exist — Discord rejects a
    // string select whose max_values exceeds its option count.
    if (sel.options.length > 0 && max > sel.options.length) {
      issues.push({
        nodeId: sel._id,
        severity: "error",
        code: "SELECT_MAX_OVER_OPTIONS",
        message: `Max selections (${max}) can’t be more than the number of options (${sel.options.length}).`,
      });
    }
  } else if (
    isUserSelect(sel) ||
    isRoleSelect(sel) ||
    isMentionableSelect(sel) ||
    isChannelSelect(sel)
  ) {
    const dvs = sel.default_values ?? [];
    if (dvs.length > LIMITS.SELECT_DEFAULT_VALUES) {
      issues.push({
        nodeId: sel._id,
        severity: "error",
        code: "SELECT_DEFAULTS_LIMIT",
        message: `A menu can have at most ${LIMITS.SELECT_DEFAULT_VALUES} default selections.`,
      });
    }
    if (dvs.length > max) {
      issues.push({
        nodeId: sel._id,
        severity: "error",
        code: "SELECT_DEFAULTS_OVER_MAX",
        message: "More default selections than max selections allows.",
      });
    }
    for (const dv of dvs) {
      if (!SNOWFLAKE_RE.test(dv.id)) {
        issues.push({
          nodeId: sel._id,
          severity: "error",
          code: "SELECT_DEFAULT_BAD_ID",
          message: `Default selections: “${dv.id}” isn’t a valid Discord ID.`,
        });
      }
    }
  }
}

function validateMediaItem(
  media: UnfurledMediaItem,
  nodeId: EditorId,
  issues: ValidationIssue[],
  context: string,
  opts: { requireAttachment?: boolean } = {},
): void {
  const hasUrl = typeof media.url === "string" && media.url.length > 0;
  const hasAttachmentId = typeof media.attachment_id === "string" && media.attachment_id.length > 0;

  if (!hasUrl && !hasAttachmentId) {
    issues.push({
      nodeId,
      severity: "error",
      code: "MEDIA_REQUIRED",
      message: `${context} needs a URL or an attachment ID.`,
    });
    return;
  }
  if (hasAttachmentId && !SNOWFLAKE_RE.test(media.attachment_id!)) {
    issues.push({
      nodeId,
      severity: "error",
      code: "MEDIA_ATTACHMENT_ID_BAD",
      message: `${context}: the attachment ID isn’t a valid Discord ID.`,
    });
  }
  if (hasUrl && containsPlaceholder(media.url!)) {
    // A `{server_icon}`-style URL resolves to a real link only at send; skip
    // every format check on its raw token form (there's no session blob to
    // resolve either). Thumbnail / gallery accept the resolved external URL;
    // File still won't render one, but that's the user's call once they opt in.
  } else if (hasUrl) {
    if (!isValidMediaUrl(media.url!)) {
      // A malformed media URL is rejected by Discord (it can't unfurl it), so
      // this blocks send rather than merely warning.
      issues.push({
        nodeId,
        severity: "error",
        code: "MEDIA_URL_INVALID",
        message: `${context}: use an https:// link or an attachment://filename reference, or upload a file.`,
      });
    } else if (
      opts.requireAttachment &&
      isExternalWebUrl(media.url!) &&
      !isDiscordCdnUrl(media.url!)
    ) {
      // The File component's media only renders uploaded attachments — Discord
      // rejects an external URL here (unlike Thumbnail / Media Gallery).
      issues.push({
        nodeId,
        severity: "error",
        code: "FILE_URL_NOT_ATTACHMENT",
        message: `${context} can only display an uploaded attachment — upload a file or use an attachment://filename reference, not an external URL.`,
      });
    }
    checkAttachmentResolves(media.url!, nodeId, issues);
  }
}

function isValidHttpsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function isValidMediaUrl(url: string): boolean {
  if (url.startsWith("attachment://")) return url.length > "attachment://".length;
  if (url.startsWith("session://")) return parseSessionUrl(url) !== null;
  return isValidUrl(url);
}

/** A plain external web URL — not an `attachment://` or in-session `session://` ref. */
function isExternalWebUrl(url: string): boolean {
  if (url.startsWith("attachment://") || url.startsWith("session://")) return false;
  return isValidUrl(url);
}

/**
 * Discord's own CDN hosts. A File component restored from a Discord message
 * response can carry a CDN url in `url`, so we don't flag those — that keeps a
 * restore → edit → resend round-trip from being blocked. Freshly-pasted
 * external URLs are still rejected, since the File component won't render them.
 */
function isDiscordCdnUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "cdn.discordapp.com" || host === "media.discordapp.net";
  } catch {
    return false;
  }
}

/**
 * If `url` is a session blob ref, flag the component when the blob isn't in
 * this browser's registry. That happens when a collaborator's upload synced
 * into the shared draft (in-session bytes never leave the uploader's browser),
 * when a resumed room draft references an upload nobody holds anymore, or when
 * the local copy was evicted. Errors block send — a post from here would ship a
 * dangling `attachment://` reference Discord rejects — so the advice names both
 * ways out: whoever holds the file posts, or it's replaced on this device.
 */
function checkAttachmentResolves(url: string, nodeId: EditorId, issues: ValidationIssue[]): void {
  const parsed = parseSessionUrl(url);
  if (!parsed) return;
  if (getAttachmentFile(parsed.blobId)) return;
  issues.push({
    nodeId,
    severity: "error",
    code: "ATTACHMENT_MISSING",
    message:
      "This uploaded file isn't in this browser — if a teammate added it, ask them to post; otherwise re-attach it or use a media URL.",
  });
}
