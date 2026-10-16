import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planGapTightening, repoRoot } from '@shorts/core';
import { ElevenLabsTTSProvider } from '@shorts/providers';
import { MechanismVideoSpecSchema, type MechanismVideoSpec } from '@shorts/schemas';
import { buildCaptionAss, buildHudAss, buildStepperAss, checkMechanismKit, findBlender, mechanismCaptionCues, narrationText, planMechanism, retimeWords, wordsFromAlignment } from '@shorts/rendering';

/** Alignment as ElevenLabs returns it: one entry per character of the submitted text. */
function fakeAlignment(text: string, secondsPerChar = 0.06) {
  const characters = [...text];
  return { characters, starts: characters.map((_, i) => i * secondsPerChar), ends: characters.map((_, i) => (i + 1) * secondsPerChar) };
}

const spec: MechanismVideoSpec = MechanismVideoSpecSchema.parse({
  slug: 'test-engine',
  title: 'Test engine',
  kit: 'four_stroke',
  beats: [
    { text: 'Hook line one.', crank: [0, 360], camera: { look: [0, 0, 1], distance: 14 } },
    {
      text: 'A spark ignites the mixture right here.',
      crankPath: [
        { at: 0, deg: 330 },
        { at: 0.5, deg: 360 },
        { at: 1, deg: 540 },
      ],
      hud: '3 · POWER',
      camera: { look: [0, 0, 2], distance: 10 },
      labels: [{ text: 'SPARK PLUG', part: 'spark plug', from: 0.2, to: 0.6 }],
    },
    { text: 'Last words.', camera: { look: [0, 0, 1], distance: 14 } },
  ],
});

function plan(s = spec) {
  const text = narrationText(s);
  const a = fakeAlignment(text);
  const words = wordsFromAlignment(a.characters, a.starts, a.ends);
  const audio = a.ends[a.ends.length - 1];
  return { text, words, audio, p: planMechanism(s, words, audio) };
}

