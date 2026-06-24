/**
 * Build-time renderer: a Discord Components V2 message → clean, self-contained
 * semantic HTML for the static template pages (see `gen-template-pages.ts`).
 *
 * Deliberately NOT the app's `<Preview>` component. Preview pulls in CSS-module
 * imports and browser-only code that don't run under Bun outside Vite, and its
 * markup is tuned for the live editor, not for crawlers. This is a small,
 * dependency-free walker tuned for SEO: every piece of message text — headings,
 * body copy, list items, button labels, select options, media captions — lands
 * as real, semantic HTML so search engines (and AI answer engines) index what
 * the template actually says, while a compact Discord-flavoured skin keeps it
 * recognisable to a human who arrives from a search result.
 *
 * Images are rendered as captioned placeholders rather than fetched: the
 * template media are random stand-ins (picsum seeds), so the caption is the only
 * thing worth indexing, and skipping the fetch keeps the page fast and
 * self-contained.
 */

import {
  ButtonStyle,
  ComponentType,
  SeparatorSpacing,
  type ActionRowComponent,
  type ButtonComponent,
  type ContainerChild,
  type ContainerComponent,
  type MediaGalleryComponent,
  type SectionComponent,
  type SelectComponent,
  type SeparatorComponent,
  type TextDisplayComponent,
  type ThumbnailComponent,
  type TopLevelComponent,
  type WebhookMessage,
} from "@/core/schema/types";

const SELECT_TYPES: ReadonlySet<number> = new Set([
  ComponentType.StringSelect,
  ComponentType.UserSelect,
  ComponentType.RoleSelect,
  ComponentType.MentionableSelect,
  ComponentType.ChannelSelect,
]);

/** Escape the five characters that are unsafe in HTML text/attribute context. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ────────────────────────────────────────────────────────────────────────────
// Markdown (Discord's subset)
// ────────────────────────────────────────────────────────────────────────────

/** Inline bold/underline/italic/strike/spoiler on an already-escaped string. */
function fmtBasic(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<u>$1</u>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    .replace(/\|\|([^|]+)\|\|/g, '<span class="dwx-spoiler">$1</span>');
}

/**
 * Render one line of Discord markdown to safe inline HTML. Order matters: text
 * is HTML-escaped first, then code spans and masked links are lifted into
 * sentinel tokens so the bold/italic passes can't reach inside their contents
 * (or an underscore in a URL), and the tokens are restored last.
 */
export function renderInline(raw: string): string {
  // A NUL byte is a safe sentinel — it never appears in template copy — so the
  // bold/italic passes (and any literal digits in the text) can't reach inside
  // finished code/link HTML, which is lifted out here and restored at the end.
  const NUL = String.fromCharCode(0);
  const tokens: string[] = [];
  const stash = (html: string): string => {
    tokens.push(html);
    return `${NUL}${tokens.length - 1}${NUL}`;
  };

  let s = escapeHtml(raw);

  // `inline code` — contents are taken verbatim (already escaped), no further formatting.
  s = s.replace(/`([^`]+)`/g, (_m, code: string) => stash(`<code>${code}</code>`));

  // [masked links](url) — only http(s) targets become real links; everything
  // else degrades to its label. External, so nofollow + new tab.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
    if (!/^https?:\/\//i.test(url)) return fmtBasic(text);
    return stash(
      `<a href="${url}" rel="nofollow ugc noopener" target="_blank">${fmtBasic(text)}</a>`,
    );
  });

  s = fmtBasic(s);
  s = s.replace(new RegExp(`${NUL}(\\d+)${NUL}`, "g"), (_m, i: string) => tokens[Number(i)] ?? "");
  return s;
}

/**
 * Render a TextDisplay's full markdown to block HTML. Supports headings
 * (`#`/`##`/`###` → `<h2>`/`<h3>`/`<h4>` so they nest under the page `<h1>`),
 * subtext (`-#`), blockquotes, bullet lists, and paragraphs (a single newline is
 * a soft break, matching Discord).
 */
