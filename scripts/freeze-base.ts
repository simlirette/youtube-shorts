/**
 * Records the SHA-256 of the frozen visual layer in base/<version>/frozen.json.
 *
 *   pnpm base:freeze            first time: writes the manifest; later: shows what differs and stops
 *   pnpm base:freeze --confirm  re-freezes after a DELIBERATE change to the visual layer
 *
 * `pnpm video` and the tests refuse to run when a frozen file no longer matches, so the 3D look cannot change by accident.
 */
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '@shorts/core';
import { baseDir, loadBase, sha256File, type FrozenManifest } from '@shorts/rendering';

const version = process.argv.find((a) => /^v\d+$/.test(a)) ?? 'v1';
const confirm = process.argv.includes('--confirm');
const base = loadBase(version);
const file = path.join(baseDir(version), 'frozen.json');
const next: Record<string, string> = {};
for (const rel of base.frozen.files) next[rel] = sha256File(path.join(repoRoot(), rel));
if (fs.existsSync(file)) {
  const prev = (JSON.parse(fs.readFileSync(file, 'utf-8')) as FrozenManifest).files;
  const diff = Object.keys(next).filter((k) => prev[k] !== next[k]);
  if (diff.length === 0) {
    console.log('frozen layer is intact; nothing to do');
    process.exit(0);
  }
  console.log(`changed since the last freeze:\n${diff.map((d) => `  ${d}`).join('\n')}`);
  if (!confirm) {
    console.log('not re-frozen. Revert the change, or run again with --confirm if it was deliberate.');
    process.exit(1);
  }
}
const manifest: FrozenManifest = { frozenAt: new Date().toISOString(), files: next };
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
console.log(`froze ${Object.keys(next).length} files in ${path.relative(repoRoot(), file)}`);
