# DWEEB intro film v6 — script and production guide

**Runtime:** 57.0 seconds (1,710 frames at 30 fps) · **Web cut:** 55.93 s (frames 12–1689)

**Masters:** 1920×1080 `DweebPromo` and 1080×1920 `DweebPromoVertical` (one codebase, two
first-class layouts)

**Voice:** Microsoft Edge neural `en-US-AndrewMultilingualNeural` (per-line rate, see below),
96 kbps mono, recorded with word boundaries

## Creative direction

One Season 4 campaign message travels from plain text to a working message in the server.
**The hook's AFTER card is the final delivered message** — the film promises it in the first
four seconds and delivers exactly that card into `#announcements`.

`boring message → makeover (the promise) → meet DWEEB → template → build → AI → plugin → send →
delivered and working → build together (coda) → CTA`

1. **The hook is a direct before/after** on a neutral "Message makeover" surface: bare plain
   Discord text (no box — real plain text has none) with a PLAIN chip, transforming under a light
   sweep into the finished interactive card (UPGRADED). No channel premise, no chat noise.
2. **The product assembles around the message.** The reveal opens on the exact card the hook
   ended on (a pixel-registered `match` crossfade in both aspects), the DWEEB lockup lands on the
   spoken "DWEEB", and the real editor builds itself around the card.
3. **The editor act is ONE continuous take**, from the reveal's settled editor to the landing in
   Discord: `reveal → templates → build → assistant → plugins → send` are all `hold` cuts, and the
   frames on both sides of each cut are pinned in `src/scenes/contracts.ts`. The Message directory
   is an *overlay on the editor* (as in the product), so "start from a template" happens inside
   the take.
4. **The payoff is real product behaviour**: the card flies (shared element) into
   `#announcements`, a member (Kai) clicks 🎉 Enter giveaway, and the public button restamps
   `(129)` and keeps ticking while 🎉/🔥 reactions roll in — the Giveaway plugin's actual
   type-7 update, not an invented ephemeral.
