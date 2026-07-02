# DWEEB — Launch Film v3.1: Script & Storyboard

**Runtime:** 1:17 (2,304 frames) @ 30fps, 1920×1080 (`DweebPromo`) — the exact
frame count comes from `public/audio/manifest.json` after `npm run audio`.
**Voice:** Microsoft Edge neural `en-US-AndrewMultilingualNeural`, +6% rate
**Goal:** one clear story a first-time viewer can follow with zero Discord-admin
context: *problem → product → build → describe it → make it do things → send →
templates → build together → CTA*. Nine scenes; every name, label and behavior
is still lifted from the codebase (registry.json, README, docs/, SendPanel).

v3.1 flow fixes over v3 (all in service of "clean, easy, simple"):

- **Hook**: the plain post *swaps in place* for the rich message — one message
  slot, one framing, the viewer's eye never moves.
- **Build**: the camera *follows* the narration with slow glides — tree while
  blocks land, across to the preview, onto the inspector fix (the cursor
  selects the flagged button and clicks into the Label field) — then zooms out
  so the whole editor is seen in sync. Gentle, never whipping between panes.
- **Assistant**: its own scene; the panel docks to the far right exactly like
  the real app (`AiChatPanel`). No model or provider names anywhere.
- **Plugins**: continues the assistant's shot — a matched cut (`hold`
  transition + shared camera framing + synced handheld-drift phase) where the
  AI chat simply slides closed, then the flagged button is selected and the
  "Attach a plugin" picker opens in-editor with all 7 plugins; Giveaway is
  attached and the chip lands on the button row.
- **Send**: naming and sending happen *in place on the Components pane* — the
  identity card (name/avatar) heads the pane above the tree (identity lives in
  the real `ComponentTree`; there is no separate Message tab), and the
  action-bar Send button drops the channel popover right under itself. One
  fixed close framing covers the name field, Send and the popover, so the
  camera never jumps between the three beats.
- **Restore scene removed** (users get editing; it cost 7 seconds).
- **Templates moved last** and made a montage: the cursor flips down the
  gallery while a big stage previews each template's actual message live.
- **Activity**: starts where it really starts — a voice channel; the Activity
  is launched from the call, the embedded builder is stripped to tree +
  preview, and the publish controls ("posting to #events" + Post→Update) live
  in the activity header like the real app.
- **CTA**: no more deal-with-it shades on the mascot; feature tags instead of
  the free/no-account chips; the search bar is a proper Google bar (G logo,
  centered "dweeb bot"); the licence fine print is gone.

A virtual camera (`components/Camera.tsx`) lives in world space; every scene
pushes in close on the beat being narrated and pulls wide before the cut so the
whole editor is understood. All moves are slow eases — arrival always precedes
the click, so clicks stay crisp. Kinetic captions reinforce each line, an
original beat-synced score turns with every cut, and a synthesized UI-SFX kit
(clicks, ticks, chimes, whooshes, a riser → impact into the CTA) lands on the
actions.

## Voice-over & scenes

Scene cuts derive from `public/audio/manifest.json` (one CBR-mp3 per line, exact
frame durations), so re-recording the VO re-syncs every cut automatically.

