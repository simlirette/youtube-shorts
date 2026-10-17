import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { planGapTightening, repoRoot } from '@shorts/core';
import { BaseConfigSchema, VideoConfigSchema } from '@shorts/schemas';
import {
  buildCalloutOverlay,
  buildCaptionOverlay,
  buildHookOverlay,
  buildOutroOverlay,
  textFx,
  buildPointerOverlay,
  buildProgressOverlay,
  calloutEvents,
  captionCues,
  checkMechanismKit,
  effectiveConfig,
  findBlender,
  hookLine,
  hookTextFor,
  progressFit,
  lengthWarnings,
  loadBase,
  loadVideo,
  narrationText,
  overlayLayers,
  overlayPointers,
  placePills,
  planMechanism,
  planOptionsFor,
  progressSegments,
  retimeWords,
  splitPointerLabels,
  toMechanismSpec,
  verifyFrozen,
  wordsFromAlignment,
} from '@shorts/rendering';

const root = repoRoot();
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'base-regression', name), 'utf-8'));

/** The planner's input exactly as `pnpm video` computes it, from saved narration (no credits, no Blender). */
function planFor(slug: 'four-stroke-engine' | 'dam', mutate?: (v: any) => void) {
  const loaded = loadVideo(path.join(root, 'videos', slug, 'video.json'));
  if (mutate) mutate(loaded.video);
  const base = loadBase(loaded.video.base);
  const cfg = effectiveConfig(base, loaded.video);
  const spec = toMechanismSpec(loaded.video, base);
  const saved = fixture(`${slug}.narration.json`);
  const raw = wordsFromAlignment(saved.characters, saved.startTimes, saved.endTimes);
  const cut = planGapTightening(raw.map((w) => ({ word: w.word, start: w.start, end: w.end })), saved.audioDurationSeconds, { leadSeconds: base.voice.leadSeconds, gapTargetSeconds: base.voice.pauseTargetSeconds, tailSeconds: base.voice.tailSeconds });
  const words = retimeWords(raw, cut.words);
  const plan = planMechanism(spec, words, cut.durationAfter, planOptionsFor(loaded.video, cfg));
  return { loaded, base, cfg, spec, words, plan, narration: narrationText(spec) };
}

/** Deep equality where numbers may differ by up to `eps`; everything else must be identical. */
function expectClose(actual: unknown, expected: unknown, eps: number, at = 'root'): void {
  if (typeof expected === 'number') {
    expect(typeof actual, at).toBe('number');
    expect(Math.abs((actual as number) - expected), `${at}: ${actual} vs ${expected}`).toBeLessThanOrEqual(eps);
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual), at).toBe(true);
    expect((actual as unknown[]).length, `${at} length`).toBe(expected.length);
    expected.forEach((e, i) => expectClose((actual as unknown[])[i], e, eps, `${at}[${i}]`));
  } else if (expected && typeof expected === 'object') {
    expect(Object.keys(actual as object).sort(), `${at} keys`).toEqual(Object.keys(expected).sort());
    for (const [k, v] of Object.entries(expected)) expectClose((actual as Record<string, unknown>)[k], v, eps, `${at}.${k}`);
  } else expect(actual, at).toEqual(expected);
}

describe('BASE v1: frozen visual layer', () => {
  it('is intact (mechanism.py, the Blender wrapper and the fonts match base/v1/frozen.json)', () => {
    expect(verifyFrozen(loadBase('v1'))).toEqual([]);
  });

  it('reports a file that is not in the manifest', () => {
    const base = loadBase('v1');
    const bad = { ...base, frozen: { ...base.frozen, files: [...base.frozen.files, 'package.json'] } };
    expect(verifyFrozen(bad)).toEqual(['package.json: not in frozen.json']);
  });
});

describe('regression: the four-stroke engine through the BASE', () => {
  it('produces exactly the Blender spec and timeline of the v3 render (3D scene, animation, lighting and camera unchanged)', () => {
    const { plan } = planFor('four-stroke-engine');
    const golden = JSON.parse(fs.readFileSync(path.join(root, 'base', 'v1', 'golden', 'four-stroke-engine.blender.json'), 'utf-8'));
    const timeline = JSON.parse(fs.readFileSync(path.join(root, 'base', 'v1', 'golden', 'four-stroke-engine.timeline.json'), 'utf-8'));
    // The saved audio is decoded to PCM in the real run, which rounds its length by a fraction of a millisecond;
    // anything under a tenth of a frame (3 ms) renders identical frames, so numbers are compared to within 1 ms.
    expectClose(plan.blender, golden, 1e-3);
    expect(Math.round(plan.blender.seconds * 30)).toBe(Math.round(golden.seconds * 30)); // the same number of frames
    expect(plan.seconds).toBeCloseTo(timeline.seconds, 2);
    expectClose(plan.beats.map((b) => [b.start, b.end]), timeline.beats.map((b: any) => [b.start, b.end]), 1e-3);
    // The per-video extras are absent for a built-in kit, so the cache key and the render are the same as before.
    expect(Object.keys(plan.blender)).not.toContain('events');
    expect(Object.keys(plan.blender)).not.toContain('max_speed');
  });

  it('keeps the original narration, in the same order', () => {
    const old = JSON.parse(fs.readFileSync(path.join(root, 'content', 'mechanisms', 'four-stroke-engine.json'), 'utf-8'));
    const { narration } = planFor('four-stroke-engine');
    expect(narration).toBe(old.beats.map((b: any) => b.text.trim()).join(' '));
    expect(fixture('four-stroke-engine.narration.json').text).toBe(narration);
  });

  it('uses the base voice settings (nothing per video)', () => {
    const { base, spec } = planFor('four-stroke-engine');
    expect(spec.voice).toEqual({ id: 'Ddh3PpD0pGS5vi20kePJ', model: 'eleven_multilingual_v2', stability: 0.3, style: 0.6 });
    expect(spec.speed).toBe(base.voice.speed);
  });
});

