# BASE v1 and the per-video layer

One command builds a complete video from the BASE plus a small per-video config. The base is versioned
(`base/v1`) and is never edited for a video.

```
pnpm video videos/<slug>/video.json
```

## What belongs in the BASE (never edited per video)

| Part | Where it lives | Frozen by SHA-256? |
|---|---|---|
| Studio, lighting rig, camera rig, depth of field, colour management, floor, backdrop | `packages/rendering/blender/mechanism.py` | yes |
| The three built-in subjects (crank-piston, four-stroke engine, turbocharger): model and animation | `packages/rendering/blender/mechanism.py` | yes |
| Part-label pill style (dark pill, white text, hairline, dot) and its placement | `packages/rendering/blender/mechanism.py` | yes |
| Collision sweep (parts that must not touch) | `packages/rendering/blender/mechanism.py` | yes |
| Wrapper that adds a per-video kit to the frozen script in memory | `base/v1/blender_entry.py` | yes |
| Caption font, label font | `assets/fonts/` | yes |
| Camera planning (look-at, push-in, orbit, headroom), narration-timed drive | `packages/rendering/src/mechanism-video.ts` (`planMechanism`) | by the golden test |
| Render settings: 1080x1920, 30 fps, H.264, bitrate, loudness, grade, 50-60 s target | `base/v1/base.json` `render` | no (config) |
| The one fixed voice: ElevenLabs id, model, stability, style, speed, pause target | `base/v1/base.json` `voice` | no (config) |
| Caption engine: font, size, stroke, position, colours, word or phrase timing | `base/v1/base.json` `captions` + `overlays.ts` | no (config) |
| Hook line: formulas, size, position, accent colour, duration | `base/v1/base.json` `hook` | no (config) |
| Progress tracker (visible from frame 1) | `base/v1/base.json` `progress` | no (config) |
| Fact-callout card style (yellow, black outline) | `base/v1/base.json` `callouts` | no (config) |
| Outro template | `base/v1/base.json` `outro` | no (config) |

`pnpm video` and the test suite refuse to run if a frozen file no longer matches `base/v1/frozen.json`.
A deliberate change to the visual layer is: edit, `pnpm base:freeze --confirm`, and a new base version if the look changes.

## What belongs in the per-video layer (`videos/<slug>/`)

| File | Contents |
|---|---|
| `video.json` | subject (name, built-in kit or its own kit), hook formula and its fields, steps, scenes (narration text, camera look-at and distance, part labels, shaft/crank motion), fact callouts, caption display text, title, description, hashtags, optional overrides |
| `kit.py` | **only for a new 3D subject**: `build_kit()` (model and animation) and optionally `register_checks()` |

A video cannot override `render` or `voice`: `VideoConfigSchema` has no such fields and rejects unknown keys.
It may override these overlay sections, key by key: `captions`, `hook`, `progress`, `callouts`, `outro`.

## Build commands

```
pnpm video videos/dam/video.json                       one video (narration -> Blender -> overlays -> mux)
pnpm video "videos/*/video.json"                       every video, one after another (also: pnpm video:batch ...)
pnpm video a/video.json b/video.json c/video.json      an explicit list
pnpm video videos/dam/video.json --plan-only           validate, narrate (spends credits only if the script is new) and print the timeline
pnpm video videos/dam/video.json --mock-voice          silent placeholder voice, no credits (look and timing)
pnpm video videos/dam/video.json --remux               reuse the last Blender render; redo overlays and audio only
pnpm video videos/dam/video.json --suggest-callouts    list numbers in the script that could get a fact card
pnpm base:freeze [--confirm]                           record / re-record the frozen manifest
```

Output: `output/videos/<slug>/` with `<slug>.mp4` (1080x1920, H.264), `<slug>.post.txt` (title, description,
hashtags), `<slug>.meta.json`, `plan.json`, `contact-sheet.jpg`.

## Every config option

See `BaseConfigSchema` and `VideoConfigSchema` in `packages/schemas/src/index.ts`; the values are in `base/v1/base.json`.
Sizes are percentages of the frame height (1920 px) or width (1080 px), so a change never depends on pixel arithmetic.

