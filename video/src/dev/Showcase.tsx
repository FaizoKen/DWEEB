import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { INTER } from "../fonts";
import {
  AI,
  ANNOUNCEMENT_HISTORY,
  CAST,
  DISCORD_TIME,
  HEADING,
  LAUNCH_NIGHT,
  REACTIONS,
  campaignAdders,
  campaignRows,
  campaignState,
  campaignStats,
  launchRows,
  launchState,
  launchText,
  textContent,
} from "../story/campaign";
import { CampaignPreview, CampaignTree } from "../components/CampaignUI";
import { DBtn, DContainer, DGallery, DMsg, DReaction, DRow, DSelect, DTextDisplay, DiscordMobile, DiscordShell, ATTACH_GOLD } from "../components/DiscordUI";
import { EditorWindow, PortraitEditor, PORTRAIT_UI, editorWindowGeometry } from "../components/editor/Layouts";
import { TextInlineEditor, ButtonInlineEditor, GalleryInlineEditor, TEXT_EDITOR_H, BUTTON_EDITOR_H, GALLERY_EDITOR_H } from "../components/editor/InlineEditors";
import { AttachedPluginChip, AddActionModal } from "../components/editor/Plugins";
import { AssistantPanel, ThinkingDots } from "../components/editor/Assistant";
import { SendPanel } from "../components/editor/Send";
import { MessageDirectory, TemplatePickToast } from "../components/editor/Directory";
import { ActivityBar, ActivityShell, InviteTooltip, PresenceDock } from "../components/editor/Activity";
import { AddComponentMenu } from "../components/editor/AddMenu";
import { Backdrop } from "../components/editor/chrome";
import { EditorActionBar } from "../components/editor/ActionBar";
import { StatPills } from "../components/editor/Meta";
import { TreeAdder, TreeRowView, TreeView, treeLayout } from "../components/editor/Tree";
import { DiscordScale, UiScale } from "../components/editor/scale";
import { Cursor, type CursorVariant } from "../components/Cursor";

/**
 * Dev-only component showcase (not part of the film): lays out the shared
 * product-UI building blocks so they can be reviewed as stills without
 * touching the scenes. Rendered by the "Showcase" composition in Root.tsx.
 *
 * One page per 8 frames (render frames 0, 8, 16 … 112):
 *   0   landscape editor (600 pane, k 1.1) — stock template, Text row editing
 *   8   landscape editor (520 pane, k 1)   — select just added, add menu, pills ✓
 *   16  landscape editor — AI dock (reply + "Updated the message · Undo"), body wipe
 *   24  landscape editor — Button row ACTION panel + "Add an action" modal
 *   32  landscape editor — attached chip, gold glow, "Send message" popover
 *   40  landscape — Message directory overlay + pick toast
 *   48  Discord desktop — the delivered message, count, reactions
 *   56  Activity — bar, presence on the tree, dock + tooltip
 *   64  portrait — editor (left: stage at 2× as filmed | right: whole stage)
 *   72  portrait — AI assistant sheet (empty state while typing)
 *   80  portrait — "Add an action" sheet | "Send message" sheet
 *   88  portrait — Discord mobile landing | directory sheet
 *   96  portrait — Activity (bar ladder, presence, dock)
 *   104 states sheet — app chrome (rows, adders, pills, bar ladder, dock, chip)
 *   112 states sheet — Discord (button kinds × states, count, reactions, wipe, dots)
 *   120 cursors — every variant × press age; Kai's phone tap at the portrait's 2×
 */

const PageLabel: React.FC<{ n: number; title: string }> = ({ n, title }) => (
  <div
    style={{
      position: "absolute",
      left: 20,
      top: 14,
      zIndex: 50,
      fontFamily: INTER,
      fontSize: 18,
      fontWeight: 700,
      color: "rgba(255,255,255,0.55)",
      letterSpacing: "0.04em",
    }}
  >
    {n * SHOWCASE_PAGE_FRAMES} · {title}
  </div>
);

const Stage: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ background: "linear-gradient(145deg, #08090d 0%, #0d1018 54%, #080a0f 100%)" }}>{children}</AbsoluteFill>
);