describe('mechanism narration timing', () => {
  it('derives word times and character offsets from character alignment', () => {
    const w = wordsFromAlignment(...(Object.values(fakeAlignment('ab cd')) as [string[], number[], number[]]));
    expect(w.map((x) => x.word)).toEqual(['ab', 'cd']);
    expect(w[1].charStart).toBe(3);
    expect(w[0].start).toBeCloseTo(0);
    expect(w[0].end).toBeCloseTo(0.12);
    expect(w[1].start).toBeCloseTo(0.18);
  });

  it('starts every beat on its first spoken word and covers the whole video without gaps', () => {
    const { words, p } = plan();
    expect(p.beats[0].start).toBe(0);
    for (let i = 1; i < p.beats.length; i++) {
      const firstWordOfBeat = words[p.beats[i].firstWord];
      expect(p.beats[i].start).toBeCloseTo(firstWordOfBeat.start);
      expect(p.beats[i - 1].end).toBeCloseTo(p.beats[i].start);
    }
    expect(p.beats[p.beats.length - 1].end).toBeCloseTo(p.seconds);
    expect(p.seconds).toBeGreaterThan(words[words.length - 1].end);
  });

  it('lands the spark (crankPath) at the requested fraction of the beat', () => {
    const { p } = plan();
    const beat = p.beats[1];
    const spark = p.blender.drive.find((d) => d.from === 360 && d.to === 540)!;
    expect(spark.t0).toBeCloseTo(beat.start + 0.5 * (beat.end - beat.start));
    // The drive is continuous: each segment starts where the previous one ended, in time and angle.
    for (let i = 1; i < p.blender.drive.length; i++) {
      expect(p.blender.drive[i].t0).toBeCloseTo(p.blender.drive[i - 1].t1);
    }
  });

  it('times labels and headings inside their beat', () => {
    const { p } = plan();
    const beat = p.beats[1];
    const label = p.blender.labels[0];
    expect(label.t0).toBeCloseTo(beat.start + 0.2 * (beat.end - beat.start));
    expect(label.t1).toBeCloseTo(beat.start + 0.6 * (beat.end - beat.start));
    expect(p.hud).toEqual([{ start: beat.start, end: beat.end, text: '3 · POWER' }]);
  });

  it('orbits the camera a few degrees during each beat, alternating direction, while pushing in slightly', () => {
    const { p } = plan();
    const look = (b: number) => spec.beats[b].camera.look;
    // Two keys per beat: arrival, then the end-of-beat position.
    const dist = (k: { pos: number[] }, b: number) => Math.hypot(k.pos[0] - look(b)[0], k.pos[1] - look(b)[1], k.pos[2] - look(b)[2]);
    const azimuth = (k: { pos: number[] }, b: number) => Math.atan2(k.pos[1] - look(b)[1], k.pos[0] - look(b)[0]) * (180 / Math.PI);
    const turns: number[] = [];
    for (let b = 0; b < spec.beats.length; b++) {
      const arrive = p.blender.camera_keys[2 * b];
      const leave = p.blender.camera_keys[2 * b + 1];
      expect(dist(leave, b)).toBeCloseTo(dist(arrive, b) * 0.95, 5);
      turns.push(azimuth(leave, b) - azimuth(arrive, b));
    }
    expect(turns.every((t) => Math.abs(Math.abs(t) - 9) < 0.01)).toBe(true);
    expect(Math.sign(turns[0])).not.toBe(Math.sign(turns[1]));
  });

  it('keeps beats on their words after sentence pauses are tightened', () => {
    // Narration with a long pause after every sentence (like the real voice).
    const text = narrationText(spec);
    const chars = [...text];
    const starts: number[] = [];
    const ends: number[] = [];
    let t = 0;
    chars.forEach((c, i) => {
      starts.push(t);
      t += 0.06;
      ends.push(t);
      if (c === '.' && chars[i + 1] === ' ') t += 0.6; // a 0.6 s pause between sentences
    });
    const words = wordsFromAlignment(chars, starts, ends);
    const cut = planGapTightening(words.map((w) => ({ word: w.word, start: w.start, end: w.end })), t, { leadSeconds: 0.05, gapTargetSeconds: 0.26, tailSeconds: 0.5 });
    expect(cut.gapsTightened).toBeGreaterThan(0);
    expect(cut.maxGapAfterSeconds).toBeLessThanOrEqual(0.27);
    const tight = retimeWords(words, cut.words);
    const before = planMechanism(spec, words, t);
    const after = planMechanism(spec, tight, cut.durationAfter);
    expect(after.seconds).toBeLessThan(before.seconds);
    // Every beat still starts on its own first word, and word order and offsets are untouched.
    after.beats.slice(1).forEach((b) => expect(b.start).toBeCloseTo(tight[b.firstWord].start));
    expect(tight.map((w) => w.charStart)).toEqual(words.map((w) => w.charStart));
    expect(() => retimeWords(words, cut.words.slice(1))).toThrow(/became/);
  });

  it('accepts a per-video voice with expressiveness settings', () => {
    const v = MechanismVideoSpecSchema.parse({ ...spec, voice: { id: 'Ddh3PpD0pGS5vi20kePJ', stability: 0.32, style: 0.5 } });
    expect(v.voice).toEqual({ id: 'Ddh3PpD0pGS5vi20kePJ', stability: 0.32, style: 0.5 });
    expect(() => MechanismVideoSpecSchema.parse({ ...spec, voice: { stability: 1.4 } })).toThrow();
    const shipped = MechanismVideoSpecSchema.parse(JSON.parse(fs.readFileSync(path.join(repoRoot(), 'content', 'mechanisms', 'four-stroke-engine.json'), 'utf-8')));
    expect(shipped.voice?.id).toBe('Ddh3PpD0pGS5vi20kePJ');
  });

  it('fails closed when the alignment does not match the beats', () => {
    const text = narrationText(spec);
    const a = fakeAlignment(text.slice(0, 20));
    const words = wordsFromAlignment(a.characters, a.starts, a.ends);
    expect(() => planMechanism(spec, words, 1.2)).toThrow(/does not cover/);
  });

  it('rejects a crankPath that does not span the beat', () => {
    const bad = MechanismVideoSpecSchema.parse({ ...spec, beats: [{ ...spec.beats[0], crankPath: [{ at: 0.2, deg: 0 }, { at: 1, deg: 90 }] }] });
    const text = narrationText(bad);
    const a = fakeAlignment(text);
    expect(() => planMechanism(bad, wordsFromAlignment(a.characters, a.starts, a.ends), 1)).toThrow(/crankPath/);
  });

  it('keeps the shipped four-stroke spec valid and its heading text short', () => {
    const file = path.join(repoRoot(), 'content', 'mechanisms', 'four-stroke-engine.json');
    const s = MechanismVideoSpecSchema.parse(JSON.parse(fs.readFileSync(file, 'utf-8')));
    expect(s.beats.length).toBeGreaterThanOrEqual(6);
    expect(plan(s).p.hud.length).toBe(s.beats.filter((b) => b.hud).length);
  });
});