export function renderMarkdown(content: string): string {
  const out: string[] = [];
  let list: string[] | null = null;
  let quote: string[] | null = null;
  let para: string[] | null = null;

  const flushList = () => {
    if (list) out.push(`<ul class="dwx-ul">${list.join("")}</ul>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote) out.push(`<blockquote class="dwx-quote">${quote.join("<br>")}</blockquote>`);
    quote = null;
  };
  const flushPara = () => {
    if (para) out.push(`<p class="dwx-p">${para.join("<br>")}</p>`);
    para = null;
  };

  for (const line of content.split("\n")) {
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) {
      flushQuote();
      flushPara();
      (list ??= []).push(`<li>${renderInline(li[1]!)}</li>`);
      continue;
    }
    flushList();

    const bq = /^>\s?(.*)$/.exec(line);
    if (bq) {
      flushPara();
      (quote ??= []).push(renderInline(bq[1]!));
      continue;
    }
    flushQuote();

    const sub = /^-#\s+(.*)$/.exec(line);
    if (sub) {
      flushPara();
      out.push(`<p class="dwx-sub">${renderInline(sub[1]!)}</p>`);
      continue;
    }

    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      const lvl = h[1]!.length;
      out.push(`<h${lvl + 1} class="dwx-h dwx-h${lvl}">${renderInline(h[2]!)}</h${lvl + 1}>`);
      continue;
    }

    if (line.trim() === "") {
      flushPara();
      continue;
    }
    (para ??= []).push(renderInline(line));
  }

  flushList();
  flushQuote();
  flushPara();
  return out.join("");
}

// ────────────────────────────────────────────────────────────────────────────
// Components
// ────────────────────────────────────────────────────────────────────────────

function accentHex(c?: number | null): string | null {
  if (c === undefined || c === null) return null;
  return `#${(c & 0xffffff).toString(16).padStart(6, "0")}`;
}

function buttonClass(style: number): string {
  switch (style) {
    case ButtonStyle.Primary:
      return "dwx-btn dwx-btn-primary";
    case ButtonStyle.Success:
      return "dwx-btn dwx-btn-success";
    case ButtonStyle.Danger:
      return "dwx-btn dwx-btn-danger";
    case ButtonStyle.Secondary:
      return "dwx-btn dwx-btn-secondary";
    case ButtonStyle.Premium:
      return "dwx-btn dwx-btn-premium";
    default:
      return "dwx-btn dwx-btn-link";
  }
}

/** Buttons render as inert styled pills — on a showcase page they illustrate the
 *  layout, they're not live destinations, so we never emit junk outbound links. */
function renderButton(b: ButtonComponent): string {
  const emoji = "emoji" in b && b.emoji?.name ? `${b.emoji.name} ` : "";
  const label =
    "label" in b && b.label ? b.label : b.style === ButtonStyle.Premium ? "Premium" : "Button";
  const ext = b.style === ButtonStyle.Link ? ' <span class="dwx-btn-ext" aria-hidden="true">↗</span>' : "";
  return `<span class="${buttonClass(b.style)}">${escapeHtml(emoji)}${escapeHtml(label)}${ext}</span>`;
}

const SELECT_KIND_LABEL: Record<number, string> = {
  [ComponentType.UserSelect]: "Pick a member",
  [ComponentType.RoleSelect]: "Pick a role",
  [ComponentType.MentionableSelect]: "Pick a member or role",
  [ComponentType.ChannelSelect]: "Pick a channel",
};

function renderSelect(s: SelectComponent): string {
  const ph = escapeHtml(s.placeholder ?? "Make a selection");
  let options = "";
  if (s.type === ComponentType.StringSelect) {
    options =
      `<ul class="dwx-options">` +
      s.options
        .map((o) => {
          const em = o.emoji?.name ? `${o.emoji.name} ` : "";
          const desc = o.description
            ? `<span class="dwx-opt-desc">${renderInline(o.description)}</span>`
            : "";
          return `<li class="dwx-opt"><span class="dwx-opt-label">${escapeHtml(em)}${escapeHtml(o.label)}</span>${desc}</li>`;
        })
        .join("") +
      `</ul>`;
  } else {
    const kind = SELECT_KIND_LABEL[s.type] ?? "Options";
    options = `<p class="dwx-select-kind">${kind}</p>`;
  }
  return `<div class="dwx-select"><span class="dwx-select-box">${ph}<span class="dwx-caret" aria-hidden="true">▾</span></span>${options}</div>`;
}

function renderActionRow(row: ActionRowComponent): string {
  const comps = row.components;
  const first = comps[0];
  if (first && SELECT_TYPES.has(first.type)) {
    return renderSelect(first as SelectComponent);
  }
  return `<div class="dwx-row">${(comps as ButtonComponent[]).map(renderButton).join("")}</div>`;
}

function renderThumb(t: ThumbnailComponent): string {
  const cap = t.description ? escapeHtml(t.description) : "Image";
  return `<div class="dwx-thumb" role="img" aria-label="${cap}"><span class="dwx-media-glyph" aria-hidden="true">🖼️</span></div>`;
}

function renderGallery(g: MediaGalleryComponent): string {
  const items = g.items
    .map((it) => {
      const caption = it.description ? `<figcaption>${renderInline(it.description)}</figcaption>` : "";
      const spoiler = it.spoiler ? " dwx-media-spoiler" : "";
      const label = it.description ? ` aria-label="${escapeHtml(it.description)}"` : "";
      return `<figure class="dwx-media${spoiler}"${label}><span class="dwx-media-glyph" aria-hidden="true">🖼️</span>${caption}</figure>`;
    })
    .join("");
  return `<div class="dwx-gallery" data-count="${g.items.length}">${items}</div>`;
}

function renderSection(s: SectionComponent): string {
  const text = s.components.map((c) => renderMarkdown(c.content)).join("");
  const accessory =
    s.accessory.type === ComponentType.Thumbnail
      ? renderThumb(s.accessory)
      : `<div class="dwx-section-action">${renderButton(s.accessory)}</div>`;
  return `<div class="dwx-section"><div class="dwx-section-text">${text}</div><div class="dwx-section-accessory">${accessory}</div></div>`;
}

function renderSeparator(s: SeparatorComponent): string {
  const big = s.spacing === SeparatorSpacing.Large ? " dwx-sep-lg" : "";
  return s.divider === false
    ? `<div class="dwx-spacer${big}"></div>`
    : `<hr class="dwx-sep${big}">`;
}

function renderChild(c: TopLevelComponent | ContainerChild): string {
  switch (c.type) {
    case ComponentType.TextDisplay:
      return `<div class="dwx-text">${renderMarkdown((c as TextDisplayComponent).content)}</div>`;
    case ComponentType.Section:
      return renderSection(c as SectionComponent);
    case ComponentType.MediaGallery:
      return renderGallery(c as MediaGalleryComponent);
    case ComponentType.Separator:
      return renderSeparator(c as SeparatorComponent);
    case ComponentType.ActionRow:
      return renderActionRow(c as ActionRowComponent);
    case ComponentType.File:
      return `<div class="dwx-file"><span class="dwx-media-glyph" aria-hidden="true">📎</span><span>Attached file</span></div>`;
    case ComponentType.Container:
      return renderContainer(c as ContainerComponent);
    default:
      return "";
  }
}

function renderContainer(c: ContainerComponent): string {
  const accent = accentHex(c.accent_color);
  const style = accent ? ` style="--dwx-accent:${accent}"` : "";
  const cls = `dwx-container${accent ? " dwx-container-accent" : ""}`;
  return `<div class="${cls}"${style}>${c.components.map(renderChild).join("")}</div>`;
}

/** Render a whole message to a Discord-style card. */
export function renderMessageHtml(message: WebhookMessage): string {
  const author = message.username ? escapeHtml(message.username) : "DWEEB";
  const initial = author.replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase() || "D";
  const body = message.components.map(renderChild).join("");
  return `<article class="dwx-msg">
  <div class="dwx-avatar" aria-hidden="true">${initial}</div>
  <div class="dwx-msg-main">
    <div class="dwx-author">${author}<span class="dwx-tag">APP</span></div>
    <div class="dwx-content">${body}</div>
  </div>
</article>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Derived metadata (for "What's inside" + keyword enrichment)
// ────────────────────────────────────────────────────────────────────────────

/** Walk the tree and return a de-duplicated, human-readable list of the
 *  Components V2 building blocks the message uses — keyword-rich and genuinely
 *  useful for a visitor sizing up the template. */
export function collectComponentKinds(message: WebhookMessage): string[] {
  const found = new Set<string>();

  const visit = (c: TopLevelComponent | ContainerChild | SelectComponent | ButtonComponent): void => {
    switch (c.type) {
      case ComponentType.Container:
        found.add("Container with accent stripe");
        (c as ContainerComponent).components.forEach(visit);
        break;
      case ComponentType.Section:
        found.add("Section");
        if ((c as SectionComponent).accessory.type === ComponentType.Thumbnail) found.add("Thumbnail");
        else found.add("Button");
        break;
      case ComponentType.TextDisplay:
        found.add("Formatted text");
        break;
      case ComponentType.MediaGallery:
        found.add("Media gallery");
        break;
      case ComponentType.Separator:
        found.add("Separator");
        break;
      case ComponentType.File:
        found.add("File attachment");
        break;
      case ComponentType.ActionRow: {
        const inner = (c as ActionRowComponent).components;
        const first = inner[0];
        if (first && SELECT_TYPES.has(first.type)) inner.forEach((x) => visit(x as SelectComponent));
        else found.add("Buttons");
        break;
      }
      case ComponentType.StringSelect:
        found.add("Dropdown menu");
        break;
      case ComponentType.UserSelect:
      case ComponentType.RoleSelect:
      case ComponentType.MentionableSelect:
      case ComponentType.ChannelSelect:
        found.add("Auto-populated select menu");
        break;
      default:
        break;
    }
  };

  message.components.forEach(visit);
  return [...found];
}
