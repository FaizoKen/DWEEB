import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, interpolate } from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot, useVertical } from "../components/Camera";
import { Caption } from "../components/Caption";
import { Cursor } from "../components/Cursor";
import { AppWindow, ActionBar, AppTabs, ChannelRow } from "../components/AppUI";
import { CampaignPreview, CampaignTree } from "../components/CampaignUI";
import { DBody, DiscordShell, DMsg } from "../components/DiscordUI";
import { AppBtn, Chip, Confetti, CountUp, useSpr, cursorAt, Waypoint } from "../components/Bits";
import { voDelay, SCENES, CLICK, POP, PING, CHIME } from "../timeline";
import { COLORS } from "../theme";
import { INTER } from "../fonts";

/** World position of "Enter giveaway" inside the POSTED Discord message. */
const EG_BTN = { x: 979, y: 514 };

/** A Discord reaction pill popping onto the freshly posted message. */
const Reaction: React.FC<{
  emoji: string;
  to: number;
  at: number;
  reveal: number;
}> = ({ emoji, to, at, reveal }) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      padding: "5px 12px",
      borderRadius: 9,
      background: "rgba(88,101,242,.18)",
      border: `1px solid ${COLORS.blurple}88`,
      color: COLORS.dText,
      fontFamily: INTER,
      fontSize: 15,
      fontWeight: 700,
      opacity: Math.min(1, reveal * 1.4),
      transform: `scale(${0.5 + Math.min(1, reveal) * 0.5})`,
      transformOrigin: "center left",
    }}
  >
    <span style={{ fontSize: 17 }}>{emoji}</span>
    <CountUp from={1} to={to} start={at + 4} duration={24} />
  </div>
);

/**
 * Channel-first delivery, then the payoff in the real server: the exact card
 * lands in Discord, the giveaway button is clicked FOR REAL (ephemeral
 * confirmation, entrant count ticks up), and reactions start rolling in.
 */
