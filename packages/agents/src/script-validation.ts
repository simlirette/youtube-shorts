import type { HookType } from '@shorts/schemas';
import { countWords, overlapCoefficient, significantTokens, tokenizeWords } from '@shorts/core';
import { unsupportedNumbers } from './verification.js';
import { DEFAULT_EDITORIAL, validateEditorial } from './editorial.js';

export interface ScriptRules {
  minWords: number;
  maxWords: number;
  hookMaxWords: number;
  sceneCount: number;
  /** Minimum number of distinct verified claims the script must reference. */
  minClaimRefs: number;
  /** Question formats: the hook must be a question (ends with "?"). Superseded by hookType. */
  hookMustBeQuestion?: boolean;
  /** Allowed scene count range; when set it replaces the exact sceneCount check. */
  sceneRange?: [number, number];
  /** Hook type plus the full editorial contract (micro-explainer). */
  hookType?: HookType;
  editorial?: boolean;
  /** Every scene must be split into clause-level visual beats. */
  requireBeats?: boolean;
  /** Narration words a single beat may hold (~2-3.5 s of speech). */
  beatWords?: [number, number];
}

/** Per-scene word budget (non-hook scenes) that lands the total inside the allowed range. */
export function sceneWordBudget(rules: ScriptRules): { min: number; max: number; target: number } {
  if (rules.sceneRange) {
    // Variable scene count: budget for a mid-range script with a full-length hook.
    const body = (rules.sceneRange[0] + rules.sceneRange[1]) / 2 - 1;
    const target = Math.round(((rules.minWords + rules.maxWords) / 2 - Math.min(rules.hookMaxWords, 12)) / body);
    return { min: target - 3, max: target + 3, target };
  }
  const body = rules.sceneCount - 1;
  const hook = Math.min(rules.hookMaxWords, 6);
  // Guidance band around the midpoint of the allowed total (validation itself checks the total).
  const target = Math.round(((rules.minWords + rules.maxWords) / 2 - hook) / body);
  return { min: target - 2, max: target + 2, target };
}

/** Imagery that generic stock libraries do not carry (live campaign: "animated map of Siberia" failed sourcing). */
const UNSOURCEABLE_SUBJECT = /\b(maps?|diagrams?|animations?|animated|charts?|graphs?|infographics?|illustrations?|drawings?|timelines?|text|headlines?|portraits? of)\b/;

export interface ScriptDraftBeat {
  text: string;
  visualIntent?: string;
  visualSubject: string;
  assetKeywords: string[];
  visualExclusions?: string[];
  /** A generated graphic instead of stock footage (validated separately against the narration). */
  graphic?: unknown;
}

export interface ScriptDraftScene {
  narration: string;
  visualObjective: string;
  assetKeywords: string[];
  beats?: ScriptDraftBeat[];
  visualSubject?: string;
  visualExclusions?: string[];
  claimRefs: string[];
}

export interface ScriptDraft {
  title: string;
  description: string;
  scenes: ScriptDraftScene[];
}

export interface ScriptValidationContext {
  rules: ScriptRules;
  /** Allowed claim references → supporting text (claim text + evidence quotes). */
  claims: Map<string, string>;
  previousTitles?: string[];
  previousHooks?: string[];
}

/**
 * Deterministic script contract. Returns human-readable violations (empty = valid). Used both to
 * drive corrective re-prompts during generation and again by content QA on the final script.
 */
