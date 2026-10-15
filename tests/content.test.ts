/**
 * Reference-driven content improvements (research/2026-10-reference-analysis/REPORT.md):
 * editorial contract, script editor, full-bleed framing, narration continuity, clause-level beats,
 * title card, music bed and production variants / experiments.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  ProviderUnavailableError,
  ValidationError,
  applyCuts,
  cacheDir,
  cutSilencesWav,
  detectSilence,
  chooseFraming,
  planGapTightening,
  readWavPcm16,
  runFfmpeg,
  summarizeMedia,
  writeWavPcm16,
} from '@shorts/core';
import { MockAssetProvider, MockLLMProvider, MockTTSProvider, createProviders, pixabayThrottle, resetPixabayThrottle, type TTSProvider, type TTSRequest, type TTSResult } from '@shorts/providers';
import {
  DEFAULT_EDITORIAL,
  ScriptEditor,
  VisualDirectorAgent,
  VoiceAgent,
  editorialVerdict,
  experimentReport,
  findBannedPhrases,
  canonicalizeBeats,
  mergeShortBeats,
  regroupBeats,
  validateBeats,
  rulesFor,
  visualPreflight,
  validateEditorial,
  validateScriptDraft,
  analyzePerformance,
  type PerformanceRow,
  type ScriptDraft,
} from '@shorts/agents';
import { TITLE_CARD_LAYOUT, VideoRenderer, bedGainDb, buildTimeline, buildTitleAss, evaluateMedia, loadMusicLibrary, measureAssBoxes, selectTrack } from '@shorts/rendering';
import { PipelineRunner, assignVariant, parseExperiment } from '@shorts/pipeline';
import { ScriptReviewSchema, ShortScriptSchema, VoiceNarrationSchema, type ShortScript } from '@shorts/schemas';
import { memoryRepo, testConfig } from './helpers.js';

const FONT = path.resolve(__dirname, '../assets/fonts/Anton-Regular.ttf');
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `${p}-`));

// =============================================================================
// P1 — Editorial contract
// =============================================================================

/** Our own weak scripts (REPORT §3, G1/G2), as transcribed from the published renders. */
const WEAK = {
  smallpox: ['What if smallpox simply vanished?', 'In 1966, smallpox was endemic in over 30 countries.', 'It was fatal in up to 30% of cases, causing global concern.', 'Global efforts were finally paying off.', 'On May 8, 1980, smallpox was declared eradicated by WHO.', 'This was the first human infectious disease ever defeated, a historic victory for global health.'],
  tacoma: ['How did a bridge dance wildly?', 'Opened on July 1st, 1940, it was a marvel.', 'The Tacoma Narrows Bridge was a true engineering spectacle.', 'On a windy November day, the bridge twisted violently.', 'The disaster revolutionized bridge design and aerodynamics.', 'This event marked a pivotal moment in engineering history.'],
  crow: ['Why is it illegal to own a crow as a pet?', 'The Migratory Bird Treaty Act of 1918 makes it illegal to keep crows as pets in the U.S.', 'Crows are protected to prevent harm from humans.', 'They require special permits for care if injured or orphaned.', 'Surprisingly, despite being protected, states can set hunting seasons for crows, showcasing a unique legal twist.'],
  planes: ['Why do planes look like they are moving in slow motion across the sky?', 'Passenger jets fly at about 925 km/h once they are high in the air.', 'The illusion of slow movement is due to the plane moving across a large field of vision.', 'Clouds can be used as a reference point to perceive speed.', 'Next time, notice these cues and witness the real velocity of the skies.'],
};
const asScenes = (lines: string[], refs = true) => lines.map((narration, i) => ({ narration, claimRefs: refs && i > 0 ? [`C${i}`] : [] }));