/** A landscape editor window, centred in the 1920×1080 frame at world scale 1. */
const Landscape: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ position: "absolute", left: 120, top: 120 }}>{children}</div>
);

/* ── Landscape pages ───────────────────────────────────────────────────── */

const PageBuildText: React.FC = () => {
  const s = campaignState("stock");
  const stats = campaignStats(s);
  const content = textContent(s);
  const selStart = 2;
  const selEnd = 2 + HEADING.stock.length;
  return (
    <Landscape>
      <EditorWindow
        leftWidth={600}
        k={1.1}
        bar={{ channel: null }}
        meta={{ ...stats }}
        tree={
          <CampaignTree
            state={s}
            selected="text"
            adders
            editor={{ rowId: "text", height: TEXT_EDITOR_H, node: <TextInlineEditor content={content} selection={[selStart, selEnd]} /> }}
          />
        }
        preview={<CampaignPreview state={s} selected="text" maxWidth={700} />}
      />
    </Landscape>
  );
};

/** A dev crosshair: proves a geometry helper's anchor lands on its control. */
const Mark: React.FC<{ x: number; y: number }> = ({ x, y }) => (
  <div style={{ position: "absolute", left: x - 5, top: y - 5, width: 10, height: 10, borderRadius: "50%", border: "2px solid #ff3cac", zIndex: 60 }} />
);

const PageBuildSelect: React.FC = () => {
  const s = campaignState("select");
  const stats = campaignStats(s);
  const geo = editorWindowGeometry({ meta: {}, bar: { channel: null } });
  const tl = treeLayout(campaignRows(s), campaignAdders(s), { k: 1 });
  const rowMark = (id: string) => {
    const b = tl.box(id)!;
    return <Mark key={id} x={geo.tree.x + b.x + 60} y={geo.tree.y + b.y + b.h / 2} />;
  };
  return (
    <Landscape>
      <EditorWindow
        bar={{ channel: null }}
        meta={{ ...stats, ok: 1 }}
        tree={<CampaignTree state={s} adders highlight={{ select: 0.8, row2: 0.5 }} hover="addToContainer" />}
        paneOverlay={
          <div style={{ position: "absolute", left: 40, top: geo.tree.y + 330 }}>
            <AddComponentMenu highlight="optionsMenu" width={470} height={330} listScroll={196} />
          </div>
        }
        preview={<CampaignPreview state={s} pop={{ select: 0.85 }} selected="select" maxWidth={700} />}
        overlay={
          <>
            {Object.entries(geo.bar).map(([id, p]) => (
              <Mark key={id} x={p!.x} y={p!.y} />
            ))}
            {["text", "claim", "addButton", "row2"].map(rowMark)}
          </>
        }
      />
    </Landscape>
  );
};

const PageAssistant: React.FC = () => {
  const frame = useCurrentFrame();
  const s = campaignState("final");
  const stats = campaignStats(s);
  return (
    <Landscape>
      <EditorWindow
        bar={{ channel: null }}
        meta={{ ...stats }}
        tree={<CampaignTree state={s} highlight={{ giveaway: 0.6 }} />}
        preview={
          <div style={{ width: 640, marginRight: 480 }}>
            <CampaignPreview state={s} bodyHighlight={0.62} glow={{ giveaway: 0.9 }} pop={{ giveaway: 1 }} />
          </div>
        }
        previewAlign="start"
        fabs={false}
        previewOverlay={
          <div style={{ position: "absolute", top: 0, bottom: 0, right: 0, width: 500 }}>
            <AssistantPanel
              zoom={1.32}
              sent={AI.prompt}
              reply={AI.reply}
              applied={1}
              frame={frame}
              usage={AI.usage(1)}
            />
          </div>
        }
      />
    </Landscape>
  );
};

