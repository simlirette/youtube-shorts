import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '@shorts/core';
import { MechanismVideoSpecSchema, type MechanismVideoSpec } from '@shorts/schemas';
import { buildCaptionAss, buildHudAss, checkMechanismKit, findBlender, mechanismCaptionCues, narrationText, planMechanism, wordsFromAlignment } from '@shorts/rendering';

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

describe('mechanism captions', () => {
  it('uses short, ordered, non-overlapping cues that cover every word', () => {
    const { words } = plan();
    const cues = mechanismCaptionCues(words);
    expect(cues.every((c) => c.lastWordIndex - c.firstWordIndex < 3)).toBe(true);
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end - 1e-6);
      expect(cues[i].firstWordIndex).toBe(cues[i - 1].lastWordIndex + 1);
    }
    expect(cues[0].firstWordIndex).toBe(0);
    expect(cues[cues.length - 1].lastWordIndex).toBe(words.length - 1);
  });

  it('writes headings with fades, upper-cased, with ASS braces removed', () => {
    const ass = buildHudAss([{ start: 1, end: 3.5, text: 'Stroke 2 · {Compression}' }]);
    expect(ass).toContain('Dialogue: 0,0:00:01.00,0:00:03.50,Hud');
    expect(ass).toContain('STROKE 2 · COMPRESSION');
    expect(ass).not.toContain('{Compression}');
    expect(ass).toContain('Montserrat SemiBold');
  });

  it('builds clean bold captions: Montserrat Bold, one gold keyword per cue, lines kept in order', () => {
    const { words } = plan();
    const cues = mechanismCaptionCues(words);
    const ass = buildCaptionAss(cues);
    expect(ass).toContain('Style: Caption,Montserrat,');
    const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(dialogues).toHaveLength(cues.length);
    // Every spoken word survives, in order, once ASS colour overrides are stripped.
    const text = dialogues.map((d) => d.split(',').slice(9).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/g, ' ')).join(' ');
    expect(text.replace(/\s+/g, ' ').trim()).toBe(words.map((w) => w.word).join(' '));
    expect(dialogues.some((d) => d.includes('&H0000C8FF&'))).toBe(true);
    // ASS override tags need a literal backslash; in a JS string a bare \f is a form feed and \c is just "c".
    expect(ass).toContain('{\\fad(60,40)}');
    expect(ass).toContain('{\\c&H0000C8FF&}');
    expect(ass).not.toContain('\f');
  });
});

// Real Blender: sweeps one full cycle of each kit and fails when parts that must not touch interpenetrate
// (regression: the connecting rod once passed through the cylinder flange and the bearing).
const blender = findBlender(process.env.BLENDER_PATH);
describe.skipIf(!blender)('mechanism kits (Blender)', () => {
  for (const kit of ['crank_piston', 'four_stroke']) {
    it(`${kit}: no parts interpenetrate over a full cycle`, async () => {
      const collisions = await checkMechanismKit(blender!, kit);
      expect(collisions).toEqual([]);
    }, 300_000);
  }
});
