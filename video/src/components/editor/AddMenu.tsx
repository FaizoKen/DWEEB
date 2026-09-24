import React from "react";
import { COLORS } from "../../theme";
import { INTER } from "../../fonts";
import type { ComponentKind } from "../../story/rules";
import { ComponentGlyph } from "./glyphs";
import { PIcon } from "./ProductIcon";
import { useUi } from "./scale";

/**
 * The two-pane add menu a container's "+ Add to container" opens
 * (src/features/builder/components/AddComponentMenu.tsx + AddMenuPreview):
 * Structure / Content / Interactive on the left — "Buttons & menus" expands to
 * Button, Options menu, Member menu, Role menu, Member / role menu, Channel
 * menu — and a preview of the highlighted entry on the right.
 */

export type AddMenuItem =
  | "section"
  | "separator"
  | "text"
  | "gallery"
  | "file"
  | "buttonsMenus"
  | "button"
  | "optionsMenu"
  | "memberMenu"
  | "roleMenu"
  | "mentionMenu"
  | "channelMenu";

const ITEMS: Record<AddMenuItem, { label: string; glyph: ComponentKind; desc: string; group?: boolean }> = {
  section: { label: "Section", glyph: "section", desc: "Text alongside a button or thumbnail.", group: true },
  separator: { label: "Separator", glyph: "separator", desc: "Spacer or divider line." },
  text: { label: "Text", glyph: "text", desc: "Markdown text block." },
  gallery: { label: "Media gallery", glyph: "gallery", desc: "Up to 10 images or videos in a grid." },
  file: { label: "File", glyph: "file", desc: "Attached file reference." },
  buttonsMenus: { label: "Buttons & menus", glyph: "actionRow", desc: "A row of up to 5 buttons, or one dropdown menu.", group: true },
  button: { label: "Button", glyph: "button", desc: "Link, action, or premium button." },
  optionsMenu: { label: "Options menu", glyph: "select", desc: "A dropdown of options you write (Discord’s string select)." },
  memberMenu: { label: "Member menu", glyph: "select", desc: "A dropdown of the server’s members (Discord’s user select)." },
  roleMenu: { label: "Role menu", glyph: "select", desc: "A dropdown of the server’s roles (Discord’s role select)." },
  mentionMenu: { label: "Member / role menu", glyph: "select", desc: "A dropdown of members and roles (Discord’s mentionable select)." },
  channelMenu: { label: "Channel menu", glyph: "select", desc: "A dropdown of the server’s channels (Discord’s channel select)." },
};

const SECTIONS: { title: string; items: AddMenuItem[] }[] = [
  { title: "STRUCTURE", items: ["section", "separator"] },
  { title: "CONTENT", items: ["text", "gallery", "file"] },
  { title: "INTERACTIVE", items: ["buttonsMenus"] },
];
const MENU_CHILDREN: AddMenuItem[] = ["button", "optionsMenu", "memberMenu", "roleMenu", "mentionMenu", "channelMenu"];

