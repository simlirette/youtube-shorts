import type { DurationBand, HookType, ShortFormat, TopicCandidate } from '@shorts/schemas';
import type { ScriptRules } from './script-validation.js';

/**
 * A script structure. MICRO_EXPLAINER is the target format (research/2026-10-reference-analysis/
 * REPORT.md §2); the others are kept for controlled experiments and legacy jobs.
 */
export interface FormatSpec {
  id: ShortFormat;
  rules: ScriptRules;
  /** Duration the format is written for (story outlines, metadata). */
  targetSeconds: number;
  /** Format-specific writing instructions inserted into the script prompt. */
  guidance: (topic: TopicCandidate, hookType?: HookType) => string;
  /** Only usable for topics that carry a viewer question (gap discovery). */
  needsQuestion: boolean;
  /** Whether the format uses clause-level visual beats. */
  beats: boolean;
}

const questionOf = (t: TopicCandidate) => t.gap?.question ?? t.title;

/**
 * Word budgets per duration band at the target pace. Live narration with gap tightening ran at
 * 2.9-3.1 words/s (2026-10-10), so 80 words gave 27 s: budgets assume ~2.9 words/s.
 */
export const DURATION_BANDS: Record<DurationBand, { minWords: number; maxWords: number; targetSeconds: number; label: string }> = {
  standard: { minWords: 88, maxWords: 120, targetSeconds: 38, label: '30-45 s' },
  short: { minWords: 70, maxWords: 95, targetSeconds: 30, label: '25-35 s' },
};

export function hookInstruction(hookType: HookType, topic: TopicCandidate): string {
  const q = questionOf(topic);
  if (hookType === 'question') return `Scene 1 (hook) asks the viewer's question, ending with "?" (at most 14 words). Topic question: "${q}".`;
  if (hookType === 'scene') {
    return `Scene 1 (hook) drops the viewer into an action already happening, in the present or simple past, naming the concrete subject (e.g. "A 300-ton airliner tilts hard right seconds after leaving the runway."). At most 14 words, no question, no "Imagine…". It must be true and supported by a claim if it states a fact.`;
  }
  return `Scene 1 (hook) is ONE concrete, surprising statement about the subject that the rest of the video pays off (e.g. "Airliners turn right after takeoff on purpose, and it saves lives."). At most 14 words, no question, no "Did you know", no "Have you ever". The viewer's question it answers: "${q}".`;
}

export const FORMATS: Record<ShortFormat, FormatSpec> = {
  MICRO_EXPLAINER: {
    id: 'MICRO_EXPLAINER',
    // Word range is set from the duration band by rulesFor(); scene range = hook + answer + 2-4 facts + payoff.
    rules: { minWords: 88, maxWords: 120, hookMaxWords: 14, sceneCount: 5, sceneRange: [5, 7], minClaimRefs: 4, editorial: true, requireBeats: true, beatWords: [3, 12] },
    targetSeconds: 38,
    needsQuestion: false,
    beats: true,
    guidance: (t, hookType = 'statement') =>
      `FORMAT: faceless micro-explainer. Structure, one idea per scene:
- ${hookInstruction(hookType, t)}
- Scene 2: the direct answer or the stake, in one sentence, backed by a claim. The viewer must know what the video is about within ~5 seconds.
- Scenes 3 to N-1: 2-4 specific facts, each backed by a claim, each following from the previous one ("so", "but", "that's why", "which means"). Escalate: each fact more surprising or more concrete than the last.
- Last scene: the payoff — the single most surprising verified fact, stated concretely. It is the final sentence. No summary, no moral, no "next time", no call to subscribe.
- Write like speech: sentences of 6-14 words where natural, concrete nouns and verbs, numbers exactly as in the claims. Never use filler or empty praise ("fascinating", "a marvel", "pivotal moment", "showcasing", "incredible").`,
  },
  STORY: {
    id: 'STORY',
    // Upper bound is derived from the voice (see SCRIPT_MAX_WORDS); overridden from config by the runner.
    rules: { minWords: 100, maxWords: 118, hookMaxWords: 7, sceneCount: 5, minClaimRefs: 3 },
    targetSeconds: 50,
    needsQuestion: false,
    beats: false,
    guidance: () => `FORMAT: mini-documentary. Scene 1 is a hook (a question or striking statement). Scenes 2-5 tell the story: context, development, twist, payoff.`,
  },
  QUESTION_ANSWER: {
    id: 'QUESTION_ANSWER',
    rules: { minWords: 55, maxWords: 85, hookMaxWords: 14, sceneCount: 4, minClaimRefs: 2, hookMustBeQuestion: true },
    targetSeconds: 32,
    needsQuestion: true,
    beats: false,
    guidance: (t) =>
      `FORMAT: answer a real viewer question fast.
- Scene 1 (hook) asks the viewer's question, ending with "?": "${questionOf(t)}". Keep its meaning; you may tighten the wording (at most 14 words).
- Scene 2 gives the direct answer immediately, in one or two sentences (viewers leave if the answer is delayed).
- Scene 3 explains why/how with the most concrete verified detail.
- Scene 4 adds one surprising verified fact the viewer did not expect, as the closing line.
- Every sentence must earn its place; no filler, no "in this video", no calls to subscribe.`,
  },
  THREE_REASONS: {
    id: 'THREE_REASONS',
    rules: { minWords: 65, maxWords: 95, hookMaxWords: 14, sceneCount: 5, minClaimRefs: 3, hookMustBeQuestion: true },
    targetSeconds: 38,
    needsQuestion: true,
    beats: false,
    guidance: (t) =>
      `FORMAT: three reasons.
- Scene 1 (hook) asks the viewer's question, ending with "?": "${questionOf(t)}". At most 14 words.
- Scenes 2, 3 and 4 each give ONE distinct reason, starting with "One:", "Two:" and "Three:", each backed by a verified claim.
- Scene 5 is a one-sentence closing payoff that ties the reasons together (no new unverified fact).
- No filler, no "in this video", no calls to subscribe.`,
  },
};

