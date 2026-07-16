/**
 * Renders a Discord markdown AST to JSX with Discord's visual treatments.
 *
 * Each AST node has a single rendering function. The renderer is intentionally
 * dumb — it never re-parses input or mutates the tree. Memoized so that
 * unchanged text doesn't re-run the parser on every keystroke.
 */

import { memo, useState, type CSSProperties, type ReactNode } from "react";
import {
  parseMarkdown,
  type BlockNode,
  type GuildNavType,
  type InlineNode,
  type MentionKind,
} from "./parse";
import { formatTimestamp } from "./timestamp";
import { GUILD_NAV_BY_TYPE } from "@/ui/guildNav";
import { useChannelInfo, useRoleInfo } from "@/core/guild/guildStore";
import { HashIcon } from "@/ui/Icon";
import { cn } from "@/lib/cn";
import styles from "./Markdown.module.css";

interface MarkdownProps {
  source: string;
  /** Render headings smaller — useful when text lives inside a Section. */
  compact?: boolean;
}

export const Markdown = memo(function Markdown({ source, compact }: MarkdownProps) {
  const ast = parseMarkdown(source);
  return <div className={compact ? styles.compact : undefined}>{renderBlocks(ast.blocks)}</div>;
});

function renderBlocks(blocks: BlockNode[]): ReactNode {
  return blocks.map((block, i) => renderBlock(block, i));
}

function renderBlock(block: BlockNode, key: number): ReactNode {
  switch (block.kind) {
    case "paragraph":
      return (
        <p key={key} className={styles.paragraph}>
          {renderInline(block.children)}
        </p>
      );
    case "heading": {
      const cls = block.level === 1 ? styles.h1 : block.level === 2 ? styles.h2 : styles.h3;
      const inner = renderInline(block.children);
      if (block.level === 1)
        return (
          <h1 key={key} className={cls}>
            {inner}
          </h1>
        );
      if (block.level === 2)
        return (
          <h2 key={key} className={cls}>
            {inner}
          </h2>
        );
      return (
        <h3 key={key} className={cls}>
          {inner}
        </h3>
      );
    }
    case "subtext":
      return (
        <p key={key} className={styles.subtext}>
          {renderInline(block.children)}
        </p>
      );
    case "quote":
      return (
        <blockquote key={key} className={styles.quote}>
          {renderBlocks(block.children)}
        </blockquote>
      );
    case "list": {
      const items = block.items.map((item, j) => (
        <li key={j}>
          {renderInline(item.content)}
          {item.children.length > 0 ? renderBlocks(item.children) : null}
        </li>
      ));
      if (block.ordered) {
        // `start` mirrors Discord, which preserves the first item's number.
        return (
          <ol key={key} className={styles.list} start={block.start}>
            {items}
          </ol>
        );
      }
      return (
        <ul key={key} className={styles.list}>
          {items}
        </ul>
      );
    }
    case "codeblock":
      return (
        <pre key={key} className={styles.codeblock} data-lang={block.lang ?? ""}>
          <code>{block.value}</code>
        </pre>
      );
  }
}

function renderInline(nodes: InlineNode[]): ReactNode {
  return nodes.map((n, i) => renderInlineNode(n, i));
}

/** Inline text spoiler. Click/tap to reveal, click/tap again to re-hide — the
 * same on desktop and touch (no hover). Inline text isn't a selectable node, so
 * unlike the media spoilers its reveal is a local toggle. The inner wrapper is
 * what actually hides (opacity), so links/mentions/emoji inside can't leak
 * their own colors through the obscuring box — Discord hides everything. */
function TextSpoiler({ children }: { children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span
      className={cn(styles.spoiler, revealed && styles.spoilerRevealed)}
      onClick={() => setRevealed((r) => !r)}
    >
      <span className={styles.spoilerContent}>{children}</span>
    </span>
  );
}

/* Unicode emoji get Discord's 1.375em treatment (a 22px glyph on 16px text).
 * Match a pictograph with emoji presentation — plus its skin-tone/VS16
 * modifiers and any ZWJ continuation — or a two-letter flag. Symbols without
 * emoji presentation (©, ™) stay plain text, mirroring Discord. */
const EMOJI_UNIT =
  "(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F)(?:\\p{Emoji_Modifier}|\\uFE0F)*";
const EMOJI_SEQ = `\\p{Regional_Indicator}{2}|${EMOJI_UNIT}(?:\\u200D${EMOJI_UNIT})*`;
const EMOJI_SPLIT = new RegExp(`(${EMOJI_SEQ})`, "gu");
const EMOJI_ONLY = new RegExp(`^(?:${EMOJI_SEQ})$`, "u");

