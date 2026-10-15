import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { GraphicSpecSchema, HookType, ResearchPacket, ShortScript, ShortScriptSchema, StoryOutline, TopicCandidate } from '@shorts/schemas';
import { validateGraphic } from './graphics.js';
import { FORMATS, type FormatSpec } from './formats.js';
import type { LLMProvider } from '@shorts/providers';
import { ValidationError, countWords, logger, tokenizeWords } from '@shorts/core';
import { ScriptDraft, ScriptRules, mergeShortBeats, sceneWordBudget, validateBeats, validateScriptDraft } from './script-validation.js';
import { materialFindings, reviewNarration } from './narration-review.js';
import { claimSourceStatus } from './source-policy.js';

const BeatOutputSchema = z.object({
  text: z.string().min(1),
  visualIntent: z.string().default(''),
  visualSubject: z.string().default(''),
  assetKeywords: z.array(z.string().min(1)).default([]),
  visualExclusions: z.array(z.string()).default([]),
  graphic: GraphicSpecSchema.nullish(),
});

const ScriptOutputSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  titleCard: z.string().default(''),
  scenes: z
    .array(
      z.object({
        narration: z.string().min(1),
        visualObjective: z.string().min(1),
        assetKeywords: z.array(z.string().min(1)).default([]),
        visualSubject: z.string().default(''),
        visualExclusions: z.array(z.string()).default([]),
        textOverlay: z.string().optional(),
        claimRefs: z.array(z.string()).default([]),
        beats: z.array(BeatOutputSchema).default([]),
      })
    )
    .min(1),
});

const BeatPlanSchema = z.object({ scenes: z.array(z.object({ scene: z.number().int().optional(), beats: z.array(BeatOutputSchema).min(1) })).min(1) });

/**
 * Regroups beats by scene when the model grouped them wrong (live: every beat returned under one
 * scene). Only possible when the beats, in order, tile the whole narration exactly and no beat
 * crosses a scene boundary; otherwise returns null and the plan is rejected.
 */
export function regroupBeats<T extends { text: string }>(narrations: string[], beats: T[]): T[][] | null {
  const sceneTokens = narrations.map((n) => tokenizeWords(n));
  const out: T[][] = narrations.map(() => []);
  let scene = 0;
  let used = 0;
  for (const b of beats) {
    const n = tokenizeWords(b.text).length;
    if (scene >= narrations.length || n === 0) return null;
    const slice = sceneTokens[scene].slice(used, used + n);
    if (slice.length !== n || slice.join(' ') !== tokenizeWords(b.text).join(' ')) return null;
    out[scene].push(b);
    used += n;
    if (used === sceneTokens[scene].length) {
      scene++;
      used = 0;
    }
  }
  return scene === narrations.length && used === 0 ? out : null;
}

/** What the footage preflight checks: one item per scene, or per beat for beat formats. */
export interface VisualPreflightItem {
  label: string;
  visualSubject: string;
  assetKeywords: string[];
  visualExclusions: string[];
}

export interface ScriptwriterOptions {
  rules: ScriptRules;
  maxAttempts: number;
  /** Script structure (default STORY). `rules` must already be the format's rules. */
  format?: FormatSpec;
  /** Topic, so question formats can open with the viewer's real question. */
  topic?: TopicCandidate;
  /** Hook type from the job's production variant (defaults to the format's rule). */
  hookType?: HookType;
  /** Generate an on-screen title card (2-6 words). */
  titleCard?: boolean;
  /**
   * Checks before any voice credits are spent that stock footage exists for each scene's visual
   * subject; returns violations (empty = fine), fed back to the writer like any other rule.
   */
  visualPreflight?: (items: VisualPreflightItem[]) => Promise<string[]>;
  /**
   * Beat formats: after one retry with stock-tag hints, up to this many beats may still lack enough
   * footage. They are accepted for the human-review path (sourcing falls back to the scene subject
   * and marks the asset NEEDS_REVIEW) instead of failing the script. Default 2.
   */
  maxFootageShortBeats?: number;
  /**
   * Beats may be shown as locally rendered graphics (numbers, comparisons, short processes, key
   * terms) instead of stock footage. At most this share of beats (default 0.4); 0 disables graphics.
   */
  graphicsMaxShare?: number;
}

