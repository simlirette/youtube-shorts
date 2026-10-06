import {
  AssetDescriptor,
  QACheck,
  QAReport,
  ResearchPacket,
  ShortScript,
  YouTubeMetadata,
  YouTubeMetadataSchema,
} from '@shorts/schemas';
import type { LLMProvider } from '@shorts/providers';
import { ProvenanceTracker } from '@shorts/core';
import { ScriptRules, validateScriptDraft } from './script-validation.js';
import { verifiedClaimRefs } from './scriptwriter-agent.js';
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
}

export function summarize(kind: QAReport['kind'], checks: QACheck[]): QAReport {
  const fails = checks.filter((c) => c.status === 'FAIL');
  const blockingWarns = checks.filter((c) => c.status === 'WARN' && c.blocking);
  const overallStatus = fails.length ? 'FAIL' : checks.some((c) => c.status === 'WARN') ? 'WARN' : 'PASS';
  const blockingReasons = [...fails, ...blockingWarns].map((c) => `${c.id}: ${c.message}`);
  return { kind, checks, overallStatus, publishEligible: blockingReasons.length === 0, blockingReasons };
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
      checks.push({ id, category, status: pass ? 'PASS' : 'FAIL', blocking: !pass, message, ...extra });

    // Script contract (same validator used during generation).
    const refs = verifiedClaimRefs(research);
    const draft = {
      title: script.title,
      description: script.description.split('\n\nSources:')[0],
      scenes: script.scenes.map((s) => ({
        narration: s.narration,
        visualObjective: s.visualObjective,
        assetKeywords: s.assetKeywords,
        claimRefs: s.claimIds.map((id) => refs.idToRef.get(id) ?? `UNVERIFIED:${id}`),
      })),
    };
    const violations = validateScriptDraft(draft, { rules: input.rules, claims: refs.support, previousTitles: input.previousTitles, previousHooks: input.previousHooks });
    add('script.contract', 'script', violations.length === 0, violations.length ? violations.join('; ') : `${script.totalWords} words, ${script.scenes.length} scenes`);

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
        checks.push({ id: 'script.framing', category: 'facts', status: 'WARN', blocking: false, message: `interpretive framing (non-blocking): ${minor.map((m) => `"${m.statement}"`).join('; ')}` });
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

    // Upload metadata.
    const meta = YouTubeMetadataSchema.safeParse(input.metadata);
    add('metadata.youtube', 'metadata', meta.success, meta.success ? 'title/description/tags within YouTube limits' : meta.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));

    return summarize('CONTENT', checks);
  }
}
