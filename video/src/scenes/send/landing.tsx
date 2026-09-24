import React from "react";
import { CampaignPreview, type CampaignPreviewProps } from "../../components/CampaignUI";
import { DMsg, DReaction, DTextDisplay, DiscordMobile, DiscordShell, type Channel } from "../../components/DiscordUI";
import { DiscordScale } from "../../components/editor";
import { ANNOUNCEMENT_HISTORY, DISCORD_TIME, SERVER } from "../../story/campaign";
import { EDITOR_L } from "../contracts";
import { PORTRAIT_ORIGIN, PORTRAIT_SIZE } from "../plugins/act";

/**
 * #announcements, where the message lands. Landscape: the desktop client,
 * placed so the card's slot sits just below-right of where the editor
 * preview showed it — the flight is a short glide, not a whip — and so the
 * card clears the bottom-left caption zone. Portrait: the Discord phone view
 * on the editor's own rect, the card exactly as wide as the preview's.
 *
 * The message block (card + reactions) is laid out absolutely at a known
 * slot, bottom-anchored above the composer as Discord stacks it, so the
 * flying card knows exactly where to land.
 */

/* ── Landscape ──────────────────────────────────────────────────────────── */

/** The desktop client's rect in the world (content box; a 1px border around it). */
export const SHELL_L = { x: 630, y: EDITOR_L.y, w: 1080, h: 900 } as const;
const RAIL = 74;
const SIDEBAR = 250;
/** The shell's header (52 + 1px rule) and composer strip (a 46 + 2 bordered input + 20 below). */
const HEADER_H = 53;
const COMPOSER_H = 68;
/** Discord's message-area padding (DiscordShell: 18px 22px). */
const AREA_PAD = { x: 22, y: 18 };

/** The card and the reactions row under it, at the landscape zoom (dk = EDITOR_L.dk). */
const DK_L = EDITOR_L.dk;
/** The delivered card's height at 700 × dk 1.12 (heading + two body lines, the 12:7 gallery, one row of
 *  three buttons, the select), and the reactions row under it (8 + 28, ×dk). */
export const CARD_H_L = 618.2;
const REACTIONS_H_L = (8 + 28) * DK_L;
const GAP = 20;

/** Where the card lands (world px, top-left). */
export const SLOT_L = (() => {
  const areaTop = SHELL_L.y + 1 + HEADER_H;
  const areaBottom = SHELL_L.y + 1 + SHELL_L.h - COMPOSER_H;
  const top = areaBottom - AREA_PAD.y - REACTIONS_H_L - CARD_H_L;
  return { x: SHELL_L.x + 1 + RAIL + SIDEBAR + AREA_PAD.x, y: top, w: EDITOR_L.previewMaxW, areaTop, areaBottom };
})();

const CHANNELS: Channel[] = [
  { cat: "INFORMATION" },
  { name: "announcements", kind: "announcement", active: true },
  { name: "rules" },
  { cat: "COMMUNITY" },
  { name: "general", unread: true },
  { name: SERVER.channels[2] },
];

export type Delivered = {
  /** The card's own props (count, hover, pressed, glow…); state/time are set here. */
  card: CampaignPreviewProps;
  /** Hide the in-channel card while the flying copy is in the air. */
  hidden?: boolean;
  reactions: { emoji: string; count: number; mine?: boolean; pop: number }[];
};

const Reactions: React.FC<{ items: Delivered["reactions"]; indent: number }> = ({ items, indent }) => (
  <div style={{ display: "flex", gap: 8 * DK_L, marginLeft: indent, marginTop: 8 * DK_L, height: 28 * DK_L, alignItems: "center" }}>
    {items.map((r) => (
      <DReaction key={r.emoji} emoji={r.emoji} count={r.count} mine={r.mine} pop={r.pop} />
    ))}
  </div>
);