export interface ScriptContext {
  previousTitles: string[];
  previousHooks: string[];
  directorNotes?: string;
}

/**
 * Map of short claim refs (C1..Cn) to usable claim IDs + supporting text, shared with content QA.
 * Usable = VERIFIED and supported by at least one source that is not REJECTED by the source policy.
 */
export function verifiedClaimRefs(research: ResearchPacket): { refToId: Map<string, string>; idToRef: Map<string, string>; support: Map<string, string>; lines: string[] } {
  const verified = research.claims.filter((c) => c.verificationStatus === 'VERIFIED' && !claimSourceStatus(c, research.sources).rejected);
  const refToId = new Map<string, string>();
  const idToRef = new Map<string, string>();
  const support = new Map<string, string>();
  const lines: string[] = [];
  verified.forEach((c, i) => {
    const ref = `C${i + 1}`;
    refToId.set(ref, c.id);
    idToRef.set(c.id, ref);
    support.set(ref, [c.text, ...c.evidence.map((e) => e.quote)].join(' '));
    lines.push(`[${ref}] ${c.text}`);
  });
  return { refToId, idToRef, support, lines };
}

/** URLs of HIGH/ACCEPTABLE sources that support the given claims, most credible first. */
export function citableSourceUrls(research: ResearchPacket, claimIds: string[]): string[] {
  const ids = new Set<string>();
  for (const id of claimIds) {
    const claim = research.claims.find((c) => c.id === id);
    if (claim) for (const s of claimSourceStatus(claim, research.sources).citableSourceIds) ids.add(s);
  }
  const order = { HIGH: 0, ACCEPTABLE: 1, QUESTIONABLE: 2, REJECTED: 3 } as const;
  return research.sources
    .filter((s) => ids.has(s.id))
    .sort((a, b) => order[a.credibility?.tier ?? 'QUESTIONABLE'] - order[b.credibility?.tier ?? 'QUESTIONABLE'])
    .map((s) => s.url);
}

export class ScriptwriterAgent {
  /** `reviewer` (when given) fact-checks each structurally valid draft before it is accepted. */
  constructor(private readonly llm: LLMProvider, private readonly opts: ScriptwriterOptions, private readonly reviewer?: LLMProvider) {}

