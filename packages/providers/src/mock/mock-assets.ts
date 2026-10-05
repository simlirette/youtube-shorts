import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AssetDescriptor, AssetType } from '@shorts/schemas';
import { AssetProvider, ImageProvider, ImageGenerateOptions } from '../interfaces.js';

export class MockAssetProvider implements AssetProvider, ImageProvider {
  name = 'MockAssetProvider';

  private async generateSolidImage(
    outputPath: string,
    width: number = 1080,
    height: number = 1920,
    color: string = '#1e293b'
  ): Promise<void> {
    const outDir = path.dirname(path.resolve(outputPath));
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      // Create a 1080x1920 image using FFmpeg color generator
      const args = [
        '-y',
        '-f', 'lavfi',
        '-i', `color=c=${color}:s=${width}x${height}:d=1`,
        '-frames:v', '1',
        outputPath,
      ];

      const child = spawn('ffmpeg', args, { stdio: 'pipe' });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Failed to generate mock asset image: code ${code}`));
      });
      child.on('error', reject);
    });
  }

  async generateImage(
    prompt: string,
    outputPath: string,
    options?: ImageGenerateOptions
  ): Promise<AssetDescriptor> {
    const width = options?.width || 1080;
    const height = options?.height || 1920;
    // Rotate pleasing dark documentary slate colors
    const colors = ['#0f172a', '#1e293b', '#18181b', '#111827'];
    const chosenColor = colors[Math.floor(Math.random() * colors.length)];

    await this.generateSolidImage(outputPath, width, height, chosenColor);

    return {
      id: randomUUID(),
      assetType: 'IMAGE',
      sourceUrl: `synthetic://local/prompt-${encodeURIComponent(prompt.slice(0, 20))}`,
      provider: 'mock_synthetic',
      license: 'Public Domain / Internal Synthetic',
      commercialUseAllowed: true,
      attributionRequired: false,
      retrievedAt: new Date().toISOString(),
      localPath: outputPath,
      metadata: {
        prompt,
        width,
        height,
        color: chosenColor,
      },
    };
  }

  async searchStockAssets(
    keywords: string[],
    assetType: AssetType = 'IMAGE',
    sceneNumber?: number
  ): Promise<AssetDescriptor[]> {
    const baseDir = path.resolve(process.cwd(), 'output/temp/assets');
    const fileName = `scene_${sceneNumber || 1}_${Date.now()}.png`;
    const destPath = path.join(baseDir, fileName);

    const asset = await this.generateImage(keywords.join(' '), destPath);
    if (sceneNumber !== undefined) {
      asset.sceneNumber = sceneNumber;
    }
    return [asset];
  }

  async acquireAsset(
    sourceUrl: string,
    destinationPath: string,
    metadata: Partial<AssetDescriptor>
  ): Promise<AssetDescriptor> {
    await this.generateSolidImage(destinationPath);
    return {
      id: metadata.id || randomUUID(),
      assetType: metadata.assetType || 'IMAGE',
      sourceUrl,
      provider: metadata.provider || 'mock_stock',
      license: metadata.license || 'Licensed Stock Standard',
      commercialUseAllowed: metadata.commercialUseAllowed ?? true,
      attributionRequired: metadata.attributionRequired ?? false,
      retrievedAt: new Date().toISOString(),
      localPath: destinationPath,
      metadata: metadata.metadata || {},
    };
  }
}
