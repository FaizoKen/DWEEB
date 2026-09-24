import React from "react";
import {
  AUTHOR,
  CAMPAIGN_ACCENT,
  PREVIEW_TIME,
  SELECT,
  campaignAdders,
  campaignRows,
  campaignState,
  textContent,
  type CampaignStage,
  type CampaignState,
  type CastMember,
} from "../story/campaign";
import { DBtn, DContainer, DGallery, DMsg, DRow, DSelect, DSelected, DTextDisplay, type TileArt } from "./DiscordUI";
import { TreeView, type TreeEditorSlot } from "./editor/Tree";

/**
 * The Season 4 campaign as the editor shows it — the live preview and the
 * component tree — both derived from ONE story state (story/campaign.ts), so
 * the hold cuts between build → assistant → plugins → send match by
 * construction: same props in, same pixels out.
 */

/* ── Preview ────────────────────────────────────────────────────────────── */

export type PreviewTarget = "container" | "text" | "gallery" | "row1" | "row2" | string;

export type CampaignPreviewProps = {
  /** The message state; defaults to `stage` (or the final message). */
  state?: CampaignState;
  stage?: CampaignStage;
  /** Header time: PREVIEW_TIME in the editor, DISCORD_TIME once posted. */
  time?: string;
  /** The preview's selection ring (a selected tree row mirrors here). */
  selected?: PreviewTarget | null;
  /** 0..1 glow per button id ("giveaway", "claim", …). */
  glow?: Partial<Record<string, number>>;
  /** Override a button's glow colour (e.g. ATTACH_GOLD at the plugin attach). */
  glowColor?: Partial<Record<string, string>>;
  /** 0..1 entrance per button id or "select" (the frame a component is added). */
  pop?: Partial<Record<string, number>>;
  hover?: string | null;
  pressed?: string | null;
  /** The giveaway button's public count ("Enter giveaway (129)"). */
  count?: number;
  /** 0..1 green wipe over the AI's rewritten body. */
  bodyHighlight?: number;
  /** Crossfade one gallery tile (the build beat's gallery check). */
  gallerySwap?: { index: 0 | 1 | 2; to: TileArt; t: number };
  /** Max width of the message column (Discord caps Components V2 at 600px ×zoom). */
  maxWidth?: number;
};

const Popped: React.FC<{ p?: number; children: React.ReactNode; origin?: string }> = ({ p = 1, children, origin = "center" }) => {
  if (p <= 0.001) return null;
  if (p >= 1) return <>{children}</>;
  return (
    <div
      style={{
        opacity: Math.min(1, p * 1.6),
        transform: `scale(${0.6 + 0.4 * p})`,
        transformOrigin: origin,
      }}
    >
      {children}
    </div>
  );
};

export const CampaignPreview: React.FC<CampaignPreviewProps> = ({
  state,
  stage,
  time = PREVIEW_TIME,
  selected = null,
  glow = {},
  glowColor = {},
  pop = {},
  hover = null,
  pressed = null,
  count,
  bodyHighlight = 0,
  gallerySwap,
  maxWidth,
}) => {
  const s = state ?? campaignState(stage ?? "final");
  const body = (
    <DMsg author={AUTHOR} avatar="nebula" time={time}>
      <DContainer accent={CAMPAIGN_ACCENT} selected={selected === "container" ? 1 : 0}>
        <DSelected on={selected === "text" ? 1 : 0}>
          <DTextDisplay
            content={textContent(s)}
            highlight={bodyHighlight > 0 ? { text: s.body, t: bodyHighlight } : undefined}
          />
        </DSelected>
        <DGallery selected={selected === "gallery" ? 1 : 0} swap={gallerySwap} />
        <DSelected on={selected === "row1" ? 1 : 0}>
          <DRow>
            {s.buttons.map((b) => (
              <Popped key={b.id} p={pop[b.id]} origin="left center">
                <DSelected on={selected === b.id ? 1 : 0}>
                  <DBtn
                    label={b.label}
                    kind={b.kind}
                    emoji={b.emoji}
                    glow={glow[b.id] ?? 0}
                    glowColor={glowColor[b.id]}
                    hover={hover === b.id}
                    pressed={pressed === b.id}
                    count={b.id === "giveaway" ? count : undefined}
                  />
                </DSelected>
              </Popped>
            ))}
          </DRow>
        </DSelected>
        {s.hasSelect && (
          <Popped p={pop.select} origin="left center">
            <DSelected on={selected === "row2" || selected === "select" ? 1 : 0} maxWidth={400}>
              <DSelect placeholder={SELECT.placeholder} />
            </DSelected>
          </Popped>
        )}
      </DContainer>
    </DMsg>
  );
  return <div style={{ width: "100%", maxWidth }}>{body}</div>;
};

/* ── Tree ───────────────────────────────────────────────────────────────── */

export type CampaignTreeProps = {
  state?: CampaignState;
  stage?: CampaignStage;
  selected?: string | null;
  /** The inline editor under the selected row. */
  editor?: TreeEditorSlot | null;
  /** Show the dashed adders ("+ Add button", "+ Add to container"). */
  adders?: boolean | { addButton?: boolean; addToContainer?: boolean };
  presence?: Record<string, CastMember[]>;
  reveal?: Record<string, number>;
  highlight?: Record<string, number>;
  hover?: string | null;
  pressed?: string | null;
};

export const CampaignTree: React.FC<CampaignTreeProps> = ({
  state,
  stage,
  selected = null,
  editor = null,
  adders = false,
  presence,
  reveal,
  highlight,
  hover = null,
  pressed = null,
}) => {
  const s = state ?? campaignState(stage ?? "final");
  const rows = campaignRows(s);
  const adderModels = campaignAdders(s).filter((a) =>
    adders === true ? true : adders === false ? false : a.id === "addButton" ? !!adders.addButton : !!adders.addToContainer,
  );
  return (
    <TreeView
      rows={rows}
      adders={adderModels}
      selected={selected}
      editor={editor}
      presence={presence}
      reveal={reveal}
      highlight={highlight}
      hover={hover}
      pressed={pressed}
    />
  );
};