const PagePluginsModal: React.FC = () => {
  const s = campaignState("final");
  const stats = campaignStats(s);
  return (
    <Landscape>
      <EditorWindow
        bar={{ channel: null }}
        meta={{ ...stats }}
        treeScroll={120}
        tree={
          <CampaignTree
            state={s}
            selected="giveaway"
            editor={{ rowId: "giveaway", height: BUTTON_EDITOR_H, node: <ButtonInlineEditor browseHover /> }}
          />
        }
        preview={<CampaignPreview state={s} selected="giveaway" maxWidth={700} />}
        overlay={
          <Backdrop>
            <div style={{ position: "absolute", left: 470, top: 110, width: 760 }}>
              <UiScale k={1.12}>
                <AddActionModal
                  cards={{ giveaway: { hover: 1, glint: 0.55 }, tickets: { glint: 0.3 } }}
                  moreLit={0.4}
                />
              </UiScale>
            </div>
          </Backdrop>
        }
      />
    </Landscape>
  );
};

const PageAttachSend: React.FC = () => {
  const s = campaignState("attached");
  const stats = campaignStats(s);
  const geo = editorWindowGeometry({ meta: {} });
  const send = geo.bar.send!;
  return (
    <Landscape>
      <EditorWindow
        bar={{ channel: "announcements", pressed: "send" }}
        meta={{ ...stats }}
        treeScroll={120}
        tree={
          <CampaignTree
            state={s}
            selected="giveaway"
            editor={{
              rowId: "giveaway",
              height: BUTTON_EDITOR_H,
              node: <ButtonInlineEditor attached={<AttachedPluginChip glow={0.7} />} />,
            }}
          />
        }
        preview={<CampaignPreview state={s} glow={{ giveaway: 1 }} glowColor={{ giveaway: ATTACH_GOLD }} maxWidth={700} />}
        overlay={
          <div style={{ position: "absolute", left: send.x - 250, top: send.y + 30, width: 600 }}>
            <UiScale k={1.05}>
              <SendPanel selected="announcements" hover="announcements" statusReveal={{ announcements: 1 }} />
            </UiScale>
          </div>
        }
      />
    </Landscape>
  );
};

const PageDirectory: React.FC = () => {
  const s = campaignState("final");
  const stats = campaignStats(s);
  return (
    <Landscape>
      <EditorWindow
        bar={{ channel: null, pressed: "directory" }}
        meta={{ ...stats }}
        tree={<CampaignTree state={s} />}
        preview={<CampaignPreview state={s} maxWidth={700} />}
        overlay={
          <Backdrop>
            <div style={{ position: "absolute", left: 40, top: 70, right: 40, bottom: 26 }}>
              <MessageDirectory states={{ announcement: { hover: 1 }, welcome: { hover: 0 } }} />
            </div>
            <div style={{ position: "absolute", right: 60, top: 84 }}>
              <UiScale k={1.15}>
                <TemplatePickToast />
              </UiScale>
            </div>
          </Backdrop>
        }
      />
    </Landscape>
  );
};

const PageDiscord: React.FC = () => {
  const s = campaignState("attached");
  return (
    <div style={{ position: "absolute", left: 120, top: 110 }}>
      <DiscordScale k={1.15}>
        <DiscordShell
          width={1680}
          height={880}
          header="announcements"
          anchor="bottom"
          channels={[
            { cat: "INFORMATION" },
            { name: "announcements", active: true },
            { name: "rules" },
            { cat: "COMMUNITY" },
            { name: "general", unread: true },
            { name: "events" },
          ]}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 22, maxWidth: 820 }}>
            {ANNOUNCEMENT_HISTORY.map((m) => (
              <DMsg key={m.time} author={m.author} avatar="nebula" time={m.time} dim={0.6}>
                <DTextDisplay content={m.text} />
              </DMsg>
            ))}
            <div>
              <CampaignPreview state={s} time={DISCORD_TIME} count={131} hover="giveaway" glow={{ giveaway: 0.5 }} />
              <div style={{ display: "flex", gap: 8, marginLeft: 64, marginTop: 8 }}>
                <DReaction emoji={REACTIONS[0].emoji} count={14} mine />
                <DReaction emoji={REACTIONS[1].emoji} count={7} pop={0.7} />
              </div>
            </div>
          </div>
        </DiscordShell>
      </DiscordScale>
    </div>
  );
};