5. **Build Together is a short coda** on the *next* message (🎮 Launch night), started the way
   a team really starts an Activity: from the voice call it is already in. The staff (Aria, Kai,
   Mira, Theo) are in Nebula Gaming's 🔊 Staff Lounge; Aria clicks the call's rocket ("Start an
   Activity"), starts DWEEB from the Activities shelf (its real cover art), and after Discord's
   launch splash the Activity opens in the call — which invites everyone in it. ONE teammate,
   Kai, joins the editing (Free rooms allow 2 co-editors; Mira and Theo stay in the call).
6. **The vertical cut is portrait-native**, not a cropped landscape: a 540×960 portrait stage
   filmed by a locked camera (s = 2), a PortraitEditor (bar strip, live preview, builder bottom
   sheet; the AI, "Add an action" and "Send message" as sheets), a Discord-mobile landing, and
   Discord mobile's call → Activities sheet → full-screen Activity for the coda. Phone viewers
   see text at 2× the v5 size.

## Voice-over

Source of truth: `LINES` in `scripts/generate-audio.mjs`. Beats are anchored to the recorded
words (`at()` in `src/timeline.ts`), so a re-recorded line re-times its own picture.

| # | id | rate | start (f) | text |
|---|---|---|---|---|
| 1 | `hook` | +4% | 14 | Here's a boring Discord message. Let's turn it into something better. |
| 2 | `reveal` | +8% | 143 | Meet DWEEB: the visual Discord message builder for webhooks, embeds, and Components V2. |
| 3 | `templates` | +8% | 337 | Start with a ready-made template, then make every detail yours. |
| 4 | `build` | +8% | 468 | Shape it with real Discord components while a high-fidelity preview updates live, and every limit is checked for you. |
| 5 | `assistant` | +4% | 681 | Got another idea? Ask the AI assistant to add it directly to the message. |
| 6 | `plugins` | +8% | 854 | Then turn that button into a real giveaway. Visual plugins power tickets, roles, forms, and more. |
| 7 | `send` | +8% | 1077 | Pick a channel and send. DWEEB handles the webhook. The moment it lands, your giveaway is live. |
| 8 | `activity` | +8% | 1293 | Need another pair of hands? Invite your team, then build together inside Discord — in real time. |
| 9 | `cta` | +8% | 1512 | Build better Discord messages. Start free today. |

Lead-in 14 frames; the settled end card holds 90 frames after the last line.

## Scenes and beats

Scene windows (from the cut; each `Sequence` starts 16 frames earlier): hook 0–134 · reveal
135–328 · templates 329–459 · build 460–672 · assistant 673–845 · plugins 846–1068 · send
1069–1284 · activity 1285–1503 · cta 1504–1709.

| id | picture (both aspects unless noted) |
|---|---|
| `hook` | Tight on the bare plain message (landscape ≈45 px text; portrait centred, 40 px) with the PLAIN chip; on "Let's turn it…" the plain text and the rich card overlap under the light (no blank frames), the chip goes UPGRADED, and the camera settles on the match framing ≥16 f before the cut. Makeover SFX: whoosh + an in-key shimmer inside the VO pause. |
| `reveal` | Match crossfade; the editor assembles around the card (chrome, pane / portrait bar + builder sheet); the DWEEB lockup lands on "DWEEB"; tree rows populate; a light glints down the tree glyphs on "Components" and across the card on "V2"; then a still whole-window wide = cut A. |
| `templates` | Click the bar's Message directory icon on "Start"; the real directory overlay (portrait: sheet) opens; hover Welcome and Patch notes (portrait: swipe); "Use this template →" on Announcement on "template"; the real pick toast; the overlay closes onto the editor now holding the stock template (📢 Announcement, one Link button). |
| `build` | Text row → inline TextInlineEditor → "📢 Announcement" drag-selected and "🚀 Season 4 is live" typed (tree summary, counter and preview update per key); Media gallery → drop zone → the Season 4 hero swaps in; "+ Add button" → 🎁 Claim reward pops in the same frame as its row; "+ Add to container" → the real add menu (Buttons & menus ▸ Options menu) → Action row + Options menu + the select; stat pills tick 5→5→6→8 and flash green with a halo on "checked". Ends on cut B. |
| `assistant` | The AI dock (portrait: sheet) slides in; the prompt "Make the opening punchier and add a giveaway button." is typed in the composer, sent, "thinking" dots, then on "add it directly" the reply and the "✦ Updated the message · Undo" chip land as the body gets a green wipe and the primary 🎉 Enter giveaway pops with a glow. |
| `plugins` | The dock leaves; the giveaway row's inline editor opens its ACTION panel ("Browse plugins · 25"); "Add an action" (landscape: pushed in on the dialog) — Giveaway clicked right after "giveaway", Tickets / Self Role / Modal Form glint on "tickets / roles / forms", the named row lights on "and more"; the attached chip "Giveaway · Founder badges · 3 winners · via Giveaway" lands as the preview button glows gold. |
| `send` | Send → the "Send message" panel (tabs Send · Update · Restore · Share link · JSON · Code · About, Send now · Schedule, channel-first list); `#announcements` picked on "Pick a channel" (the toolbar chip follows); "✓ Webhook ready · reusing it" on "handles the webhook"; the card flies into `#announcements` (portrait: Discord mobile) and lands with the delivery ping; Kai's member pointer (portrait: a named tap) clicks 🎉 Enter giveaway; the label restamps "(129)" and ticks on with the reactions. |
| `activity` | Dip into Discord's 🔊 Staff Lounge call: the channel list with its four members (Theo muted), Voice Connected, the call tiles (Mira, then Kai talking) and the call's control bar. On "pair" the pointer rests on the rocket ("Start an Activity" tooltip), clicks it on "hands"; the Activities shelf opens with DWEEB's cover; DWEEB is started on "Invite"; Discord's launch splash (the Activity's background art, icon, loading bar) hands over to the Activity in the call's focused tile, the participants settling into a strip below. Kai joins on the pause after "team" (dock pop + the Activity badge on his row) as the camera pushes into the Activity until it fills the frame under the channel header; his outline lands on the Text row, he types " — Friday!", you add "💡 Suggest a game". Portrait: Discord mobile's call, the Activities sheet, then the Activity full-screen, on the locked camera. |
| `cta` | Hard cut on the hit (frame 1504): impact, a photographic flash and a recoil as BUILD slams in; BETTER / DISCORD / MESSAGES. each 4 frames before their word; the mascot; a Google-style search bar types "DWEEB Discord builder" with key ticks; the G is pressed as the line ends (1611); the result card — "DWEEB — Visual Discord message builder" / **dweeb.faizo.net** · Start free — lands on the score's outro crash (1626); the settled card holds to the fade. |

## Captions (burned-in editorial supers)

One top-level `CaptionTrack` (outside every scene transition) renders every cue in ABSOLUTE
frames; each scene exports its cues as `captions`. Label = the feature, body = the benefit.
Landscape plates sit bottom-left with their bottom edge 96 px above the frame (clear of a web
player's native controls); portrait plates sit in the top band (y ≈ 236–390). Touching cues
share one plate (the text crossfades, the plate morphs). `npm run qa:captions` checks reading
time (0.3 s/word + 0.5 s fully legible) and overlaps.

| cue | aspect | frames | text |
|---|---|---|---|
| hook-before | both | 6–76 | BEFORE · Just plain text. |
| hook-after | L 92–164 · V 76–149 | | AFTER · Clear. Visual. Interactive. |
| reveal | both | 203–335 | MEET DWEEB · The visual Discord message builder. |
| templates | both | 370–480 | TEMPLATES · Start polished. Make it yours. |
| build | both | 481–716 | LIVE PREVIEW · Real components. Every limit checked. |
| assistant | both | 724–874 | AI ASSISTANT · Ask. Apply. Keep building. |
| plugins | both | 908–1024 | VISUAL PLUGINS · Buttons that actually work. |
| send-webhook | both | 1079–1187 | WEBHOOK HANDLED · Pick a channel. Hit send. |
| send-server | both | 1191–1289 | IN YOUR SERVER · Posted — and the giveaway is live. |
| activity | both | 1289–1492 | DISCORD ACTIVITY · Edit together, inside Discord. |

The narration itself ships separately as WebVTT captions for the web intro (see Delivery).

## Continuity contracts (the invisible cuts)

- `src/scenes/contracts.ts` pins the editor act: `EDITOR_L` (landscape window 1680×900 at
  world (120, 90), 600-px pane at k 1.1, preview dk 1.12, preview column 700), `EDITOR_V`
  (portrait k 1.07 / bar 1.04 / dk 1), the canonical framings `EDITOR_WIDE_L` (s 1.1) and
  `PORTRAIT_CAM` (s 2), the background glow, and the boundary states `CUT_A` (reveal→templates:
  the final message) and `CUT_B` (build→assistant: retitled + reward + select). At a boundary:
  static camera through the 16-frame overlap, no selection / editor / overlay / cursor, pills
  neutral, scrolls at 0.
- **Portrait sheet detents**: the builder sheet's edge must fall in a gap of the card, never
  through a component — 484 at cut A (between the final card's two button rows), 470 from the
  template pick on (the stock-bodied states' gallery gap); the templates scene moves the detent
  while the directory sheet covers the editor. Measurements are in `contracts.ts`.
- Scenes after cut B render through ONE frame component per aspect (`src/scenes/plugins/act.tsx`
  `LandscapeAct` / `PortraitAct`), so identical props give identical pixels.
- The hook and reveal share `src/scenes/hook/stage.tsx`; the match is registered to 0 moved
  blocks in both aspects.
- `npm run qa:cuts` compares the frames on both sides of every cut through `SceneProbe` (one
  scene alone, no transitions): holds must be identical, the match must register.

## Visual and motion system

- Transitions (`src/DweebPromo.tsx`): `match` into the reveal, `hold` for templates → send,
  `dip` (7 f out to the stage colour, 9 f in) into the activity, `cut` into the end card.
  Invisible layers are not mounted — nothing in a scene may be scheduled before its first visible
  frame.
- Camera (`src/components/Camera.tsx`): gentle default ease, a snappier `RECOIL_EASE` for the CTA;
  blur only from real on-screen velocity, on an unscaled layer, capped ~3 px, zero on static
  frames. Moves carrying readable text stay ≤ ~25 px/frame (the whole film peaks at 23.9).
- Framing rule: a held shot contains a pane / card / dialog completely or excludes it — never
  slices text mid-label (a scrim-dimmed background behind a modal is background).
- Cursor (`Cursor.tsx`): arrow (landscape), touch dot (portrait), member arrow / member touch with
  a name flag (Kai). Press window `[f, f+4)` with a ripple after the press; the CLICK plays on
  `f`; aims come from the layout geometry helpers, never hand-measured pixels.
- Captions and the film-level SFX live above the scenes, in absolute frames.
- Colours are the project's measured Discord tokens (classic-dark canvas #313338 with its
  container pair #2b2d31); the Nebula server icon is the author avatar; emoji in headings.

## Product-accuracy anchors

Every on-screen string and flow is checked against the app source (reports in the v6 work notes):
tree labels / glyphs / summaries follow `src/core/schema/metadata.ts` and `ComponentTree.tsx`
("Action row", "Options menu", "Media gallery"; the add menu's "Buttons & menus"); the message is
a VALID Components V2 tree whose stat pills equal the product's own `countComponents` /
`countCharacters` (stock 5·149 → final 9·202); "Patch notes" is a Link button; the action bar,
stat pills, AI panel ("AI Assistant", "Free AI · 1/8 today", "✦ Updated the message · Undo"),
"Add an action" ("Search 25 actions…", 8 interactive + 17 link services from
`src/core/plugins/registry.json`), the Send dialog, the Message directory ("Search 36
templates…", the real pick toast) and the Activity bar / dock follow their components; the
giveaway label format is `{label} ({count})` (`plugins/giveaway/src/discord.rs`).

Accepted film compressions: new buttons/selects arrive already styled; the drop zone swaps the
hero (the product adds an item); the SendConfirm step is skipped; the channel rows' notes
("reusing it" / "Will create one") are a film addition; the portrait Activity keeps Kai's avatar
on the tree row; the portrait AI sheet grows 17 units in the frame the AI's rewrite shortens the
body, so its edge stays in the card's gap (the product's phone card has a fixed height). Discord's
own surfaces in the coda (call view, Activities shelf, launch splash) are stylised in the send
scene's Discord idiom, not measured; the shelf shows only DWEEB (no third-party Activity is
depicted), with its real cover and background art (`public/activity/`, copied from the web app's
`public/activity-assets/`).

## Audio

- **VO** (`npm run audio`): reuses existing takes by default; `--rerecord=<ids|all>` records
  fresh ones with word boundaries (`<id>.words.json` sidecars). The manifest (v2) carries text,
  rate, hashes, durations, words, the speech span, a per-line loudness gain (to −21 LUFS) and the
  music plan. VO, sidecars, manifest and SFX are committed; `npm run audio -- --words` prints the
  word table.
- **Music**: Pixabay #182507 "Tech Corporate" by paulyudin (Pavel Yudin), kept in the gitignored
  `assets-src/` — never commit it or `public/audio/music.wav`. `scripts/lib/music-edit.mjs` makes
  ONE bar-accurate, manifest-anchored edit (118 BPM): main A enters with the build line (467), a
  splice bar 22 → 29 at 1321 plays the breakdown's closing bars and riser under the activity, the
  main-B drop lands exactly on the CTA hit (1504), and the outro crash lands at 1626. The bed is
  ducked −6 dB under real speech spans (120 ms attack, 400 ms release). `npm run music -- --plan`
  prints the edit; a re-record that breaks the fit throws with the frames to move.
- **SFX** (`npm run sfx`, deterministic): clicks / pops / ticks with 3 variants each, an in-key
  chime (C♯6→F♯6), a shimmer for the makeover, the delivery ping (delivery only), soft and full
  whooshes, the riser, and an impact that survives phone speakers. Levels come from `VOL` in
  `src/audio.ts`, lengths from `SFX_FRAMES`. Sounds that ring across a cut or belong to a
  transition live on the film-level track `src/sfxTrack.tsx` (absolute frames): reveal whoosh
  119, build chime 658, plugins chime 1055, activity whoosh 1269, riser 1468 → 1504.
- **Mastering** (`npm run master -- out/x.mp4 --audio out/x.wav`): static gain + a 4×-oversampled
  true-peak limiter — promo masters −14 LUFS / ≤ −1 dBTP (AAC 256k, zero A/V lag), and a −16 LUFS
  PCM for the web cuts.

## Tooling and QA

- `npm run stills -- <outDir> <DweebPromo|DweebPromoVertical|both|SceneProbe|SceneProbeVertical|Showcase> <specs…> [--scale 0.5] [--sheet]`
  — specs: `120`, `100-140:5`, `build+34` (scene-local), `@build` (the cut), `build$` (last
  visible frame). One browser per run; reports console errors; cleans its temp folders.
- `npm run qa:cuts`, `npm run qa:captions`, `npm run qa:loudness -- <file> --target -14`,
  `npm run qa:bench`, `npm run typecheck`.
- Fonts (Inter v18, JetBrains Mono v20, OFL) are self-hosted in `public/fonts`, so renders never
  touch the network. `src/fonts.ts` holds rendering on them with a module-level `delayRender`,
  which only works because `src/index.ts` imports `remotion/no-react` FIRST: Remotion's render
  entry otherwise resets the delayRender timeout registry after the root has loaded, and the
  orphaned timer kills a full render one timeout in (stills finish before it fires).

## Delivery

```bash
cd video
npm install
npm run audio              # offline: reuse takes, rebuild music + SFX + manifest
npm run typecheck
npm run render             # out/dweeb-promo.mp4 + lossless out/dweeb-promo.wav
npm run render:vertical    # out/dweeb-promo-vertical.mp4 + .wav
npm run master -- out/dweeb-promo.mp4 --audio out/dweeb-promo.wav
npm run master -- out/dweeb-promo-vertical.mp4 --audio out/dweeb-promo-vertical.wav
npm run deliver:web        # ../public/media: web cuts, posters, captions
npm run still              # out/cover.png (settled end card, frame 1650)
```

`npm run deliver:web` writes the in-app intro to `../public/media/`: `intro.av1.mp4` +
`intro.mp4` (1920×1080 AV1 / H.264), `intro-vertical.av1.mp4` + `intro-vertical.mp4`
(1080×1920 AV1 / 720×1280 H.264), keyframes on the scene cuts, the −16 LUFS web mix, posters
from the settled end card, and `intro.en.vtt` (narration captions from the word timings). The
web cuts skip the master's black fade-in/out so the modal never flashes or rests on black. Each
H.264 cut is pinned to the level `WelcomeVideo.tsx` declares (High@4.0 landscape, High@3.1
vertical), and every delivered file is checked to decode sample-aligned with its source audio.
`--only=landscape|vertical|vtt` and `--codec=av1|h264` redo part of a delivery.
`src/features/welcome/WelcomeVideo.tsx` serves them as codec-tagged `<source>`s (AV1 on phones
only when MediaCapabilities says it is power-efficient) with the captions track off by default,
tries audible playback on the explicit open and falls back to muted + "Tap for sound". The
files stay out of the service-worker precache.

## Needs a human listen

The mix was verified by measurement and frame arithmetic only: the splice at ≈44.0 s (frame
1321), the outro crash under the end-card chime (1616–1626), the chimes' tails against the next
scene's first click (682, 1078), and the typing ticks under the VO.
