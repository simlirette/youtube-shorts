# Reference analysis and content target — report (no production code changed)

Date: 2026-10-10. Data: `reference-metrics.json`, `our-metrics.json`, `sample.json` in this folder.

## 0. Method and what was actually inspected

- **Sample**: for each channel, the 3 most-viewed of its latest 60 Shorts plus one near the median (16 Shorts). BE AMAZED **has no Shorts tab** (long-form only, 13.5M subscribers), so the first 75 s of its 2 most-viewed recent videos were analysed instead.
- **Inspected per video** (downloaded at 360p for local analysis only, not redistributed):
  - duration;
  - cut count (FFmpeg scene score > 0.3);
  - integrated loudness and silences (≥ 0.25 s below −38 dB);
  - a word-timed transcript (OpenAI Whisper, ≈ $0.10 total), giving words per second, the narration start time and the first-3-second hook text;
  - frame sheets, which I viewed myself: 7 frames across the first 3 s and 10 frames across the whole video.
- **The same measurements were applied to 4 of our own Shorts** (2 from the new question formats, 2 STORY-format).
- **Limits of the method:**
  - Scene detection under-counts continuous animation, map zooms and hard cuts between similar shots. Visual change frequency was therefore judged from the frame sheets, not the cut count alone.
  - Music presence is inferred from "no silences" plus loudness, not from listening.
  - YouTube's own captions were not retrievable (bot check); the transcripts come from Whisper.
  - Retention data for the reference channels is not public.

## 1. Reference analysis

Legend: **O** = observed in the sample, **I** = inference.

| | Zack D. Films (29M) | The Infographics Show (15.5M) | MrBallen Shorts (3.2M) | RealLifeLore (7.9M) | BE AMAZED (13.5M) |
|---|---|---|---|---|---|
| Median views, latest 60 Shorts | 10M | 264k | 288k | 278k | n/a (no Shorts) |
| Duration (O) | 31–63 s | 29–59 s | 177–180 s | 56–60 s | long-form |
| Words/second (O) | 2.5–3.0 | 2.7–3.55 | 3.2–3.6 | 3.3–3.65 | 2.1–2.5 |
| Narration starts at (O) | 0.0 s | 0.0–1.0 s | 0.0 s | 0.0 s | 0.0–0.9 s |
| Silences (O) | none | 0–3 short | none | 0–1 | none |
| Loudness (O) | −10.6 to −11.9 LUFS | −13.8 to −21.3 | −10.9 to −13.2 | −16.1 to −17.4 | −16.9 to −18.9 |
| Visuals (O) | custom 3D animation; every shot depicts the exact action narrated; camera always moving | flat 2D vector animation (one 3D anatomy); characters and icons act out each sentence | host on camera over location backdrops, cut with real photos of the people and places | animated satellite maps: pans, zooms, highlighted regions, routes, labels, data cards | real/viral clips, stock, cartoons, map graphics, countdown cards |
| Visual change (O, from frames) | new composition every ~2–4 s (continuous motion) | new composition every ~2–4 s | host vs. photo every ~5–9 s | continuous movement; new overlay every ~2–4 s | cut every 3.3–3.8 s (measured) |
| Hook, first 1–3 s (O) | in medias res action: "He walked in with a nail sticking out of his head", "It swung down and smashed right into the toucan's upper beak" | the topic as a statement: "Here's how soldiers storm a trench", "When you're shot, the bullet first…" + a title card (yellow/red labels) | "In 2009, a 38-year-old man…", "In 1991, 31-year-old…" (date + person) | a common belief to overturn: "Most Americans and Canadians think of Canada as being fully north…" / an event in progress | a list promise: "From self-snitching on social media to…" |
| Structure (O) | problem → "So / But / Then" causal chain → concrete payoff ("…the toucan could pick up fruit again"); sometimes a parable | direct answer, then steps ("first… next… finally") and a one-line conclusion | linear story with a withheld identity, revealed at the end ("…Squid Game") | claim → evidence with highlighted map regions → escalating oddities → punchline (Detroit) → subscribe CTA | countdown of clips |
| Captions (O) | 2–4 words, white, small, shadowed, ~75 % height | sentence chunks in a dark box (3 lines) or big yellow words at the top; title card at the top | 1–3 words, small serif caps, keyword in orange, chest height | 1–3 words, white bold, mid-frame; brand tag top-left | mostly none |
| Sound (O/I) | continuous bed + effects (loud, I) | bed, quieter | continuous bed (I) | bed (I) | continuous |
| Ending (O) | concrete resolution; no CTA | summary line | identity/twist reveal | punchline, then CTA | — |
| Reproducible in our pipeline | storytelling discipline (concrete verbs, causal chain, payoff, no filler), pacing, captions; **not** the bespoke 3D visuals | statement hooks, title card, step structure, caption styles; **not** the custom animation | date/person hook, delayed reveal (for public figures/events); **not** the on-camera host; real photos of private people raise rights/privacy issues | the counterintuitive-claim structure and data comparisons; maps only with new work (programmatic map scenes from public-domain imagery) | cut rate, full-frame real footage (stock only; viral clips need licences) |
| Needs substantial human/creative work | 3D production per Short | illustration/animation | presenter, reporting | map motion design | licensing footage |

