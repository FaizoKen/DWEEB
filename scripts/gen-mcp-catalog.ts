/**
 * Generate the data the Rust MCP server serves, and the corpus that pins its
 * validator to this one.
 *
 * The remote MCP server (`server/src/mcp/`) is Rust, so it cannot import the
 * TypeScript schema layer the way the local stdio server does. Two kinds of
 * thing had to cross that line, and they are treated very differently:
 *
 *  - **Data** — the limits, the core placeholder tokens, the link-plugin URL
 *    prefixes, and all 36 templates — is *generated* here into
 *    `server/src/mcp/catalog.json`. Hand-porting three thousand lines of
 *    template literals would guarantee drift the first time someone edits a
 *    template; generating them means `src/data/presets.ts` stays the only place
 *    a template exists.
 *  - **Rules** — the ~70 validation checks — genuinely have to be rewritten in
 *    Rust. Nothing can generate those. So instead they are *pinned*: this script
 *    also emits `server/src/mcp/validation-corpus.json`, a set of messages with
 *    the exact issue codes the TypeScript validator produces for each, and both
 *    implementations are tested against it. A rule that drifts on either side
 *    fails a test on that side rather than surfacing as a message Discord
 *    rejects.
 *
 * The corpus is only worth anything if it exercises every rule, so this script
 * reads the validator's source, collects every `code:` it can emit, and
 * **fails** if the corpus does not cover one. Adding a validation rule without
 * a case that triggers it therefore breaks the build, which is the point.
 *
 * Run: `bun run gen:mcp` (also run by `bun run build`).
 * Output is committed — the server's Docker build context only copies
 * `server/src`, and a build must not depend on a JS toolchain.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LIMITS } from "@/core/schema/limits";
import { CURRENT_VERSION } from "@/core/serialization/version";
import { validateMessage, type ValidationIssue } from "@/core/schema/validation";
import { buildPathIndex } from "@/core/schema/traversal";
import { attachEditorFields, stripEditorFields } from "@/core/serialization/normalize";
import { ButtonStyle, ComponentType, type WebhookMessage } from "@/core/schema/types";
import { CORE_PLACEHOLDERS } from "@/core/plugins/placeholders";
import { LINK_PLUGINS } from "@/core/plugins/registry";
import { linkUrlPrefix } from "@/core/plugins/linkManifest";
import {
  compressToEncodedURIComponent,
  decompressFromEncodedURIComponent,
} from "lz-string";
import { TEMPLATES } from "@/data/presets";
import { FIXTURES } from "@/test/fixtures";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "server", "src", "mcp");
const VALIDATION_SOURCE = join(ROOT, "src", "core", "schema", "validation.ts");

/**
 * The canonical public origin the built-in templates' stock images live on.
 *
 * `DEFAULT_MEDIA` resolves its URLs against `VITE_WEB_APP_URL`, falling back to
 * the browser's own origin — which is right for the app and wrong for this
 * generator. What it writes is a **production artifact**: `catalog.json` is
 * compiled into the Rust MCP server and served to every client, so a run on a
 * machine with a dev `.env` would bake `http://localhost:5173/media/...` into
 * templates that people then post to Discord, where the images are simply
 * broken for everyone. The output has to be the same regardless of who runs it.
 */
const CANONICAL_MEDIA_ORIGIN = "https://dweeb.faizo.net";
const DEFAULT_MEDIA_PATH = "/media/defaults/";

/** Repoint a stock-image URL at the canonical origin, whatever this machine's
 *  environment resolved it to. Any other URL is left exactly as written. */
function canonicalizeMedia(value: unknown): unknown {
  if (typeof value === "string") {
    const at = value.indexOf(DEFAULT_MEDIA_PATH);
    return at === -1 ? value : `${CANONICAL_MEDIA_ORIGIN}${value.slice(at)}`;
  }
  if (Array.isArray(value)) return value.map(canonicalizeMedia);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, canonicalizeMedia(v)]),
    );
  }
  return value;
}

/**
 * Wire form: no editor ids, `flags` computed — what the Rust side receives.
 *
 * Every message reaching the generated files goes through here (the catalog's
 * templates, the corpus's template cases, the LZ vector), so this is the one
 * place the media origin has to be pinned.
 */
function wire(message: WebhookMessage): unknown {
  return canonicalizeMedia(stripEditorFields(message));
}