export interface FormatHistoryEntry {
  format: ShortFormat;
  /** Performance signal from analytics (e.g. log views/day), when known. */
  performance?: number;
}

/**
 * Chooses the format for a topic: question topics rotate between question formats; the format used
 * least recently wins, nudged by measured performance; never the same format three times in a row.
 * A single enabled format (the default MICRO_EXPLAINER) is always returned as is.
 */
export function chooseFormat(topic: TopicCandidate, recent: FormatHistoryEntry[], enabled: ShortFormat[], weights: Partial<Record<ShortFormat, number>> = {}): ShortFormat {
  if (enabled.length === 1 && !FORMATS[enabled[0]].needsQuestion) return enabled[0];
  const pool = enabled.filter((f) => (FORMATS[f].needsQuestion ? Boolean(topic.gap) : true));
  const questionPool = pool.filter((f) => FORMATS[f].needsQuestion);
  const candidates = topic.gap && questionPool.length ? questionPool : pool.filter((f) => !FORMATS[f].needsQuestion);
  if (candidates.length === 0) return enabled.includes('MICRO_EXPLAINER') ? 'MICRO_EXPLAINER' : 'STORY';
  const lastTwo = recent.slice(0, 2).map((r) => r.format);
  const scored = candidates.map((f) => {
    const lastUse = recent.findIndex((r) => r.format === f);
    const recency = lastUse === -1 ? recent.length + 1 : lastUse; // larger = used longer ago
    const blocked = lastTwo.length === 2 && lastTwo.every((x) => x === f);
    return { f, score: (blocked ? -1000 : 0) + recency + (weights[f] ?? 0) };
  });
  scored.sort((a, b) => b.score - a.score || a.f.localeCompare(b.f));
  return scored[0].f;
}

/**
 * Rules for a format under a production variant: the duration band sets the word range for the
 * micro-explainer; every range is capped by the voice-derived maximum.
 */
export function rulesFor(format: ShortFormat, maxWordsCeiling: number, opts: { hookType?: HookType; durationBand?: DurationBand } = {}): ScriptRules {
  const r = { ...FORMATS[format].rules };
  if (format === 'MICRO_EXPLAINER') {
    const band = DURATION_BANDS[opts.durationBand ?? 'standard'];
    r.minWords = band.minWords;
    r.maxWords = band.maxWords;
    r.hookType = opts.hookType ?? 'statement';
  }
  return { ...r, maxWords: Math.min(r.maxWords, maxWordsCeiling), minWords: Math.min(r.minWords, maxWordsCeiling) };
}
