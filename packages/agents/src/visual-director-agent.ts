import { ShortScript, AssetDescriptor } from '@shorts/schemas';
import { AssetProvider } from '@shorts/providers';
import { ShortsRepository, ProvenanceTracker, logger } from '@shorts/core';

export class VisualDirectorAgent {
  constructor(
    private assetProvider: AssetProvider,
    private repo: ShortsRepository
  ) {}

  async planAndCollectAssets(script: ShortScript): Promise<AssetDescriptor[]> {
    logger.info(`Planning visuals and collecting media assets for ${script.scenes.length} scenes`, {
      stage: 'VISUAL_DIRECTOR',
      scriptId: script.id,
    });

    const collectedAssets: AssetDescriptor[] = [];

    for (const scene of script.scenes) {
      logger.debug(`Sourcing visual for Scene ${scene.sceneNumber} (${scene.mediaFormat})`, {
        stage: 'VISUAL_DIRECTOR',
        keywords: scene.assetKeywords,
      });

      const assets = await this.assetProvider.searchStockAssets(
        scene.assetKeywords,
        'IMAGE',
        scene.sceneNumber
      );

      for (const asset of assets) {
        asset.sceneNumber = scene.sceneNumber;
        await this.repo.saveAsset(asset);
        collectedAssets.push(asset);
      }
    }

    // Verify licensing compliance
    const licenseCheck = ProvenanceTracker.verifyAssetLicenses(collectedAssets);
    if (!licenseCheck.valid) {
      logger.warn('Flagged assets found during visual planning', {
        stage: 'VISUAL_DIRECTOR',
        flagged: licenseCheck.flaggedAssets,
      });
    }

    logger.info(`Visual planning completed: collected ${collectedAssets.length} assets.`, {
      stage: 'VISUAL_DIRECTOR',
      assetCount: collectedAssets.length,
    });

    return collectedAssets;
  }
}