**Observed across all channels:**
- Narration starts at about 0 s and never pauses: a continuous audio bed with no silences.
- 2.5–3.65 words per second (except BE AMAZED long-form).
- Full-bleed 9:16 picture in every Short.
- Visual change every ~2–4 s.
- Captions of 1–4 words.
- Not one of the 16 Shorts opens with a question.
- Every ending lands on a concrete resolution or reveal, never a generic summary.

## 2. Recommended target format (first production channel)

**"Faceless micro-explainer"**:
- **Structure** from RealLifeLore and The Infographics Show (claim, then evidence, then punchline);
- **Storytelling discipline** from Zack D. Films (concrete causal chain, payoff);
- **Visual method** from BE AMAZED (fast-cut full-frame real footage), which fits our stock pipeline.

MrBallen's format (host on camera, 3-minute true crime about private people) and Zack's visuals (bespoke 3D) are deliberately **not** targeted: they are incompatible with a faceless, stock-based, fact-checked pipeline.

**Essential**
1. **Audience and promise:** curious English-speaking viewers aged 16–45. "The surprising real answer to something you've wondered about machines, places and how the world works — in under 45 seconds, with sources."
2. **Topics:**
   - aviation, maritime, trains, megastructures and infrastructure;
   - "how does X work" engineering;
   - geography oddities that can be shown with stock footage.
   - Exclude: private individuals, current wars and politics, health or financial advice.
   - Gap discovery already targets these.
3. **Duration:** 30–45 s (to be tested against 25–35 s).
4. **Hook:**
   - The first spoken words at ≤ 0.3 s are a concrete claim, a scene in progress, or "Here's why X": a statement, not an abstract question.
   - Frame 1 shows the subject.
   - A title card with the topic is on screen for 0–2.5 s.
   - The answer, or a stake, arrives by about 5 s.
