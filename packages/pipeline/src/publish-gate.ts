import fs from 'node:fs';
import {
  Job,
  QAResult,
  QAResultSchema,
  RenderJob,
  RenderJobSchema,
  ResearchPacketSchema,
  AssetDescriptorSchema,
  VoiceNarrationSchema,
  ShortScript,
  TopicCandidate,
  YouTubeMetadata,
  YouTubeMetadataSchema,
} from '@shorts/schemas';
import { AppConfig, ProvenanceTracker, ShortsRepository, ValidationError, sha256File } from '@shorts/core';
import { claimSourceStatus, isCitable, sourceTier } from '@shorts/agents';

/** Deterministic upload metadata derived from the validated script and topic. */
export function buildMetadata(script: ShortScript, topic: TopicCandidate, cfg: AppConfig): YouTubeMetadata {
  const tags: string[] = [];
  for (const t of [...topic.tags, topic.pillar.toLowerCase().replace(/_/g, ' '), 'shorts', 'documentary']) {
    const clean = t.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    if (clean && !tags.includes(clean) && [...tags, clean].join(',').length <= 400) tags.push(clean);
    if (tags.length >= 12) break;
  }
  return {
    title: script.title,
    description: script.description,
    tags,
    privacyStatus: cfg.YOUTUBE_DEFAULT_PRIVACY,
    categoryId: cfg.YOUTUBE_CATEGORY_ID,
    containsSyntheticMedia: cfg.YOUTUBE_CONTAINS_SYNTHETIC_MEDIA,
    defaultLanguage: 'en',
  };
}

export interface PublishableArtifacts {
  render: RenderJob;
  qa: QAResult;
  metadata: YouTubeMetadata;
}

/**
 * The single authority on whether a job may be published. Every condition is re-checked from
 * persisted state and the file on disk — nothing is taken on trust from the caller.
 */
export async function assertPublishable(job: Job, repo: ShortsRepository, cfg: AppConfig, script: ShortScript, topic: TopicCandidate): Promise<PublishableArtifacts> {
  const problems: string[] = [];
  if (job.state !== 'READY_TO_PUBLISH' && job.state !== 'PUBLISHING') problems.push(`job state is ${job.state}, not READY_TO_PUBLISH`);
  const a = job.artifacts;
  for (const k of ['topicId', 'researchId', 'scriptId', 'narrationId', 'renderId', 'qaId'] as const) if (!a[k]) problems.push(`missing ${k}`);
  if (!a.assetIds?.length) problems.push('missing assetIds');
  if (script.id !== a.scriptId) problems.push('script passed to the gate is not the job\'s validated script');
  if (topic.id !== a.topicId) problems.push('topic passed to the gate is not the job\'s topic');
  if (problems.length) throw new ValidationError('Publication blocked', problems);

  const research = await repo.requireArtifact(a.researchId, 'research', ResearchPacketSchema);
  const render = await repo.requireArtifact(a.renderId, 'render', RenderJobSchema);
  const qa = await repo.requireArtifact(a.qaId, 'qa', QAResultSchema);

  const narration = await repo.requireArtifact(a.narrationId, 'narration', VoiceNarrationSchema);
  const assets = await Promise.all((a.assetIds ?? []).map((id) => repo.requireArtifact(id, 'asset', AssetDescriptorSchema)));

  // NO VERIFIED RESEARCH / UNACCEPTABLE SOURCE → NO PUBLISH
  if (research.verifiedClaimCount < cfg.MIN_VERIFIED_CLAIMS) problems.push(`only ${research.verifiedClaimCount} verified claims`);
  const prov = ProvenanceTracker.verifyScriptClaims(script, research);
  if (!prov.valid || prov.referencedVerifiedClaims.length === 0) problems.push('script references unverified or unknown claims');
  for (const id of prov.referencedVerifiedClaims) {
    const claim = research.claims.find((c) => c.id === id)!;
    if (claimSourceStatus(claim, research.sources).rejected) problems.push(`claim "${claim.text.slice(0, 50)}" is supported only by rejected sources`);
  }
  const described = [...script.description.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]);
  for (const u of described) {
    const src = research.sources.find((s) => s.url === u);
    if (!src || !isCitable(sourceTier(src))) problems.push(`description cites a source not permitted for publication: ${u}`);
  }
  if (described.length === 0) problems.push('description cites no permitted source');

  // NO VALID TTS → NO PUBLISH
  if (!fs.existsSync(narration.audioPath) || (await sha256File(narration.audioPath)) !== narration.sha256) problems.push('validated narration audio missing or modified');

  // NO VALID MEDIA → NO PUBLISH
  for (const asset of assets) {
    const v = asset.visualValidation;
    if (!v) problems.push(`asset ${asset.sceneNumber}.${asset.shotIndex} was not visually validated`);
    else if (v.defects.length) problems.push(`asset ${asset.sceneNumber}.${asset.shotIndex} has visual defects: ${v.defects.join(', ')}`);
    else if (v.semantic?.verdict === 'REJECT') problems.push(`asset ${asset.sceneNumber}.${asset.shotIndex} was rejected by the vision check`);
  }
  if (render.status !== 'COMPLETED') problems.push(`render status ${render.status}`);
  if (qa.renderId !== render.id) problems.push('QA result does not belong to the current render');
  if (qa.overallStatus === 'FAIL') problems.push('QA overall status is FAIL');
  if (!qa.publishEligible || !qa.media.publishEligible || !qa.content.publishEligible) {
    problems.push(`QA not publish-eligible: ${qa.blockingReasons.join('; ') || 'blocking checks present'}`);
  }
  if (!fs.existsSync(render.videoPath)) problems.push(`rendered file missing: ${render.videoPath}`);
  else {
    const sha = await sha256File(render.videoPath);
    if (sha !== qa.videoSha256) problems.push('video file changed after QA (sha256 mismatch)');
    if (render.sha256 && sha !== render.sha256) problems.push('video file does not match the render record');
  }

  const approval = await repo.getLatestApproval(job.id, 'FINAL_VIDEO');
  if (!approval || approval.decision !== 'APPROVED') problems.push('no FINAL_VIDEO approval');
  else {
    if (approval.targetId !== render.id) problems.push('FINAL_VIDEO approval refers to a different render');
    if (approval.decidedBy.startsWith('policy:') && cfg.APPROVAL_FINAL !== 'auto_after_qa') {
      problems.push('automatic final approval present but APPROVAL_FINAL policy is not auto_after_qa');
    }
    // UNCERTAIN QUALITY / QUESTIONABLE SOURCES → HUMAN REVIEW: a policy approval can never cover them.
    const needsReview = qa.requiresHumanReview || assets.some((x) => x.visualValidation?.decision !== 'ACCEPTED');
    if (needsReview && approval.decidedBy !== 'human') {
      problems.push(`human review required (${qa.reviewReasons.join('; ') || 'uncertain visual match'}) but approval was ${approval.decidedBy}`);
    }
  }

  const metadata = buildMetadata(script, topic, cfg);
  const meta = YouTubeMetadataSchema.safeParse(metadata);
  if (!meta.success) problems.push(`metadata invalid: ${meta.error.issues.map((i) => i.message).join(', ')}`);

  if (problems.length) throw new ValidationError('Publication blocked', problems);
  return { render, qa, metadata };
}