export function validateScriptDraft(draft: ScriptDraft, ctx: ScriptValidationContext): string[] {
  const v: string[] = [];
  const { rules } = ctx;

  if (rules.sceneRange) {
    const [lo, hi] = rules.sceneRange;
    if (draft.scenes.length < lo || draft.scenes.length > hi) v.push(`script must have ${lo}-${hi} scenes (got ${draft.scenes.length})`);
  } else if (draft.scenes.length !== rules.sceneCount) v.push(`script must have exactly ${rules.sceneCount} scenes (got ${draft.scenes.length})`);

  const total = draft.scenes.reduce((n, s) => n + countWords(s.narration), 0);
  if (total < rules.minWords || total > rules.maxWords) {
    const perScene = draft.scenes.map((s, i) => `scene ${i + 1}: ${countWords(s.narration)}`).join(', ');
    const budget = sceneWordBudget(rules);
    v.push(
      `total narration must be between ${rules.minWords} and ${rules.maxWords} words (got ${total}; ${perScene}); ` +
        `${total < rules.minWords ? 'add' : 'remove'} about ${total < rules.minWords ? rules.minWords - total + 5 : total - rules.maxWords + 5} words — ` +
        (rules.sceneRange
          ? `every scene after the hook should have ${budget.min}-${budget.max} words` +
            (() => {
              const short = draft.scenes.map((s, i) => ({ n: i + 1, w: countWords(s.narration) })).filter((x) => x.n > 1 && x.w < budget.min);
              return total < rules.minWords && short.length ? `; add one full sentence (7-12 words) to scene${short.length > 1 ? 's' : ''} ${short.map((x) => x.n).join(', ')}` : '';
            })()
          : `scenes 2-${rules.sceneCount} should each have ${budget.min}-${budget.max} words`)
    );
  }

  const hook = draft.scenes[0]?.narration ?? '';
  const hookWords = countWords(hook);
  if (hookWords === 0) v.push('scene 1 (hook) narration is empty');
  else if (hookWords > rules.hookMaxWords) v.push(`scene 1 hook must be at most ${rules.hookMaxWords} words (got ${hookWords})`);
  if (rules.hookMustBeQuestion && !rules.hookType && !hook.trim().endsWith('?')) v.push('scene 1 hook must be the viewer question, ending with "?"');
  if (rules.editorial) {
    v.push(...validateEditorial(draft.scenes.map((s) => ({ narration: s.narration, claimRefs: s.claimRefs })), { ...DEFAULT_EDITORIAL, hookType: rules.hookType ?? 'statement' }));
  } else if (rules.hookType === 'question' && !hook.trim().endsWith('?')) v.push('scene 1 hook must be the viewer question, ending with "?"');
  if (rules.requireBeats) v.push(...validateBeats(draft.scenes, rules.beatWords ?? [3, 12]));

  const used = new Set<string>();
  draft.scenes.forEach((s, i) => {
    const n = i + 1;
    if (countWords(s.narration) < (i === 0 ? 1 : 4)) v.push(`scene ${n} narration is too short`);
    if (!s.visualObjective.trim()) v.push(`scene ${n} visualObjective is empty`);
    if (s.assetKeywords.length < 2 || s.assetKeywords.length > 5) v.push(`scene ${n} needs 2-5 assetKeywords`);
    const subject = (s.visualSubject ?? '').trim();
    if (subject.split(/\s+/).filter(Boolean).length < 2 || subject.length > 60) v.push(`scene ${n} visualSubject must be a concrete 2-6 word description`);
    if (/\d/.test(subject)) v.push(`scene ${n} visualSubject must not contain numbers or dates`);
    const unfilmable = subject.toLowerCase().match(UNSOURCEABLE_SUBJECT);
    if (unfilmable) v.push(`scene ${n} visualSubject "${subject}" asks for a ${unfilmable[1]}, which stock footage does not provide — describe a real filmable scene instead`);
    if ((s.visualExclusions ?? []).length > 4) v.push(`scene ${n} allows at most 4 visualExclusions`);
    for (const ex of s.visualExclusions ?? []) {
      // Exclusions name misleading imagery; negations and shot preferences make every clip fail.
      if (/^(no|not|without|non)\b/i.test(ex.trim()) || ex.trim().split(/\s+/).length > 3) {
        v.push(`scene ${n} visualExclusion "${ex}" must name a kind of misleading imagery in 1-3 words (e.g. "cartoon", "modern city"), not a negation or shot preference`);
      }
    }
    for (const k of s.assetKeywords) {
      if (/\d/.test(k)) v.push(`scene ${n} assetKeyword "${k}" must not contain numbers or dates`);
      if (k.trim().split(/\s+/).length > 3) v.push(`scene ${n} assetKeyword "${k}" must be at most 3 words`);
    }
    for (const ref of s.claimRefs) {
      if (!ctx.claims.has(ref)) v.push(`scene ${n} references unknown claim "${ref}"`);
      else used.add(ref);
    }
    const supporting = s.claimRefs.filter((r) => ctx.claims.has(r)).map((r) => ctx.claims.get(r)!);
    const badNums = unsupportedNumbers(s.narration, supporting);
    if (badNums.length > 0) {
      v.push(`scene ${n} states number(s) ${badNums.join(', ')} that its referenced claims do not support (reference the claim containing them, or remove the number)`);
    }
  });

  const needed = Math.min(rules.minClaimRefs, ctx.claims.size);
  if (used.size < needed) v.push(`script must reference at least ${needed} distinct verified claims (got ${used.size})`);

  const title = draft.title.trim();
  if (title.length < 10 || title.length > 90) v.push(`title must be 10-90 characters (got ${title.length})`);
  if (/[<>]/.test(title)) v.push('title must not contain < or >');
  if (draft.description.trim().length < 30 || draft.description.length > 1000) v.push('description must be 30-1000 characters');

  const titleTokens = significantTokens(title);
  for (const prev of ctx.previousTitles ?? []) {
    if (overlapCoefficient(titleTokens, significantTokens(prev)) >= 0.8) {
      v.push(`title is a near-duplicate of a previous Short ("${prev}")`);
      break;
    }
  }
  const hookTokens = significantTokens(hook);
  for (const prev of ctx.previousHooks ?? []) {
    if (hookTokens.length >= 2 && overlapCoefficient(hookTokens, significantTokens(prev)) >= 0.9) {
      v.push(`hook is a near-duplicate of a previous Short ("${prev}")`);
      break;
    }
  }
  return v;
}

