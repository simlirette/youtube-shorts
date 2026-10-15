/**
 * Claude Code (claude.ai plan) as the LLM, and the per-request fallback when a provider is busy.
 * The CLI is replaced by a fake runner; the live smoke test only runs with CLAUDE_CODE_LIVE_TEST=1.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AuthenticationError, ProviderUnavailableError, RateLimitError, ValidationError } from '@shorts/core';
import {
  ClaudeCodeLLMProvider,
  FallbackLLMProvider,
  MockLLMProvider,
  classifyClaudeError,
  createProviders,
  findClaudeCli,
  missingLiveCredentials,
  type ClaudeRunner,
  type LLMProvider,
  type ProviderCallReport,
} from '@shorts/providers';
import { testConfig } from './helpers.js';

const resultLine = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    api_error_status: null,
    stop_reason: 'end_turn',
    result: '{"a":1}',
    usage: { input_tokens: 2, cache_creation_input_tokens: 1800, cache_read_input_tokens: 200, output_tokens: 40 },
    modelUsage: { 'claude-sonnet-5-5': {} },
    ...over,
  });

const req = { task: 't', system: 'Judge it.', prompt: 'Is the sky blue?', schemaHint: '{"a":0}', schema: z.object({ a: z.number() }) };

describe('Claude Code provider', () => {
  it('runs claude headless without tools, settings, MCP or API credentials, and records $0', async () => {
    const calls: Array<{ args: string[]; stdin: string; system: string; env: NodeJS.ProcessEnv; cwd: string }> = [];
    const runner: ClaudeRunner = async (_bin, args, stdin, o) => {
      calls.push({ args, stdin, system: fs.readFileSync(args[args.indexOf('--system-prompt-file') + 1], 'utf8'), env: o.env, cwd: o.cwd });
      return { code: 0, stdout: `{"type":"system","subtype":"init"}\n{"type":"assistant"}\n${resultLine()}\n`, stderr: '', timedOut: false };
    };
    const reports: ProviderCallReport[] = [];
    process.env.ANTHROPIC_API_KEY = 'must-not-be-passed';
    try {
      const p = new ClaudeCodeLLMProvider('claude.exe', 'sonnet', { timeoutMs: 5000, runner }, { observer: (r) => reports.push(r) });
      const r = await p.generateStructured({ ...req, images: [{ mimeType: 'image/jpeg', data: Buffer.from('jpeg-bytes') }] });
      expect(r.content).toEqual({ a: 1 });
      expect(r.model).toBe('claude-sonnet-5-5');
      expect(r.usage).toEqual({ inputTokens: 2002, outputTokens: 40, estimatedCostUsd: 0 });
      expect(reports[0].costUsd).toBe(0);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
    const c = calls[0];
    expect(c.args).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']));
    expect(c.args[c.args.indexOf('--tools') + 1]).toBe('');
    expect(c.args[c.args.indexOf('--setting-sources') + 1]).toBe('');
    expect(c.args[c.args.indexOf('--model') + 1]).toBe('sonnet');
    expect(c.system).toMatch(/Judge it\.[\s\S]*\{"a":0\}/);
    expect(c.env.ANTHROPIC_API_KEY).toBeUndefined();
    // The prompt and image travel on stdin (no command-line length limit), and the temp dir is removed.
    const msg = JSON.parse(c.stdin.trim());
    expect(msg.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from('jpeg-bytes').toString('base64') } },
      { type: 'text', text: 'Is the sky blue?' },
    ]);
    expect(fs.existsSync(c.cwd)).toBe(false);
  });

  it('turns CLI failures into typed errors', async () => {
    const failing = (stdout: string, extra: Partial<{ code: number; stderr: string; timedOut: boolean }> = {}) =>
      new ClaudeCodeLLMProvider('claude.exe', 'sonnet', { timeoutMs: 5000, runner: async () => ({ code: 1, stdout, stderr: '', timedOut: false, ...extra }) });
    await expect(failing(resultLine({ is_error: true, api_error_status: 429, result: "You've hit your limit · resets 3pm" })).generateStructured(req)).rejects.toMatchObject({ kind: 'RATE_LIMIT' });
    await expect(failing(resultLine({ is_error: true, api_error_status: 529, result: 'Overloaded' })).generateStructured(req)).rejects.toMatchObject({ kind: 'PROVIDER_UNAVAILABLE' });
    await expect(failing(resultLine({ is_error: true, api_error_status: 404, result: "There's an issue with the selected model" })).generateStructured(req)).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    await expect(failing('', { stderr: 'Not logged in · Please run /login' }).generateStructured(req)).rejects.toMatchObject({ kind: 'AUTHENTICATION' });
    await expect(failing('', { timedOut: true }).generateStructured(req)).rejects.toMatchObject({ kind: 'TIMEOUT' });
    const old = classifyClaudeError('claude-code', null, 'Claude AI usage limit reached|4102444800') as RateLimitError;
    expect(old.retryAfterMs).toBeGreaterThan(0);
  });

  it('retries a failed process launch once, then reports the provider as unavailable (so the fallback takes over)', async () => {
    let launches = 0;
    const flaky: ClaudeRunner = async () => {
      if (++launches === 1) throw new ProviderUnavailableError('claude-code', 'could not launch claude.exe: spawn UNKNOWN');
      return { code: 0, stdout: resultLine(), stderr: '', timedOut: false };
    };
    expect((await new ClaudeCodeLLMProvider('claude.exe', 'sonnet', { timeoutMs: 5000, runner: flaky, launchRetryMs: 1 }).generateStructured(req)).content).toEqual({ a: 1 });
    expect(launches).toBe(2);
    const dead: ClaudeRunner = async () => {
      throw new ProviderUnavailableError('claude-code', 'could not launch claude.exe: spawn UNKNOWN');
    };
    const p = new ClaudeCodeLLMProvider('claude.exe', 'sonnet', { timeoutMs: 5000, runner: dead, launchRetryMs: 1 });
    await expect(p.generateStructured(req)).rejects.toMatchObject({ kind: 'PROVIDER_UNAVAILABLE' });
    const gemini: LLMProvider = { name: 'gemini', model: 'g', generateStructured: (async () => ({ content: { a: 9 }, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, model: 'g', durationMs: 0, attempts: 1 })) as LLMProvider['generateStructured'] };
    expect((await new FallbackLLMProvider(p, gemini).generateStructured(req)).content).toEqual({ a: 9 });
  });

  it('re-prompts with the validation errors like every other provider', async () => {
    const outputs = ['not json', '{"a":2}'];
    const p = new ClaudeCodeLLMProvider('claude.exe', 'sonnet', { timeoutMs: 5000, runner: async () => ({ code: 0, stdout: resultLine({ result: outputs.shift() }), stderr: '', timedOut: false }) });
    expect((await p.generateStructured(req)).content).toEqual({ a: 2 });
  });
});

describe('LLM fallback per request', () => {
  const fixed = (name: string, impl: () => Promise<unknown>): LLMProvider => ({
    name,
    model: `${name}-model`,
    generateStructured: (async () => impl()) as LLMProvider['generateStructured'],
  });
  const ok = (name: string) => async () => ({ content: { from: name }, usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 }, model: name, durationMs: 1, attempts: 1 });

  it('uses the fallback while the primary is busy, then returns to the primary after its reset', async () => {
    let t = 0;
    let primaryCalls = 0;
    let busy = true;
    const primary = fixed('claude-code', async () => {
      primaryCalls++;
      if (busy) throw new RateLimitError('claude-code', 'usage limit', 60_000);
      return ok('claude-code')();
    });
    const f = new FallbackLLMProvider(primary, fixed('gemini', ok('gemini')), { now: () => t });
    expect((await f.generateStructured(req)).content).toEqual({ from: 'gemini' });
    expect((await f.generateStructured(req)).content).toEqual({ from: 'gemini' });
    expect(primaryCalls).toBe(1); // skipped until the reset time
    busy = false;
    t += 61_000;
    expect((await f.generateStructured(req)).content).toEqual({ from: 'claude-code' });
  });

  it('never hides invalid output or a login problem behind the fallback', async () => {
    const fb = fixed('gemini', ok('gemini'));
    await expect(new FallbackLLMProvider(fixed('claude-code', async () => { throw new ValidationError('bad output'); }), fb).generateStructured(req)).rejects.toBeInstanceOf(ValidationError);
    await expect(new FallbackLLMProvider(fixed('claude-code', async () => { throw new AuthenticationError('claude-code', 'not logged in'); }), fb).generateStructured(req)).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe('factory', () => {
  const live = (o: Record<string, string>) =>
    testConfig({ PIPELINE_MODE: 'live', TAVILY_API_KEY: 't', ELEVENLABS_API_KEY: 'e', PIXABAY_API_KEY: 'p', GEMINI_API_KEY: 'g', ...o });

  it('builds Claude Code with a Gemini fallback for writer and verifier', () => {
    const cfg = live({ LLM_PROVIDER: 'claude_code', CLAUDE_CODE_PATH: process.execPath, LLM_FALLBACK_PROVIDER: 'gemini', GEMINI_FREE_TIER: 'true', CLAUDE_CODE_VERIFIER_MODEL: 'haiku' });
    expect(missingLiveCredentials(cfg)).toEqual([]);
    const b = createProviders(cfg, 'live');
    expect(b.llm).toBeInstanceOf(FallbackLLMProvider);
    expect(b.llm.name).toBe('claude-code>gemini');
    expect(b.llm.model).toBe('sonnet');
    expect(b.verifierLlm.model).toBe('haiku');
  });

  it('reports a missing CLI and a missing fallback key instead of starting', () => {
    const cfg = live({ LLM_PROVIDER: 'claude_code', CLAUDE_CODE_PATH: 'C:/nope/claude.exe', LLM_FALLBACK_PROVIDER: 'gemini', GEMINI_API_KEY: '' });
    expect(missingLiveCredentials(cfg)).toEqual(['GEMINI_API_KEY', 'CLAUDE_CODE_PATH (Claude Code CLI not found)']);
  });

  it('mock mode is unchanged', () => {
    expect(createProviders(testConfig({ LLM_PROVIDER: 'claude_code' }), 'mock').llm).toBeInstanceOf(MockLLMProvider);
  });
});

// Spends a little of the claude.ai plan allowance: opt-in only.
const cli = findClaudeCli(process.env.CLAUDE_CODE_PATH || undefined);
describe.skipIf(!process.env.CLAUDE_CODE_LIVE_TEST || !cli)('Claude Code live smoke test', () => {
  it('returns schema-valid JSON for text and for an image', async () => {
    const p = new ClaudeCodeLLMProvider(cli!, 'haiku', { timeoutMs: 120_000 });
    const r = await p.generateStructured({ ...req, prompt: 'Return a=7.' });
    expect(r.content).toEqual({ a: 7 });
    expect(r.usage.estimatedCostUsd).toBe(0);
  }, 180_000);
});
