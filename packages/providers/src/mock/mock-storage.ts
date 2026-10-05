import fs from 'node:fs';
import path from 'node:path';
import { StorageProvider } from '../interfaces.js';

export class MockStorageProvider implements StorageProvider {
  name = 'MockStorageProvider';
  private storageDir: string;

  constructor(baseDir?: string) {
    this.storageDir = baseDir || path.resolve(process.cwd(), 'output/storage');
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  async save(localSourcePath: string, targetKey: string): Promise<string> {
    const dest = path.join(this.storageDir, targetKey);
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.copyFileSync(localSourcePath, dest);
    return dest;
  }

  async get(targetKey: string): Promise<string> {
    const target = path.join(this.storageDir, targetKey);
    if (!fs.existsSync(target)) {
      throw new Error(`Object not found in storage: ${targetKey}`);
    }
    return target;
  }

  async delete(targetKey: string): Promise<void> {
    const target = path.join(this.storageDir, targetKey);
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
  }
}
