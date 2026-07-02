import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, interpolate } from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot } from "../components/Camera";
import { Caption } from "../components/Caption";
import { Cursor } from "../components/Cursor";
import { AppWindow, ActionBar, AppTabs, TreeRow, InspectorCard, Field, ChannelRow } from "../components/AppUI";
import { DiscordShell, DMsg, DContainer, DHeading, DBody, DGallery, DBtn, DSelect } from "../components/DiscordUI";
import { Mascot } from "../components/Mascot";
import { AppBtn, Chip, TypeText, useSpr, cursorAt, Waypoint, PulseRing } from "../components/Bits";
import { voDelay, SCENES, CLICK, TICK, PING } from "../timeline";
import { COLORS } from "../theme";
import { INTER } from "../fonts";

/**
 * SEND — no separate send screen: name the message on the Message tab, hit the
 * same Send button that's always in the action bar, and the channel picker
 * drops down right there. One click, and the payoff lands in Discord.
 */
export const SceneSend: React.FC = () => {
  const frame = useCurrentFrame();
  const d = voDelay("send");

  const tName = d + 36; // "name the message" — typing starts
  const tSendClick = d + 100; // click Send in the action bar
  const tPop = tSendClick + 6; // the channel popover drops in place
  const tPickCh = d + 128; // "pick a channel"
  const tSendNow = d + 162; // "One click."
  const tSwap = tSendNow + 10;
  const tLand = tSwap + 22; // lands as "Posted." hits — then holds through the gap

  const popIn = useSpr(tPop, { damping: 15 });
  const swap = useSpr(tSwap, { damping: 17 });
  const land = useSpr(tLand, { damping: 14, stiffness: 110 });

  // World-space path (cursor renders INSIDE the camera): the identity card's
  // Name field (top of the Components pane), the action-bar Send button, the
  // #announcements row, then Send in the popover. Every leg gets ≥20 frames so
  // the pointer never snaps.
  const waypoints: Waypoint[] = [
    { f: d + 4, x: 640, y: 520 },
    { f: tName - 6, x: 300, y: 285 },
    { f: tName, x: 300, y: 285, press: true },
    { f: tName + 34, x: 350, y: 292 },
    { f: tSendClick - 6, x: 581, y: 142 },
    { f: tSendClick, x: 581, y: 142, press: true },
    { f: tPickCh - 6, x: 490, y: 256 },
    { f: tPickCh, x: 490, y: 256, press: true },
    { f: tSendNow - 8, x: 657, y: 417 },
    { f: tSendNow, x: 657, y: 417, press: true },
    { f: tSendNow + 10, x: 657, y: 417 },
  ];
  const cur = cursorAt(frame, waypoints);

  // ONE close framing holds through the whole in-editor sequence — the
  // identity card, the action-bar Send and the popover all live inside it, so
  // the camera never has to jump between beats. Then a slow zoom-out into the
  // Discord payoff.
  const shots: Shot[] = [
    { f: 0, x: 960, y: 540, s: 1.02 },
    { f: tName - 10, x: 490, y: 305, s: 1.36 },
    { f: tSendNow + 8, x: 490, y: 305, s: 1.36 },
    { f: tSwap + 24, x: 960, y: 540, s: 1.06 }, // zoom out through the swap
    { f: tLand + 34, x: 1010, y: 500, s: 1.24 }, // the message lands
    { f: tLand + 70, x: 960, y: 540, s: 1.1 },
  ];

  return (
    <AbsoluteFill>
      <Background glow="blurple" />
      <Camera shots={shots}>
        <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          {/* ── the editor — naming + sending happen in place ─────────────── */}
          <div
            style={{
              position: "absolute",
              opacity: 1 - swap,
              transform: `scale(${1 - swap * 0.06}) translateY(${swap * -24}px)`,
            }}
          >
            <AppWindow
              width={1760}
              height={950}
              leftWidth={560}
              left={
                <>
                  <ActionBar glowSend={frame > tSendClick - 18 && frame < tPop} />
                  <AppTabs />
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minHeight: 0 }}>
                    {/* message identity heads the Components pane */}
                    <InspectorCard title="Message · identity">
                      <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
                        <div
                          style={{
                            width: 44,
                            height: 44,
                            borderRadius: "50%",
                            overflow: "hidden",
                            background: COLORS.blurple,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                          }}
                        >
                          <Mascot size={38} glow={false} look={false} />
                        </div>
                        <Field label="Name — shown as the author" grow>
                          <TypeText text="Nebula Announcements" start={tName} cps={17} />
                        </Field>
                      </div>
                      <div style={{ fontFamily: INTER, fontSize: 12.5, color: COLORS.textSubtle }}>
                        Posts as a webhook — call it whatever you like, no bot account needed.
                      </div>
                    </InspectorCard>
                    <TreeRow icon="▤" label="Container" depth={0} />
                    <TreeRow icon="◧" label="Section" depth={1} />
                    <TreeRow icon="¶" label="Text" depth={2} />
                    <TreeRow icon="▦" label="Media Gallery" depth={1} />
                    <TreeRow icon="⬚" label="Buttons Row" depth={1} />
                    <TreeRow icon="▢" label="Button — Claim reward" depth={2} />
                    <TreeRow icon="▢" label="Button — Patch notes" depth={2} />
                    <TreeRow icon="▢" label="Button — Enter giveaway" depth={2} chip="Giveaway" chipColor="#f0b232" />
                    <TreeRow icon="☰" label="String Select" depth={1} />
                  </div>
                </>
              }
              right={
                <div style={{ width: "100%", maxWidth: 700, marginTop: 12 }}>
                  <DMsg author={frame > tName + 20 ? "Nebula Announcements" : "Webhook"} mascot>
                    <DContainer accent={COLORS.green}>
                      <DHeading icon="rocket">Season 4 is live</DHeading>
                      <DBody>
                        New maps, ranked rewards, and a fresh battle pass. Jump in and claim your
                        founder badge before the weekend.
                      </DBody>
                      <DGallery h={140} />
                      <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
                        <DBtn label="Claim reward" kind="success" emoji="🎁" />
                        <DBtn label="Patch notes" kind="primary" />
                        <DBtn label="Enter giveaway" emoji="🎉" />
                      </div>
                      <DSelect placeholder="Choose your platform…" />
                    </DContainer>
                  </DMsg>
                </div>
              }
              overlay={
                popIn > 0.01 ? (
                  /* the Send popover — drops from the action bar's Send button */
                  <div
                    style={{
                      position: "absolute",
                      left: 180,
                      top: 100,
                      width: 460,
                      background: COLORS.bgElevated,
                      border: `1px solid ${COLORS.borderStrong}`,
                      borderRadius: 16,
                      padding: 18,
                      boxShadow: "0 30px 90px rgba(0,0,0,0.6)",
                      fontFamily: INTER,
                      opacity: popIn,
                      transform: `translateY(${(1 - popIn) * -16}px) scale(${0.96 + popIn * 0.04})`,
                      transformOrigin: "top right",
                      display: "flex",
                      flexDirection: "column",
                      gap: 11,
                      zIndex: 10,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                      <span style={{ fontSize: 17.5, fontWeight: 800, color: COLORS.text }}>Send to Nebula Gaming</span>
                    </div>
                    <div style={{ fontSize: 12.5, color: COLORS.textSubtle, marginTop: -6 }}>
                      pick a channel — the webhook is handled for you
                    </div>
                    <ChannelRow
                      name="announcements"
                      sel={frame > tPickCh}
                      badge={frame > tPickCh ? "webhook ready" : undefined}
                      note="reuses its webhook"
                    />
                    <ChannelRow name="general" note="DWEEB creates one" />
                    <ChannelRow name="events" note="DWEEB creates one" />
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 2 }}>
                      <Chip icon="link" color="#9b84ee">
                        or paste a webhook URL
                      </Chip>
                      <div style={{ flex: 1 }} />
                      <AppBtn kind="primary" icon="send" size="sm" glow={frame > tSendNow - 16 && frame < tSwap}>
                        Send
                      </AppBtn>
                    </div>
                  </div>
                ) : undefined
              }
            />
          </div>

          {/* ── payoff: the message lands in Discord ─────────────────────── */}
          <div
            style={{
              position: "absolute",
              opacity: swap,
              transform: `scale(${0.94 + swap * 0.06})`,
            }}
          >
            <DiscordShell
              width={1620}
              height={910}
              header="announcements"
              headerKind="announcement"
              channels={[
                { cat: "INFO" },
                { name: "announcements", kind: "announcement", active: true },
                { name: "rules" },
                { cat: "COMMUNITY" },
                { name: "general" },
                { name: "events" },
              ]}
            >
              <div
                style={{
                  opacity: land,
                  transform: `translateY(${interpolate(land, [0, 1], [40, 0])}px)`,
                  paddingTop: 8,
                }}
              >
                <DMsg author="Nebula Announcements" mascot>
                  <div style={{ maxWidth: 700 }}>
                    <DContainer accent={COLORS.green}>
                      <DHeading icon="rocket">Season 4 is live</DHeading>
                      <DBody>
                        New maps, ranked rewards, and a fresh battle pass. Jump in and claim your
                        founder badge before the weekend.
                      </DBody>
                      <DGallery h={146} />
                      <div style={{ display: "flex", gap: 9 }}>
                        <DBtn label="Claim reward" kind="success" emoji="🎁" />
                        <DBtn label="Patch notes" kind="primary" />
                        <DBtn label="Enter giveaway" emoji="🎉" />
                      </div>
                      <DSelect placeholder="Choose your platform…" />
                    </DContainer>
                  </div>
                </DMsg>
              </div>
            </DiscordShell>
            <PulseRing x={810} y={210} start={tLand + 6} color={COLORS.green} />
          </div>

          {/* inside the camera → the tip stays locked to the UI through pans/zooms */}
          {frame < tSwap && frame > d && <Cursor x={cur.x} y={cur.y} pressed={cur.pressed} />}
        </AbsoluteFill>
      </Camera>

      {new Array(6).fill(0).map((_, i) => (
        <Sequence key={i} from={tName + i * 6} durationInFrames={5}>
          <Audio src={staticFile(TICK)} volume={0.32} />
        </Sequence>
      ))}
      <Sequence from={tSendClick} durationInFrames={10}>
        <Audio src={staticFile(CLICK)} volume={0.65} />
      </Sequence>
      <Sequence from={tPickCh} durationInFrames={10}>
        <Audio src={staticFile(CLICK)} volume={0.6} />
      </Sequence>
      <Sequence from={tSendNow} durationInFrames={10}>
        <Audio src={staticFile(CLICK)} volume={0.75} />
      </Sequence>
      <Sequence from={tLand + 4} durationInFrames={20}>
        <Audio src={staticFile(PING)} volume={0.8} />
      </Sequence>

      <Caption
        parts={["Name it, pick a channel —", { hl: "the webhook is handled for you." }]}
        delay={d + 18}
        out={SCENES.send.durationInFrames - 26}
        accent={COLORS.blurple}
      />
    </AbsoluteFill>
  );
};
