import { validateGraphic } from './graphics.js';
import {
  AssetDescriptor,
  QACheck,
  QAReport,
  ResearchPacket,
  ScriptReview,
  ShortScript,
  YouTubeMetadata,
  YouTubeMetadataSchema,
} from '@shorts/schemas';
import type { LLMProvider } from '@shorts/providers';
import { ProvenanceTracker } from '@shorts/core';
import { ScriptRules, validateScriptDraft } from './script-validation.js';
import { citableSourceUrls, verifiedClaimRefs } from './scriptwriter-agent.js';
import { claimSourceStatus, sourceTier } from './source-policy.js';
import { sentenceStats } from './editorial.js';
import { materialFindings, reviewNarration } from './narration-review.js';

export interface ContentQAInput {
  script: ShortScript;
  research: ResearchPacket;
  assets: AssetDescriptor[];
  metadata: YouTubeMetadata;
  rules: ScriptRules;
  minVerifiedClaims: number;
  minRelevance: number;
  previousTitles: string[];
  previousHooks: string[];
  /** Timeline shots that each require their own asset. */
  shots?: Array<{ sceneNumber: number; shotIndex: number }>;
  /** Latest script-editor review (required for the micro-explainer format). */
  scriptReview?: ScriptReview | null;
}

export function summarize(kind: QAReport['kind'], checks: QACheck[]): QAReport {
  const fails = checks.filter((c) => c.status === 'FAIL');
  const blockingWarns = checks.filter((c) => c.status === 'WARN' && c.blocking);
  const overallStatus = fails.length ? 'FAIL' : checks.some((c) => c.status === 'WARN') ? 'WARN' : 'PASS';
  const blockingReasons = [...fails, ...blockingWarns].map((c) => `${c.id}: ${c.message}`);
  const review = checks.filter((c) => c.reviewRequired);
  return {
    kind,
    checks,
    overallStatus,
    publishEligible: blockingReasons.length === 0,
    blockingReasons,
    requiresHumanReview: review.length > 0,
    reviewReasons: review.map((c) => `${c.id}: ${c.message}`),
  };
}

/**
 * Content gate: script contract, claim provenance, semantic support of the narration, media
 * coverage/licensing, and upload metadata. Re-validates instead of trusting upstream stages.
 */
export class ContentQA {
  constructor(private readonly reviewer: LLMProvider) {}