const Row: React.FC<{ item: AddMenuItem; active: boolean; expanded?: boolean; child?: boolean }> = ({ item, active, expanded, child }) => {
  const { u } = useUi();
  const it = ITEMS[item];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: u(10),
        height: u(38),
        padding: `0 ${u(8)}px`,
        marginLeft: child ? u(22) : 0,
        borderRadius: u(6),
        background: active ? COLORS.bgActive : "transparent",
        color: COLORS.text,
      }}
    >
      <span
        style={{
          width: u(26),
          height: u(26),
          borderRadius: u(6),
          background: COLORS.bgInput,
          border: `${u(1)}px solid ${COLORS.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <ComponentGlyph kind={it.glyph} size={u(13)} color={COLORS.textMuted} />
      </span>
      <span style={{ fontSize: u(14), fontWeight: 600, flex: 1, whiteSpace: "nowrap" }}>{it.label}</span>
      {it.group && <PIcon name={expanded ? "chevronDown" : "chevronRight"} size={u(16)} color={COLORS.textSubtle} />}
    </div>
  );
};

/** A small drawing of the highlighted entry (AddMenuPreview's role). */
const Illustration: React.FC<{ item: AddMenuItem }> = ({ item }) => {
  const { u } = useUi();
  const bar = (w: string, c = COLORS.borderStrong) => (
    <div style={{ height: u(8), width: w, borderRadius: 4, background: c }} />
  );
  const isMenu = ITEMS[item].glyph === "select";
  return (
    <div
      style={{
        height: u(150),
        borderRadius: u(10),
        background: COLORS.bgActive,
        border: `${u(1)}px solid ${COLORS.border}`,
        padding: u(18),
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: u(10),
      }}
    >
      {isMenu ? (
        <>
          <div
            style={{
              height: u(28),
              borderRadius: u(6),
              background: "#1a1c22",
              border: `${u(1)}px solid ${COLORS.borderStrong}`,
              display: "flex",
              alignItems: "center",
              padding: `0 ${u(10)}px`,
              gap: u(8),
            }}
          >
            {bar("60%")}
            <span style={{ marginLeft: "auto", display: "flex" }}>
              <PIcon name="chevronDown" size={u(14)} color={COLORS.textMuted} />
            </span>
          </div>
          <div style={{ borderRadius: u(6), background: "#1a1c22", border: `${u(1)}px solid ${COLORS.border}`, padding: u(8), display: "flex", flexDirection: "column", gap: u(8) }}>
            {bar("70%")}
            {bar("55%")}
            {bar("62%")}
          </div>
        </>
      ) : item === "button" || item === "buttonsMenus" ? (
        <div style={{ display: "flex", gap: u(8), marginTop: u(30) }}>
          <div style={{ height: u(24), flex: 1, borderRadius: u(6), background: COLORS.blurple }} />
          <div style={{ height: u(24), flex: 1, borderRadius: u(6), background: "#2b8a4f" }} />
          <div style={{ height: u(24), flex: 1, borderRadius: u(6), background: "rgba(151,151,159,0.24)" }} />
        </div>
      ) : (
        <>
          {bar("75%")}
          {bar("90%")}
          {bar("60%")}
        </>
      )}
    </div>
  );
};

export const AddComponentMenu: React.FC<{
  /** Expand "Buttons & menus". */
  expanded?: boolean;
  /** The highlighted entry (keyboard/pointer focus). */
  highlight?: AddMenuItem;
  reveal?: number;
  width?: number | string;
  /** Fixed menu height (px); the list scrolls inside it, like the product's. */
  height?: number;
  /** How far the left list is scrolled (px) — e.g. to bring Interactive into view. */
  listScroll?: number;
}> = ({ expanded = true, highlight = "optionsMenu", reveal = 1, width, height, listScroll = 0 }) => {
  const { u } = useUi();
  if (reveal <= 0.001) return null;
  const r = Math.min(1, reveal);
  const it = ITEMS[highlight];
  return (
    <div
      style={{
        width: width ?? u(580),
        height,
        display: "flex",
        background: COLORS.bgElevated,
        border: `${u(1)}px solid ${COLORS.border}`,
        borderRadius: u(10),
        boxShadow: `0 ${u(16)}px ${u(48)}px rgba(0,0,0,${(0.6 * r).toFixed(3)})`,
        overflow: "hidden",
        fontFamily: INTER,
        opacity: Math.min(1, r * 1.5),
        transform: r < 1 ? `translateY(${(1 - r) * u(10)}px) scale(${0.97 + 0.03 * r})` : undefined,
        transformOrigin: "top left",
      }}
    >
      <div style={{ width: "54%", borderRight: `${u(1)}px solid ${COLORS.border}`, boxSizing: "border-box", overflow: "hidden" }}>
        <div style={{ padding: u(10), transform: listScroll ? `translateY(${-listScroll}px)` : undefined }}>
        {SECTIONS.map((s) => (
          <div key={s.title} style={{ marginBottom: u(6) }}>
            <div style={{ padding: `${u(8)}px ${u(8)}px ${u(4)}px`, fontSize: u(11), fontWeight: 600, letterSpacing: "0.08em", color: COLORS.textSubtle }}>
              {s.title}
            </div>
            {s.items.map((item) => (
              <React.Fragment key={item}>
                <Row item={item} active={highlight === item} expanded={item === "buttonsMenus" && expanded} />
                {item === "buttonsMenus" &&
                  expanded &&
                  MENU_CHILDREN.map((c) => <Row key={c} item={c} active={highlight === c} child />)}
              </React.Fragment>
            ))}
          </div>
        ))}
        </div>
      </div>
      <div style={{ flex: 1, padding: u(14), display: "flex", flexDirection: "column", gap: u(12), minWidth: 0 }}>
        <Illustration item={highlight} />
        <div style={{ fontSize: u(14), fontWeight: 600, color: COLORS.text }}>{it.label}</div>
        <div style={{ fontSize: u(12), lineHeight: 1.5, color: COLORS.textMuted }}>{it.desc}</div>
        <div style={{ marginTop: "auto", fontSize: u(11), color: COLORS.textSubtle }}>↑↓ to browse · Enter to add</div>
      </div>
    </div>
  );
};
