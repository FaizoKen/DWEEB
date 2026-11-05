/**
 * Discord **component embeds** (2026-10-05): a website names, in its own HTML,
 * the Components V2 layout Discord shows when someone shares one of its links —
 * no app, no bot, no webhook. It is a *display-only* subset of a message:
 *
 *  - the payload is `{"component": <Container>}` — exactly one Container and
 *    nothing beside it, delivered in `<head>` as
 *    `<script id="discord:component-embed" type="application/json">`;
 *  - inside it only Action Row, Button, Section, Text Display, Thumbnail, Media
 *    Gallery and Separator (types 1, 2, 9, 10, 11, 12, 14), no nested Container;
 *  - buttons are Link buttons (style 5) carrying only `id`, `type`, `url`,
 *    `style`, `label`, `emoji` and `disabled`, with a label, an emoji or both —
 *    "any other key invalidates the entire payload";
 *  - media are `http(s)` URLs of at most 2,048 characters in a format Discord
 *    plays (.png .gif .jpg .jpeg .webp .avif, .mp4 .webm .mov) — so never an
 *    upload, since a web page has nothing to upload;
 *  - at most 10 gallery items across the whole embed, at most 40 components
 *    including the Container, and at most 3,000 bytes of payload, escapes
 *    counted at their full length.
 *
 * Some violations make Discord show **no** preview at all rather than the
 * page's Open Graph fallback, so this module never emits a payload outside
 * those rules: it rebuilds each node from a per-type key allowlist and leaves
 * out whatever can't appear, naming each omission so the editor can say what
 * changed. Pure and dependency-free: the Code tab calls it, and the static-site
 * generator calls it at build time for DWEEB's own pages (with the audit
 * re-checking the result).
 *
 * Reference: https://docs.discord.com/developers/link-previews/component-embeds
 */

type Node = Record<string, unknown>;

export const COMPONENT_EMBED_MAX_BYTES = 3000;
export const COMPONENT_EMBED_MAX_COMPONENTS = 40;
export const COMPONENT_EMBED_MAX_GALLERY_ITEMS = 10;
const MAX_URL_LENGTH = 2048;
/** Discord's Embed Debugger: paste a page URL to see how Discord reads it. */
export const EMBED_DEBUGGER_URL = "https://discord.com/developers/embeds";

const ACTION_ROW = 1;
const BUTTON = 2;
const SECTION = 9;
const TEXT_DISPLAY = 10;
const THUMBNAIL = 11;
const MEDIA_GALLERY = 12;
const FILE = 13;
const SEPARATOR = 14;
const CONTAINER = 17;
const LINK_STYLE = 5;

const MEDIA_EXTENSIONS = new Set([
  "png",
  "gif",
  "jpg",
  "jpeg",
  "webp",
  "avif",
  "mp4",
  "webm",
  "mov",
]);

export interface ComponentEmbed {
  /** The payload, rebuilt to the rules above — `null` when nothing is left. */
  payload: { component: Node } | null;
  /** The payload as it goes in the `<script>`: compact, `<` escaped. */
  json: string;
  /** UTF-8 bytes of `json`, the figure Discord's 3,000-byte cap counts. */
  bytes: number;
  /** Components in the payload, the Container included. */
  componentCount: number;
  /** True when the message wasn't a single Container and was wrapped in one. */
  wrapped: boolean;
  /** What was left out or changed, in plain words, one line each. */
  omitted: string[];
  /** What still stops Discord showing it (size, count) — empty when it fits. */
  problems: string[];
}

/** The `<script>` element Discord reads, for a page's `<head>`. */
export function componentEmbedScript(json: string): string {
  return `<script id="discord:component-embed" type="application/json">${json}</script>`;
}

/**
 * JSON safe inside a `<script>` data block: `<` becomes `<`, so no text in
 * the message can close the element (`</script>`) or open a comment. Nothing
 * else is escaped — every escape costs bytes against the cap, and raw UTF-8 is
 * valid JSON.
 */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** UTF-8 length, the unit of Discord's payload cap. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Whether `url` can be a preview's media: http(s), short enough, and a format
 *  Discord plays, judged by the path's extension as Discord's own filter is. */
