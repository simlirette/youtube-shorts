# Realignment (2026-10-15)

## Goal

An automated pipeline for YouTube Shorts, Instagram Reels and TikTok: educational, visually engaging
explainers on one curiosity-driven channel. Topics: how machines and mechanisms work (3D animation), how
everyday things work, design "why" questions, history of technology, AI and computing, and
research-backed investigative explainers. **Blender (3D visuals) and ElevenLabs (narration) are mandatory.**

## Why the project drifted

- The 2026-10-10 reference analysis studied other channels (Zack D., Infographics Show, MrBallen,
  RealLifeLore, BE AMAZED) and concluded bespoke 3D was "not reproducible", so stock footage became the
  primary visual path.
- Gap research narrowed topics to aviation / maritime / infrastructure.
- Blender was limited to four flat text-card templates (`graphic.py`, at most 40 % of beats).
- Publishing covers YouTube and local export only.

## Reference findings (2026-10-15, observed unless marked I)

| Account | Visuals | Length | Notes |
|---|---|---|---|
| Denis Shmalts | photoreal 3D, avatar of himself, cutaways | ~30 s | "How X works" Shorts 6K-28K views; narrative/human-stakes hooks 500K-34M (I: stakes beat plain mechanism titles) |
| scroll.engineer | stylized 3D, pill state labels, citations on screen | 80-160 s | paradox hooks ("AirTags don't use GPS. So how...?"), zero dead air |
| zackdfilms | photoreal CG characters, continuous camera | 27-46 s | broad "why" topics, 24K-416K likes |
| engineering.facts_ | clean low-poly 3D with callouts | 46-60 s | 24-104 likes on 388K followers, 5-19 silences per reel (I: automated, weak engagement) |
| Post Deb4B7fu4Cq | talking head + interactive isometric 3D demos | 43 s | promo for a Claude "Anatomy" skill, not a mechanism breakdown |

Shared traits of the stronger accounts: every shot literally shows the narrated action, the camera is
always moving, labels point at the key part, cutaways show internals, there is no dead air, one idea per
video, and the hook is a paradox or stakes.

Limits: Instagram exposes likes but not views; transcripts were not generated; only the five latest reels
per account were sampled; Instagram normalizes loudness, so audio levels were not comparable.

## Formats

1. **Mechanism cutaway** (core): Blender 3D, 35-50 s.
2. **Why-design**: paradox hook plus a 3D diagram or comparison.
3. **History of tech**: the invention modeled in 3D, with archival images.
4. **AI and computing**: abstract 3D data-flow scenes.
5. **Investigation**: sourced data cards and Blender charts; uses the existing research stack.

## Pipeline

Research and script (existing) -> beat planner emits a JSON **scene spec** per beat (kit, parts, motions,
labels, camera) -> Blender **kit library** renders it (`packages/rendering/blender/mechanism.py`) ->
ElevenLabs word timestamps time the labels and motion -> vision check on rendered frames -> FFmpeg
assembly (existing) -> per-platform export (YouTube, Instagram, TikTok). Stock footage and the 2D text
cards stay as fallbacks. LLMs never write free-form Blender code; they choose kits and parameters.

## Plan

| Phase | Work | Gate |
|---|---|---|
| 0 | Checkpoint-commit the working tree, fix the test runner | suite green |
| 1 | Spike: one mechanism Short end to end (crank-piston kit done; ElevenLabs timing next) | look approved |
| 2 | Scene-spec schema, 3-5 kits, 3D-first visual director | unattended mechanism Short |
| 3 | Broaden topic discovery across the five formats | |
| 4 | Instagram / TikTok export packages, then API publishing | |
| 5 | Analytics-driven format experiments | |

Decisions: stylized 3D first (photoreal later, if at all); 35-50 s default length; manual upload packages
for Instagram and TikTok before API publishing.
