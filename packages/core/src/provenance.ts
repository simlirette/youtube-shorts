import type { AssetDescriptor, ResearchPacket, ShortScript } from '@shorts/schemas';

export interface ScriptProvenanceResult {
  valid: boolean;
  /** Claim IDs referenced by scenes that do not exist in the research packet. */
  unknownClaims: string[];
  /** Claim IDs referenced by scenes whose verification status is not VERIFIED. */
  unverifiedClaims: string[];
  /** Verified claims whose cited sources are missing from the packet. */
  missingSources: string[];
  referencedVerifiedClaims: string[];
}

export class ProvenanceTracker {
  /**
   * A script is provenance-valid only when every referenced claim exists, is VERIFIED,
   * and each of its supporting sources is present in the packet.
   */
  static verifyScriptClaims(script: ShortScript, research: ResearchPacket): ScriptProvenanceResult {
    const claimsById = new Map(research.claims.map((c) => [c.id, c]));
    const sourceIds = new Set(research.sources.map((s) => s.id));
    const unknownClaims: string[] = [];
    const unverifiedClaims: string[] = [];
    const missingSources: string[] = [];
    const referenced = new Set<string>();

    for (const scene of script.scenes) {
      for (const claimId of scene.claimIds) {
        const claim = claimsById.get(claimId);
        if (!claim) {
          unknownClaims.push(`scene ${scene.sceneNumber}: ${claimId}`);
          continue;
        }
        if (claim.verificationStatus !== 'VERIFIED') {
          unverifiedClaims.push(`scene ${scene.sceneNumber}: ${claimId} (${claim.verificationStatus}: ${claim.verificationReason})`);
          continue;
        }
        if (claim.sourceIds.length === 0 || claim.sourceIds.some((s) => !sourceIds.has(s))) {
          missingSources.push(`claim ${claimId} cites a source not present in the research packet`);
          continue;
        }
        referenced.add(claimId);
      }
    }
    return {
      valid: unknownClaims.length === 0 && unverifiedClaims.length === 0 && missingSources.length === 0,
      unknownClaims,
      unverifiedClaims,
      missingSources,
      referencedVerifiedClaims: [...referenced],
    };
  }

  static verifyAssetLicenses(assets: AssetDescriptor[]): { valid: boolean; flaggedAssets: string[] } {
    const flaggedAssets: string[] = [];
    for (const asset of assets) {
      if (!asset.commercialUseAllowed) flaggedAssets.push(`asset ${asset.id} (${asset.provider}): commercial use not allowed`);
      if (!asset.licenseVerified) flaggedAssets.push(`asset ${asset.id} (${asset.provider}): license not verified`);
      if (!asset.license || /unknown/i.test(asset.license)) flaggedAssets.push(`asset ${asset.id} (${asset.provider}): license unknown`);
    }
    return { valid: flaggedAssets.length === 0, flaggedAssets };
  }
}