/**
 * Deterministic beat repair, applied before validation: a beat shorter than the minimum is joined
 * to its neighbour (the previous beat, or the next one for a scene's first beat), and consecutive
 * beats with the same subject are joined — exactly the fix the validator would ask the writer for.
 * A short beat joins the following beat instead when the previous one ends a sentence.
 * Beat texts stay exact, contiguous slices of the narration; the joined beat keeps the subject of
 * its longer part. A join that would exceed the maximum beat length is left for the validator.
 * Mutates `scenes` in place and returns the number of joins.
 */
export function mergeShortBeats(scenes: ScriptDraftScene[], beatWords: [number, number]): number {
  for (const s of scenes) canonicalizeBeats(s, beatWords[1]);
  let joins = 0;
  const len = (b: ScriptDraftBeat) => tokenizeWords(b.text).length;
  const same = (a: ScriptDraftBeat, b: ScriptDraftBeat) => significantTokens(a.visualSubject).join(' ') === significantTokens(b.visualSubject).join(' ');
  for (const s of scenes) {
    const beats = s.beats;
    if (!beats || beats.length < 2) continue;
    // Only repair beats that already split the narration exactly; anything else goes to the writer.
    if (tokenizeWords(s.narration).join(' ') !== beats.flatMap((b) => tokenizeWords(b.text)).join(' ')) continue;
    let changed = true;
    while (changed && beats.length > 1) {
      changed = false;
      for (let j = 0; j < beats.length; j++) {
        const short = len(beats[j]) < beatWords[0];
        const dupOfPrev = j > 0 && same(beats[j], beats[j - 1]);
        if (!short && !dupOfPrev) continue;
        // Join within the sentence: a short beat goes forward when the previous beat ends a sentence.
        const prevEndsSentence = j > 0 && /[.!?]["')”]*$/.test(beats[j - 1].text.trim());
        const k = dupOfPrev || (j > 0 && !(prevEndsSentence && j + 1 < beats.length)) ? j - 1 : j + 1;
        const [a, b] = k < j ? [beats[k], beats[j]] : [beats[j], beats[k]];
        if (len(a) + len(b) > beatWords[1]) continue;
        const keep = len(a) >= len(b) ? a : b;
        beats.splice(Math.min(j, k), 2, { ...keep, text: `${a.text.trim()} ${b.text.trim()}` });
        joins++;
        changed = true;
        break;
      }
    }
  }
  return joins;
}

const wordKey = (t: string) => t.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Beat texts are re-cut from the narration's own tokens when they match it ignoring case and
 * punctuation (live: a planner repeated a beat split that differed only in typography four times),
 * and a missing tail of the narration is added to the last beat when that keeps it within the
 * maximum length. Anything else is left for the validator. Returns true when it changed a beat.
 */
export function canonicalizeBeats(scene: ScriptDraftScene, maxBeatWords: number): boolean {
  const beats = scene.beats;
  if (!beats || beats.length === 0) return false;
  const raw = tokenizeWords(scene.narration);
  const narr = raw.map(wordKey);
  const per = beats.map((b) => tokenizeWords(b.text).map(wordKey).filter(Boolean));
  const flat = per.flat();
  const content = narr.filter(Boolean);
  if (flat.length > content.length || flat.some((k, i) => k !== content[i])) return false;
  const missing = content.length - flat.length;
  if (missing > 0 && per[per.length - 1].length + missing > maxBeatWords) return false;
  if (missing > 0) per[per.length - 1].push(...content.slice(flat.length));
  // Hand out the narration's raw tokens: each beat takes as many word tokens as it matched, plus
  // any punctuation-only tokens that follow them.
  let p = 0;
  const texts = per.map((keys) => {
    const out: string[] = [];
    let taken = 0;
    while (p < raw.length && taken < keys.length) {
      if (narr[p]) taken++;
      out.push(raw[p++]);
    }
    while (p < raw.length && !narr[p]) out.push(raw[p++]);
    return out.join(' ');
  });
  if (p < raw.length) texts[texts.length - 1] = `${texts[texts.length - 1]} ${raw.slice(p).join(' ')}`.trim();
  const changed = texts.some((t, j) => t !== beats[j].text.trim());
  texts.forEach((t, j) => (beats[j] = { ...beats[j], text: t }));
  return changed;
}

/**
 * Clause-level beats: each scene's beats must be exact, contiguous slices of its narration (so beats
 * can be timed from word timestamps), each long enough to show and short enough to keep the picture
 * changing, with a literal, filmable subject.
 */
export function validateBeats(scenes: ScriptDraftScene[], beatWords: [number, number]): string[] {
  const v: string[] = [];
  scenes.forEach((s, i) => {
    const n = i + 1;
    const beats = s.beats ?? [];
    if (beats.length === 0) {
      v.push(`scene ${n} needs "beats": split its narration into clause-level beats, each with its own visualSubject`);
      return;
    }
    const sceneTokens = tokenizeWords(s.narration);
    const beatTokens = beats.flatMap((b) => tokenizeWords(b.text));
    if (sceneTokens.join(' ') !== beatTokens.join(' ')) {
      const k = sceneTokens.findIndex((t, i) => t !== beatTokens[i]);
      const at = k < 0 ? beatTokens.length : k;
      const where =
        at >= beatTokens.length
          ? `the beats stop after word ${at}; missing: "${sceneTokens.slice(at).join(' ').slice(0, 80)}"`
          : `word ${at + 1} is "${beatTokens[at]}" but the narration says "${sceneTokens[at] ?? '(end)'}"`;
      v.push(`scene ${n} beats must split its narration exactly, in order, without changing a word: ${where}. Narration: "${s.narration.slice(0, 160)}"`);
      return;
    }
    beats.forEach((b, j) => {
      const words = tokenizeWords(b.text).length;
      const isOnly = beats.length === 1;
      if (words > beatWords[1]) v.push(`scene ${n} beat ${j + 1} has ${words} words (max ${beatWords[1]}): split it at a clause boundary`);
      if (!isOnly && words < beatWords[0]) v.push(`scene ${n} beat ${j + 1} has only ${words} words (min ${beatWords[0]}): merge it with a neighbour`);
      const subject = b.visualSubject.trim();
      if (subject.split(/\s+/).filter(Boolean).length > 6) v.push(`scene ${n} beat ${j + 1} visualSubject must be 1-6 words`);
      if (/\d/.test(subject)) v.push(`scene ${n} beat ${j + 1} visualSubject must not contain numbers or dates`);
      const unfilmable = b.graphic ? null : subject.toLowerCase().match(UNSOURCEABLE_SUBJECT);
      if (unfilmable) v.push(`scene ${n} beat ${j + 1} visualSubject "${subject}" asks for a ${unfilmable[1]}, which stock footage does not provide`);
      if (b.assetKeywords.length < 1 || b.assetKeywords.length > 4) v.push(`scene ${n} beat ${j + 1} needs 1-4 assetKeywords`);
      for (const ex of b.visualExclusions ?? []) {
        if (/^(no|not|without|non)\b/i.test(ex.trim()) || ex.trim().split(/\s+/).length > 3) v.push(`scene ${n} beat ${j + 1} visualExclusion "${ex}" must name misleading imagery in 1-3 words`);
      }
      // Consecutive beats with the same subject add a cut without adding information.
      if (j > 0 && significantTokens(subject).join(' ') === significantTokens(beats[j - 1].visualSubject).join(' ')) {
        v.push(`scene ${n} beats ${j} and ${j + 1} show the same subject "${subject}": merge them (a cut must show something new)`);
      }
    });
  });
  return v;
}