| # | id | VO | Picture |
|---|----|----|---------|
| 1 | hook | Every day, your server posts messages that look like this. They could look like this. | Discord chat: a plain grey text post swaps in place for a rich Components V2 announcement card. |
| 2 | reveal | This is DWEEB — the visual builder for Discord messages. | Mascot lands, wordmark + green underline, tagline. |
| 3 | build | Design with Discord's real building blocks — containers, sections, media galleries, buttons, select menus — and watch a pixel-accurate preview update live, while DWEEB enforces Discord's limits for you. | The editor in one steady framing: tree assembles block-by-block, the preview mirrors each block; the floating issue pill flags a problem, then resolves. |
| 4 | assistant | Or just describe it — the built-in AI assistant drafts the whole message, right in your editor. | The AI Assistant docks on the right (like the real app), a prompt types, the draft lands in tree + preview at once. No model names. |
| 5 | plugins | Now make it do things. Select a button, pick a plugin — support tickets, giveaways, role menus, pop-up forms — real behavior, set up visually. | The Enter-giveaway button is selected; the "Attach a plugin" picker opens in-editor with all 7 real plugins; Giveaway is attached, the chip lands on the row. |
| 6 | send | When it's ready, name the message, pick a channel — DWEEB finds or creates the webhook for you. One click. Posted. | Message tab names it ("Nebula Announcements"), the action-bar Send drops a channel popover in place → click → the message lands in Discord with a ping. |
| 7 | templates | And you never start from zero — flip through ready-made templates, preview the message live, and open one to make it yours. | Gallery on the left, a big live-preview stage on the right: Welcome → Role menu → Giveaway → Announcement flip by as the cursor browses, then one opens. |
| 8 | activity | DWEEB also runs inside Discord. Open the Activity in a voice channel and build together — live presence, real-time co-editing, one-click publish. | A Staff Lounge voice call → the DWEEB Activity launches from it → the simplified embedded builder: presence rings on the tree, two edits land at once, **Post** flips to **Update**. |
| 9 | cta | DWEEB. Free to use, right in your browser. Just search dweeb bot on Google, and start building. | Riser → impact: mascot + wordmark, feature tags (Visual builder · AI assistant · Plugins · Build together); a Google search bar (G logo) types **dweeb bot** centered. |

## Accuracy sources (per claim)

- Component names = `src/core/schema/metadata.ts` (Container, Section, Text, Media
  Gallery, Buttons Row, String Select…). Limits/validation = `limits.ts` /
  `validation.ts` (+ README).
- AI assistant = `src/features/ai/AiChatPanel.tsx` — docks to the far right of
  the app, edits the live message directly ("Applied to your message"). BYOK is
  real but deliberately not narrated or shown; no provider/model names on screen.
- Plugin names & one-liners = `src/core/plugins/registry.json`; the narrated
  four = Tickets, Giveaway, Self Role, Modal Form; the picker shows all seven.
- Channel-first send = `/features/discord-webhook-manager` tagline: "Pick a channel
  and DWEEB finds or creates the webhook for you" (GuildWebhookPicker). Message
  name/avatar = the builder's Message tab (webhook identity).
- Templates = `src/data/presets.ts` (Welcome, Server rules, Role menu, Giveaway,
  Poll, Announcement, Patch notes, FAQ); gallery = `features/templates/TemplateGallery.tsx`.
- Activity = docs/activity.md (launched in a voice channel, real-time co-editing,
  presence, Post→Update, invite via +).
- "Free to use, right in your browser" = index.html FAQ ("completely free… no
  paywall") + the web app needing no install — no fine print on screen.

## Production notes

- **VO**: `scripts/generate-audio.mjs` via `msedge-tts`, one CBR-mp3 per line —
  duration = bytes/6000 → frames → `manifest.json` drives the whole timeline.
- **Music**: the licensed bed (Pavel Yudin — "Tech Corporate", Pixabay,
  `paulyudin-tech-corporate-182507.mp3`). The music step decodes it with
  Remotion's bundled ffmpeg, trims it to the film, bakes the duck under every
  VO line plus head/tail fades, and writes it as `music.wav`
  (`buildMusicFromTrack` in `scripts/audio-synth.mjs`). If the mp3 is missing,
  a synthesized ambient fallback (chord pads + bass, no percussion) is
  generated instead. Arrangement marks: groove at *build*, lift at *templates*,
  breakdown under *activity*, riser → impact into *cta*.
- **SFX**: original synthesized kit — click, tick, pop, chime, whoosh, ping
  (message-land), riser, impact. Regenerate offline with `npm run sfx`.
- **Camera**: per-scene keyframes, deliberately minimal in v3.1; captions render
  at screen level (pin-sharp).
- The v1 40s cut's vertical (9:16) composition was retired with the v2 film;
  `out/dweeb-promo-vertical.mp4` from v1 remains until re-authored.

## Rebuild

```bash
cd video
npm install
npm run audio            # regenerate VO + music + SFX + manifest (network for TTS)
npm run music            # rebuild ONLY music.wav to the existing manifest (offline)
npm run sfx              # regenerate ONLY the SFX kit (offline)
npm run studio           # preview in Remotion Studio
npm run render           # -> out/dweeb-promo.mp4
```
