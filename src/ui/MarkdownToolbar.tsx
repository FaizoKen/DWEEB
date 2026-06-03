import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Menu, MenuDivider, MenuItem } from "@/ui/Menu";
import {
  BoldIcon,
  ChevronDownIcon,
  ClockIcon,
  CodeBlockIcon,
  CodeIcon,
  EmojiIcon,
  HashIcon,
  HeadingIcon,
  ItalicIcon,
  LinkIcon,
  ListBulletIcon,
  ListOrderedIcon,
  MentionIcon,
  QuoteIcon,
  SpoilerIcon,
  StrikethroughIcon,
  UnderlineIcon,
} from "@/ui/Icon";
import {
  insertLink,
  insertSnippet,
  isBulletActive,
  isHeadingActive,
  isInlineActive,
  isOrderedActive,
  isQuoteActive,
  setHeading,
  toggleBulletList,
  toggleOrderedList,
  toggleQuote,
  wrapCodeBlock,
  wrapInline,
  type EditResult,
  type EditState,
} from "@/ui/markdownActions";
import { TimestampPanel } from "@/ui/TimestampPicker";
import {
  GuildChannelPanel,
  GuildEmojiPanel,
  GuildMentionPanel,
} from "@/features/guild/MentionPicker";
import styles from "./MarkdownToolbar.module.css";

type Transform = (state: EditState) => EditResult;

interface MarkdownToolbarProps {
  /** Live editor value + selection, used for active-state highlighting. */
  state: EditState;
  /** Runs a transform against the current selection and commits the result. */
  onAction: (transform: Transform) => void;
  disabled?: boolean;
}

interface ToolButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  children: ReactNode;
}

/**
 * A single toolbar control. `mousedown` is suppressed so clicking never steals
 * focus from the textarea — the caret/selection stays put and visible while the
 * edit is applied.
 */
const ToolButton = forwardRef<HTMLButtonElement, ToolButtonProps>(function ToolButton(
  { label, active, children, className, onMouseDown, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(styles.btn, active && styles.btnActive, className)}
      onMouseDown={(e) => {
        e.preventDefault();
        onMouseDown?.(e);
      }}
      {...rest}
    >
      {children}
    </button>
  );
});

/**
 * Formatting toolbar for a Discord-markdown textarea. Every button maps to a
 * pure transform in `markdownActions`; the component itself holds no state and
 * just reflects the selection it's handed.
 */
