/**
 * Renders a Discord markdown AST to JSX with Discord's visual treatments.
 *
 * Each AST node has a single rendering function. The renderer is intentionally
 * dumb — it never re-parses input or mutates the tree. Memoized so that
 * unchanged text doesn't re-run the parser on every keystroke.
 */

import { memo, useState, type ReactNode } from "react";
import { parseMarkdown, type BlockNode, type InlineNode, type MentionKind } from "./parse";
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
    case "list":
      if (block.ordered) {
        return (
          <ol key={key} className={styles.list}>
            {block.items.map((item, j) => (
              <li key={j}>{renderInline(item)}</li>
            ))}
          </ol>
        );
      }
      return (
        <ul key={key} className={styles.list}>
          {block.items.map((item, j) => (
            <li key={j}>{renderInline(item)}</li>
          ))}
        </ul>
      );
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
 * unlike the media spoilers its reveal is a local toggle. */
function TextSpoiler({ children }: { children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span
      className={cn(styles.spoiler, revealed && styles.spoilerRevealed)}
      onClick={() => setRevealed((r) => !r)}
    >
      {children}
    </span>
  );
}

function renderInlineNode(node: InlineNode, key: number): ReactNode {
  switch (node.kind) {
    case "text":
      return <span key={key}>{node.value}</span>;
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
      return (
        <a
          key={key}
          href={node.href}
          className={styles.link}
          target="_blank"
          rel="noreferrer noopener"
        >
          {renderInline(node.children)}
        </a>
      );
    case "mention":
      return <Mention key={key} kind={node.mention} id={node.id} />;
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
  if (kind === "user") return <span className={styles.mention}>@user-{id.slice(-4)}</span>;
  if (kind === "role") return <span className={styles.mention}>@role-{id.slice(-4)}</span>;
  return <span className={styles.mention}>#channel-{id.slice(-4)}</span>;
}

function formatTimestamp(unix: number, style: string): string {
  const d = new Date(unix * 1000);
  switch (style) {
    case "t":
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    case "T":
      return d.toLocaleTimeString();
    case "d":
      return d.toLocaleDateString();
    case "D":
      return d.toLocaleDateString([], { dateStyle: "long" });
    case "F":
      return d.toLocaleString([], { dateStyle: "full", timeStyle: "short" });
    case "R": {
      const diff = (Date.now() - d.getTime()) / 1000;
      const abs = Math.abs(diff);
      const fmt = (n: number, unit: string) =>
        diff >= 0 ? `${Math.floor(n)} ${unit} ago` : `in ${Math.floor(n)} ${unit}`;
      if (abs < 60) return fmt(abs, "seconds");
      if (abs < 3600) return fmt(abs / 60, "minutes");
      if (abs < 86400) return fmt(abs / 3600, "hours");
      return fmt(abs / 86400, "days");
    }
    default:
      return d.toLocaleString();
  }
}
