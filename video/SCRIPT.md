# DWEEB — Promo Video Script & Storyboard

**Runtime:** ~39.6s (1189 frames) @ 30fps · **Formats:** 1920×1080 master (`DweebPromo`) + 1080×1920 social cut (`DweebPromoVertical`)
**Voice:** Microsoft Edge neural `en-US-AndrewMultilingualNeural` (warm, conversational), +8% rate

A cinematic product walkthrough. Rather than a static camera showing each screen
flat, a **virtual camera** (`src/components/Camera.tsx`) lives in world space and
pushes in, pans, tracks and reframes onto whatever the voice-over is talking about
at that instant — guiding the eye the way a motion designer would. Kinetic
lower-thirds reinforce each line, an original beat-synced score builds underneath,
and UI sound effects (clicks, a success chime, type ticks) land on the actions.

| # | Scene | VO | Camera move |
|---|-------|----|-------------|
| 1 | **Open** | "This is DWEEB. It enhances your Discord messages." | A gentle push-in on the mascot as it lands, easing back to reveal the full lockup + tagline |
| 2 | **Build** | "Design rich, interactive messages right in your browser. Add text, media, and buttons, and watch a pixel-perfect preview update live." | Establish the app → push to favour the editor as the tree builds (preview always reacting on the right) → glide to the live preview and punch in → ease back to show both halves in sync |
| 3 | **Plugins** | "Then make them do things. Tickets, giveaways, self-roles, polls, forms — a whole library of plugins, one click away." | Establish the library → push toward **Tickets** as it's named → punch in on the click (✓ Added) → ease back out to reveal the whole grid. Grid shows only shipped plugins (Tickets · Giveaways · Self-roles · Polls · Forms · Quick replies) under a full-width **…and many more** banner — no vaporware tiles. |
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
- **Two aspect ratios, one film.** The same scenes render at 1920×1080 and at
  1080×1920. Each scene detects the portrait viewport (`height > width`) and
  swaps in a vertical set of camera keyframes (tighter zooms, recentred on the
  subject); captions move into the portrait safe-area and a few layouts (feature
  chips, plugin grid) reflow. Nothing is re-authored twice — only the framing.

## Production notes
- **VO**: `scripts/generate-audio.mjs` via `msedge-tts` neural voices, one CBR-mp3
  per line so exact durations drive the timeline.
- **Music**: the film plays a licensed royalty-free corporate-tech bed
  (`audio/paulyudin-tech-corporate-182507.mp3`). A fully synthesized, beat-synced
  original score (`music.wav`, chord turns aligned to the VO cuts) is also built
  by `npm run audio` and can be swapped in via `MUSIC` in `src/timeline.ts`.
- **SFX**: an original UI kit synthesized as raw PCM WAV — `click`, `chime`,
  `tick`, `whoosh`, `pop`, plus a `riser` and `impact` that land the CTA (since
  the stock bed has no built-in hit, `SceneMoreCta` sweeps the riser up into the
  CTA reveal and drops the impact on it). The whole kit regenerates offline (no
  TTS/network) with `npm run sfx` — see `scripts/audio-synth.mjs`.
- **Timeline**: scene cuts derive automatically from each line's start frame in
  `public/audio/manifest.json`, so re-recording the VO re-syncs every cut.

## Brand
- Blurple `#5865F2`, Discord green `#57F287`, dark canvas `#0e0f13`/`#1e1f22`/`#313338`
- Mascot robot (from `favicon.svg`), heavy "DWEEB" wordmark, Inter + JetBrains Mono

## Rebuild
```bash
cd video
npm install
npm run audio            # regenerate VO + music + SFX + manifest (needs network for TTS)
npm run sfx              # regenerate ONLY the SFX kit (offline, no TTS)
npm run studio           # preview in Remotion Studio (both compositions)
npm run render           # 16:9  -> out/dweeb-promo.mp4
npm run render:vertical  # 9:16  -> out/dweeb-promo-vertical.mp4
```
