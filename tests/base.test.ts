import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { planGapTightening, repoRoot } from '@shorts/core';
import { BaseConfigSchema, VideoConfigSchema } from '@shorts/schemas';
import {
  buildCalloutOverlay,
  buildCaptionOverlay,
  buildHookOverlay,
  buildOutroOverlay,
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
  planMechanism,
  planOptionsFor,
  progressSegments,
  retimeWords,
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
    const { cfg } = planFor('four-stroke-engine', (v) => (v.overrides = { captions: { font: { sizePct: 9.5 } }, outro: { enabled: false } }));
    expect(cfg.captions.font).toEqual({ family: 'Montserrat', bold: true, sizePct: 9.5 }); // only sizePct changed
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

  it('captions are much larger than before and centred, not in the lower third', () => {
    const { cfg, words } = planFor('four-stroke-engine');
    const ass = buildCaptionOverlay(captionCues(words, cfg.captions), words, cfg.captions);
    const size = Number(ass.split('\n').find((l) => l.startsWith('Style: Caption'))!.split(',')[2]);
    expect(size / 1920).toBeGreaterThanOrEqual(0.08); // was 62 px = 3.2%
    expect(size / 1920).toBeLessThanOrEqual(0.12);
    const first = eventsOf(ass, 'Caption')[0];
    expect(first).toContain('\\an5\\pos(540,960)'); // the middle of the 1080x1920 frame
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
    expect(fit).toBeLessThan(1);
    expect(fit).toBeGreaterThan(0.6);
    const size = (ass: string, style: string) => Number(ass.split('\n').find((l) => l.startsWith('Style: ' + style))!.split(',')[2]);
    const eng = buildProgressOverlay(engine.loaded.video.steps!, progressSegments(engine.plan, engine.loaded.video.steps!, engine.cfg.progress), engine.cfg.progress);
    const dm = buildProgressOverlay(dam.loaded.video.steps!, progressSegments(dam.plan, dam.loaded.video.steps!, dam.cfg.progress), dam.cfg.progress);
    expect(size(eng, 'StepOn')).toBe(Math.round(0.024 * 1920)); // exactly the configured size
    expect(size(dm, 'StepOn')).toBeLessThan(Math.round(0.024 * 1920));
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