export const SceneSend: React.FC = () => {
  const frame = useCurrentFrame();
  const vert = useVertical();
  const d = voDelay("send");

  const tSendClick = d + 16;
  const tPopover = tSendClick + 6;
  const tPick = d + 52;
  const tPost = d + 92;
  const tMorph = tPost + 8;
  const tLand = tMorph + 14;
  const tGive = d + 134;
  const tEntered = tGive + 6;
  const tReact1 = d + 150;
  const tReact2 = d + 157;

  const popIn = useSpr(tPopover, { damping: 17, stiffness: 155 });
  const morph = useSpr(tMorph, { damping: 22, stiffness: 130 });
  const land = useSpr(tLand, { damping: 15, stiffness: 145 });
  const enteredIn = useSpr(tEntered, { damping: 16, stiffness: 165, mass: 0.6 });
  const react1 = useSpr(tReact1, { damping: 13, stiffness: 190, mass: 0.5 });
  const react2 = useSpr(tReact2, { damping: 13, stiffness: 190, mass: 0.5 });

  // Dwell at each control, then hop in a short confident move — never a crawl.
  const waypoints: Waypoint[] = [
    { f: d + 2, x: 920, y: 620 },
    { f: tSendClick - 20, x: 920, y: 620 },
    { f: tSendClick - 4, x: 582, y: 167 },
    { f: tSendClick, x: 582, y: 167, press: true },
    { f: tPick - 18, x: 582, y: 167 },
    { f: tPick - 4, x: 495, y: 280 },
    { f: tPick, x: 495, y: 280, press: true },
    { f: tPost - 20, x: 495, y: 280 },
    { f: tPost - 4, x: 705, y: 451 },
    { f: tPost, x: 705, y: 451, press: true },
    { f: tMorph, x: 705, y: 451 },
    // second appearance — inside Discord, heading for the live button
    { f: tLand + 2, x: 1150, y: 700 },
    { f: tLand + 6, x: 1150, y: 700 },
    { f: tGive - 4, x: EG_BTN.x, y: EG_BTN.y },
    { f: tGive, x: EG_BTN.x, y: EG_BTN.y, press: true },
    { f: tGive + 10, x: EG_BTN.x, y: EG_BTN.y },
  ];
  const cursor = cursorAt(frame, waypoints);
  const cursorVisible =
    (frame >= d && frame < tMorph) || (frame >= tLand + 2 && frame < tGive + 22);

  // First keyframe continues the plugins scene's final framing (hold cut).
  const shots: Shot[] = vert
    ? [
        { f: 18, x: 430, y: 400, s: 1.68 },
        { f: tPost, x: 470, y: 410, s: 1.68 },
        { f: tLand + 16, x: 916, y: 500, s: 1.42 },
      ]
    : [
        { f: 18, x: 830, y: 465, s: 1.12 },
        { f: tPopover + 10, x: 760, y: 430, s: 1.16 },
        { f: tPost, x: 730, y: 425, s: 1.18 },
        { f: tLand + 16, x: 980, y: 485, s: 1.14 },
      ];

  return (
    <AbsoluteFill>
      <Background glow="blurple" />
      <Camera shots={shots}>
        <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div
            style={{
              position: "absolute",
              opacity: 1 - morph,
              transform: `scale(${1 - morph * 0.035}) translateY(${-18 * morph}px)`,
              filter: morph > 0.15 ? `blur(${morph * 1.6}px)` : undefined,
            }}
          >
            <AppWindow
              width={1680}
              height={900}
              leftWidth={520}
              left={
                <>
                  <ActionBar glowSend={frame >= tSendClick - 14 && frame < tPopover + 8} />
                  <AppTabs />
                  <CampaignTree selectedGiveaway attached />
                </>
              }
              right={
                <div
                  style={{
                    width: "100%",
                    display: "flex",
                    justifyContent: "center",
                    marginTop: 18,
                  }}
                >
                  <CampaignPreview scale={0.98} />
                </div>
              }
              overlay={
                popIn > 0.01 ? (
                  <div
                    style={{
                      position: "absolute",
                      left: 178,
                      top: 94,
                      width: 470,
                      padding: 18,
                      display: "flex",
                      flexDirection: "column",
                      gap: 11,
                      borderRadius: 17,
                      background: "linear-gradient(145deg, #1b1e25, #13161c)",
                      border: `1px solid ${COLORS.borderStrong}`,
                      boxShadow: "0 34px 100px rgba(0,0,0,.66)",
                      opacity: popIn,
                      transform: `translateY(${(1 - popIn) * -14}px) scale(${0.97 + popIn * 0.03})`,
                      transformOrigin: "top right",
                      fontFamily: INTER,
                      zIndex: 18,
                    }}
                  >
                    <div>
                      <div style={{ color: COLORS.text, fontWeight: 850, fontSize: 18 }}>
                        Send to Nebula Gaming
                      </div>
                      <div style={{ color: COLORS.textSubtle, fontSize: 12.5, marginTop: 4 }}>
                        Choose the channel. DWEEB handles the webhook.
                      </div>
                    </div>
                    <ChannelRow
                      name="announcements"
                      sel={frame >= tPick}
                      badge={frame >= tPick ? "webhook ready" : undefined}
                      note="reuses its webhook"
                    />
                    <ChannelRow name="general" note="creates one" />
                    <ChannelRow name="events" note="creates one" />
                    <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 2 }}>
                      <Chip icon="clock" color={COLORS.textMuted}>
                        Send now
                      </Chip>
                      <div style={{ flex: 1 }} />
                      <AppBtn
                        kind="primary"
                        icon="send"
                        size="sm"
                        glow={frame >= tPost - 14 && frame < tMorph}
                      >
                        Send
                      </AppBtn>
                    </div>
                  </div>
                ) : undefined
              }
            />
          </div>

          <div
            style={{
              position: "absolute",
              opacity: morph,
              transform: `scale(${0.965 + morph * 0.035})`,
            }}
          >
            <DiscordShell
              width={1540}
              height={850}
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
                  width: 760,
                  paddingTop: 8,
                  opacity: land,
                  transform: `translateY(${interpolate(land, [0, 1], [30, 0])}px)`,
                }}
              >
                <CampaignPreview
                  time="Today at 9:41 AM"
                  giveawayGlow={frame >= tGive - 10 && frame < tGive + 16}
                />
                {/* reactions row reserves its height so the ephemeral reply
                    below never shifts when the pills pop in */}
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    marginTop: 12,
                    marginLeft: 59,
                    height: 34,
                    alignItems: "center",
                  }}
                >
                  {react1 > 0.01 && <Reaction emoji="🎉" to={24} at={tReact1} reveal={react1} />}
                  {react2 > 0.01 && <Reaction emoji="🔥" to={12} at={tReact2} reveal={react2} />}
                </div>
                {/* the plugin answers the click privately — the button is real */}
                {enteredIn > 0.01 && (
                  <div
                    style={{
                      marginTop: 10,
                      opacity: Math.min(1, enteredIn * 1.3),
                      transform: `translateY(${(1 - enteredIn) * 16}px)`,
                    }}
                  >
                    <DMsg author="DWEEB" mascot time="Today at 9:42 AM" ephemeral>
                      <DBody size={15.5}>
                        🎉 You’re entered!{" "}
                        <span style={{ color: "#fff", fontWeight: 750 }}>
                          <CountUp from={128} to={129} start={tEntered + 4} duration={12} />
                        </span>{" "}
                        people have joined this giveaway.
                      </DBody>
                    </DMsg>
                  </div>
                )}
              </div>
            </DiscordShell>
          </div>

          <Confetti x={EG_BTN.x} y={EG_BTN.y} start={tGive + 2} count={22} />
          {cursorVisible && (
            <Cursor x={cursor.x} y={cursor.y} pressed={cursor.pressed} size={30} />
          )}
        </AbsoluteFill>
      </Camera>

      <Sequence from={tSendClick} durationInFrames={10}>
        <Audio src={staticFile(CLICK)} volume={0.64} />
      </Sequence>
      <Sequence from={tPopover} durationInFrames={12}>
        <Audio src={staticFile(POP)} volume={0.46} />
      </Sequence>
      <Sequence from={tPick} durationInFrames={10}>
        <Audio src={staticFile(CLICK)} volume={0.62} />
      </Sequence>
      <Sequence from={tPost} durationInFrames={10}>
        <Audio src={staticFile(CLICK)} volume={0.76} />
      </Sequence>
      <Sequence from={tLand + 4} durationInFrames={22}>
        <Audio src={staticFile(PING)} volume={0.82} />
      </Sequence>
      <Sequence from={tGive} durationInFrames={10}>
        <Audio src={staticFile(CLICK)} volume={0.7} />
      </Sequence>
      <Sequence from={tEntered + 2} durationInFrames={22}>
        <Audio src={staticFile(CHIME)} volume={0.46} />
      </Sequence>
      <Sequence from={tReact1} durationInFrames={10}>
        <Audio src={staticFile(POP)} volume={0.36} />
      </Sequence>
      <Sequence from={tReact2} durationInFrames={10}>
        <Audio src={staticFile(POP)} volume={0.3} />
      </Sequence>

      <Caption
        label="Webhook handled"
        parts={["Pick a channel.", { hl: "Posted." }]}
        delay={d + 6}
        out={tMorph - 8}
        accent={COLORS.blurple}
      />
      <Caption
        label="In the server"
        parts={["Live buttons.", { hl: "Real entries." }]}
        delay={tEntered + 4}
        out={SCENES.send.durationInFrames - 5}
        accent={COLORS.green}
      />
    </AbsoluteFill>
  );
};