describe('config', () => {
  const raw = () => JSON.parse(fs.readFileSync(path.join(root, 'base', 'v1', 'base.json'), 'utf-8'));
  const videoRaw = () => JSON.parse(fs.readFileSync(path.join(root, 'videos', 'four-stroke-engine', 'video.json'), 'utf-8'));

  it('renders at 1080x1920, 30 fps, H.264 and rejects anything else', () => {
    const b = BaseConfigSchema.parse(raw());
    expect([b.render.width, b.render.height, b.render.fps, b.render.video.codec]).toEqual([1080, 1920, 30, 'libx264']);
    for (const bad of [{ width: 720, height: 1280 }, { fps: 24 }]) {
      const r = raw();
      Object.assign(r.render, bad);
      expect(() => BaseConfigSchema.parse(r)).toThrow();
    }
  });

  it('cannot override render or voice from a video, and rejects unknown keys', () => {
    for (const overrides of [{ render: { video: { crf: 30 } } }, { voice: { speed: 1.2 } }]) {
      const v = videoRaw();
      v.overrides = overrides;
      expect(() => VideoConfigSchema.parse(v)).toThrow();
    }
    const v = videoRaw();
    v.voice = { id: 'other-voice' };
    expect(() => VideoConfigSchema.parse(v)).toThrow();
  });

  it('applies allowed overrides key by key', () => {
    const { cfg } = planFor('four-stroke-engine', (v) => (v.overrides = { caption: { size_pct: 6.5 }, outro: { enabled: false } }));
    expect(cfg.captions.font).toEqual({ family: 'Montserrat', bold: true, sizePct: 6.5 }); // only sizePct changed
    expect(cfg.captions.colors.current).toBe('#FFD200');
  });

  it('builds all five hook formulas', () => {
    const f = loadBase('v1').hook.formulas;
    expect(hookLine(f, { formula: 'how_becomes', input: 'River', output: 'Power Station' })).toBe('How a River Becomes a Power Station');
    expect(hookLine(f, { formula: 'how_works', subject: 'a Turbocharger' })).toBe('How a Turbocharger Works');
    expect(hookLine(f, { formula: 'why', question: 'Do Planes Turn After Takeoff?' })).toBe('Why Do Planes Turn After Takeoff?');
    expect(hookLine(f, { formula: 'stat', stat: 'Your car engine only makes power 1 stroke out of 4!' })).toBe('Your car engine only makes power 1 stroke out of 4!');
    expect(hookLine(f, { formula: 'custom', text: 'Look at this' })).toBe('Look at this');
    expect(() => VideoConfigSchema.parse({ ...videoRaw(), hook: { formula: 'how_becomes', input: 'River' } })).toThrow();
  });
});