export function isPreviewMediaUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length === 0 || url.length > MAX_URL_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const ext = /\.([A-Za-z0-9]+)$/.exec(parsed.pathname)?.[1]?.toLowerCase();
  return ext !== undefined && MEDIA_EXTENSIONS.has(ext);
}

function isHttpUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length === 0 || url.length > MAX_URL_LENGTH) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function asNode(value: unknown): Node | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Node) : null;
}

function children(node: Node, key = "components"): Node[] {
  const list = node[key];
  return Array.isArray(list) ? list.map(asNode).filter((n): n is Node => n !== null) : [];
}

/** Copy only the listed keys that are present. */
function pick(node: Node, keys: readonly string[]): Node {
  const out: Node = {};
  for (const key of keys) if (node[key] !== undefined) out[key] = node[key];
  return out;
}

const KIND_NAMES: Record<number, string> = {
  3: "A dropdown menu",
  5: "A member menu",
  6: "A role menu",
  7: "A member / role menu",
  8: "A channel menu",
  [FILE]: "A file",
};

class Builder {
  omitted: string[] = [];
  galleryItems = 0;
  private galleryCapNoted = false;

  note(line: string): void {
    if (!this.omitted.includes(line)) this.omitted.push(line);
  }

  emoji(raw: unknown): Node | null {
    const e = asNode(raw);
    if (!e) return null;
    const out = pick(e, ["id", "name", "animated"]);
    return out.id || out.name ? out : null;
  }

  button(raw: Node): Node | null {
    if (raw.style !== LINK_STYLE) {
      this.note(
        "Buttons that run an action were left out — a link preview can only hold link buttons.",
      );
      return null;
    }
    if (!isHttpUrl(raw.url)) {
      this.note("A link button without an http(s) address was left out.");
      return null;
    }
    const out: Node = { type: BUTTON, style: LINK_STYLE, url: raw.url };
    const label = typeof raw.label === "string" && raw.label.trim() ? raw.label : null;
    const emoji = this.emoji(raw.emoji);
    if (label) out.label = label;
    if (emoji) out.emoji = emoji;
    if (raw.disabled === true) out.disabled = true;
    if (!label && !emoji) {
      this.note("A link button with neither a label nor an emoji was left out.");
      return null;
    }
    return out;
  }

  media(raw: unknown, what: string): Node | null {
    const media = asNode(raw);
    const url = media?.url;
    if (isPreviewMediaUrl(url)) return { url };
    if (typeof url === "string" && url.startsWith("attachment://")) {
      this.note(
        `${what} that is an uploaded file was left out — a link preview needs an https:// link to the image.`,
      );
    } else {
      this.note(
        `${what} without an https:// link to a .png, .jpg, .gif, .webp, .avif, .mp4, .webm or .mov file was left out.`,
      );
    }
    return null;
  }

  thumbnail(raw: Node): Node | null {
    const media = this.media(raw.media, "A thumbnail");
    if (!media) return null;
    const out: Node = { type: THUMBNAIL, media };
    if (typeof raw.description === "string" && raw.description) out.description = raw.description;
    if (raw.spoiler === true) out.spoiler = true;
    return out;
  }

  gallery(raw: Node): Node | null {
    const items: Node[] = [];
    for (const item of children(raw, "items")) {
      if (this.galleryItems >= COMPONENT_EMBED_MAX_GALLERY_ITEMS) {
        if (!this.galleryCapNoted) {
          this.galleryCapNoted = true;
          this.note(
            `Gallery images past the ${COMPONENT_EMBED_MAX_GALLERY_ITEMS}th were left out — a link preview shows at most ${COMPONENT_EMBED_MAX_GALLERY_ITEMS} across all its galleries.`,
          );
        }
        break;
      }
      const media = this.media(item.media, "A gallery image");
      if (!media) continue;
      const out: Node = { media };
      if (typeof item.description === "string" && item.description)
        out.description = item.description;
      if (item.spoiler === true) out.spoiler = true;
      items.push(out);
      this.galleryItems++;
    }
    return items.length ? { type: MEDIA_GALLERY, items } : null;
  }

