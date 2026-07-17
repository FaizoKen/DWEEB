# DWEEB promo film v5 - script and production guide

**Runtime:** 53.5 seconds (1,605 frames at 30 fps)

**Masters:** 1920x1080 `DweebPromo` and 1080x1920 `DweebPromoVertical`

**Voice:** Microsoft Edge neural `en-US-AndrewMultilingualNeural`, +8% rate

## Creative direction

The film follows one ordinary Discord message from plain text to a polished,
interactive message. Every feature advances that same artifact: choose a template,
refine it, ask the assistant for one addition, attach real behavior, send it, then
briefly show collaboration as an optional coda. The direct product URL closes the film.

`problem -> transformation -> product -> template -> refine -> enhance -> activate -> send -> collaborate -> CTA`

v5 hardens that story into three cinematic moves:

1. **The hook is a direct before/after.** A deliberately boring text-only Discord
   message sits on a neutral message-preview surface — no channel premise, chat noise,
   or announcement framing. On "turn it into something better" it transforms in place
   into the finished visual version, keeping the same author and facts while adding
   clear hierarchy, media, and actions.
2. **The product assembles around the message.** The reveal opens on the exact card the
   hook ended on (screen-position-matched on both sides of the dissolve in BOTH
   aspect ratios), then the editor physically builds itself around it - preview surface
   first, chrome drops in, builder pane slides in, tree populates.
3. **The editor act is one continuous take.** build → assistant → plugins → send are
   joined by *hold cuts*: camera framing, component tree, preview geometry, and open
   panels are pixel-matched on both sides of every boundary (each scene's first camera
   keyframe sits at the end of the 16-frame overlap so the visible cut lands on a
   static camera). Only real UI motion - panels docking, dialogs, the send morph -
   marks the passage between chapters.

## Voice-over and storyboard

Scene boundaries are derived from `public/audio/manifest.json`, so regenerating the
voice track automatically re-times the composition.

| #   | ID          | Voice-over                                                                                                              | Picture and story beat                                                                                                                                                              |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `hook`      | Here's a boring Discord message. Let's turn it into something better.                                                   | One plain text-only message transforms in place into a clear visual, interactive message. No channel or announcement setup distracts from the before/after.                         |
| 2   | `reveal`    | Meet DWEEB - the visual builder for Discord webhooks, embeds, and Components V2.                                        | Match cut: the finished card holds its screen position while the DWEEB editor assembles around it. Product identity lands as the cause of the transformation.                        |
| 3   | `templates` | Start with a ready-made template, then make every detail yours.                                                         | Three large starting points. Announcement is selected; its stock state (generic "Season 4 launch" title, one button) is exactly what the next scene personalizes.                    |
| 4   | `build`     | Shape it with real Discord components while a pixel-accurate preview updates live, and every limit is checked for you.  | Retitle the heading (the tree label types along with it), check the gallery, then add the reward button and platform select through the real Add-component flow. Ends "Ready to send". |
| 5   | `assistant` | Need another idea? Ask the AI assistant to add it directly to the message.                                              | Hold cut - same take. The dock slides in, a focused prompt asks for a punchier opening and a giveaway button, and the assistant edits the same draft.                                |
| 6   | `plugins`   | Then turn that button into a real giveaway. Visual plugins power tickets, roles, forms, and more.                       | The Giveaway plugin is ATTACHED (picker dialog → tree chip → the button glows live). No click here - clicking a preview inside the editor would mean nothing.                        |
| 7   | `send`      | Choose a channel and send. DWEEB finds or creates the webhook, then posts in one click.                                 | Channel-first send flow, the editor morphs into Discord, the exact message lands in `#announcements` - then the proof: Enter giveaway is clicked for real (confetti, ephemeral "You're entered", count ticks 128 → 129) and 🎉/🔥 reactions roll in. |
| 8   | `activity`  | Need another pair of hands? Invite your team, then build together inside Discord - in real time.                        | Start directly in the Activity editor, click its bottom-right invite/presence dock, then show teammates arrive and edit the same message live.                                      |
| 9   | `cta`       | Build better Discord messages. Start free today.                                                                         | Riser into an impact flash + camera recoil, an accurate product endline, then a Google-style search bar types “DWEEB Discord builder” with the G action at the far end.               |