  async writeScript(story: StoryOutline, research: ResearchPacket, ctx: ScriptContext): Promise<ShortScript> {
    const { refToId, support, lines } = verifiedClaimRefs(research);
    if (lines.length === 0) throw new ValidationError('Cannot write a script without verified claims');
    const r = this.opts.rules;
    const budget = sceneWordBudget(r);
    const format = this.opts.format ?? FORMATS.STORY;
    if (format.needsQuestion && !this.opts.topic?.gap) throw new ValidationError(`Format ${format.id} needs a topic with a viewer question`);
    const hookType = this.opts.hookType ?? r.hookType;
    const formatGuidance = format.guidance(this.opts.topic ?? ({ title: story.logline } as TopicCandidate), hookType);
    const sceneRule = r.sceneRange
      ? `${Math.round((r.sceneRange[0] + r.sceneRange[1]) / 2)} scenes (between ${r.sceneRange[0]} and ${r.sceneRange[1]} are accepted).`
      : `Exactly ${r.sceneCount} scenes.`;
    // Live drafts came back 30-50 % short on first attempts (2026-10-10): give a per-scene budget.
    const target = Math.round((r.minWords + r.maxWords) / 2);
    const lengthRule = format.beats
      ? // Models undercount words but follow sentence counts: state the budget as sentences.
        `Length: total narration between ${r.minWords} and ${r.maxWords} words (about ${format.targetSeconds} seconds) — aim for about ${target}. Scene 1 is ONE sentence of at most ${r.hookMaxWords} words. Every other scene is TWO or THREE complete sentences of 7-12 words each (${budget.min}-${budget.max} words per scene); a scene of one short sentence is too short. With 6 scenes that is about ${12 + 5 * budget.target} words. Drafts under ${r.minWords} words are rejected.`
      : `Length: scene 1 (the hook) is ONE sentence of at most ${r.hookMaxWords} words. Scenes 2-${r.sceneCount} have ${budget.min}-${budget.max} words each, in complete short spoken sentences. Total narration must be between ${r.minWords} and ${r.maxWords} words (about ${format.targetSeconds} seconds of voiceover).`;
    // Beat formats are written in two calls: the narration (validated, fact-checked) first, then the
    // visual beats on the frozen narration. One combined call let every beat or footage defect force a
    // full rewrite, which broke length or editorial rules again (live: 0/6 scripts, 2026-10-10).
    const beatRules = `1. VISUAL BEATS: split every scene's narration into "beats" — consecutive clauses of ${r.beatWords?.[0] ?? 3}-${r.beatWords?.[1] ?? 12} words, each about 2-3.5 seconds of speech. The beat "text" values of a scene, joined in order, must reproduce the scene narration EXACTLY (same words, same punctuation). Start a new beat when the narration introduces a new action, object or causal step; do not split just to add cuts. A scene of up to ${r.beatWords?.[1] ?? 12} words may be a single beat.
2. Each beat has "visualSubject": the literal, filmable thing on screen while that clause is spoken (1-4 words, e.g. "airliner banking", "cargo ship", "bridge cables") — something generic stock libraries tag literally; no names, dates, numbers, maps, diagrams, animations or text. Consecutive beats must show different subjects.
3. "assetKeywords": 1-4 stock-footage search terms (the first restates the subject). "visualIntent": what the shot should make the viewer understand. "visualExclusions": 0-3 kinds of misleading imagery (e.g. "cartoon"); never shot preferences or negations. Usually leave it empty.${
      (this.opts.graphicsMaxShare ?? 0) > 0
        ? `
5. GRAPHICS: a beat whose point is a number, a comparison, a short cause-and-effect sequence or a technical term that no camera can film may instead carry "graphic" (otherwise leave "graphic" null). Templates:
   {"template":"stat","value":"617,000","label":"U.S. bridges"} — one number spoken in that beat, label 1-4 words;
   {"template":"compare","items":[{"label":"Cars","value":2,"display":"2 s"},{"label":"Trains","value":7,"display":"7 s"}]} — 2-3 values spoken in that beat;
   {"template":"process","steps":["Wheel hits gap","Rail flexes","Clack"]} — 2-4 steps of 1-4 words;
   {"template":"keyword","text":"Wind shear"} — a term of 1-3 words.
   A graphic beat has at least 5 words. Every number in a graphic must be spoken in that same beat, written the same way, and every word must come from the narration; nothing else. Use graphics for at most ${Math.round((this.opts.graphicsMaxShare ?? 0.4) * 100)} % of beats, never for two beats in a row, and keep filmable clauses as stock footage. A graphic beat still has a visualSubject (e.g. "number card") and one assetKeyword.`
        : ''
    }`;
    const visualRules = `6. "visualSubject": the concrete thing that must be on screen, filmable with generic real-world stock footage (e.g. "crystal close-up", "suspension bridge in wind") — 2-6 words, no names, dates or numbers. Stock libraries have no footage of specific historical events, named people or places, and no maps, diagrams, animations, charts or text: pick a generic real scene that illustrates the line instead (e.g. "dense taiga forest" rather than "map of Siberia").
7. "assetKeywords": 2-5 stock-footage search terms per scene (e.g. "suspension bridge", "crowd walking") — no names, dates or numbers, max 3 words each. The FIRST keyword restates the visual subject.
8. "visualExclusions": 0-3 kinds of imagery that would be misleading or factually wrong for this scene (e.g. "cartoon", "modern city" for a historical scene, "crash" when no crash happened). Never shot preferences ("clear sky", "ground view") and never negations ("no clouds") — they make usable footage fail. Usually leave it empty.`;
    const titleRule = this.opts.titleCard
      ? `\n13. "titleCard": the topic as shown on screen during the first seconds, 2-6 words, no question mark, no hashtags (e.g. "Why jets turn right").`
      : '';
    // Every statement the fact-checker has rejected so far; re-sent on each retry so fixes converge.
    const flagged: string[] = [];

    const narrationRules: ScriptRules = format.beats ? { ...r, requireBeats: false } : r;
    const res = await this.llm.generateStructured({
      task: 'script',
      system:
        'You are a YouTube Shorts documentary scriptwriter. You write tight, spoken-word narration and you never state a fact that is not in the verified claim list.',
      prompt: `Write the narration script for a vertical documentary Short.

LOGLINE: ${story.logline}
ARC: hook: ${story.narrativeArc.hook} | context: ${story.narrativeArc.context} | development: ${story.narrativeArc.development} | twist: ${story.narrativeArc.twist} | payoff: ${story.narrativeArc.payoff}

VERIFIED CLAIMS (the only facts you may state; reference them by id):
${lines.join('\n')}
${ctx.directorNotes ? `\nDIRECTOR NOTES (must be addressed): ${ctx.directorNotes}\n` : ''}
HARD RULES (validated automatically; violations are rejected):
1. ${sceneRule}
2. ${lengthRule}
3. ${formatGuidance.replace(/\n/g, '\n   ')}
4. Every factual statement must come from the verified claims; list the ids you rely on in each scene's "claimRefs". Reference at least ${Math.min(r.minClaimRefs, lines.length)} different claims overall.
5. Any number, year or date you say must appear in a claim listed in that same scene's claimRefs. Do not round or convert numbers.
${visualRules}
9. "visualObjective": one sentence describing what the viewer sees.
10. "title": 10-90 characters, no hashtags. "description": 1-3 sentences summarizing the story.
11. Plain spoken English. No stage directions, no emojis, no hashtags inside narration.
12. An automated fact-checker compares every sentence with the claims. Restate facts with their exact figures and scope: never round ("just over two hours" for "two hours and twenty minutes"), generalize ("cut travel times everywhere"), quantify vaguely ("cut in half") or add conclusions ("it remains a mystery") that no claim states. Copy every qualifier of a claim word for word ("on main tracks", "structurally deficient or functionally obsolete", "in the US") even when it makes the sentence longer — dropping a qualifier to keep a sentence short is the most common rejection. Do not add a closing remark about trends, efforts or the future unless a claim states it. Questions and non-factual connective phrases ("here is why") are fine.${titleRule}`,
      schemaHint: format.beats
        ? '{"title":"string","description":"string","titleCard":"string","scenes":[{"narration":"scene 1: one sentence; later scenes: two or three sentences","visualObjective":"string","visualSubject":"string","assetKeywords":["string"],"visualExclusions":["string"],"claimRefs":["C1"]}]}'
        : '{"title":"string","description":"string","scenes":[{"narration":"string","visualObjective":"string","visualSubject":"string","assetKeywords":["string"],"visualExclusions":["string"],"textOverlay":"string","claimRefs":["C1"]}]}',
      schema: ScriptOutputSchema,
      validate: async (draft) => {
        const violations = validateScriptDraft({ ...(draft as ScriptDraft), scenes: draft.scenes.map((s) => ({ ...s, beats: undefined })) }, {
          rules: narrationRules,
          claims: support,
          previousTitles: ctx.previousTitles,
          previousHooks: ctx.previousHooks,
        });
        if (this.opts.titleCard) {
          const tc = draft.titleCard.trim();
          const n = tc.split(/\s+/).filter(Boolean).length;
          if (n < 2 || n > 6 || tc.length > 42 || /[?#]/.test(tc)) violations.push('"titleCard" must be 2-6 words (max 42 characters), no "?" or hashtags');
        }
        if (violations.length > 0) return violations;
        // Beat formats check footage per beat in the second call.
        if (this.opts.visualPreflight && !format.beats) {
          const items: VisualPreflightItem[] = draft.scenes.map((s, i) => ({ label: `scene ${i + 1}`, visualSubject: s.visualSubject, assetKeywords: s.assetKeywords, visualExclusions: s.visualExclusions }));
          const visual = await this.opts.visualPreflight(items);
          if (visual.length > 0) {
            return [...visual, `the other ${items.length - visual.length} scene subjects have enough footage: keep them (and the narration) unchanged and only replace the subjects listed above`];
          }
        }
        if (!this.reviewer) return [];
        const facts = [...refToId.values()].map((id) => research.claims.find((c) => c.id === id)!.text);
        const material = materialFindings(await reviewNarration(this.reviewer, facts, draft.scenes));
        if (material.length === 0) return [];
        const earlier = flagged.filter((f) => !material.some((m) => m.statement === f));
        flagged.push(...material.map((m) => m.statement).filter((st) => !flagged.includes(st)));
        const out = material.map((u) => `unsupported fact (not in verified claims): "${u.statement}" — ${u.reason}. Remove that detail or restate a verified claim instead.`);
        if (earlier.length) out.push(`do not reintroduce statements rejected in earlier attempts: ${earlier.map((e) => `"${e}"`).join('; ')}`);
        return out;
      },
      maxValidationAttempts: this.opts.maxAttempts,
      temperature: 0.7,
      maxTokens: 2000,
    });

    const draft = res.content;
    let beatAttempts = 0;
    if (format.beats) {
      const plan = await this.planBeats(draft.scenes.map((s) => s.narration.trim().replace(/\s+/g, ' ')), beatRules, r.beatWords ?? [3, 12]);
      draft.scenes.forEach((s, i) => (s.beats = plan.scenes[i].beats));
      beatAttempts = plan.attempts;
    }
    const scenes = draft.scenes.map((s, i) => ({
      sceneNumber: i + 1,
      narration: s.narration.trim().replace(/\s+/g, ' '),
      visualObjective: s.visualObjective.trim(),
      mediaFormat: 'LICENSED_STOCK' as const,
      assetKeywords: s.assetKeywords.map((k) => k.trim().toLowerCase()),
      visualSubject: s.visualSubject.trim(),
      visualExclusions: s.visualExclusions.map((k) => k.trim().toLowerCase()).filter(Boolean),
      textOverlay: s.textOverlay?.trim() || undefined,
      transitionIntent: 'CUT' as const,
      claimIds: [...new Set(s.claimRefs)].map((ref) => refToId.get(ref)!),
      beats: format.beats
        ? s.beats.map((b) => ({
            text: b.text.trim().replace(/\s+/g, ' '),
            visualIntent: b.visualIntent.trim(),
            visualSubject: b.visualSubject.trim(),
            assetKeywords: b.assetKeywords.map((k) => k.trim().toLowerCase()).filter(Boolean),
            visualExclusions: b.visualExclusions.map((k) => k.trim().toLowerCase()).filter(Boolean),
            ...(b.graphic ? { graphic: b.graphic } : {}),
          }))
        : [],
    }));
    const totalWords = scenes.reduce((n, s) => n + countWords(s.narration), 0);
    // Only sources the policy permits citing (HIGH/ACCEPTABLE) that support claims this script uses.
    const sourcesLine = citableSourceUrls(research, scenes.flatMap((s) => s.claimIds)).slice(0, 4).join('\n');
    const script = ShortScriptSchema.parse({
      id: randomUUID(),
      storyId: story.id,
      topicId: story.topicId,
      title: draft.title.trim(),
      description: `${draft.description.trim()}\n\nSources:\n${sourcesLine}\n\n#Shorts`.slice(0, 5000),
      hookText: scenes[0].narration,
      format: format.id,
      hookType: format.beats ? hookType : undefined,
      titleCard: this.opts.titleCard && draft.titleCard.trim() ? draft.titleCard.trim() : undefined,
      targetDurationSeconds: format.targetSeconds,
      scenes,
      totalWords,
      generationAttempts: res.attempts,
      createdAt: new Date().toISOString(),
    });
    logger.info(`Script accepted: "${script.title}" — ${totalWords} words, ${scenes.length} scenes, attempt ${res.attempts}${format.beats ? `, beats attempt ${beatAttempts}` : ''}`, { stage: 'SCRIPT' });
    return script;
  }

  /**
   * Second call for beat formats: clause-level beats on the accepted narration. Validated as exact
   * slices (after deterministic joins of too-short beats) and checked for stock footage per beat;
   * the narration itself can no longer change. Fails closed after the bounded attempts.
   */
  private async planBeats(
    narrations: string[],
    beatRules: string,
    beatWords: [number, number]
  ): Promise<{ scenes: Array<{ beats: z.infer<typeof BeatOutputSchema>[] }>; attempts: number; footageShort: string[] }> {
    let attempt = 0;
    let footageShort: string[] = [];
    const res = await this.llm.generateStructured({
      task: 'script_beats',
      system: 'You are the visual director of a YouTube Shorts documentary. You plan one literal, filmable stock-footage shot per spoken clause.',
      prompt: `Plan the visual beats for this narration. Do not change any word of it.

${narrations.map((n, i) => `SCENE ${i + 1}: ${n}`).join('\n')}

HARD RULES (validated automatically; violations are rejected):
${beatRules}
4. Return exactly ${narrations.length} scene objects ("scene": 1 to ${narrations.length}), one per SCENE line above, in order; each scene's beats cover only that scene's narration.`,
      schemaHint:
        (this.opts.graphicsMaxShare ?? 0) > 0
          ? '{"scenes":[{"scene":1,"beats":[{"text":"exact slice of narration","visualIntent":"string","visualSubject":"string","assetKeywords":["string"],"visualExclusions":["string"],"graphic":null}]}]}'
          : '{"scenes":[{"scene":1,"beats":[{"text":"exact slice of narration","visualIntent":"string","visualSubject":"string","assetKeywords":["string"],"visualExclusions":["string"]}]}]}',
      schema: BeatPlanSchema,
      validate: async (plan) => {
        attempt++;
        if (plan.scenes.length !== narrations.length) {
          const regrouped = regroupBeats(narrations, plan.scenes.flatMap((s) => s.beats));
          if (!regrouped) return [`return exactly ${narrations.length} scenes, one object per SCENE line, in order (got ${plan.scenes.length})`];
          plan.scenes = regrouped.map((beats, i) => ({ scene: i + 1, beats }));
        }
        const scenes = narrations.map((narration, i) => ({ narration, visualObjective: '', assetKeywords: [] as string[], claimRefs: [] as string[], beats: plan.scenes[i].beats }));
        mergeShortBeats(scenes, beatWords);
        plan.scenes.forEach((s, i) => (s.beats = scenes[i].beats as typeof s.beats));
        const violations = validateBeats(scenes, beatWords);
        // Graphics: allowed share, never back to back, and their text must restate the narration.
        const all = plan.scenes.flatMap((s, i) => s.beats.map((b, j) => ({ b, i, j })));
        const share = this.opts.graphicsMaxShare ?? 0;
        const withGraphic = all.filter((x) => x.b.graphic);
        if (withGraphic.length && share <= 0) violations.push('graphics are not available for this Short: set every "graphic" to null');
        else if (withGraphic.length > Math.max(1, Math.floor(all.length * share))) violations.push(`${withGraphic.length} of ${all.length} beats are graphics; at most ${Math.max(1, Math.floor(all.length * share))} — show the others as stock footage`);
        all.forEach((x, k) => {
          if (x.b.graphic && all[k - 1]?.b.graphic) violations.push(`scene ${x.i + 1} beat ${x.j + 1}: two graphics in a row — show one of them as stock footage`);
          // Shorter beats are merged into a neighbour by the timeline, which would drop the graphic.
          if (x.b.graphic && countWords(x.b.text) < 5) violations.push(`scene ${x.i + 1} beat ${x.j + 1}: a graphic needs a beat of at least 5 words to be readable — lengthen the beat or use stock footage`);
          if (x.b.graphic) for (const p of validateGraphic(x.b.graphic, x.b.text, narrations[x.i])) violations.push(`scene ${x.i + 1} beat ${x.j + 1}: ${p}`);
        });
        if (violations.length > 0 || !this.opts.visualPreflight) return violations;
        // Graphic beats are rendered locally; only stock beats need footage.
        const items: VisualPreflightItem[] = plan.scenes.flatMap((s, i) =>
          s.beats.flatMap((b, j) => (b.graphic ? [] : [{ label: `scene ${i + 1} beat ${j + 1}`, visualSubject: b.visualSubject, assetKeywords: b.assetKeywords, visualExclusions: b.visualExclusions }]))
        );
        const visual = await this.opts.visualPreflight(items);
        if (visual.length === 0) return [];
        // Literal subjects stock does not carry (live: "derailed train") go to human review, not failure.
        if (attempt >= 2 && visual.length <= (this.opts.maxFootageShortBeats ?? 2)) {
          footageShort = visual;
          logger.warn(`Beats accepted for human review — not enough stock footage: ${visual.map((v) => v.split(';')[0]).join(' | ')}`, { stage: 'SCRIPT' });
          return [];
        }
        return [
          ...visual,
          `the other ${items.length - visual.length} beats have enough footage: keep them unchanged and only replace the subjects listed above${share > 0 ? ' (or, if the clause states a number, comparison, process or term, show it as a graphic)' : ''}`,
        ];
      },
      maxValidationAttempts: this.opts.maxAttempts,
      temperature: 0.4,
      maxTokens: 2500,
    });
    return { scenes: res.content.scenes, attempts: res.attempts, footageShort };
  }
}