export function MarkdownToolbar({ state, onAction, disabled }: MarkdownToolbarProps) {
  const inline = (marker: string, placeholder: string) => () =>
    onAction((s) => wrapInline(s, marker, placeholder));
  const active = (marker: string) => isInlineActive(state, marker);

  return (
    <div
      className={styles.toolbar}
      role="toolbar"
      aria-label="Text formatting"
      aria-disabled={disabled}
    >
      <div className={styles.group}>
        <ToolButton label="Bold (Ctrl+B)" active={active("**")} onClick={inline("**", "bold text")}>
          <BoldIcon />
        </ToolButton>
        <ToolButton
          label="Italic (Ctrl+I)"
          active={active("*")}
          onClick={inline("*", "italic text")}
        >
          <ItalicIcon />
        </ToolButton>
        <ToolButton
          label="Underline (Ctrl+U)"
          active={active("__")}
          onClick={inline("__", "underlined text")}
        >
          <UnderlineIcon />
        </ToolButton>
        <ToolButton
          label="Strikethrough"
          active={active("~~")}
          onClick={inline("~~", "struck text")}
        >
          <StrikethroughIcon />
        </ToolButton>
        <ToolButton label="Spoiler" active={active("||")} onClick={inline("||", "spoiler")}>
          <SpoilerIcon />
        </ToolButton>
        <ToolButton label="Inline code" active={active("`")} onClick={inline("`", "code")}>
          <CodeIcon />
        </ToolButton>
      </div>

      <span className={styles.divider} role="separator" />

      <div className={styles.group}>
        <Menu
          align="start"
          trigger={
            <ToolButton
              label="Heading"
              active={
                isHeadingActive(state, "# ") ||
                isHeadingActive(state, "## ") ||
                isHeadingActive(state, "### ") ||
                isHeadingActive(state, "-# ")
              }
              className={styles.btnMenu}
            >
              <HeadingIcon />
              <ChevronDownIcon size={12} className={styles.caret} />
            </ToolButton>
          }
        >
          {(close) => (
            <>
              <MenuItem
                onSelect={() => {
                  onAction((s) => setHeading(s, "# "));
                  close();
                }}
              >
                Heading 1
              </MenuItem>
              <MenuItem
                onSelect={() => {
                  onAction((s) => setHeading(s, "## "));
                  close();
                }}
              >
                Heading 2
              </MenuItem>
              <MenuItem
                onSelect={() => {
                  onAction((s) => setHeading(s, "### "));
                  close();
                }}
              >
                Heading 3
              </MenuItem>
              <MenuDivider />
              <MenuItem
                onSelect={() => {
                  onAction((s) => setHeading(s, "-# "));
                  close();
                }}
              >
                Subtext (small)
              </MenuItem>
            </>
          )}
        </Menu>
        <ToolButton
          label="Quote"
          active={isQuoteActive(state)}
          onClick={() => onAction(toggleQuote)}
        >
          <QuoteIcon />
        </ToolButton>
        <ToolButton
          label="Bulleted list"
          active={isBulletActive(state)}
          onClick={() => onAction(toggleBulletList)}
        >
          <ListBulletIcon />
        </ToolButton>
        <ToolButton
          label="Numbered list"
          active={isOrderedActive(state)}
          onClick={() => onAction(toggleOrderedList)}
        >
          <ListOrderedIcon />
        </ToolButton>
        <ToolButton label="Code block" onClick={() => onAction((s) => wrapCodeBlock(s))}>
          <CodeBlockIcon />
        </ToolButton>
      </div>

      <span className={styles.divider} role="separator" />

      <div className={styles.group}>
        <ToolButton label="Link" onClick={() => onAction(insertLink)}>
          <LinkIcon />
        </ToolButton>
        <Menu
          align="start"
          trigger={
            <ToolButton label="Mention" className={styles.btnMenu}>
              <MentionIcon />
              <ChevronDownIcon size={12} className={styles.caret} />
            </ToolButton>
          }
        >
          {(close) => (
            <GuildMentionPanel
              onPick={(snippet, selectToken) => {
                onAction((s) => insertSnippet(s, snippet, selectToken));
                close();
              }}
            />
          )}
        </Menu>
        <Menu
          align="start"
          trigger={
            <ToolButton label="Channel" className={styles.btnMenu}>
              <HashIcon />
              <ChevronDownIcon size={12} className={styles.caret} />
            </ToolButton>
          }
        >
          {(close) => (
            <GuildChannelPanel
              onPick={(snippet, selectToken) => {
                onAction((s) => insertSnippet(s, snippet, selectToken));
                close();
              }}
            />
          )}
        </Menu>
        <Menu
          align="start"
          trigger={
            <ToolButton label="Emoji" className={styles.btnMenu}>
              <EmojiIcon />
              <ChevronDownIcon size={12} className={styles.caret} />
            </ToolButton>
          }
        >
          {(close) => (
            <GuildEmojiPanel
              onPick={(snippet, selectToken) => {
                onAction((s) => insertSnippet(s, snippet, selectToken));
                close();
              }}
            />
          )}
        </Menu>
        <Menu
          align="end"
          trigger={
            <ToolButton label="Timestamp" className={styles.btnMenu}>
              <ClockIcon />
              <ChevronDownIcon size={12} className={styles.caret} />
            </ToolButton>
          }
        >
          {(close) => (
            <TimestampPanel
              onInsert={(snippet) => {
                onAction((s) => insertSnippet(s, snippet));
                close();
              }}
            />
          )}
        </Menu>
      </div>
    </div>
  );
}