## Visual and motion system

- The visual language is a restrained dark production design: aurora light, subtle
  floor grid, fine texture, controlled depth, and DWEEB's green/blurple accents.
- Product UI is intentionally enlarged and simplified per shot. It remains structurally
  faithful while prioritizing legibility at normal playback size.
- The same Nebula Season 4 campaign persists from template selection through Discord
  delivery. Shared components (`CampaignUI`) prevent copy or art from drifting between
  scenes; the build scene mirrors `CampaignPreview`'s exact geometry and tree order so
  its hold cut into the assistant scene is invisible.
- Continuity is causal, not just visual: the template ships with one button, the build
  scene adds the reward button and select through Add component (rows appear only when
  their components do), the AI adds the giveaway button, the plugin makes it work, and
  that exact message is what lands in Discord.
- Camera rules: hold-cut boundaries share identical framing (first keyframe at
  `f: TRANSITION_FRAMES` so the entrance overlap is static); held shots either contain
  a UI pane completely or exclude it completely - never slicing text mid-label; only
  fast moves pick up motion blur.
- Cursor rules: the pointer dwells on each control, then hops in a short confident
  12-18 frame move - never a multi-second crawl - and clicks land on
  render-verified pixel targets in both aspect ratios.
- Preview colors use the project's measured Discord tokens, including the sanctioned
  classic-dark canvas and container pairing.
- Captions are short editorial supers, not full transcripts. The send scene earns a
  second one ("Delivered - and noticed.") as the reactions land, pre-echoing the CTA.
- Both compositions use dedicated framing and layout branches. Portrait is composed for
  9:16 rather than presented as a simple center crop, and the hook/reveal match cut is
  aligned independently per aspect ratio.

## Audio

- Voice-over is generated one line at a time by `scripts/generate-audio.mjs`.
- The licensed music bed is trimmed to the manifest, faded, and ducked beneath every VO
  region by `scripts/audio-synth.mjs`.
- UI clicks, ticks, pops, chimes, message ping, riser, and CTA impact are synthesized
  locally. Their pseudo-random detail is seeded, so rebuilding SFX is deterministic.
- Sound only the structural turns: the hook makeover whoosh, an air whoosh + brand
  pop for the assembly, click/pop pairs for every real interaction, chimes for applied
  states, the message ping for delivery, soft pops for the reactions, then the riser
  into one impact (with its two-frame photographic flash) on the end card.
- `scripts/generate-audio.mjs --only=<ids>` re-records just those lines and reuses the
  existing mp3 for every other one (durations come from CBR byte math, so reused files
  re-manifest identically) - a single-line rewording cannot drift the rest of the
  film's verified timings by a frame.
- The final mix is set in `src/DweebPromo.tsx`; validate the rendered master with a
  loudness pass after any narration or score change.

## Product-accuracy anchors

- Component names and preview behavior follow `src/core/schema`, validation, and the
  project's measured Discord-preview conventions.
- Template concepts come from `src/data/presets.ts`.
- The AI assistant edits the live message directly; provider and model names are omitted.
- Plugin claims and categories follow `src/core/plugins/registry.json`.
- The send story follows DWEEB's real channel-first webhook flow.
- Activity is presented as an optional collaboration feature, not the main product.
- The CTA says `Start free`; it does not imply that paid quota tiers do not exist.

## Encoding and delivery

Remotion renders PNG intermediates and H.264 at CRF 17 with `yuv420p` and BT.709 color
metadata. This avoids JPEG generation loss and keeps browser/social-platform playback
widely compatible.

```bash
cd video
npm install
npm run audio             # regenerate VO, music, SFX, and manifest; TTS needs network
npm run music             # rebuild only music.wav from the existing manifest
npm run sfx               # deterministically rebuild the local SFX kit
npm run typecheck
npm run studio
npm run render            # out/dweeb-promo.mp4
npm run render:vertical   # out/dweeb-promo-vertical.mp4
npm run still             # out/cover.png (settled CTA frame)
```

For fast visual QA without a full render, `node scripts/stills.mjs <outDir> <comp|both>
<frame...>` bundles once and renders any set of frames as PNGs (used to verify cursor
targets, hold-cut boundaries, and both match cuts).