- `captions`: `enabled`, `layout` (`phrase` | `single`), `timing` (`word` | `phrase`), `maxWordsPerCue`, `maxLines`,
  `font {family, bold, sizePct}`, `stroke {widthPct, color, shadowPct}`, `colors {spoken, current, upcoming}`,
  `position {xPct, yPct}`, `safeWidthPct`, `uppercase`, `hideDuringHook`, `fadeMs`
- `hook`: `enabled`, `seconds`, `formulas`, `font`, `stroke`, `colors {text, accent}`, `position`, `safeWidthPct`, `uppercase`,
  `accentNumbers`, `fadeMs`; per video: `hook {formula: how_becomes | how_works | why | stat | custom, ...fields}`
- `progress`: `enabled`, `visibleFromStart`, `afterLast` (`complete` | `hide` | `hold`), `yPct`, `spreadPct`, `activeFont`,
  `inactiveFont`, `stroke`, `colors {active, done, upcoming, line}`, `dotRadiusPct`
- `callouts`: `fill`, `text`, `outline`, `outlineWidthPct`, `valueFont`, `labelFont`, `position`, `paddingPct`, `seconds`, `fadeMs`;
  per video: `callouts [{value, label, at {scene, fraction} | {phrase}, seconds}]`
- `outro`: `enabled`, `mode` (`tail` extends the video | `overlay`), `seconds`, `text`, `subtext`, fonts, `stroke`, `colors`,
  `position`, `fadeMs`
- `render`: `width` / `height` / `fps` (fixed 1080 / 1920 / 30), `video {codec, crf, preset, pixFmt}`,
  `audio {codec, bitrate, loudnessLufs, truePeakDb}`, `grade {contrast, saturation, grain}`, `lengthSeconds {min, max}`
- `voice`: `id`, `model`, `stability`, `style`, `speed`, `pauseTargetSeconds`, `leadSeconds`, `tailSeconds`
- per video only: `captionText` (display text for spoken words), `blender {floorZ, events, maxSpeed, allowedContacts}` for a new kit,
  `overrides`, `hashtags`, `description`, `title`, `steps`, `scenes`

## Decisions on record (2026-10-16)

- `mechanism.py` stays frozen exactly as hashed in `frozen.json`. One label (CAMSHAFT, scene 6 of the engine) sits about 10 px
  higher and to the right than in the v3b render, because labels now anchor at the centre of a part's geometry. Accepted; not restored.
- No per-scene title text. The progress tracker carries the structure of a video, and on-screen text is kept minimal for retention.
  The `hud` field in a scene is accepted by the schema for older specs but `pnpm video` does not draw it.
- Tracker label sizing for any number of steps is a base responsibility (`progressFit`); the four-stroke tracker is unchanged by it (tested).
- The four-stroke engine keeps its original 39 s narration, so it shows a length warning. New videos target 50-60 s.

## Starting a new video

1. `videos/<slug>/video.json`: copy `videos/dam/video.json` and change the subject, hook, steps, scenes, callouts, hashtags.
2. A built-in subject (crank_piston, four_stroke, turbocharger) needs nothing else. A new 3D subject needs `videos/<slug>/kit.py`
   (copy `videos/dam/kit.py` as the pattern: `build_kit()`, optional `register_checks()`), and its collision sweep must pass.
3. `pnpm video videos/<slug>/video.json --mock-voice --plan-only` validates the config and the timeline for 0 credits.
4. `pnpm video videos/<slug>/video.json` builds it (about 900 ElevenLabs credits for a 50-60 s script; about 25 min of rendering).

## Overlay refinement (2026-10-16): new options, all additive

Config-only. The legacy sections (`captions`, `progress`, `callouts`, `hook`) stay as fallback values; delete a section below and the old look returns. Every key can also be set per video under `overrides`.