const PageActivity: React.FC = () => {
  const ls = launchState({ kaiTyped: 6, suggestAdded: true });
  return (
    <div style={{ position: "absolute", left: 120, top: 110 }}>
      <UiScale k={1.1}>
        <DiscordScale k={1.15}>
          <ActivityShell
            width={1680}
            height={880}
            leftWidth={560}
            bar={<ActivityBar channel={LAUNCH_NIGHT.channel} />}
            left={
              <TreeView
                rows={launchRows(ls)}
                selected="suggest"
                presence={{ text: [CAST.kai] }}
                highlight={{ suggest: 0.7 }}
              />
            }
            right={
              <div style={{ padding: 32, display: "flex", justifyContent: "center" }}>
                <div style={{ width: 720 }}>
                  <DMsg author="Nebula Gaming" avatar="nebula" time="09:41 AM">
                    <DContainer accent={LAUNCH_NIGHT.accent}>
                      <DTextDisplay content={launchText(ls)} />
                      <DRow>
                        {ls.buttons.map((b) => (
                          <DBtn key={b.id} label={b.label} kind={b.kind} emoji={b.emoji} glow={b.id === "suggest" ? 0.8 : 0} />
                        ))}
                      </DRow>
                    </DContainer>
                  </DMsg>
                </div>
              </div>
            }
            dock={
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>
                <InviteTooltip />
                <PresenceDock people={[CAST.aria, { ...CAST.kai, join: 0.8 }]} hover />
              </div>
            }
          />
        </DiscordScale>
      </UiScale>
    </div>
  );
};

/* ── Portrait pages ────────────────────────────────────────────────────── */

/**
 * The portrait stage (540×960 units). Children are laid out in stage units;
 * the caption band (118–195) is marked for spacing checks.
 */
const PortraitStage: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ position: "relative", width: 540, height: 960, background: "linear-gradient(160deg, #0c0e16, #090a0f)", overflow: "hidden" }}>
    <div
      style={{
        position: "absolute",
        left: 22,
        right: 22,
        top: 118,
        height: 77,
        border: "1px dashed rgba(255,255,255,0.16)",
        borderRadius: 9,
        color: "rgba(255,255,255,0.3)",
        fontFamily: INTER,
        fontSize: 11,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      caption band
    </div>
    {children}
  </div>
);

/** Left: the stage at 2× (as the vertical camera films it), window [y0, y0+540]. Right: the whole stage at 1.1×. */
const PortraitPage: React.FC<{ stage: React.ReactNode; y0?: number }> = ({ stage, y0 = 200 }) => (
  <>
    <div style={{ position: "absolute", left: 0, top: 0, width: 1080, height: 1080, overflow: "hidden", borderRight: "2px solid #22252e" }}>
      <div style={{ position: "absolute", left: 0, top: -y0 * 2, transform: "scale(2)", transformOrigin: "0 0" }}>{stage}</div>
    </div>
    <div style={{ position: "absolute", left: 1120, top: 12, transform: "scale(1.1)", transformOrigin: "0 0" }}>{stage}</div>
  </>
);

const portraitEditor = (opts: {
  sheet?: React.ReactNode;
  scrim?: number;
  stage?: "stock" | "final";
  selected?: string | null;
  galleryEditor?: boolean;
  treeScroll?: number;
}) => {
  const s = campaignState(opts.stage ?? "final");
  const st = campaignStats(s);
  return (
    <PortraitStage>
      <div style={{ position: "absolute", left: PORTRAIT_UI.side, top: PORTRAIT_UI.top }}>
        <PortraitEditor
          bar={{ channel: null }}
          preview={
            <CampaignPreview
              state={s}
              selected={opts.galleryEditor ? "gallery" : null}
              gallerySwap={opts.galleryEditor ? { index: 1, to: "aurora", t: 1 } : undefined}
            />
          }
          previewScroll={opts.galleryEditor ? 60 : 0}
          sheetTop={430}
          pills={st}
          tree={
            <CampaignTree
              state={s}
              selected={opts.selected ?? null}
              adders
              editor={
                opts.galleryEditor
                  ? { rowId: "gallery", height: GALLERY_EDITOR_H, node: <GalleryInlineEditor dropActive={0.7} /> }
                  : null
              }
            />
          }
          treeScroll={opts.treeScroll ?? 0}
          sheet={opts.sheet}
          scrim={opts.scrim}
        />
      </div>
    </PortraitStage>
  );
};

const PagePortraitEditor: React.FC = () => (
  <PortraitPage stage={portraitEditor({ selected: "gallery", galleryEditor: true, treeScroll: 40 })} y0={200} />
);

const PagePortraitAssistant: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <PortraitPage
      y0={420}
      stage={portraitEditor({
        scrim: 0.4,
        sheet: (
          <UiScale k={1.07}>
            <AssistantPanel layout="sheet" height={470} composer={AI.prompt.slice(0, 31)} caret thinking={false} sent={null} frame={frame} usage={AI.usage(0)} />
          </UiScale>
        ),
      })}
    />
  );
};

