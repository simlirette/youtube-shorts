# Sourcing report: what performs for 3D explainers (2026-10-16)

Method: 50 YouTube searches across the six topic areas (30 results each, 1,438 unique videos; 493 are 3 minutes or less, 170 are 60 s or less), channel sizes for 486 channels, plus web sources found with Exa. Scripts: `collect.mjs`, `analyse.mjs`, `topics.mjs` (rerunnable: `node collect.mjs && node analyse.mjs && node topics.mjs`). Raw data: `videos.json`, `channels.json`, `rows.json`. Tables: `analysis.md`, `topics.md`.

**Observed** = counted in the data. **Inferred** = my reading of it.

## What the data shows

1. **Mechanism animations are the strongest demand by far** (observed). Median 63K views over 181 videos; the 90th percentile is 833K. Small channels get huge views: a 13K-subscriber channel has 24.7M views on a turbocharger model, a 31K channel has 27M on a clutch/transmission video, and a 6K channel has 3.6M on a steam locomotive boiler animation. Inferred: the topic carries the views, not the channel.
2. **The best subjects are automotive and everyday machines** (observed). Turbocharger (median 624K, 4 hits from tiny channels), clutch (362K), pumps and hydraulics (111K, 20 of 33 videos over 100K), air conditioning and refrigeration (125K), steam engines (112K), jet and turbine (110K), locks (a 6 s lock animation has 1.8M), brakes and ABS (2.3M), toilet and sewer (2.3M).
3. **Our four-stroke video is on a proven subject** (observed). "Car engine / piston / valves": 76 videos, 25 over 100K, 6 hits from tiny channels, best 2.6M.
4. **The differential, which I suggested earlier, looks weaker than I assumed** (observed). Median 36K, best 141K, no tiny-channel hits. Still usable, but it is not a first pick.
5. **Length:** 45 to 60 s has the highest median (30K, against 13K to 17K for the other bands) (observed, 42 videos). Inferred: our 43 s video is in a good range.
6. **"Why ...?" titles perform badly in this sample** (observed: median 70 views, 43 videos). Caution: the searches themselves lean toward small videos for "why" phrases, so do not read this as proof. The one why-design hit: "What's That Hole at the Bottom of Airline Windows?", 675K in 49 s from a 265K-subscriber channel.
7. **AI and computing is bimodal** (observed). Median 3K to 19K but huge hits: "How To Make A CPU" 26.2M, "How Computer Works" 2.8M in 46 s, "Neural Network 3D Simulation" 1.0M, and a vector-search explainer at 1.3M from a 13K channel.
8. **Investigative AI-water content has the weakest demand here** (observed). Median 4K, best 303K, and the top result in that group, "That's AI (2026) - Short Film" (5.8M), is not about water.

## What the research says about virality (web sources)

- **A 2026 analysis of 300 educational Reels from 21 accounts** (Tvorogov, SSRN, published 2026-10-07): the account explains 68% of the variation in views, and follower count is about two thirds of that. Within an account, hits are rare spikes: 9.7% of Reels reach 10x the account's own median. No hook type, hook length, video length, editing pace, subtitle type or music was reliably linked to views. An explicit request to comment was the only prompt with a consistent signal (about 2.3x comments, preliminary).
- **A TikTok study of 1,278 posts** (Postdom, October 2026): tutorials get 41 saves per 100 likes against 11 for all videos, and videos with numbered items get 35 against 10. Fact or statistic hooks and warning hooks drew far more comments than POV or relatable hooks.
- Inferred for us: the features we can control are topic choice and volume. Style variations matter less than expected. A new channel starts with a large follower disadvantage, so consistency matters. "Four strokes" or "3 reasons" numbered structures fit the save pattern. A closing "which machine next?" line is a cheap test of the comment signal.

## Recommended mix for one video a day

| Share | Area | First picks (evidence) |
|---|---|---|
| about 60% | Mechanisms, automotive first | turbocharger; clutch; manual gearbox; brakes and ABS; pump/hydraulic cylinder; pin-tumbler lock; AC compressor |
| about 15% | AI and computing | how a CPU runs an instruction; neural network; vector search |
| about 10% | History of technology | steam engine / locomotive; the evolution of the lock |
| about 10% | Why-design | airliner window hole (verified 675K); the spare-tire question |
| about 5% | Investigative | AI water use, only with sourced numbers; not a daily staple |

First two weeks, in order: four-stroke (done), turbocharger, clutch, pin-tumbler lock, brakes and ABS, steam engine, manual gearbox, pump, CPU instruction cycle, airliner window hole, AC compressor, neural network, jet engine, vector search.

## Limits of this study

- YouTube search results are not a random sample, and the views are lifetime totals, not first-week performance.
- Channel sizes were looked up only for channels with at least one video over 50K views (486 channels); smaller channels have no size, so they are missing from the views-versus-subscribers ratios.
- TikTok and Instagram were not measured at video level. TikTok tag pages are broken in yt-dlp and Instagram exposes likes, not views. The Instagram and TikTok findings come from the two published studies above, not from our own scrape.
- 3 of 7 Exa searches hit the free rate limit and returned nothing (hook-formula, "most viewed 3D animation channels", AI water per query).
- Muse from Meta is not reachable from the available tools. Its output could be pasted in for comparison.