  text(raw: Node): Node | null {
    return typeof raw.content === "string" && raw.content.trim()
      ? { type: TEXT_DISPLAY, content: raw.content }
      : null;
  }

  /** One child of the Container; a Section whose accessory can't stay is
   *  flattened into its text, which keeps everything the reader reads. */
  child(raw: Node): Node[] {
    switch (raw.type) {
      case TEXT_DISPLAY: {
        const t = this.text(raw);
        return t ? [t] : [];
      }
      case SEPARATOR:
        return [{ type: SEPARATOR, ...pick(raw, ["divider", "spacing"]) }];
      case MEDIA_GALLERY: {
        const g = this.gallery(raw);
        return g ? [g] : [];
      }
      case ACTION_ROW: {
        const buttons = children(raw)
          .map((c) => {
            if (c.type === BUTTON) return this.button(c);
            this.note(
              `${KIND_NAMES[c.type as number] ?? "A menu"} was left out — a link preview can't hold menus.`,
            );
            return null;
          })
          .filter((b): b is Node => b !== null);
        return buttons.length ? [{ type: ACTION_ROW, components: buttons }] : [];
      }
      case SECTION: {
        const texts = children(raw)
          .map((c) => (c.type === TEXT_DISPLAY ? this.text(c) : null))
          .filter((t): t is Node => t !== null);
        const accessory = asNode(raw.accessory);
        const kept =
          accessory?.type === THUMBNAIL
            ? this.thumbnail(accessory)
            : accessory?.type === BUTTON
              ? this.button(accessory)
              : null;
        if (texts.length === 0) return [];
        return kept ? [{ type: SECTION, components: texts, accessory: kept }] : texts;
      }
      case CONTAINER:
        this.note("A Container inside the Container was left out — Containers can't nest.");
        return [];
      default:
        this.note(
          `${KIND_NAMES[raw.type as number] ?? "A component Discord doesn't allow in link previews"} was left out.`,
        );
        return [];
    }
  }
}

function countComponents(node: Node): number {
  let n = 1;
  for (const c of children(node)) n += countComponents(c);
  const accessory = asNode(node.accessory);
  if (accessory) n += 1;
  return n;
}

/**
 * Turn a message's top-level components (wire shape: no editor ids) into a
 * component embed. A single Container is used as it is; a message with no
 * Container is wrapped in one (that is the only shape a preview has); a message
 * with a Container *and* other top-level components keeps the Container and
 * says what it dropped, since a Container can't hold another.
 */
export function buildComponentEmbed(components: readonly unknown[]): ComponentEmbed {
  const b = new Builder();
  const top = components.map(asNode).filter((n): n is Node => n !== null);
  const containers = top.filter((n) => n.type === CONTAINER);

  let source: Node;
  let wrapped = false;
  if (containers.length === 0) {
    source = { type: CONTAINER, components: top };
    wrapped = top.length > 0;
  } else {
    source = containers[0]!;
    if (top.length > 1) {
      b.note(
        containers.length > 1
          ? "Only the first Container was kept — a link preview is a single Container."
          : "Components outside the Container were left out — a link preview is a single Container.",
      );
    }
  }

  const inner = children(source).flatMap((c) => b.child(c));
  const container: Node = { type: CONTAINER };
  const accent = source.accent_color;
  if (typeof accent === "number" && Number.isInteger(accent) && accent >= 0 && accent <= 0xffffff)
    container.accent_color = accent;
  if (source.spoiler === true) container.spoiler = true;
  container.components = inner;

  if (inner.length === 0) {
    return {
      payload: null,
      json: "",
      bytes: 0,
      componentCount: 0,
      wrapped,
      omitted: b.omitted,
      problems: ["Nothing in this message can appear in a link preview — add some text."],
    };
  }

  const payload = { component: container };
  const json = scriptSafeJson(payload);
  const bytes = utf8Bytes(json);
  const componentCount = countComponents(container);
  const problems: string[] = [];
  if (bytes > COMPONENT_EMBED_MAX_BYTES)
    problems.push(
      `The preview is ${bytes.toLocaleString("en-US")} bytes; Discord's limit is ${COMPONENT_EMBED_MAX_BYTES.toLocaleString("en-US")}. Shorten the text or remove components.`,
    );
  if (componentCount > COMPONENT_EMBED_MAX_COMPONENTS)
    problems.push(
      `The preview has ${componentCount} components; Discord's limit is ${COMPONENT_EMBED_MAX_COMPONENTS}, the Container included.`,
    );
  return { payload, json, bytes, componentCount, wrapped, omitted: b.omitted, problems };
}