const PagePortraitSheets: React.FC = () => (
  <>
    <div style={{ position: "absolute", left: 0, top: 0, width: 1080, height: 1080, overflow: "hidden", borderRight: "2px solid #22252e" }}>
      <div style={{ position: "absolute", left: 0, top: -300 * 2, transform: "scale(2)", transformOrigin: "0 0" }}>
        {portraitEditor({
          scrim: 1,
          sheet: (
            <UiScale k={1.07}>
              <AddActionModal layout="sheet" cards={{ giveaway: { selected: true } }} />
            </UiScale>
          ),
        })}
      </div>
    </div>
    <div style={{ position: "absolute", left: 1120, top: 12, transform: "scale(1.1)", transformOrigin: "0 0" }}>
      {portraitEditor({
        scrim: 1,
        sheet: (
          <UiScale k={1.07}>
            <SendPanel layout="sheet" selected="announcements" lead={false} />
          </UiScale>
        ),
      })}
    </div>
  </>
);

const PagePortraitDiscord: React.FC = () => {
  const s = campaignState("attached");
  const mobile = (
    <PortraitStage>
      <div style={{ position: "absolute", left: 10, right: 10, top: 200, bottom: 20 }}>
        <DiscordScale k={1.0}>
          <DiscordMobile channel="announcements" height="100%">
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <DMsg author={ANNOUNCEMENT_HISTORY[1].author} avatar="nebula" time={ANNOUNCEMENT_HISTORY[1].time} dim={0.6}>
                <DTextDisplay content={ANNOUNCEMENT_HISTORY[1].text} />
              </DMsg>
              <div>
                <CampaignPreview state={s} time={DISCORD_TIME} count={129} />
                <div style={{ display: "flex", gap: 8, marginLeft: 56, marginTop: 8 }}>
                  <DReaction emoji="🎉" count={9} mine />
                  <DReaction emoji="🔥" count={3} />
                </div>
              </div>
            </div>
          </DiscordMobile>
        </DiscordScale>
      </div>
    </PortraitStage>
  );
  const dir = (
    <PortraitStage>
      <div style={{ position: "absolute", left: 10, right: 10, top: 230, bottom: 0 }}>
        <UiScale k={1.07}>
          <MessageDirectory layout="sheet" columns={1} cards={["welcome", "announcement", "patch-notes"]} states={{ announcement: { hover: 1 } }} previewH={170} />
        </UiScale>
      </div>
    </PortraitStage>
  );
  return (
    <>
      <div style={{ position: "absolute", left: 0, top: 0, width: 1080, height: 1080, overflow: "hidden", borderRight: "2px solid #22252e" }}>
        <div style={{ position: "absolute", left: 0, top: -200 * 2, transform: "scale(2)", transformOrigin: "0 0" }}>{mobile}</div>
      </div>
      <div style={{ position: "absolute", left: 1120, top: 12, transform: "scale(1.1)", transformOrigin: "0 0" }}>{dir}</div>
    </>
  );
};

/* ── Pages ─────────────────────────────────────────────────────────────── */