/** The desktop client with the older post and the delivered message at SLOT_L. */
export const DiscordLandingL: React.FC<{ delivered: Delivered; opacity?: number }> = ({ delivered, opacity = 1 }) => {
  const localTop = SLOT_L.y - SLOT_L.areaTop;
  const older = ANNOUNCEMENT_HISTORY[ANNOUNCEMENT_HISTORY.length - 1];
  return (
    <div
      style={{
        position: "absolute",
        left: SHELL_L.x,
        top: SHELL_L.y,
        opacity: opacity < 1 ? opacity : undefined,
      }}
    >
      <DiscordScale k={DK_L}>
        <DiscordShell
          width={SHELL_L.w}
          height={SHELL_L.h}
          header="announcements"
          headerKind="announcement"
          inputGhost="Message #announcements"
          channels={CHANNELS}
        >
          {/* The older post, bottom-aligned just above the new message. */}
          <div style={{ position: "absolute", left: AREA_PAD.x, right: AREA_PAD.x, bottom: SLOT_L.areaBottom - SLOT_L.areaTop - localTop + GAP }}>
            <DMsg author={older.author} avatar="nebula" time={older.time} dim={0.6}>
              <DTextDisplay content={older.text} />
            </DMsg>
          </div>
          <div style={{ position: "absolute", left: AREA_PAD.x, top: localTop, width: SLOT_L.w }}>
            <div style={{ visibility: delivered.hidden ? "hidden" : undefined }}>
              <CampaignPreview {...delivered.card} time={DISCORD_TIME} maxWidth={SLOT_L.w} />
            </div>
            <Reactions items={delivered.reactions} indent={(40 + 16) * DK_L} />
          </div>
        </DiscordShell>
      </DiscordScale>
    </div>
  );
};

/* ── Portrait ───────────────────────────────────────────────────────────── */

/** The phone's #announcements on the editor's own rect (world px). */
export const MOBILE_V = { x: PORTRAIT_ORIGIN.x, y: PORTRAIT_ORIGIN.y, w: PORTRAIT_SIZE.w, h: PORTRAIT_SIZE.h } as const;
/** DiscordMobile's header (58 + 1px rule), composer strip (10 + 40 + 14) and list padding (14 12 6). */
const M_HEADER = 59;
const M_COMPOSER = 64;
const M_PAD = { top: 14, x: 12, bottom: 6 };
/** The delivered card at 496 × dk 1 (two rows of buttons at this width) and its reactions row. */
export const CARD_H_V = 515.7;
const REACTIONS_H_V = 8 + 28;

export const SLOT_V = (() => {
  const listBottom = MOBILE_V.y + 1 + MOBILE_V.h - M_COMPOSER - M_PAD.bottom;
  return {
    x: MOBILE_V.x + 1 + M_PAD.x,
    y: listBottom - REACTIONS_H_V - CARD_H_V,
    w: MOBILE_V.w - 2 * M_PAD.x,
    listTop: MOBILE_V.y + 1 + M_HEADER,
  };
})();

/**
 * The phone's channel view with the delivered message at SLOT_V. No older
 * post here: the card fills the list, and a post above it could only show
 * sliced under the header.
 */
export const DiscordLandingV: React.FC<{ delivered: Delivered; opacity?: number }> = ({ delivered, opacity = 1 }) => (
  <div
    style={{
      position: "absolute",
      left: MOBILE_V.x,
      top: MOBILE_V.y,
      width: MOBILE_V.w,
      opacity: opacity < 1 ? opacity : undefined,
    }}
  >
    <DiscordScale k={1}>
      <DiscordMobile channel="announcements" height={MOBILE_V.h} inputGhost="Message #announcements" anchor="top">
        <div style={{ position: "absolute", left: M_PAD.x, top: SLOT_V.y - SLOT_V.listTop, width: SLOT_V.w }}>
          <div style={{ visibility: delivered.hidden ? "hidden" : undefined }}>
            <CampaignPreview {...delivered.card} time={DISCORD_TIME} maxWidth={SLOT_V.w} />
          </div>
          <div style={{ display: "flex", gap: 8, marginLeft: 56, marginTop: 8, height: 28, alignItems: "center" }}>
            {delivered.reactions.map((r) => (
              <DReaction key={r.emoji} emoji={r.emoji} count={r.count} mine={r.mine} pop={r.pop} />
            ))}
          </div>
        </div>
      </DiscordMobile>
    </DiscordScale>
  </div>
);