5. **Script structure:**
   - Hook, then the direct answer in one sentence.
   - Then 2–4 escalating concrete facts, each causally linked (So / But / That's why).
   - End on a payoff: the single most surprising verified fact or reveal.
   - Banned: filler ("a marvel", "pivotal moment", "showcasing", "fascinating", "next time…", "in conclusion").
6. **Narration:**
   - 2.6–3.0 words per second (we measured 2.2 for STORY and 2.7–2.9 for the question formats).
   - Sentences of 6–14 words.
   - No pause longer than 0.3 s between sentences.
   - An energetic, consistent voice.
7. **Scene planning:**
   - One visual beat per clause, with a new visual every 2–3.5 s.
   - Each beat names a literal, filmable noun from its clause.
8. **Visuals:**
   - Full-bleed 9:16 with no blurred letterbox. Landscape clips are cropped, with a slow pan or punch-in.
   - Motion in every shot.
   - The vision check must ACCEPT every shot for unattended publication.
   - No watermarks, logos or on-screen text from the source footage.
9. **Captions and audio:**
   - Captions: 1–3 words per cue, word-synced, white bold with stroke, at 60–72 % of frame height, inside the safe zone.
   - Audio: a continuous music bed 18–24 LU under the voice, ducked during speech. Final loudness −14 LUFS (−1 dBTP).
10. **Ending:** the payoff line is last, with no call to action by default. Optionally, the last line can lead back into the hook so the Short loops.
11. **QC (measurable):**
    - speech starts at ≤ 0.3 s; words per second within range; no silence over 0.4 s;
    - median shot 2–3.5 s; at least 90 % full-bleed frames; every shot vision-ACCEPTed (or human review);
    - zero banned phrases; an editor rubric score of at least the threshold (hook concreteness, specificity, causal flow, payoff);
    - all existing technical and fact QA checks.

**Optional (test before adopting):** keyword-highlight captions, sound-effect hits on cuts, a call to action, a loop ending, voice choice, programmatic map and data-card scenes.

**Configurable and A/B-tested:** hook type (statement / scene / question), duration band, voice and speed, music level (on or off), caption style, title card (on or off), call to action (on or off), format.

## 3. Current engine capability (prioritised gaps)

| # | Priority | Gap (evidence) | Where |
|---|---|---|---|
| G1 | Storytelling | **Filler and generic sentences.** "This marked a significant turning point", "This event marked a pivotal moment in engineering history", "showcasing a unique legal twist", "Next time, notice these cues…". There is no check for specificity or payoff. | `scriptwriter-agent.ts` (prompt), `script-validation.ts`, `narration-review.ts`, `content-qa.ts` |
| G2 | Storytelling | **Hooks are abstract questions.** Our question formats *require* a question ("Why do planes look like…?"); none of the 16 references opens with one. The STORY hook is ≤ 7 words of generic intrigue ("How did a bridge dance wildly?"). | `formats.ts` (`hookMustBeQuestion`), prompt rule 3 |
| G3 | Storytelling | **No title card or on-screen topic in the first seconds;** no "answer by about 5 s" rule for STORY; THREE_REASONS reads as a list rather than an escalation. | `formats.ts`, `renderer.ts` |
| G4 | Visuals | **Blurred letterbox:** landscape stock fills about a third of the frame over a blurred copy (visible in most of our frames). Every reference is full-bleed. | `rendering/renderer.ts` `sceneFilter` |
| G5 | Visuals | **Visual beats are per scene, not per clause.** A median shot of 3.9–4.7 s and a 6 s shot cap. Scenes are 15–25 words long, so one subject has to carry several sentences. | `rendering/timeline.ts`, scene model in `schemas`, `scriptwriter-agent.ts` |
| G6 | Visuals | Older Shorts (before the vision check) had weak matches: an Italian village for "In 1966", a statue of Justice for "beneath its beauty". The current stack (subject + vision + fallbacks) is better, but fallbacks still lead to generic b-roll. No map or data-graphic capability. | `visual-director-agent.ts`, `media-ranker.ts` |
| G7 | Audio and narration | **Dead air:** 5–13 silences per Short (3–8 s in total) and **no music bed**; every reference has continuous audio. | `voice-agent.ts`, `renderer.ts`, `media-qa.ts` (narration correlation check must allow a bed) |
| G8 | Audio and narration | **Pace:** 2.2 words per second for STORY (speed 1.1), below every reference. | `config.ts` `ELEVENLABS_SPEED`, prompt sentence rules |
| G9 | Research integrity | Strong: located quotes, entailment, source tiers, fact review. Remaining risk: some sources are content sites (birdfact.com, a-z-animals.com) classified ACCEPTABLE by the model. | `source-policy.ts` (no change needed now) |
| G10 | Experimentation | No variant fields: the analyzer can group by format, cluster, length and hour, but not by hook type, caption style or music. | `schemas` (script/job), `performance-analyzer.ts` |
| G11 | Rendering | Technically solid (codec, loudness, safe zones, sync); no transitions or motion on video clips (fine for hard cuts). | — |

## 4. Prioritised implementation plan

| # | Change | Fixes | Expected effect on the video | Files | Test | New service? | Cost / ops | When |
|---|---|---|---|---|---|---|---|---|
| P1 | **Editorial contract:** banned-filler lint; hook types (statement / scene / question) as a format parameter; "answer by sentence 2"; "payoff is last and concrete"; sentence length 6–14 words; a few original structural examples in the prompt | G1, G2, G3 (script) | tighter, concrete scripts with a real ending | `formats.ts`, `scriptwriter-agent.ts`, `script-validation.ts` | unit: lint, hook-type validation; regression fixtures from our weak scripts must fail | no | ≈ $0 | **now** |
| P2 | **Editor rubric pass:** one LLM call scores hook concreteness, specificity, causal flow and payoff (0–5 each) and returns rewrite notes; the script must reach the threshold or retry | G1 | removes generic writing the lint misses | new `script-editor.ts`, `scriptwriter-agent.ts`, `content-qa.ts` (records score) | mock-LLM tests; live comparison of 10 scripts before vs after | no | +$0.01–0.02 per Short | **now** |
| P3 | **Full-bleed framing:** landscape clips cropped to 9:16 with a slow pan or punch-in (letterbox only if the crop would upscale more than ~2×); ranker prefers portrait and ≥ 1080p | G4 | picture fills the screen like every reference | `renderer.ts` `sceneFilter`, `media-ranker.ts`, `media-qa.ts` (new full-bleed check) | render tests on landscape/portrait/still fixtures; QA check fails on letterbox | no | none | **now** |
| P4 | **Continuous narration:** trim inter-sentence gaps over 0.25 s on the audio *and* shift word timestamps; default speed 1.15–1.2; update the word budget per second | G7 (dead air), G8 | about 2.6–2.9 words per second, no dead air, more information per second | `voice-agent.ts`, `config.ts`, `timeline.ts` | unit: realignment keeps word/caption sync; media QA speech-gap check tightened | no | slightly fewer credits per second of video | **now** |
| P5 | **Music bed with ducking:** a local library of licensed tracks (you provide them, e.g. from the YouTube Audio Library), one picked per Short (logged), sidechain-ducked about 20 LU under the voice; QA keeps the narration correlation check on the voice stem | G7 | removes silence; references all have a bed | `renderer.ts`, `media-qa.ts`, new `music.ts`, config | render test with a fixture track; QA: narration still dominant, loudness −14 ± 1 | **needs tracks from you** (free libraries; licence per track) | none per Short | **now** (once tracks exist) |
| P6 | **Clause-level visual beats:** the script gives one visual beat per clause (1–2 s of speech); the timeline cuts on beat boundaries (target 2–3.5 s shots); preflight and vision checks run per beat | G5, G6 | visuals follow the words, faster rhythm | `schemas` (scene beats), `scriptwriter-agent.ts`, `timeline.ts`, `visual-director-agent.ts` | timeline tests; mock end-to-end; live 3 Shorts | no | about 2× vision checks (+$0.01) | **now**, after P1–P4 |
| P7 | **Title card (0–2.5 s)** with the topic phrase, in a style distinct from the references | G3 | instant topic recognition, as in Infographics/RLL | `renderer.ts` (ASS layer), `captions.ts`, `media-qa.ts` safe-zone check | caption/safe-zone tests | no | none | now (as a test variant) |
| P8 | **Variant tracking:** `variant` fields on the script/job (hook type, caption style, music, title card, speed, CTA, format, duration band); balanced rotation, changing one factor at a time; analyzer groups by each factor; optional manual entry of "viewed vs swiped" (not available through the API) | G10 | decisions based on evidence | `schemas`, `formats.ts`, `performance-analyzer.ts`, CLI `analytics` | analyzer tests on synthetic data; rotation tests | no | none | **now** |
| P9 | Keyword-highlight captions | — | possibly better readability | `captions.ts` | caption tests | no | none | later (variant) |
| P10 | Programmatic map/data-card scenes (NASA Blue Marble + Natural Earth, both public domain) | geography topics, G6 | unlocks RLL-style geography Shorts | new rendering module | visual tests | data downloads only | engineering effort: days | later |
| P11 | Sound-effect hits on cuts (licensed pack) | polish | — | `renderer.ts` | — | assets from you | — | later |

**Experiment plan**
- **One factor per test**, everything else held constant: hook type, then music on/off, then title card, then duration band.
- **Each arm** needs ≥ 8 Shorts older than 72 h.
- **Primary metric:** engaged views per day, together with average % viewed (Analytics API).
- **Secondary metrics:** subscribers per 1,000 views, and "viewed vs swiped" entered manually from Studio.
- **Decision rule:** adopt an arm when its median beats the other by ≥ 20 % on the primary metric and is not worse on % viewed; otherwise keep rotating.
- **Data retention:** every Short stores its variant, format, topic gap evidence and metrics history (the `video_metrics` table already exists), so decisions can be audited later.
- **Caveat:** small channels have high variance, so treat early results as provisional.

## 5. Uncertainties and limitations

- **Survivorship bias:** the sample is small (4 Shorts per channel) and skewed to recent top performers.
- **Comparability:** the references benefit from established audiences and subscriber feeds; their view counts are not comparable to a new channel's.
- **No retention data** for the references: what *keeps* viewers is inferred from structure, not measured.
- **Questions vs statements:** no reference opens with a question, which suggests (but does not prove) that statement hooks work better. Our gap data (search questions) argues for keeping the question as the *topic*, while the spoken hook becomes a statement. This must be tested.
- **Stock limits:** stock footage cannot match custom animation for literal depiction. Clause-level beats and vision checks narrow the gap but will not close it.
- **Music** (P5) needs tracks whose licences you accept. I will not scrape or download music without your choice of source.
- **Measurement method:** cut detection under-counts animation; music presence is inferred.

## 6. Acceptance criteria for finished content

A Short is acceptable for publication when all of these hold:
1. Every existing technical and fact QA check passes, and every claim is verified with a citable source.
2. The first spoken word is at ≤ 0.3 s, and the hook is concrete (editor rubric hook ≥ 4/5); the answer or stake arrives by 5 s.
3. Zero banned filler phrases; editor rubric total ≥ 15/20; the last sentence is the payoff (rubric payoff ≥ 4/5).
4. 2.6–3.0 words per second; no silence over 0.4 s; a music bed present (once P5 lands) with the voice dominant; −14 ± 1 LUFS.
5. Median shot 2–3.5 s; at least 90 % of sampled frames full-bleed; every shot vision-ACCEPTed (otherwise human review).
6. Captions 1–3 words per cue, word-synced, inside the safe zone.
7. Duration 25–45 s (unless a test variant).
8. A human reviewer would not describe it as "generic" (the final approval gate stays manual until the analytics show stable results).

## 7. Implementation status (2026-10-10, uncommitted on `feat/production-pipeline`; checkpoint `refs/checkpoints/pre-content-improvements`)

| Item | Status | Evidence |
|---|---|---|
| P1 editorial contract (hook types, answer by ~16 words, 2–4 claim-backed facts, payoff, banned filler, regression fixtures) | **Implemented and tested; real-provider tested** | `editorial.ts`, `formats.ts`; `tests/content.test.ts` P1; live scripts pass the contract |
| P2 script editor (0–5 rubric, ≥15 / hook ≥4 / payoff ≥4, bounded revisions, fail closed, stored reviews, cost ledger) | **Implemented and tested; real-provider tested** | 1 live rejection (14/20) → revision → 16/20. Weakness: gpt-4o scored 16/20 in almost every pass, so its discrimination is low; consider a stronger `OPENAI_VERIFIER_MODEL` |
| P3 full-bleed framing (saliency crop/pan, letterbox only above 2× upscale, QA full-bleed/upscale) | **Implemented and tested; real-provider tested** | 0 letterboxed shots in live renders; frames reviewed. Live defect fixed: vision and blank checks now judge the *used* segment, cropped as shown |
| P4 continuity and pacing (start ≤0.3 s, gaps ≤0.4 s on the stem, realigned timestamps) | **Implemented and tested; real-provider tested** | Acoustic second pass added after a live failure. Speed 1.1 → 2.2–2.5 w/s; 1.2 → 3.06; **1.15 → 2.67–2.85** (in band). Default is now 1.15 |
| P5 clause-level beats (two-phase writer, per-beat preflight, review path, no silent substitution) | **Implemented and tested; real-provider tested** | Two-call writer, regrouping and canonicalisation, Pixabay rate limiter. Footage-short beats go to human review. Some metaphorical subjects remain (e.g. waves for "G-force") |
| P6 title card (0–2.5 s, safe area) | **Implemented and tested; real-provider tested** | `titleCard.layout` PASS on every live render; seen in frames |
| P7 variants and experiments (frozen per job, round-robin, analyzer, ≥8/arm screening) | **Implemented and tested; not real-provider tested** | Needs published Shorts and Analytics; YouTube not verified |
| Music bed (approved local tracks, ducking, voice-dominance QA) | **Implemented and tested with a generated fixture; blocked for real use** | No approved tracks: renders record music as disabled, and QA reports NOT MET. Add tracks per `assets/music/README.md` |
| Caption highlight style, short duration band | Implemented and unit-tested; not real-provider tested | — |
| CTA | **Not implemented** (flag recorded, off) | — |

**Live campaigns** (local export only, nothing published):
- Nine small campaigns were run while fixing defects. The early ones failed 100 % at SCRIPTING; every root cause was fixed and covered by a regression test.
- On the near-final code (campaigns 6–9), 9 of 12 jobs reached `AWAITING_FINAL_APPROVAL` on the first pass. The 3 failures were:
  - voice continuity, before the acoustic pass;
  - the beat planner, before canonicalisation;
  - the research gate (correct).
- Cost per accepted Short was about $0.30–0.46 (OpenAI/Tavily), plus about 550–650 ElevenLabs credits.
- Every accepted Short still carries human-review reasons: QUESTIONABLE sources, UNSURE or fallback visuals, and the pace WARN before the 1.15 setting.

**Not ready for unattended publishing.**
