import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, interpolate } from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot } from "../components/Camera";
import { Caption } from "../components/Caption";
import { DiscordShell, DMsg, DContainer, DHeading, DBody, DGallery, DBtn, DMention } from "../components/DiscordUI";
import { PING, WHOOSH } from "../timeline";
import { voDelay } from "../timeline";
import { COLORS } from "../theme";
import { useSpr } from "../components/Bits";

/**
 * HOOK — a plain, wall-of-text announcement… then it SWAPS in place for the
 * same news as a rich Components V2 message. One message slot, one camera
 * framing: the viewer's eye never has to move, the message just gets better.
 */
export const SceneHook: React.FC = () => {
  const frame = useCurrentFrame();
  const d = voDelay("hook"); // VO: "…look like this. They could look like this."
  const turn = d + 68; // ≈ "They could look like this"
  const landed = turn + 10;

  const swapOut = useSpr(turn, { damping: 17, stiffness: 120 });
  const richIn = useSpr(landed, { damping: 15, stiffness: 110 });

  // One slot, one gentle push — the swap happens where the viewer is already
  // looking, so the camera never has to reframe.
  const shots: Shot[] = [
    { f: 0, x: 960, y: 460, s: 1.06 },
    { f: d + 28, x: 940, y: 420, s: 1.26 }, // slow push onto the message slot
    { f: landed + 46, x: 950, y: 470, s: 1.16 }, // breathe out to fit the rich card
  ];

  return (
    <AbsoluteFill>
      <Background glow="blurple" />
      <Camera shots={shots}>
        <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <DiscordShell
            width={1640}
            height={930}
            header="announcements"
            headerKind="announcement"
            channels={[
              { cat: "INFO" },
              { name: "announcements", kind: "announcement", active: true },
              { name: "rules" },
              { cat: "COMMUNITY" },
              { name: "general", unread: true },
              { name: "clips" },
              { name: "events" },
              { cat: "VOICE" },
              { name: "Staff Lounge", kind: "voice" },
            ]}
          >
            {/* one message slot — the plain post swaps out, the rich one swaps in */}
            <div style={{ position: "relative", height: 640, paddingTop: 6 }}>
              {/* the "before" — a tired plain-text post */}
              <div
                style={{
                  position: "absolute",
                  top: 6,
                  left: 0,
                  right: 0,
                  opacity: 1 - swapOut,
                  transform: `translateY(${swapOut * -34}px) scale(${1 - swapOut * 0.04})`,
                  filter: swapOut > 0.05 ? `blur(${(swapOut * 2.5).toFixed(2)}px)` : undefined,
                }}
              >
                <DMsg author="Moderator" app={false} avatarColor="#4e5058" time="Yesterday at 8:12 PM">
                  <DBody>
                    <DMention>@everyone</DMention> season 4 drops tomorrow!!! new maps + ranked rewards.
                    patch notes here → <span style={{ color: COLORS.dLink }}>nebula.gg/patch-4-0-full-notes</span>{" "}
                    and dont forget the giveaway form <span style={{ color: COLORS.dLink }}>forms.nebula.gg/s4</span>{" "}
                    (pls actually read it this time)
                  </DBody>
                </DMsg>
              </div>

              {/* the "after" — the same news, as a Components V2 message, in the SAME spot */}
              {richIn > 0.001 && (
                <div
                  style={{
                    position: "absolute",
                    top: 6,
                    left: 0,
                    right: 0,
                    opacity: richIn,
                    transform: `translateY(${interpolate(richIn, [0, 1], [42, 0])}px) scale(${interpolate(richIn, [0, 1], [0.96, 1])})`,
                    filter: richIn < 0.9 ? `drop-shadow(0 0 ${interpolate(richIn, [0, 1], [40, 0])}px ${COLORS.blurple}66)` : undefined,
                  }}
                >
                  <DMsg author="Nebula Announcements" mascot time="Today at 9:41 AM">
                    <div style={{ maxWidth: 700 }}>
                      <DContainer accent={COLORS.green}>
                        <DHeading icon="rocket">Season 4 is live</DHeading>
                        <DBody>
                          New maps, ranked rewards, and a fresh battle pass. Jump in and claim your
                          founder badge before the weekend.
                        </DBody>
                        <DGallery h={148} />
                        <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
                          <DBtn label="Claim reward" kind="success" emoji="🎁" />
                          <DBtn label="Patch notes" kind="primary" />
                          <DBtn label="Enter giveaway" emoji="🎉" />
                        </div>
                      </DContainer>
                    </div>
                  </DMsg>
                </div>
              )}
            </div>
          </DiscordShell>
        </AbsoluteFill>
      </Camera>

      <Sequence from={turn} durationInFrames={18}>
        <Audio src={staticFile(WHOOSH)} volume={0.3} />
      </Sequence>
      <Sequence from={landed + 4} durationInFrames={20}>
        <Audio src={staticFile(PING)} volume={0.7} />
      </Sequence>

      <Caption
        parts={["Same news.", { hl: "Very different message." }]}
        delay={landed + 6}
        accent={COLORS.green}
      />
    </AbsoluteFill>
  );
};
