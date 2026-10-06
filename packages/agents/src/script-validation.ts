import { countWords, overlapCoefficient, significantTokens } from '@shorts/core';
import { unsupportedNumbers } from './verification.js';

export interface ScriptRules {
  minWords: number;
  maxWords: number;
  hookMaxWords: number;
  sceneCount: number;
  /** Minimum number of distinct verified claims the script must reference. */
  minClaimRefs: number;
}

/** Per-scene word budget (non-hook scenes) that lands the total inside the allowed range. */
export function sceneWordBudget(rules: ScriptRules): { min: number; max: number; target: number } {
  const body = rules.sceneCount - 1;
  const hook = Math.min(rules.hookMaxWords, 6);
  const target = Math.round(((rules.minWords + rules.maxWords) / 2 - hook) / body);
  return {
    min: Math.ceil((rules.minWords + 4 - hook) / body),
    max: Math.floor((rules.maxWords - 4 - hook) / body),
    target,
  };
}

export interface ScriptDraftScene {
  narration: string;
  visualObjective: string;
  assetKeywords: string[];
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

  if (draft.scenes.length !== rules.sceneCount) v.push(`script must have exactly ${rules.sceneCount} scenes (got ${draft.scenes.length})`);

  const total = draft.scenes.reduce((n, s) => n + countWords(s.narration), 0);
  if (total < rules.minWords || total > rules.maxWords) {
    const perScene = draft.scenes.map((s, i) => `scene ${i + 1}: ${countWords(s.narration)}`).join(', ');
    const budget = sceneWordBudget(rules);
    v.push(
      `total narration must be between ${rules.minWords} and ${rules.maxWords} words (got ${total}; ${perScene}); ` +
        `${total < rules.minWords ? 'add' : 'remove'} about ${total < rules.minWords ? rules.minWords - total + 5 : total - rules.maxWords + 5} words — ` +
        `scenes 2-${rules.sceneCount} should each have ${budget.min}-${budget.max} words`
    );
  }

  const hook = draft.scenes[0]?.narration ?? '';
  const hookWords = countWords(hook);
  if (hookWords === 0) v.push('scene 1 (hook) narration is empty');
  else if (hookWords > rules.hookMaxWords) v.push(`scene 1 hook must be at most ${rules.hookMaxWords} words (got ${hookWords})`);

  const used = new Set<string>();
  draft.scenes.forEach((s, i) => {
    const n = i + 1;
    if (countWords(s.narration) < (i === 0 ? 1 : 4)) v.push(`scene ${n} narration is too short`);
    if (!s.visualObjective.trim()) v.push(`scene ${n} visualObjective is empty`);
    if (s.assetKeywords.length < 2 || s.assetKeywords.length > 5) v.push(`scene ${n} needs 2-5 assetKeywords`);
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