describe('overlays (all from config)', () => {
  const eventsOf = (ass: string, style: string) => ass.split('\n').filter((l) => l.startsWith('Dialogue:') && l.split(',')[3] === style);
  const hms = (t: string) => {
    const [h, m, s] = t.split(':');
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  };

  it('captions are 5-7% of the frame height, in the lower third, at most 3 words', () => {
    const { cfg, words } = planFor('four-stroke-engine');
    const ass = buildCaptionOverlay(captionCues(words, cfg.captions), words, cfg.captions);
    const size = Number(ass.split('\n').find((l) => l.startsWith('Style: Caption'))!.split(',')[2]);
    expect(size / 1920).toBeGreaterThanOrEqual(0.05);
    expect(size / 1920).toBeLessThanOrEqual(0.07);
    expect(cfg.captions.maxWordsPerCue).toBeLessThanOrEqual(3);
    const first = eventsOf(ass, 'Caption')[0];
    expect(first).toContain('\\an5\\pos(540,1459)'); // lower third (76%), not the middle
  });

  it('highlights exactly the word being spoken, from the ElevenLabs timestamps (word timing)', () => {
    const { cfg, words } = planFor('four-stroke-engine', (v) => (v.overrides = { captions: { hideDuringHook: false } }));
    const ass = buildCaptionOverlay(captionCues(words, cfg.captions), words, cfg.captions);
    const events = eventsOf(ass, 'Caption');
    expect(events).toHaveLength(words.length);
    events.forEach((e, i) => {
      const f = e.split(',');
      expect(hms(f[1])).toBeCloseTo(words[i].start, 1);
      const tokens = [...f.slice(9).join(',').matchAll(/\{\\c(&H[0-9A-F]+&)\}([^{]+)/g)].map((m) => ({ c: m[1], t: m[2].replace(/\\N/g, ' ').trim() }));
      const gold = tokens.filter((t) => t.c === '&H00D2FF&');
      expect(gold).toHaveLength(1);
      expect(gold[0].t).toBe(words[i].word);
    });
  });

  it('supports one word at a time, and a whole phrase with one static keyword', () => {
    const single = planFor('four-stroke-engine', (v) => (v.overrides = { captions: { layout: 'single', hideDuringHook: false } }));
    const sAss = buildCaptionOverlay(captionCues(single.words, single.cfg.captions), single.words, single.cfg.captions);
    const sEvents = eventsOf(sAss, 'Caption');
    expect(sEvents).toHaveLength(single.words.length);
    expect(sEvents.every((e) => [...e.matchAll(/\{\\c&H/g)].length === 1)).toBe(true);
    const phrase = planFor('four-stroke-engine', (v) => (v.overrides = { captions: { timing: 'phrase', hideDuringHook: false } }));
    const cues = captionCues(phrase.words, phrase.cfg.captions);
    const pEvents = eventsOf(buildCaptionOverlay(cues, phrase.words, phrase.cfg.captions), 'Caption');
    expect(pEvents).toHaveLength(cues.length);
  });

  it('never needs more lines than configured, even with the larger text', () => {
    const { cfg, words } = planFor('dam');
    const cues = captionCues(words, cfg.captions);
    expect(cues.every((c) => c.lines.length <= cfg.captions.maxLines)).toBe(true);
    const shown = cues.flatMap((c) => c.lines.flatMap((l) => l.split(' ')));
    expect(shown).toEqual(words.map((w) => w.word));
  });

  it('draws display text from captionText without moving the timing, and hides captions during the hook', () => {
    const { cfg, words, loaded } = planFor('dam');
    expect(loaded.video.captionText['forty-five']).toBe('45');
    const ass = buildCaptionOverlay(captionCues(words, cfg.captions), words, cfg.captions, { display: loaded.video.captionText, suppress: [[0, cfg.hook.seconds]] });
    const body = eventsOf(ass, 'Caption').map((e) => e.split(',').slice(9).join(','));
    expect(body.some((b) => /\}45(\s|\\|$)/.test(b))).toBe(true); // drawn as 45 ...
    expect(body.some((b) => /forty-five/.test(b))).toBe(false); // ... never as "forty-five"
    // The timing is the spoken word's: the "45" event starts when "forty-five" is said.
    const spoken = words.findIndex((w) => /forty-five/i.test(w.word));
    const ev = eventsOf(ass, 'Caption').find((e) => /\{\\c&H00D2FF&\}45/.test(e))!;
    expect(hms(ev.split(',')[1])).toBeCloseTo(words[spoken].start, 1);
    // Nothing is drawn while the hook is on screen, and no sliver is left at its edge.
    for (const e of eventsOf(ass, 'Caption')) {
      const f = e.split(',');
      expect(hms(f[1])).toBeGreaterThanOrEqual(cfg.hook.seconds - 0.001);
      if (Math.abs(hms(f[1]) - cfg.hook.seconds) < 0.001) expect(hms(f[2]) - hms(f[1])).toBeGreaterThanOrEqual(0.11); // the event clipped at the edge is not a flash
    }
  });

  it('shows a large centred hook line from the first frame, with numbers in the accent colour', () => {
    const { cfg, loaded, base } = planFor('four-stroke-engine');
    const text = hookTextFor(base, loaded.video);
    expect(text).toBe('Your car engine only makes power 1 stroke out of 4!');
    const ass = buildHookOverlay(text, cfg.hook);
    const ev = eventsOf(ass, 'Hook');
    expect(ev).toHaveLength(1);
    const f = ev[0].split(',');
    expect(hms(f[1])).toBe(0);
    expect(hms(f[2])).toBeCloseTo(cfg.hook.seconds, 2);
    expect(ev[0]).toContain('\\an5\\pos(540,768)'); // 40% down, centred
    expect(ev[0]).toContain('{\\c&H00D2FF&}1{');
    expect(Number(ass.split('\n').find((l) => l.startsWith('Style: Hook'))!.split(',')[2]) / 1920).toBeGreaterThan(0.05);
  });

  it('shows the progress tracker from frame 1 (all dim), then each step, then done', () => {
    const { cfg, plan, loaded } = planFor('four-stroke-engine');
    const steps = loaded.video.steps!;
    const segs = progressSegments(plan, steps, cfg.progress);
    expect(segs[0]).toMatchObject({ start: 0, index: -1 });
    expect(segs.map((s) => s.index)).toEqual([-1, 0, 1, 2, 3, steps.length]);
    expect(segs[segs.length - 1].end).toBeCloseTo(plan.seconds, 3);
    for (let i = 1; i < segs.length; i++) expect(segs[i].start).toBeCloseTo(segs[i - 1].end, 3);
    const ass = buildProgressOverlay(steps, segs, cfg.progress);
    const first = ass.split('\n').find((l) => l.startsWith('Dialogue:') && l.includes('0:00:00.00'))!;
    expect(first).toContain('\\fad(0,'); // no fade-in: visible on the very first frame
    for (const s of steps) expect(ass).toContain(s.toUpperCase());
    const hidden = planFor('four-stroke-engine', (v) => (v.overrides = { progress: { visibleFromStart: false, afterLast: 'hide' } }));
    const hs = progressSegments(hidden.plan, steps, hidden.cfg.progress);
    expect(hs[0].start).toBeGreaterThan(0);
    expect(hs.map((s) => s.index)).toEqual([0, 1, 2, 3]);
  });

  it('sizes the tracker labels to the number of steps: the four strokes are untouched, five longer steps shrink to fit', () => {
    const engine = planFor('four-stroke-engine');
    expect(progressFit(engine.loaded.video.steps!, engine.cfg.progress)).toBe(1);
    const dam = planFor('dam');
    const fit = progressFit(dam.loaded.video.steps!, dam.cfg.progress);
    expect(fit).toBeLessThanOrEqual(1);
    expect(fit).toBeGreaterThan(0.6);
    const size = (ass: string, style: string) => Number(ass.split('\n').find((l) => l.startsWith('Style: ' + style))!.split(',')[2]);
    const eng = buildProgressOverlay(engine.loaded.video.steps!, progressSegments(engine.plan, engine.loaded.video.steps!, engine.cfg.progress), engine.cfg.progress);
    const dm = buildProgressOverlay(dam.loaded.video.steps!, progressSegments(dam.plan, dam.loaded.video.steps!, dam.cfg.progress), dam.cfg.progress);
    expect(size(eng, 'StepOn')).toBe(Math.round((engine.cfg.progress.activeFont.sizePct / 100) * 1920)); // exactly the configured size
    expect(size(dm, 'StepOn')).toBeLessThanOrEqual(size(eng, 'StepOn'));
    // With the fit applied no active label reaches its neighbour: needed width <= gap for every step.
    const gap = (dam.cfg.progress.spreadPct / 100) * 1080 / (dam.loaded.video.steps!.length - 1);
    const on = 0.78 * ((dam.cfg.progress.activeFont.sizePct * fit * 19.2) / 1.22) + 3;
    const off = 0.78 * ((dam.cfg.progress.inactiveFont.sizePct * fit * 19.2) / 1.22) + 3;
    const steps = dam.loaded.video.steps!;
    steps.forEach((st, i) => expect(((st.length * on + Math.max(steps[i - 1]?.length ?? 0, steps[i + 1]?.length ?? 0) * off) / 2) * 1.08).toBeLessThanOrEqual(gap + 0.5));
  });

  it('keeps every tracker label inside the safe margin, sliding edge labels inward', () => {
    for (const slug of ['four-stroke-engine', 'dam'] as const) {
      const v = planFor(slug);
      const steps = v.loaded.video.steps!;
      const segs = progressSegments(v.plan, steps, v.cfg.progress);
      const ass = buildProgressOverlay(steps, segs, v.cfg.progress);
      const fit = progressFit(steps, v.cfg.progress);
      const labels = ass.split('\n').filter((l) => /^Dialogue: 2,/.test(l));
      expect(labels.length).toBeGreaterThan(0);
      for (const l of labels) {
        const style = l.split(',')[3];
        const x = Number(/\\pos\((\d+),/.exec(l)![1]);
        const text = l.replace(/^.*\}/, '');
        const font = style === 'StepOn' ? v.cfg.progress.activeFont : v.cfg.progress.inactiveFont;
        const half = (text.length * (0.78 * ((font.sizePct * fit * 19.2) / 1.22) + 3)) / 2;
        expect(x - half).toBeGreaterThanOrEqual(35);
        expect(x + half).toBeLessThanOrEqual(1080 - 35);
      }
    }
  });

  it('places yellow stat cards with a black outline at the right moments', () => {
    const { cfg, loaded, plan, words, narration } = planFor('four-stroke-engine');
    const ev = calloutEvents(loaded.video, cfg, words, plan, narration);
    expect(ev.map((e) => e.value)).toEqual(['1 in 4', '1/2 speed', '2 turns']);
    const b0 = plan.beats[0];
    expect(ev[0].start).toBeCloseTo(b0.start + 0.55 * (b0.end - b0.start), 3);
    const half = words.find((w) => w.charStart >= narration.toLowerCase().indexOf("half the crankshaft's speed"))!;
    expect(ev[1].start).toBeCloseTo(half.start, 3);
    const ass = buildCalloutOverlay(ev, cfg.callouts);
    expect(ass).toContain('\\c&H00D2FF&'); // yellow fill
    expect(ass).toContain('\\3c&H000000&'); // black outline
    expect(ass).toContain('1 in 4');
    expect(() => calloutEvents({ ...loaded.video, callouts: [{ value: 'A', at: { scene: 0, fraction: 0.5 } }, { value: 'B', at: { scene: 0, fraction: 0.55 } }] }, cfg, words, plan, narration)).toThrow(/overlap/);
    expect(() => calloutEvents({ ...loaded.video, callouts: [{ value: 'A', at: { phrase: 'a phrase nobody says' } }] }, cfg, words, plan, narration)).toThrow(/not in the narration/);
  });

  it('adds an outro by extending the video (tail mode) when enabled, and not for the engine', () => {
    const dam = planFor('dam');
    expect(dam.cfg.outro.enabled).toBe(true);
    expect(dam.plan.seconds - dam.words[dam.words.length - 1].end).toBeGreaterThanOrEqual(dam.cfg.outro.seconds);
    const engine = planFor('four-stroke-engine');
    expect(engine.cfg.outro.enabled).toBe(false);
    const ass = buildOutroOverlay(dam.plan.seconds - dam.cfg.outro.seconds, dam.plan.seconds, dam.cfg.outro);
    expect(ass).toContain('Follow for more machines');
  });
});

describe('per-video layer', () => {
  const dirs = fs.readdirSync(path.join(root, 'videos'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

  it('every video folder holds a valid video.json and at most its own kit.py (no copies of base code)', () => {
    expect(dirs).toEqual(expect.arrayContaining(['four-stroke-engine', 'dam']));
    for (const d of dirs) {
      const files = fs.readdirSync(path.join(root, 'videos', d));
      expect(files.filter((f) => f !== 'video.json' && f !== 'kit.py')).toEqual([]);
      const { video, kitFile } = loadVideo(path.join(root, 'videos', d, 'video.json'));
      expect(video.slug).toBe(d);
      if (kitFile) {
        const src = fs.readFileSync(kitFile, 'utf-8');
        expect(src).toContain('def build_kit');
        // A kit must build on the base's helpers, not redefine the studio.
        for (const forbidden of ['studio_setup', 'area_light(', 'def place_labels', 'scene.render.resolution', 'bpy.ops.render.render']) expect(src).not.toContain(forbidden);
      }
    }
  });

  it('the engine uses a built-in kit; the dam brings its own', () => {
    expect(loadVideo(path.join(root, 'videos', 'four-stroke-engine', 'video.json')).kitFile).toBeUndefined();
    expect(loadVideo(path.join(root, 'videos', 'dam', 'video.json')).kitFile).toMatch(/dam[\\/]kit\.py$/);
  });
});

describe('reusability proof: "How a Dam Becomes Electricity" from the base plus one config', () => {
  it('fits the 50-60 s target with the real narration timing and speeds up, never down', () => {
    const { plan, cfg, words } = planFor('dam');
    expect(lengthWarnings(plan.seconds, cfg)).toEqual([]);
    expect(plan.seconds).toBeGreaterThanOrEqual(50);
    expect(plan.seconds).toBeLessThanOrEqual(60);
    expect(words.length).toBeGreaterThan(150);
    plan.blender.drive.forEach((d) => expect(d.to).toBeGreaterThanOrEqual(d.from));
    // Shaft angle per frame stays under half the 45 degree magnet pitch, so the rotor never strobes.
    for (const d of plan.blender.drive) expect(Math.abs(d.to - d.from) / (d.t1 - d.t0) / 30).toBeLessThan(22);
  });

  it('passes the per-video Blender extras only for this subject: floor, gate event, speed scale', () => {
    const { plan } = planFor('dam');
    expect(plan.blender.kit).toBe('dam');
    expect(plan.blender.floor_z).toBe(-6.45);
    expect(plan.blender.max_speed).toBe(300);
    expect(plan.blender.events).toHaveLength(1);
    const gate = plan.blender.events![0];
    expect(gate.name).toBe('gate');
    expect(gate.t0).toBeGreaterThanOrEqual(plan.beats[2].start);
    expect(gate.t1).toBeLessThanOrEqual(plan.beats[2].end);
  });

  it('has a hook, a tracker for its five steps, two fact cards and hashtags', () => {
    const { loaded, base, plan, cfg, words, narration } = planFor('dam');
    expect(hookTextFor(base, loaded.video)).toBe("Falling water makes 14% of the world's electricity!");
    const segs = progressSegments(plan, loaded.video.steps!, cfg.progress);
    expect(segs.map((s) => s.index)).toEqual([-1, 0, 1, 2, 3, 4, 5]);
    expect(calloutEvents(loaded.video, cfg, words, plan, narration).map((c) => c.value)).toEqual(['14%', '4,500 TWh']);
    expect(loaded.video.hashtags.length).toBeGreaterThanOrEqual(5);
  });
});

describe('blender_entry.py (adds a per-video kit to the frozen script in memory)', () => {
  const python = spawnSync('python', ['--version']).status === 0 ? 'python' : null;
  const entry = path.join(root, 'base', 'v1', 'blender_entry.py');
  const run = (script: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-'));
    const spec = path.join(dir, 'spec.json');
    const kit = path.join(dir, 'kit.py');
    fs.writeFileSync(kit, 'def build_kit():\n    pass\n');
    fs.writeFileSync(spec, JSON.stringify({ kit: 'x', kit_file: kit, frozen_script: script }));
    return spawnSync(python!, [entry, '--', spec], { encoding: 'utf-8' });
  };

  it.skipIf(!python)('refuses to run when the frozen script no longer has its marker lines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-copy-'));
    const tampered = path.join(dir, 'mechanism.py');
    const original = fs.readFileSync(path.join(root, 'packages', 'rendering', 'blender', 'mechanism.py'), 'utf-8').split('\r\n').join('\n');
    const marker = 'kit = SPEC.get("kit", "crank_piston")\n';
    expect(original).toContain(marker);
    fs.writeFileSync(tampered, original.replace(marker, 'kit = SPEC.get("kit")\n'));
    const r = run(tampered);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('frozen script layout changed');
  });

  it.skipIf(!python)('finds both markers in the real frozen script and goes on to run it (it then stops only because bpy exists only inside Blender)', () => {
    const r = run(path.join(root, 'packages', 'rendering', 'blender', 'mechanism.py'));
    expect(r.stderr).not.toContain('layout changed');
    expect(r.stderr).toContain('bpy');
  });

  it.skipIf(!python)('never writes to the frozen script', () => {
    const file = path.join(root, 'packages', 'rendering', 'blender', 'mechanism.py');
    const before = fs.readFileSync(file);
    run(file);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
});

const blender = findBlender(process.env.BLENDER_PATH);
describe.skipIf(!blender)('the dam kit (Blender)', () => {
  it('no parts interpenetrate over a full cycle (through the base wrapper)', async () => {
    const loaded = loadVideo(path.join(root, 'videos', 'dam', 'video.json'));
    const collisions = await checkMechanismKit(blender!, 'dam', { kitFile: loaded.kitFile, entryScript: path.join(root, 'base', 'v1', 'blender_entry.py'), floorZ: -6.45 });
    expect(collisions).toEqual([]);
  }, 300_000);
});

describe('overlay refinement (captions, tracker, pointers, fact cards)', () => {
  const { cfg, plan, loaded } = planFor('four-stroke-engine');
  const ptr = overlayPointers(cfg)!;
  // A part that drifts across the frame, one on the left and one on the right.
  const tracks = {
    'intake valve': [[0, 0.3, 0.4, 5], [60, 0.3, 0.4, 5]] as Array<[number, number, number, number]>,
    'exhaust valve': [[0, 0.7, 0.42, 5], [60, 0.7, 0.42, 5]] as Array<[number, number, number, number]>,
    piston: [[0, 0.5, 0.6, 5], [60, 0.5, 0.6, 5]] as Array<[number, number, number, number]>,
  };
  const labels = [
    { text: 'INTAKE VALVE', part: 'intake valve', t0: 1, t1: 4 },
    { text: 'EXHAUST VALVE', part: 'exhaust valve', t0: 1, t1: 4 },
    { text: 'PISTON', part: 'piston', t0: 1, t1: 4, style: 'pulse' as const },
  ];

  it('defaults: caption 5-7% lower third max 3 words, slim tracker, scaled cards, overlay pointers', () => {
    expect(cfg.captions.font.sizePct).toBeGreaterThanOrEqual(5);
    expect(cfg.captions.font.sizePct).toBeLessThanOrEqual(7);
    expect(cfg.captions.position.yPct).toBe(76);
    expect(cfg.captions.maxWordsPerCue).toBe(3);
    expect(cfg.progress.lineHeightPx).toBe(3);
    expect(cfg.progress.dimOpacity).toBe(0.45);
    expect(cfg.progress.visibleFromStart).toBe(true);
    expect(cfg.callouts.valueFont.sizePct).toBeLessThan(6.5);
    expect(ptr.style).toBe('leader');
    expect(ptr.thickness_px).toBeGreaterThanOrEqual(2);
    expect(ptr.thickness_px).toBeLessThanOrEqual(3);
  });

  it('removing the new sections restores the old look (legacy values are the fallback)', () => {
    const base = loadBase('v1');
    const legacy = effectiveConfig({ ...base, caption: undefined, tracker: undefined, callout: undefined, pointer: undefined } as any, loaded.video);
    expect(legacy.captions.font.sizePct).toBe(8);
    expect(legacy.captions.position.yPct).toBe(50);
    expect(legacy.callouts.position.yPct).toBe(72);
  });

  it('zones map to a caption position', () => {
    for (const [zone, y] of [['center', 50], ['upper_third', 24], ['lower_third', 76]] as const) {
      expect(planFor('four-stroke-engine', (v) => (v.overrides = { caption: { zone } })).cfg.captions.position.yPct).toBe(y);
    }
  });

  it('pointer mode "blender" keeps the old in-render pills (no overlay)', () => {
    const c = planFor('four-stroke-engine', (v) => (v.overrides = { pointer: { mode: 'blender' } })).cfg;
    expect(overlayPointers(c)).toBeNull();
  });

  it('putting labels in the overlay changes nothing in the Blender spec except an empty labels list', () => {
    const e = planFor('four-stroke-engine');
    const { plan: split, labels: ls } = splitPointerLabels(e.plan, e.loaded.video);
    expect(split.blender.labels).toEqual([]);
    expect({ ...split.blender, labels: e.plan.blender.labels }).toEqual(e.plan.blender);
    expect(ls).toHaveLength(e.plan.blender.labels.length);
    expect(ls.map((l) => l.text)).toEqual(e.plan.blender.labels.map((l) => l.text));
  });

  it('every pill sits at a frame edge, never over the middle, and has a leader line', () => {
    const pills = placePills(labels, tracks, ptr);
    expect(pills).toHaveLength(3);
    for (const p of pills) {
      const atLeft = p.x === ptr.edge_margin_px;
      const atRight = Math.abs(p.x + p.w - (1080 - ptr.edge_margin_px)) < 1;
      expect(atLeft || atRight).toBe(true);
      expect(p.w).toBeLessThan(540); // never reaches the middle
      expect(p.y).toBeGreaterThanOrEqual((ptr.zone.topPct / 100) * 1920);
      expect(p.y).toBeLessThanOrEqual((ptr.zone.bottomPct / 100) * 1920);
    }
    const ass = buildPointerOverlay(labels, tracks, ptr, 30);
    const draws = ass.split('\n').filter((l) => l.startsWith('Dialogue:') && l.includes('PtrDraw'));
    expect(draws.length).toBeGreaterThanOrEqual(3 * 2); // line + dot (or ring) per label at least
    expect(ass).toContain('PINTAKE'.slice(1)); // INTAKE VALVE text present
  });

  it('pills on screen together do not overlap; a part that is off screen gets no pill', () => {
    const near = labels.map((l) => ({ ...l, part: 'intake valve' }));
    const pills = placePills(near, tracks, ptr);
    for (let i = 0; i < pills.length; i++) {
      for (let j = i + 1; j < pills.length; j++) {
        if (pills[i].side !== pills[j].side) continue;
        expect(Math.abs(pills[i].y - pills[j].y)).toBeGreaterThanOrEqual(pills[i].h);
      }
    }
    expect(placePills([{ text: 'GHOST', part: 'nothing', t0: 1, t1: 2 }], tracks, ptr)).toEqual([]);
  });

  it('fact cards scale with callout.size_pct', () => {
    const small = planFor('four-stroke-engine', (v) => (v.overrides = { callout: { size_pct: 3 } })).cfg;
    expect(small.callouts.valueFont.sizePct).toBeLessThan(cfg.callouts.valueFont.sizePct);
  });
});

describe('overlay checklist on the real engine and dam narration', () => {
  it.each(['four-stroke-engine', 'dam'] as const)('%s: captions never show more than 3 words and stay in the lower third', (slug) => {
    const { cfg, words } = planFor(slug);
    const ass = buildCaptionOverlay(captionCues(words, cfg.captions), words, cfg.captions);
    const ev = ass.split(/\r?\n/).filter((l) => l.startsWith('Dialogue:') && l.split(',')[3] === 'Caption');
    expect(ev.length).toBeGreaterThan(0);
    for (const e of ev) {
      const body = e.split(',').slice(9).join(',');
      const text = body.replace(/\{[^}]*\}/g, '').replace(/\N/g, ' ');
      expect(text.trim().split(/\s+/).length).toBeLessThanOrEqual(3);
      expect(Number(/\pos\(\d+,(\d+)\)/.exec(body)![1])).toBeGreaterThanOrEqual(0.7 * 1920); // below the central band
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
// Text styles: classic (control) and premium
// ---------------------------------------------------------------------------------------------------------

function layersFor(slug: 'four-stroke-engine' | 'dam', style: 'classic' | 'premium') {
  return buildLayers(slug, (video, base) => effectiveConfig(base, video, style));
}

function layersForConfig(slug: 'four-stroke-engine' | 'dam', cfg: ReturnType<typeof effectiveConfig>): Record<string, string> {
  return buildLayers(slug, () => cfg).layers;
}

function buildLayers(slug: 'four-stroke-engine' | 'dam', cfgOf: (video: any, base: ReturnType<typeof loadBase>) => ReturnType<typeof effectiveConfig>) {
  const loaded = loadVideo(path.join(root, 'videos', slug, 'video.json'));
  const base = loadBase(loaded.video.base);
  const cfg = cfgOf(loaded.video, base);
  const spec = toMechanismSpec(loaded.video, base);
  const saved = fixture(`${slug}.narration.json`);
  const raw = wordsFromAlignment(saved.characters, saved.startTimes, saved.endTimes);
  const cut = planGapTightening(raw.map((w) => ({ word: w.word, start: w.start, end: w.end })), saved.audioDurationSeconds, { leadSeconds: base.voice.leadSeconds, gapTargetSeconds: base.voice.pauseTargetSeconds, tailSeconds: base.voice.tailSeconds });
  const words = retimeWords(raw, cut.words);
  const split = splitPointerLabels(planMechanism(spec, words, cut.durationAfter, planOptionsFor(loaded.video, cfg)), loaded.video);
  const plan = split.plan;
  const callouts = calloutEvents(loaded.video, cfg, words, plan, narrationText(spec));
  const tracks = slug === 'four-stroke-engine' ? fixture('engine.anchors.json') : {};
  const layers = overlayLayers({
    cfg,
    video: loaded.video,
    words,
    plan,
    hook: hookTextFor(cfg, loaded.video),
    callouts,
    segments: progressSegments(plan, loaded.video.steps ?? [], cfg.progress),
    pointerLabels: slug === 'four-stroke-engine' ? split.labels : [],
    tracks,
    fps: base.render.fps,
  });
  const byName = Object.fromEntries(layers.map((l) => [l.name, l.ass])) as Record<string, string>;
  // The outro layer is only part of the build when the video enables it; the control records it either way.
  byName.outro ??= buildOutroOverlay(Math.max(0, plan.seconds - cfg.outro.seconds), plan.seconds, cfg.outro, undefined, undefined, textFx(cfg.text));
  return { cfg, words, plan, callouts, layers: byName };
}

describe('text style: classic is the original look, exactly', () => {
  const golden = fixture('classic-overlays.sha256.json');
  it.each(['four-stroke-engine', 'dam'] as const)('%s: every overlay layer of "classic" is byte-identical to the layers recorded before the presets existed', (slug) => {
    const { layers } = layersFor(slug, 'classic');
    const hashes = Object.fromEntries(Object.entries(layers).map(([k, v]) => [k, createHash('sha256').update(v).digest('hex')]));
    expect(hashes).toEqual(golden[slug]);
  });
  it('the default style of the base is classic', () => {
    expect(loadBase('v1').text_style ?? 'classic').toBe('classic');
  });
});

describe('text style: premium', () => {
  const classic = layersFor('four-stroke-engine', 'classic');
  const premium = layersFor('four-stroke-engine', 'premium');
  const events = (ass: string, style: string) => ass.split(/\r?\n/).filter((l) => l.startsWith('Dialogue:') && l.split(',')[3] === style);
  const styleLine = (ass: string, name: string) => ass.split(/\r?\n/).find((l) => l.startsWith(`Style: ${name},`))!.split(',');
  const YELLOW_OLD = '&H00D2FF&'; // the classic #FFD200
  const YELLOW_NEW = '&H3BD4FF&'; // the premium highlight #FFD43B

  it('keeps sizes, positions, word timing and the timeline; only the letterforms and effects change', () => {
    expect(premium.cfg.captions.font.sizePct).toBe(classic.cfg.captions.font.sizePct);
    expect(premium.cfg.captions.position).toEqual(classic.cfg.captions.position);
    expect(premium.cfg.hook.font.sizePct).toBe(classic.cfg.hook.font.sizePct);
    expect(premium.cfg.captions.maxWordsPerCue).toBe(classic.cfg.captions.maxWordsPerCue);
    expect(premium.plan.seconds).toBe(classic.plan.seconds);
    const times = (ass: string) => events(ass, 'Caption').map((e) => e.split(',').slice(1, 3).join(','));
    expect(times(premium.layers.captions)).toEqual(times(classic.layers.captions));
    const words = (ass: string) => events(ass, 'Caption').map((e) => e.replace(/\{[^}]*\}/g, '').split(',').slice(9).join(','));
    expect(words(premium.layers.captions)).toEqual(words(classic.layers.captions));
  });

  it('uses the bundled Inter (not a system font) and has no outline', () => {
    for (const f of ['Inter-Bold.otf', 'Inter-SemiBold.otf', 'OFL-Inter.txt']) expect(fs.existsSync(path.join(root, 'assets', 'fonts', f))).toBe(true);
    expect(loadBase('v1').frozen.files.join(' ')).not.toContain('Inter'); // additive: the frozen list is unchanged
    const cap = styleLine(premium.layers.captions, 'Caption');
    expect(cap[1]).toBe('Inter');
    expect(Number(cap[16])).toBe(0); // Outline
    expect(Number(cap[17])).toBe(0); // Shadow (the soft shadow is its own blurred layer)
    expect(Number(cap[13])).toBeLessThan(0); // tighter tracking
    expect(Number(styleLine(classic.layers.captions, 'Caption')[16])).toBeGreaterThan(5); // classic keeps its thick outline
    for (const layer of ['hook', 'callouts', 'pointers']) expect(premium.layers[layer]).toMatch(/Inter/);
  });

  it('replaces the stroke by a soft blurred shadow layer under every text event', () => {
    const shadows = events(premium.layers.captions, 'CaptionShadow');
    expect(shadows).toHaveLength(events(premium.layers.captions, 'Caption').length);
    expect(shadows[0]).toMatch(/\\blur10/);
    expect(shadows[0]).toMatch(/\\1c&H000000&/);
    expect(events(classic.layers.captions, 'CaptionShadow')).toHaveLength(0);
    expect(events(premium.layers.hook, 'HookShadow').length).toBe(1);
    expect(events(premium.layers.progress, 'StepOnShadow')).toHaveLength(0); // the tracker keeps the classic look
  });

  it('the word being spoken is yellow, in sync with the voice (one yellow word per caption event, from the ElevenLabs timestamps)', () => {
    const caps = events(premium.layers.captions, 'Caption');
    expect(premium.layers.captions).not.toContain(YELLOW_OLD); // classic gold is gone; premium has its own yellow
    expect(caps.length).toBeGreaterThan(100); // every word outside the hook and outro windows
    caps.forEach((e) => {
      const start = hmsToS(e.split(',')[1]);
      const spoken = [...premium.words].reverse().find((w) => w.start <= start + 0.02)!; // the word being said at that moment (an event clipped by the hook window starts later)
      expect(spoken).toBeDefined();
      const tokens = [...e.matchAll(/\{\\c(&H[0-9A-F]+&)\}([^{]+)/g)].map((m) => ({ c: m[1], t: m[2].replace(/\\N/g, ' ').trim() }));
      const yellow = tokens.filter((t) => t.c === YELLOW_NEW);
      expect(yellow).toHaveLength(1);
      expect(yellow[0].t).toBe(spoken.word);
    });
    expect(classic.layers.captions).toContain(YELLOW_OLD);
  });

  it('the single-highlight policy is still available: one yellow word per scene, none where a fact card is', () => {
    const v = loadVideo(path.join(root, 'videos', 'four-stroke-engine', 'video.json'));
    const base = loadBase('v1');
    const cfg = effectiveConfig(base, { ...v.video, overrides: { highlight: { policy: 'single' }, captions: { colors: { current: '#FFFFFF' } } } }, 'premium');
    expect(cfg.highlight?.policy).toBe('single');
    expect(cfg.captions.colors.current).toBe('#FFFFFF');
    const layers = layersForConfig('four-stroke-engine', cfg);
    const yellow = events(layers.captions, 'Caption').flatMap((e) => [...e.matchAll(/\{\\c&H3BD4FF&\}([^{]+)/g)].map((m) => m[1].trim()));
    expect(yellow.length).toBeGreaterThan(0);
    expect(new Set(yellow).size).toBeLessThanOrEqual(premium.plan.beats.length);
  });

  it('the steps tracker at the top is the classic one, byte for byte', () => {
    expect(premium.layers.progress).toBe(classic.layers.progress);
    expect(layersFor('dam', 'premium').layers.progress).toBe(layersFor('dam', 'classic').layers.progress);
    expect(premium.layers.progress).toContain(YELLOW_OLD); // the classic yellow active dot
  });

  it('the first text (the title / hook) is centred in the frame', () => {
    expect(premium.cfg.hook.position).toEqual({ xPct: 50, yPct: 50 });
    expect(events(premium.layers.hook, 'Hook')[0]).toContain('\\an5\\pos(540,960)');
    expect(classic.cfg.hook.position.yPct).toBe(40); // classic is unchanged
  });

  it('fact cards become a minimal badge: dark translucent backdrop, thin border, figure over label', () => {
    const ass = premium.layers.callouts;
    const lines = ass.split(/\r?\n/);
    const backdrop = lines.find((l) => l.includes(',CalloutDraw,') && l.startsWith('Dialogue: 3'))!;
    expect(backdrop).toContain('\\c&H110D0B&'); // #0B0D11, not the yellow fill
    expect(backdrop).toMatch(/\\bord1\.5/);
    expect(backdrop).not.toMatch(/\\1a&H00&/); // translucent
    const value = lines.find((l) => l.includes(',CalloutValue,'))!;
    const label = lines.find((l) => l.includes(',CalloutLabel,'))!;
    const y = (l: string) => Number(/\\pos\(\d+,(\d+)\)/.exec(l)![1]);
    expect(y(label)).toBeGreaterThan(y(value)); // label beneath the figure
    expect(Number(styleLine(ass, 'CalloutValue')[2])).toBeGreaterThan(Number(styleLine(ass, 'CalloutLabel')[2]) * 2);
    expect(classic.layers.callouts).not.toContain('CalloutValueShadow');
  });

  it('keeps the size hierarchy hook > caption > fact label > tracker label', () => {
    const sz = (ass: string, name: string) => Number(styleLine(ass, name)[2]);
    expect(sz(premium.layers.hook, 'Hook')).toBeGreaterThan(sz(premium.layers.captions, 'Caption'));
    expect(sz(premium.layers.captions, 'Caption')).toBeGreaterThan(sz(premium.layers.callouts, 'CalloutLabel'));
    expect(sz(premium.layers.callouts, 'CalloutLabel')).toBeGreaterThan(sz(premium.layers.progress, 'Step'));
    expect(sz(premium.layers.hook, 'Hook')).toBe(sz(classic.layers.hook, 'Hook'));
  });

  it('is selectable per video, and an unknown preset is an error', () => {
    const loaded = loadVideo(path.join(root, 'videos', 'dam', 'video.json'));
    const base = loadBase('v1');
    expect(effectiveConfig(base, { ...loaded.video, overrides: { text_style: 'premium' } }).text_style).toBe('premium');
    expect(effectiveConfig(base, loaded.video).text_style).toBe('classic');
    expect(() => effectiveConfig({ ...base, presets: {} }, loaded.video, 'premium')).toThrow(/presets\.premium/);
  });

  it('renders the dam too (text layers differ from classic, same layers present)', () => {
    const c = layersFor('dam', 'classic');
    const p = layersFor('dam', 'premium');
    expect(Object.keys(p.layers).sort()).toEqual(Object.keys(c.layers).sort());
    expect(p.layers.captions).not.toBe(c.layers.captions);
  });
});

function hmsToS(t: string): number {
  const [h, m, s] = t.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}