/**
 * Re-check a finished payload against every rule, independently of the
 * builder — what the static-site audit runs over each generated page, so a
 * future edit to a page's card can't ship a payload that kills its preview.
 * Returns the violations, empty when the payload is valid.
 */
export function componentEmbedViolations(json: string): string[] {
  const out: string[] = [];
  if (utf8Bytes(json) > COMPONENT_EMBED_MAX_BYTES) out.push("over 3,000 bytes");
  if (/<\/script/i.test(json)) out.push("contains </script");
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return [...out, "not JSON"];
  }
  const obj = asNode(root);
  if (!obj || Object.keys(obj).length !== 1 || !asNode(obj.component)) {
    return [...out, 'not {"component": <Container>}'];
  }
  const container = obj.component as Node;
  if (container.type !== CONTAINER) out.push("top-level component is not a Container");
  let count = 0;
  let gallery = 0;
  const allowedKeys: Record<number, readonly string[]> = {
    [CONTAINER]: ["type", "id", "components", "accent_color", "spoiler"],
    [ACTION_ROW]: ["type", "id", "components"],
    [BUTTON]: ["id", "type", "url", "style", "label", "emoji", "disabled"],
    [SECTION]: ["type", "id", "components", "accessory"],
    [TEXT_DISPLAY]: ["type", "id", "content"],
    [THUMBNAIL]: ["type", "id", "media", "description", "spoiler"],
    [MEDIA_GALLERY]: ["type", "id", "items"],
    [SEPARATOR]: ["type", "id", "divider", "spacing"],
  };
  const visit = (node: Node, depth: number): void => {
    count++;
    const type = node.type as number;
    const keys = allowedKeys[type];
    if (!keys) {
      out.push(`type ${String(node.type)} is not allowed`);
      return;
    }
    if (type === CONTAINER && depth > 0) out.push("nested Container");
    for (const key of Object.keys(node))
      if (!keys.includes(key)) out.push(`type ${type} carries "${key}"`);
    if (type === BUTTON) {
      if (node.style !== LINK_STYLE) out.push("a button is not link-style");
      if (!isHttpUrl(node.url)) out.push("a button has no http(s) url");
      if (!node.label && !node.emoji) out.push("a button has neither label nor emoji");
    }
    if (type === THUMBNAIL && !isPreviewMediaUrl(asNode(node.media)?.url))
      out.push("a thumbnail's media is not a supported http(s) URL");
    if (type === MEDIA_GALLERY) {
      for (const item of children(node, "items")) {
        gallery++;
        if (!isPreviewMediaUrl(asNode(item.media)?.url))
          out.push("a gallery item's media is not a supported http(s) URL");
      }
    }
    for (const c of children(node)) visit(c, depth + 1);
    const accessory = asNode(node.accessory);
    if (accessory) visit(accessory, depth + 1);
  };
  visit(container, 0);
  if (count > COMPONENT_EMBED_MAX_COMPONENTS) out.push(`${count} components (max 40)`);
  if (gallery > COMPONENT_EMBED_MAX_GALLERY_ITEMS) out.push(`${gallery} gallery items (max 10)`);
  return out;
}