/** Portrait Activity: bar (fit ladder), the Launch night message, the tree strip with Kai's presence, the dock. */
const PagePortraitActivity: React.FC = () => {
  const ls = launchState({ kaiTyped: 99, suggestAdded: true });
  const stage = (
    <PortraitStage>
      <div style={{ position: "absolute", left: PORTRAIT_UI.side, top: PORTRAIT_UI.top }}>
        <UiScale k={1.07}>
          <DiscordScale k={1.0}>
            <div
              style={{
                position: "relative",
                width: 520,
                height: 740,
                borderRadius: 18,
                overflow: "hidden",
                background: "#313338",
                border: "1px solid #3b4150",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <ActivityBar width={518} channel={LAUNCH_NIGHT.channel} />
              <div style={{ padding: "14px 12px 6px" }}>
                <DMsg author="Nebula Gaming" avatar="nebula" time="09:41 AM">
                  <DContainer accent={LAUNCH_NIGHT.accent}>
                    <DTextDisplay content={launchText(ls)} />
                    <DRow>
                      {ls.buttons.map((b) => (
                        <DBtn key={b.id} label={b.label} kind={b.kind} emoji={b.emoji} glow={b.id === "suggest" ? 0.8 : 0} />
                      ))}
                    </DRow>
                  </DContainer>
                </DMsg>
              </div>
              <div style={{ margin: "8px 10px 0", padding: 8, borderRadius: 14, background: "#0e0f13" }}>
                <TreeView rows={launchRows(ls)} selected="suggest" presence={{ text: [CAST.kai] }} />
              </div>
              <div style={{ position: "absolute", right: 12, bottom: 12, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
                <InviteTooltip reveal={0.9} />
                <PresenceDock people={[CAST.aria, CAST.kai]} />
              </div>
            </div>
          </DiscordScale>
        </UiScale>
      </div>
    </PortraitStage>
  );
  return <PortraitPage stage={stage} y0={200} />;
};

const Grid: React.FC<{ children: React.ReactNode; cols: number; gap?: number }> = ({ children, cols, gap = 14 }) => (
  <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap, alignItems: "start" }}>{children}</div>
);
const Label: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontFamily: INTER, fontSize: 12, color: "rgba(255,255,255,0.45)", margin: "10px 0 4px" }}>{children}</div>
);

/** States sheet A — the app chrome: every tree row kind/state, adders, pills, the bar's ladder, the dock. */
const PageStatesApp: React.FC = () => {
  const kinds = ["container", "section", "text", "gallery", "file", "separator", "actionRow", "button", "thumbnail", "select"] as const;
  return (
    <div style={{ position: "absolute", left: 40, top: 56, right: 40, bottom: 20 }}>
      <UiScale k={1.15}>
        <div style={{ display: "grid", gridTemplateColumns: "420px 1fr", gap: 40 }}>
          <div>
            <Label>tree rows · every kind (label + summary + tint)</Label>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {kinds.map((k) => (
                <TreeRowView key={k} kind={k} summary={k === "text" ? "# 🚀 Season 4 is live New worlds…" : ""} />
              ))}
            </div>
            <Label>selected · hover · presence (Kai) · issue · highlight</Label>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <TreeRowView kind="button" summary="Enter giveaway" selected />
              <TreeRowView kind="button" summary="Claim reward" hover />
              <TreeRowView kind="text" summary="# 🎮 Launch night — Friday!" presence={[CAST.kai]} />
              <TreeRowView kind="select" summary="platform" issue="error" />
              <TreeRowView kind="actionRow" summary="1 select" highlight={1} />
            </div>
          </div>
          <div>
            <Label>adders · normal / hover / pressed</Label>
            <div style={{ display: "flex", gap: 10 }}>
              <TreeAdder label="Add button" />
              <TreeAdder label="Add to container" hover />
              <TreeAdder label="Add button" pressed />
            </div>
            <Label>stat pills · normal · ok 0.5 · ok 1 · tick · near limit</Label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <StatPills components={5} chars={149} />
              <StatPills components={8} chars={201} ok={0.5} />
              <StatPills components={9} chars={202} ok={1} />
              <StatPills components={6} chars={165} tick={{ components: 0.5 }} />
              <StatPills components={36} chars={3620} />
            </div>
            <Label>action bar · the product's collapse ladder at 440 / 520 / 600 / 760 px (k 1.15)</Label>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <EditorActionBar width={440} />
              <EditorActionBar width={520} channel="announcements" hover="directory" />
              <EditorActionBar width={600} channel="announcements" glow={{ send: 1 }} />
              <EditorActionBar width={760} channel="announcements" channelOpen pressed="send" />
            </div>
            <Label>dock · alone · hover · Kai joining · joined — tooltip · toast · chip reveal</Label>
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <PresenceDock />
              <PresenceDock hover />
              <PresenceDock people={[CAST.aria, { ...CAST.kai, join: 0.5 }]} />
              <PresenceDock people={[CAST.aria, CAST.kai]} glow={0.8} />
              <InviteTooltip />
            </div>
            <div style={{ display: "flex", gap: 14, marginTop: 12, alignItems: "flex-start" }}>
              <TemplatePickToast />
              <div style={{ width: 460 }}>
                <AttachedPluginChip reveal={0.6} />
                <div style={{ height: 8 }} />
                <AttachedPluginChip glow={1} />
              </div>
            </div>
          </div>
        </div>
      </UiScale>
    </div>
  );
};

