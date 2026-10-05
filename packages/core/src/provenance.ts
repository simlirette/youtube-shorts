import { ShortScript, ResearchPacket, AssetDescriptor } from '@shorts/schemas';
import { logger } from './logger.js';

export interface ProvenanceValidationResult {
  valid: boolean;
  unverifiedClaims: string[];
  missingSources: string[];
  unlicensedAssets: string[];
  warnings: string[];
}

export class ProvenanceTracker {
  /**
   * Verifies that all claims referenced in a script exist in the research packet and have valid sources.
   */
  static verifyScriptClaims(script: ShortScript, research: ResearchPacket): ProvenanceValidationResult {
    const validClaimIds = new Set(research.claims.map((c) => c.id));
    const validSourceIds = new Set(research.sources.map((s) => s.id));

    const unverifiedClaims: string[] = [];
    const missingSources: string[] = [];
    const warnings: string[] = [];

    for (const scene of script.scenes) {
      for (const claimId of scene.claimIds) {
        if (!validClaimIds.has(claimId)) {
          unverifiedClaims.push(`Scene ${scene.sceneNumber}: Claim ID ${claimId} not found in research`);
          continue;
        }

        const claim = research.claims.find((c) => c.id === claimId);
        if (claim) {
          if (!validSourceIds.has(claim.sourceId)) {
            missingSources.push(`Claim "${claim.text.slice(0, 40)}..." has unknown source ID ${claim.sourceId}`);
          }
          if (claim.confidence < 0.7) {
            warnings.push(`Claim "${claim.text.slice(0, 40)}..." has low confidence score (${claim.confidence})`);
          }
        }
      }
    }

    const valid = unverifiedClaims.length === 0 && missingSources.length === 0;

    if (!valid) {
      logger.warn('Script provenance validation failed', {
        stage: 'PROVENANCE',
        unverifiedClaims,
        missingSources,
      });
    }

    return {
      valid,
      unverifiedClaims,
      missingSources,
      unlicensedAssets: [],
      warnings,
    };
  }

  /**
   * Validates asset licensing and commercial usage rights.
   */
  static verifyAssetLicenses(assets: AssetDescriptor[]): { valid: boolean; flaggedAssets: string[] } {
    const flaggedAssets: string[] = [];

    for (const asset of assets) {
      if (!asset.commercialUseAllowed) {
        flaggedAssets.push(`Asset ${asset.id} (${asset.provider}): Commercial use prohibited`);
      }
      if (!asset.license || asset.license.toLowerCase().includes('unknown')) {
        flaggedAssets.push(`Asset ${asset.id} (${asset.provider}): License unverified`);
      }
    }

    return {
      valid: flaggedAssets.length === 0,
      flaggedAssets,
    };
  }
}