  async evaluate(input: ContentQAInput): Promise<QAReport> {
    const { script, research, assets } = input;
    const checks: QACheck[] = [];
    const add = (id: string, category: string, pass: boolean, message: string, extra: Partial<QACheck> = {}) =>
      checks.push({ id, category, status: pass ? 'PASS' : 'FAIL', blocking: !pass, reviewRequired: false, message, ...extra });
    const review = (id: string, category: string, message: string) =>
      checks.push({ id, category, status: 'WARN', blocking: false, reviewRequired: true, message });

    // Script contract (same validator used during generation).
    const refs = verifiedClaimRefs(research);
    const draft = {
      title: script.title,
      description: script.description.split('\n\nSources:')[0],
      scenes: script.scenes.map((s) => ({
        narration: s.narration,
        visualObjective: s.visualObjective,
        assetKeywords: s.assetKeywords,
        visualSubject: s.visualSubject,
        visualExclusions: s.visualExclusions,
        claimRefs: s.claimIds.map((id) => refs.idToRef.get(id) ?? `UNVERIFIED:${id}`),
        beats: s.beats,
      })),
    };
    const violations = validateScriptDraft(draft, { rules: input.rules, claims: refs.support, previousTitles: input.previousTitles, previousHooks: input.previousHooks });
    add('script.contract', 'script', violations.length === 0, violations.length ? violations.join('; ') : `${script.totalWords} words, ${script.scenes.length} scenes`);

    // Editorial quality: the separate editor must have approved exactly this script.
    if (script.format === 'MICRO_EXPLAINER' || input.scriptReview) {
      const r = input.scriptReview;
      const ok = Boolean(r && r.scriptId === script.id && r.passed);
      add(
        'script.editor',
        'script',
        ok,
        !r
          ? 'no script-editor review recorded for this script'
          : r.scriptId !== script.id
            ? 'the recorded editor review belongs to a different script version'
            : `editor ${r.total}/20 (hook ${r.scores.hook}, specificity ${r.scores.specificity}, flow ${r.scores.causalFlow}, payoff ${r.scores.payoff}) after ${r.revision} revision(s)${r.passed ? '' : ' — below thresholds'}`,
        r ? { measured: r.scores, expected: r.thresholds } : {}
      );
    }
    {
      const st = sentenceStats(script.scenes.map((s) => ({ narration: s.narration, claimRefs: [] })));
      checks.push({
        id: 'script.sentences',
        category: 'script',
        status: 'PASS',
        blocking: false,
        reviewRequired: false,
        message: `${st.sentences} sentences, mean ${st.meanWords} words, max ${st.maxWords}; ${st.withinTarget} within the 6-14 word target`,
        measured: st,
      });
    }

    // Claim provenance.
    add(
      'research.verifiedClaims',
      'facts',
      research.verifiedClaimCount >= input.minVerifiedClaims,
      `${research.verifiedClaimCount} verified claims (minimum ${input.minVerifiedClaims})`
    );
    const prov = ProvenanceTracker.verifyScriptClaims(script, research);
    add(
      'script.claimProvenance',
      'facts',
      prov.valid && prov.referencedVerifiedClaims.length > 0,
      prov.valid
        ? `${prov.referencedVerifiedClaims.length} verified claims referenced, all with located evidence`
        : [...prov.unknownClaims, ...prov.unverifiedClaims, ...prov.missingSources].join('; ') || 'no verified claims referenced'
    );

    // Source credibility: a claim can be supported and still not be publishable on that source alone.
    const referenced = [...new Set(script.scenes.flatMap((s) => s.claimIds))]
      .map((id) => research.claims.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c));
    const statuses = referenced.map((c) => ({ c, st: claimSourceStatus(c, research.sources) }));
    const onlyRejected = statuses.filter((x) => x.st.rejected);
    add(
      'sources.notRejected',
      'sources',
      onlyRejected.length === 0,
      onlyRejected.length
        ? `claim(s) supported only by sources rejected under the source policy: ${onlyRejected.map((x) => `"${x.c.text.slice(0, 60)}"`).join('; ')}`
        : 'every referenced claim has at least one non-rejected source'
    );
    const questionable = statuses.filter((x) => x.st.reviewRequired);
    if (questionable.length) {
      review(
        'sources.credibility',
        'sources',
        `claim(s) whose best supporting source is QUESTIONABLE (human review required): ${questionable.map((x) => `"${x.c.text.slice(0, 60)}"`).join('; ')}`
      );
    } else {
      add('sources.credibility', 'sources', true, `all referenced claims backed by HIGH/ACCEPTABLE sources`);
    }
    const citable = citableSourceUrls(research, referenced.map((c) => c.id));
    const described = [...script.description.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]);
    const uncitable = described.filter((u) => {
      const src = research.sources.find((s) => s.url === u);
      return !src || (sourceTier(src) !== 'HIGH' && sourceTier(src) !== 'ACCEPTABLE');
    });
    add(
      'sources.published',
      'sources',
      citable.length > 0 && described.length > 0 && uncitable.length === 0,
      uncitable.length
        ? `description cites sources not permitted for publication: ${uncitable.join(', ')}`
        : citable.length === 0
          ? 'no HIGH/ACCEPTABLE source supports the referenced claims — nothing citable'
          : described.length === 0
            ? 'description lists no sources'
            : `description cites ${described.length} permitted source(s)`
    );

    // Semantic review: is anything stated that the verified claims don't support?
    const verifiedLines = research.claims.filter((c) => c.verificationStatus === 'VERIFIED').map((c) => c.text);
    try {
      const findings = await reviewNarration(this.reviewer, verifiedLines, script.scenes);
      const bad = materialFindings(findings);
      const minor = findings.filter((f) => f.severity === 'minor');
      add(
        'script.factualSupport',
        'facts',
        bad.length === 0,
        bad.length ? `unsupported facts: ${bad.map((b) => `"${b.statement}" (${b.reason})`).join('; ')}` : 'no unsupported specific facts'
      );
      if (minor.length) {
        checks.push({ id: 'script.framing', category: 'facts', status: 'WARN', blocking: false, reviewRequired: false, message: `interpretive framing (non-blocking): ${minor.map((m) => `"${m.statement}"`).join('; ')}` });
      }
    } catch (err) {
      add('script.factualSupport', 'facts', false, `semantic review could not be completed: ${(err as Error).message}`);
    }

    // Media coverage, uniqueness, relevance and licensing.
    const missing: string[] = script.scenes.filter((s) => !assets.some((a) => a.sceneNumber === s.sceneNumber)).map((s) => `${s.sceneNumber}`);
    for (const sh of input.shots ?? []) {
      if (!assets.some((a) => a.sceneNumber === sh.sceneNumber && a.shotIndex === sh.shotIndex)) missing.push(`${sh.sceneNumber}.${sh.shotIndex}`);
    }
    add('media.coverage', 'media', missing.length === 0, missing.length ? `no asset for scene(s) ${missing.join(', ')}` : 'every scene has a validated asset');
    const keys = assets.map((a) => `${a.provider}:${a.providerAssetId}`);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    add('media.unique', 'media', dupes.length === 0, dupes.length ? `duplicate media: ${[...new Set(dupes)].join(', ')}` : 'no duplicate media');
    const lowRel = assets.filter((a) => a.ranking.relevance < input.minRelevance);
    add('media.relevance', 'media', lowRel.length === 0, lowRel.length ? `scene(s) ${lowRel.map((a) => a.sceneNumber).join(', ')} below relevance ${input.minRelevance}` : `relevance ${assets.map((a) => a.ranking.relevance.toFixed(2)).join(', ')}`);
    const lic = ProvenanceTracker.verifyAssetLicenses(assets);
    add('media.licensing', 'media', lic.valid, lic.valid ? 'all assets licensed for commercial use' : lic.flaggedAssets.join('; '));

    // Visual validation of every selected asset: defects block; uncertain relevance needs a human.
    const unvalidated = assets.filter((a) => !a.visualValidation);
    const defective = assets.filter((a) => (a.visualValidation?.defects.length ?? 0) > 0);
    add(
      'media.visualDefects',
      'media',
      unvalidated.length === 0 && defective.length === 0,
      unvalidated.length
        ? `asset(s) without frame validation: ${unvalidated.map((a) => `${a.sceneNumber}.${a.shotIndex}`).join(', ')}`
        : defective.length
          ? defective.map((a) => `${a.sceneNumber}.${a.shotIndex} ${a.provider}:${a.providerAssetId}: ${a.visualValidation!.defects.join(', ')}`).join('; ')
          : `${assets.length} assets passed frame checks (black/blank/chroma-key/letterbox/static)`
    );
    const semanticRejected = assets.filter((a) => a.visualValidation?.semantic?.verdict === 'REJECT');
    add('media.semanticReject', 'media', semanticRejected.length === 0, semanticRejected.length ? `vision check rejected: ${semanticRejected.map((a) => `${a.sceneNumber}.${a.shotIndex}`).join(', ')}` : 'no vision-rejected assets selected');
    // Generated graphics carry no vision verdict: their on-screen text is re-verified against the narration.
    const generated = assets.filter((a) => a.generated);
    if (generated.length) {
      const bad = generated.flatMap((a) => {
        const scene = script.scenes.find((s) => s.sceneNumber === a.sceneNumber);
        if (!scene) return [`${a.sceneNumber}.${a.shotIndex}: unknown scene`];
        if (!scene.narration.includes(a.generated!.beatText)) return [`${a.sceneNumber}.${a.shotIndex}: graphic clause is not part of the narration`];
        return validateGraphic(a.generated!.spec, a.generated!.beatText, scene.narration).map((p) => `${a.sceneNumber}.${a.shotIndex}: ${p}`);
      });
      add('media.generatedGraphics', 'media', bad.length === 0, bad.length ? bad.join('; ') : `${generated.length} generated graphic(s) only restate their narration`);
    }
    const uncertain = assets.filter((a) => a.visualValidation && a.visualValidation.decision !== 'ACCEPTED');
    if (uncertain.length) {
      review(
        'media.semanticRelevance',
        'media',
        `asset(s) without a confident vision match (human review required): ${uncertain
          .map((a) => `${a.sceneNumber}.${a.shotIndex} (${a.visualValidation!.semantic ? `${a.visualValidation!.semantic.verdict}: ${a.visualValidation!.semantic.reason}` : 'not checked'})`)
          .join('; ')}`
      );
    } else if (assets.length) {
      add(
        'media.semanticRelevance',
        'media',
        true,
        `vision check accepted all ${assets.length - generated.length} stock assets for their scenes${generated.length ? `; ${generated.length} generated graphic(s) verified against the narration` : ''}`
      );
    }

    // Upload metadata.
    const meta = YouTubeMetadataSchema.safeParse(input.metadata);
    add('metadata.youtube', 'metadata', meta.success, meta.success ? 'title/description/tags within YouTube limits' : meta.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));

    return summarize('CONTENT', checks);
  }
}
