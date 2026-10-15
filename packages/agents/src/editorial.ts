import type { HookType } from '@shorts/schemas';
import { countWords } from '@shorts/core';

/**
 * Editorial contract for the micro-explainer format (research/2026-10-reference-analysis/REPORT.md).
 * These checks are one deterministic layer; the script editor (script-editor.ts) judges hook
 * concreteness, specificity, causal flow and payoff on top of them.
 */

/**
 * Filler and empty-praise phrases. Taken from our own weak scripts (smallpox, Tacoma, crow, planes)
 * plus common Shorts filler. Matching is case-insensitive on word boundaries.
 */
export const BANNED_PHRASES: readonly string[] = [
  'a marvel',
  'engineering spectacle',
  'true spectacle',
  'pivotal moment',
  'significant turning point',
  'turning point in history',
  'historic victory',
  'showcasing',
  'a testament to',
  'stands as a testament',
  'fascinating',
  'incredible',
  'amazing',
  'mind-blowing',
  'mind blowing',
  "you won't believe",
  'shocking',
  'insane',
  'unbelievable',
  'in this video',
  "let's dive",
  'stay tuned',
  'did you know',
  'global concern',
  'paying off',
  'invaluable lessons',
  'the rest is history',
  'unique legal twist',
  'witness the',
  'real velocity',
  'with elegance and ambition',
  'changed the world forever',
  'forever changed',
];

/** Closing sentences that summarize or moralize instead of paying off with a concrete fact. */
const GENERIC_ENDING: RegExp[] = [
  /^\s*(so\s+)?next time\b/i,
  /^\s*(in conclusion|in the end|ultimately|all in all|overall)\b/i,
  /^\s*this (event |failure |discovery |story )?(marked|shows|proves|reminds|was a|is a)\b/i,
  /^\s*(and )?that'?s (why|how) (we|it all|this)\b/i,
  /\bremains? (a|an) (mystery|enigma)\b/i,
  /\b(forever|history) (changed|books)\b/i,
  /\blessons? (learned|for us all)\b/i,
];

/** Dramatic intensifiers that claim more than any verified fact can support. */
const UNSUPPORTED_DRAMA = /\b(the most (dangerous|terrifying|insane|shocking)|deadliest ever|nobody knows|no one knows|scientists are baffled|baffled experts|changed everything)\b/i;

export function findBannedPhrases(text: string): string[] {
  const t = text.toLowerCase();
  return BANNED_PHRASES.filter((p) => new RegExp(`(^|[^a-z])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i').test(t));
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isGenericEnding(sentence: string): boolean {
  return GENERIC_ENDING.some((r) => r.test(sentence));
}

export interface EditorialDraftScene {
  narration: string;
  claimRefs: string[];
}

export interface EditorialRules {
  hookType: HookType;
  /** Hard limit; the 6-14 word target is guidance (grammar and accuracy come first). */
  maxSentenceWords: number;
  /** The answer or stake must begin within this many spoken words (≈5 s at ~2.8 words/s). */
  answerWithinWords: number;
  /** Body facts (scenes between the answer and the payoff), each backed by a claim. */
  minBodyFacts: number;
  maxBodyFacts: number;
}

export const DEFAULT_EDITORIAL: Omit<EditorialRules, 'hookType'> = {
  maxSentenceWords: 22,
  answerWithinWords: 16,
  minBodyFacts: 2,
  maxBodyFacts: 4,
};

/** Statistics recorded for every script (also used by content QA and analytics). */
export function sentenceStats(scenes: EditorialDraftScene[]): { sentences: number; meanWords: number; maxWords: number; withinTarget: number } {
  const lens = scenes.flatMap((s) => splitSentences(s.narration)).map(countWords);
  return {
    sentences: lens.length,
    meanWords: lens.length ? Math.round((lens.reduce((a, b) => a + b, 0) / lens.length) * 10) / 10 : 0,
    maxWords: lens.length ? Math.max(...lens) : 0,
    withinTarget: lens.filter((n) => n >= 6 && n <= 14).length,
  };
}

/**
 * Deterministic editorial checks for the micro-explainer structure:
 * hook (by type) → answer/stake by ~5 s → 2-4 causal facts → concrete, verified payoff.
 * Returns human-readable violations used both for corrective re-prompts and by content QA.
 */
export function validateEditorial(scenes: EditorialDraftScene[], rules: EditorialRules): string[] {
  const v: string[] = [];
  if (scenes.length === 0) return ['script has no scenes'];
  const hook = scenes[0].narration.trim();
  const all = scenes.map((s) => s.narration).join(' ');

  // Hook type.
  if (rules.hookType === 'question' && !hook.endsWith('?')) v.push('hook must be the viewer question (question hook variant), ending with "?"');
  if (rules.hookType !== 'question' && /\?\s*$/.test(hook)) {
    v.push(`hook must be a ${rules.hookType === 'scene' ? 'scene already in progress (an action happening)' : 'concrete statement (a surprising claim)'}, not a question`);
  }
  if (rules.hookType !== 'question' && /^\s*(have you ever|did you know|ever wondered|what if|imagine)\b/i.test(hook)) {
    v.push('hook must open on the concrete subject or action, not a rhetorical lead-in ("Have you ever…", "Imagine…")');
  }

  // Answer or stake early: scene 2 starts within the word budget and is backed by a claim.
  if (scenes.length < 2) v.push('script needs an answer/stake scene after the hook');
  else {
    if (countWords(hook) > rules.answerWithinWords) v.push(`the answer must start within the first ${rules.answerWithinWords} words; the hook alone has ${countWords(hook)}`);
    if (scenes[1].claimRefs.length === 0) v.push('scene 2 must give the direct answer or the stake, backed by a verified claim (claimRefs)');
  }

  // Body: causally connected, claim-backed facts.
  const body = scenes.slice(2, -1);
  const factScenes = body.filter((s) => s.claimRefs.length > 0);
  if (factScenes.length < rules.minBodyFacts) v.push(`body needs at least ${rules.minBodyFacts} specific facts backed by claims (got ${factScenes.length})`);
  if (body.length > rules.maxBodyFacts) v.push(`body has ${body.length} scenes; keep it to at most ${rules.maxBodyFacts} facts`);

  // Payoff: last scene is a verified, concrete fact, not a summary or moral.
  const last = scenes[scenes.length - 1];
  if (scenes.length >= 3 && last.claimRefs.length === 0) v.push('the final scene must be the payoff: the most surprising verified fact (cite its claim)');
  const lastSentence = splitSentences(last.narration).pop() ?? '';
  if (isGenericEnding(lastSentence)) v.push(`the last sentence is a generic ending ("${lastSentence}"); end on the concrete payoff fact instead`);

  // Language.
  const banned = findBannedPhrases(all);
  if (banned.length) v.push(`remove filler/empty praise: ${banned.map((b) => `"${b}"`).join(', ')} — say the concrete fact instead`);
  const drama = all.match(UNSUPPORTED_DRAMA);
  if (drama) v.push(`unsupported dramatic claim "${drama[0]}": state only what the verified facts say`);
  for (const s of scenes.flatMap((x) => splitSentences(x.narration))) {
    const n = countWords(s);
    if (n > rules.maxSentenceWords) v.push(`sentence too long (${n} words, max ${rules.maxSentenceWords}): "${s.slice(0, 80)}…" — split it`);
  }
  return v;
}
