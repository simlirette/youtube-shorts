// Exits 0 when the model answers a small JSON request within 30 s, 1 otherwise (one free request).
import { loadConfig } from '@shorts/core';
const cfg: any = loadConfig();
const m = process.argv[2] ?? 'gemini-3.8-flash';
const t = Date.now();
try {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
    method: 'POST', headers: { 'x-goog-api-key': cfg.GEMINI_API_KEY, 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'List 20 bridge engineering questions as a JSON array of strings.' }] }], generationConfig: { maxOutputTokens: 2000, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } } }),
  });
  console.log(new Date().toISOString(), m, r.status, `${((Date.now() - t) / 1000).toFixed(1)}s`);
  process.exitCode = r.ok ? 0 : 1;
} catch (e: any) { console.log(new Date().toISOString(), m, "ERR", e.name); process.exitCode = 1; }
