import fs from 'node:fs';
import { ValidationError } from './errors.js';

/**
 * Sets KEY=value in an env file, replacing an existing assignment or appending one. The value is
 * never logged. The file is created owner-readable only.
 */
export function upsertEnvVar(file: string, key: string, value: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new ValidationError(`invalid env key "${key}"`);
  if (/[\r\n]/.test(value)) throw new ValidationError(`${key} value must be a single line`);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  const next = re.test(text) ? text.replace(re, () => line) : `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`;
  fs.writeFileSync(file, next, { mode: 0o600 });
}