/** States sheet B — Discord: button kinds × states, the count restamp, reactions, select, wipe, gallery swap, dots. */
const PageStatesDiscord: React.FC = () => {
  const frame = useCurrentFrame();
  const kinds = ["primary", "secondary", "success", "danger", "link"] as const;
  return (
    <div style={{ position: "absolute", left: 40, top: 56, right: 40, bottom: 20 }}>
      <DiscordScale k={1.25}>
        <UiScale k={1.25}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40 }}>
            <div>
              <Label>DBtn · kinds × normal / hover / pressed / glow (valid ring + halo per kind)</Label>
              {kinds.map((k) => (
                <div key={k} style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                  <DBtn label={k} kind={k} emoji={k === "success" ? "🎁" : undefined} />
                  <DBtn label="hover" kind={k} hover />
                  <DBtn label="pressed" kind={k} pressed />
                  <DBtn label="glow" kind={k} glow />
                </div>
              ))}
              <Label>giveaway count restamp (label_with_count) · gold attach glow</Label>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <DBtn label="Enter giveaway" kind="primary" emoji="🎉" />
                <DBtn label="Enter giveaway" kind="primary" emoji="🎉" count={129} />
                <DBtn label="Enter giveaway" kind="primary" emoji="🎉" count={1234} />
                <DBtn label="Enter giveaway" kind="primary" emoji="🎉" glow glowColor={ATTACH_GOLD} />
              </div>
              <Label>reactions · mine / others / popping</Label>
              <div style={{ display: "flex", gap: 8 }}>
                <DReaction emoji="🎉" count={21} mine />
                <DReaction emoji="🔥" count={12} />
                <DReaction emoji="🔥" count={3} pop={0.5} />
              </div>
              <Label>thinking dots (frame-driven)</Label>
              <div style={{ display: "flex", gap: 30, color: "#fff" }}>
                {[0, 4, 8, 12, 16].map((f) => (
                  <ThinkingDots key={f} frame={frame + f} />
                ))}
              </div>
            </div>
            <div style={{ width: 640 }}>
              <Label>AI rewrite wipe (0.45) + gallery tile swap (0.5) + selected gallery</Label>
              <DContainer accent={COLORS_GREEN}>
                <DTextDisplay content={"# 🚀 Season 4 is live\n" + campaignState("final").body} highlight={{ text: campaignState("final").body, t: 0.45 }} />
                <DGallery swap={{ index: 1, to: "aurora", t: 0.5 }} selected={1} />
              </DContainer>
              <Label>select · open with options</Label>
              <div style={{ height: 220 }}>
                <DSelect
                  placeholder="Choose your platform…"
                  openP={1}
                  highlight={1}
                  options={[
                    { emoji: "🖥️", label: "PC" },
                    { emoji: "🎮", label: "Console", selected: true },
                    { emoji: "📱", label: "Mobile" },
                  ]}
                />
              </div>
            </div>
          </div>
        </UiScale>
      </DiscordScale>
    </div>
  );
};

const COLORS_GREEN = "#57F287";

/**
 * Cursors: every variant at rest and through a press (ages 0–8 of the
 * 10-frame ripple), then Kai's phone tap (member-touch) on the giveaway
 * button at the portrait master's 2× filming scale, before and after the
 * count restamps.
 */