/** Round-trip an untyped payload through the import boundary so the validator
 *  sees exactly the shape a caller's JSON would produce. */
function fromPayload(payload: unknown): WebhookMessage {
  return attachEditorFields(payload);
}

/* ─── Catalog ────────────────────────────────────────────────────────── */

interface CatalogTemplate {
  id: string;
  name: string;
  description: string;
  emoji: string;
  category: string;
  tags: string[];
  interactive: boolean;
  pairs_with: string | null;
  message: unknown;
}

function buildCatalog() {
  const templates: CatalogTemplate[] = TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    emoji: t.emoji,
    category: t.category,
    tags: t.tags ?? [],
    interactive: t.requiresBot === true,
    pairs_with: t.pairsWith ?? null,
    message: wire(t.message),
  }));

  return {
    // Stamped so a stale catalog is obvious in a diff and in the server's logs.
    generatedFrom: "src/data/presets.ts + src/core/schema/limits.ts",
    // Share-token format version. The Rust side mints links in the same format
    // the browser reads, so a bump here has to reach it — generating the number
    // is what makes that automatic rather than remembered.
    shareTokenVersion: CURRENT_VERSION,
    limits: { ...LIMITS },
    // Reserved tokens whose raw `{form}` shape must not be flagged as a broken
    // URL: they resolve at send from the destination.
    corePlaceholderTokens: CORE_PLACEHOLDERS.map((p) => p.token),
    // A link button pointing into one of these still carrying a non-core
    // `{token}` is an unfinished URL, which blocks send.
    linkPlugins: LINK_PLUGINS.map((p) => ({
      id: p.id,
      name: p.name,
      prefix: linkUrlPrefix(p.url),
    })),
    templates,
  };
}

/* ─── Corpus ─────────────────────────────────────────────────────────── */

/** One recorded issue: the rule that fired and the component it points at.
 *  `path` is null for a message-level rule, which names no component. */
interface CorpusIssue {
  code: string;
  path: string | null;
}

interface CorpusCase {
  name: string;
  message: unknown;
  errors: CorpusIssue[];
  warnings: CorpusIssue[];
}

/**
 * The issues of one severity, as `(code, path)` pairs — sorted and deduped so
 * the record is order-independent: the two implementations may legitimately
 * visit nodes in a different order, but they must agree on *which rules fired*
 * and *which components they blame*.
 *
 * The path matters as much as the code. An issue that names the wrong component
 * sends a model to edit a part of a message it cannot see, which is worse than
 * a vague error — so the corpus pins both.
 */