describe('editorial contract (P1)', () => {
  const rules = { ...DEFAULT_EDITORIAL, hookType: 'statement' as const };

  it('regression fixtures: our weak published scripts fail for the intended reasons', () => {
    const smallpox = validateEditorial(asScenes(WEAK.smallpox), rules).join(' | ');
    expect(smallpox).toMatch(/not a question/);
    expect(smallpox).toMatch(/"global concern"|"paying off"|"historic victory"/);

    const tacoma = validateEditorial(asScenes(WEAK.tacoma), rules).join(' | ');
    expect(tacoma).toMatch(/"a marvel"/);
    expect(tacoma).toMatch(/"engineering spectacle"/);
    expect(tacoma).toMatch(/generic ending/);

    const crow = validateEditorial(asScenes(WEAK.crow), rules).join(' | ');
    expect(crow).toMatch(/"showcasing"/);
    expect(crow).toMatch(/"unique legal twist"/);

    const planes = validateEditorial(asScenes(WEAK.planes), rules).join(' | ');
    expect(planes).toMatch(/generic ending \("Next time/);
    expect(planes).toMatch(/"witness the"|"real velocity"/);
  });

  it('a concrete statement-hook script with claim-backed answer, facts and payoff passes', () => {
    const good = asScenes([
      'Airliners turn right after takeoff on purpose.',
      'Departure routes are published so that every pilot flies the same path.',
      'Those paths steer heavy jets away from homes near the runway.',
      'Controllers give each departure a different heading, so the jets separate quickly.',
      'At busy airports, two jets can leave parallel runways just seconds apart.',
    ]);
    expect(validateEditorial(good, rules)).toEqual([]);
  });

  it('hook types: statement and scene reject questions and rhetorical lead-ins; question is allowed only for the question variant', () => {
    expect(validateEditorial(asScenes(['Why do planes turn?', 'a b c d e f.', 'g h i j k l.', 'm n o p q r.', 's t u v w x.']), rules).join()).toMatch(/not a question/);
    expect(validateEditorial(asScenes(['Imagine a jet banking hard right.', 'a b c d e f.', 'g h i j k l.', 'm n o p q r.', 's t u v w x.']), { ...rules, hookType: 'scene' }).join()).toMatch(/rhetorical lead-in/);
    expect(validateEditorial(asScenes(['Why do planes turn right after takeoff?', 'a b c d e f.', 'g h i j k l.', 'm n o p q r.', 's t u v w x.']), { ...rules, hookType: 'question' }).join()).not.toMatch(/hook/);
  });

  it('requires an early claim-backed answer, 2-4 claim-backed facts and a verified payoff', () => {
    const lines = ['Airliners turn right after takeoff on purpose.', 'Routes are published.', 'Fact one is here.', 'Fact two is here.', 'The final fact lands here.'];
    const v = validateEditorial(lines.map((narration, i) => ({ narration, claimRefs: i === 3 ? ['C1'] : [] })), rules).join(' | ');
    expect(v).toMatch(/scene 2 must give the direct answer/);
    expect(v).toMatch(/at least 2 specific facts/);
    expect(v).toMatch(/final scene must be the payoff/);
  });

  it('flags over-long sentences and unsupported drama, but not legitimate words that contain a banned stem', () => {
    const long = `This sentence keeps going and going with clause after clause after clause until the listener has no idea where the point is anymore.`;
    const v = validateEditorial(asScenes(['Jets turn right on purpose.', long, 'Scientists are baffled by this fact.', 'Fact two is here today.', 'Payoff fact is here.']), rules).join(' | ');
    expect(v).toMatch(/sentence too long/);
    expect(v).toMatch(/unsupported dramatic claim/);
    expect(findBannedPhrases('The amazingly named Amazing Grace sailed.')).toEqual(['amazing']);
    expect(findBannedPhrases('The bridge was amazingly flexible.')).toEqual([]);
  });

  it('beats must be exact, ordered slices of the narration with literal, distinct subjects', () => {
    const r = rulesFor('MICRO_EXPLAINER', 118, { hookType: 'statement' });
    const scene = (narration: string, beats: Array<{ text: string; visualSubject: string }>) => ({
      narration, visualObjective: 'x', visualSubject: 'airliner climbing out', visualExclusions: [], assetKeywords: ['airliner', 'runway'], claimRefs: ['C1'],
      beats: beats.map((b) => ({ ...b, assetKeywords: [b.visualSubject], visualExclusions: [] })),
    });
    const draft: ScriptDraft = {
      title: 'Why jets turn right after takeoff', description: 'Departure routes explained with verified facts from aviation sources.',
      scenes: [
        scene('Airliners turn right after takeoff on purpose.', [{ text: 'Airliners turn right after takeoff', visualSubject: 'airliner banking' }]),
        scene('Routes are published so every pilot flies the same path.', [{ text: 'Routes are published so every pilot', visualSubject: 'map of routes' }, { text: 'flies the same exact path.', visualSubject: 'cockpit view' }]),
        scene('Jets avoid homes near the runway.', [{ text: 'Jets avoid homes near the runway.', visualSubject: 'houses near airport' }, { text: '', visualSubject: 'houses near airport' }].slice(0, 1)),
      ],
    };
    const v = validateScriptDraft(draft, { rules: r, claims: new Map([['C1', 'x']]) }).join(' | ');
    expect(v).toMatch(/scene 1 beats must split its narration exactly/); // "on purpose." missing
    expect(v).toMatch(/scene 2 beats must split its narration exactly/); // "exact" added
    const v2 = validateScriptDraft(
      { ...draft, scenes: [scene('Jets turn, then climb steeply over the bay.', [{ text: 'Jets turn,', visualSubject: 'airliner banking' }, { text: 'then climb steeply over the bay.', visualSubject: 'airliner banking' }])] },
      { rules: r, claims: new Map([['C1', 'x']]) }
    ).join(' | ');
    expect(v2).toMatch(/show the same subject/);
    expect(v2).toMatch(/beat 1 has only 2 words/);
    const v3 = validateScriptDraft({ ...draft, scenes: [scene('Routes are published so every pilot flies the same path.', [{ text: 'Routes are published so every pilot flies the same path.', visualSubject: 'animated map of routes' }])] }, { rules: r, claims: new Map([['C1', 'x']]) }).join(' | ');
    expect(v3).toMatch(/stock footage does not provide/);
  });
});

// =============================================================================
// P2 — Script editor
// =============================================================================

const scriptFixture = (): ShortScript =>
  ShortScriptSchema.parse({
    id: randomUUID(), storyId: randomUUID(), topicId: randomUUID(), title: 'Why jets turn right after takeoff', description: 'd', hookText: 'Airliners turn right after takeoff on purpose.',
    format: 'MICRO_EXPLAINER', targetDurationSeconds: 38, totalWords: 20, createdAt: new Date().toISOString(),
    scenes: ['Airliners turn right after takeoff on purpose.', 'Routes keep heavy jets away from homes.', 'Controllers give each jet its own heading.'].map((n, i) => ({ sceneNumber: i + 1, narration: n, visualObjective: 'x', assetKeywords: ['jet'] })),
  });

describe('script editor (P2)', () => {
  it('pass/fail is computed from the scores against the thresholds (never taken from the model)', () => {
    const t = { minTotal: 15, minHook: 4, minPayoff: 4 };
    expect(editorialVerdict({ hook: 4, specificity: 4, causalFlow: 3, payoff: 4 }, t)).toEqual({ total: 15, passed: true });
    expect(editorialVerdict({ hook: 3, specificity: 5, causalFlow: 5, payoff: 5 }, t).passed).toBe(false);
    expect(editorialVerdict({ hook: 5, specificity: 5, causalFlow: 5, payoff: 3 }, t).passed).toBe(false);
    expect(editorialVerdict({ hook: 4, specificity: 3, causalFlow: 3, payoff: 4 }, t)).toEqual({ total: 14, passed: false });
  });

  it('records scores, notes and the model; low scores come with specific notes', async () => {
    const llm = new MockLLMProvider({}, { script_editor: () => ({ scores: { hook: 2, specificity: 3, causalFlow: 3, payoff: 2 }, notes: ['[1] Replace the generic opener with the claim about departure routes', '[3] End on the parallel-runway fact'] }) });
    const r = await new ScriptEditor(llm).review(scriptFixture(), ['fact'], 0);
    expect(ScriptReviewSchema.parse(r)).toMatchObject({ total: 10, passed: false, revision: 0, model: 'mock-llm-1' });
    expect(r.notes).toHaveLength(2);
  });

  it('malformed output (out-of-range scores, missing fields, failing score without notes) is rejected after bounded retries', async () => {
    for (const bad of [{ scores: { hook: 7, specificity: 4, causalFlow: 4, payoff: 4 }, notes: [] }, { scores: { hook: 4 }, notes: [] }, { scores: { hook: 1, specificity: 1, causalFlow: 1, payoff: 1 }, notes: [] }]) {
      let calls = 0;
      const llm = new MockLLMProvider({}, { script_editor: () => (calls++, bad) });
      await expect(new ScriptEditor(llm).review(scriptFixture(), ['fact'], 0)).rejects.toBeInstanceOf(ValidationError);
      expect(calls).toBe(2);
    }
  });

  it('pipeline: a failing review triggers a bounded revision through the writer, and the passing review is recorded', async () => {
    const cfg = testConfig({ APPROVAL_IDEA: 'auto', APPROVAL_SCRIPT: 'manual' });
    const repo = await memoryRepo(cfg);
    const bundle = createProviders(cfg, 'mock');
    let reviews = 0;
    const prompts: string[] = [];
    const verifier = new MockLLMProvider({}, {
      script_editor: () => (reviews++ === 0 ? { scores: { hook: 2, specificity: 4, causalFlow: 4, payoff: 3 }, notes: ['[1] Open on the concrete subject instead of a summary'] } : { scores: { hook: 4, specificity: 4, causalFlow: 4, payoff: 4 }, notes: [] }),
    });
    const llm = new MockLLMProvider();
    const origGen = llm.generateStructured.bind(llm);
    llm.generateStructured = async (req) => {
      if (req.task === 'script') prompts.push(req.prompt);
      return origGen(req);
    };
    const runner = new PipelineRunner(cfg, repo, { ...bundle, llm, verifierLlm: Object.assign(verifier, {}) });
    const job = await runner.createJob();
    const waiting = await runner.run(job.id);
    expect(waiting.state).toBe('AWAITING_SCRIPT_APPROVAL');
    expect(reviews).toBe(2);
    expect(prompts.some((p) => /script editor scored the previous draft 13\/20/.test(p) && /Open on the concrete subject/.test(p))).toBe(true);
    const reviewsSaved = await repo.listArtifacts('script_review', ScriptReviewSchema, { jobId: job.id });
    expect(reviewsSaved.map((r) => [r.revision, r.passed]).sort()).toEqual([[0, false], [1, true]]);
    expect(waiting.artifacts.scriptReviewId).toBe(reviewsSaved.find((r) => r.passed)!.id);
    expect(reviewsSaved.find((r) => r.passed)!.scriptId).toBe(waiting.artifacts.scriptId);
  }, 300_000);

  it('pipeline: exhausted revisions and editor provider failures fail closed (no script is accepted)', async () => {
    const cfg = testConfig({ APPROVAL_IDEA: 'auto', APPROVAL_SCRIPT: 'auto', EDITOR_MAX_REVISIONS: '1' });
    const repo = await memoryRepo(cfg);
    const bundle = createProviders(cfg, 'mock');
    const low = new MockLLMProvider({}, { script_editor: () => ({ scores: { hook: 3, specificity: 3, causalFlow: 3, payoff: 3 }, notes: ['[5] The payoff repeats scene 2'] }) });
    const r1 = new PipelineRunner(cfg, repo, { ...bundle, verifierLlm: low });
    const j1 = await r1.createJob();
    const failed = await r1.run(j1.id);
    expect(failed.state).toBe('FAILED');
    expect(failed.failedStage).toBe('SCRIPTING');
    expect(failed.errorMessage).toMatch(/Script editor did not approve the script after 1 revision/);
    expect(failed.artifacts.scriptId).toBeUndefined();

    const broken = new MockLLMProvider();
    const orig = broken.generateStructured.bind(broken);
    broken.generateStructured = async (req) => {
      if (req.task === 'script_editor') throw new ProviderUnavailableError('mock-llm', 'editor outage');
      return orig(req);
    };
    const r2 = new PipelineRunner(cfg, await memoryRepo(cfg), { ...bundle, verifierLlm: broken });
    const j2 = await r2.createJob();
    const f2 = await r2.run(j2.id);
    expect(f2).toMatchObject({ state: 'FAILED', failedStage: 'SCRIPTING', errorKind: 'PROVIDER_UNAVAILABLE', retryable: true });
  }, 300_000);

  it('editor calls are recorded in the provider cost ledger', async () => {
    const cfg = testConfig({ APPROVAL_IDEA: 'auto', APPROVAL_SCRIPT: 'manual' });
    const repo = await memoryRepo(cfg);
    const runner = new PipelineRunner(cfg, repo, { mode: 'mock' });
    const job = await runner.createJob();
    expect((await runner.run(job.id)).state).toBe('AWAITING_SCRIPT_APPROVAL');
    const runs = await repo.providerRunSummary(job.id);
    expect(runs.find((r) => r.operation === 'llm:script_editor')).toMatchObject({ calls: 1, errors: 0 });
  }, 300_000);
});

// =============================================================================
// P3 — Full-bleed framing
// =============================================================================

/** RGB24 thumbnail with a bright, textured block between x0 and x1 (fractions of the width). */
function frameWithBlock(w: number, h: number, x0: number, x1: number): Buffer {
  const b = Buffer.alloc(w * h * 3, 40);
  for (let y = 0; y < h; y++) for (let x = Math.round(x0 * w); x < Math.round(x1 * w); x++) {
    const v = (x + y) % 2 === 0 ? 250 : 10;
    b[(y * w + x) * 3] = v;
    b[(y * w + x) * 3 + 1] = v;
    b[(y * w + x) * 3 + 2] = v;
  }
  return b;
}

describe('full-bleed framing (P3)', () => {
  const opts = { outWidth: 1080, outHeight: 1920, maxUpscale: 2 };
  it('portrait fills the frame; landscape is cropped where the subject is, not blindly centered', () => {
    expect(chooseFraming({ width: 1080, height: 1920 }, [], opts)).toMatchObject({ mode: 'cover', upscale: 1 });
    const left = [0, 1, 2].map(() => ({ rgb: frameWithBlock(160, 90, 0.05, 0.25), w: 160, h: 90 }));
    const d = chooseFraming({ width: 1920, height: 1080 }, left, opts);
    expect(d.mode).toBe('crop_pan');
    expect(d.centerStart).toBeLessThan(0.3);
    expect(d.centerStart).toBe(d.centerEnd);
    expect(d.upscale).toBeCloseTo(1.778, 2);
  });
  it('follows a moving subject with a restrained pan', () => {
    const moving = [0.05, 0.35, 0.7].map((x) => ({ rgb: frameWithBlock(160, 90, x, x + 0.2), w: 160, h: 90 }));
    const d = chooseFraming({ width: 1920, height: 1080 }, moving, opts);
    expect(d.centerEnd).toBeGreaterThan(d.centerStart);
    expect(d.centerEnd - d.centerStart).toBeLessThanOrEqual(0.25 + 1e-9);
  });
  it('letterboxes only when cropping would over-upscale or destroy an ultra-wide picture', () => {
    expect(chooseFraming({ width: 1280, height: 720 }, [], opts)).toMatchObject({ mode: 'letterbox' });
    expect(chooseFraming({ width: 1280, height: 720 }, [], opts).reason).toMatch(/upscale 2\.67/);
    expect(chooseFraming({ width: 5000, height: 1100 }, [], opts)).toMatchObject({ mode: 'letterbox' });
    expect(chooseFraming({ width: 5000, height: 1100 }, [], opts).reason).toMatch(/ultra-wide/);
  });

  it('renders the off-center subject full-frame (no blurred band) and QA reports full-bleed and upscale', async () => {
    const dir = tmp('framing');
    // Landscape 1920x1080 clip: bright textured block on the left fifth, dark elsewhere.
    const src = path.join(dir, 'left.mp4');
    await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=0x202020:s=1920x1080:d=3', '-f', 'lavfi', '-i', 'testsrc2=s=380x1080:d=3', '-filter_complex', '[0][1]overlay=40:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', src]);
    const cfg = testConfig();
    const script = ShortScriptSchema.parse({
      id: randomUUID(), storyId: randomUUID(), topicId: randomUUID(), title: 'Framing test', description: 'd', hookText: 'One scene here.', format: 'STORY', targetDurationSeconds: 30, totalWords: 9, createdAt: new Date().toISOString(),
      scenes: ['One scene here.', 'Two scenes here.', 'Three scenes here.'].map((n, i) => ({ sceneNumber: i + 1, narration: n, visualObjective: 'x', assetKeywords: ['test'] })),
    });
    const narration = await new VoiceAgent(new MockTTSProvider(), { targetLufs: -14, toleranceLu: 2, minSeconds: 1, maxSeconds: 60, tailSeconds: 0.6, ttsCacheDir: path.join(dir, 'tts') }).generateVoiceover(script, path.join(dir, 'audio'));
    const timeline = buildTimeline(script, narration, { fps: 30, tailSeconds: 0.6 });
    const probe = await summarizeMedia(src);
    const asset = {
      id: randomUUID(), assetType: 'VIDEO' as const, provider: 'fixture', providerAssetId: 'left', sourceUrl: 'https://x/left.mp4', pageUrl: 'https://x/left', license: 'fixture', licenseVerified: true,
      commercialUseAllowed: true, attributionRequired: false, width: 1920, height: 1080, localPath: src, sha256: 'a'.repeat(64), sceneNumber: 1, shotIndex: 0,
      probe: { width: 1920, height: 1080, durationSeconds: probe.durationSeconds, hasAudio: false, codec: 'h264', fps: 30 },
      ranking: { score: 1, relevance: 1, matchedTerms: [], orientation: 0.3, resolution: 1, duration: 1, reasons: [] },
      visualValidation: { frames: [], defects: [], semantic: null, decision: 'ACCEPTED' as const },
      framing: { mode: 'crop_pan' as const, centerStart: 0.117, centerEnd: 0.117, upscale: 1.778, reason: 'fixture: subject on the left' },
      retrievedAt: new Date().toISOString(), metadata: {},
    };
    const assets = timeline.shots.map((sh) => ({ ...asset, id: randomUUID(), sceneNumber: sh.sceneNumber, shotIndex: sh.shotIndex }));
    const out = await new VideoRenderer().render({ script, timeline, narration, assets: assets as never, renderDir: path.join(dir, 'render'), fontFile: FONT });
    // The left block (testsrc2 colour bars) now fills the frame: the top band is bright and colourful, not a dark blur.
    const top = await runFfmpeg(['-nostats', '-ss', '1', '-i', out.render.videoPath, '-vf', 'crop=1080:200:0:0,signalstats,metadata=print', '-frames:v', '1', '-f', 'null', '-']);
    const yavg = Number(top.stderr.match(/lavfi\.signalstats\.YAVG=([\d.]+)/)?.[1] ?? 0);
    expect(yavg).toBeGreaterThan(60);
    const report = await evaluateMedia({
      videoPath: out.render.videoPath, uncaptionedPath: out.uncaptionedPath, narration, timeline, renderDir: path.join(dir, 'render'),
      limits: { minSeconds: 1, maxSeconds: 60, targetLufs: -14, toleranceLu: 2, fullBleedMinRatio: 0.9, maxUpscale: 2 },
      framing: [{ label: '1.0', mode: 'crop_pan', upscale: 1.778, reason: 'fixture' }],
    });
    expect(report.checks.find((c) => c.id === 'video.fullBleed')).toMatchObject({ status: 'PASS' });
    expect(report.checks.find((c) => c.id === 'video.upscale')).toMatchObject({ status: 'PASS' });
    const boxed = await evaluateMedia({
      videoPath: out.render.videoPath, narration, timeline, renderDir: path.join(dir, 'render'),
      limits: { minSeconds: 1, maxSeconds: 60, targetLufs: -14, toleranceLu: 2, fullBleedMinRatio: 0.9, maxUpscale: 2 },
      framing: [{ label: '1.0', mode: 'letterbox', upscale: 0.84, reason: 'crop would upscale 2.67×' }, { label: '1.1', mode: 'crop_pan', upscale: 2.6, reason: 'bad' }],
    });
    expect(boxed.checks.find((c) => c.id === 'video.fullBleed')).toMatchObject({ status: 'WARN', reviewRequired: true });
    expect(boxed.checks.find((c) => c.id === 'video.upscale')).toMatchObject({ status: 'FAIL' });
  }, 300_000);
});

// =============================================================================
// P4 — Narration continuity and pacing
// =============================================================================

describe('narration continuity (P4)', () => {
  const words = [
    { word: 'Jets', start: 0.6, end: 0.9 },
    { word: 'turn.', start: 0.95, end: 1.3 },
    { word: 'Routes', start: 2.2, end: 2.6 },
    { word: 'matter.', start: 2.65, end: 3.1 },
  ];
  it('trims the lead and long gaps, keeps word durations, and realigns every timestamp', () => {
    const plan = planGapTightening(words, 4.5, { leadSeconds: 0.08, gapTargetSeconds: 0.22, tailSeconds: 0.4 });
    expect(plan.leadingTrimmedSeconds).toBeCloseTo(0.52, 3);
    expect(plan.gapsTightened).toBe(1);
    expect(plan.words[0].start).toBeCloseTo(0.08, 3);
    expect(plan.maxGapAfterSeconds).toBeLessThanOrEqual(0.22 + 1e-9);
    plan.words.forEach((w, i) => expect(w.end - w.start).toBeCloseTo(words[i].end - words[i].start, 3));
    expect(plan.durationAfter).toBeCloseTo(plan.words[3].end + 0.4, 3);
    // Cuts sit inside gaps only: no cut overlaps a word.
    for (const c of plan.cuts) for (const w of words) expect(c.end <= w.start + 1e-9 || c.start >= w.end - 1e-9).toBe(true);
  });

  it('applies cuts to PCM without touching speech (tone bursts survive intact)', () => {
    const sr = 8000;
    const samples = new Int16Array(sr * 4.5);
    for (const w of words) for (let i = Math.round(w.start * sr); i < Math.round(w.end * sr); i++) samples[i] = Math.round(10000 * Math.sin((2 * Math.PI * 300 * i) / sr));
    const plan = planGapTightening(words, 4.5, { leadSeconds: 0.08, gapTargetSeconds: 0.22, tailSeconds: 0.4 });
    const out = applyCuts({ sampleRate: sr, channels: 1, samples }, plan.cuts);
    expect(out.samples.length / sr).toBeCloseTo(plan.durationAfter, 2);
    for (const w of plan.words) {
      const seg = out.samples.slice(Math.round((w.start + 0.01) * sr), Math.round((w.end - 0.01) * sr));
      expect(Math.max(...Array.from(seg, (x) => Math.abs(x)))).toBeGreaterThan(9000);
    }
    const f = path.join(tmp('wav'), 'x.wav');
    writeWavPcm16(f, out);
    expect(readWavPcm16(f).samples.length).toBe(out.samples.length);
  });

  /** TTS with a slow start and long pauses after every sentence. */
  class GappyTTS implements TTSProvider {
    readonly name = 'gappy';
    readonly voiceId = 'v';
    readonly modelId = 'gappy-1';
    readonly settingsKey = 'g';
    private readonly inner = new MockTTSProvider();
    async synthesize(req: TTSRequest): Promise<TTSResult> {
      const base = await this.inner.synthesize(req);
      // Shift: 0.6 s lead, +0.9 s after every sentence end.
      const pcm = (() => {
        const f = path.join(tmp('gappy'), 'b.wav');
        fs.writeFileSync(f, base.audio);
        return readWavPcm16(f);
      })();
      const sr = pcm.sampleRate;
      const a = base.alignment;
      const extra: number[] = [];
      let shift = 0.6;
      const starts: number[] = [];
      const ends: number[] = [];
      a.characters.forEach((ch, i) => {
        starts.push(a.startTimes[i] + shift);
        ends.push(a.endTimes[i] + shift);
        if (/[.!?]/.test(ch) && i < a.characters.length - 1) {
          extra.push(a.endTimes[i]);
          shift += 0.9;
        }
      });
      const out: number[] = new Array(Math.round(0.6 * sr)).fill(0);
      let cursor = 0;
      for (const t of extra) {
        const k = Math.round(t * sr);
        out.push(...pcm.samples.slice(cursor, k));
        out.push(...new Array(Math.round(0.9 * sr)).fill(0));
        cursor = k;
      }
      out.push(...pcm.samples.slice(cursor));
      const f = path.join(tmp('gappy'), 'o.wav');
      writeWavPcm16(f, { ...pcm, samples: Int16Array.from(out) });
      return { ...base, audio: fs.readFileSync(f), alignment: { characters: a.characters, startTimes: starts, endTimes: ends } };
    }
  }

  const story = (): ShortScript =>
    ShortScriptSchema.parse({
      id: randomUUID(), storyId: randomUUID(), topicId: randomUUID(), title: 'Continuity', description: 'd', hookText: 'Jets turn right.', format: 'STORY', targetDurationSeconds: 30, totalWords: 9, createdAt: new Date().toISOString(),
      scenes: ['Jets turn right.', 'Routes keep them apart.', 'Homes stay quiet.'].map((n, i) => ({ sceneNumber: i + 1, narration: n, visualObjective: 'x', assetKeywords: ['jet'] })),
    });
  const voice = (dir: string, continuity = true) =>
    new VoiceAgent(new GappyTTS(), {
      targetLufs: -14, toleranceLu: 2, minSeconds: 1, maxSeconds: 60, tailSeconds: 0.6, ttsCacheDir: path.join(dir, 'tts'),
      ...(continuity ? { continuity: { leadSeconds: 0.08, gapTargetSeconds: 0.22, tailSeconds: 0.4, speechStartMax: 0.3, maxGap: 0.4 } } : {}),
    });

  it('acoustic pass: a pause the alignment hides inside word boundaries is still cut to the target (regression: live 0.41 s gaps)', async () => {
    const sr = 48000;
    const tone = (sec: number) => Array.from({ length: Math.round(sec * sr) }, (_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / sr)));
    const silence = (sec: number) => new Array(Math.round(sec * sr)).fill(0);
    const f = path.join(tmp('hidden'), 'n.wav');
    writeWavPcm16(f, { sampleRate: sr, channels: 1, samples: Int16Array.from([...tone(1), ...silence(0.6), ...tone(1), ...silence(0.3)]) });
    // Alignment claims only 0.1 s between the words (it attributes the pause to them).
    const words = [{ word: 'Jets', start: 0, end: 1.25 }, { word: 'turn', start: 1.35, end: 2.6 }];
    expect(planGapTightening(words, 2.9, { leadSeconds: 0.08, gapTargetSeconds: 0.22, tailSeconds: 0.4 }).cuts).toHaveLength(0);
    const measured = await detectSilence(f, -45, 0.22);
    const plan = cutSilencesWav(f, measured, words, 0.22);
    expect(plan.cuts).toHaveLength(1);
    expect(plan.secondsRemoved).toBeCloseTo(0.38, 1);
    const after = (await detectSilence(f, -45, 0.05)).filter((x) => x.end < plan.words[1].end);
    expect(Math.max(...after.map((x) => x.end - x.start))).toBeLessThanOrEqual(0.25);
    // The second word moved by exactly what was removed before it, so captions stay in sync.
    expect(plan.words[1].end).toBeCloseTo(2.6 - plan.secondsRemoved, 2);
  });

  it('VoiceAgent: speech starts by 0.3 s, no dead air, captions stay synchronized with the processed narration', async () => {
    const dir = tmp('cont');
    const n = await voice(dir).generateVoiceover(story(), path.join(dir, 'audio'));
    expect(n.wordTimestamps[0].start).toBeLessThanOrEqual(0.3);
    expect(n.processing).toMatchObject({ gapsTightened: 2 });
    expect(n.processing!.secondsRemoved).toBeGreaterThan(2);
    expect(n.processing!.maxGapAfterSeconds).toBeLessThanOrEqual(0.4);
    // Captions are derived from the realigned words: every cue starts exactly at its first word.
    const timeline = buildTimeline(story(), n, { fps: 30, tailSeconds: 0.6 });
    for (const c of timeline.captions) expect(c.start).toBeCloseTo(n.wordTimestamps[c.firstWordIndex].start, 6);
    for (let i = 1; i < timeline.captions.length; i++) expect(timeline.captions[i].start).toBeGreaterThanOrEqual(timeline.captions[i - 1].end - 1e-9);
    // Duration of the processed audio matches the realigned last word + tail.
    const lastEnd = n.wordTimestamps[n.wordTimestamps.length - 1].end;
    expect(n.durationSeconds).toBeGreaterThan(lastEnd);
    expect(n.durationSeconds).toBeLessThanOrEqual(lastEnd + 0.4 + 0.02);
  }, 120_000);

  it('without the continuity stage the same narration fails the speech-start and continuity QA (measured on the stem)', async () => {
    const dir = tmp('cont2');
    const n = await voice(dir, false).generateVoiceover(story(), path.join(dir, 'audio'));
    const timeline = buildTimeline(story(), n, { fps: 30, tailSeconds: 0.6 });
    const assets = (await new VisualDirectorAgent(new MockAssetProvider(), { mediaCacheDir: cacheDir(testConfig().outputDir, 'media'), minRelevance: 0.3, maxDownloadBytes: 1e9 }).collectAssets(story(), timeline, path.join(dir, 'media'))).assets;
    const out = await new VideoRenderer().render({ script: story(), timeline, narration: n, assets, renderDir: path.join(dir, 'render'), fontFile: FONT });
    const r = await evaluateMedia({
      videoPath: out.render.videoPath, narration: n, timeline, renderDir: path.join(dir, 'render'),
      limits: { minSeconds: 1, maxSeconds: 60, targetLufs: -14, toleranceLu: 2, speechStartMax: 0.3, maxSpeechGap: 0.4, paceMin: 2.6, paceMax: 3.0 },
    });
    expect(r.checks.find((c) => c.id === 'audio.speechStart')?.status).toBe('FAIL');
    expect(r.checks.find((c) => c.id === 'audio.speechContinuity')?.status).toBe('FAIL');
    expect(r.checks.find((c) => c.id === 'audio.pace')).toMatchObject({ status: 'WARN', reviewRequired: true, blocking: false });
  }, 300_000);
});

// =============================================================================
// P5 — Clause-level beats
// =============================================================================

describe('clause-level visual beats (P5)', () => {
  it('repairs too-short and duplicate-subject beats by joining exact neighbours (regression: live drafts failed on 2-word beats)', () => {
    const beat = (text: string, visualSubject: string) => ({ text, visualSubject, assetKeywords: [visualSubject], visualIntent: 'x', visualExclusions: [] });
    const scenes = [
      {
        narration: 'Trains lean into curves, so riders stay seated. Engineers tilt the track.',
        visualObjective: 'x', assetKeywords: ['train'], claimRefs: [],
        beats: [beat('Trains lean into curves,', 'train on curve'), beat('so riders stay seated.', 'train passengers'), beat('Engineers tilt', 'railway track'), beat('the track.', 'railway track')],
      },
      {
        // Not an exact split: left alone for the writer to fix.
        narration: 'Ships turn slowly.', visualObjective: 'x', assetKeywords: ['ship'], claimRefs: [],
        beats: [beat('Ships', 'ship'), beat('turn quickly.', 'ship turning')],
      },
    ];
    expect(mergeShortBeats(scenes as never, [3, 12])).toBe(1);
    expect(scenes[0].beats.map((b) => b.text)).toEqual(['Trains lean into curves,', 'so riders stay seated.', 'Engineers tilt the track.']);
    expect(scenes[0].beats[2].visualSubject).toBe('railway track');
    expect(scenes[1].beats).toHaveLength(2);
    // A join that would exceed the maximum is left for the validator.
    const long = [{ narration: 'one two three four five six seven eight nine ten eleven. Twelve thirteen.', visualObjective: 'x', assetKeywords: ['x'], claimRefs: [], beats: [beat('one two three four five six seven eight nine ten eleven.', 'a'), beat('Twelve thirteen.', 'b')] }];
    expect(mergeShortBeats(long as never, [3, 12])).toBe(0);
    expect(mergeShortBeats(scenes as never, [3, 12])).toBe(0);
  });

  it('beats are planned in a second call on the frozen narration: a beat defect is retried without rewriting the narration', async () => {
    const cfg = testConfig({ APPROVAL_IDEA: 'auto' });
    const calls: Record<string, number> = {};
    const prompts: string[] = [];
    const llm: MockLLMProvider = new MockLLMProvider({}, {
      script_beats: (prompt: string) => {
        calls.script_beats = (calls.script_beats ?? 0) + 1;
        prompts.push(prompt);
        const plan = (llm as unknown as { route: (t: string, p: string) => { scenes: Array<{ beats: Array<{ text: string }> }> } }).route('script_beats', prompt);
        // First plan rewrites a word of the narration: rejected, and the narration is not regenerated.
        if (calls.script_beats === 1) plan.scenes[1].beats[0].text = `Reworded ${plan.scenes[1].beats[0].text}`;
        return plan;
      },
    });
    const orig = llm.generateStructured.bind(llm);
    llm.generateStructured = async (req) => {
      if (req.task === 'script') calls.scriptRequests = (calls.scriptRequests ?? 0) + 1;
      return orig(req);
    };
    const bundle = createProviders(cfg, 'mock');
    const runner = new PipelineRunner(cfg, await memoryRepo(cfg), { ...bundle, llm });
    const job = await runner.createJob();
    const out = await runner.run(job.id);
    expect(out.state).toBe('AWAITING_SCRIPT_APPROVAL');
    expect(calls.scriptRequests).toBe(1);
    expect(calls.script_beats).toBe(2);
    // The retry prompt carries the same narration as the first one.
    expect(prompts[1]).toContain(prompts[0].split('HARD RULES')[0].trim());
  }, 300_000);

  it('stock searches wait for the rolling per-minute limit instead of hitting HTTP 429 (regression: per-beat preflight was throttled live)', async () => {
    resetPixabayThrottle();
    let t = 1_000_000;
    const sleeps: number[] = [];
    const sleep = async (ms: number) => { sleeps.push(ms); t += ms; };
    for (let i = 0; i < 3; i++) expect(await pixabayThrottle(3, () => t, sleep)).toBe(0);
    t += 10_000;
    const waited = await pixabayThrottle(3, () => t, sleep);
    expect(waited).toBe(50_050);
    expect(sleeps).toEqual([50_050]);
    resetPixabayThrottle();
  });

  it('re-cuts beat texts from the narration when they differ only in case or typography, and adds a short missing tail (regression: 4 identical rejections)', () => {
    const beat = (text: string, visualSubject: string) => ({ text, visualSubject, assetKeywords: [visualSubject], visualIntent: 'x', visualExclusions: [] });
    const narration = 'Over 617,000 U.S. bridges connect us — across rivers and busy highways.';
    const scene = { narration, visualObjective: 'x', assetKeywords: ['x'], claimRefs: [], beats: [beat('over 617,000 US bridges', 'bridge'), beat('connect us across rivers', 'river'), beat('and busy highways', 'highway')] };
    expect(canonicalizeBeats(scene, 12)).toBe(true);
    expect(scene.beats.map((b) => b.text)).toEqual(['Over 617,000 U.S. bridges', 'connect us — across rivers', 'and busy highways.']);
    expect(validateBeats([scene], [3, 12])).toEqual([]);
    const tail = { ...scene, beats: [beat('Over 617,000 U.S. bridges', 'bridge'), beat('connect us — across rivers', 'river')] };
    expect(canonicalizeBeats(tail, 12)).toBe(true);
    expect(tail.beats[1].text).toBe('connect us — across rivers and busy highways.');
    // A changed word is not repaired; the validator names it.
    const changed = { ...scene, beats: [beat('Over 617,000 U.S. bridges', 'bridge'), beat('link us — across rivers and busy highways.', 'river')] };
    expect(canonicalizeBeats(changed, 12)).toBe(false);
    expect(validateBeats([changed], [3, 12]).join()).toMatch(/word 5 is "link" but the narration says "connect"/);
  });

  it('regroups beats returned under the wrong scene only when they tile the narration exactly (regression: all beats in one scene)', () => {
    const narr = ['Jets turn right after takeoff.', 'Controllers assign each jet a heading.'];
    const b = (text: string) => ({ text });
    expect(regroupBeats(narr, [b('Jets turn right'), b('after takeoff.'), b('Controllers assign'), b('each jet a heading.')])!.map((s) => s.map((x) => x.text))).toEqual([
      ['Jets turn right', 'after takeoff.'],
      ['Controllers assign', 'each jet a heading.'],
    ]);
    expect(regroupBeats(narr, [b('Jets turn right after'), b('takeoff. Controllers assign each jet a heading.')])).toBeNull(); // crosses a boundary
    expect(regroupBeats(narr, [b('Jets turn right after takeoff.')])).toBeNull(); // incomplete
    expect(regroupBeats(narr, [b('Jets turn left after takeoff.'), b('Controllers assign each jet a heading.')])).toBeNull(); // changed word
  });

  it('preflight failures name the tags stock actually uses for that search', async () => {
    const provider = {
      name: 'tags',
      search: async () =>
        [1, 2, 3, 4].map((i) => ({
          provider: 'tags', providerMediaId: String(i), mediaType: 'VIDEO' as const, pageUrl: `https://x/${i}`, downloadUrl: `https://x/${i}.mp4`, aspectRatio: 0.5625, commercialUseAllowed: true,
          width: 1080, height: 1920, durationSeconds: 10, tags: ['highway', 'traffic', 'road', ...(i % 2 ? ['night'] : [])], description: 'cars', license: 'pixabay', attributionRequired: false,
        })),
      download: async () => { throw new Error('not used'); },
    };
    const v = await visualPreflight(provider as never, [{ label: 'scene 1 beat 2', visualSubject: 'deserted highway', assetKeywords: ['highway'], visualExclusions: [] }], { minRelevance: 0.1, maxDownloadBytes: 1e9, minCandidates: 2 });
    expect(v[0]).toMatch(/scene 1 beat 2 visualSubject "deserted highway" matches only 0/);
    expect(v[0]).toMatch(/tags on the stock clips these searches found: "highway", "road", "traffic", "night"/);
    // "highway" (a word of the failing subject) has enough clips on its own: say so.
    expect(v[0]).toMatch(/on its own, "highway" has enough footage/);
  });

  const beatScript = (): ShortScript =>
    ShortScriptSchema.parse({
      id: randomUUID(), storyId: randomUUID(), topicId: randomUUID(), title: 'Beats', description: 'd', hookText: 'Airliners turn right after takeoff,', format: 'MICRO_EXPLAINER', targetDurationSeconds: 30, totalWords: 30, createdAt: new Date().toISOString(),
      scenes: [
        {
          sceneNumber: 1,
          narration: 'Airliners turn right after takeoff, then climb over the bay toward the open sea.',
          visualObjective: 'x', visualSubject: 'airliner climbing out', assetKeywords: ['airliner', 'takeoff'],
          beats: [
            { text: 'Airliners turn right after takeoff,', visualSubject: 'airliner banking right', assetKeywords: ['airliner banking'] },
            { text: 'then climb over the bay toward the open sea.', visualSubject: 'jet over ocean', assetKeywords: ['jet over ocean'] },
          ],
        },
        {
          sceneNumber: 2,
          narration: 'Ok.',
          visualObjective: 'x', visualSubject: 'control tower', assetKeywords: ['control tower'],
          beats: [{ text: 'Ok.', visualSubject: 'control tower', assetKeywords: ['control tower'] }],
        },
        {
          sceneNumber: 3,
          narration: 'Homes below stay quiet.',
          visualObjective: 'x', visualSubject: 'suburban houses', assetKeywords: ['suburban houses'],
          beats: [{ text: 'Homes below stay quiet.', visualSubject: 'suburban houses', assetKeywords: ['suburban houses'] }],
        },
      ],
    });
  const words = (script: ShortScript) => {
    let t = 0.05;
    return script.scenes.flatMap((s) => s.narration.split(/\s+/)).map((w) => {
      const start = t;
      t += 0.4;
      return { word: w, start, end: start + 0.35 };
    });
  };
  const narr = (script: ShortScript) => {
    const ws = words(script);
    return VoiceNarrationSchema.parse({
      id: randomUUID(), scriptId: script.id, provider: 'x', voiceId: 'x', modelId: 'x', audioPath: 'x.wav', rawAudioPath: 'x.wav', durationSeconds: ws[ws.length - 1].end + 0.3,
      sampleRate: 48000, channels: 1, codec: 'pcm_s16le', integratedLufs: -14, truePeakDb: -2, wordTimestamps: ws, sha256: 'a'.repeat(64), cacheKey: 'b'.repeat(64), synthesizedAt: new Date().toISOString(),
    });
  };

  it('cuts on beat boundaries, merges beats too short to register, and records word ranges', () => {
    const s = beatScript();
    const t = buildTimeline(s, narr(s), { fps: 30, tailSeconds: 0.6, minShotSeconds: 1.6, maxShotSeconds: 4 });
    const scene1 = t.shots.filter((x) => x.sceneNumber === 1);
    expect(scene1.map((x) => x.beatIndex)).toEqual([0, 1]);
    expect(scene1[0]).toMatchObject({ firstWordIndex: 0, lastWordIndex: 4 });
    expect(scene1[1]).toMatchObject({ firstWordIndex: 5 });
    // Shots are contiguous and cover the timeline.
    for (let i = 1; i < t.shots.length; i++) expect(t.shots[i].start).toBeCloseTo(t.shots[i - 1].end, 6);
    expect(t.shots[t.shots.length - 1].end).toBeCloseTo(t.totalDurationSeconds, 6);
    // A long beat is split into more than one shot, never longer than the maximum.
    const long = buildTimeline(s, narr(s), { fps: 30, tailSeconds: 0.6, minShotSeconds: 1.6, maxShotSeconds: 2 });
    expect(long.shots.filter((x) => x.sceneNumber === 1 && x.beatIndex === 1).length).toBeGreaterThan(1);
    for (const x of long.shots) expect(x.end - x.start).toBeLessThanOrEqual(2 + 1 / 30);
    // Short beats merge: with a 3 s minimum the two beats of scene 1 become one shot (first beat's subject).
    const merged = buildTimeline(s, narr(s), { fps: 30, tailSeconds: 0.6, minShotSeconds: 3, maxShotSeconds: 10 });
    expect(merged.shots.filter((x) => x.sceneNumber === 1).map((x) => x.beatIndex)).toEqual([0]);
  });

  it('sources each beat with its own literal subject; fallbacks are flagged for human review, never silent', async () => {
    const s = beatScript();
    const t = buildTimeline(s, narr(s), { fps: 30, tailSeconds: 0.6, minShotSeconds: 1.6, maxShotSeconds: 4 });
    const queries: string[] = [];
    const inner = new MockAssetProvider();
    // No footage for "jet over ocean": the beat falls back to the scene-level subject.
    const provider = { name: 'mock-stock', search: async (r: { query: string; mediaType: 'VIDEO' | 'IMAGE'; perPage?: number }) => (queries.push(r.query), /ocean/.test(r.query) ? [] : inner.search(r)), download: inner.download.bind(inner) };
    const { assets } = await new VisualDirectorAgent(provider as never, { mediaCacheDir: cacheDir(testConfig().outputDir, 'media'), minRelevance: 0.3, maxDownloadBytes: 1e9 }).collectAssets(s, t, tmp('beats'));
    expect(queries.some((q) => q.includes('airliner banking right'))).toBe(true);
    const beat2 = assets.find((a) => a.sceneNumber === 1 && a.shotIndex === 1)!;
    expect(beat2.visualValidation?.decision).toBe('NEEDS_REVIEW');
  }, 120_000);
});

// =============================================================================
// P6 — Title card
// =============================================================================

describe('title card (P6)', () => {
  it('is uppercase, at most two lines, fades, and only shows during the opening', () => {
    const ass = buildTitleAss('Why jets turn right after takeoff every time');
    expect(ass).toMatch(/Dialogue: 1,0:00:00\.00,0:00:02\.50,Title/);
    expect(ass).toMatch(/\\fad\(120,300\)/);
    expect((ass.match(/Title,,0,0,0,,(.*)$/m)![1].match(/\\N/g) ?? []).length).toBeLessThanOrEqual(1);
  });
  it('renders inside its safe area and is gone by 3 s', async () => {
    const dir = tmp('title');
    fs.mkdirSync(path.join(dir, 'fonts'));
    fs.copyFileSync(FONT, path.join(dir, 'fonts', path.basename(FONT)));
    fs.writeFileSync(path.join(dir, 'title.ass'), buildTitleAss('Why jets turn right'));
    const [shown, after] = await measureAssBoxes(dir, 'title.ass', [1.0, 3.0], 30, 4);
    const z = TITLE_CARD_LAYOUT.safeZone;
    expect(shown).not.toBeNull();
    expect(shown!.x1).toBeGreaterThanOrEqual(z.left);
    expect(shown!.x2).toBeLessThanOrEqual(z.right);
    expect(shown!.y1).toBeGreaterThanOrEqual(z.top);
    expect(shown!.y2).toBeLessThanOrEqual(z.bottom);
    expect(after).toBeNull();
  }, 60_000);
});

// =============================================================================
// Music infrastructure
// =============================================================================

describe('music bed', () => {
  async function library(entries: Array<Record<string, unknown>>, withFile = true): Promise<string> {
    const dir = tmp('music');
    if (withFile) await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'sine=f=220:d=12,volume=0.3', '-f', 'lavfi', '-i', 'sine=f=330:d=12,volume=0.2', '-filter_complex', 'amix=inputs=2', '-ar', '48000', path.join(dir, 'bed.wav')]);
    fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ tracks: entries }));
    return path.join(dir, 'library.json');
  }
  const track = { id: 'bed-1', file: 'bed.wav', title: 'Test Bed', source: 'test_fixture', licence: 'test fixture, generated', licenceEvidence: 'generated by the test with FFmpeg', attributionRequired: false, approved: true };

  it('loads only approved, evidenced, decodable tracks and reports every rejection', async () => {
    expect((await loadMusicLibrary(path.join(tmp('none'), 'library.json'))).problems[0]).toMatch(/no music library manifest/);
    const lib = await loadMusicLibrary(
      await library([
        track,
        { ...track, id: 'unapproved', approved: false },
        { ...track, id: 'attrib', attributionRequired: true },
        { ...track, id: 'nofile', file: 'missing.wav' },
        { ...track, id: 'noevidence', licenceEvidence: '' },
        { ...track, id: 'escape', file: '../bed.wav' },
      ])
    );
    expect(lib.tracks.map((t) => t.id)).toEqual(['bed-1']);
    expect(lib.problems.join(' | ')).toMatch(/unapproved: not approved/);
    expect(lib.problems.join(' | ')).toMatch(/attrib: requires attribution/);
    expect(lib.problems.join(' | ')).toMatch(/nofile: file missing/);
    expect(lib.problems.join(' | ')).toMatch(/invalid metadata/);
    expect(lib.problems.join(' | ')).toMatch(/escape: file must live inside/);
    expect(selectTrack(lib.tracks, 'job-a')!.id).toBe('bed-1');
    expect(selectTrack([], 'job-a')).toBeNull();
    expect(bedGainDb(-14, -20, 20)).toBe(-14);
  }, 60_000);

  it('mixes the bed under the narration with ducking; QA keeps the voice dominant and limits true peak', async () => {
    const dir = tmp('mix');
    const lib = await loadMusicLibrary(await library([track]));
    const script = ShortScriptSchema.parse({
      id: randomUUID(), storyId: randomUUID(), topicId: randomUUID(), title: 'Music', description: 'd', hookText: 'Jets turn right.', format: 'STORY', targetDurationSeconds: 30, totalWords: 9, createdAt: new Date().toISOString(),
      scenes: ['Jets turn right after takeoff.', 'Routes keep them apart from homes.', 'Controllers assign each jet a heading.'].map((n, i) => ({ sceneNumber: i + 1, narration: n, visualObjective: 'x', assetKeywords: ['jet'] })),
    });
    const n = await new VoiceAgent(new MockTTSProvider(), { targetLufs: -14, toleranceLu: 2, minSeconds: 1, maxSeconds: 60, tailSeconds: 0.6, ttsCacheDir: path.join(dir, 'tts') }).generateVoiceover(script, path.join(dir, 'audio'));
    const t = buildTimeline(script, n, { fps: 30, tailSeconds: 0.6 });
    const { assets } = await new VisualDirectorAgent(new MockAssetProvider(), { mediaCacheDir: cacheDir(testConfig().outputDir, 'media'), minRelevance: 0.3, maxDownloadBytes: 1e9 }).collectAssets(script, t, path.join(dir, 'media'));
    const tr = lib.tracks[0];
    const out = await new VideoRenderer().render({ script, timeline: t, narration: n, assets, renderDir: path.join(dir, 'render'), fontFile: FONT, music: { track: tr, gainDb: bedGainDb(n.integratedLufs, tr.integratedLufs, 20), bedLu: 20 } });
    expect(out.render.music).toMatchObject({ trackId: 'bed-1', licence: track.licence });
    const r = await evaluateMedia({
      videoPath: out.render.videoPath, uncaptionedPath: out.uncaptionedPath, narration: n, timeline: t, renderDir: path.join(dir, 'render'),
      limits: { minSeconds: 1, maxSeconds: 60, targetLufs: -14, toleranceLu: 2, truePeakMax: -1 },
      music: { requested: true, trackId: 'bed-1', gainDb: out.render.music!.gainDb, trackLufs: out.render.music!.trackLufs },
    });
    const c = (id: string) => r.checks.find((x) => x.id === id)!;
    expect(c('audio.musicBed').status).toBe('PASS');
    expect(c('audio.isNarration').status).toBe('PASS');
    expect(c('audio.voiceDominant').status).toBe('PASS');
    expect(c('audio.truePeak').status).toBe('PASS');
    expect(c('audio.loudness').status).toBe('PASS');

    // Negative: a bed as loud as the voice is caught (the narration would no longer dominate).
    const loud = await new VideoRenderer().render({ script, timeline: t, narration: n, assets, renderDir: path.join(dir, 'render-loud'), fontFile: FONT, music: { track: tr, gainDb: n.integratedLufs - tr.integratedLufs, bedLu: 0 } });
    const r2 = await evaluateMedia({
      videoPath: loud.render.videoPath, narration: n, timeline: t, renderDir: path.join(dir, 'render-loud'),
      limits: { minSeconds: 1, maxSeconds: 60, targetLufs: -14, toleranceLu: 2, truePeakMax: -1 },
      music: { requested: true, trackId: 'bed-1', gainDb: loud.render.music!.gainDb, trackLufs: loud.render.music!.trackLufs },
    });
    const dom = r2.checks.find((x) => x.id === 'audio.voiceDominant')!;
    expect(dom.status, dom.message).toBe('FAIL');
  }, 300_000);

  it('without an approved track the render records music as disabled and QA reports the criterion as NOT MET', async () => {
    const cfg = testConfig({ APPROVAL_IDEA: 'auto', APPROVAL_SCRIPT: 'auto', MUSIC_LIBRARY: path.join(tmp('nolib'), 'library.json') });
    const repo = await memoryRepo(cfg);
    const runner = new PipelineRunner(cfg, repo, createProviders(cfg, 'mock'));
    const job = await runner.createJob();
    const done = await runner.run(job.id);
    expect(done.state).toBe('AWAITING_FINAL_APPROVAL');
    const { RenderJobSchema, QAResultSchema } = await import('@shorts/schemas');
    const render = await repo.requireArtifact(done.artifacts.renderId, 'render', RenderJobSchema);
    expect(render.music).toBeNull();
    expect(render.musicDisabledReason).toMatch(/no approved music track/);
    const qa = await repo.requireArtifact(done.artifacts.qaId, 'qa', QAResultSchema);
    expect(qa.media.checks.find((x) => x.id === 'audio.musicBed')).toMatchObject({ status: 'WARN', blocking: false });
    expect(qa.media.checks.find((x) => x.id === 'audio.musicBed')!.message).toMatch(/NOT MET/);
    // Title card on by default: QA measured it.
    expect(qa.media.checks.find((x) => x.id === 'titleCard.layout')?.status).toBe('PASS');
    expect(qa.content.checks.find((x) => x.id === 'script.editor')?.status).toBe('PASS');
    expect(qa.media.checks.find((x) => x.id === 'video.fullBleed')?.status).toBe('PASS');
  }, 600_000);
});