const PageCursors: React.FC = () => {
  const variants: { v: CursorVariant; label: string; member?: boolean }[] = [
    { v: "arrow", label: "arrow" },
    { v: "touch", label: "touch" },
    { v: "member", label: "member (Kai)", member: true },
    { v: "member-touch", label: "member-touch (Kai)", member: true },
  ];
  const ages: (number | null)[] = [null, 0, 1, 2, 3, 5, 8];
  const tap = (age: number | null, count?: number) => (
    <div style={{ position: "relative", width: 420, height: 150 }}>
      <div style={{ position: "absolute", left: 20, top: 40, transform: "scale(2)", transformOrigin: "0 0" }}>
        <DiscordScale k={1}>
          <DBtn label="Enter giveaway" kind="primary" emoji="🎉" count={count} pressed={age !== null && age < 4} />
        </DiscordScale>
        <Cursor x={52} y={12} variant="member-touch" name={CAST.kai.name} color={CAST.kai.color} pressAge={age} flag="above-right" />
      </div>
    </div>
  );
  return (
    <div style={{ position: "absolute", left: 60, top: 70, right: 40, bottom: 20, fontFamily: INTER }}>
      <div style={{ display: "grid", gridTemplateColumns: `200px repeat(${ages.length}, 150px)`, rowGap: 6 }}>
        <div />
        {ages.map((a) => (
          <Label key={String(a)}>{a === null ? "rest" : `press age ${a}`}</Label>
        ))}
        {variants.map(({ v, label, member }) => (
          <React.Fragment key={v}>
            <Label>{label}</Label>
            {ages.map((a) => (
              <div key={String(a)} style={{ position: "relative", height: 110, background: "#313338", borderRadius: 10 }}>
                <Cursor x={60} y={50} variant={v} pressAge={a} name={member ? CAST.kai.name : undefined} color={member ? CAST.kai.color : undefined} />
              </div>
            ))}
          </React.Fragment>
        ))}
      </div>
      <Label>member-touch on the giveaway button at 2× (portrait), flag="above-right": tap on the left third · the ripple · after the restamp</Label>
      <div style={{ display: "flex", gap: 30 }}>
        {tap(0)}
        {tap(3, 129)}
        {tap(6, 129)}
      </div>
    </div>
  );
};

const PAGES: { title: string; C: React.FC }[] = [
  { title: "editor (600 pane, k 1.1) · stock template · Text editing", C: PageBuildText },
  { title: "editor · select added · add menu · pills ✓", C: PageBuildSelect },
  { title: "editor · AI assistant dock", C: PageAssistant },
  { title: "editor · ACTION panel · Add an action", C: PagePluginsModal },
  { title: "editor · attached chip · Send message", C: PageAttachSend },
  { title: "Message directory + pick toast", C: PageDirectory },
  { title: "Discord desktop landing", C: PageDiscord },
  { title: "Activity", C: PageActivity },
  { title: "portrait · editor (left: 2× as filmed)", C: PagePortraitEditor },
  { title: "portrait · AI sheet", C: PagePortraitAssistant },
  { title: "portrait · Add an action | Send message", C: PagePortraitSheets },
  { title: "portrait · Discord mobile | directory", C: PagePortraitDiscord },
  { title: "portrait · Activity (bar ladder, presence, dock)", C: PagePortraitActivity },
  { title: "states · app chrome", C: PageStatesApp },
  { title: "states · Discord", C: PageStatesDiscord },
  { title: "cursors · variants × press · Kai's phone tap", C: PageCursors },
];

/** Frames per page — render 0, 8, 16 … 120. */
export const SHOWCASE_PAGE_FRAMES = 8;
/** The Showcase composition's length: one page per SHOWCASE_PAGE_FRAMES. */
export const SHOWCASE_FRAMES = PAGES.length * SHOWCASE_PAGE_FRAMES;

export const Showcase: React.FC = () => {
  const frame = useCurrentFrame();
  const n = Math.min(PAGES.length - 1, Math.floor(frame / SHOWCASE_PAGE_FRAMES));
  const { C, title } = PAGES[n];
  return (
    <Stage>
      <C />
      <PageLabel n={n} title={title} />
    </Stage>
  );
};
