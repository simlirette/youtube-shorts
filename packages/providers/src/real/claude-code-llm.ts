import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AuthenticationError, InvalidResponseError, PipelineError, ProviderUnavailableError, RateLimitError, TimeoutError } from '@shorts/core';
import type { ProviderContext } from '../interfaces.js';
import { RawCompletion, StructuredLLMBase, requireNonEmpty } from '../llm-base.js';

/**
 * Locates the Claude Code executable: the configured path first, then claude.exe / claude on PATH,
 * then the npm global install's native binary (the npm `claude` entry is a shell shim). Null when none.
 */
export function findClaudeCli(configured?: string): string | null {
  if (configured) return fs.existsSync(configured) ? configured : null;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates: string[] = [];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(dir, exe), path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', exe));
  }
  candidates.push(path.join(os.homedir(), '.local', 'bin', exe));
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', exe));
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
}

export interface ClaudeRunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs one CLI invocation with `stdin` piped in (injectable for tests). */
export type ClaudeRunner = (bin: string, args: string[], stdin: string, opts: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<ClaudeRunResult>;

const spawnRunner: ClaudeRunner = (bin, args, stdin, opts) =>
  new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      // Windows reports some launch failures synchronously ("spawn UNKNOWN", e.g. under memory pressure).
      reject(new ProviderUnavailableError('claude-code', `could not launch ${bin}: ${(err as Error).message}`, err));
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.stdout!.on('data', (c) => (stdout += c.toString()));
    child.stderr!.on('data', (c) => (stderr += c.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ProviderUnavailableError('claude-code', `could not launch ${bin}: ${err.message}`, err));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    child.stdin!.on('error', () => undefined); // the process may exit before reading everything
    child.stdin!.end(stdin);
  });

/** Environment for the CLI: without API credentials, so calls can only use the claude.ai plan login. */
export function subscriptionOnlyEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete out[k];
  return out;
}

interface ResultEvent {
  type: 'result';
  is_error?: boolean;
  subtype?: string;
  api_error_status?: number | null;
  stop_reason?: string;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  modelUsage?: Record<string, unknown>;
}

/** Maps a failed CLI result to a typed error (usage limits and overload are retryable / fall-back-able). */
export function classifyClaudeError(provider: string, status: number | null | undefined, message: string): PipelineError {
  const msg = message.replace(/\s+/g, ' ').trim().slice(0, 400) || 'Claude Code reported an error';
  if (status === 429 || /usage limit|hit your limit|limit reached|rate limit/i.test(msg)) {
    // Older CLIs append "|<reset epoch seconds>".
    const epoch = msg.match(/\|(\d{10})\b/);
    const retryAfterMs = epoch ? Math.max(0, Number(epoch[1]) * 1000 - Date.now()) : undefined;
    return new RateLimitError(provider, msg, retryAfterMs);
  }
  if (status === 401 || status === 403 || /not logged in|please run \/login|authenticat|invalid api key|credit balance/i.test(msg)) {
    return new AuthenticationError(provider, `${msg} (run "claude" and log in with your claude.ai account)`);
  }
  if ((status !== null && status !== undefined && status >= 500) || /overloaded|temporarily unavailable/i.test(msg)) {
    return new ProviderUnavailableError(provider, msg);
  }
  return new InvalidResponseError(provider, msg, { details: { status } });
}

export interface ClaudeCodeOptions {
  timeoutMs: number;
  runner?: ClaudeRunner;
  /** Pause before retrying a failed process launch (default 3 s). */
  launchRetryMs?: number;
}

/**
 * Structured completions through the Claude Code CLI (`claude -p`), billed to the user's claude.ai
 * plan instead of per token: recorded at $0. Each call runs headless with no tools, no MCP servers,
 * no user/project settings (so no hooks or plugins), no saved session and its own system prompt,
 * from an empty working directory. API credentials are removed from its environment so it can
 * never fall back to API billing. Images go in as base64 content blocks (stream-json input).
 */
export class ClaudeCodeLLMProvider extends StructuredLLMBase {
  readonly name = 'claude-code';

  constructor(
    private readonly bin: string,
    readonly model: string,
    private readonly opts: ClaudeCodeOptions,
    ctx: ProviderContext = {}
  ) {
    super(ctx);
    this.freeTier = true;
  }

  protected async complete(
    system: string,
    user: string,
    o: { temperature: number; maxTokens: number; model: string; task: string; images?: Array<{ mimeType: string; data: Buffer }> }
  ): Promise<RawCompletion> {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'shorts-claude-'));
    try {
      const systemFile = path.join(work, 'system.txt');
      fs.writeFileSync(systemFile, system);
      const content = [
        ...(o.images ?? []).map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data.toString('base64') } })),
        { type: 'text', text: user },
      ];
      const stdin = `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
      // Temperature and max tokens are not exposed by the CLI; the schema and validators still apply.
      const args = [
        '-p',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--setting-sources', '',
        '--strict-mcp-config',
        '--tools', '',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--system-prompt-file', systemFile,
        '--model', o.model,
      ];
      const run = this.opts.runner ?? spawnRunner;
      const launch = () => run(this.bin, args, stdin, { cwd: work, timeoutMs: this.opts.timeoutMs, env: subscriptionOnlyEnv() });
      // A failed launch (not a failed call) is retried once after a pause; then it counts as unavailable.
      const res = await launch().catch(async (err) => {
        if (!(err instanceof ProviderUnavailableError)) throw err;
        await new Promise((r) => setTimeout(r, this.opts.launchRetryMs ?? 3000));
        return launch();
      });
      if (res.timedOut) throw new TimeoutError(this.name, `no complete response within ${this.opts.timeoutMs} ms`);

      const result = res.stdout
        .split(/\r?\n/)
        .filter((l) => l.trim().startsWith('{'))
        .map((l) => {
          try {
            return JSON.parse(l) as { type?: string };
          } catch {
            return null;
          }
        })
        .filter((e): e is ResultEvent => e?.type === 'result')
        .pop();
      if (!result) throw classifyClaudeError(this.name, null, res.stderr || `claude exited with code ${res.code} and no result`);
      if (result.is_error || result.subtype !== 'success') throw classifyClaudeError(this.name, result.api_error_status, result.result ?? res.stderr);

      const u = result.usage ?? {};
      return {
        text: requireNonEmpty(this.name, result.result, 'result text'),
        inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
        model: Object.keys(result.modelUsage ?? {})[0] ?? o.model,
        finishReason: result.stop_reason === 'max_tokens' ? 'MAX_TOKENS' : result.stop_reason,
        httpAttempts: 1,
      };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
}