| Key | Default | Effect |
|---|---|---|
| `caption.size_pct` | 5.8 | caption size, % of frame height (5-7) |
| `caption.zone` | `lower_third` | `lower_third` (y 76%), `center` (50%), `upper_third` (24%) |
| `caption.max_words` | 3 | words on screen at once (word-by-word gold highlight kept) |
| `hook.size_pct` / `hook.duration_s` | 6.4 / 2.0 | the big centred hook line in the first seconds |
| `tracker.height_px` | 3 | thickness of the tracker bar |
| `tracker.font_size_pct` | 1.5 | tracker label size |
| `tracker.dim_opacity` | 0.45 | opacity of upcoming steps; tracker visible from frame 1 |
| `callout.size_pct` | 4.6 | fact-card size (yellow/black style kept) |
| `callout.y_pct` | 27 | fact-card vertical position |
| `pointer.mode` | `overlay` | `overlay` = pills at the frame edge; `blender` = old in-render pills |
| `pointer.style` | `leader` | `leader` (line + dot) or `pulse` (ring on the part); per label: `"pointer": "pulse"` |
| `pointer.thickness_px` / `color` / `dot_px` | 2.5 / #FFFFFF / 5 | leader line |
| `pointer.label_size_pct` | 1.9 | pill text size |
| `pointer.edge_margin_px` | 36 | pill distance from the frame edge |
| `pointer.zone` | top 15% - bottom 64% | vertical band for pills (below tracker, above captions) |
| `pointer.pill`, `minGapPx`, `pulse`, `fadeMs` | see base.json | pill colours, spacing, ring size and period, fades |

How pointers work without touching frozen files: the frozen `mechanism.py` draws pills over the subject, so in overlay mode it is given an empty `labels` list. `base/v1/probe_kit.py` (unfrozen) runs the same Blender script through the frozen wrapper and records where each part appears on screen per frame; the overlay layer draws pill, leader line and dot from that.

### Kit authoring guideline (not enforced)

Frame the subject in the upper two thirds of the frame. Keep the lower third free of key parts: it is the caption zone.

## Text styles: classic and premium (2026-10-17)

`text_style` in `base.json` (or `overrides.text_style` in a video) picks the look of every overlay. Only the text layer changes: sizes, positions, word timing, the timeline and the 3D render are the same in both.

- **classic** (default) is the sections of `base.json` untouched. A test (`classic-overlays.sha256.json`) pins every overlay layer byte for byte, and a classic render is pixel-identical to the render made before presets existed.
- **premium** is `presets.premium` merged over those sections.

One command renders a video in both: `pnpm video videos/<slug>/video.json --text-style=both` gives `<slug>.classic.mp4` and `<slug>.premium.mp4` (one Blender render, `--remux` reuses it). `--text-style=premium` or `=classic` renders one; without the flag the base's `text_style` is used and the file is `<slug>.mp4`.

| Option | Default (classic) | Premium preset | Effect |
|---|---|---|---|
| `text_style` | `classic` | | which look |
| `text.shadow_blur` | absent (none) | 10 | soft drop shadow behind all text, blur px; replaces the stroke |
| `text.shadow_opacity` | 0.55 | 1.0 | shadow opacity |
| `text.shadow_offset_px` | 2 | 3 | shadow distance below the text |
| `text.tracking_px` | 0 | -0.8 | letter spacing added to every style |
| `text.scrim_opacity` | 0 | 0 | fallback to the shadow: soft dark patch behind each caption phrase |
| `highlight.policy` | `legacy` | `single` | single: yellow only on one word per scene (or the fact card figure of a scene that has one) |
| `highlight.color` | classic gold `#FFD200` | `#FFD43B` | the one highlight colour |
| `callout.style` | `legacy` | `badge` | badge: dark translucent card, thin border, big figure over a small label |
| `callouts.badge.*` | see base.json | fill #0B0D11 at 0.58, border 1.5 px at 0.32, radius 22, padding 26 | badge look |
| `pointer.font` | Montserrat SemiBold | Inter SemiBold | pill text |
| font families, stroke widths, colours | Montserrat, thick outline | Inter / Inter SemiBold, no stroke, white and gray | any section can be overridden in the preset |

Under `single`, a scene's yellow word is the video's own pick (`highlights: [{ "scene": 3, "word": "explosion" }]` in video.json) or, by default, the longest meaningful word of the scene. A scene with a fact card has no yellow caption word. The hook still colours numbers, the tracker and the outro use white and gray.

Fonts: `assets/fonts/Inter-Bold.otf`, `Inter-SemiBold.otf` (Inter 3.19, SIL OFL, licence in `OFL-Inter.txt`). They are copied into every render with the rest of the folder and are not in the frozen list.
