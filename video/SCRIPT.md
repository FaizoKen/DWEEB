# DWEEB — Promo Video Script & Storyboard

**Runtime:** ~40.6s (1217 frames) · **Format:** 1920×1080 @ 30fps
**Voice:** Microsoft Edge neural "Andrew" (warm, conversational), +8% rate

A cinematic product walkthrough. Rather than a static camera showing each screen
flat, a **virtual camera** (`src/components/Camera.tsx`) lives in world space and
pushes in, pans, tracks and reframes onto whatever the voice-over is talking about
at that instant — guiding the eye the way a motion designer would. Kinetic
lower-thirds reinforce each line, an original beat-synced score builds underneath,
and UI sound effects (clicks, a success chime, type ticks) land on the actions.

| # | Scene | VO | Camera move |
|---|-------|----|-------------|
| 1 | **Open** | "This is DWEEB. For your… very important Discord messages." | A gentle push-in on the mascot as it lands, easing back to reveal the full lockup + tagline |
| 2 | **Build** | "Design rich, interactive messages right in your browser. Add text, media, and buttons, and watch a pixel-perfect preview update live." | Establish the app → push to favour the editor as the tree builds (preview always reacting on the right) → glide to the live preview and punch in → ease back to show both halves in sync |
| 3 | **Plugins** | "Then make them do things. Tickets, giveaways, self-roles, polls, forms — a whole library of plugins, one click away." | Establish the library → push toward **Tickets** as it's named → punch in on the click (✓ Added) → ease back out to reveal the whole grid |
| 4 | **Custom bot** | "Send it through your very own custom bot, straight into any channel." | Push in on the bot's identity + "your own custom bot" callout → reframe to the `#announcements` header (✓ Posted) → ease back for the whole message |
| 5 | **Interact** | "And your members get buttons that actually work." | Track the cursor to **Claim reward**, punch in on the click, pull back to frame the ephemeral "Reward claimed" reply |
| 6 | **More + CTA** | "Scheduling, A.I., sharing, and so much more — every feature, completely free. Just search dweeb on Google." | Drift through the feature chips → settle on the lockup → push into the Google search bar as **dweeb** types → ease back to rest |

## How the camera works
- Scenes lay their content out as a normal full-frame composition; `Camera`
  takes a list of keyframes `{ f, x, y, s }` (scene-relative frame, world point to
  centre, zoom) and eases between them. A little perpetual handheld drift keeps
  even "held" shots breathing, and fast moves pick up a touch of motion blur.
- Captions and lower-thirds render at screen level (outside the camera) so they
  stay pin-sharp while the world moves behind them.
- Detail shots are authored near scale 1 (with the app sized large in world
  space) so push-ins stay crisp rather than upscaling a rasterised layer.

## Production notes
- **VO**: `scripts/generate-audio.mjs` via `msedge-tts` neural voices, one CBR-mp3
  per line so exact durations drive the timeline.
- **Music + SFX**: original, royalty-free, synthesized as raw PCM WAV in the same
  script — a beat-synced score (chord turns aligned to the VO cuts, a riser into
  the CTA that lands on an impact) plus a UI kit (`click`, `chime`, `tick`,
  `whoosh`, `pop`).
- **Timeline**: scene cuts derive automatically from each line's start frame in
  `public/audio/manifest.json`, so re-recording the VO re-syncs every cut.

## Brand
- Blurple `#5865F2`, Discord green `#57F287`, dark canvas `#0e0f13`/`#1e1f22`/`#313338`
- Mascot robot (from `favicon.svg`), heavy "DWEEB" wordmark, Inter + JetBrains Mono

## Rebuild
```bash
cd video
npm install
npm run audio     # regenerate VO + music + SFX + manifest
npm run studio    # preview in Remotion Studio
npm run render    # -> out/dweeb-promo.mp4
```