function issuesOf(
  issues: ValidationIssue[],
  severity: ValidationIssue["severity"],
  paths: Map<string, string>,
): CorpusIssue[] {
  const seen = new Map<string, CorpusIssue>();
  for (const issue of issues) {
    if (issue.severity !== severity) continue;
    const path = (issue.nodeId ? paths.get(issue.nodeId) : undefined) ?? null;
    const key = `${issue.code}@${path ?? ""}`;
    if (!seen.has(key)) seen.set(key, { code: issue.code, path });
  }
  // Code-point order, NOT `localeCompare`: collation is locale- and
  // ICU-version-dependent, so a corpus sorted that way records an order the
  // Rust side (which compares byte-wise) cannot reproduce, and which could even
  // differ between two machines running this generator.
  return [...seen.values()].sort((a, b) => {
    // Compare field by field, in code-point order. NOT `localeCompare`:
    // collation is locale- and ICU-version-dependent, so a corpus sorted that
    // way records an order the Rust side (which compares byte-wise) cannot
    // reproduce, and which could differ between two machines running this.
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    const left = a.path ?? "";
    const right = b.path ?? "";
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function record(name: string, payload: unknown): CorpusCase {
  return recordTree(name, fromPayload(payload));
}

/**
 * Record a case from an already-editor-shaped tree.
 *
 * Separate from {@link record} for one case the import boundary refuses
 * outright: `attachEditorFields` throws on a Section with no accessory rather
 * than inventing one, so a payload that omits it can never reach the validator
 * through that door — yet the validator does have a rule for it
 * (`SECTION_ACCESSORY_MISSING`), because such a tree can arrive by another
 * route (a peer's collab op). The Rust side has no editor and no such door, so
 * it must **report** that message rather than refuse it: a model handed
 * "Section needs an accessory" can fix its payload, where "that isn't a
 * Components V2 message" tells it nothing. This is the one deliberate
 * divergence between the two boundaries, and recording it here is what pins
 * the Rust behaviour.
 */
function recordTree(name: string, message: WebhookMessage): CorpusCase {
  const { issues } = validateMessage(message);
  const paths = buildPathIndex(message);
  return {
    name,
    message: wire(message),
    errors: issuesOf(issues, "error", paths),
    warnings: issuesOf(issues, "warning", paths),
  };
}

/** Stamp editor ids onto a raw payload without the repairs or the refusals
 *  `attachEditorFields` applies — the corpus needs the tree exactly as written. */
function stampIds(value: unknown, counter = { n: 0 }): unknown {
  if (Array.isArray(value)) return value.map((v) => stampIds(v, counter));
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(object)) out[key] = stampIds(child, counter);
  if (typeof object.type === "number" || "media" in object) {
    out._id = `n${counter.n++}`;
  }
  return out;
}

const SNOWFLAKE = "123456789012345678";
const text = (content: string) => ({ type: ComponentType.TextDisplay, content });
const row = (components: unknown[]) => ({ type: ComponentType.ActionRow, components });
const linkButton = (extra: Record<string, unknown> = {}) => ({
  type: ComponentType.Button,
  style: ButtonStyle.Link,
  label: "Open",
  url: "https://example.test/",
  ...extra,
});
const actionButton = (extra: Record<string, unknown> = {}) => ({
  type: ComponentType.Button,
  style: ButtonStyle.Primary,
  label: "Go",
  custom_id: "go",
  ...extra,
});
const stringSelect = (extra: Record<string, unknown> = {}) => ({
  type: ComponentType.StringSelect,
  custom_id: "pick",
  options: [{ label: "One", value: "1" }],
  ...extra,
});
const thumbnail = (extra: Record<string, unknown> = {}) => ({
  type: ComponentType.Thumbnail,
  media: { url: "https://example.test/i.png" },
  ...extra,
});

/**
 * Cases chosen to trigger every rule at least once, plus the whole template
 * catalogue and the shared fixtures as the "this must stay clean" half. A case
 * is named for what it is *for*, so a Rust failure names the rule directly.
 */
function buildCorpus(): CorpusCase[] {
  const cases: CorpusCase[] = [];

  // The clean half: everything the app ships must validate identically on both
  // sides. These catch a Rust rule that is too *strict*, which a hand-written
  // adversarial case never would.
  for (const [name, build] of Object.entries(FIXTURES)) {
    cases.push(record(`fixture:${name}`, wire(build())));
  }
  for (const template of TEMPLATES) {
    cases.push(record(`template:${template.id}`, wire(template.message)));
  }

  // Message level.
  cases.push(record("empty-message", { components: [] }));
  cases.push(
    record("too-many-top-level", {
      components: Array.from({ length: LIMITS.TOP_LEVEL_COMPONENTS + 1 }, (_, i) =>
        text(`block ${i}`),
      ),
    }),
  );
  cases.push(
    record("too-many-components", {
      components: [
        {
          type: ComponentType.Container,
          components: Array.from({ length: LIMITS.TOTAL_COMPONENTS }, (_, i) => text(`c${i}`)),
        },
      ],
    }),
  );
  cases.push(
    record("too-many-characters", {
      components: [text("x".repeat(LIMITS.TOTAL_CHARACTERS + 1))],
    }),
  );
  // Character counting is UTF-16 code units, because that is what
  // `String.prototype.length` counts and what the limits were measured against.
  // This message is 2001 code points but 4002 code units, so it is over the cap
  // only under the right counting — which is exactly the mistake a Rust port
  // makes by reaching for `chars().count()`.
  cases.push(
    record("astral-characters-count-as-two", {
      components: [text("😀".repeat(2001))],
    }),
  );
  // …and its twin just under the cap, so a port that over-counts (`len()` on
  // UTF-8 bytes, four per emoji) fails too rather than passing by luck.
  cases.push(
    record("astral-characters-under-the-cap", {
      components: [text("😀".repeat(1999))],
    }),
  );
  cases.push(
    record("username-too-long", {
      username: "u".repeat(LIMITS.WEBHOOK_USERNAME + 1),
      components: [text("hi")],
    }),
  );
  cases.push(record("username-reserved", { username: "Discord Alerts", components: [text("hi")] }));
  cases.push(
    record("avatar-url-bad", { avatar_url: "not a url", components: [text("hi")] }),
  );
  cases.push(
    record("avatar-url-long", {
      avatar_url: `https://example.test/${"a".repeat(LIMITS.WEBHOOK_AVATAR_URL)}`,
      components: [text("hi")],
    }),
  );
  cases.push(
    record("avatar-url-placeholder-is-fine", {
      avatar_url: "{server_icon}",
      components: [text("hi")],
    }),
  );
  cases.push(
    record("allowed-mentions-conflicts", {
      allowed_mentions: {
        parse: ["roles", "users"],
        roles: [SNOWFLAKE],
        users: [SNOWFLAKE],
      },
      components: [text("hi")],
    }),
  );
  cases.push(
    record("allowed-mentions-bad-ids", {
      allowed_mentions: { roles: ["nope"], users: ["also-nope"] },
      components: [text("hi")],
    }),
  );
  cases.push(
    record("thread-name-long", {
      thread_name: "t".repeat(LIMITS.THREAD_NAME + 1),
      components: [text("hi")],
    }),
  );
  cases.push(
    record("applied-tags-problems", {
      applied_tags: Array.from({ length: LIMITS.APPLIED_TAGS + 1 }, () => "bad"),
      components: [text("hi")],
    }),
  );
  cases.push(
    record("applied-tags-without-thread-name", {
      applied_tags: [SNOWFLAKE],
      components: [text("hi")],
    }),
  );

  // Text displays.
  cases.push(record("text-empty", { components: [text("   ")] }));
  cases.push(record("text-missing-content", { components: [{ type: ComponentType.TextDisplay }] }));
  cases.push(
    record("text-too-long", {
      components: [text("x".repeat(LIMITS.TEXT_DISPLAY_CONTENT + 1))],
    }),
  );

  // Containers and sections.
  cases.push(record("container-empty", { components: [{ type: ComponentType.Container, components: [] }] }));
  cases.push(
    record("container-too-many-children", {
      components: [
        {
          type: ComponentType.Container,
          components: Array.from({ length: LIMITS.CONTAINER_CHILDREN + 1 }, (_, i) => text(`c${i}`)),
        },
      ],
    }),
  );
  cases.push(
    record("container-accent-out-of-range", {
      components: [
        { type: ComponentType.Container, accent_color: 0x1000000, components: [text("hi")] },
      ],
    }),
  );
  cases.push(
    recordTree(
      "section-missing-accessory",
      stampIds({
        components: [{ type: ComponentType.Section, components: [text("hi")] }],
      }) as WebhookMessage,
    ),
  );
  cases.push(
    record("section-wrong-text-count", {
      components: [
        {
          type: ComponentType.Section,
          components: [text("a"), text("b"), text("c"), text("d")],
          accessory: thumbnail(),
        },
      ],
    }),
  );

  // Rows.
  cases.push(record("row-empty", { components: [row([])] }));
  cases.push(
    record("row-too-many-buttons", {
      components: [
        row(
          Array.from({ length: LIMITS.ACTION_ROW_BUTTONS + 1 }, (_, i) =>
            actionButton({ custom_id: `b${i}` }),
          ),
        ),
      ],
    }),
  );
  cases.push(
    record("row-mixes-select-and-button", {
      components: [row([stringSelect(), actionButton()])],
    }),
  );

  // Buttons.
  cases.push(record("button-url-invalid", { components: [row([linkButton({ url: "nope" })])] }));
  cases.push(
    record("button-url-long", {
      components: [row([linkButton({ url: `https://e.test/${"a".repeat(LIMITS.BUTTON_URL)}` })])],
    }),
  );
  cases.push(
    record("button-url-placeholder-is-fine", {
      components: [row([linkButton({ url: "{server_icon}" })])],
    }),
  );
  cases.push(
    record("button-custom-id-missing", {
      components: [row([actionButton({ custom_id: "" })])],
    }),
  );
  cases.push(
    record("button-custom-id-long", {
      components: [row([actionButton({ custom_id: "c".repeat(LIMITS.BUTTON_CUSTOM_ID + 1) })])],
    }),
  );
  cases.push(
    record("button-label-long", {
      components: [row([actionButton({ label: "l".repeat(LIMITS.BUTTON_LABEL + 1) })])],
    }),
  );
  cases.push(
    record("button-no-label-or-emoji", {
      components: [row([{ type: ComponentType.Button, style: ButtonStyle.Primary, custom_id: "x" }])],
    }),
  );
  cases.push(
    record("button-emoji-id-without-name", {
      components: [row([actionButton({ emoji: { id: SNOWFLAKE } })])],
    }),
  );
  cases.push(
    record("button-premium-sku-missing", {
      components: [row([{ type: ComponentType.Button, style: ButtonStyle.Premium }])],
    }),
  );
  cases.push(
    record("button-premium-sku-invalid", {
      components: [row([{ type: ComponentType.Button, style: ButtonStyle.Premium, sku_id: "abc" }])],
    }),
  );
  cases.push(
    record("button-duplicate-custom-ids", {
      components: [row([actionButton({ custom_id: "same" }), actionButton({ custom_id: "same" })])],
    }),
  );
  cases.push(
    record("component-id-duplicate", {
      components: [{ ...text("a"), id: 5 }, { ...text("b"), id: 5 }],
    }),
  );
  cases.push(
    record("component-id-not-integer", { components: [{ ...text("a"), id: 1.5 }] }),
  );

  // An unfinished link-plugin URL: the template prefix is real, the token is
  // one only the server owner can fill in.
  const linkPlugin = LINK_PLUGINS.find((p) => linkUrlPrefix(p.url) !== p.url);
  if (linkPlugin) {
    cases.push(
      record("link-plugin-url-unfinished", {
        components: [row([linkButton({ url: linkPlugin.url })])],
      }),
    );
  }

  // Selects.
  cases.push(
    record("select-custom-id-missing", { components: [row([stringSelect({ custom_id: "" })])] }),
  );
  cases.push(
    record("select-custom-id-long", {
      components: [row([stringSelect({ custom_id: "c".repeat(LIMITS.SELECT_CUSTOM_ID + 1) })])],
    }),
  );
  cases.push(
    record("select-placeholder-long", {
      components: [row([stringSelect({ placeholder: "p".repeat(LIMITS.SELECT_PLACEHOLDER + 1) })])],
    }),
  );
  cases.push(
    record("select-min-out-of-range", {
      components: [row([stringSelect({ min_values: LIMITS.SELECT_MAX_VALUES + 1 })])],
    }),
  );
  cases.push(
    record("select-max-out-of-range", {
      components: [row([stringSelect({ max_values: 0 })])],
    }),
  );
  cases.push(
    record("select-min-greater-than-max", {
      components: [row([stringSelect({ min_values: 2, max_values: 1 })])],
    }),
  );
  cases.push(record("select-no-options", { components: [row([stringSelect({ options: [] })])] }));
  cases.push(
    record("select-too-many-options", {
      components: [
        row([
          stringSelect({
            options: Array.from({ length: LIMITS.SELECT_OPTIONS + 1 }, (_, i) => ({
              label: `o${i}`,
              value: `v${i}`,
            })),
          }),
        ]),
      ],
    }),
  );
  cases.push(
    record("select-option-problems", {
      components: [
        row([
          stringSelect({
            options: [
              { label: "", value: "" },
              { label: "l".repeat(LIMITS.SELECT_OPTION_LABEL + 1), value: "dup" },
              { label: "ok", value: "dup" },
              {
                label: "ok2",
                value: "v".repeat(LIMITS.SELECT_OPTION_VALUE + 1),
                description: "d".repeat(LIMITS.SELECT_OPTION_DESCRIPTION + 1),
              },
              { label: "ok3", value: "v3", emoji: { id: SNOWFLAKE } },
            ],
          }),
        ]),
      ],
    }),
  );
  cases.push(
    record("select-defaults-over-max", {
      components: [
        row([
          stringSelect({
            max_values: 1,
            options: [
              { label: "a", value: "a", default: true },
              { label: "b", value: "b", default: true },
            ],
          }),
        ]),
      ],
    }),
  );
  cases.push(
    record("select-max-over-option-count", {
      components: [
        row([
          stringSelect({
            max_values: 5,
            options: [
              { label: "a", value: "a" },
              { label: "b", value: "b" },
            ],
          }),
        ]),
      ],
    }),
  );
  cases.push(
    record("select-default-values-limit", {
      components: [
        row([
          {
            type: ComponentType.RoleSelect,
            custom_id: "roles",
            default_values: Array.from({ length: LIMITS.SELECT_DEFAULT_VALUES + 1 }, () => ({
              id: SNOWFLAKE,
              type: "role",
            })),
          },
        ]),
      ],
    }),
  );
  cases.push(
    record("select-default-values-bad-id", {
      components: [
        row([
          {
            type: ComponentType.UserSelect,
            custom_id: "users",
            max_values: 5,
            default_values: [{ id: "nope", type: "user" }],
          },
        ]),
      ],
    }),
  );
  cases.push(
    record("select-default-values-over-max", {
      components: [
        row([
          {
            type: ComponentType.ChannelSelect,
            custom_id: "channels",
            max_values: 1,
            default_values: [
              { id: SNOWFLAKE, type: "channel" },
              { id: SNOWFLAKE.replace(/8$/, "9"), type: "channel" },
            ],
          },
        ]),
      ],
    }),
  );

  // Media.
  cases.push(
    record("media-required", { components: [{ type: ComponentType.MediaGallery, items: [{}] }] }),
  );
  cases.push(
    record("media-url-invalid", {
      components: [{ type: ComponentType.MediaGallery, items: [{ media: { url: "nope" } }] }],
    }),
  );
  cases.push(
    record("media-attachment-id-bad", {
      components: [
        { type: ComponentType.MediaGallery, items: [{ media: { attachment_id: "abc" } }] },
      ],
    }),
  );
  cases.push(record("gallery-empty", { components: [{ type: ComponentType.MediaGallery, items: [] }] }));
  cases.push(
    record("gallery-too-many-items", {
      components: [
        {
          type: ComponentType.MediaGallery,
          items: Array.from({ length: LIMITS.GALLERY_ITEMS + 1 }, () => ({
            media: { url: "https://example.test/i.png" },
          })),
        },
      ],
    }),
  );
  cases.push(
    record("gallery-description-long", {
      components: [
        {
          type: ComponentType.MediaGallery,
          items: [
            {
              media: { url: "https://example.test/i.png" },
              description: "d".repeat(LIMITS.MEDIA_DESCRIPTION + 1),
            },
          ],
        },
      ],
    }),
  );
  cases.push(
    record("thumbnail-description-long", {
      components: [
        {
          type: ComponentType.Section,
          components: [text("hi")],
          accessory: thumbnail({ description: "d".repeat(LIMITS.MEDIA_DESCRIPTION + 1) }),
        },
      ],
    }),
  );
  cases.push(
    record("file-external-url", {
      components: [{ type: ComponentType.File, file: { url: "https://example.test/a.pdf" } }],
    }),
  );
  cases.push(
    record("file-attachment-reference-is-fine", {
      components: [{ type: ComponentType.File, file: { url: "attachment://report.pdf" } }],
    }),
  );
  cases.push(
    record("file-discord-cdn-is-fine", {
      components: [
        { type: ComponentType.File, file: { url: "https://cdn.discordapp.com/attachments/1/2/a.pdf" } },
      ],
    }),
  );
  // A `session://` upload reference can never resolve on a server — the bytes
  // only ever existed in one browser — so the remote side must report it.
  cases.push(
    record("session-upload-reference", {
      components: [
        {
          type: ComponentType.MediaGallery,
          items: [{ media: { url: "session://abc123/photo.png" } }],
        },
      ],
    }),
  );

  return cases;
}

/* ─── Coverage ───────────────────────────────────────────────────────── */

/** Every `code:` the validator can emit, read from its source. */
function declaredCodes(): string[] {
  const source = readFileSync(VALIDATION_SOURCE, "utf8");
  const found = new Set<string>();
  for (const m of source.matchAll(/code:\s*"([A-Z_]+)"/g)) found.add(m[1]!);
  return [...found].sort();
}

/**
 * Codes only reachable in the browser, so no corpus case can produce them.
 * Each needs a reason, and the list is checked: a code named here that the
 * validator no longer declares fails the build, so it cannot rot.
 */
const UNREACHABLE_ON_A_SERVER: Record<string, string> = {
  // Emitted by `validateDestination`, which takes the destination channel's
  // type rather than the message — a separate entry point, tested separately.
  THREAD_NAME_REQUIRED: "validateDestination only",
  THREAD_NAME_FORBIDDEN: "validateDestination only",
};

function assertCoverage(cases: CorpusCase[]): void {
  const produced = new Set<string>();
  for (const c of cases) {
    for (const issue of [...c.errors, ...c.warnings]) produced.add(issue.code);
  }
  const declared = declaredCodes();
  const missing = declared.filter(
    (code) => !produced.has(code) && !(code in UNREACHABLE_ON_A_SERVER),
  );
  if (missing.length > 0) {
    throw new Error(
      `The corpus does not exercise ${missing.length} validation code(s): ${missing.join(", ")}.\n` +
        "Add a case to buildCorpus() that triggers each, or record it in UNREACHABLE_ON_A_SERVER " +
        "with the reason. An unexercised rule is one the Rust port can get wrong silently.",
    );
  }
  const stale = Object.keys(UNREACHABLE_ON_A_SERVER).filter((code) => !declared.includes(code));
  if (stale.length > 0) {
    throw new Error(
      `UNREACHABLE_ON_A_SERVER names ${stale.join(", ")}, which the validator no longer emits — remove the entry.`,
    );
  }
}

/* ─── Write ──────────────────────────────────────────────────────────── */

/**
 * Hostnames that mean "this was generated on someone's laptop".
 *
 * The output is compiled into the deployed server and served to every client, so
 * one of these reaching it is a broken image in a real Discord message. Worse,
 * the only symptom would be CI failing the drift check on the *next* person's
 * machine, long after the cause — which is exactly what happened once
 * (2026-08-18) before {@link canonicalizeMedia} existed.
 */
const MACHINE_LOCAL_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"];

function writeJson(name: string, value: unknown): void {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  for (const host of MACHINE_LOCAL_HOSTS) {
    if (serialized.includes(`//${host}`)) {
      throw new Error(
        `${name} contains a ${host} URL, so it was generated against a local environment ` +
          "rather than the deployed one. These files are compiled into the server and served " +
          "to every client — they must not depend on whose machine ran the generator.",
      );
    }
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, name);
  writeFileSync(path, serialized, "utf8");
  const bytes = Buffer.byteLength(serialized);
  console.log(`[mcp] wrote server/src/mcp/${name} (${(bytes / 1024).toFixed(1)} KiB)`);
}

/* ─── LZ-String vectors ──────────────────────────────────────────────── */

/**
 * Test vectors pinning the Rust port of `compressToEncodedURIComponent`.
 *
 * A DWEEB share link's payload is LZ-String-compressed by the browser, and the
 * remote MCP server has to produce the *same* encoding — a link it mints is
 * opened by the web app's decoder, which knows exactly one format. Nothing can
 * generate that algorithm, so it is pinned the way the validator is: run the
 * real implementation here, record the answers, and make the Rust port
 * reproduce them byte for byte.
 *
 * The cases are chosen for where a port goes wrong: the empty string, a single
 * character, ASCII repetition (the dictionary path), characters above U+00FF
 * (the 16-bit branch), astral characters (surrogate pairs — where a port that
 * iterates Rust `char`s instead of UTF-16 units diverges), and a real message
 * payload at realistic length.
 */
function buildLzVectors(): Array<{ name: string; input: string; output: string }> {
  const showcase = TEMPLATES.find((t) => t.id === "showcase") ?? TEMPLATES[0]!;
  const cases: Array<[string, string]> = [
    ["empty", ""],
    ["one-char", "a"],
    ["ascii", "hello world"],
    ["repetition", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    ["json-empty-message", JSON.stringify({ components: [] })],
    ["latin1-boundary", "ÿĀ café"],
    ["wide", "日本語のメッセージ"],
    ["astral", "😀😀 emoji 🎉"],
    ["mixed", 'a😀b"c\\d\ne'],
    ["template", JSON.stringify(wire(showcase.message))],
  ];
  return cases.map(([name, input]) => {
    const output = compressToEncodedURIComponent(input);
    // A vector that does not round-trip would pin the port to a broken answer.
    if (decompressFromEncodedURIComponent(output) !== input) {
      throw new Error(`LZ vector "${name}" does not round-trip in lz-string itself.`);
    }
    return { name, input, output };
  });
}

const catalog = buildCatalog();
const corpus = buildCorpus();
assertCoverage(corpus);

writeJson("catalog.json", catalog);
writeJson("validation-corpus.json", { cases: corpus });
writeJson("lz-vectors.json", { vectors: buildLzVectors() });

console.log(
  `[mcp] ${catalog.templates.length} templates · ${catalog.linkPlugins.length} link plugins · ` +
    `${corpus.length} validator cases covering ${declaredCodes().length - Object.keys(UNREACHABLE_ON_A_SERVER).length} rules`,
);