function renderTextWithEmoji(value: string, key: number): ReactNode {
  const parts = value.split(EMOJI_SPLIT);
  if (parts.length === 1) return <span key={key}>{value}</span>;
  return (
    <span key={key}>
      {parts.map((part, i) =>
        part && EMOJI_ONLY.test(part) ? (
          <span key={i} className={styles.unicodeEmoji}>
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </span>
  );
}

function renderInlineNode(node: InlineNode, key: number): ReactNode {
  switch (node.kind) {
    case "text":
      return renderTextWithEmoji(node.value, key);
    case "break":
      return <br key={key} />;
    case "bold":
      return <strong key={key}>{renderInline(node.children)}</strong>;
    case "italic":
      return <em key={key}>{renderInline(node.children)}</em>;
    case "underline":
      return <u key={key}>{renderInline(node.children)}</u>;
    case "strike":
      return <s key={key}>{renderInline(node.children)}</s>;
    case "spoiler":
      return <TextSpoiler key={key}>{renderInline(node.children)}</TextSpoiler>;
    case "code":
      return (
        <code key={key} className={styles.codeInline}>
          {node.value}
        </code>
      );
    case "link":
      // Rendered as a non-navigable span: the preview should look like Discord
      // (blue, underline-on-hover) but never open URLs on click.
      return (
        <span key={key} className={styles.link}>
          {renderInline(node.children)}
        </span>
      );
    case "mention":
      return <Mention key={key} kind={node.mention} id={node.id} />;
    case "guildNav":
      return <GuildNav key={key} nav={node.nav} />;
    case "emoji":
      return (
        <img
          key={key}
          className={styles.emoji}
          src={`https://cdn.discordapp.com/emojis/${node.id}.${node.animated ? "gif" : "webp"}?size=24&quality=lossless`}
          alt={`:${node.name}:`}
          loading="lazy"
          decoding="async"
        />
      );
    case "timestamp":
      return (
        <time
          key={key}
          className={styles.timestamp}
          dateTime={new Date(node.unix * 1000).toISOString()}
        >
          {formatTimestamp(node.unix, node.style)}
        </time>
      );
  }
}

function Mention({ kind, id }: { kind: MentionKind; id: string }) {
  if (kind === "everyone" || kind === "here") {
    return <span className={styles.mention}>@{kind}</span>;
  }
  // The proxy intentionally never reads guild members (that needs a privileged
  // intent), so user mentions can't resolve to a name — keep the stable
  // placeholder. Roles and channels resolve against the connected server.
  if (kind === "user") return <span className={styles.mention}>@user-{id.slice(-4)}</span>;
  if (kind === "role") return <RoleMention id={id} />;
  return <ChannelMention id={id} />;
}

/**
 * Role mention. Resolves to the real role name and tints with the role's color
 * (like Discord) once the server's data is loaded; otherwise falls back to a
 * neutral `@role-1234` placeholder so the preview still reads correctly offline.
 */
function RoleMention({ id }: { id: string }) {
  const role = useRoleInfo(id);
  const name = role ? role.name : `role-${id.slice(-4)}`;
  const rgb = role && role.color ? packedColorToRgb(role.color) : null;
  return (
    <span
      className={cn(styles.mention, rgb && styles.roleMention)}
      style={rgb ? ({ "--role-rgb": rgb } as CSSProperties) : undefined}
    >
      @{name}
    </span>
  );
}

/** Channel mention. Resolves `<#id>` to `# channel-name` when data is loaded. */
function ChannelMention({ id }: { id: string }) {
  const channel = useChannelInfo(id);
  const name = channel ? channel.name : `channel-${id.slice(-4)}`;
  return (
    <span className={styles.mention}>
      <HashIcon className={styles.navIcon} />
      {name}
    </span>
  );
}

/** Discord's packed RGB integer → a `"r, g, b"` string for a CSS custom prop. */
function packedColorToRgb(color: number): string {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  return `${r}, ${g}, ${b}`;
}

/** Built-in server navigation mention (Browse Channels, Server Guide, …). */
function GuildNav({ nav }: { nav: GuildNavType }) {
  const { Icon, label } = GUILD_NAV_BY_TYPE[nav];
  return (
    <span className={styles.mention}>
      <Icon className={styles.navIcon} />
      {label}
    </span>
  );
}