describe('ElevenLabs voice settings', () => {
  function capture() {
    const bodies: Array<Record<string, any>> = [];
    const audio = Buffer.alloc(2048, 1).toString('base64');
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ audio_base64: audio, alignment: { characters: ['a'], character_start_times_seconds: [0], character_end_times_seconds: [0.1] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { bodies, fetchImpl };
  }
  const base = { timeoutMs: 5000, maxAttempts: 1, usdPer1kChars: 0.22, speed: 1.15 };

  it('sends the per-video stability and style (more energy) and the cache key changes with them', async () => {
    const c = capture();
    const energetic = new ElevenLabsTTSProvider('k', 'v', 'eleven_multilingual_v2', { ...base, stability: 0.3, style: 0.6 }, { fetchImpl: c.fetchImpl });
    await energetic.synthesize({ text: 'hello there' });
    expect(c.bodies[0].voice_settings).toMatchObject({ stability: 0.3, style: 0.6, speed: 1.15, use_speaker_boost: true });
    const plain = new ElevenLabsTTSProvider('k', 'v', 'eleven_multilingual_v2', base, { fetchImpl: c.fetchImpl });
    await plain.synthesize({ text: 'hello there' });
    expect(c.bodies[1].voice_settings).toMatchObject({ stability: 0.5, style: 0 });
    expect(energetic.settingsKey).not.toBe(plain.settingsKey);
  });
});

describe('turbocharger video spec', () => {
  const file = path.join(repoRoot(), 'content', 'mechanisms', 'turbocharger.json');
  const turbo = MechanismVideoSpecSchema.parse(JSON.parse(fs.readFileSync(file, 'utf-8')));

  it('is a valid spec with a four-step sequence and only claims the kit shows', () => {
    expect(turbo.kit).toBe('turbocharger');
    expect(turbo.steps).toHaveLength(4);
    const stepBeats = turbo.beats.filter((b) => b.step !== undefined).map((b) => b.step);
    expect(stepBeats).toEqual([0, 1, 2, 3]);
    // Every label points at a part the kit defines.
    const parts = ['exhaust inlet', 'turbine wheel', 'shaft', 'bearing housing', 'air inlet', 'compressor wheel', 'outlet to engine'];
    for (const b of turbo.beats) for (const l of b.labels) expect(parts).toContain(l.part);
  });

  it('plans the studio floor below the taller turbocharger and keeps the shaft speed gentle (no wheel strobing)', () => {
    const text = narrationText(turbo);
    const a = fakeAlignment(text, 0.058);
    const p = planMechanism(turbo, wordsFromAlignment(a.characters, a.starts, a.ends), a.ends[a.ends.length - 1]);
    expect(p.blender.floor_z).toBeLessThan(-3);
    expect(p.stepper.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    // Shaft angle per frame stays under half the blade pitch of the 8-blade compressor (45 degrees) in every segment.
    for (const d of p.blender.drive) {
      const perFrame = (Math.abs(d.to - d.from) / (d.t1 - d.t0)) / 30;
      expect(perFrame).toBeLessThan(22);
    }
    // The wheel only ever speeds up (spool-up), never reverses.
    p.blender.drive.forEach((d) => expect(d.to).toBeGreaterThanOrEqual(d.from));
  });
});

describe('mechanism captions', () => {
  it('uses short, ordered, non-overlapping cues that cover every word', () => {
    const { words } = plan();
    const cues = mechanismCaptionCues(words);
    expect(cues.every((c) => c.lastWordIndex - c.firstWordIndex < 4)).toBe(true);
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end - 1e-6);
      expect(cues[i].firstWordIndex).toBe(cues[i - 1].lastWordIndex + 1);
    }
    expect(cues[0].firstWordIndex).toBe(0);
    expect(cues[cues.length - 1].lastWordIndex).toBe(words.length - 1);
  });

  it('never overflows the two-line caption box: long words start a new phrase instead of losing a line', () => {
    const text = 'Crankshaft\u2019s turbocharger compression synchronizer differential intake exhaust';
    const a = fakeAlignment(text);
    const words = wordsFromAlignment(a.characters, a.starts, a.ends);
    const cues = mechanismCaptionCues(words);
    expect(cues.every((c) => c.lines.length <= 2)).toBe(true);
    // Every spoken word is shown exactly once, in order, across the cues.
    const shown = cues.flatMap((c) => c.lines.flatMap((l) => l.split(' ')));
    expect(shown).toEqual(words.map((w) => w.word));
    expect(() => buildCaptionAss(cues, words)).not.toThrow();
  });

  it('highlights exactly the word being spoken: one event per word, starting when the voice says it', () => {
    const { words } = plan();
    const cues = mechanismCaptionCues(words);
    const ass = buildCaptionAss(cues, words);
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:') && l.includes(',Caption,'));
    expect(events).toHaveLength(words.length);
    const hms = (t: string) => {
      const [h, m, s] = t.split(':');
      return Number(h) * 3600 + Number(m) * 60 + Number(s);
    };
    events.forEach((e, i) => {
      const fields = e.split(',');
      expect(hms(fields[1])).toBeCloseTo(words[i].start, 1); // starts when this word starts
      const body = fields.slice(9).join(',').replace(/\{\\fad\([^)]*\)\}/g, '');
      const tokens = [...body.matchAll(/\{\\c(&H[0-9A-F]+&)\}([^{]+)/g)].map((m) => ({ colour: m[1], text: m[2].replace(/\\N/g, ' ').trim() }));
      const gold = tokens.filter((t) => t.colour === '&H00D2FF&');
      expect(gold).toHaveLength(1);
      expect(gold[0].text).toBe(words[i].word); // the gold word is the spoken word
      // Words already spoken in this phrase are white, the ones still to come are dimmed.
      const k = tokens.findIndex((t) => t.colour === '&H00D2FF&');
      tokens.slice(0, k).forEach((t) => expect(t.colour).toBe('&HFFFFFF&'));
      tokens.slice(k + 1).forEach((t) => expect(t.colour).toBe('&HA8A8A8&'));
    });
  });

  it('keeps every word of a phrase on screen in order, and never leaves a backslash out of an ASS tag', () => {
    const { words } = plan();
    const ass = buildCaptionAss(mechanismCaptionCues(words), words);
    expect(ass).toContain('{\\c&H00D2FF&}');
    expect(ass).toContain('{\\fad(70,0)}');
    expect(ass).not.toContain('\f');
    const first = ass.split('\n').find((l) => l.includes(',Caption,'))!;
    expect(first.replace(/\{[^}]*\}/g, '').split(',').slice(9).join(',').replace(/\\N/g, ' ').trim().startsWith(words[0].word)).toBe(true);
  });

  it('is plain text: no background box and no drawn lines around the captions', () => {
    const { words } = plan();
    const ass = buildCaptionAss(mechanismCaptionCues(words), words);
    const style = ass.split('\n').find((l) => l.startsWith('Style: Caption'))!.split(',');
    expect(style[15]).toBe('1'); // BorderStyle 1 = outline only (3 would be an opaque box)
    expect(ass).not.toContain('\\p1'); // no vector drawings
    expect(ass).not.toContain('Bracket');
    expect(ass.split('\n').filter((l) => l.startsWith('Style:'))).toHaveLength(1);
  });

  it('draws a centred stepper with the active step gold and fades only at the ends of a run', () => {
    const steps = ['Intake', 'Compression', 'Power', 'Exhaust'];
    const ass = buildStepperAss([
      { start: 1, end: 3, index: 0, steps },
      { start: 3, end: 5, index: 1, steps },
      { start: 8, end: 9, index: 3, steps },
    ]);
    for (const s of steps) expect(ass).toContain(s.toUpperCase());
    const dots = ass.split('\n').filter((l) => l.startsWith('Dialogue: 1,0:00:03.00') && l.includes('\\p1'));
    expect(dots.filter((d) => d.includes('\\c&H00D2FF&'))).toHaveLength(1); // one gold dot for the active step
    // Step 0 -> 1 are adjacent: the second event has no fade-in; step 3 is separate and fades in again.
    const at = (t: string) => ass.split('\n').find((l) => l.startsWith(`Dialogue: 2,${t}`))!;
    expect(at('0:00:01.00')).toContain('\\fad(250,0)');
    expect(at('0:00:03.00')).toContain('\\fad(0,200)');
    expect(at('0:00:08.00')).toContain('\\fad(250,200)');
    // Labels are centred on the frame.
    const xs = [...ass.matchAll(/\\an8\\pos\((\d+),/g)].map((m) => Number(m[1]));
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(540, -1);
  });

  it('plans a stepper from the beats and rejects a step outside the sequence', () => {
    const withSteps = MechanismVideoSpecSchema.parse({
      ...spec,
      steps: ['One', 'Two'],
      beats: spec.beats.map((b, i) => ({ ...b, hud: undefined, step: i === 1 ? 1 : i === 0 ? 0 : undefined })),
    });
    const text = narrationText(withSteps);
    const a = fakeAlignment(text);
    const p2 = planMechanism(withSteps, wordsFromAlignment(a.characters, a.starts, a.ends), a.ends[a.ends.length - 1]);
    expect(p2.stepper.map((s) => s.index)).toEqual([0, 1]);
    expect(p2.stepper[1].steps).toEqual(['One', 'Two']);
    const bad = MechanismVideoSpecSchema.parse({ ...withSteps, steps: ['Only', 'Two'], beats: withSteps.beats.map((b, i) => (i === 1 ? { ...b, step: 5 } : b)) });
    expect(() => planMechanism(bad, wordsFromAlignment(a.characters, a.starts, a.ends), 5)).toThrow(/step 5/);
  });

  it('writes large centred titles with fades, upper-cased, with ASS braces removed', () => {
    const ass = buildHudAss([{ start: 1, end: 3.5, text: 'Valve {timing}' }]);
    expect(ass).toContain('Dialogue: 0,0:00:01.00,0:00:03.50,Hud');
    expect(ass).toContain('VALVE TIMING');
    expect(ass).not.toContain('{timing}');
    expect(ass).toContain('Style: Hud,Montserrat,72');
  });
});

// Real Blender: sweeps one full cycle of each kit and fails when parts that must not touch interpenetrate
// (regression: the connecting rod once passed through the cylinder flange and the bearing).
const blender = findBlender(process.env.BLENDER_PATH);
describe.skipIf(!blender)('mechanism kits (Blender)', () => {
  for (const kit of ['crank_piston', 'four_stroke', 'turbocharger']) {
    it(`${kit}: no parts interpenetrate over a full cycle`, async () => {
      const collisions = await checkMechanismKit(blender!, kit);
      expect(collisions).toEqual([]);
    }, 300_000);
  }
});
