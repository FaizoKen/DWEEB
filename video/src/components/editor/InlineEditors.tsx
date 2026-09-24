import React from "react";
import { COLORS } from "../../theme";
import { INTER } from "../../fonts";
import { withAlpha } from "../../lib/color";
import { PIcon, type ProductIconName } from "./ProductIcon";
import { useUi } from "./scale";
import { InlineEditorFrame } from "./Tree";
import { InlineActionPanel } from "./Plugins";
import { FieldLabel, InputBox } from "./chrome";

/**
 * The inline editors that unfold under a selected tree row (the Inspector,
 * rendered inside ComponentTree's .editorPanel). Each exports its content
 * height at k = 1 so `treeLayout()` can reserve the slot and rows below move
 * exactly as far as the pixels do.
 */

/** TextDisplayInspector: "Content" + markdown toolbar + textarea + "Markdown supported. n/4000". */
export const TEXT_EDITOR_H = 214;
/** ButtonInspector with the PluginPanel on top (ACTION + Browse/attached) and the Style select. */
export const BUTTON_EDITOR_H = 262;
/** MediaGalleryInspector: "Media (3 / 10)" + "+ Add media" + the drop zone. */
export const GALLERY_EDITOR_H = 132;

const TOOLBAR: (ProductIconName | "|")[] = [
  "bold",
  "italic",
  "underline",
  "strike",
  "spoiler",
  "code",
  "|",
  "heading",
  "quote",
  "listBullet",
  "codeBlock",
  "link",
  "|",
  "emoji",
];

/**
 * The Text row's editor. The textarea shows the raw markdown; `selection`
 * paints a text selection (the build beat selects "📢 Announcement") and
 * `caret` draws the insertion point (pass caretOn=false on blink-off frames).
 */
export const TextInlineEditor: React.FC<{
  content: string;
  selection?: [number, number];
  caret?: number | null;
  caretOn?: boolean;
  focused?: boolean;
}> = ({ content, selection, caret = null, caretOn = true, focused = true }) => {
  const { u } = useUi();
  const caretEl = (
    <span
      style={{
        display: "inline-block",
        width: u(2),
        height: "1.15em",
        verticalAlign: "-0.2em",
        marginLeft: -u(1),
        marginRight: -u(1),
        background: caretOn ? COLORS.text : "transparent",
        borderRadius: 1,
      }}
    />
  );
  // Split the text into [before][selected][after] and drop the caret in.
  let body: React.ReactNode;
  if (selection && selection[1] > selection[0]) {
    body = (
      <>
        {content.slice(0, selection[0])}
        <span style={{ background: "rgba(88,101,242,0.55)", color: "#fff", borderRadius: u(2) }}>
          {content.slice(selection[0], selection[1])}
        </span>
        {content.slice(selection[1])}
      </>
    );
  } else if (caret !== null) {
    body = (
      <>
        {content.slice(0, caret)}
        {caretEl}
        {content.slice(caret)}
      </>
    );
  } else body = content;

  return (
    <InlineEditorFrame kind="text">
      <div style={{ display: "flex", flexDirection: "column", gap: u(6), height: "100%" }}>
        <FieldLabel label="Content" />
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: u(2),
              padding: `${u(4)}px ${u(6)}px`,
              background: COLORS.bgSubtle,
              border: `${u(1)}px solid ${COLORS.border}`,
              borderBottom: "none",
              borderRadius: `${u(6)}px ${u(6)}px 0 0`,
              color: COLORS.textMuted,
            }}
          >
            {TOOLBAR.map((t, i) =>
              t === "|" ? (
                <span key={i} style={{ width: 1, height: u(18), background: COLORS.border, margin: `0 ${u(4)}px` }} />
              ) : (
                <span key={i} style={{ width: u(30), height: u(30), display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <PIcon name={t} size={u(16)} />
                </span>
              ),
            )}
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              padding: `${u(10)}px ${u(12)}px`,
              background: COLORS.bgInput,
              border: `${u(1)}px solid ${focused ? COLORS.blurple : COLORS.border}`,
              boxShadow: focused ? `0 0 0 ${u(2)}px ${COLORS.blurple}` : undefined,
              borderRadius: `0 0 ${u(6)}px ${u(6)}px`,
              fontFamily: INTER,
              fontSize: u(14),
              lineHeight: 1.55,
              color: COLORS.text,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              overflow: "hidden",
            }}
          >
            {body}
          </div>
        </div>
        <span style={{ fontSize: u(12), color: COLORS.textSubtle }}>
          Markdown supported. {content.length}/4000
        </span>
      </div>
    </InlineEditorFrame>
  );
};

/**
 * The selected button's editor: the PluginPanel (ACTION + "Browse plugins · 25",
 * or the attached chip once a plugin is on) above the Style select.
 */
export const ButtonInlineEditor: React.FC<{
  style?: string;
  browseHover?: boolean;
  browsePressed?: boolean;
  attached?: React.ReactNode;
}> = ({ style = "Primary (blurple)", browseHover, browsePressed, attached }) => {
  const { u } = useUi();
  return (
    <InlineEditorFrame kind="button">
      <div style={{ display: "flex", flexDirection: "column", gap: u(12) }}>
        <div style={{ paddingBottom: u(16), borderBottom: `${u(1)}px solid ${COLORS.border}` }}>
          <InlineActionPanel hover={browseHover} pressed={browsePressed} attached={attached} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: u(6) }}>
          <FieldLabel label="Style" />
          <InputBox value={style} select />
        </div>
      </div>
    </InlineEditorFrame>
  );
};

/**
 * The gallery's editor (MediaGalleryInspector.tsx:63-113): "Media (3 / 10)",
 * "+ Add media", and the drop zone — the items themselves are tree rows, so
 * the inspector shows no thumbnails. `dropActive` is the zone's drag-over
 * state (a file being dropped in — the build beat's tile swap).
 */
export const GalleryInlineEditor: React.FC<{ count?: number; dropActive?: number }> = ({ count = 3, dropActive = 0 }) => {
  const { u } = useUi();
  const a = Math.max(0, Math.min(1, dropActive));
  return (
    <InlineEditorFrame kind="gallery">
      <div style={{ display: "flex", flexDirection: "column", gap: u(10) }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: u(13), fontWeight: 600 }}>Media ({count} / 10)</span>
          <span style={{ fontSize: u(12), fontWeight: 600, color: "#aeb6ff" }}>+ Add media</span>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: u(3),
            padding: `${u(14)}px ${u(12)}px`,
            borderRadius: u(10),
            border: `${u(1.5)}px dashed ${a > 0.01 ? withAlpha(COLORS.blurple, 0.5 + 0.5 * a) : COLORS.borderStrong}`,
            background: a > 0.01 ? withAlpha(COLORS.blurple, 0.14 * a) : "transparent",
            textAlign: "center",
          }}
        >
          <strong style={{ fontSize: u(13), fontWeight: 600, color: COLORS.text }}>
            Drag &amp; drop, paste, or click to add images or videos
          </strong>
          <span style={{ fontSize: u(12), color: COLORS.textMuted }}>
            Kept in this browser while editing; uploaded to Discord when you send.
          </span>
        </div>
      </div>
    </InlineEditorFrame>
  );
};