// =============================================================================
// P7 — Production variants and experiments
// =============================================================================

describe('production variants and experiments (P7)', () => {
  it('parses one-factor experiments and rejects invalid ones', () => {
    expect(parseExperiment('hook-1|hookType|statement,question')).toEqual({ id: 'hook-1', factor: 'hookType', arms: ['statement', 'question'] });
    expect(parseExperiment('')).toBeNull();
    expect(() => parseExperiment('x|colour|red,blue')).toThrow(ConfigurationError);
    expect(() => parseExperiment('x|hookType|statement')).toThrow(/two distinct/);
    expect(() => parseExperiment('x|hookType|statement,shouting')).toThrow();
    expect(() => parseExperiment('x|voiceSpeed|1.0,1.5')).toThrow(/0.7-1.2/);
  });

  it('assigns arms round-robin, deterministically, changing exactly one factor', () => {
    const cfg = testConfig({ EXPERIMENT: 'tc-1|titleCard|true,false' });
    const a = [0, 1, 2, 3].map((n) => assignVariant(cfg, n));
    expect(a.map((v) => v.arm)).toEqual(['true', 'false', 'true', 'false']);
    expect(a.map((v) => v.titleCard)).toEqual([true, false, true, false]);
    for (const v of a) expect({ ...v, titleCard: true, arm: null, assignment: '', assignedAt: '' }).toEqual({ ...a[0], titleCard: true, arm: null, assignment: '', assignedAt: '' });
    expect(a[1].assignment).toMatch(/round-robin #2 of tc-1/);
  });

  it('the variant is frozen at job creation: resume never picks up changed configuration', async () => {
    const cfg = testConfig({ APPROVAL_IDEA: 'auto', APPROVAL_SCRIPT: 'manual', EXPERIMENT: 'hk|hookType|statement,scene' });
    const repo = await memoryRepo(cfg);
    const r1 = new PipelineRunner(cfg, repo, createProviders(cfg, 'mock'));
    const j = await r1.createJob();
    expect(j.artifacts.variant).toMatchObject({ experimentId: 'hk', factor: 'hookType', arm: 'statement', hookType: 'statement' });
    const second = await r1.createJob();
    expect(second.artifacts.variant).toMatchObject({ arm: 'scene', hookType: 'scene' });
    // Configuration changes before the job runs: a different runner/config must not alter the job.
    const cfg2 = testConfig({ APPROVAL_IDEA: 'auto', APPROVAL_SCRIPT: 'manual', HOOK_TYPE: 'question', TITLE_CARD: 'false', EXPERIMENT: '' });
    const r2 = new PipelineRunner(cfg2, repo, createProviders(cfg2, 'mock'));
    const waiting = await r2.run(j.id);
    expect(waiting.state).toBe('AWAITING_SCRIPT_APPROVAL');
    expect(waiting.artifacts.variant).toEqual(j.artifacts.variant);
    const script = await repo.requireArtifact(waiting.artifacts.scriptId, 'script', ShortScriptSchema);
    expect(script.hookType).toBe('statement');
    expect(script.titleCard).toBeTruthy();
  }, 300_000);

  it('legacy jobs without a variant get one recorded snapshot (and keep it)', async () => {
    const cfg = testConfig({ APPROVAL_IDEA: 'auto', APPROVAL_SCRIPT: 'manual' });
    const repo = await memoryRepo(cfg);
    const runner = new PipelineRunner(cfg, repo, createProviders(cfg, 'mock'));
    const j = await runner.createJob();
    const { variant: _drop, ...legacy } = j.artifacts;
    await repo.updateJobArtifacts(j.id, legacy);
    const after = await runner.run(j.id);
    expect(after.artifacts.variant?.assignment).toMatch(/legacy backfill/);
  }, 300_000);

  const row = (i: number, arm: string, views: number, pct?: number, engaged?: number): PerformanceRow => ({
    videoId: `v${i}`, title: `S${i}`, format: 'MICRO_EXPLAINER', cluster: 'aviation', pillar: 'ENGINEERING', words: 90, durationSeconds: 34, hookWords: 8, gapScore: 90,
    publishHour: 17, ageHours: 96, views, engagedViews: engaged, averageViewPercentage: pct, experimentId: 'hk', experimentFactor: 'hookType', arm, hookType: arm,
  });

  it('experiment report: insufficient data below 8 per arm; never claims significance; missing metrics are not invented', () => {
    const few = [...[1, 2, 3].map((i) => row(i, 'statement', 4000, 55)), ...[4, 5, 6].map((i) => row(i, 'scene', 1000, 50))];
    expect(experimentReport(few, 'hk')).toMatchObject({ status: 'insufficient data' });
    const lead = [...Array.from({ length: 8 }, (_, i) => row(i, 'statement', 4000 + i * 10, 55)), ...Array.from({ length: 8 }, (_, i) => row(100 + i, 'scene', 2000 + i * 10, 50))];
    const r = experimentReport(lead, 'hk');
    expect(r.status).toBe('provisional leader');
    expect(r.summary).toMatch(/Provisional/);
    expect(r.summary).toMatch(/n=8/);
    expect(r.arms[0].metric).toBe('viewsPerDay'); // engaged views missing → views, labelled as such
    const overlap = [...Array.from({ length: 8 }, (_, i) => row(i, 'statement', 1000 + i * 600, 55)), ...Array.from({ length: 8 }, (_, i) => row(100 + i, 'scene', 900 + i * 600, 50))];
    expect(experimentReport(overlap, 'hk').status).toBe('no clear difference');
    const worseRetention = [...Array.from({ length: 8 }, (_, i) => row(i, 'statement', 4000 + i, 30)), ...Array.from({ length: 8 }, (_, i) => row(100 + i, 'scene', 2000 + i, 60))];
    expect(experimentReport(worseRetention, 'hk').status).toBe('no clear difference');
    expect(analyzePerformance(lead).byVariant.hookType.map((g) => g.key).sort()).toEqual(['scene', 'statement']);
  });
});
